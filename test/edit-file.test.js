import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { ToolHost } from "../src/tools/host.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("edit_file 在 workspace-auto 中精确替换并生成 durable Manifest 与 Diff", async (t) => {
  const fixture = await createFixture(t, "nexus-edit-file-");
  await fs.mkdir(path.join(fixture.workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(fixture.workspace, "src", "app.js"), "const mode = 'before';\nconsole.log(mode);\n");
  let approvals = 0;

  const result = await fixture.host.execute({
    id: "edit-success",
    name: "edit_file",
    arguments: {
      path: "src/app.js",
      old_text: "const mode = 'before';",
      new_text: "const mode = 'after';",
    },
  }, {
    session: fixture.session,
    requestApproval: async () => { approvals += 1; return false; },
  });

  assert.equal(result.status, "completed");
  assert.equal(approvals, 0);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "src", "app.js"), "utf8"), "const mode = 'after';\nconsole.log(mode);\n");
  assert.deepEqual(result.fileChanges.summary, { created: 0, modified: 1, deleted: 0, total: 1 });
  assert.equal(result.fileChanges.changes[0].path, "src/app.js");
  const diff = await fixture.store.artifacts.get(result.fileChanges.diffArtifact.id, { sessionId: fixture.session.id });
  assert.match(diff.content, /-const mode = 'before';/);
  assert.match(diff.content, /\+const mode = 'after';/);
  const completed = fixture.session.state.events.findLast((event) => event.callId === "edit-success");
  assert.equal(completed.fileChanges.changes[0].operation, "modified");
});

test("edit_file 在匹配缺失或歧义时不写入", async (t) => {
  const fixture = await createFixture(t, "nexus-edit-file-mismatch-");
  const file = path.join(fixture.workspace, "repeated.txt");
  await fs.writeFile(file, "same\nsame\n");

  const ambiguous = await fixture.host.execute({
    id: "edit-ambiguous",
    name: "edit_file",
    arguments: { path: "repeated.txt", old_text: "same", new_text: "changed" },
  }, { session: fixture.session, requestApproval: async () => false });
  assert.equal(ambiguous.status, "external_failed");
  assert.match(ambiguous.result, /预期匹配 1 处，实际匹配 2 处/);
  assert.equal(ambiguous.fileChanges, undefined);
  assert.equal(await fs.readFile(file, "utf8"), "same\nsame\n");

  const missing = await fixture.host.execute({
    id: "edit-missing",
    name: "edit_file",
    arguments: { path: "repeated.txt", old_text: "absent", new_text: "changed" },
  }, { session: fixture.session, requestApproval: async () => false });
  assert.equal(missing.status, "external_failed");
  assert.match(missing.result, /实际匹配 0 处/);
  assert.equal(await fs.readFile(file, "utf8"), "same\nsame\n");
});

test("edit_file 支持显式多处替换并保留 UTF-8 BOM 与 CRLF", async (t) => {
  const fixture = await createFixture(t, "nexus-edit-file-multiple-");
  const file = path.join(fixture.workspace, "unicode.txt");
  await fs.writeFile(file, "\uFEFF旧值\r\n旧值\r\n");

  const result = await fixture.host.execute({
    id: "edit-multiple",
    name: "edit_file",
    arguments: {
      path: "unicode.txt",
      old_text: "旧值",
      new_text: "新值",
      expected_replacements: 2,
    },
  }, { session: fixture.session, requestApproval: async () => false });

  assert.equal(result.status, "completed");
  assert.match(result.result, /替换 2 处/);
  assert.equal(await fs.readFile(file, "utf8"), "\uFEFF新值\r\n新值\r\n");
});

test("edit_file 通过工作区内符号链接编辑时审计真实目标", async (t) => {
  const fixture = await createFixture(t, "nexus-edit-file-link-");
  await fs.writeFile(path.join(fixture.workspace, "target.txt"), "before\n");
  await fs.symlink("target.txt", path.join(fixture.workspace, "link.txt"));

  const result = await fixture.host.execute({
    id: "edit-link",
    name: "edit_file",
    arguments: { path: "link.txt", old_text: "before", new_text: "after" },
  }, { session: fixture.session, requestApproval: async () => false });

  assert.equal(result.status, "completed");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "target.txt"), "utf8"), "after\n");
  assert.deepEqual(result.fileChanges.changes.map((change) => [change.path, change.operation]), [
    ["target.txt", "modified"],
  ]);
});

test("read-only 不向模型暴露 edit_file", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-edit-file-read-only-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const profile = createPermissionProfile({ name: "read-only", workspace, executionType: "native" });
  const registry = createToolRegistry({ workspace, accessPolicy: profile });
  const host = new ToolHost({
    registry,
    policy: new WorkspacePolicy({}, { profile, allowElevation: false }),
  });

  assert.equal(host.schemas().some((schema) => schema.function.name === "edit_file"), false);
});

async function createFixture(t, prefix) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(() => store.close());
  const initial = createSession({ id: `${prefix}session`, provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const profile = createPermissionProfile({ name: "workspace-auto", workspace, executionType: "native" });
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts, accessPolicy: profile });
  const host = new ToolHost({
    registry,
    artifactStore: store.artifacts,
    policy: new WorkspacePolicy({}, { profile, allowElevation: false }),
  });
  return { workspace, store, session, host };
}
