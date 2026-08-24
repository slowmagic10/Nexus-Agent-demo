import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";

test("关闭 Gateway 会取消仍在运行的任务", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const provider = {
    name: "waiting-provider",
    complete: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  };
  const manager = new GatewaySessionManager({
    workspace,
    provider,
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  const session = await manager.create();
  await manager.sendMessage(session.id, "保持运行");

  await manager.close();

  assert.equal((await manager.get(session.id)).phase, "cancelled");
  assert.equal((await manager.get(session.id)).lastError, "Gateway 正在关闭");
});

test("Gateway 从指定游标补发事件后继续推送实时事件", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-events-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: {
      name: "instant-provider",
      complete: async () => ({ text: "完成", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
    },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const session = await manager.create();
  const events = [];
  const unsubscribe = await manager.subscribeEvents(session.id, (event) => events.push(event), { after: 1 });
  await manager.sendMessage(session.id, "执行");
  await waitFor(() => events.some((event) => event.type === "COMPLETED"));
  unsubscribe();

  assert.equal(events[0].cursor, 2);
  assert.ok(events.every((event, index) => index === 0 || event.cursor > events[index - 1].cursor));
  assert.equal(await manager.cursor(session.id), events.at(-1).cursor);
});

test("Gateway 可以导出 journal 并从指定 cursor 创建分支", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-branch-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "branch-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const parent = await manager.create();
  const archive = await manager.exportSession(parent.id);
  const child = await manager.branch(parent.id, { cursor: 1 });

  assert.equal(archive.format, "nexus.session-journal");
  assert.equal(archive.session.cursor, 1);
  assert.equal(child.lineage.parentSessionId, parent.id);
  assert.equal(child.lineage.parentCursor, 1);
  await assert.rejects(manager.branch(parent.id, { cursor: 2 }), /cursor 必须是/);
});

test("Gateway 可导入 journal，并把存储错误映射为客户端错误", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-import-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "import-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const source = await manager.create();
  const archive = await manager.exportSession(source.id);
  const imported = await manager.importSession(archive, { id: "session-gateway-imported" });

  assert.equal(imported.id, "session-gateway-imported");
  assert.equal(imported.workspace, workspace);
  await assert.rejects(
    manager.importSession(archive, { id: imported.id }),
    (error) => error.status === 409 && /会话已存在/.test(error.message),
  );
  archive.events[0].baseline.provider = "tampered";
  await assert.rejects(
    manager.importSession(archive, { id: "session-invalid-import" }),
    (error) => error.status === 400 && /checksum/.test(error.message),
  );
});

test("Gateway 可查看、验证来源并软删除长期记忆", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-memory-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "memory-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const record = await manager.addMemory("偏好深色主题", ["preference"]);
  assert.equal((await manager.listMemories("深色"))[0].id, record.id);
  const verification = await manager.verifyMemory(record.id);
  assert.equal(verification.record.provenance.origin, "user_explicit");
  assert.equal(verification.events[0].type, "memory.added");

  await manager.deleteMemory(record.id, "用户修改偏好");
  assert.deepEqual(await manager.listMemories("深色"), []);
  assert.equal((await manager.verifyMemory(record.id)).record.status, "deleted");
  await assert.rejects(manager.deleteMemory(record.id), (error) => error.status === 404);
});

test("Gateway 暴露 Memory mutation retry、discard 与 resolve API", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-mutation-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "mutation-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const state = await manager.create();
  const session = manager.sessions.get(state.id).session;
  const mutation = (id, content) => ({
    id,
    operation: "add",
    candidate: { content },
    scope: session.state.memoryScope,
    provenance: { origin: "user_explicit" },
  });

  const retry = mutation("gateway-retry", "Gateway retry fact");
  await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: retry });
  await session.dispatch({
    type: "MEMORY_MUTATION_FAILED",
    mutationId: retry.id,
    error: "temporary",
    retryable: true,
  });
  const retried = await manager.retryMemoryMutation(state.id, retry.id);
  assert.deepEqual(retried.memoryMutationIssues, []);
  assert.equal((await manager.listMemories("Gateway retry"))[0].content, "Gateway retry fact");

  const discarded = mutation("gateway-discard", "Gateway discard fact");
  await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: discarded });
  assert.deepEqual((await manager.discardMemoryMutation(state.id, discarded.id, "用户放弃")).pendingMemoryMutations, []);

  const resolved = mutation("gateway-resolve", "Gateway resolve fact");
  await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: resolved });
  await assert.rejects(
    manager.resolveMemoryMutation(state.id, resolved.id, "bypass"),
    (error) => error.status === 404 && /待处理/.test(error.message),
  );
  await session.dispatch({
    type: "MEMORY_MUTATION_MANUAL_REQUIRED",
    mutationId: resolved.id,
    error: "人工确认",
    retryable: true,
    outcome: "safe_to_retry",
  });
  const resolvedState = await manager.resolveMemoryMutation(state.id, resolved.id, "external-memory");
  assert.deepEqual(resolvedState.pendingMemoryMutations, []);
  assert.ok(resolvedState.events.some((event) => (
    event.type === "memory.mutation_applied" && event.memoryId === "external-memory"
  )));
});

async function waitFor(predicate) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("等待事件超时");
}
