import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { readSessionState, selectSessionStateFields } from "../src/core/session-state-view.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { ToolHost } from "../src/tools/host.js";

const at = "2026-09-09T04:00:00.000Z";
const initial = (workspace = "/tmp") => createSession({ provider: "demo", workspace, createdAt: at });
const request = (id) => ({ type: "TOOL_REQUESTED", call: {
  id, name: "read_file", arguments: { path: `${id}.txt` },
}, effects: ["read"], at });
const sessionWith = (state = initial(), extra = {}) => new AgentSession({ state, reducer: reduceSession, ...extra });

function assertOwnUndefined(value, key) {
  assert.equal(Object.hasOwn(value, key), true);
  assert.equal(value[key], undefined);
}

test("readState 同步返回所选顶层字段，调用方字段列表保持不变", () => {
  const session = sessionWith();
  const fields = Object.freeze(["metrics", "id", "phase"]);
  const view = session.readState(fields);
  assert.equal(view instanceof Promise, false);
  assert.deepEqual(Object.keys(view), fields);
  assert.equal(view.id, session.id);
  assert.equal(view.phase, "idle");
  assert.deepEqual(view.metrics, session.state.metrics);
  assert.deepEqual(fields, ["metrics", "id", "phase"]);
});

test("readState 嵌套对象和数组脱离内部状态且不同读取相互独立", () => {
  const state = initial();
  state.messages.push({ role: "user", content: "原始内容", extra: { enabled: true } });
  const session = sessionWith(state);
  const first = session.readState(["metrics", "messages"]);
  const second = session.readState(["metrics", "messages"]);
  first.metrics.toolCalls = 900;
  first.messages[0].content = "篡改";
  first.messages[0].extra.enabled = false;
  first.messages.push({ role: "assistant", content: "注入" });
  assert.deepEqual(second, { metrics: state.metrics, messages: state.messages });
  assert.deepEqual(session.readState(["metrics", "messages"]), second);
});

test("readState 通过一次选择克隆保留字段之间的别名和循环", () => {
  const shared = { value: "共享", nested: [] };
  shared.self = shared;
  const state = initial();
  state.first = shared;
  state.second = shared;
  const session = sessionWith(state);
  const view = session.readState(["first", "second"]);
  assert.equal(view.first, view.second);
  assert.equal(view.first.self, view.first);
  assert.notEqual(view.first, shared);
  view.first.nested.push("外部写入");
  assert.deepEqual(session.readState(["first"]).first.nested, []);
});

test("readState 不依赖完整 state getter，也不读取未选字段", () => {
  const session = sessionWith();
  Object.defineProperty(session, "state", { get() { throw new Error("完整状态不应读取"); } });
  assert.deepEqual(session.readState(["id", "phase"]), { id: session.id, phase: "idle" });
  const state = { selected: { value: 1 } };
  Object.defineProperty(state, "unselected", { enumerable: true, get() { throw new Error("未选字段不应读取"); } });
  assert.deepEqual(selectSessionStateFields(state, ["selected"]), { selected: { value: 1 } });
});

test("readState 空列表合法，重复字段去重并保留第一次出现的顺序", () => {
  const session = sessionWith();
  assert.deepEqual(session.readState([]), {});
  assert.deepEqual(Object.keys(session.readState(["phase", "id", "phase", "metrics", "id"])), ["phase", "id", "metrics"]);
  const state = {};
  let reads = 0;
  Object.defineProperty(state, "selected", { enumerable: true, get() { reads += 1; return { count: reads }; } });
  assert.deepEqual(selectSessionStateFields(state, ["selected", "selected"]), { selected: { count: 1 } });
  assert.equal(reads, 1);
});

test("字段仅表示顶层自有键，未知和继承字段保留 undefined", () => {
  const inherited = { inherited: { value: "不应暴露" } };
  Object.defineProperty(inherited, "inheritedGetter", { get() { throw new Error("继承 getter 不应读取"); } });
  const state = Object.assign(Object.create(inherited), { nested: { value: 1 }, "nested.value": 2 });
  const selected = selectSessionStateFields(state, ["nested.value", "nested.missing", "inherited", "inheritedGetter", "toString"]);
  assert.equal(selected["nested.value"], 2);
  for (const key of ["nested.missing", "inherited", "inheritedGetter", "toString"]) assertOwnUndefined(selected, key);
  const session = sessionWith();
  const view = session.readState(["metrics.toolCalls", "missing", "toString"]);
  for (const key of ["metrics.toolCalls", "missing", "toString"]) assertOwnUndefined(view, key);
});

test("特殊字段名 __proto__ 作为自有数据键保存且不改变输出原型", () => {
  const state = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"value":1},"prototype":2}');
  const selected = selectSessionStateFields(state, ["__proto__", "constructor", "prototype"]);
  assert.equal(Object.getPrototypeOf(selected), Object.prototype);
  assert.equal(Object.hasOwn(selected, "__proto__"), true);
  assert.deepEqual(selected.__proto__, { polluted: true });
  assert.deepEqual(selected.constructor, { value: 1 });
  assert.equal(selected.polluted, undefined);
  selected.__proto__.polluted = false;
  assert.equal(state.__proto__.polluted, true);
  const absent = selectSessionStateFields({}, ["__proto__"]);
  assertOwnUndefined(absent, "__proto__");
  assert.equal(Object.getPrototypeOf(absent), Object.prototype);
});

test("readState 拒绝非法字段列表，不执行 selector 回调", () => {
  const session = sessionWith();
  let invoked = false;
  const selector = () => { invoked = true; return "id"; };
  const invalidFields = [undefined, null, "id", {}, new Set(["id"]), selector,
    [""], [1], [null], [undefined], [Symbol("id")], ["x".repeat(129)],
    Array.from({ length: 65 }, () => "id"), new Array(1)];
  for (const fields of invalidFields) {
    assert.throws(() => session.readState(fields));
    assert.throws(() => selectSessionStateFields({ id: "test" }, fields));
  }
  assert.equal(invoked, false);
});

test("字段列表上限和字段名长度边界可用，不裁剪合法字段名", () => {
  const keys = Array.from({ length: 64 }, (_, index) => `field${index}`);
  const state = Object.fromEntries(keys.map((key, index) => [key, index]));
  assert.deepEqual(selectSessionStateFields(state, keys), state);
  const longest = "x".repeat(128);
  assert.deepEqual(selectSessionStateFields({ [longest]: 7, " ": 8 }, [longest, " "]), { [longest]: 7, " ": 8 });
});

test("完整 state getter 和 dispatch 的既有独立快照契约保持不变", async () => {
  const session = sessionWith();
  const first = session.state;
  first.metrics.toolCalls = 800;
  first.messages.push({ role: "user", content: "外部注入" });
  assert.equal(session.state.metrics.toolCalls, 0);
  assert.equal(session.state.messages.length, 0);
  const committed = await session.dispatch(request("legacy-return"));
  assert.ok(Object.keys(committed).length > 3);
  assert.equal(committed.metrics.toolCalls, 1);
  committed.metrics.toolCalls = -1;
  assert.equal(session.readState(["metrics"]).metrics.toolCalls, 1);
});

test("旧字段快照在提交成功和失败之后都保持原值，失败不发布观察通知", async () => {
  let fail = false;
  let cursor = 0;
  const session = sessionWith(initial(), { journal: {
    ensureJournal: (state) => structuredClone(state),
    commitSessionEvent(state, action, patch) {
      if (fail) throw new Error("模拟 Journal 失败");
      return { cursor: ++cursor, sessionId: state.id, type: action.type, at: action.at, action, patch };
    },
  } });
  const before = session.readState(["metrics", "events"]);
  const observed = [];
  session.subscribe(() => observed.push(session.readState(["metrics"]).metrics.toolCalls));
  await session.dispatch(request("success"));
  const afterSuccess = session.readState(["metrics", "events"]);
  fail = true;
  await assert.rejects(session.dispatch(request("failed")), /模拟 Journal 失败/);
  assert.equal(before.metrics.toolCalls, 0);
  assert.equal(before.events.some((event) => event.callId === "success"), false);
  assert.equal(afterSuccess.metrics.toolCalls, 1);
  assert.deepEqual(session.readState(["metrics", "events"]), afterSuccess);
  assert.deepEqual(observed, [1]);
  assert.equal(session.cursor, 1);
});

test("关闭会话后只读快照仍可取得且相互独立，新增提交仍拒绝", async () => {
  const session = sessionWith();
  await session.dispatch(request("before-close"));
  const before = session.readState(["id", "metrics"]);
  session.close();
  assert.deepEqual(session.readState(["id", "metrics"]), before);
  assert.equal(readSessionState(session, ["metrics"]).metrics.toolCalls, 1);
  await assert.rejects(session.dispatch(request("after-close")), /已删除或关闭/);
  before.metrics.toolCalls = 300;
  assert.equal(session.readState(["metrics"]).metrics.toolCalls, 1);
  assert.equal(session.state.metrics.toolCalls, 1);
});

test("readSessionState 优先调用新 API 并保留 this，不读取旧 state", () => {
  const fields = ["id", "metrics"];
  let calls = 0;
  const session = {
    id: "selected",
    readState(received) {
      calls += 1;
      assert.equal(this, session);
      assert.deepEqual(received, fields);
      received.push("adapter-only");
      return { id: this.id, metrics: { toolCalls: 5 } };
    },
    get state() { throw new Error("旧 getter 不应读取"); },
  };
  assert.deepEqual(readSessionState(session, fields), { id: "selected", metrics: { toolCalls: 5 } });
  assert.deepEqual(fields, ["id", "metrics"]);
  assert.equal(calls, 1);
});

test("readSessionState 新 API 抛错直接传播，不静默退回旧 state", () => {
  const failure = new Error("投影读取失败");
  let legacyReads = 0;
  const session = {
    readState() { throw failure; },
    get state() { legacyReads += 1; return { id: "legacy" }; },
  };
  assert.throws(() => readSessionState(session, ["id"]), (error) => error === failure);
  assert.equal(legacyReads, 0);
});

test("readSessionState 同步选择一次读取方法，动态 getter 不会换成另一处理器", () => {
  let lookups = 0;
  const session = {
    id: "method-snapshot",
    get readState() {
      lookups += 1;
      const selected = lookups;
      return function (fields) {
        assert.equal(this, session);
        assert.deepEqual(fields, ["id"]);
        return { id: `${this.id}:${selected}` };
      };
    },
  };
  assert.deepEqual(readSessionState(session, ["id"]), { id: "method-snapshot:1" });
  assert.equal(lookups, 1);
});

test("readSessionState 旧适配器完整 getter 只读一次，选择后仍为独立快照", () => {
  const shared = { nested: [1] };
  const original = { first: shared, second: shared, unselected: { ignored: true } };
  let reads = 0;
  const legacy = { get state() { reads += 1; return original; } };
  const view = readSessionState(legacy, ["first", "second", "missing"]);
  assert.equal(reads, 1);
  assert.equal(view.first, view.second);
  assert.notEqual(view.first, shared);
  assertOwnUndefined(view, "missing");
  assert.equal(Object.hasOwn(view, "unselected"), false);
  view.first.nested.push(2);
  assert.deepEqual(shared.nested, [1]);
});

test("readSessionState 对空会话和缺失 state 保持 undefined", () => {
  for (const session of [undefined, null, {}, { state: undefined }, { state: null }]) {
    assert.equal(readSessionState(session, ["id"]), undefined);
  }
  assert.deepEqual(readSessionState({ state: {} }, []), {});
});

test("SQLite 提交与恢复后的字段视图与完整状态一致，观察者看到当前 durable 游标", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-state-view-"));
  let store;
  let reopened;
  try {
    const dbPath = path.join(workspace, "state-view.db");
    store = new SessionStore(dbPath, { workspace, checkpointInterval: 2 });
    const state = initial(workspace);
    const session = sessionWith(state, { journal: store });
    const baselineCursor = session.cursor;
    const fields = ["id", "metrics", "messages", "events", "phase"];
    const before = session.readState(fields);
    const observed = [];
    session.subscribe((notification) => {
      observed.push({ cursor: session.cursor, count: session.readState(["metrics"]).metrics.toolCalls });
      notification.metrics.toolCalls = -500;
    });
    await session.dispatch(request("first"));
    await session.dispatchWithReceipt(request("second"), { includeState: false });
    assert.deepEqual(observed, [
      { cursor: baselineCursor + 1, count: 1 },
      { cursor: baselineCursor + 2, count: 2 },
    ]);
    assert.equal(before.metrics.toolCalls, 0);
    assert.equal(session.readState(["metrics"]).metrics.toolCalls, 2);
    assert.deepEqual(session.readState(fields), selectSessionStateFields(store.load(session.id), fields));
    const finalView = session.readState(fields);
    store.close();
    store = null;
    reopened = new SessionStore(dbPath, { workspace, checkpointInterval: 2 });
    const restored = sessionWith(state, { journal: reopened });
    assert.equal(restored.cursor, baselineCursor + 2);
    assert.deepEqual(restored.readState(fields), finalView);
    restored.readState(["metrics"]).metrics.toolCalls = 100;
    assert.equal(restored.state.metrics.toolCalls, 2);
  } finally {
    store?.close();
    reopened?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ToolHost 扩展 available、policy 和 execute 保持完整独立状态及 dispatch 返回契约", async () => {
  const state = reduceSession(initial(), { type: "USER_MESSAGE", content: "扩展需要看到历史", at });
  state.customMarker = { enabled: true, nested: ["保持"] };
  const session = sessionWith(state);
  const seen = { available: 0, policy: 0, execute: 0 };
  const inspectFullSnapshot = (snapshot) => {
    assert.equal(snapshot.id, session.id);
    assert.equal(snapshot.messages[0].content, "扩展需要看到历史");
    assert.ok(snapshot.events.some((event) => event.type === "message.user"));
    assert.deepEqual(snapshot.customMarker, { enabled: true, nested: ["保持"] });
  };
  const mutateSnapshot = (snapshot) => {
    snapshot.messages[0].content = "仅修改回调快照";
    snapshot.events.length = 0;
    snapshot.customMarker.enabled = false;
    snapshot.customMarker.nested.push("外部修改");
  };
  const tool = {
    name: "custom_full_state",
    description: "读取自定义完整会话状态",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    approval: "never", effects: ["read"], idempotency: "safe",
    capability: { risk: "R0", readOnly: true, resources: [{ kind: "session", access: "read" }] },
    available({ state: snapshot }) {
      seen.available += 1;
      inspectFullSnapshot(snapshot);
      mutateSnapshot(snapshot);
      return true;
    },
    async execute(_args, context) {
      seen.execute += 1;
      inspectFullSnapshot(context.state);
      mutateSnapshot(context.state);
      const committed = await context.dispatch({ type: "MEMORY_ADDED", content: "扩展提交", at });
      inspectFullSnapshot(committed);
      assert.equal(committed.memory.at(-1).content, "扩展提交");
      mutateSnapshot(committed);
      return "扩展完成";
    },
  };
  const policy = new WorkspacePolicy();
  const authorize = policy.authorize.bind(policy);
  policy.authorize = (input) => {
    seen.policy += 1;
    inspectFullSnapshot(input.state);
    const result = authorize(input);
    mutateSnapshot(input.state);
    return result;
  };
  const registry = {
    get: (name) => name === tool.name ? tool : undefined,
    schemas: () => [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }],
  };
  const host = new ToolHost({ registry, policy });
  assert.equal(host.schemas({ session }).length, 1);
  const result = await host.execute({ id: "custom-full-state", name: tool.name, arguments: {} }, { session });
  assert.equal(result.status, "completed");
  assert.equal(result.result, "扩展完成");
  assert.equal(seen.available, 2);
  assert.equal(seen.policy, 1);
  assert.equal(seen.execute, 1);
  inspectFullSnapshot(session.state);
  assert.equal(session.readState(["memory"]).memory.at(-1).content, "扩展提交");
});
