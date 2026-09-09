import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { retrieveContextMemories } from "../src/memory/context-retrieval.js";
import { AgentSession } from "../src/core/session.js";
import { AgentRuntime } from "../src/core/agent.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { ToolHost } from "../src/tools/host.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { buildSystemPrompt } from "../src/workspace.js";

test("实际Runtime按自然问题召回长期事实，保持固定约束、来源与跨scope隔离", async (t) => {
  const { store, scope, session, host } = await fixture(t);
  const relevant = await store.memory.add({ content: "项目使用 TypeScript，测试使用 Vitest" }, { scope, provenance: { origin: "user_explicit" } });
  const pinned = await store.memory.add({ content: "修改之后不要自动启动服务。", pinned: true }, { scope, provenance: { origin: "user_explicit" } });
  await store.memory.add({ content: "项目使用 private-other-language，测试使用 private-other-tool" }, { scope: { ...scope, agentId: "other" }, provenance: { origin: "user_explicit" } });
  const requests = [];
  const runtime = new AgentRuntime({ session, toolHost: host,
    systemPrompt: buildSystemPrompt({ root: scope.workspace, files: [], skills: [] }),
    retrieveMemory: (query, { signal }) => retrieveContextMemories(store.memory, query, { scope, signal }),
    provider: { complete: async (request) => { requests.push(request); return { text: "项目使用TypeScript与Vitest。", toolCalls: [] }; } },
  });
  await runtime.runTurn("我们项目使用什么语言和测试框架？");
  assert.equal(runtime.state.phase, "completed", runtime.state.lastError);
  assert.match(requests[0].systemPrompt, /TypeScript|Vitest/);
  assert.match(requests[0].systemPrompt, /不要自动启动服务/);
  assert.doesNotMatch(requests[0].systemPrompt, /private-other/);
  assert.deepEqual(runtime.state.contextMemory.map((item) => item.id), [pinned.id, relevant.id]);
  const plan = runtime.state.events.find((event) => event.type === "model.context_prepared");
  assert.equal(plan.pinnedMemoryHits[0].id, pinned.id);
  assert.equal(plan.memoryHits[0].id, relevant.id);
  assert.deepEqual(store.load(session.id).contextMemory, runtime.state.contextMemory);
});

test("长任务自动查询按Adapter上限取首尾，保留固定记忆并标记查询裁剪", async (t) => {
  const { store, scope } = await fixture(t);
  const pinned = await store.memory.add({ content: "不得自动启动服务", pinned: true }, { scope, provenance: { origin: "user_explicit" } });
  const related = await store.memory.add({ content: "alpha then beta", tags: ["retrieval"] }, { scope, provenance: { origin: "user_explicit" } });
  const query = "前文" + "无".repeat(10000) + " alpha beta";
  await assert.rejects(store.memory.search(query, { scope }), /4096/);
  const records = await retrieveContextMemories(store.memory, query, { scope });
  assert.equal(records[0].id, pinned.id);
  assert.ok(records.some((item) => item.id === related.id && item.contextQueryTruncated === true));
  assert.ok(records.filter((item) => !item.pinned).every((item) => item.retrievalQuery.length <= 4096));
});

test("自动查询裁剪不切断Unicode码点，没有声明边界的外部Adapter保持原query", async () => {
  const query = "𠀀".repeat(100) + "tail";
  for (const maxSearchQueryChars of [64, undefined]) {
    let observed;
    await retrieveContextMemories({ capabilities: { maxSearchQueryChars }, search: async (value, _, { pinned }) => {
      if (!pinned) observed = value;
      return [];
    } }, query, { scope: { workspace: "/tmp", agentId: "default", userId: "local" } });
    if (maxSearchQueryChars) {
      assert.ok(observed.length <= maxSearchQueryChars);
      assert.equal(observed.isWellFormed(), true);
      assert.match(observed, /tail$/);
    } else assert.equal(observed, query);
  }
});

test("Memory工具schema公布实际Adapter长度边界，失败后可用具体关键词重查", async (t) => {
  const { host, session, store, scope } = await fixture(t);
  await store.memory.add({ content: "备份采用增量方式，每周五保留一份完整副本。" }, { scope, provenance: { origin: "user_explicit" } });
  const schema = host.schemas({ session }).find((item) => item.function.name === "memory_search");
  assert.equal(schema.function.parameters.properties.query.maxLength, 4096);
  const invalid = await host.execute({ id: "long", name: "memory_search", arguments: { query: "x".repeat(4097) } }, { session });
  assert.equal(invalid.status, "validation_failed");
  const result = await host.execute({ id: "short", name: "memory_search", arguments: { query: "备份" } }, { session });
  assert.equal(result.ok, true);
  assert.match(result.result, /增量/);
});

test("查询在分词前完整脱敏，词项和durable上下文不留下拆散后的凭据", async (t) => {
  const { store, scope, session } = await fixture(t);
  await store.memory.add({ content: "alpha then beta" }, { scope, provenance: { origin: "user_explicit" } });
  const direct = await store.memory.search("alpha beta API_KEY=synthetic_private_marker", { scope });
  assert.equal(direct.length, 1);
  assert.doesNotMatch(JSON.stringify(direct), /synthetic|private_marker|"private"|"marker"/);
  const records = await retrieveContextMemories(store.memory, "alpha beta API_KEY=synthetic_private_marker", { scope });
  assert.equal(records.length, 1);
  await session.dispatch({ type: "MEMORY_CONTEXT_SET", query: "alpha beta API_KEY=synthetic_private_marker", memories: records });
  const persisted = JSON.stringify(store.load(session.id));
  assert.doesNotMatch(JSON.stringify(records), /synthetic|private_marker|"private"|"marker"/);
  assert.doesNotMatch(persisted, /synthetic|private_marker|"private"|"marker"/);
});

test("长query裁剪前先完整脱敏，后半页不能绕过已被裁掉的凭据前缀", async (t) => {
  const { store, scope } = await fixture(t);
  await store.memory.add({ content: "alpha then beta", pinned: true }, { scope, provenance: { origin: "user_explicit" } });
  await store.memory.add({ content: "alpha then beta related" }, { scope, provenance: { origin: "user_explicit" } });
  const query = "alpha beta API_KEY=" + "synthetic_private_marker".repeat(500) + "\nalpha beta";
  const records = await retrieveContextMemories(store.memory, query, { scope });
  assert.equal(records.length, 2);
  assert.doesNotMatch(JSON.stringify(records), /synthetic|private_marker|"private"|"marker"/);
  await assert.rejects(store.memory.search(query, { scope }), /4096/);
});

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-memory-keyword-runtime-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const scope = store.memoryScope;
  const session = new AgentSession({ state: createSession({ provider: "offline", workspace, memoryScope: scope }), reducer: reduceSession, journal: store });
  const host = new ToolHost({ registry: createToolRegistry({ workspace, memory: store.memory }) });
  t.after(async () => { await session.drain(); session.close(); store.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  return { workspace, store, scope, session, host };
}
