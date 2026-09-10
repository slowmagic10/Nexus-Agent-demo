// Synchronous main-request preparation only. No configuration, database,
// Provider, subprocess or service is used. Sizes are clone-input JSON proxies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ModelContextProjection } from "../src/core/model-context.js";
import { buildSystemPrompt } from "../src/workspace.js";
import { appendAgentInstructions } from "../src/core/named-agent-profiles.js";
import { promptContextFixture } from "../test/support/prompt-context-fixture.js";
import { loadHistorySnapshotReference } from "../test/support/model-history-reference.js";

const previous = await loadHistorySnapshotReference();
const PREPARATIONS = 20;
const CASES = [
  { name: "builtin-tools-120-turns", turns: 120 },
  { name: "builtin-profile-tools-960-turns", turns: 960, profile: true },
  { name: "builtin-opaque-960-turns", turns: 960, opaque: true },
  { name: "custom-tools-960-turns", turns: 960, custom: true },
  { name: "ordinary-conversation-960-turns", turns: 960, conversation: true },
  { name: "date-compatibility-120-turns", turns: 120, special: true },
];

function countClones(run, messageCount) {
  const native = globalThis.structuredClone;
  const counters = { structuredCloneCalls: 0, initialHistorySnapshotCalls: 0, fullPromptSnapshotCalls: 0,
    clonedInputJsonUtf8Bytes: 0 };
  globalThis.structuredClone = (value, ...args) => {
    counters.structuredCloneCalls++;
    if (Array.isArray(value) && value.length === messageCount) counters.initialHistorySnapshotCalls++;
    if (value && !Array.isArray(value) && Array.isArray(value.messages)) counters.fullPromptSnapshotCalls++;
    counters.clonedInputJsonUtf8Bytes += Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    return native(value, ...args);
  };
  try { return { counters, output: run() }; }
  finally { globalThis.structuredClone = native; }
}

function measureCase(sample) {
  const { state, tools } = promptContextFixture(sample.turns, sample);
  if (sample.conversation) state.messages = state.messages.filter((message) => !message.tool_calls && message.role !== "tool");
  if (sample.special) state.messages[0].stamp = new Date("2026-09-10T00:00:00Z");
  const original = structuredClone(state);
  const prior = new previous.ModelContextProjection([], state);
  const current = new ModelContextProjection([], state);
  const builtin = buildSystemPrompt("离线合成工作区");
  const systemPrompt = sample.profile ? appendAgentInstructions(builtin, "合成 Profile 要求")
    : sample.custom ? (context) => builtin(context) : builtin;
  const options = { systemPrompt, tools, maxInputTokens: 32_000 };
  const run = (projection) => Array.from({ length: PREPARATIONS }, () => projection.prepareRequest(options));
  const before = countClones(() => run(prior), state.messages.length);
  const after = countClones(() => run(current), state.messages.length);
  assert.deepEqual(after.output, before.output);
  assert.equal(before.counters.initialHistorySnapshotCalls, PREPARATIONS);
  assert.equal(after.counters.initialHistorySnapshotCalls, sample.special ? PREPARATIONS : 0);
  assert.equal(after.counters.fullPromptSnapshotCalls, sample.custom ? PREPARATIONS : 0);
  if (sample.special) assert.deepEqual(after.counters, before.counters);
  assert.deepEqual(state, original);
  const result = after.output[0];
  const resultHash = hash(result);
  const plan = result.contextPlan;
  for (const message of result.messages) {
    if (message.tool_calls) message.tool_calls[0].function.arguments = "EXTERNAL_MUTATION";
    if (message.provider_items) message.provider_items[0].encrypted_content = "EXTERNAL_MUTATION";
    message.content = "EXTERNAL_MUTATION";
  }
  result.messages.length = 0;
  assert.equal(hash(current.prepareRequest(options)), resultHash);
  return { name: sample.name, historicalTurns: sample.turns, messages: state.messages.length,
    preparations: PREPARATIONS, maxInputTokens: options.maxInputTokens, stateSha256: hash(original),
    baseline: before.counters, current: after.counters,
    result: { resultSha256: resultHash, contextHash: plan.contextHash, estimatedInputTokens: plan.estimatedInputTokens,
      includedMessages: plan.includedMessages, omittedMessages: plan.omittedMessages },
    checks: { everyFullRequestEqual: true, sourceUnchanged: true, detachedResults: true,
      usesCompatibilitySnapshot: Boolean(sample.special) } };
}

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

process.stdout.write(JSON.stringify({ metadata: { version: 1, benchmark: "nexus.synthetic-model-history-copies",
  syntheticOnly: true, nodeVersion: process.version, platform: process.platform,
  baseline: "frozen stage 18 initial messages structuredClone; same prompt projection and history/window planner",
  measuredBoundary: "20 synchronous main request preparations per already constructed in-memory projection",
  cloneBytesInterpretation: "sum of structuredClone input JSON UTF-8 bytes; not actual allocation, copying or RSS",
  excluded: ["projection construction", "reducer", "journal", "Provider", "CPU time", "task latency", "RSS", "quality"] },
  cases: CASES.map(measureCase) }, null, 2) + "\n");
