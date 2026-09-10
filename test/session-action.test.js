import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { AgentRuntime } from "../src/core/agent.js";
import { dispatchSessionAction } from "../src/core/session-action.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { ToolHost } from "../src/tools/host.js";
import { runToolBatch } from "../src/tools/batch.js";

const at = "2026-09-09T05:00:00.000Z";
const stateGetter = Object.getOwnPropertyDescriptor(AgentSession.prototype, "state").get;
const initial = (workspace = "/tmp") => createSession({ id: "session-action", provider: "offline", workspace, createdAt: at });
const request = (id) => ({ type: "TOOL_REQUESTED", call: { id, name: "read_file", arguments: { path: `${id}.txt` } }, effects: ["read"], at });
const memory = (content) => ({ type: "MEMORY_ADDED", content, at });
const session = () => new AgentSession({ state: initial(), reducer: reduceSession });

function traceFullReads(target) {
  let reads = 0;
  Object.defineProperty(target, "state", { configurable: true, get() { reads++; return stateGetter.call(this); } });
  return () => reads;
}

test("内部提交不请求完整状态回执，公开 dispatch/receipt 和订阅仍为独立快照", async () => {
  const target = session();
  const fullReads = traceFullReads(target);
  let observed;
  target.subscribe((state) => { observed = state; state.metrics.toolCalls = -1; });
  assert.equal(await dispatchSessionAction(target, request("a")), undefined);
  assert.equal(fullReads(), 0);
  assert.equal(target.readState(["metrics"]).metrics.toolCalls, 1);
  assert.equal(observed.events.at(-1).callId, "a");
  const returned = await target.dispatch(request("b"));
  assert.equal(returned.metrics.toolCalls, 2);
  assert.equal(fullReads(), 1);
  const receipt = await target.dispatchWithReceipt(request("c"));
  assert.equal(receipt.cursor, 3);
  assert.equal(receipt.state.metrics.toolCalls, 3);
  assert.equal(fullReads(), 2);
  returned.messages.length = 0;
  receipt.state.events.length = 0;
  observed.metrics.toolCalls = 100;
  assert.equal(target.readState(["metrics"]).metrics.toolCalls, 3);
  assert.equal(target.readState(["events"]).events.length, 3);
});

test("内部与原 dispatch 保持并发队列、observer追加及 await 后游标顺序", async () => {
  async function run(commit) {
    const target = session();
    const events = [];
    const continuations = [];
    let added;
    target.subscribeEvents((event) => {
      events.push([event.cursor, event.type, event.action.call?.id]);
      if (event.action.call?.id === "a") added = target.dispatch(memory("observer"));
      event.patch = {};
    });
    await Promise.all(["a", "b", "c"].map((id) => commit(target, request(id)).then(() => {
      continuations.push([id, target.cursor]);
    })));
    await target.drain();
    await added;
    return { events, continuations, state: target.state, cursor: target.cursor };
  }
  const original = await run((target, action) => target.dispatch(action));
  const current = await run(dispatchSessionAction);
  assert.deepEqual(current, original);
  assert.deepEqual(current.events.map((event) => event[0]), [1, 2, 3, 4]);
});

test("SQLite checkpoint失败时内部确认不推进投影或通知，原动作可正常重试", async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-session-action-"));
  const store = new SessionStore(path.join(workspace, "state.db"), { workspace, checkpointInterval: 2 });
  const target = new AgentSession({ state: initial(workspace), reducer: reduceSession, journal: store });
  t.after(() => { target.close(); store.close(); rmSync(workspace, { recursive: true, force: true }); });
  const before = target.state;
  const modelBefore = target.prepareModelRequest({ systemPrompt: "固定", tools: [] });
  let notifications = 0;
  target.subscribeEvents(() => { notifications++; }, { after: target.cursor });
  target.subscribe(() => { notifications++; });
  store.db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON session_checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END");
  await assert.rejects(dispatchSessionAction(target, memory("未提交")), /checkpoint unavailable/);
  assert.equal(target.cursor, 1);
  assert.equal(notifications, 0);
  assert.deepEqual(target.state, before);
  assert.deepEqual(store.load(target.id), before);
  assert.deepEqual(target.prepareModelRequest({ systemPrompt: "固定", tools: [] }), modelBefore);
  store.db.exec("DROP TRIGGER fail_checkpoint");
  await dispatchSessionAction(target, memory("已提交"));
  assert.equal(target.cursor, 2);
  assert.equal(notifications, 2);
  assert.deepEqual(store.load(target.id), target.state);
  assert.deepEqual(JSON.parse(store.db.prepare("SELECT state_json FROM sessions WHERE id = ?").get(target.id).state_json), target.state);
});

test("内部确认保留动作失败后的队列恢复以及 close 后排队任务拒绝", async () => {
  const target = session();
  await assert.rejects(dispatchSessionAction(target, { type: "MODEL_STREAM_DELTA", delta: "无活动流", at }), /没有可写入/);
  await dispatchSessionAction(target, request("after-failure"));
  assert.equal(target.cursor, 1);
  const queued = dispatchSessionAction(target, request("queued"));
  target.close();
  await assert.rejects(queued, /已删除或关闭/);
  await assert.rejects(dispatchSessionAction(target, request("closed")), /已删除或关闭/);
  await target.drain();
  assert.equal(target.cursor, 1);
});

test("旧适配器只调用一次原dispatch，保持this、原Promise及原返回值", async () => {
  const deferred = Promise.withResolvers();
  const action = memory("legacy");
  let lookups = 0;
  let calls = 0;
  const legacy = {
    get dispatch() {
      lookups++;
      return function (received) {
        assert.equal(this, legacy);
        assert.equal(received, action);
        calls++;
        return deferred.promise;
      };
    },
    get dispatchWithReceipt() { assert.fail("不能试探旧适配器的 receipt"); },
  };
  const operation = dispatchSessionAction(legacy, action);
  assert.equal(operation, deferred.promise);
  const result = { marker: "legacy-return" };
  deferred.resolve(result);
  assert.equal(await operation, result);
  assert.equal(lookups, 1);
  assert.equal(calls, 1);
});

test("被覆盖的 Session dispatch 钩子仍能等待或拒绝，不能被receipt绕过", async () => {
  const target = session();
  const original = target.dispatch;
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  let calls = 0;
  target.dispatch = async function (action) {
    assert.equal(this, target);
    calls++;
    if (action.content === "reject") throw new Error("hook rejection");
    const state = await original.call(this, action);
    entered.resolve();
    await released.promise;
    return state;
  };
  let finished = false;
  const pending = dispatchSessionAction(target, memory("wait")).then((value) => { finished = true; return value; });
  await entered.promise;
  assert.equal(finished, false);
  assert.equal(target.cursor, 1);
  released.resolve();
  assert.equal((await pending).memory[0].content, "wait");
  await assert.rejects(dispatchSessionAction(target, memory("reject")), /hook rejection/);
  assert.equal(calls, 2);
  assert.equal(target.cursor, 1);
});

for (const accessor of [false, true]) {
  test(`被覆盖的 receipt ${accessor ? "getter" : "方法"}继续只通过原dispatch调用`, async () => {
    const target = session();
    const original = target.dispatchWithReceipt;
    let calls = 0;
    let lookups = 0;
    const hook = function (action, options) {
      assert.equal(this, target);
      assert.equal(options, undefined, "原 dispatch 不传内部选项");
      calls++;
      return original.call(this, action);
    };
    if (accessor) Object.defineProperty(target, "dispatchWithReceipt", { get() { lookups++; return hook; } });
    else target.dispatchWithReceipt = hook;
    const value = await dispatchSessionAction(target, request("hook"));
    assert.equal(value.metrics.toolCalls, 1);
    assert.equal(calls, 1);
    assert.equal(lookups, accessor ? 1 : 0);
  });
}

test("Proxy适配器保持原dispatch路径且不新增原型或receipt探测", async () => {
  const target = session();
  const bound = target.dispatch.bind(target);
  let calls = 0;
  const proxy = new Proxy(target, {
    get(object, key) {
      if (key === "dispatch") { calls++; return bound; }
      if (key === "dispatchWithReceipt") assert.fail("不能读取 Proxy receipt");
      return Reflect.get(object, key, object);
    },
    getPrototypeOf() { assert.fail("不能探测 Proxy 原型"); },
  });
  assert.equal((await dispatchSessionAction(proxy, memory("proxy"))).memory[0].content, "proxy");
  assert.equal(calls, 1);
});

function runtime(target) {
  return new AgentRuntime({
    session: target, systemPrompt: "完成合成任务", toolHost: { schemas: () => [], execute: async () => {} },
    provider: {
      name: "offline", complete: async () => assert.fail("应调用stream"),
      async *stream() {
        yield { type: "text_delta", delta: "第一段。" };
        yield { type: "text_delta", delta: "第二段。" };
        yield { type: "completed", response: { text: "已完成。", toolCalls: [], finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } };
      },
    },
  });
}

test("真实Runtime模型流与ContextLifecycle内部提交只在最终公开返回请求完整状态", async () => {
  const target = session();
  const fullReads = traceFullReads(target);
  const agent = runtime(target);
  const completed = await agent.runTurn("完成合成任务");
  assert.equal(completed.phase, "completed");
  assert.equal(completed.metrics.totalTokens, 5);
  assert.equal(completed.events.filter((event) => event.type === "model.stream_delta").length, 2);
  assert.equal(fullReads(), 1);
  const publicState = await agent.dispatch(memory("公开接口"));
  assert.equal(fullReads(), 2);
  assert.equal(publicState.memory.at(-1).content, "公开接口");
  completed.messages.length = 0;
  publicState.memory.length = 0;
  assert.ok(target.readState(["messages"]).messages.length > 0);
  assert.equal(target.readState(["memory"]).memory.length, 1);
});

test("Runtime自定义dispatch继续拦截本轮动作和模型流", async () => {
  const target = session();
  const agent = runtime(target);
  const original = agent.dispatch;
  const types = [];
  agent.dispatch = function (action) { assert.equal(this, agent); types.push(action.type); return original.call(this, action); };
  const completed = await agent.runTurn("通过钩子完成");
  assert.equal(completed.phase, "completed");
  assert.deepEqual(types, ["USER_MESSAGE", "MODEL_STREAM_STARTED", "MODEL_STREAM_DELTA", "MODEL_STREAM_DELTA",
    "MODEL_STREAM_COMPLETED", "ASSISTANT_MESSAGE", "COMPLETED"]);
});

test("工具扩展dispatch和onOutput仍返回完整独立状态，内部结果保留来源cursor", async () => {
  const target = session();
  const events = [];
  target.subscribeEvents((event) => events.push(event));
  const tool = {
    name: "state_extension", description: "验证工具回调", adapter: "test", approval: "never",
    effects: ["read"], idempotency: "safe", parameters: { type: "object", properties: {}, additionalProperties: false },
    capability: { risk: "R0", readOnly: true, resources: [{ kind: "session", access: "read" }] },
    async execute(args, context) {
      const state = await context.dispatch(memory("工具扩展"));
      assert.ok(Array.isArray(state.messages) && Array.isArray(state.events));
      const outputState = await context.onOutput({ channel: "stdout", chunk: "完整一行\n" });
      assert.equal(outputState.toolStreams[context.callId].preview, "完整一行\n");
      assert.ok(outputState.agentProfile);
      state.memory.length = 0;
      outputState.toolStreams[context.callId].preview = "不能写回";
      return "ok";
    },
  };
  const host = new ToolHost({ registry: { get: (name) => name === tool.name ? tool : null, schemas: () => [] } });
  const result = await host.execute({ id: "extension", name: tool.name, arguments: {} }, { session: target });
  assert.equal(result.ok, true);
  assert.equal(target.readState(["memory"]).memory[0].content, "工具扩展");
  const requested = events.find((event) => event.type === "TOOL_REQUESTED");
  assert.equal(events.find((event) => event.type === "TOOL_RESULT").action.sourceCursor, requested.cursor);
});

test("并行批次结果的确认不索取状态副本，仍按原调用顺序记录", async () => {
  const target = session();
  const fullReads = traceFullReads(target);
  const calls = ["a", "b", "c"].map((id) => request(id).call);
  const results = await runToolBatch(calls, { session: target }, {
    prepareRead: (call) => ({ run: async () => ({ result: call.id, action: {
      type: "TOOL_RESULT", call, ok: true, status: "completed", result: call.id, durationMs: 0, at,
    } }) }),
    executeSerial: () => assert.fail("应走并行计划"),
  });
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.equal(fullReads(), 0);
  assert.deepEqual(target.readState(["messages"]).messages.map((message) => message.tool_call_id), results);
});
