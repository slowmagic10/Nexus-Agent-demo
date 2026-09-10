// Synthetic source-preparation measurements only. No configuration, model,
// database, tool, subprocess or service is used; no CPU/RSS claims are made.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { prepareSessionContextSummary } from "../src/core/session-summary.js";
import { prepareReferenceSessionSummary } from "../test/support/session-summary-reference.js";

const QUERIES = 20;
const CASES = [
  { name: "local-extractive-120-turns", turns: 120, usesModel: false, maxInputTokens: 32_000 },
  { name: "model-960-turns", turns: 960, usesModel: true, maxInputTokens: 32_000 },
  { name: "model-budget-fit-960-turns", turns: 960, usesModel: true, maxInputTokens: 2_000 },
  { name: "local-budget-rejection-960-turns", turns: 960, usesModel: true, maxInputTokens: 1 },
];

function makeState(turns) {
  const state = createSession({ provider: "synthetic-summary-copy", workspace: "/tmp/synthetic-summary-copy",
    id: "synthetic-summary-copy", createdAt: "2026-09-10T01:00:00.000Z" });
  for (let index = 0; index < turns; index += 1) {
    state.messages.push({ role: "user", content: `历史请求 ${index} ${"旧事实中文ABC".repeat(120)}` },
      { role: "assistant", content: `历史结果 ${index} ${"verified result ".repeat(60)}`,
        provider_items: [{ encrypted_content: "synthetic-opaque-data|".repeat(80) }] });
  }
  state.contextSummary = { summaryVersion: "semantic-summary-v1", revision: 1,
    objective: "继续合成任务", completed: ["已核对较早历史"], active: [], decisions: [], files: [], blockers: [],
    nextMoves: ["核对剩余事项"], sourceComplete: false, throughMessage: (turns - 6) * 2, sourceCursor: 1 };
  state.messages.push({ role: "user", content: "CURRENT_TURN_OUTSIDE_SUMMARY" });
  return state;
}

function capture(prepare, session, options) {
  try { return { status: "prepared", value: prepare(session, options) }; }
  catch (error) {
    if (error.code !== "context_summary_request_budget") throw error;
    return { status: "rejected", code: error.code, message: error.message, sourceCursor: error.sourceCursor,
      maxInputTokens: error.maxInputTokens, estimatedInputTokens: error.estimatedInputTokens };
  }
}

function countClones(run) {
  const native = globalThis.structuredClone;
  const counters = { structuredCloneCalls: 0, messageSnapshotCloneCalls: 0, clonedInputJsonUtf8Bytes: 0 };
  globalThis.structuredClone = (value, ...args) => {
    counters.structuredCloneCalls += 1;
    if (Array.isArray(value?.messages)) counters.messageSnapshotCloneCalls += 1;
    counters.clonedInputJsonUtf8Bytes += Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    return native(value, ...args);
  };
  try { return { counters, output: run() }; }
  finally { globalThis.structuredClone = native; }
}

function measureCase(sample) {
  const state = makeState(sample.turns);
  const originalHash = hash(state);
  const session = new AgentSession({ state, reducer: reduceSession });
  const options = { fromMessage: state.contextSummary.throughMessage, throughMessage: sample.turns * 2,
    usesModel: sample.usesModel, maxInputTokens: sample.maxInputTokens };
  const run = (prepare) => Array.from({ length: QUERIES }, () => hash(capture(prepare, session, options)));
  const baseline = countClones(() => run(prepareReferenceSessionSummary));
  const current = countClones(() => run(prepareSessionContextSummary));
  const selected = capture(prepareSessionContextSummary, session, options);
  assert.deepEqual(current.output, baseline.output);
  assert.equal(hash(state), originalHash);
  assert.equal(hash(session.state), originalHash);
  assert.equal(baseline.counters.messageSnapshotCloneCalls, QUERIES);
  assert.equal(current.counters.messageSnapshotCloneCalls, 0);
  if (selected.status === "prepared") {
    assert.doesNotMatch(JSON.stringify(selected), /synthetic-opaque-data|CURRENT_TURN_OUTSIDE_SUMMARY/);
    const retained = structuredClone(selected);
    selected.value.batch.messages[0].content = "CALLER_MUTATION";
    selected.value.previousSummary.completed.push("CALLER_MUTATION");
    if (selected.value.request) selected.value.request.tools.push({ name: "CALLER_MUTATION" });
    assert.deepEqual(capture(prepareSessionContextSummary, session, options), retained);
  }
  return {
    name: sample.name, historicalTurns: sample.turns, messages: state.messages.length, preparations: QUERIES, options,
    stateJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(state), "utf8"), stateSha256: originalHash,
    baseline: baseline.counters, current: current.counters,
    result: { status: selected.status, resultSha256: current.output[0],
      ...(selected.status === "prepared" ? {
        fromMessage: selected.value.batch.fromMessage, throughMessage: selected.value.batch.throughMessage,
        sourceComplete: selected.value.sourceComplete,
      } : { code: selected.code, sourceCursor: selected.sourceCursor }) },
    checks: { everyResultEqual: true, zeroFullMessageSnapshotCopies: true, originalStateUnchanged: true,
      detachedPreparedResultsOrTypedRejection: true },
  };
}

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

const results = CASES.map(measureCase);
process.stdout.write(JSON.stringify({
  metadata: { version: 1, benchmark: "nexus.synthetic-summary-source-copies", syntheticOnly: true,
    nodeVersion: process.version, platform: process.platform,
    baseline: "frozen stage16 readSessionState(messages,contextSummary) path; both strategies share the unchanged request planner",
    measuredBoundary: "20 synchronous source preparations on an already constructed in-memory AgentSession per case",
    cloneBytesInterpretation: "sum of structuredClone input JSON UTF-8 bytes; a repeated payload proxy, not actual heap copy or RSS",
    notMeasured: ["Session construction and reducer/model-context copies", "Provider/tokenizer/summary quality",
      "database, journal, service or tool execution", "CPU time, heap/RSS, I/O or whole-task latency"],
  }, results, checksPassed: results.every(({ checks }) => Object.values(checks).every(Boolean)),
}, null, 2) + "\n");
