import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { ContextLifecycle } from "../src/core/context-lifecycle.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { ContextSummaryRequestBudgetError } from "../src/core/context-summary.js";
import { prepareSessionContextSummary } from "../src/core/session-summary.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { prepareReferenceSessionSummary } from "./support/session-summary-reference.js";

const at = "2026-09-10T01:00:00.000Z";
const summary = { objective: "完成原任务", completed: ["保存既有事实"], active: [], decisions: [],
  files: [], blockers: [], nextMoves: ["继续验证"], sourceComplete: false };
const history = [
  { role: "user", content: "首个历史请求", provider_items: [{ encrypted_content: "private-state" }] },
  { role: "assistant", content: "首个历史结果" },
  { role: "user", content: "第二个历史请求" },
  { role: "assistant", content: "第二个历史结果" },
  { role: "user", content: "当前任务" },
];
const options = { fromMessage: 0, throughMessage: 4, maxInputTokens: 32_000 };
const seed = (workspace = "/tmp") => createSession({ provider: "summary-snapshot-fixture", workspace, createdAt: at });
function makeSession({ messages = history, previousSummary = null, extra = {} } = {}) {
  return new AgentSession({ state: { ...seed(), messages: structuredClone(messages), contextSummary: previousSummary },
    reducer: reduceSession, ...extra });
}

for (const usesModel of [true, false]) {
  test(`${usesModel ? "模型" : "本地抽取"}摘要来源与旧全历史快照路径一致`, () => {
    for (const previousSummary of [null, summary]) {
      const session = makeSession({ previousSummary });
      const before = session.state;
      const selected = session.prepareContextSummary({ ...options, usesModel });
      assert.equal(selected instanceof Promise, false);
      assert.deepEqual(selected, prepareReferenceSessionSummary(session, { ...options, usesModel }));
      assert.equal(selected.sourceCursor, session.cursor);
      assert.deepEqual(session.state, before);
      assert.doesNotMatch(JSON.stringify(selected), /private-state|provider_items/);
    }
  });
}

test("预算缩小与首轮非单调边界仍保持请求、覆盖和完整性", () => {
  const cases = [
    [history, 500],
    [[{ role: "user", content: "A".repeat(350) }, { role: "user", content: "B" },
      { role: "user", content: "中".repeat(11_000) }], 389],
    [[{ role: "user", content: "开始" }, ...Array.from({ length: 20 }, () => ({ role: "tool", content: "中文".repeat(8_000) })),
      { role: "assistant", content: "最后结果" }], 4_000],
  ];
  for (const [messages, maxInputTokens] of cases) {
    const session = makeSession({ messages });
    const config = { throughMessage: messages.length, maxInputTokens };
    assert.deepEqual(prepareSessionContextSummary(session, config), prepareReferenceSessionSummary(session, config));
  }
});

test("返回的消息、旧摘要和请求均不暴露 Session 私有引用", () => {
  const session = makeSession({ previousSummary: summary });
  const before = session.state;
  const first = session.prepareContextSummary(options);
  const second = session.prepareContextSummary(options);
  first.batch.messages[0].content = "外部改写";
  first.batch.messages.push({ role: "user", content: "外部注入" });
  first.previousSummary.completed.push("伪造事实");
  first.request.messages[0].content = "改写请求";
  first.request.tools.push({ name: "external" });
  assert.deepEqual(session.state, before);
  assert.deepEqual(second, session.prepareContextSummary(options));
  assert.notEqual(second.previousSummary, session.prepareContextSummary(options).previousSummary);
});

test("新读取仅观察已提交状态，旧结果在排队提交后保持独立", async () => {
  const session = makeSession();
  const first = session.prepareContextSummary(options);
  const pending = session.dispatch({ type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "当前结果" }, at });
  assert.deepEqual(session.prepareContextSummary(options), first);
  await pending;
  const next = session.prepareContextSummary({ throughMessage: 6 });
  assert.equal(next.sourceCursor, first.sourceCursor + 1);
  assert.equal(first.batch.throughMessage, 4);
  assert.equal(next.batch.throughMessage, 6);
  assert.match(JSON.stringify(next.batch), /当前结果/);
});

test("持久化提交失败不改变摘要来源或其游标", async () => {
  const state = { ...seed(), messages: history };
  const session = new AgentSession({ state, reducer: reduceSession, journal: {
    ensureJournal: () => structuredClone(state), latestSessionCursor: () => 7,
    commitSessionEvent: () => { throw new Error("合成提交失败"); },
  } });
  const before = session.prepareContextSummary(options);
  await assert.rejects(session.dispatch({ type: "MODEL_REQUESTED", at }), /合成提交失败/);
  assert.deepEqual(session.prepareContextSummary(options), before);
  assert.equal(before.sourceCursor, 7);
});

test("关闭后的摘要准备沿用只读快照语义，不重新打开会话", async () => {
  const session = makeSession();
  const before = session.prepareContextSummary(options);
  session.close();
  assert.deepEqual(session.prepareContextSummary(options), before);
  await assert.rejects(session.dispatch({ type: "MODEL_REQUESTED" }), /已删除或关闭/);
});

test("原生摘要准备不复制整份 messages，也不调用公开状态读取器", () => {
  const session = makeSession();
  Object.defineProperty(session, "state", { get() { throw new Error("不应读取完整state"); } });
  session.readState = () => { throw new Error("直接新接口不应调用字段读取器"); };
  const clone = globalThis.structuredClone;
  let historyClones = 0;
  globalThis.structuredClone = (value, ...rest) => {
    if (value?.messages || (Array.isArray(value) && value.some((item) => item?.role))) historyClones += 1;
    return clone(value, ...rest);
  };
  try {
    assert.equal(session.prepareContextSummary(options).batch.throughMessage, 4);
    assert.equal(historyClones, 0);
  } finally { globalThis.structuredClone = clone; }
});

test("本地预算拒绝携带原来源游标，且无需复制全历史", async () => {
  const session = makeSession();
  await session.dispatch({ type: "MODEL_REQUESTED", at });
  const cursor = session.cursor;
  const clone = globalThis.structuredClone;
  let historyClones = 0;
  globalThis.structuredClone = (value, ...rest) => {
    if (value?.messages) historyClones += 1;
    return clone(value, ...rest);
  };
  try {
    assert.throws(() => prepareSessionContextSummary(session, { ...options, maxInputTokens: 1 }), (error) => {
      assert.ok(error instanceof ContextSummaryRequestBudgetError);
      assert.equal(error.sourceCursor, cursor);
      return true;
    });
    assert.equal(historyClones, 0);
  } finally { globalThis.structuredClone = clone; }
});

test("新接口参数错误保持原校验，不被伪装为预算降级", () => {
  const session = makeSession();
  for (const invalid of [{ ...options, throughMessage: 100 }, { ...options, fromMessage: -1 },
    { ...options, usesModel: "false" }, { ...options, maxInputTokens: 0 }]) {
    assert.throws(() => session.prepareContextSummary(invalid), (error) => {
      assert.equal(error instanceof ContextSummaryRequestBudgetError, false);
      assert.equal(Object.hasOwn(error, "sourceCursor"), false);
      return true;
    });
  }
});

for (const narrow of [true, false]) {
  test(`旧${narrow ? "字段" : "完整状态"}适配器仍读取一次来源再取 cursor`, () => {
    const native = makeSession();
    const calls = [];
    const adapter = {
      get cursor() { calls.push("cursor"); return 31; },
      get state() { calls.push("state"); return native.state; },
      ...(narrow ? { readState(fields) { calls.push("readState"); return native.readState(fields); } } : {}),
    };
    const result = prepareSessionContextSummary(adapter, options);
    assert.equal(result.sourceCursor, 31);
    assert.deepEqual(calls, [narrow ? "readState" : "state", "cursor"]);
    assert.deepEqual(result.batch, native.prepareContextSummary(options).batch);
  });
}

test("原生 readState 覆盖保留来源改写，不被继承的新方法绕过", () => {
  const session = makeSession();
  let reads = 0;
  session.readState = (fields) => {
    reads += 1;
    assert.deepEqual(fields, ["messages", "contextSummary"]);
    return { messages: [{ role: "user", content: "自定义来源" }], contextSummary: null };
  };
  const result = prepareSessionContextSummary(session, { throughMessage: 1 });
  assert.equal(reads, 1);
  assert.equal(result.batch.messages[0].content, "自定义来源");
});

test("动态 readState getter 只由旧路径读取一次，异常不回退", () => {
  const session = makeSession();
  let reads = 0;
  const failure = new Error("读取钩子失败");
  Object.defineProperty(session, "readState", { get() { reads += 1; return () => { throw failure; }; } });
  assert.throws(() => prepareSessionContextSummary(session, options), (error) => error === failure);
  assert.equal(reads, 1);
});

test("原生 cursor 覆盖保持外部来源身份", () => {
  const session = makeSession();
  let reads = 0;
  Object.defineProperty(session, "cursor", { get() { reads += 1; return 99; } });
  assert.equal(prepareSessionContextSummary(session, options).sourceCursor, 99);
  assert.equal(reads, 1);
});

test("Proxy 适配器沿用其原有字段读取和 cursor 钩子", () => {
  const native = makeSession();
  const calls = [];
  const proxy = new Proxy(native, { get(target, key) {
    if (key === "prepareContextSummary") throw new Error("不应探测Proxy新方法");
    if (key === "readState") return (fields) => { calls.push("readState"); return target.readState(fields); };
    if (key === "cursor") { calls.push("cursor"); return 55; }
    return Reflect.get(target, key, target);
  } });
  assert.equal(prepareSessionContextSummary(proxy, options).sourceCursor, 55);
  assert.deepEqual(calls, ["readState", "cursor"]);
});

test("显式新适配器按一次方法读取调用，保持 this 与异常", () => {
  let reads = 0;
  const result = { sourceCursor: 42, batch: { messages: [] } };
  const adapter = {
    get prepareContextSummary() { reads += 1; return function (config) {
      assert.equal(this, adapter); assert.equal(config, options); return result;
    }; },
    get state() { throw new Error("不能读旧state"); },
  };
  assert.equal(prepareSessionContextSummary(adapter, options), result);
  assert.equal(reads, 1);
  const failure = new Error("新适配器失败");
  assert.throws(() => prepareSessionContextSummary({ prepareContextSummary() { throw failure; } }, options),
    (error) => error === failure);
});

test("只覆盖新方法的原生 Session 明确选择新扩展接口", () => {
  const session = makeSession();
  const native = session.prepareContextSummary;
  let calls = 0;
  session.prepareContextSummary = function (config) { calls += 1; return native.call(this, config); };
  assert.deepEqual(prepareSessionContextSummary(session, options), prepareReferenceSessionSummary(session, options));
  assert.equal(calls, 1);
});

test("真实 SQLite 恢复后摘要来源、请求和 durable cursor 一致", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-session-summary-"));
  const database = path.join(workspace, "sessions.db");
  let store = new SessionStore(database, { workspace });
  try {
    const session = new AgentSession({ state: seed(workspace), reducer: reduceSession, journal: store });
    for (const message of history) await session.dispatch(message.role === "user"
      ? { type: "USER_MESSAGE", content: message.content, at }
      : { type: "ASSISTANT_MESSAGE", message, at });
    const before = session.prepareContextSummary(options);
    const id = session.id;
    store.close();
    store = new SessionStore(database, { workspace });
    const restored = new AgentSession({ state: store.load(id), reducer: reduceSession, journal: store });
    assert.deepEqual(restored.prepareContextSummary(options), before);
    assert.deepEqual(prepareSessionContextSummary(restored, options), prepareReferenceSessionSummary(restored, options));
  } finally { store.close(); rmSync(workspace, { recursive: true, force: true }); }
});

test("Lifecycle 接入摘要准备接口，不再读取整份历史字段快照", async () => {
  const session = makeSession({ messages: [
    { role: "user", content: "历史目标".repeat(2_000) },
    { role: "assistant", content: "历史结果" }, { role: "user", content: "当前任务" },
  ] });
  const prepare = session.prepareContextSummary;
  const read = session.readState;
  let prepares = 0;
  let historyReads = 0;
  let selected;
  session.prepareContextSummary = function (config) {
    prepares += 1;
    selected = prepare.call(this, config);
    return selected;
  };
  session.readState = function (fields) {
    if (fields.includes("messages")) historyReads += 1;
    return read.call(this, fields);
  };
  const { lifecycle, requests } = runtimeFixture(session);
  await (await lifecycle.startTurn()).completeModelStep();
  assert.equal(prepares, 1);
  assert.equal(historyReads, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual({ ...requests[0], signal: undefined }, selected.request);
  const completed = session.state.events.find((event) => event.type === "context.summary_completed");
  assert.equal(completed.sourceCursor, selected.sourceCursor);
  assert.equal(session.state.contextSummary.throughMessage, selected.batch.throughMessage);
});

test("Lifecycle 本地预算降级使用拒绝时的来源游标", async () => {
  const session = makeSession({ messages: [
    { role: "user", content: "历史目标".repeat(2_000) }, { role: "user", content: "当前任务" },
  ] });
  const prepare = session.prepareContextSummary;
  let rejectedCursor;
  session.prepareContextSummary = function (config) {
    try { return prepare.call(this, config); }
    catch (error) {
      rejectedCursor = error.sourceCursor;
      Object.defineProperty(this, "cursor", { get() { return 99_999; } });
      throw error;
    }
  };
  const { lifecycle, requests } = runtimeFixture(session, { summaryMaxInputTokens: 1 });
  await (await lifecycle.startTurn()).completeModelStep();
  const degraded = session.state.events.find((event) => event.type === "context.summary_degraded");
  assert.equal(degraded.sourceCursor, rejectedCursor);
  assert.notEqual(degraded.sourceCursor, session.cursor);
  assert.equal(requests.length, 0);
  assert.equal(session.state.contextSummary, null);
  assert.deepEqual(degraded.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

test("来源读取钩子的预算类型异常不被伪装为本地摘要降级", async () => {
  const session = makeSession({ messages: [
    { role: "user", content: "历史目标".repeat(2_000) }, { role: "user", content: "当前任务" },
  ] });
  const read = session.readState;
  const failure = new ContextSummaryRequestBudgetError(1, 10);
  session.readState = function (fields) {
    if (fields.includes("messages")) throw failure;
    return read.call(this, fields);
  };
  const { lifecycle, requests } = runtimeFixture(session);
  await assert.rejects((await lifecycle.startTurn()).completeModelStep(), (error) => error === failure);
  assert.equal(requests.length, 0);
  assert.equal(session.state.events.some((event) => event.type === "context.summary_degraded"), false);
});

function runtimeFixture(session, overrides = {}) {
  const requests = [];
  const lifecycle = new ContextLifecycle({ session, systemPrompt: "完成任务", getTools: () => [], maxInputTokens: 400,
    provider: { name: "summary-snapshot-fixture", complete: async (request) => {
      requests.push(request);
      return { text: JSON.stringify(summary), usage: null };
    } },
    requestModel: async () => ({ text: "完成", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
    ...overrides,
  });
  return { lifecycle, requests };
}
