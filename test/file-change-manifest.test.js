import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import {
  beginFileChangeCapture,
  finishFileChangeCapture,
} from "../src/artifacts/file-change-manifest.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { ToolHost } from "../src/tools/host.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("File Change Capture 识别新增、修改、删除并忽略秘密与内部目录", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "modify.js"), "const value = 1;\n");
  await fs.writeFile(path.join(workspace, "src", "delete.js"), "delete me\n");
  await fs.writeFile(path.join(workspace, ".env-secret"), "TOKEN=before\n");
  const capture = await beginFileChangeCapture({ workspace, mode: "workspace" });

  await fs.writeFile(path.join(workspace, "src", "modify.js"), "const value = 2;\n");
  await fs.writeFile(path.join(workspace, "src", "create.js"), "created\n");
  await fs.rm(path.join(workspace, "src", "delete.js"));
  await fs.writeFile(path.join(workspace, ".env-secret"), "TOKEN=after\n");
  const result = await finishFileChangeCapture(capture);

  assert.deepEqual(result.manifest.summary, { created: 1, modified: 1, deleted: 1, total: 3 });
  assert.deepEqual(result.manifest.changes.map(({ path: file, operation }) => [file, operation]), [
    ["src/create.js", "created"],
    ["src/delete.js", "deleted"],
    ["src/modify.js", "modified"],
  ]);
  assert.doesNotMatch(result.diff, /TOKEN|\.env/);
  assert.match(result.diff, /-const value = 1;/);
  assert.match(result.diff, /\+const value = 2;/);
});

test("write_file 将 Manifest 与脱敏 Diff Artifact 写入 durable TOOL_RESULT", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-host-");
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(() => store.close());
  const initial = createSession({ id: "session-file-change", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts });
  const host = new ToolHost({ registry, artifactStore: store.artifacts });

  const result = await host.execute({
    id: "call-write-manifest",
    name: "write_file",
    arguments: { path: "src/secret.txt", content: "Authorization: Bearer top-secret-token-value\n" },
  }, { session, requestApproval: async () => ({ approved: true, scope: "once" }) });

  assert.equal(result.ok, true);
  assert.equal(result.fileChanges.summary.created, 1);
  const completed = session.state.events.findLast((event) => event.type === "tool.completed");
  assert.equal(completed.fileChanges.changes[0].path, "src/secret.txt");
  assert.equal(completed.fileChanges.diffArtifact.kind, "file_diff");
  const diff = await store.artifacts.get(completed.fileChanges.diffArtifact.id, { sessionId: session.id });
  assert.match(diff.content, /\[REDACTED\]/);
  assert.doesNotMatch(diff.content, /top-secret-token-value/);
  assert.match(session.state.messages.at(-1).content, /文件变更：新增 1/);

  const branch = store.branchSession(session.id, {
    id: "session-file-change-branch",
    cursor: session.cursor,
    provider: session.state.provider,
    workspace,
  });
  assert.match((await store.artifacts.get(completed.fileChanges.diffArtifact.id, {
    sessionId: branch.id,
  })).content, /\[REDACTED\]/);

  const importedWorkspace = await fixture(t, "nexus-file-change-import-");
  const importedStore = new SessionStore(path.join(importedWorkspace, ".nexus", "nexus.db"), {
    workspace: importedWorkspace,
  });
  t.after(() => importedStore.close());
  const imported = importedStore.importJournal(store.exportJournal(session.id), {
    id: "session-file-change-imported",
    workspace: importedWorkspace,
  });
  const importedEvent = importedStore.listSessionEvents(imported.id)
    .find((event) => event.type === "TOOL_RESULT");
  assert.equal(importedEvent.fileChanges.diffArtifact.sessionId, imported.id);
  assert.match((await importedStore.artifacts.get(importedEvent.fileChanges.diffArtifact.id, {
    sessionId: imported.id,
  })).content, /\[REDACTED\]/);

  const importedBranch = importedStore.importJournal(store.exportJournal(branch.id), {
    id: "session-file-change-branch-imported",
    workspace: importedWorkspace,
  });
  const importedBranchEvent = importedStore.load(importedBranch.id).events
    .find((event) => event.fileChanges?.diffArtifact);
  assert.equal(importedBranchEvent.fileChanges.diffArtifact.sessionId, importedBranch.id);
  assert.match((await importedStore.artifacts.get(importedBranchEvent.fileChanges.diffArtifact.id, {
    sessionId: importedBranch.id,
  })).content, /\[REDACTED\]/);
});

test("run_shell 通过统一 Tool Host 采集工作区变化", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-shell-");
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(() => store.close());
  const initial = createSession({ id: "session-shell-change", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const registry = createToolRegistry({
    workspace,
    artifactStore: store.artifacts,
    workspaceExecution: {
      id: "fake-workspace",
      execute: async () => {
        await fs.writeFile(path.join(workspace, "shell-created.txt"), "created by shell\n");
        return { exitCode: 0, output: "done" };
      },
    },
  });
  const host = new ToolHost({ registry, artifactStore: store.artifacts });
  const result = await host.execute({
    id: "call-shell-change",
    name: "run_shell",
    arguments: { command: "touch shell-created.txt" },
  }, { session, requestApproval: async () => ({ approved: true, scope: "once" }) });

  assert.equal(result.fileChanges.summary.created, 1);
  assert.equal(result.fileChanges.changes[0].path, "shell-created.txt");
  assert.equal(result.fileChanges.diffArtifact.kind, "file_diff");
});

test("write_file 通过工作区内符号链接写入时审计真实目标", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-write-link-");
  await fs.writeFile(path.join(workspace, "target.txt"), "before");
  await fs.symlink("target.txt", path.join(workspace, "link.txt"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(() => store.close());
  const initial = createSession({ id: "session-write-link", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts });
  const host = new ToolHost({ registry, artifactStore: store.artifacts });

  const result = await host.execute({
    id: "call-write-link",
    name: "write_file",
    arguments: { path: "link.txt", content: "after" },
  }, { session, requestApproval: async () => ({ approved: true, scope: "once" }) });

  assert.equal(await fs.readFile(path.join(workspace, "target.txt"), "utf8"), "after");
  assert.equal(result.fileChanges.summary.modified, 1);
  assert.deepEqual(result.fileChanges.changes.map((change) => [change.path, change.operation]), [
    ["target.txt", "modified"],
  ]);
  const completed = session.state.events.findLast((event) => event.callId === "call-write-link");
  assert.equal(completed.fileChanges.changes[0].path, "target.txt");
  const diff = await store.artifacts.get(result.fileChanges.diffArtifact.id, { sessionId: session.id });
  assert.match(diff.content, /-before/);
  assert.match(diff.content, /\+after/);
});

test("run_shell 创建、改指向和删除符号链接时记录链接变化", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-shell-link-");
  await fs.writeFile(path.join(workspace, "target-a.txt"), "a\n");
  await fs.writeFile(path.join(workspace, "target-b.txt"), "b\n");
  await fs.symlink("target-a.txt", path.join(workspace, "changed-link.txt"));
  await fs.symlink("target-a.txt", path.join(workspace, "deleted-link.txt"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(() => store.close());
  const initial = createSession({ id: "session-shell-link", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const registry = createToolRegistry({
    workspace,
    artifactStore: store.artifacts,
    workspaceExecution: {
      id: "fake-workspace",
      execute: async () => {
        await fs.unlink(path.join(workspace, "changed-link.txt"));
        await fs.symlink("target-b.txt", path.join(workspace, "changed-link.txt"));
        await fs.unlink(path.join(workspace, "deleted-link.txt"));
        await fs.symlink("target-a.txt", path.join(workspace, "created-link.txt"));
        return { exitCode: 0, output: "links changed" };
      },
    },
  });
  const host = new ToolHost({ registry, artifactStore: store.artifacts });

  const result = await host.execute({
    id: "call-shell-link",
    name: "run_shell",
    arguments: { command: "update links" },
  }, { session, requestApproval: async () => ({ approved: true, scope: "once" }) });

  assert.equal(result.fileChanges.complete, true);
  assert.deepEqual(result.fileChanges.summary, { created: 1, modified: 1, deleted: 1, total: 3 });
  assert.deepEqual(result.fileChanges.changes.map((change) => [change.path, change.operation]), [
    ["changed-link.txt", "modified"],
    ["created-link.txt", "created"],
    ["deleted-link.txt", "deleted"],
  ]);
  assert.equal(result.fileChanges.changes[0].after.kind, "symlink");
  assert.equal(result.fileChanges.changes[0].after.linkTarget, "target-b.txt");
  const diff = await store.artifacts.get(result.fileChanges.diffArtifact.id, { sessionId: session.id });
  assert.match(diff.content, /-symlink -> target-a\.txt/);
  assert.match(diff.content, /\+symlink -> target-b\.txt/);
});

async function fixture(t, prefix) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}
