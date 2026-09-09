import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
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
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";

test("采集复用文件读取策略，合成凭据正文不进入快照或 Diff", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-protected-");
  const protectedPaths = [".aws/credentials", ".ssh/id_rsa", ".npmrc", ".env.local", "nested/.aws/credentials", "nested/.ssh/config"];
  for (const file of protectedPaths) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), "synthetic-private-before\n");
  }
  await fs.writeFile(path.join(workspace, "public.txt"), "before\n");
  const capture = await beginFileChangeCapture({ workspace });
  assert.doesNotMatch(JSON.stringify([...capture.before.files]), /synthetic-private/);
  for (const file of protectedPaths) await fs.writeFile(path.join(workspace, file), "synthetic-private-after\n");
  await fs.writeFile(path.join(workspace, "public.txt"), "after\n");
  const { manifest, diff } = await finishFileChangeCapture(capture);
  assert.equal(manifest.complete, false);
  assert.ok(manifest.issues.some((issue) => issue.reason === "read_denied"));
  assert.deepEqual(manifest.changes.map((change) => change.path), ["public.txt"]);
  assert.doesNotMatch(diff, /synthetic-private/);
  assert.match(diff, /-before/);
  assert.match(diff, /\+after/);
});

test("路径采集拒绝符号链接的受限及工作区外真实目标", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-protected-link-");
  const outside = await fixture(t, "nexus-file-change-outside-");
  await fs.mkdir(path.join(workspace, ".aws"));
  await fs.writeFile(path.join(workspace, ".aws", "credentials"), "synthetic-private-before\n");
  await fs.writeFile(path.join(outside, "external.txt"), "synthetic-external-before\n");
  await fs.symlink(".aws/credentials", path.join(workspace, "secret-link.txt"));
  await fs.symlink(outside, path.join(workspace, "outside-dir"));
  const capture = await beginFileChangeCapture({ workspace, mode: "paths", paths: ["secret-link.txt", "outside-dir/external.txt"] });
  assert.equal(capture.before.files.size, 0);
  await fs.writeFile(path.join(workspace, ".aws", "credentials"), "synthetic-private-after\n");
  const result = await finishFileChangeCapture(capture);
  assert.equal(result.manifest.complete, false);
  assert.equal(result.diff, "");
  assert.equal(result.manifest.summary.total, 0);
});

test("后置读取权限收紧时不把前置正文伪装成删除 Diff", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-revoked-read-");
  await fs.writeFile(path.join(workspace, "restricted.txt"), "synthetic-revoked-before\n");
  let allowed = true;
  const capture = await beginFileChangeCapture({ workspace, authorizeRead: () => allowed });
  allowed = false;
  const result = await finishFileChangeCapture(capture);
  assert.equal(result.manifest.complete, false);
  assert.equal(result.manifest.summary.total, 0);
  assert.equal(result.diff, "");
});

test("Tool Host 使用 Session 当前 Access Policy 和 Workspace read 规则采集", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-current-policy-");
  const files = ["profile-private.txt", "workspace-private.txt", "public.txt", ".aws/credentials", ".ssh/id_rsa", ".npmrc", "nested/.env.local"];
  for (const name of files) {
    await fs.mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await fs.writeFile(path.join(workspace, name), `synthetic-${name}-before\n`);
  }
  const defaultProfile = createPermissionProfile({ name: "workspace-auto", workspace, executionType: "local" });
  const currentProfile = createPermissionProfile({ name: "workspace-confirm", workspace, executionType: "local" });
  const assertPath = currentProfile.assertPath.bind(currentProfile);
  currentProfile.assertPath = (relative, access) => {
    if (access === "read" && relative === "profile-private.txt") throw new Error("custom read denied");
    return assertPath(relative, access);
  };
  const initial = createSession({ provider: "test", workspace, permissionProfile: "workspace-confirm" });
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(() => store.close());
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const registry = createToolRegistry({
    workspace, accessPolicy: defaultProfile, accessPolicies: new Map([[currentProfile.name, currentProfile]]),
    workspaceExecution: { id: "fake-workspace", execute: async () => {
      for (const name of files) await fs.writeFile(path.join(workspace, name), `synthetic-${name}-after\n`);
      return { exitCode: 0, output: "done" };
    } },
  });
  const policy = new WorkspacePolicy({ rules: [{ id: "deny-private-read", tools: ["read_file"], pathPrefixes: ["workspace-private.txt"], decision: "deny" }] }, { profile: currentProfile });
  const host = new ToolHost({ registry, policy, artifactStore: store.artifacts });
  const result = await host.execute({ id: "current-policy", name: "run_shell", arguments: { command: "build" } }, { session, requestApproval: async () => true });
  assert.equal(result.ok, true);
  assert.equal(result.fileChanges.complete, false);
  assert.deepEqual(result.fileChanges.changes.map((change) => change.path), ["public.txt"]);
  const artifact = await store.artifacts.get(result.fileChanges.diffArtifact.id, { sessionId: session.id });
  assert.doesNotMatch(artifact.content, /synthetic-(profile|workspace)-private/);
  assert.doesNotMatch(artifact.content, /synthetic-.*(?:credentials|id_rsa|npmrc|env\.local)/);
  assert.match(artifact.content, /synthetic-public.txt-after/);
});

test("Shell 审批不授权额外审计读取，执行后新读审批规则也阻止旧正文落盘", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-read-approval-");
  await fs.writeFile(path.join(workspace, "private.txt"), "synthetic-before-read-revocation\n");
  const initial = createSession({ provider: "test", workspace });
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(() => store.close());
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const policy = new WorkspacePolicy();
  const registry = createToolRegistry({ workspace, workspaceExecution: { id: "fake-workspace", execute: async () => {
    await fs.writeFile(path.join(workspace, "private.txt"), "synthetic-after-read-revocation\n");
    policy.replace({ rules: [{ id: "read-needs-approval", tools: ["read_file"], decision: "approval_required" }] });
    return { exitCode: 0, output: "done" };
  } } });
  const host = new ToolHost({ registry, policy, artifactStore: store.artifacts });
  let approvals = 0;
  const result = await host.execute({ id: "approval-revocation", name: "run_shell", arguments: { command: "build" } }, {
    session, requestApproval: async () => { approvals += 1; return { approved: true, scope: "session" }; },
  });
  assert.equal(approvals, 1);
  assert.equal(result.ok, true);
  assert.equal(result.fileChanges.complete, false);
  assert.equal(result.fileChanges.summary.total, 0);
  assert.equal(result.fileChanges.diffArtifact, undefined);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-(before|after)-read-revocation/);
});

test("读取前并发换链不会让受限正文进入快照", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-swap-link-");
  await fs.mkdir(path.join(workspace, ".aws"));
  await fs.writeFile(path.join(workspace, ".aws", "credentials"), "synthetic-swapped-secret\n");
  await fs.writeFile(path.join(workspace, "public.txt"), "before\n");
  const open = fs.open.bind(fs);
  const canonicalFile = path.join(await fs.realpath(workspace), "public.txt");
  let swapped = false;
  t.mock.method(fs, "open", async (target, ...args) => {
    if (target === canonicalFile && !swapped) {
      swapped = true;
      await fs.unlink(target);
      await fs.symlink(".aws/credentials", target);
    }
    return open(target, ...args);
  });
  const capture = await beginFileChangeCapture({ workspace, mode: "paths", paths: ["public.txt"] });
  assert.equal(swapped, true);
  assert.doesNotMatch(JSON.stringify([...capture.before.files]), /synthetic-swapped-secret/);
  const result = await finishFileChangeCapture(capture);
  assert.equal(result.manifest.complete, false);
  assert.equal(result.diff, "");
});

test("父目录并发换成外部链接时打开的描述符不会读取任何正文", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-swap-directory-");
  const outside = await fixture(t, "nexus-file-change-swap-external-");
  await fs.mkdir(path.join(workspace, "src"));
  await fs.writeFile(path.join(workspace, "src", "public.txt"), "allowed-before\n");
  await fs.writeFile(path.join(outside, "public.txt"), "synthetic-outside-secret\n");
  const canonicalRoot = await fs.realpath(workspace);
  const open = fs.open.bind(fs);
  let swapped = false;
  let reads = 0;
  t.mock.method(fs, "open", async (target, ...args) => {
    if (target === path.join(canonicalRoot, "src", "public.txt") && !swapped) {
      swapped = true;
      await fs.rename(path.join(workspace, "src"), path.join(workspace, "src-before"));
      await fs.symlink(outside, path.join(workspace, "src"));
    }
    const handle = await open(target, ...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", (...readArgs) => { reads += 1; return read(...readArgs); });
    return handle;
  });
  const capture = await beginFileChangeCapture({ workspace, mode: "paths", paths: ["src/public.txt"] });
  assert.equal(swapped, true);
  assert.equal(reads, 0);
  assert.equal(capture.before.files.size, 0);
  assert.equal(capture.before.complete, false);
});

test("普通文件并发换成 FIFO 时采集有界退出且不读取管道", { skip: process.platform === "win32" }, async (t) => {
  const workspace = await fixture(t, "nexus-file-change-swap-fifo-");
  const file = path.join(await fs.realpath(workspace), "input.txt");
  await fs.writeFile(file, "ordinary input\n");
  const open = fs.open.bind(fs);
  let nonblocking = false;
  let swapped = false;
  let reads = 0;
  t.mock.method(fs, "open", async (target, flags, ...args) => {
    if (target === file && !swapped) {
      swapped = true;
      await fs.unlink(file);
      execFileSync("mkfifo", [file], { timeout: 1_000 });
      nonblocking = Boolean(flags & constants.O_NONBLOCK);
      // A regressed implementation must fail the assertion below without
      // hanging the entire test process waiting for a FIFO writer.
      if (!nonblocking) throw new Error("blocking FIFO open prevented by test");
    }
    const handle = await open(target, flags, ...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", (...readArgs) => { reads += 1; return read(...readArgs); });
    return handle;
  });
  const capture = await beginFileChangeCapture({ workspace, mode: "paths", paths: ["input.txt"] });
  assert.equal(swapped, true);
  assert.equal(nonblocking, true);
  assert.equal(reads, 0);
  assert.equal(capture.before.files.size, 0);
  assert.equal(capture.before.complete, false);
});

test("普通悬空符号链接与 .. 前缀合法文件仍可完整审计", async (t) => {
  const workspace = await fixture(t, "nexus-file-change-safe-paths-");
  const capture = await beginFileChangeCapture({ workspace, mode: "paths", paths: ["missing-link.txt", "..safe.txt"] });
  await fs.symlink("not-yet-created.txt", path.join(workspace, "missing-link.txt"));
  await fs.writeFile(path.join(workspace, "..safe.txt"), "allowed\n");
  const result = await finishFileChangeCapture(capture);
  assert.equal(result.manifest.complete, true);
  assert.equal(result.manifest.summary.created, 2);
  assert.match(result.diff, /symlink -> not-yet-created.txt/);
});

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
