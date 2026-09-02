import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { applyWorkspacePatch } from "../src/tools/apply-patch.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { ToolHost } from "../src/tools/host.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("apply_patch 在一个 Tool Call 中新增、更新、删除并生成完整 Manifest", async (t) => {
  const fixture = await createFixture(t, "nexus-apply-patch-");
  await fs.mkdir(path.join(fixture.workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(fixture.workspace, "src", "update.js"), "export const value = 1;\n");
  await fs.writeFile(path.join(fixture.workspace, "src", "delete.js"), "delete me\n");
  let approvals = 0;

  const result = await fixture.host.execute({
    id: "patch-success",
    name: "apply_patch",
    arguments: {
      operations: [
        { operation: "add", path: "src/added.js", content: "export const added = true;\n" },
        { operation: "update", path: "src/update.js", old_text: "value = 1", new_text: "value = 2" },
        { operation: "update", path: "src/update.js", old_text: ";\n", new_text: ";\nexport const patched = true;\n" },
        { operation: "delete", path: "src/delete.js" },
      ],
    },
  }, {
    session: fixture.session,
    requestApproval: async () => { approvals += 1; return false; },
  });

  assert.equal(result.status, "completed");
  assert.equal(approvals, 0);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "src", "added.js"), "utf8"), "export const added = true;\n");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "src", "update.js"), "utf8"), "export const value = 2;\nexport const patched = true;\n");
  await assert.rejects(fs.stat(path.join(fixture.workspace, "src", "delete.js")), /ENOENT/);
  assert.deepEqual(result.fileChanges.summary, { created: 1, modified: 1, deleted: 1, total: 3 });
  assert.deepEqual(result.fileChanges.changes.map((change) => [change.path, change.operation]), [
    ["src/added.js", "created"],
    ["src/delete.js", "deleted"],
    ["src/update.js", "modified"],
  ]);
  const authorization = fixture.session.state.events.find((event) => (
    event.type === "tool.authorization_decided" && event.callId === "patch-success"
  ));
  assert.deepEqual(authorization.resources.map((resource) => resource.value).sort(), [
    "src/added.js",
    "src/delete.js",
    "src/update.js",
  ]);
  const diff = await fixture.store.artifacts.get(result.fileChanges.diffArtifact.id, { sessionId: fixture.session.id });
  assert.match(diff.content, /\+export const added = true;/);
  assert.match(diff.content, /-export const value = 1;/);
  assert.match(diff.content, /\+export const value = 2;/);
  assert.match(diff.content, /\+export const patched = true;/);
  assert.match(diff.content, /-delete me/);
});

test("apply_patch 任一预检失败时所有文件保持不变", async (t) => {
  const fixture = await createFixture(t, "nexus-apply-patch-preflight-");
  await fs.writeFile(path.join(fixture.workspace, "first.txt"), "before first\n");
  await fs.writeFile(path.join(fixture.workspace, "second.txt"), "before second\n");

  const result = await fixture.host.execute({
    id: "patch-preflight-failure",
    name: "apply_patch",
    arguments: {
      operations: [
        { operation: "update", path: "first.txt", old_text: "before", new_text: "after" },
        { operation: "add", path: "created.txt", content: "should not exist\n" },
        { operation: "update", path: "second.txt", old_text: "missing", new_text: "after" },
      ],
    },
  }, { session: fixture.session, requestApproval: async () => false });

  assert.equal(result.status, "external_failed");
  assert.match(result.result, /所有文件均未修改/);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "first.txt"), "utf8"), "before first\n");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "second.txt"), "utf8"), "before second\n");
  await assert.rejects(fs.stat(path.join(fixture.workspace, "created.txt")), /ENOENT/);
  assert.equal(result.fileChanges, undefined);
});

test("apply_patch 在提交中失败时回滚已经写入的文件", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-apply-patch-rollback-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const first = path.join(workspace, "first.txt");
  const second = path.join(workspace, "second.txt");
  await fs.writeFile(first, "first before\n");
  await fs.writeFile(second, "second before\n");
  let failed = false;
  const fileSystem = {
    realpath: (...args) => fs.realpath(...args),
    lstat: (...args) => fs.lstat(...args),
    stat: (...args) => fs.stat(...args),
    readFile: (...args) => fs.readFile(...args),
    unlink: (...args) => fs.unlink(...args),
    mkdir: (...args) => fs.mkdir(...args),
    chmod: (...args) => fs.chmod(...args),
    rm: (...args) => fs.rm(...args),
    writeFile: async (file, ...args) => {
      if (path.basename(file) === "second.txt" && !failed) {
        failed = true;
        await fs.writeFile(file, ...args);
        const error = new Error("injected write failure");
        error.code = "EIO";
        throw error;
      }
      return fs.writeFile(file, ...args);
    },
  };

  await assert.rejects(applyWorkspacePatch({
    workspace,
    operations: [
      { operation: "update", path: "first.txt", old_text: "before", new_text: "after" },
      { operation: "update", path: "second.txt", old_text: "before", new_text: "after" },
    ],
    accessPolicy: { assertPath: () => ({ decision: "allow" }) },
    fileSystem,
  }), /已回滚所有已提交文件/);

  assert.equal(await fs.readFile(first, "utf8"), "first before\n");
  assert.equal(await fs.readFile(second, "utf8"), "second before\n");
});

test("apply_patch 对重复真实目标和受保护路径 fail closed", async (t) => {
  const fixture = await createFixture(t, "nexus-apply-patch-policy-");
  await fs.writeFile(path.join(fixture.workspace, "target.txt"), "before\n");
  await fs.symlink("target.txt", path.join(fixture.workspace, "link.txt"));

  const duplicate = await fixture.host.execute({
    id: "patch-duplicate",
    name: "apply_patch",
    arguments: { operations: [
      { operation: "update", path: "target.txt", old_text: "before", new_text: "after" },
      { operation: "update", path: "link.txt", old_text: "before", new_text: "other" },
    ] },
  }, { session: fixture.session, requestApproval: async () => false });
  assert.equal(duplicate.status, "external_failed");
  assert.match(duplicate.result, /重复目标/);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "target.txt"), "utf8"), "before\n");

  const protectedResult = await fixture.host.execute({
    id: "patch-protected",
    name: "apply_patch",
    arguments: { operations: [
      { operation: "update", path: "target.txt", old_text: "before", new_text: "after" },
      { operation: "add", path: ".env-secret", content: "TOKEN=secret\n" },
    ] },
  }, { session: fixture.session, requestApproval: async () => false });
  assert.equal(protectedResult.status, "policy_denied");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "target.txt"), "utf8"), "before\n");
  await assert.rejects(fs.stat(path.join(fixture.workspace, ".env-secret")), /ENOENT/);
  assert.equal(fixture.session.state.events.some((event) => (
    event.type === "tool.execution_started" && event.callId === "patch-protected"
  )), false);
});

test("apply_patch 拒绝空批次且 read-only 不向模型暴露", async (t) => {
  const fixture = await createFixture(t, "nexus-apply-patch-validation-");
  const invalid = await fixture.host.execute({
    id: "patch-empty",
    name: "apply_patch",
    arguments: { operations: [] },
  }, { session: fixture.session, requestApproval: async () => false });
  assert.equal(invalid.status, "validation_failed");

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-apply-patch-read-only-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const profile = createPermissionProfile({ name: "read-only", workspace, executionType: "native" });
  const registry = createToolRegistry({ workspace, accessPolicy: profile });
  const host = new ToolHost({
    registry,
    policy: new WorkspacePolicy({}, { profile, allowElevation: false }),
  });
  assert.equal(host.schemas().some((schema) => schema.function.name === "apply_patch"), false);
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
