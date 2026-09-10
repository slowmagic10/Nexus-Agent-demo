// Pure offline request planning measurements. No model, database, subprocess,
// tool or service is invoked. Stage 15 is frozen in test/support for comparison.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  planContextSummaryRequest,
  prepareContextSummaryRequest,
  summaryContent,
} from "../src/core/context-summary.js";
import {
  selectContextSummaryBatch as selectReferenceBatch,
  prepareContextSummaryRequest as prepareReferenceRequest,
} from "../test/support/summary-request-reference.js";
import { measureModelRequest, TOKEN_ESTIMATOR_VERSION } from "../src/core/model-usage.js";

const MAX_CHARS = 48_000;
const MAX_INPUT_TOKENS = 32_000;
const MARKERS = { head: "SYNTHETIC_FIRST_USER_OBJECTIVE", tail: "SYNTHETIC_FINAL_ASSISTANT_RESULT" };
const FIELDS = ["completed", "active", "decisions", "files", "blockers", "nextMoves"];
const normalPreviousSummary = {
  objective: "继续完成合成离线示例。",
  completed: ["已梳理示例的输入边界。"],
  active: ["对照完整摘要请求的预算。"],
  decisions: ["预算使用项目自己的生产估算器。"],
  files: ["synthetic-example.txt：已核对"],
  blockers: [],
  nextMoves: ["完成离线验证并记录结果。"],
};
const maximalPreviousSummary = {
  objective: "规范字段达到上限的合成旧摘要。".padEnd(1_000, "文"),
  ...Object.fromEntries(FIELDS.map((field) => [field,
    Array.from({ length: 20 }, (_, index) => `${field} ${index}：`.padEnd(500, "文")),
  ])),
};

function toolPair(index, content) {
  return [
    { role: "assistant", content: `合成工具请求 ${index}。`, tool_calls: [{ id: `synthetic-${index}`, type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: `synthetic-${index}.txt` }) } }] },
    { role: "tool", tool_call_id: `synthetic-${index}`, content },
  ];
}

function history(turn) {
  const messages = [
    { role: "user", content: "此前摘要已覆盖的请求。" },
    { role: "assistant", content: "此前摘要已覆盖的回答。" },
    ...turn,
    { role: "user", content: "CURRENT_TURN_OUTSIDE_SUMMARY_SOURCE" },
    { role: "assistant", content: "当前轮也不能进入这次摘要来源。" },
  ];
  return { messages, fromMessage: 2, throughMessage: 2 + turn.length };
}

function makeCases() {
  const ordinary = [
    { role: "user", content: `${MARKERS.head}：请核对普通离线示例。` },
    ...toolPair(0, "普通示例已通过，含有引号\"和反斜杠\\。"),
    { role: "assistant", content: "普通示例已完成。" },
    { role: "user", content: "记录下一步。" },
    { role: "assistant", content: MARKERS.tail },
  ];
  const chinese = [
    { role: "user", content: `${MARKERS.head}：保留中文长历史的首尾事实。` },
    ...Array.from({ length: 12 }, (_, index) => toolPair(index, `合成中文事实 ${index}：${"文".repeat(11_000)}`)).flat(),
    { role: "assistant", content: MARKERS.tail },
  ];
  const escaped = [
    { role: "user", content: `${MARKERS.head}：核对嵌套 JSON 转义与中文。` },
    ...Array.from({ length: 100 }, (_, index) => toolPair(index, `转义事实 ${index}：${'"\\\n中文测试'.repeat(100)}`)).flat(),
    { role: "assistant", content: MARKERS.tail },
  ];
  return [
    { name: "ordinary-complete-history-unchanged", ...history(ordinary), previousSummary: null, unchanged: true },
    { name: "chinese-source-fitted-to-complete-request-budget", ...history(chinese), previousSummary: null, fitted: true },
    { name: "escaped-chinese-source-fitted-to-complete-request-budget", ...history(escaped), previousSummary: null, fitted: true },
    { name: "normal-previous-summary-unchanged", ...history(ordinary), previousSummary: normalPreviousSummary, unchanged: true },
    { name: "maximal-valid-previous-summary-rejected-before-request", ...history(ordinary), previousSummary: maximalPreviousSummary, rejected: true },
  ];
}

function sourceMetrics(batch) {
  const text = JSON.stringify(batch.messages);
  return { jsonCharacters: text.length, jsonUtf8Bytes: Buffer.byteLength(text, "utf8"),
    messages: batch.messages.length, fromMessage: batch.fromMessage, throughMessage: batch.throughMessage,
    sourceComplete: batch.sourceComplete,
    omissionEntries: batch.messages.filter((message) => message.summary_source_omission === "summary-source-excerpt-v1").length,
    sha256: hash(text) };
}

function requestMetrics(request) {
  const text = JSON.stringify(request);
  const payload = JSON.parse(request.messages[0].content);
  return { ...measureModelRequest(request), jsonCharacters: text.length,
    jsonUtf8Bytes: Buffer.byteLength(text, "utf8"), userPayloadCharacters: request.messages[0].content.length,
    sourceNoticePresent: typeof payload.sourceNotice === "string" && payload.sourceNotice.length > 0,
    previousSummaryPresent: payload.previousSummary !== null, sha256: hash(text) };
}

function measureCase(sample) {
  const plannerInput = { messages: sample.messages, previousSummary: sample.previousSummary,
    fromMessage: sample.fromMessage, throughMessage: sample.throughMessage, maxInputTokens: MAX_INPUT_TOKENS };
  const beforeInput = hash(JSON.stringify(plannerInput));
  const baselineBatch = selectReferenceBatch(sample.messages, {
    fromMessage: sample.fromMessage, throughMessage: sample.throughMessage, maxChars: MAX_CHARS,
  });
  const baselineRequest = prepareReferenceRequest({ ...baselineBatch, previousSummary: sample.previousSummary });
  const baseline = { source: sourceMetrics(baselineBatch), request: requestMetrics(baselineRequest),
    requestWithoutNewHistory: requestMetrics(prepareReferenceRequest({ previousSummary: sample.previousSummary, messages: [] })) };
  assert.ok(baseline.source.jsonCharacters <= MAX_CHARS);
  let plan;
  let error;
  try { plan = planContextSummaryRequest(plannerInput); } catch (caught) { error = caught; }
  assert.equal(hash(JSON.stringify(plannerInput)), beforeInput);
  const checks = { originalInputUnmodified: true, stage15SourceAlreadyFits48000Characters: true };
  let current;
  if (sample.rejected) {
    assert.equal(plan, undefined);
    assert.equal(error?.code, "context_summary_request_budget");
    assert.ok(baseline.request.estimatedInputTokens > MAX_INPUT_TOKENS);
    assert.ok(baseline.requestWithoutNewHistory.estimatedInputTokens >= MAX_INPUT_TOKENS);
    current = { admission: "rejected", executableRequestsReturned: 0, errorCode: error.code,
      source: null, request: null, sourceMaxChars: null };
    checks.fixedInputOverBudgetRejectedWithoutExecutableRequest = true;
  } else {
    if (error) throw error;
    assert.equal(plan.maxInputTokens, MAX_INPUT_TOKENS);
    assert.ok(Number.isSafeInteger(plan.sourceMaxChars) && plan.sourceMaxChars > 0 && plan.sourceMaxChars <= MAX_CHARS);
    assert.deepEqual(plan.request, prepareContextSummaryRequest(plan.input));
    assert.deepEqual(plan.input.messages, plan.batch.messages);
    const source = sourceMetrics(plan.batch);
    const request = requestMetrics(plan.request);
    assert.equal(plan.estimatedInputTokens, request.estimatedInputTokens);
    assert.ok(request.estimatedInputTokens <= MAX_INPUT_TOKENS);
    assert.ok(source.jsonCharacters <= plan.sourceMaxChars);
    assert.equal(plan.batch.fromMessage, sample.fromMessage);
    assert.equal(plan.batch.throughMessage, sample.throughMessage);
    assert.ok(!JSON.stringify(plan.batch.messages).includes("CURRENT_TURN_OUTSIDE_SUMMARY_SOURCE"));
    for (const marker of Object.values(MARKERS)) assert.ok(JSON.stringify(plan.batch.messages).includes(marker));
    if (sample.unchanged) {
      assert.deepEqual(plan.batch, baselineBatch);
      assert.deepEqual(plan.request, baselineRequest);
      checks.ordinaryBatchAndCompletePreparedRequestUnchanged = true;
    }
    if (sample.fitted) {
      assert.ok(baseline.request.estimatedInputTokens > MAX_INPUT_TOKENS);
      assert.ok(request.estimatedInputTokens < baseline.request.estimatedInputTokens);
      assert.ok(plan.sourceMaxChars < MAX_CHARS);
      assert.equal(plan.batch.sourceComplete, false);
      assert.equal(plan.input.sourceComplete, false);
      assert.ok(request.sourceNoticePresent);
      checks.oversizedCompleteRequestFittedWithExplicitIncompleteSource = true;
    }
    current = { admission: "accepted", executableRequestsReturned: 1, sourceMaxChars: plan.sourceMaxChars, source, request };
    Object.assign(checks, { completePreparedRequestFitsEstimatedTokenBudget: true,
      sourceFitsBothCharacterBudgets: true, preparedRequestMatchesPlannerInput: true,
      originalCursorCoverageAndHeadTailFactsPreserved: true, currentTurnExcluded: true });
  }
  return { name: sample.name,
    input: { messages: sample.messages.length, requestedFromMessage: sample.fromMessage,
      requestedThroughMessage: sample.throughMessage, maxInputTokens: MAX_INPUT_TOKENS, sourceMaxChars: MAX_CHARS,
      previousSummaryNormalizedCharacters: sample.previousSummary ? JSON.stringify(summaryContent(sample.previousSummary)).length : 0,
      sha256: beforeInput },
    planningInvocations: 1, providerCalls: 0, baseline, current, checks };
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

try {
  assert.deepEqual(summaryContent(normalPreviousSummary), normalPreviousSummary);
  assert.deepEqual(summaryContent(maximalPreviousSummary), maximalPreviousSummary);
  const results = makeCases().map(measureCase);
  const report = {
    metadata: { version: 1, benchmark: "nexus.synthetic-summary-complete-request-budgets", syntheticOnly: true,
      nodeVersion: process.version, platform: process.platform,
      baseline: "frozen stage15 context-summary.js; only its relative redaction import changed",
      baselineFile: "test/support/summary-request-reference.js",
      estimator: TOKEN_ESTIMATOR_VERSION, maxInputTokens: MAX_INPUT_TOKENS, sourceMaxChars: MAX_CHARS,
      sourceBoundary: "JSON.stringify(batch.messages).length, including omission records; JavaScript UTF-16 code units, not bytes or tokens",
      completeRequestBoundary: "actual prepared systemPrompt, messages and tools measured by production measureModelRequest; includes previous summary, notices, JSON envelope and escaping",
      previousSummary: { maximalObjectiveCharacters: 1_000, arrayFields: 6, maximalEntriesPerArray: 20,
        maximalCharactersPerEntry: 500, maximalNormalizedJsonCharacters: JSON.stringify(maximalPreviousSummary).length },
      invocationInterpretation: "one pure planner invocation per case; executableRequestsReturned records whether a bounded request was produced, not a provider call or runtime lifecycle event",
      rejectionInterpretation: "oversized fixed prompt plus previous summary cannot yield a request under this budget; runtime degradation and zero model accounting are verified separately by runtime tests",
      notMeasured: ["real provider tokenizer, model calls or summary quality", "internal planner candidate count, CPU, heap/RSS or latency",
        "database, journal, tools, subprocesses or services", "runtime degradation event or accounting counters"],
      limitation: "token limits use the shared project estimator, not a guarantee about any provider tokenizer; fitted source may omit facts and is explicitly marked incomplete",
    }, results, checksPassed: results.every(({ checks }) => Object.values(checks).every(Boolean)),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? `measurement_assertion_failed: ${error.message}` : `measurement_failed: ${error.message}` }) + "\n");
  process.exitCode = 1;
}
