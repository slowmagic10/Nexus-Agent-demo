import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextSummaryRequestBudgetError,
  planContextSummaryRequest,
  prepareContextSummaryRequest,
  selectContextSummaryBatch,
} from "../src/core/context-summary.js";
import { measureModelRequest } from "../src/core/model-usage.js";

const previousSummary = { objective: "完成原始目标", completed: ["旧模块已验收"], throughMessage: 2, sourceComplete: true };
const shortHistory = [
  { role: "user", content: "第一轮目标" },
  { role: "assistant", content: "第一轮完成" },
  { role: "user", content: "第二轮目标" },
  { role: "assistant", content: "第二轮完成" },
  { role: "user", content: "当前轮保留" },
];

test("完整摘要请求充足预算保留原批次、实际请求和 signal", () => {
  const signal = new AbortController().signal;
  const batch = selectContextSummaryBatch(shortHistory, { fromMessage: 2, throughMessage: 4 });
  const expected = prepareContextSummaryRequest({ previousSummary, ...batch, signal });
  const result = planContextSummaryRequest({ messages: shortHistory, previousSummary,
    fromMessage: 2, throughMessage: 4, signal });

  assert.deepEqual(result.batch, batch);
  assert.deepEqual(result.request, expected);
  assert.equal(result.request.signal, signal);
  assert.equal(result.input.signal, signal);
  assert.equal(result.input.sourceComplete, true);
  assert.equal(result.maxInputTokens, 32_000);
  assert.equal(result.sourceMaxChars, 48_000);
  assertValidPlan(result);
});

test("完整请求恰好等于估算预算时原样通过，减少一 token 后缩小来源或本地拒绝", () => {
  const messages = [{ role: "user", content: "原始目标".repeat(700) }, { role: "assistant", content: "尾部证据" }];
  const normal = planContextSummaryRequest({ messages, throughMessage: messages.length });
  const exact = planContextSummaryRequest({ messages, throughMessage: messages.length,
    maxInputTokens: normal.estimatedInputTokens });
  assert.deepEqual(exact.batch, normal.batch);
  assert.deepEqual(exact.request, normal.request);
  assert.equal(exact.estimatedInputTokens, exact.maxInputTokens);
  const smaller = planContextSummaryRequest({ messages, throughMessage: messages.length,
    maxInputTokens: normal.estimatedInputTokens - 1 });
  assert.ok(smaller.estimatedInputTokens < normal.estimatedInputTokens);
  assert.equal(smaller.batch.sourceComplete, false);
  assert.equal(smaller.batch.throughMessage, messages.length);
  assertValidPlan(smaller);
});

for (const [name, fragment] of [["中文", "中文来源"], ["转义", "\"\\\n\t\u0001"], ["Emoji 与孤立代理项", "😀\ud800\udfff"]]) {
  test(`${name} 来源按完整请求估算预算选择，不能仅用源字符数判断`, () => {
    const messages = [{ role: "user", content: `目标首部 ${fragment.repeat(3_500)}` }];
    for (let index = 0; index < 5; index++) messages.push({ role: "assistant", content: fragment.repeat(3_500) });
    messages.push({ role: "assistant", content: "历史尾部：完成离线测试" });
    const result = planContextSummaryRequest({ messages, throughMessage: messages.length, maxInputTokens: 2_500 });

    assertValidPlan(result);
    assert.equal(result.batch.sourceComplete, false);
    assert.equal(result.batch.fromMessage, 0);
    assert.equal(result.batch.throughMessage, messages.length);
    assert.equal(result.input.sourceComplete, false);
    assert.match(result.request.messages[0].content, /目标首部/);
    assert.match(result.request.messages[0].content, /历史尾部/);
    assert.equal(typeof JSON.parse(result.request.messages[0].content).sourceNotice, "string");
  });
}

test("缩小多轮来源保留原历史游标和完整 turn 边界", () => {
  const messages = shortHistory.slice(0, 2);
  for (let index = 0; index < 6; index++) messages.push(
    { role: "user", content: `目标 ${index} ${"文字".repeat(300)}` },
    { role: "assistant", content: `完成 ${index} ${"结果".repeat(250)}` },
  );
  messages.push({ role: "user", content: "不属于此次来源的当前轮" });
  const result = planContextSummaryRequest({ messages, previousSummary, fromMessage: 2,
    throughMessage: messages.length - 1, maxInputTokens: 2_300 });

  assertValidPlan(result);
  assert.equal(result.batch.fromMessage, 2);
  assert.ok(result.batch.throughMessage > 2);
  assert.ok(result.batch.throughMessage < messages.length - 1);
  assert.equal(messages[result.batch.throughMessage].role, "user");
  assert.equal(result.batch.throughMessage % 2, 0);
  assert.equal(result.batch.messages[0].content, messages[2].content);
  assert.doesNotMatch(result.request.messages[0].content, /不属于此次来源/);
});

for (const size of [350, 400, 450, 500, 600, 800, 1_000, 2_000]) {
  test(`省略说明使成本非单调时，仍保留可容纳的 ${size} 字完整首轮`, () => {
    const messages = [{ role: "user", content: "A".repeat(size) },
      { role: "user", content: "B" }, { role: "user", content: "中".repeat(11_000) }];
    const firstBatch = selectContextSummaryBatch(messages, { throughMessage: 1 });
    const maxInputTokens = measureModelRequest(prepareContextSummaryRequest({
      ...firstBatch, previousSummary: null,
    })).estimatedInputTokens;
    const result = planContextSummaryRequest({ messages, throughMessage: 3, maxInputTokens });

    assertValidPlan(result);
    assert.equal(result.batch.throughMessage, 1);
    assert.equal(result.batch.sourceComplete, true);
    assert.deepEqual(result.batch.messages, firstBatch.messages);
    assert.equal("sourceNotice" in JSON.parse(result.request.messages[0].content), false);
  });
}

test("已有摘要计入完整请求但不被预算裁剪，旧不完整标记累计传播", () => {
  const previous = { ...previousSummary, sourceComplete: false, completed: ["已有结果".repeat(100)] };
  const messages = [{ role: "user", content: "旧覆盖" }, { role: "assistant", content: "旧结果" },
    { role: "user", content: "新增目标".repeat(2_000) }, { role: "assistant", content: "新增尾部结果" }];
  const result = planContextSummaryRequest({ messages, previousSummary: previous,
    fromMessage: 2, throughMessage: 4, maxInputTokens: 2_000 });

  assertValidPlan(result);
  assert.deepEqual(result.input.previousSummary, previous);
  const input = JSON.parse(result.request.messages[0].content);
  assert.equal(input.previousSummary.completed[0], previous.completed[0]);
  assert.equal(result.input.sourceComplete, false);
  assert.equal(typeof input.sourceNotice, "string");
});

test("完整来源接续旧不完整摘要时仍附带来源说明并纳入估算", () => {
  const result = planContextSummaryRequest({ messages: shortHistory,
    previousSummary: { ...previousSummary, sourceComplete: false }, fromMessage: 2, throughMessage: 4 });
  assert.equal(result.batch.sourceComplete, true);
  assert.equal(result.input.sourceComplete, false);
  assert.equal(typeof JSON.parse(result.request.messages[0].content).sourceNotice, "string");
  assertValidPlan(result);
});

test("合法最大旧摘要超过预算时抛专用错误，不修改旧摘要或来源", () => {
  const previous = largeSummary();
  const messages = structuredClone(shortHistory);
  const before = structuredClone({ previous, messages });
  assert.throws(() => planContextSummaryRequest({ messages, previousSummary: previous,
    fromMessage: 2, throughMessage: 4, maxInputTokens: 32_000 }), isRequestBudgetError);
  assert.deepEqual({ previous, messages }, before);
});

test("固定提示及非空来源无法容纳时只抛完整请求预算错误", () => {
  assert.throws(() => planContextSummaryRequest({ messages: shortHistory,
    throughMessage: 2, maxInputTokens: 1 }), isRequestBudgetError);
});

test("固定开销已超预算时不读取、脱敏或格式化历史正文", () => {
  const messages = [{ role: "user", get content() { throw new Error("不应访问历史正文"); } }];
  assert.throws(() => planContextSummaryRequest({ messages, previousSummary: largeSummary(),
    throughMessage: 1, maxInputTokens: 32_000 }), isRequestBudgetError);
});

test("缩小预算不会修改原消息、provider opaque 字段或旧摘要", () => {
  const messages = [{ role: "user", content: `安全目标 ${"长来源".repeat(8_000)}` },
    { role: "assistant", content: "完成尾部", provider_items: [{ encrypted_content: "opaque-private" }] }];
  const previous = { objective: "原始事实", completed: ["保留既有结果"] };
  const before = structuredClone({ messages, previous });
  const result = planContextSummaryRequest({ messages, previousSummary: previous, throughMessage: 2, maxInputTokens: 1_500 });
  assertValidPlan(result);
  assert.deepEqual({ messages, previous }, before);
  assert.doesNotMatch(JSON.stringify(result.request), /opaque-private/);
});

test("多次候选选择不会重复读取同一原始正文", () => {
  let reads = 0;
  const messages = [{ role: "user", get content() { reads++; return "摘要来源".repeat(5_000); } },
    { role: "assistant", content: "保留末尾证据" }];
  const result = planContextSummaryRequest({ messages, throughMessage: 2, maxInputTokens: 1_500 });
  assertValidPlan(result);
  assert.equal(reads, 1);
});

test("完整请求预算必须是安全正整数", () => {
  for (const maxInputTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1000"]) {
    assert.throws(() => planContextSummaryRequest({ messages: shortHistory, throughMessage: 2, maxInputTokens }));
  }
});

function assertValidPlan(result) {
  const actual = measureModelRequest(result.request).estimatedInputTokens;
  assert.equal(result.estimatedInputTokens, actual);
  assert.ok(actual <= result.maxInputTokens, `${actual} > ${result.maxInputTokens}`);
  assert.ok(JSON.stringify(JSON.parse(result.request.messages[0].content).newHistory).length <= result.sourceMaxChars);
  assert.ok(result.sourceMaxChars <= 48_000);
  assert.ok(result.batch.messages.length > 0);
  assert.ok(result.batch.throughMessage > result.batch.fromMessage);
  assert.deepEqual(result.request, prepareContextSummaryRequest(result.input));
}

function isRequestBudgetError(error) {
  assert.ok(error instanceof ContextSummaryRequestBudgetError);
  assert.equal(error.code, "context_summary_request_budget");
  return true;
}

function largeSummary() {
  const fields = ["completed", "active", "decisions", "files", "blockers", "nextMoves"];
  return { objective: "中".repeat(1_000), sourceComplete: true, throughMessage: 2,
    ...Object.fromEntries(fields.map((field) => [field, Array.from({ length: 20 }, (_, index) => `${index} ${"文".repeat(497)}`)])) };
}
