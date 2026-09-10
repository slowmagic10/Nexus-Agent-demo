// Offline summary-source boundary measurements. No model, database, subprocess,
// tool or service is started. The legacy implementation is frozen in test/support.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  selectContextSummaryBatch,
  prepareContextSummaryRequest,
  summaryContent,
} from "../src/core/context-summary.js";
import {
  selectContextSummaryBatch as selectReferenceBatch,
  prepareContextSummaryRequest as prepareReferenceRequest,
} from "../test/support/summary-source-reference.js";
import { measureModelRequest, TOKEN_ESTIMATOR_VERSION } from "../src/core/model-usage.js";

const MAX_CHARS = 48_000;
const PREFIX = [
  { role: "user", content: "此前已处理的用户请求。" },
  { role: "assistant", content: "此前已处理的回答。" },
];
const NEXT_TURN = [
  { role: "user", content: "NEXT_TURN_OUTSIDE_SELECTED_SOURCE" },
  { role: "assistant", content: "这条后续回答也不应挤入首个超大 turn。" },
];
const MARKERS = {
  head: "SYNTHETIC_FIRST_USER_OBJECTIVE",
  finalTool: "SYNTHETIC_LAST_TOOL_RESULT",
  tail: "SYNTHETIC_FINAL_ASSISTANT_RESULT",
};
const previousSummary = {
  objective: "规范字段达到上限的合成旧摘要。".padEnd(1_000, "文"),
  ...Object.fromEntries(["completed", "active", "decisions", "files", "blockers", "nextMoves"]
    .map((field) => [field, Array.from({ length: 20 }, (_, index) => `${field} ${index}：`.padEnd(500, "文"))])),
};

function makeCase(name, turn, { ordinary = false, calls = 0 } = {}) {
  const messages = [...structuredClone(PREFIX), ...turn, ...(ordinary ? [] : structuredClone(NEXT_TURN))];
  return { name, messages, ordinary, calls,
    options: { fromMessage: PREFIX.length, throughMessage: messages.length, maxChars: MAX_CHARS },
    expectedThroughMessage: PREFIX.length + turn.length };
}

function toolPair(index, content) {
  return [
    { role: "assistant", content: `合成工具请求 ${index}。`, tool_calls: [{ id: `synthetic-${index}`, type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: `synthetic-${index}.txt` }) } }] },
    { role: "tool", tool_call_id: `synthetic-${index}`, content },
  ];
}

function makeCases() {
  const ordinary = makeCase("ordinary-small-batch", [
    { role: "user", content: "请继续整理离线示例。" },
    ...toolPair(0, "示例文件已核对，包含中文、引号\"和反斜杠\\。"),
    { role: "assistant", content: "示例已核对完成。" },
    { role: "user", content: "记录下一步。" },
    { role: "assistant", content: "下一步是完成摘要边界回归。" },
  ], { ordinary: true, calls: 1 });
  const huge = makeCase("first-turn-16-long-tool-calls", [
    { role: "user", content: `${MARKERS.head}：完成当前任务并保留首尾事实。${"合成用户要求。".repeat(160)}` },
    ...Array.from({ length: 16 }, (_, index) => toolPair(index,
      index === 15 ? `${"末次工具事实。".repeat(150)}${MARKERS.finalTool}` : `工具 ${index} 完整合成输出：${"中文工具输出 abc123。".repeat(1_600)}`)).flat(),
    { role: "assistant", content: `${"最终处理结果。".repeat(120)}${MARKERS.tail}` },
  ], { calls: 16 });
  const short = makeCase("first-turn-1200-short-tool-calls", [
    { role: "user", content: `${MARKERS.head}：处理大量短消息。` },
    ...Array.from({ length: 1_200 }, (_, index) => toolPair(index,
      index === 1_199 ? MARKERS.finalTool : `短结果 ${index}：通过。`)).flat(),
    { role: "assistant", content: MARKERS.tail },
  ], { calls: 1_200 });
  const escaping = makeCase("first-turn-quotes-and-backslashes", [
    { role: "user", content: `${MARKERS.head}：处理需要 JSON 转义的文本。` },
    ...Array.from({ length: 12 }, (_, index) => toolPair(index,
      index === 11 ? MARKERS.finalTool : `合成转义文本 ${index}：${'"\\\n'.repeat(3_000)}`)).flat(),
    { role: "assistant", content: MARKERS.tail },
  ], { calls: 12 });
  return [ordinary, huge, short, escaping];
}

function sourceMetrics(batch) {
  const text = JSON.stringify(batch.messages);
  return { jsonCharacters: text.length, jsonUtf8Bytes: Buffer.byteLength(text, "utf8"),
    messages: batch.messages.length, fromMessage: batch.fromMessage,
    throughMessage: batch.throughMessage, sourceComplete: batch.sourceComplete,
    omissionEntries: batch.messages.filter((message) => message.role === "context_source_notice"
      && message.summary_source_omission === "summary-source-excerpt-v1").length,
    sha256: hash(text) };
}

function requestMetrics(prepare, batch, summary) {
  const request = prepare({ ...batch, previousSummary: summary });
  const text = JSON.stringify(request);
  const payload = JSON.parse(request.messages[0].content);
  return { sourceNoticePresent: typeof payload.sourceNotice === "string" && payload.sourceNotice.length > 0,
    jsonCharacters: text.length, jsonUtf8Bytes: Buffer.byteLength(text, "utf8"),
    userPayloadCharacters: request.messages[0].content.length,
    userPayloadUtf8Bytes: Buffer.byteLength(request.messages[0].content, "utf8"),
    ...measureModelRequest(request), sha256: hash(text) };
}

function measureCase(sample) {
  const beforeInput = hash(JSON.stringify({ messages: sample.messages, options: sample.options, previousSummary }));
  const baseline = selectReferenceBatch(sample.messages, sample.options);
  const current = selectContextSummaryBatch(sample.messages, sample.options);
  const baselineSource = sourceMetrics(baseline);
  const currentSource = sourceMetrics(current);
  const selected = JSON.stringify(current.messages);
  assert.equal(current.fromMessage, sample.options.fromMessage);
  assert.equal(current.throughMessage, sample.expectedThroughMessage);
  assert.ok(currentSource.jsonCharacters <= MAX_CHARS);
  assert.equal(hash(JSON.stringify({ messages: sample.messages, options: sample.options, previousSummary })), beforeInput);
  if (sample.ordinary) {
    assert.deepEqual(current, baseline);
    for (const summary of [null, previousSummary]) {
      assert.deepEqual(prepareContextSummaryRequest({ ...current, previousSummary: summary }),
        prepareReferenceRequest({ ...baseline, previousSummary: summary }));
    }
  } else {
    assert.ok(baselineSource.jsonCharacters > MAX_CHARS);
    assert.equal(current.sourceComplete, false);
    for (const marker of Object.values(MARKERS)) assert.ok(selected.includes(marker), `missing marker in ${sample.name}: ${marker}`);
    assert.ok(!selected.includes(NEXT_TURN[0].content));
    const omission = current.messages.find((message) => message.role === "context_source_notice"
      && message.summary_source_omission === "summary-source-excerpt-v1" && /省略/.test(String(message.content)));
    assert.ok(omission, `missing explicit omission entry in ${sample.name}`);
    assert.equal(omission.fromMessage, current.fromMessage);
    assert.equal(omission.throughMessage, current.throughMessage);
    assert.ok(omission.omittedFromMessage > current.fromMessage);
    assert.ok(omission.omittedThroughMessage < current.throughMessage);
    assert.ok(omission.omittedThroughMessage > omission.omittedFromMessage);
    assert.equal(current.messages.length, current.throughMessage - current.fromMessage
      - (omission.omittedThroughMessage - omission.omittedFromMessage) + 1);
  }
  const baselineRequest = {
    withoutPreviousSummary: requestMetrics(prepareReferenceRequest, baseline, null),
    withMaximalNormalizedPreviousSummary: requestMetrics(prepareReferenceRequest, baseline, previousSummary),
  };
  const currentRequest = {
    withoutPreviousSummary: requestMetrics(prepareContextSummaryRequest, current, null),
    withMaximalNormalizedPreviousSummary: requestMetrics(prepareContextSummaryRequest, current, previousSummary),
  };
  if (!sample.ordinary) {
    assert.ok(currentRequest.withoutPreviousSummary.sourceNoticePresent);
    assert.ok(currentRequest.withMaximalNormalizedPreviousSummary.sourceNoticePresent);
  }
  const summaryOverhead = {
    completeRequestJsonCharacters: currentRequest.withMaximalNormalizedPreviousSummary.jsonCharacters - currentRequest.withoutPreviousSummary.jsonCharacters,
    completeRequestJsonUtf8Bytes: currentRequest.withMaximalNormalizedPreviousSummary.jsonUtf8Bytes - currentRequest.withoutPreviousSummary.jsonUtf8Bytes,
    estimatedInputTokens: currentRequest.withMaximalNormalizedPreviousSummary.estimatedInputTokens - currentRequest.withoutPreviousSummary.estimatedInputTokens,
  };
  assert.ok(summaryOverhead.completeRequestJsonCharacters > MAX_CHARS);
  assert.equal(hash(JSON.stringify({ messages: sample.messages, options: sample.options, previousSummary })), beforeInput);
  return {
    name: sample.name,
    input: { messages: sample.messages.length, toolCalls: sample.calls, maxChars: MAX_CHARS,
      requestedFromMessage: sample.options.fromMessage, requestedThroughMessage: sample.options.throughMessage,
      firstSelectedTurnThroughMessage: sample.ordinary ? null : sample.expectedThroughMessage,
      sha256: beforeInput },
    source: { baseline: baselineSource, current: currentSource },
    completeSummaryRequest: { baseline: baselineRequest, current: currentRequest },
    maximalPreviousSummaryIncrement: summaryOverhead,
    checks: { sourceFitsCharacterLimit: true, originalTurnCursorBoundaryPreserved: true,
      ordinaryBatchAndRequestsDeepEqualOrOversizedSourceMarkedIncomplete: true,
      omissionGapMatchesOriginalMessageCoverage: true,
      ordinaryBatchOrOversizedHeadTailAndOmissionNoticeRetained: true,
      nextTurnExcludedWhenFirstTurnOverflows: true, inputUnmodified: true,
      completeRequestMeasuredIncludingPromptAndSourceNotice: true,
      previousSummaryMeasuredOutsideSourceBudget: true },
  };
}

function hash(text) { return createHash("sha256").update(text).digest("hex"); }

try {
  assert.deepEqual(summaryContent(previousSummary), previousSummary);
  const results = makeCases().map(measureCase);
  const report = {
    metadata: { version: 1, benchmark: "nexus.synthetic-summary-source-bounds", syntheticOnly: true,
      nodeVersion: process.version, platform: process.platform, maxChars: MAX_CHARS,
      baseline: "frozen pre-bound context-summary.js with only the relative redaction import adjusted",
      estimator: TOKEN_ESTIMATOR_VERSION,
      sourceBoundary: "JSON.stringify(selected.messages).length, including source omission entries; JavaScript UTF-16 code units, not bytes or tokens",
      completeRequestBoundary: "actual prepareContextSummaryRequest output measured using the production measureModelRequest estimator",
      previousSummary: { objectiveCharacters: 1_000, arrayFields: 6, entriesPerArray: 20, charactersPerEntry: 500,
        normalizedJsonCharacters: JSON.stringify(previousSummary).length,
        normalizedJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(previousSummary), "utf8"),
        budget: "outside the selected source character budget; still included in the complete prepared request and its token estimate" },
      interpretation: "the bound limits selected summary source, not the complete model request; previous summary, prompt, additional source notice, JSON envelope and escaping add input",
      notMeasured: ["real provider tokenizer, model calls or summary quality", "CPU time, heap/RSS or end-to-end latency",
        "database, journal, tools, subprocesses or services", "a universal complete-request or token upper bound of 48000"],
      limitation: "oversized first turns intentionally produce incomplete source excerpts while keeping original cursor coverage; ordinary complete batches are compared exactly",
    }, results, checksPassed: results.every(({ checks }) => Object.values(checks).every(Boolean)),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? `measurement_assertion_failed: ${error.message}` : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
