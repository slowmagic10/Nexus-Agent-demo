import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextSummarySourceBudgetError,
  prepareContextSummaryRequest,
  renderContextSummaryMessage,
  selectContextSummaryBatch,
} from "../src/core/context-summary.js";
import {
  prepareContextSummaryRequest as prepareReferenceRequest,
  renderContextSummaryMessage as renderReferenceMessage,
  selectContextSummaryBatch as selectReferenceBatch,
} from "./support/summary-source-reference.js";

const OMISSION_VERSION = "summary-source-excerpt-v1";
const summary = {
  objective: "完成当前实现",
  completed: ["保留原始 Journal"],
  active: [], decisions: [], files: [], blockers: [], nextMoves: ["执行回归验证"],
};

function noticeOf(batch) {
  const notices = batch.messages.filter((message) => message.summary_source_omission === OMISSION_VERSION);
  assert.equal(notices.length, 1, "摘录需要一条显式来源省略记录");
  assert.equal(notices[0].role, "context_source_notice");
  return notices[0];
}

function assertBounded(batch, maxChars) {
  assert.ok(batch.messages.length > 0);
  assert.ok(JSON.stringify(batch.messages).length <= maxChars,
    `实际来源 JSON 长度 ${JSON.stringify(batch.messages).length} 超过预算 ${maxChars}`);
  assert.deepEqual(JSON.parse(JSON.stringify(batch.messages)), batch.messages);
}

test("巨大首 turn 的摘要来源硬上限保留首尾记录及完整推进边界", () => {
  const messages = [
    { role: "user", content: "较早的用户请求" },
    { role: "assistant", content: "较早的回复" },
    { role: "user", content: `FIRST_SOURCE ${"首条信息".repeat(8_000)}` },
    ...Array.from({ length: 9 }, (_, index) => ({
      role: "tool", tool_call_id: `middle-${index}`, content: `MIDDLE_${index} ${"日志".repeat(8_000)}`,
    })),
    { role: "assistant", content: `${"最终状态".repeat(8_000)} LAST_SOURCE` },
    { role: "user", content: "后续 turn 不应被提前消费" },
    { role: "assistant", content: "后续回复" },
  ];
  const original = structuredClone(messages);
  const batch = selectContextSummaryBatch(messages, {
    fromMessage: 2, throughMessage: messages.length, maxChars: 1_400,
  });
  assertBounded(batch, 1_400);
  assert.equal(batch.fromMessage, 2);
  assert.equal(batch.throughMessage, 13);
  assert.equal(batch.sourceComplete, false);
  const notice = noticeOf(batch);
  assert.equal(notice.fromMessage, 2);
  assert.equal(notice.throughMessage, 13);
  assert.ok(notice.omittedFromMessage >= 3);
  assert.ok(notice.omittedThroughMessage <= 12);
  assert.ok(notice.omittedFromMessage <= notice.omittedThroughMessage);
  const sources = batch.messages.filter((message) => message !== notice);
  const retained = [...messages.slice(2, notice.omittedFromMessage), ...messages.slice(notice.omittedThroughMessage, 13)];
  assert.deepEqual(sources.map((message) => message.role), retained.map((message) => message.role));
  assert.deepEqual(sources.map((message) => message.tool_call_id), retained.map((message) => message.tool_call_id));
  assert.match(sources[0].content, /FIRST_SOURCE/);
  assert.match(sources.at(-1).content, /LAST_SOURCE/);
  assert.doesNotMatch(JSON.stringify(batch.messages), /后续 turn/);
  for (let index = notice.omittedFromMessage; index < notice.omittedThroughMessage; index += 1) {
    assert.doesNotMatch(JSON.stringify(batch.messages), new RegExp(`MIDDLE_${index - 3}`));
  }
  assert.deepEqual(messages, original);
});

test("单条巨大来源只保留一个源记录并明确标记省略", () => {
  const messages = [{ role: "user", content: `SINGLE_HEAD ${"内容".repeat(30_000)} SINGLE_TAIL` }];
  const batch = selectContextSummaryBatch(messages, { throughMessage: 1, maxChars: 900 });
  assertBounded(batch, 900);
  const notice = noticeOf(batch);
  const sources = batch.messages.filter((message) => message !== notice);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].role, "user");
  assert.match(sources[0].content, /SINGLE_HEAD/);
  assert.match(sources[0].content, /SINGLE_TAIL/);
  assert.equal(batch.throughMessage, 1);
  assert.equal(batch.sourceComplete, false);
  assert.equal(notice.fromMessage, 0);
  assert.equal(notice.throughMessage, 1);
  assert.ok(notice.omittedFromMessage <= notice.omittedThroughMessage);
});

test("JSON 转义和 Unicode 来源按序列化后长度限制", () => {
  for (const unit of ['"\\\n\t\u0000', "🙂𠮷汉字", "\ud800", "\u2028\u2029"]) {
    for (const maxChars of [512, 768, 1_024, 2_000, 4_096]) {
      const messages = [
        { role: "user", content: `HEAD ${unit.repeat(7_000)}` },
        { role: "assistant", content: `${unit.repeat(7_000)} TAIL` },
      ];
      const batch = selectContextSummaryBatch(messages, { throughMessage: 2, maxChars });
      assertBounded(batch, maxChars);
      assert.equal(batch.sourceComplete, false);
      assert.equal(batch.throughMessage, 2);
      noticeOf(batch);
    }
  }
});

test("巨大 role、tool_call_id 和工具参数都受实际来源 JSON 预算限制", () => {
  const messages = [
    { role: `role-${"r".repeat(40_000)}`, tool_call_id: `id-${"i".repeat(40_000)}`, content: "首条事实" },
    { role: "assistant", content: "中间记录", tool_calls: [{
      id: "call-middle", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "x".repeat(60_000) }) },
    }] },
    { role: "tool", tool_call_id: `tail-${"t".repeat(40_000)}`, content: "最后事实" },
  ];
  const original = structuredClone(messages);
  const batch = selectContextSummaryBatch(messages, { throughMessage: 3, maxChars: 1_200 });
  assertBounded(batch, 1_200);
  assert.equal(batch.sourceComplete, false);
  const notice = noticeOf(batch);
  assert.ok(notice.omittedFromMessage >= 1);
  assert.ok(notice.omittedThroughMessage <= 2);
  assert.ok(notice.omittedFromMessage <= notice.omittedThroughMessage);
  assert.match(JSON.stringify(batch.messages), /首条事实/);
  assert.match(JSON.stringify(batch.messages), /最后事实/);
  assert.deepEqual(messages, original);
});

test("普通首 turn 使用实际来源 JSON 边界而非内部 wrapper 长度", () => {
  const messages = [{ role: "user", content: "可完整容纳的来源" }];
  const maxChars = JSON.stringify(messages).length;
  const batch = selectContextSummaryBatch(messages, { throughMessage: 1, maxChars });
  assertBounded(batch, maxChars);
  assert.deepEqual(batch.messages, messages);
  assert.equal(batch.sourceComplete, true);
  assert.equal(batch.throughMessage, 1);
});

test("普通多 turn 的消息内容和追加边界与冻结旧算法保持一致", () => {
  const messages = Array.from({ length: 12 }, (_, index) => [
    { role: "user", content: `第 ${index} 次请求：读取模块` },
    { role: "assistant", content: `第 ${index} 次结果：模块正常`, tool_calls: index % 3 ? undefined : [{
      id: `call-${index}`, type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' },
    }] },
    { role: "tool", tool_call_id: `call-${index}`, content: "读取内容已保留" },
  ]).flat();
  for (const fromMessage of [0, 3, 12, 27]) {
    for (const maxChars of [700, 1_000, 2_000, 48_000]) {
      const options = { fromMessage, throughMessage: messages.length, maxChars };
      const actual = selectContextSummaryBatch(messages, options);
      assert.deepEqual(actual, selectReferenceBatch(messages, options));
      assertBounded(actual, maxChars);
    }
  }
});

test("原有单字段来源截断仍保留不完整标记而不影响完整 turn 边界", () => {
  const messages = [
    { role: "user", content: "x".repeat(13_000) },
    { role: "assistant", content: "本轮结束" },
  ];
  const options = { throughMessage: 2, maxChars: 48_000 };
  const batch = selectContextSummaryBatch(messages, options);
  assert.deepEqual(batch, selectReferenceBatch(messages, options));
  assert.equal(batch.sourceComplete, false);
  assertBounded(batch, 48_000);
});

test("极小预算抛出可识别错误而不静默返回空来源或超限来源", () => {
  for (const maxChars of [1, 2, 16, 64, 128]) {
    assert.throws(() => selectContextSummaryBatch([
      { role: "user", content: "应明确报告无法容纳来源".repeat(3_000) },
    ], { throughMessage: 1, maxChars }), (error) => {
      assert.ok(error instanceof ContextSummarySourceBudgetError);
      assert.equal(error.code, "context_summary_source_budget");
      return true;
    });
  }
});

test("完整内容先脱敏再裁剪，跨裁剪边界的秘密不残留片段", () => {
  const secret = `BEGIN_PRIVATE_SEGMENT${"Z".repeat(35_000)}END_PRIVATE_SEGMENT`;
  const messages = [{ role: "user", content: `可信事实\nAPI_TOKEN=${secret}\n保留结果` }];
  const batch = selectContextSummaryBatch(messages, { throughMessage: 1, maxChars: 512 });
  assertBounded(batch, 512);
  assert.equal(batch.sourceComplete, true);
  assert.match(batch.messages[0].content, /API_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(batch.messages), /BEGIN_PRIVATE_SEGMENT|END_PRIVATE_SEGMENT|ZZZZZZ/);
  assert.equal(messages[0].content, `可信事实\nAPI_TOKEN=${secret}\n保留结果`);
});

test("巨大来源中的 ID 和结构化工具参数在摘录前完成脱敏", () => {
  const idSecret = `sk-${"IdentitySecret123".repeat(2_000)}`;
  const argumentSecret = `ArgumentSecretStart${"s".repeat(30_000)}ArgumentSecretEnd`;
  const messages = [
    { role: "user", content: `HEAD ${"x".repeat(30_000)}`, tool_call_id: idSecret },
    { role: "assistant", content: "TAIL", tool_calls: [{ id: idSecret, type: "function", function: {
      name: "read_file", arguments: { path: "README.md", api_key: argumentSecret },
    } }] },
  ];
  const batch = selectContextSummaryBatch(messages, { throughMessage: 2, maxChars: 1_200 });
  assertBounded(batch, 1_200);
  const serialized = JSON.stringify(batch.messages);
  assert.doesNotMatch(serialized, /IdentitySecret123|ArgumentSecretStart|ArgumentSecretEnd|ssssssss/);
  assert.match(serialized, /REDACTED/);
});

test("常规来源中的 role 和工具 ID 同样不传播凭据", () => {
  const secret = "sk-SecretIdentity1234567890abcdef";
  const batch = selectContextSummaryBatch([
    { role: `role ${secret}`, tool_call_id: secret, content: "已读取" },
  ], { throughMessage: 1, maxChars: 1_000 });
  assert.doesNotMatch(JSON.stringify(batch.messages), /SecretIdentity1234567890abcdef/);
  assert.match(JSON.stringify(batch.messages), /REDACTED/);
});

test("opaque provider_items 不进入完整或摘录来源", () => {
  for (const maxChars of [700, 48_000]) {
    const batch = selectContextSummaryBatch([
      { role: "user", content: "用户目标", provider_items: [{ encrypted_content: "OPAQUE_USER_PAYLOAD".repeat(2_000) }] },
      { role: "assistant", content: "结果".repeat(7_000), provider_items: [{ encrypted_content: "OPAQUE_ASSISTANT_PAYLOAD".repeat(2_000) }] },
    ], { throughMessage: 2, maxChars });
    assertBounded(batch, maxChars);
    assert.doesNotMatch(JSON.stringify(batch.messages), /provider_items|OPAQUE_/);
  }
});

test("已消费摘录 turn 之后从原始消息游标继续选择完整下一轮", () => {
  const messages = [
    { role: "user", content: "x".repeat(25_000) },
    { role: "tool", content: "中间输出".repeat(5_000) },
    { role: "assistant", content: "第一轮尾部" },
    { role: "user", content: "第二轮请求" },
    { role: "assistant", content: "第二轮完成" },
  ];
  const first = selectContextSummaryBatch(messages, { throughMessage: 5, maxChars: 800 });
  const second = selectContextSummaryBatch(messages, { fromMessage: first.throughMessage, throughMessage: 5, maxChars: 800 });
  assert.equal(first.throughMessage, 3);
  assert.equal(second.fromMessage, 3);
  assert.equal(second.throughMessage, 5);
  assert.equal(second.sourceComplete, true);
  assert.deepEqual(second.messages, messages.slice(3));
});

test("完整摘要请求和渲染保持旧路径的字节内容", () => {
  const controller = new AbortController();
  const messages = [{ role: "user", content: "后续实现" }];
  for (const sourceComplete of [undefined, true]) {
    const previousSummary = { ...summary, sourceComplete };
    const input = { previousSummary, messages, sourceComplete, signal: controller.signal };
    assert.deepEqual(prepareContextSummaryRequest(input), prepareReferenceRequest(input));
    assert.deepEqual(renderContextSummaryMessage(previousSummary), renderReferenceMessage(previousSummary));
    assert.equal(Object.hasOwn(JSON.parse(prepareContextSummaryRequest(input).messages[0].content), "sourceNotice"), false);
  }
});

test("当前、历史及内部省略标记都向摘要 Provider 注入同一固定来源说明", () => {
  const plainMessages = [{ role: "user", content: "当前来源" }];
  const excerpt = selectContextSummaryBatch([
    { role: "user", content: "x".repeat(30_000) },
  ], { throughMessage: 1, maxChars: 700 });
  const inputs = [
    { previousSummary: summary, messages: plainMessages, sourceComplete: false },
    { previousSummary: { ...summary, sourceComplete: false }, messages: plainMessages, sourceComplete: true },
    { previousSummary: summary, messages: excerpt.messages },
  ];
  const notices = inputs.map((input) => {
    const request = prepareContextSummaryRequest(input);
    const payload = JSON.parse(request.messages[0].content);
    assert.equal(typeof payload.sourceNotice, "string");
    assert.ok(payload.sourceNotice.length > 0);
    assert.match(payload.sourceNotice, /省略|不完整/);
    assert.deepEqual(payload.previousSummary, summary);
    return payload.sourceNotice;
  });
  assert.equal(new Set(notices).size, 1);
});

test("不完整摘要渲染明确说明来源省略和证据局限", () => {
  const message = renderContextSummaryMessage({ ...summary, sourceComplete: false });
  assert.equal(message.role, "assistant");
  assert.match(message.content, /省略|不完整/);
  assert.match(message.content, /证据/);
  assert.match(message.content, /不可信事实记录/);
  assert.ok(message.content.includes(JSON.stringify(summary, null, 2)));
  assert.notEqual(message.content, renderReferenceMessage(summary).content);
});

test("巨量小记录只读取有界首尾正文，省略区间和输出顺序一致", () => {
  const count = 10_000;
  const reads = new Uint16Array(count);
  const messages = Array.from({ length: count }, (_, index) => ({
    role: index === 0 ? "user" : "tool",
    tool_call_id: `call-${index}`,
    get content() {
      reads[index] += 1;
      return `record:${index}`;
    },
  }));
  const batch = selectContextSummaryBatch(messages, { throughMessage: count, maxChars: 1_600 });
  assertBounded(batch, 1_600);
  assert.equal(batch.throughMessage, count);
  assert.equal(batch.sourceComplete, false);
  const notice = noticeOf(batch);
  const indexes = [
    ...Array.from({ length: notice.omittedFromMessage }, (_, index) => index),
    ...Array.from({ length: count - notice.omittedThroughMessage }, (_, index) => index + notice.omittedThroughMessage),
  ];
  const sources = batch.messages.filter((message) => message !== notice);
  assert.deepEqual(sources.map((message) => message.tool_call_id), indexes.map((index) => `call-${index}`));
  assert.deepEqual(sources.map((message) => message.content), indexes.map((index) => `record:${index}`));
  assert.equal(batch.messages.indexOf(notice), notice.omittedFromMessage);
  assert.equal(indexes[0], 0);
  assert.equal(indexes.at(-1), count - 1);
  assert.equal(reads.slice(100, count - 100).reduce((sum, value) => sum + value, 0), 0,
    "预算已限制为首尾摘录，不应遍历并脱敏正中间数千条正文");
  assert.ok(reads.reduce((sum, value) => sum + value, 0) < count / 10);
});

test("普通首 turn 达到追加预算后不再读取后续 turn 正文", () => {
  let unselectedReads = 0;
  const messages = [
    { role: "user", content: "A" },
    { role: "user", get content() { unselectedReads += 1; return "后续用户正文"; } },
    { role: "assistant", get content() { unselectedReads += 1; return "后续助手正文"; } },
    { role: "user", get content() { unselectedReads += 1; return "再下一轮正文"; } },
  ];
  const batch = selectContextSummaryBatch(messages, { throughMessage: messages.length, maxChars: 50 });
  assertBounded(batch, 50);
  assert.deepEqual(batch.messages, [{ role: "user", content: "A" }]);
  assert.equal(batch.throughMessage, 1);
  assert.equal(batch.sourceComplete, true);
  assert.equal(unselectedReads, 0);
});

test("候选下一 turn 首条已证实放不下时不读取该 turn 剩余正文", () => {
  let candidateReads = 0;
  let laterReads = 0;
  const messages = [
    { role: "user", content: "第一轮请求" },
    { role: "assistant", content: "第一轮结果" },
    { role: "user", get content() { candidateReads += 1; return "第二轮巨大请求".repeat(500); } },
    { role: "assistant", get content() { laterReads += 1; return "第二轮剩余正文"; } },
    { role: "user", get content() { laterReads += 1; return "第三轮正文"; } },
  ];
  const batch = selectContextSummaryBatch(messages, { throughMessage: messages.length, maxChars: 250 });
  assertBounded(batch, 250);
  assert.deepEqual(batch.messages, messages.slice(0, 2));
  assert.equal(batch.throughMessage, 2);
  assert.equal(batch.sourceComplete, true);
  assert.equal(candidateReads, 1);
  assert.equal(laterReads, 0);
});

test("非字符串 role 与工具 ID 不序列化不可信元数据并标记来源不完整", () => {
  const batch = selectContextSummaryBatch([
    { role: { nested: "UNTRUSTED_ROLE_OBJECT".repeat(2_000) }, content: "仍保留正文事实" },
    { role: "tool", tool_call_id: ["UNTRUSTED_ID_ARRAY".repeat(2_000)], content: "工具结果" },
  ], { throughMessage: 2, maxChars: 500 });
  assertBounded(batch, 500);
  assert.equal(batch.sourceComplete, false);
  assert.deepEqual(batch.messages, [
    { role: "unknown", content: "仍保留正文事实" },
    { role: "tool", content: "工具结果" },
  ]);
  assert.doesNotMatch(JSON.stringify(batch.messages), /UNTRUSTED_/);
});

test("摘录进入 Provider 请求后二次脱敏仍满足实际 newHistory JSON 上限", () => {
  const secret = "sk-Abcdef0123456789SensitiveValue";
  const messages = [
    { role: "user", content: `HEAD ${'password="x" \\ "\n'.repeat(5_000)} ${secret} TAIL` },
    { role: "assistant", tool_call_id: secret, content: 'api_key="y" '.repeat(5_000), tool_calls: [{
      id: secret, type: "function", function: {
        name: "read_file", arguments: JSON.stringify({ path: 'api_key="z" '.repeat(2_000) }),
      },
    }] },
  ];
  for (const maxChars of [700, 1_024, 1_800, 4_000]) {
    const batch = selectContextSummaryBatch(messages, { throughMessage: 2, maxChars });
    assertBounded(batch, maxChars);
    const request = prepareContextSummaryRequest({ messages: batch.messages, sourceComplete: batch.sourceComplete });
    const payload = JSON.parse(request.messages[0].content);
    assert.ok(JSON.stringify(payload.newHistory).length <= maxChars);
    assert.doesNotMatch(JSON.stringify(payload.newHistory), /Abcdef0123456789SensitiveValue/);
    assert.equal(typeof payload.sourceNotice, "string");
  }
});
