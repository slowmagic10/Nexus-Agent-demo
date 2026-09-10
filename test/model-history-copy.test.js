import assert from "node:assert/strict";
import test from "node:test";
import { ModelContextProjection, prepareModelRequest, projectModelContext } from "../src/core/model-context.js";
import { AgentSession } from "../src/core/session.js";
import { ContextLifecycle } from "../src/core/context-lifecycle.js";
import { reduceSession } from "../src/core/state.js";
import { buildSystemPrompt } from "../src/workspace.js";
import { promptContextFixture } from "./support/prompt-context-fixture.js";
import { loadHistorySnapshotReference } from "./support/model-history-reference.js";

const legacy = await loadHistorySnapshotReference();
const baseOptions = { systemPrompt: "离线验证", tools: [], maxInputTokens: 1_000_000 };
const builtin = () => buildSystemPrompt("只在临时数据内验证");
function pair(state) {
  return { current: new ModelContextProjection([], state), previous: new legacy.ModelContextProjection([], state) };
}
function fullClones(run, count) {
  const clone = globalThis.structuredClone;
  let calls = 0;
  globalThis.structuredClone = (value, ...options) => {
    if (Array.isArray(value) && value.length === count) calls++;
    return clone(value, ...options);
  };
  try { return { calls: () => calls, value: run() }; }
  finally { globalThis.structuredClone = clone; }
}
function capture(run) {
  try { return { value: run() }; }
  catch (error) { return { error: { name: error.name, message: error.message } }; }
}

for (const opaque of [false, true]) {
  test(`${opaque ? "不透明 Provider" : "普通工具"}历史的预算、完整协议、摘要与哈希保持`, () => {
    const { state, tools } = promptContextFixture(10, { opaque });
    const { current, previous } = pair(state);
    for (const systemPrompt of ["固定", builtin(), (context) => `历史数量 ${context.messages.length}`]) {
      for (const maxInputTokens of [1, 4200, 9000, 1_000_000]) {
        const options = { systemPrompt, tools, maxInputTokens };
        const before = fullClones(() => previous.prepareRequest(options), state.messages.length);
        const after = fullClones(() => current.prepareRequest(options), state.messages.length);
        assert.deepEqual(after.value, before.value);
        assert.equal(before.calls(), 1);
        assert.equal(after.calls(), 0);
      }
    }
  });
}

test("全部历史/活动投影分支的返回嵌套值不连接私有历史或后续请求", () => {
  for (const scenario of ["plain", "small-tools", "archived-tools", "opaque"]) {
    const { state } = promptContextFixture(4, { opaque: scenario === "opaque" });
    if (scenario === "plain") state.messages = state.messages.filter((message) => !message.tool_calls && message.role !== "tool");
    if (scenario === "small-tools") for (const message of state.messages) {
      if (message.tool_calls) message.tool_calls[0].function.arguments = "{}";
      if (message.role === "tool") message.content = "短输出";
    }
    for (const message of state.messages) message.metadata = { values: ["原始嵌套数据"] };
    const { current, previous } = pair(state);
    const expected = previous.prepareRequest(baseOptions);
    const request = current.prepareRequest(baseOptions);
    assert.deepEqual(request, expected);
    for (const message of request.messages) {
      if (message.metadata) message.metadata.values.push("调用方修改");
      if (message.tool_calls) message.tool_calls[0].function.arguments = "调用方修改";
      if (message.provider_items) message.provider_items[0].encrypted_content = "调用方修改";
      message.content = "调用方修改";
    }
    request.messages.push({ role: "user", content: "外部新消息" });
    assert.deepEqual(current.prepareRequest(baseOptions), expected);
    const retained = current.prepareRequest(baseOptions);
    current.applyEvent({ patch: { append: { messages: [{ role: "assistant", content: "后续事实" }] } } }, state);
    assert.deepEqual(retained, expected);
  }
});

test("同一轮的共享引用与跨轮独立副本保持既有别名关系", () => {
  const { state } = promptContextFixture(2);
  const metadata = { values: ["共享来源"] };
  state.messages = [
    { role: "user", content: "第一轮", metadata },
    { role: "assistant", content: "第一轮回答", metadata },
    { role: "user", content: "第二轮", metadata },
    { role: "assistant", content: "第二轮回答", metadata },
  ];
  const { current, previous } = pair(state);
  const actual = current.prepareRequest(baseOptions);
  assert.deepEqual(actual, previous.prepareRequest(baseOptions));
  assert.equal(actual.messages[0].metadata, actual.messages[1].metadata);
  assert.equal(actual.messages[2].metadata, actual.messages[3].metadata);
  assert.notEqual(actual.messages[0].metadata, actual.messages[2].metadata);
  actual.messages[0].metadata.values.push("外部改写");
  assert.deepEqual(actual.messages[2].metadata.values, ["共享来源"]);
  assert.deepEqual(current.prepareRequest(baseOptions), previous.prepareRequest(baseOptions));
});

test("提示回调仍独立，回调追加或替换消息保持原来的同步读取顺序", () => {
  for (const mutation of ["append", "set"]) {
    const { state } = promptContextFixture(3);
    const { current, previous } = pair(state);
    const run = (projection) => {
      let captured;
      const request = projection.prepareRequest({ ...baseOptions, systemPrompt: (context) => {
        captured = context;
        context.messages[0].content = "只能修改提示参数";
        projection.applyEvent({ patch: { [mutation]: { messages: [{ role: "assistant", content: "回调提交" }] } } }, state);
        return "回调提示";
      } });
      captured.messages.length = 0;
      return { request, next: projection.prepareRequest(baseOptions) };
    };
    assert.deepEqual(run(current), run(previous));
  }
});

test("tools getter 在历史投影之后运行，重入追加不改写本次已生成消息", () => {
  const { state } = promptContextFixture(3);
  const { current, previous } = pair(state);
  function run(projection) {
    let calls = 0;
    const tools = [{ get description() {
      calls++;
      projection.applyEvent({ patch: { append: { messages: [{ role: "assistant", content: "工具读取阶段的新事件" }] } } }, state);
      return "本地工具";
    } }];
    const first = projection.prepareRequest({ ...baseOptions, tools });
    assert.equal(calls, 1);
    assert.ok(!first.messages.some((message) => message.content === "工具读取阶段的新事件"));
    const next = projection.prepareRequest(baseOptions);
    assert.ok(next.messages.some((message) => message.content === "工具读取阶段的新事件"));
    return { first, next };
  }
  assert.deepEqual(run(current), run(previous));
});

test("公开纯函数仍先克隆完整 messages 并保留输入 getter 次序", () => {
  const { state } = promptContextFixture(3);
  let reads = 0;
  const plain = projectModelContext([], state);
  const context = { ...plain, get messages() { reads++; return plain.messages; } };
  const result = fullClones(() => prepareModelRequest(context, baseOptions), state.messages.length);
  assert.equal(reads, 2);
  assert.equal(result.calls(), 1);
  assert.deepEqual(result.value, legacy.prepareModelRequest(plain, baseOptions));
});

for (const [name, makeValue] of [
  ["Date", () => new Date("2026-09-10T00:00:00Z")],
  ["Map", () => new Map([["key", "value"]])],
  ["稀疏数组", () => Array(5)],
  ["超深对象", () => { let value = "末尾"; for (let i = 0; i < 135; i++) value = { child: value }; return value; }],
  ["超过节点预算", () => Array(100_100).fill(1)],
]) {
  test(`${name} 使用完整消息快照兼容路径`, () => {
    const { state } = promptContextFixture(3);
    state.messages[0].metadata = makeValue();
    const { current, previous } = pair(state);
    const after = fullClones(() => current.prepareRequest(baseOptions), state.messages.length);
    assert.equal(after.calls(), 1);
    assert.deepEqual(after.value, previous.prepareRequest(baseOptions));
  });
}

test("特殊序列化钩子可改写其请求副本，不能改写私有工具历史", () => {
  const { state } = promptContextFixture(3);
  state.messages[1].stamp = new Date("2026-09-10T00:00:00Z");
  const { current, previous } = pair(state);
  const native = Date.prototype.toJSON;
  let trace = [];
  Date.prototype.toJSON = function (key) {
    trace.push(key);
    this.setUTCSeconds(this.getUTCSeconds() + 1);
    return native.call(this, key);
  };
  try {
    const expected = previous.prepareRequest(baseOptions);
    const expectedTrace = [...trace];
    trace = [];
    const actual = current.prepareRequest(baseOptions);
    assert.deepEqual(actual, expected);
    assert.deepEqual(trace, expectedTrace);
  } finally { Date.prototype.toJSON = native; }
  let captured;
  current.prepareRequest({ ...baseOptions, systemPrompt: (context) => { captured = context; return "捕获"; } });
  assert.equal(captured.messages[1].stamp.toISOString(), "2026-09-10T00:00:00.000Z");
});

test("对象正文和对象参数的字符串转换不能触及私有值", () => {
  for (const field of ["content", "arguments"]) {
    const { state } = promptContextFixture(3);
    const source = field === "content" ? state.messages[1] : state.messages[1].tool_calls[0].function;
    source[field] = { marker: "原始对象" };
    const { current, previous } = pair(state);
    const native = Object.prototype.toString;
    let trace = [];
    Object.prototype.toString = function () {
      trace.push(this.marker);
      this.changedByCoercion = true;
      return native.call(this);
    };
    try {
      const expected = previous.prepareRequest(baseOptions);
      const expectedTrace = [...trace];
      trace = [];
      const actual = fullClones(() => current.prepareRequest(baseOptions), state.messages.length);
      assert.equal(actual.calls(), 1);
      assert.deepEqual(actual.value, expected);
      assert.deepEqual(trace, expectedTrace);
    } finally { Object.prototype.toString = native; }
    let captured;
    current.prepareRequest({ ...baseOptions, systemPrompt: (context) => { captured = context; return "捕获"; } });
    const value = field === "content" ? captured.messages[1].content : captured.messages[1].tool_calls[0].function.arguments;
    assert.equal(value.changedByCoercion, undefined);
  }
});

test("继承的模型字段 getter 走完整副本，保持调用轨迹且不泄漏私有接收者", () => {
  const { state } = promptContextFixture(3);
  delete state.messages[0].role;
  const { current, previous } = pair(state);
  let receivers = [];
  Object.defineProperty(Object.prototype, "role", { configurable: true,
    get() { receivers.push(this); return "user"; } });
  try {
    const expected = previous.prepareRequest(baseOptions);
    const count = receivers.length;
    receivers = [];
    const actual = fullClones(() => current.prepareRequest(baseOptions), state.messages.length);
    assert.deepEqual(actual.value, expected);
    assert.equal(actual.calls(), 1);
    assert.equal(receivers.length, count);
    for (const value of receivers) value.privateMutation = "只能改副本";
  } finally { delete Object.prototype.role; }
  let captured;
  // The legacy missing-role entry is still accepted as a pre-user history row.
  current.prepareRequest({ ...baseOptions, systemPrompt: (context) => { captured = context; return "捕获"; } });
  assert.equal(captured.messages[0].privateMutation, undefined);
});

test("循环与非法 JSON 的错误不能被旧历史省略掩盖", () => {
  for (const value of [1n, (() => { const cycle = {}; cycle.self = cycle; return cycle; })()]) {
    const { state } = promptContextFixture(3);
    state.messages[0].metadata = value;
    const { current, previous } = pair(state);
    const options = { ...baseOptions, maxInputTokens: 1 };
    const expected = capture(() => previous.prepareRequest(options));
    const actual = capture(() => current.prepareRequest(options));
    assert.ok(actual.error);
    assert.deepEqual(actual, expected);
  }
});

test("投影增量从普通到特殊再替换回普通时重新判断，失败补丁不推进历史", () => {
  const { state } = promptContextFixture(3);
  const { current, previous } = pair(state);
  for (const [patch, copied] of [
    [{ append: { messages: [{ role: "assistant", content: "普通新事实" }] } }, false],
    [{ append: { messages: [{ role: "assistant", content: "特殊新事实", stamp: new Date(0) }] } }, true],
    [{ set: { messages: state.messages } }, false],
  ]) {
    current.applyEvent({ patch }, state);
    previous.applyEvent({ patch }, state);
    let count;
    const options = { ...baseOptions, systemPrompt: (context) => { count = context.messages.length; return "计数"; } };
    const expected = previous.prepareRequest(options);
    const actual = fullClones(() => current.prepareRequest(options), count);
    assert.deepEqual(actual.value, expected);
    assert.equal(actual.calls(), copied ? 1 : 0);
  }
  const bad = { patch: { append: { messages: [{ role: "user", content: "不能提交" }], memory: [() => null] } } };
  assert.throws(() => current.applyEvent(bad, state), { name: "DataCloneError" });
  assert.deepEqual(current.prepareRequest(baseOptions), previous.prepareRequest(baseOptions));
});

test("120 组确定性历史与来源类型组合保持完整请求相等", () => {
  let seed = 91824;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let index = 0; index < 120; index++) {
    const { state, tools } = promptContextFixture(2 + Math.floor(random() * 12), { opaque: index % 3 === 0 });
    if (index % 4 === 0) state.contextSummary = null;
    if (index % 5 === 0) state.messages[0].metadata = new Date(0);
    state.messages.at(-1).content += "多字节🙂\n".repeat(Math.floor(random() * 20));
    const { current, previous } = pair(state);
    const options = { systemPrompt: index % 2 ? "固定" : builtin(), tools, maxInputTokens: 1 + Math.floor(random() * 22_000) };
    assert.deepEqual(current.prepareRequest(options), previous.prepareRequest(options));
  }
});

test("Lifecycle 的 Provider 修改请求副本不会影响 Session 或下一次模型请求", async () => {
  const { state, tools } = promptContextFixture(3, { opaque: true });
  const original = structuredClone(state.messages);
  const session = new AgentSession({ state, reducer: reduceSession });
  let calls = 0;
  const lifecycle = new ContextLifecycle({ session, systemPrompt: builtin(), getTools: () => tools,
    maxInputTokens: 1_000_000, provider: { complete: async () => { throw new Error("不允许外部模型"); } },
    requestModel: async (request) => {
      calls++;
      assert.equal(request.messages[1].tool_calls[0].function.arguments, original[1].tool_calls[0].function.arguments);
      assert.deepEqual(request.messages[1].provider_items, original[1].provider_items);
      request.messages[1].tool_calls[0].function.arguments = "Provider 改写";
      request.messages[1].provider_items[0].encrypted_content = "Provider 改写";
      request.messages.length = 0;
      assert.deepEqual(session.readState(["messages"]).messages, original);
      return { text: "离线响应", toolCalls: [], usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, finishReason: "stop" };
    } });
  const turn = await lifecycle.startTurn({ query: "当前任务" });
  await turn.completeModelStep();
  await turn.completeModelStep();
  assert.equal(calls, 2);
  assert.deepEqual(session.readState(["messages"]).messages, original);
});
