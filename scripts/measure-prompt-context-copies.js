// Isolate synchronous request preparation on an already constructed projection.
// No configuration, model, database, subprocess or service is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareModelRequest, projectModelContext } from "../src/core/model-context.js";
import { loadHistorySnapshotReference } from "../test/support/model-history-reference.js";
import { buildSystemPrompt } from "../src/workspace.js";
import { appendAgentInstructions } from "../src/core/named-agent-profiles.js";
import { promptContextFixture } from "../test/support/prompt-context-fixture.js";

// Keep this historical stage 18 measurement reproducible after stage 19 removes
// the extra messages snapshot. The current optimization has its own benchmark.
const { ModelContextProjection } = await loadHistorySnapshotReference();

const PREPARATIONS = 20;
const CASES = [
  { name: "builtin-120-turns", turns: 120, prompt: "builtin" },
  { name: "builtin-profile-960-turns", turns: 960, prompt: "profile" },
  { name: "static-opaque-960-turns", turns: 960, prompt: "static", opaque: true },
  { name: "custom-full-context-960-turns", turns: 960, prompt: "custom" },
];

function countClones(run, messageCount) {
  const native = globalThis.structuredClone;
  const counters = { structuredCloneCalls: 0, fullPromptSnapshotCalls: 0, requestHistoryCloneCalls: 0,
    clonedInputJsonUtf8Bytes: 0 };
  globalThis.structuredClone = (value, ...args) => {
    counters.structuredCloneCalls += 1;
    if (value && !Array.isArray(value) && Array.isArray(value.messages)) counters.fullPromptSnapshotCalls += 1;
    if (Array.isArray(value) && value.length === messageCount) counters.requestHistoryCloneCalls += 1;
    counters.clonedInputJsonUtf8Bytes += Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    return native(value, ...args);
  };
  try { return { counters, output: run() }; }
  finally { globalThis.structuredClone = native; }
}

function measureCase(sample) {
  const { state, tools } = promptContextFixture(sample.turns, sample);
  const originalHash = hash(state);
  const projection = new ModelContextProjection([], state);
  const context = projectModelContext([], state);
  const builtin = buildSystemPrompt("离线合成工作区");
  const systemPrompt = sample.prompt === "profile" ? appendAgentInstructions(builtin, "合成 Profile 要求")
    : sample.prompt === "static" ? "固定提示"
      : sample.prompt === "custom" ? (value) => builtin(value) : builtin;
  const options = { systemPrompt, tools, maxInputTokens: 32_000 };
  const run = (prepare) => Array.from({ length: PREPARATIONS }, () => prepare(options));
  // Public preparation deliberately retains the stage 17 full prompt snapshot;
  // both paths share the unchanged history projection and request planner.
  const baseline = countClones(() => run((args) => prepareModelRequest(context, args)), state.messages.length);
  const current = countClones(() => run((args) => projection.prepareRequest(args)), state.messages.length);
  assert.deepEqual(current.output, baseline.output);
  assert.equal(baseline.counters.fullPromptSnapshotCalls, PREPARATIONS);
  assert.equal(current.counters.fullPromptSnapshotCalls, sample.prompt === "custom" ? PREPARATIONS : 0);
  assert.equal(current.counters.requestHistoryCloneCalls, PREPARATIONS);
  if (sample.prompt === "custom") assert.deepEqual(current.counters, baseline.counters);
  assert.equal(hash(state), originalHash);
  assert.deepEqual(context, projectModelContext([], state));
  const result = current.output[0];
  const resultHash = hash(result);
  result.messages[0].content = "EXTERNAL_MUTATION";
  result.tools[0].function.name = "EXTERNAL_MUTATION";
  result.contextPlan.pinnedMemoryHits[0].scope.workspace = "EXTERNAL_MUTATION";
  assert.equal(hash(projection.prepareRequest(options)), resultHash);
  const plan = current.output[1].contextPlan;
  return { name: sample.name, historicalTurns: sample.turns, messages: state.messages.length,
    preparations: PREPARATIONS, maxInputTokens: options.maxInputTokens,
    contextJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(context), "utf8"), stateSha256: originalHash,
    baseline: baseline.counters, current: current.counters,
    result: { resultSha256: resultHash, contextHash: plan.contextHash, estimatedInputTokens: plan.estimatedInputTokens,
      includedMessages: plan.includedMessages, omittedMessages: plan.omittedMessages },
    checks: { everyFullRequestEqual: true, inputUnchanged: true, detachedResults: true,
      separateRequestHistoryRetained: true, customCallbackKeepsFullContext: sample.prompt === "custom" } };
}

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

process.stdout.write(JSON.stringify({ metadata: { version: 1, benchmark: "nexus.synthetic-prompt-context-copies",
  syntheticOnly: true, nodeVersion: process.version, platform: process.platform,
  baseline: "unchanged public prepareModelRequest full prompt snapshot; shared history projection and request planner",
  measuredBoundary: "20 synchronous main request preparations per already constructed in-memory projection",
  cloneBytesInterpretation: "sum of structuredClone input JSON UTF-8 bytes; repeated payload proxy, not heap allocation or RSS",
  excluded: ["projection construction", "reducer", "journal", "Provider", "CPU time", "task latency", "RSS", "quality"] },
  cases: CASES.map(measureCase) }, null, 2) + "\n");
