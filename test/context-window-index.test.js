import assert from "node:assert/strict";
import test from "node:test";
import { prepareModelRequest } from "../src/core/model-context.js";
import { measureModelMessages, measureModelRequest } from "../src/core/model-usage.js";
import { progressFeedback } from "../src/core/progress-feedback.js";
import { loadLegacyWindowReference } from "./support/context-window-reference.js";

const legacy = await loadLegacyWindowReference();
const tools = [{ type: "function", function: { name: "read_file", description: "读取说明".repeat(20),
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const context = (messages, extra = {}) => ({ messages, memory: [], contextMemory: [], contextSummary: null,
  loadedSkills: [], objective: null, plan: null, delegations: [], ...extra });

function history(count, width = 120) {
  return Array.from({ length: count }, (_, index) => [
    { role: "user", content: `问题${index} ${"中文🙂".repeat(width)}` },
    { role: "assistant", content: `回答${index} ${"abc".repeat(width)}` },
  ]).flat();
}

function parity(input, options = {}) {
  const before = structuredClone(input);
  const args = { systemPrompt: "固定指令", tools, maxInputTokens: 4000, ...options };
  const actual = prepareModelRequest(input, args);
  const expected = legacy.prepareModelRequest(input, args);
  assert.deepEqual(actual, expected);
  assert.deepEqual(input, before);
  assert.deepEqual(measureModelRequest(actual), {
    fixedTokens: actual.contextPlan.fixedTokens, messageTokens: actual.contextPlan.messageTokens,
    estimatedInputTokens: actual.contextPlan.estimatedInputTokens,
  });
  return actual;
}

test("完整请求计费复用同一消息估算，UTF-8和逐消息取整保持原值", () => {
  const messages = [{ role: "user", content: "中文🙂\ud800" }, { role: "assistant", content: "abc" }];
  const original = messages.reduce((sum, message) => sum + Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(message)) / 3)) + 4, 0);
  assert.equal(measureModelMessages(messages), original);
  assert.equal(measureModelRequest({ messages }).messageTokens, original);
});

test("空历史、少量轮次、多轮历史及完整容量边界均与冻结选择器一致", () => {
  for (const count of [0, 1, 2, 3, 25]) {
    const input = context(history(count));
    const full = legacy.prepareModelRequest(input, { systemPrompt: "固定指令", tools, maxInputTokens: 1_000_000 });
    for (const maxInputTokens of [...new Set([1, 100, 1000, 4000, full.contextPlan.estimatedInputTokens - 1,
      full.contextPlan.estimatedInputTokens, full.contextPlan.estimatedInputTokens + 1])]) {
      if (maxInputTokens > 0) parity(input, { maxInputTokens });
    }
  }
});

test("当前完整轮超目标时仍完整保留，旧轮和摘要不会挤掉工具协议", () => {
  const current = [{ role: "user", content: "当前任务" },
    { role: "assistant", content: "调用", tool_calls: [{ id: "pending", type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ padding: "x".repeat(8000) }) } }],
      provider_items: [{ type: "reasoning_content", content: "opaque".repeat(500) }] },
    { role: "tool", tool_call_id: "pending", content: "结果".repeat(3000) }];
  const input = context([...history(12), ...current], { contextSummary: summary(24) });
  const result = parity(input, { maxInputTokens: 500 });
  assert.deepEqual(result.messages, current);
  assert.equal(result.contextPlan.estimatedOverTarget, true);
  assert.equal(result.contextPlan.summary.omittedReason, "budget");
});

test("遇到过大的中间轮立即停止向前纳入，不能跳过它挑选更老的小轮", () => {
  const recent = history(4, 5);
  const input = context([...history(6, 5),
    { role: "user", content: "必须完整保留的中间轮".repeat(3000) },
    { role: "assistant", content: "中间轮结果" }, ...recent]);
  const result = parity(input, { tools: [], maxInputTokens: 1000 });
  assert.deepEqual(result.messages, recent);
  assert.equal(result.contextPlan.omittedTurns, 7);
});

function toolHistory(count = 7, { opaque = false } = {}) {
  return Array.from({ length: count }, (_, index) => [
    { role: "user", content: `历史任务 ${index}` },
    { role: "assistant", content: "读文件", tool_calls: [{ id: "reused", type: "function", function: {
      name: index % 2 ? "search_files" : "read_file", arguments: JSON.stringify({ text: "x".repeat(4000) }),
    } }], ...(opaque ? { provider_items: [{ type: "reasoning_content", content: "opaque".repeat(400) }] } : {}) },
    { role: "tool", tool_call_id: "reused", content: "输出".repeat(2500) },
    { role: "assistant", content: "历史完成" },
  ]).flat();
}

for (const suffix of ["", "a", "aa", "中文🙂a"]) {
  test(`工具档案首次纳入时精确计入共享说明，UTF-8取整后缀=${JSON.stringify(suffix)}`, () => {
    const input = context([...toolHistory(), { role: "user", content: "当前任务" }]);
    const systemPrompt = `固定指令${suffix}`;
    const all = legacy.prepareModelRequest(input, { systemPrompt, tools: [], maxInputTokens: 1_000_000 });
    const probe = legacy.prepareModelRequest(input, { systemPrompt, tools: [], maxInputTokens: 1600 });
    assert.equal(probe.contextPlan.compacted, true);
    assert.ok(probe.messages.some((message) => message.context_archive === "tool-history"));
    const candidate = all.messages.slice(-5);
    const boundary = measureModelRequest({ systemPrompt: probe.systemPrompt, messages: candidate, tools: [] }).estimatedInputTokens;
    const below = parity(input, { systemPrompt, tools: [], maxInputTokens: boundary - 1 });
    const exact = parity(input, { systemPrompt, tools: [], maxInputTokens: boundary });
    parity(input, { systemPrompt, tools: [], maxInputTokens: boundary + 1 });
    assert.equal(below.messages.some((message) => message.context_archive === "tool-history"), false);
    assert.equal(exact.messages.some((message) => message.context_archive === "tool-history"), true);
    assert.equal(exact.contextPlan.estimatedInputTokens, boundary);
    assert.equal(exact.messages.length, 5);
  });
}

function summary(throughMessage, content = "历史已完成") {
  return { objective: "继续当前任务", completed: [content], active: ["检查结果"], decisions: [], files: [], blockers: [], nextMoves: [],
    revision: 2, throughMessage, sourceCursor: 800, sourceComplete: true };
}

test("摘要纳入、覆盖不足、预算不足及额外省略边界保持原选择和元数据", () => {
  const messages = [...history(15, 25), { role: "user", content: "当前任务" }];
  const reasons = new Set();
  let included = false;
  for (const through of [2, 16, 28, 30]) {
    for (const content of ["短摘要", "摘要细节".repeat(200)]) {
      for (const maxInputTokens of [120, 300, 500, 850, 1600]) {
        const result = parity(context(messages, { contextSummary: summary(through, content) }), { tools: [], maxInputTokens });
        reasons.add(result.contextPlan.summary.omittedReason);
        included ||= result.contextPlan.summary.included;
      }
    }
  }
  assert.ok(included);
  assert.ok(reasons.has("budget"));
  assert.ok(reasons.has("coverage"));
});

test("opaque历史、活动工具压缩与当前进展/完成反馈保持同一请求及哈希", () => {
  const current = [{ role: "user", content: "完成当前任务" }];
  for (let index = 0; index < 5; index++) current.push(
    { role: "assistant", content: "", tool_calls: [{ id: "same", type: "function", function: {
      name: "read_file", arguments: JSON.stringify({ long: "p".repeat(5000) }),
    } }] }, { role: "tool", tool_call_id: "same", content: "长结果".repeat(2000) });
  current.push({ role: "system", runtime_feedback: "progress", content: progressFeedback(1) },
    { role: "system", runtime_feedback: "completion", content: "完成纠正：保持当前目标" });
  const input = context([...toolHistory(4, { opaque: true }), ...current]);
  for (const maxInputTokens of [100, 12000, 30000, 1_000_000]) {
    const result = parity(input, { maxInputTokens });
    assert.ok(result.systemPrompt.includes(progressFeedback(1)));
    assert.equal(result.contextPlan.activeToolProjection.preservedRounds, 2);
    assert.ok(result.messages.filter((message) => message.role === "assistant").some((message) => message.tool_calls));
  }
});

test("索引仅属于当前请求，状态、工具和预算变化不会复用旧计费或泄露快照", () => {
  const input = context([...history(15, 20), { role: "user", content: "当前任务" }]);
  const definitions = structuredClone(tools);
  const first = parity(input, { tools: definitions, maxInputTokens: 1000 });
  const retained = structuredClone(first);
  input.messages[12].content += "扩充历史".repeat(300);
  input.messages.push({ role: "assistant", content: "新进展" });
  definitions[0].function.description += "工具变化".repeat(100);
  for (const budget of [700, 1600, 20000]) parity(input, { tools: definitions, maxInputTokens: budget });
  assert.deepEqual(first, retained);
  first.messages[0].content = "调用方修改";
  first.tools.length = 0;
  parity(input, { tools: definitions, maxInputTokens: 1000 });
});

test("Date序列化钩子回退保持旧调用轨迹和请求", () => {
  const input = context(history(8, 12));
  input.messages.at(-2).stamp = new Date("2026-09-09T00:00:00Z");
  const original = Date.prototype.toJSON;
  let trace = [];
  Date.prototype.toJSON = function (key) { trace.push(key); return original.call(this, key); };
  try {
    const args = { systemPrompt: "固定", tools: [], maxInputTokens: 1500 };
    const expected = legacy.prepareModelRequest(input, args);
    const oldTrace = [...trace];
    trace = [];
    const actual = prepareModelRequest(input, args);
    assert.deepEqual(actual, expected);
    assert.deepEqual(trace, oldTrace);
  } finally { Date.prototype.toJSON = original; }
});

test("继承的档案标记getter使用原选择器，不能缓存动态标记", () => {
  const input = context(history(8, 12));
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "context_archive");
  let reads = 0;
  Object.defineProperty(Object.prototype, "context_archive", { configurable: true,
    get() { reads++; return reads % 3 === 0 ? "tool-history" : undefined; } });
  try {
    const args = { systemPrompt: "固定", tools: [], maxInputTokens: 700 };
    const expected = legacy.prepareModelRequest(input, args);
    const oldReads = reads;
    reads = 0;
    const actual = prepareModelRequest(input, args);
    assert.deepEqual(actual, expected);
    assert.equal(reads, oldReads);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "context_archive", previous);
    else delete Object.prototype.context_archive;
  }
});

test("兼容旧的非对象消息值且不把其费用当普通消息对象缓存", () => {
  const input = context(history(6, 12));
  input.messages[input.messages.length - 1] = "旧适配器消息值";
  parity(input, { tools: [], maxInputTokens: 500 });
});

test("特殊工具定义、稀疏/深层消息在探测预算外仍保持旧选择", () => {
  const input = context(history(5, 20));
  let deep = "end";
  for (let depth = 0; depth < 135; depth++) deep = { nested: deep };
  input.messages.at(-2).metadata = deep;
  parity(input, { maxInputTokens: 1000 });
  input.messages.at(-2).metadata = new Array(10);
  parity(input, { maxInputTokens: 1000 });
  input.messages.at(-2).metadata = Array.from({ length: 100_100 }, () => 1);
  parity(input, { maxInputTokens: 1000 });
  delete input.messages.at(-2).metadata;
  parity(input, { maxInputTokens: 1000, tools: [{ type: "function", stamp: new Date("2026-09-09") }] });
});

test("旧历史中的非法JSON内容不能被预算省略而隐藏原异常", () => {
  for (const extra of [1n, (() => { const value = {}; value.self = value; return value; })()]) {
    const input = context(history(5, 20));
    input.messages[1].metadata = extra;
    const options = { systemPrompt: "固定", tools: [], maxInputTokens: 10 };
    assert.throws(() => legacy.prepareModelRequest(input, options));
    assert.throws(() => prepareModelRequest(input, options));
  }
});

test("200组确定性多轮请求对照包含工具成本、Unicode和不同预算", () => {
  let seed = 54819;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  for (let index = 0; index < 200; index++) {
    const input = context(history(3 + Math.floor(random() * 20), 1 + Math.floor(random() * 30)));
    if (index % 3 === 0) input.contextSummary = summary(Math.floor(random() * input.messages.length));
    parity(input, { systemPrompt: "固定🙂".repeat(1 + Math.floor(random() * 10)),
      tools: index % 2 ? tools : [], maxInputTokens: 1 + Math.floor(random() * 6000) });
  }
});
