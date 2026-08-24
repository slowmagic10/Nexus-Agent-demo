import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { MemoryFlushPolicy } from "../src/memory/flush-policy.js";
import { createMemoryScope } from "../src/memory/scope.js";
import { SessionStore } from "../src/persistence/session-store.js";

test("MemoryFlushPolicy 只创建 candidate，跳过已有事实并保留来源", async (t) => {
  const fixture = await createFixture(t);
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace: fixture.workspace, memoryScope: fixture.scope }),
    reducer: reduceSession,
    journal: fixture.store,
  });
  await fixture.store.memory.add({ content: "项目使用 Node.js" }, {
    scope: fixture.scope,
    provenance: { origin: "user_explicit", actor: fixture.scope.userId },
  });
  await session.dispatch({ type: "USER_MESSAGE", content: "我偏好深色主题，项目使用 Node.js" });
  const sourceCursor = session.cursor;
  await session.dispatch({ type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "知道了" } });
  await session.dispatch({ type: "COMPLETED" });

  const policy = new MemoryFlushPolicy({
    memory: fixture.store.memory,
    extractCandidates: async () => [
      { content: "偏好深色主题", kind: "preference", confidence: 0.9, tags: ["ui"] },
      { content: "项目使用 Node.js", kind: "fact", confidence: 0.8 },
    ],
  });
  const created = await policy.flush({
    session,
    messages: session.state.messages,
    sourceCursor,
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].status, "candidate");
  assert.deepEqual(await fixture.store.memory.search("偏好深色主题", { scope: fixture.scope }), []);
  const [candidate] = await fixture.store.memory.search("偏好深色主题", { scope: fixture.scope }, {
    statuses: ["candidate"],
  });
  assert.equal(candidate.sourceSession, session.id);
  assert.equal(candidate.sourceCursor, sourceCursor);
  assert.equal(candidate.provenance.origin, "auto_extract");
  assert.ok(session.state.events.some((event) => event.type === "memory.flush_requested"));
  assert.ok(session.state.events.some((event) => (
    event.type === "memory.candidate_created" && event.memoryId === candidate.id
  )));
  assert.ok(session.state.events.some((event) => (
    event.type === "memory.flush_completed" && event.created === 1 && event.skipped === 1
  )));
});

test("MemoryFlushPolicy 提取失败只记录 degraded，不改变已完成 turn", async (t) => {
  const fixture = await createFixture(t);
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace: fixture.workspace, memoryScope: fixture.scope }),
    reducer: reduceSession,
    journal: fixture.store,
  });
  await session.dispatch({ type: "USER_MESSAGE", content: "普通对话" });
  const sourceCursor = session.cursor;
  await session.dispatch({ type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "完成" } });
  await session.dispatch({ type: "COMPLETED" });
  const policy = new MemoryFlushPolicy({
    memory: fixture.store.memory,
    extractCandidates: async () => { throw new Error("extractor unavailable"); },
  });

  assert.deepEqual(await policy.flush({ session, messages: session.state.messages, sourceCursor }), []);
  assert.equal(session.state.phase, "completed");
  const degraded = session.state.events.find((event) => event.type === "memory.flush_degraded");
  assert.match(degraded.error, /extractor unavailable/);
});

test("MemoryFlushPolicy 对忽略 AbortSignal 的 extractor 执行 deadline", async (t) => {
  const fixture = await createFixture(t);
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace: fixture.workspace, memoryScope: fixture.scope }),
    reducer: reduceSession,
    journal: fixture.store,
  });
  const policy = new MemoryFlushPolicy({
    memory: fixture.store.memory,
    extractCandidates: async () => new Promise(() => {}),
    timeoutMs: 5,
  });

  assert.deepEqual(await policy.flush({ session, messages: [], sourceCursor: 1 }), []);
  assert.match(session.state.events.find((event) => event.type === "memory.flush_degraded").error, /timeout|timed out/i);
});

async function createFixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-memory-flush-"));
  const scope = createMemoryScope({ workspace, agentId: "agent-test", userId: "user-test" });
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace, memoryScope: scope });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  return { workspace, scope, store };
}
