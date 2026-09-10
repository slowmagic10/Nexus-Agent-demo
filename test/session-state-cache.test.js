import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { applyStatePatch } from "../src/state-patch.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { cacheActionTime, countStateClones, createStateCacheFixture } from "./support/session-state-cache-fixture.js";

function fixture(t, options) {
  const value = createStateCacheFixture(options);
  t.after(() => value.close());
  return value;
}
function commit(session, index, extra = {}) {
  return session.dispatchWithReceipt({ type: "MODEL_REQUESTED", at: cacheActionTime(index), ...extra }, { includeState: false });
}

test("Gateway 没有完整状态读取时每次提交只保留 reducer 的全状态克隆", async (t) => {
  const current = fixture(t);
  const baseline = fixture(t, { eager: true });
  const events = [];
  current.session.subscribeEvents((event) => events.push(event), { after: current.session.cursor });
  const run = async (target) => { for (let index = 1; index <= 8; index++) await commit(target.session, index); };
  const oldCost = await countStateClones(() => run(baseline));
  const newCost = await countStateClones(() => run(current));
  assert.equal(oldCost.metrics.fullStateClones, 16);
  assert.equal(newCost.metrics.fullStateClones, 8);
  assert.equal(events.length, 8);
  let projected = current.seed;
  for (const event of events) projected = applyStatePatch(projected, event.patch);
  const firstRead = await countStateClones(() => current.entry.state);
  assert.equal(firstRead.metrics.fullStateClones, 1);
  assert.deepEqual(firstRead.result, baseline.entry.state);
  assert.deepEqual(firstRead.result, projected);
  assert.deepEqual(current.store.load(current.session.id), firstRead.result);
  const repeat = await countStateClones(() => current.entry.state);
  assert.equal(repeat.metrics.fullStateClones, 0);
  assert.strictEqual(repeat.result, firstRead.result);
});

test("Gateway 缓存保留当前引用并在下一次提交隔离旧视图和客户端修改", async (t) => {
  const { entry, session } = fixture(t);
  await commit(session, 1);
  const old = entry.state;
  const original = structuredClone(old);
  old.messages[0].content = "客户端修改";
  old.messages[1].tool_calls[0].function.arguments = "客户端参数";
  old.metrics.modelCalls = -1;
  old.extra = { nested: [1] };
  assert.strictEqual(entry.state, old);
  assert.deepEqual(session.state, original);
  await commit(session, 2);
  assert.notStrictEqual(entry.state, old);
  assert.equal(old.metrics.modelCalls, -1);
  assert.equal(entry.state.metrics.modelCalls, 2);
  assert.equal(entry.state.messages[0].content, original.messages[0].content);
  assert.equal(entry.state.extra, undefined);
});

test("Gateway 事件回调仍读取上一次状态通知的版本，未读取版本也保持顺序", async (t) => {
  const { entry, session } = fixture(t);
  const eventReads = [];
  const stateReads = [];
  session.subscribeEvents(() => eventReads.push(entry.state.metrics.modelCalls), { after: session.cursor });
  session.subscribe(() => stateReads.push(entry.state.metrics.modelCalls));
  await commit(session, 1);
  await commit(session, 2);
  await commit(session, 3);
  assert.deepEqual(eventReads, [0, 1, 2]);
  assert.deepEqual(stateReads, [1, 2, 3]);
});

test("Gateway 迟到读取仍绑定未曾生成快照的前一提交", async (t) => {
  const { entry, session } = fixture(t);
  await commit(session, 1);
  let duringEvent;
  session.subscribeEvents(() => { duringEvent = entry.state; }, { after: session.cursor });
  await commit(session, 2);
  assert.equal(duringEvent.metrics.modelCalls, 1);
  assert.equal(entry.state.metrics.modelCalls, 2);
});

test("Gateway 完整订阅保留每次提交、共享快照、失败隔离和退订后的按需路径", async (t) => {
  const { entry, session } = fixture(t);
  const seen = [];
  const first = (state) => { state.client = true; seen.push(state); };
  const second = (state) => { assert.equal(state.client, true); seen.push(state); };
  entry.subscribers.add(first);
  entry.subscribers.add(second);
  const eager = await countStateClones(() => commit(session, 1));
  assert.equal(eager.metrics.fullStateClones, 2);
  assert.equal(seen.length, 2);
  assert.strictEqual(seen[0], seen[1]);
  assert.strictEqual(entry.state, seen[0]);
  assert.equal(session.state.client, undefined);
  entry.subscribers.clear();
  entry.subscribers.add(() => { throw new Error("客户端断开"); });
  await commit(session, 2);
  assert.equal(entry.state.metrics.modelCalls, 2);
  entry.subscribers.clear();
  const deferred = await countStateClones(() => commit(session, 3));
  assert.equal(deferred.metrics.fullStateClones, 1);
  assert.equal(entry.state.metrics.modelCalls, 3);
});

test("Gateway update 扩展每次收到独立完整状态，动态安装和移除仍有效", async (t) => {
  const { entry, session, manager } = fixture(t);
  const nativeUpdate = manager.update;
  await commit(session, 1);
  const previous = entry.state;
  const observations = [];
  manager.update = function (target, state) {
    assert.strictEqual(this, manager);
    assert.strictEqual(target.state, previous);
    observations.push(state);
    nativeUpdate.call(this, target, state);
  };
  const hooked = await countStateClones(() => commit(session, 2));
  assert.equal(hooked.metrics.fullStateClones, 2);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].messages.length, 16);
  assert.strictEqual(entry.state, observations[0]);
  manager.update = nativeUpdate;
  const restored = await countStateClones(() => commit(session, 3));
  assert.equal(restored.metrics.fullStateClones, 1);
});

test("Gateway update getter 每次通知只求值一次，抛错仍保留旧缓存", async (t) => {
  const { entry, session, manager } = fixture(t);
  await commit(session, 1);
  const previous = entry.state;
  let lookups = 0;
  Object.defineProperty(manager, "update", { get() { lookups++; throw new Error("扩展失败"); } });
  await commit(session, 2);
  assert.equal(lookups, 1);
  assert.strictEqual(entry.state, previous);
  assert.equal(session.state.metrics.modelCalls, 2);
});

test("Gateway 自定义 subscribe getter 只调用一次，保持原订阅接口", async (t) => {
  let lookups = 0;
  let callbacks = 0;
  const value = fixture(t, { beforeAttach({ session }) {
    const native = session.subscribe;
    Object.defineProperty(session, "subscribe", { get() {
      lookups++;
      return function (listener) { return native.call(this, (state) => { callbacks++; listener(state); }); };
    } });
  } });
  assert.equal(lookups, 1);
  const cost = await countStateClones(() => commit(value.session, 1));
  assert.equal(cost.metrics.fullStateClones, 2);
  assert.equal(callbacks, 1);
  assert.equal(value.entry.state.metrics.modelCalls, 1);
  assert.equal(Object.getOwnPropertyDescriptor(value.entry, "state").get, undefined);
});

test("Gateway 自定义 Journal 保留原完整快照，不连接外部持有的 committed state", async (t) => {
  let retained;
  const { entry, session } = fixture(t, { beforeAttach({ store }) {
    const native = store.commitSessionEvent;
    store.commitSessionEvent = function (state, ...rest) { retained = state; return native.call(this, state, ...rest); };
  } });
  const cost = await countStateClones(() => commit(session, 1));
  assert.equal(cost.metrics.fullStateClones, 2);
  const expected = structuredClone(entry.state);
  retained.messages[0].content = "外部写入";
  assert.deepEqual(entry.state, expected);
});

test("Gateway 运行中替换 Journal 后即使在提交内恢复原方法也立即固化当前快照", async (t) => {
  const { entry, session, store } = fixture(t);
  let retained;
  const native = store.commitSessionEvent;
  store.commitSessionEvent = function (state, ...rest) {
    retained = state;
    store.commitSessionEvent = native;
    return native.call(this, state, ...rest);
  };
  const cost = await countStateClones(() => commit(session, 1));
  assert.equal(cost.metrics.fullStateClones, 2);
  retained.messages[0].content = "稍后修改外部状态";
  assert.equal(entry.state.messages[0].content, "合成请求 0");
});

test("Gateway Journal 失败不推进未读取缓存，恢复后仍与 durable cursor 一致", async (t) => {
  const { entry, session, store } = fixture(t);
  await commit(session, 1);
  const cursor = session.cursor;
  const native = store.commitSessionEvent;
  store.commitSessionEvent = () => { throw new Error("合成提交失败"); };
  await assert.rejects(commit(session, 2), /合成提交失败/);
  assert.equal(session.cursor, cursor);
  assert.equal(entry.state.metrics.modelCalls, 1);
  store.commitSessionEvent = native;
  await commit(session, 3);
  assert.equal(session.cursor, cursor + 1);
  assert.deepEqual(entry.state, store.load(session.id));
});

test("Gateway 队列提交与异步读取不串版本，失败后的队列仍可推进", async (t) => {
  const { entry, session } = fixture(t);
  const states = [];
  session.subscribe(async () => { await Promise.resolve(); states.push(entry.state.metrics.modelCalls); });
  const receipts = await Promise.all([commit(session, 1), commit(session, 2), commit(session, 3)]);
  assert.deepEqual(receipts.map((receipt) => receipt.cursor), [2, 3, 4]);
  assert.deepEqual(states, [1, 2, 3]);
  assert.equal(entry.state.metrics.modelCalls, 3);
  const pending = await Promise.allSettled([commit(session, 4, { type: "INVALID" }), commit(session, 5)]);
  assert.equal(pending[0].status, "rejected");
  assert.equal(pending[1].status, "fulfilled");
  assert.equal(entry.state.metrics.modelCalls, 4);
});

test("State reader 默认即时固化自定义 reducer 状态，延后读取和重复读取保持隔离", async () => {
  const state = createSession({ id: "custom-reader", provider: "offline", workspace: "/tmp" });
  const session = new AgentSession({ state, reducer(previous, action) { previous.marker = action.marker; return previous; } });
  const reads = [];
  session.subscribeStateReader((read) => reads.push(read));
  await session.dispatchWithReceipt({ type: "CUSTOM", marker: 1 }, { includeState: false });
  await session.dispatchWithReceipt({ type: "CUSTOM", marker: 2 }, { includeState: false });
  assert.equal(reads[0]().marker, 1);
  assert.equal(reads[1]().marker, 2);
  reads[0]().messages.push({ role: "user", content: "仅修改读者快照" });
  assert.strictEqual(reads[0](), reads[0]());
  assert.equal(session.state.messages.length, 0);
  session.close();
});

test("State reader 与旧订阅保持通知次序、异常隔离及关闭行为", async (t) => {
  const { session } = fixture(t);
  assert.throws(() => session.subscribeStateReader(null), /函数/);
  const order = [];
  session.subscribeEvents(() => order.push("event"), { after: session.cursor });
  session.subscribe(() => order.push("state-before"));
  const stop = session.subscribeStateReader((read) => { order.push(`reader-${read().metrics.modelCalls}`); });
  session.subscribeStateReader(async () => { throw new Error("异步读者失败"); });
  session.subscribe(() => order.push("state-after"));
  await commit(session, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["event", "state-before", "reader-1", "state-after"]);
  stop();
  order.length = 0;
  await commit(session, 2);
  assert.deepEqual(order, ["event", "state-before", "state-after"]);
  session.close();
  await assert.rejects(commit(session, 3), /关闭/);
});

test("State reader 显式许可不匹配实际 reducer 时仍即时固化", async (t) => {
  const { store, seed } = fixture(t);
  const session = new AgentSession({ state: { ...seed, id: "other-reducer" }, journal: store,
    reducer(previous, action) { previous.marker = action.marker; return previous; } });
  t.after(() => session.close());
  let read;
  session.subscribeStateReader((next) => { read = next; }, {
    immutableReducer: reduceSession, immutableJournalCommit: SessionStore.prototype.commitSessionEvent,
  });
  await session.dispatchWithReceipt({ type: "CUSTOM", marker: 1 }, { includeState: false });
  const first = read;
  await session.dispatchWithReceipt({ type: "CUSTOM", marker: 2 }, { includeState: false });
  assert.equal(first().marker, 1);
  assert.equal(read().marker, 2);
});

test("Gateway 真正 API 的首次订阅、view、刷新恢复和删除仍闭合", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nexus-state-cache-api-"));
  const store = new SessionStore(path.join(directory, "session.db"), { workspace: directory });
  const options = { workspace: directory, store, provider: { name: "offline", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null }, systemPrompt: "test" };
  const manager = new GatewaySessionManager(options);
  let restored;
  t.after(async () => { await manager.close(); await restored?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = await manager.create();
  const entry = manager.sessions.get(initial.id);
  await commit(entry.session, 1);
  const snapshots = [];
  const stop = await manager.subscribe(initial.id, (state) => snapshots.push(state));
  assert.equal(snapshots[0].metrics.modelCalls, 1);
  await commit(entry.session, 2);
  assert.equal(snapshots[1].metrics.modelCalls, 2);
  stop();
  await commit(entry.session, 3);
  assert.equal(snapshots.length, 2);
  const view = await manager.view(initial.id);
  assert.equal(view.cursor, entry.session.cursor);
  assert.deepEqual(view.state, store.load(initial.id));
  const oldView = structuredClone(view.state);
  await manager.close();
  restored = new GatewaySessionManager(options);
  const loaded = await restored.view(initial.id);
  assert.ok(loaded.cursor > view.cursor);
  assert.deepEqual(view.state, oldView);
  assert.equal(loaded.state.metrics.modelCalls, 3);
  const deletedEvents = [];
  await restored.subscribeEvents(initial.id, (event) => deletedEvents.push(event), { after: loaded.cursor });
  await restored.deleteSession(initial.id);
  assert.equal(deletedEvents.at(-1).type, "SESSION_DELETED");
  await assert.rejects(restored.get(initial.id), (error) => error.status === 404);
});

test("Gateway 真实 Runtime 的模型增量经 patch 重建与完整状态相等", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nexus-state-cache-runtime-"));
  const store = new SessionStore(path.join(directory, "session.db"), { workspace: directory });
  const manager = new GatewaySessionManager({ workspace: directory, store,
    provider: { name: "offline", complete: async () => { throw new Error("应走流式接口"); },
      async *stream() {
        for (const delta of ["正在处理。\n", "已完成。\n"]) yield { type: "text_delta", delta };
        yield { type: "completed", response: { text: "正在处理。\n已完成。\n", finishReason: "stop", toolCalls: [],
          usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 } } };
      } },
    tools: { schemas: () => [], get: () => null }, systemPrompt: "test" });
  t.after(async () => { await manager.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = await manager.create();
  const baseline = await manager.view(initial.id);
  let projected = baseline.state;
  const cursors = [];
  await manager.subscribeEvents(initial.id, (event) => {
    projected = applyStatePatch(projected, event.patch);
    cursors.push(event.cursor);
  }, { after: baseline.cursor });
  await manager.sendMessage(initial.id, "只回复已完成");
  const entry = manager.sessions.get(initial.id);
  await entry.run;
  const result = await manager.view(initial.id);
  assert.deepEqual(result.state, projected);
  assert.equal(result.cursor, cursors.at(-1));
  assert.equal(result.state.phase, "completed");
  assert.equal(result.state.messages.at(-1).content, "正在处理。\n已完成。\n");
  assert.ok(result.state.events.some((event) => event.type === "model.stream_delta"));
  assert.ok(result.state.events.some((event) => event.type === "model.stream_completed"));
  assert.deepEqual(store.load(initial.id), result.state);
});
