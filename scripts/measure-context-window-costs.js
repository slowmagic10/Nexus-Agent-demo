// Offline request-planning measurements. No Session database, model, tools or
// services are started. The frozen selector shares unchanged request shaping.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareModelRequest } from "../src/core/model-context.js";
import { loadLegacyWindowReference } from "../test/support/context-window-reference.js";

const legacy = await loadLegacyWindowReference();
const definitions = [{ type: "function", function: { name: "read_file", description: "合成工具说明".repeat(30),
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];

function makeCase(name, turns, { summary = false, largeCurrent = false } = {}) {
  const messages = Array.from({ length: turns }, (_, index) => [
    { role: "user", content: `合成问题 ${index}：${"中文说明 abc123。".repeat(12)}` },
    { role: "assistant", content: `合成回答 ${index}：${"已记录当前结果。".repeat(12)}` },
  ]).flat();
  if (largeCurrent) messages.push({ role: "user", content: "当前任务".repeat(6000) });
  const input = { messages, memory: [], contextMemory: [], loadedSkills: [], objective: null, plan: null, delegations: [],
    contextSummary: summary ? { objective: "完成当前任务", completed: ["历史记录已核对"], active: ["继续处理"],
      decisions: [], files: [], blockers: [], nextMoves: [], revision: 1, throughMessage: (turns - 1) * 2,
      sourceCursor: 2000, sourceComplete: true } : null };
  const fullOptions = { systemPrompt: "固定合成任务指令", tools: definitions, maxInputTokens: 10_000_000 };
  const full = legacy.prepareModelRequest(input, fullOptions);
  const options = { ...fullOptions, maxInputTokens: largeCurrent ? 1000 : Math.floor(full.contextPlan.estimatedInputTokens * 0.6) };
  return { name, input, options, turns: turns + (largeCurrent ? 1 : 0), summary, largeCurrent };
}

async function measure() {
  const cases = [makeCase("history-240-turns", 240), makeCase("history-480-turns", 480),
    makeCase("history-960-turns", 960), makeCase("summary-480-turns", 480, { summary: true }),
    makeCase("latest-turn-over-target", 480, { largeCurrent: true })];
  const results = cases.map(measureCase);
  return {
    metadata: { version: 1, benchmark: "nexus.synthetic-context-window-planning-costs", syntheticOnly: true,
      nodeVersion: process.version, platform: process.platform,
      baseline: "frozen original selectCompactedTurns; unchanged request shaping shared with production, index construction disabled",
      boundaries: ["TextEncoder.encode calls and returned UTF-8 bytes during complete prepareModelRequest",
        "separate wall-clock windows around complete request preparation without encoding instrumentation"],
      exclusions: ["input construction, baseline selection for target size, output comparisons, hashes and formatting excluded",
        "instrumented runs never used for timing"],
      notMeasured: ["provider tokenizer or generation", "task quality or end-to-end latency", "Session reducer/dispatch or persistence", "peak heap/RSS"],
      interpretation: "encoding bytes are repeated estimator work, not memory savings; timing includes request cloning, tool projection, budget selection and final hashing",
      remainingWork: ["full history still projected and measured once", "message snapshots and final request hashing remain",
        "nonstandard values or probe overflow use the legacy selector", "no active-turn segmentation or Provider contract change"],
    },
    results,
    checksPassed: results.every((result) => Object.values(result.checks).every(Boolean)),
  };
}

function measureCase(sample) {
  const inputHash = hash({ input: sample.input, options: sample.options });
  const before = countEncodings(() => legacy.prepareModelRequest(sample.input, sample.options));
  const after = countEncodings(() => prepareModelRequest(sample.input, sample.options));
  assert.deepEqual(after.request, before.request);
  assert.equal(hash({ input: sample.input, options: sample.options }), inputHash);
  const timing = measureTiming(sample, before.request);
  return {
    name: sample.name,
    input: { turns: sample.turns, messages: sample.input.messages.length, summary: sample.summary,
      latestTurnOverTarget: sample.largeCurrent, maxInputTokens: sample.options.maxInputTokens, inputSha256: inputHash },
    request: { selectedMessages: after.request.messages.length, omittedTurns: after.request.contextPlan.omittedTurns,
      estimatedInputTokens: after.request.contextPlan.estimatedInputTokens, summaryIncluded: after.request.contextPlan.summary.included,
      estimatedOverTarget: after.request.contextPlan.estimatedOverTarget, contextHash: after.request.contextPlan.contextHash },
    encoding: { baseline: before.metrics, current: after.metrics,
      encodedUtf8ReductionPercent: percentSaved(before.metrics.encodedUtf8Bytes, after.metrics.encodedUtf8Bytes) },
    preparationTiming: timing,
    checks: { fullRequestsDeepEqual: true, contextHashAndBudgetEqual: true, inputUnmodified: true,
      everyTimedRequestChecked: true, encodingInstrumentationRestored: true, noSpeedThreshold: true },
  };
}

function countEncodings(operation) {
  const encode = TextEncoder.prototype.encode;
  const metrics = { encodeCalls: 0, encodedUtf8Bytes: 0 };
  TextEncoder.prototype.encode = function (...args) {
    const value = Reflect.apply(encode, this, args);
    metrics.encodeCalls++;
    metrics.encodedUtf8Bytes += value.length;
    return value;
  };
  try { return { request: operation(), metrics }; }
  finally { TextEncoder.prototype.encode = encode; }
}

function measureTiming(sample, expected) {
  function run(prepare) {
    const start = performance.now();
    const request = prepare(sample.input, sample.options);
    const elapsed = performance.now() - start;
    assert.deepEqual(request, expected);
    return elapsed;
  }
  for (let index = 0; index < 2; index++) {
    for (const prepare of index % 2 ? [prepareModelRequest, legacy.prepareModelRequest] : [legacy.prepareModelRequest, prepareModelRequest]) run(prepare);
  }
  const baseline = [], current = [];
  for (let index = 0; index < 10; index++) {
    for (const optimized of index % 2 ? [true, false] : [false, true]) {
      (optimized ? current : baseline).push(run(optimized ? prepareModelRequest : legacy.prepareModelRequest));
    }
  }
  return { sampleCountPerStrategy: 10, warmupsPerStrategy: 2, clock: "performance.now", percentileMethod: "nearest rank",
    measurementOrder: "alternating baseline/current first", instrumentationInsideWindow: false,
    assertionsInsideWindow: false, baseline: summarize(baseline), current: summarize(current),
    limitation: "synthetic request preparation wall time; includes GC/scheduling effects and is not real-model task performance" };
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value) => Number(value.toFixed(4));
  return { samplesMs: samples.map(round), p50Ms: round(sorted[Math.ceil(samples.length * 0.5) - 1]),
    p95Ms: round(sorted[Math.ceil(samples.length * 0.95) - 1]), maxMs: round(sorted.at(-1)) };
}
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function percentSaved(a, b) { return Number(((1 - b / a) * 100).toFixed(4)); }

try { process.stdout.write(JSON.stringify(await measure(), null, 2) + "\n"); }
catch (error) {
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? "measurement_assertion_failed" : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
