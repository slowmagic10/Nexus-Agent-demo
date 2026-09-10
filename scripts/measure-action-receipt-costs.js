// Synthetic in-memory Session commits only. No service, model, tool execution,
// application configuration or existing database is loaded.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AgentSession } from "../src/core/session.js";
import { dispatchSessionAction } from "../src/core/session-action.js";
import { createSession, reduceSession, SESSION_SCHEMA_VERSION } from "../src/core/state.js";

const INPUT = Object.freeze({ id: "synthetic-action-receipt", at: "2026-09-09T00:00:00.000Z",
  historicalAssistantMessages: 120, contentRepeats: 160, commits: 80 });
const baselineCommit = (session, action) => session.dispatch(action);
const requestOptions = { systemPrompt: "合成请求验证", tools: [], maxInputTokens: 4000 };

async function measure() {
  const seed = seedState();
  const actions = createActions();
  let expected = seed;
  const expectedStates = actions.map((action) => (expected = reduceSession(expected, action)));
  const inputHash = hash({ seed, actions });
  const baseline = await countCommits(seed, actions, expectedStates, baselineCommit);
  const current = await countCommits(seed, actions, expectedStates, dispatchSessionAction);
  assert.deepEqual(current.events, baseline.events);
  assert.deepEqual(current.requests, baseline.requests);
  assert.deepEqual(current.finalState, baseline.finalState);
  assert.equal(JSON.stringify(current.events), JSON.stringify(baseline.events));
  assert.equal(baseline.metrics.fullStateCloneCalls, actions.length * 2);
  assert.equal(current.metrics.fullStateCloneCalls, actions.length);
  assert.equal(hash({ seed, actions }), inputHash);
  const timing = await measureTiming(seed, actions, expected, baseline.events);
  return {
    metadata: {
      version: 1, benchmark: "nexus.synthetic-session-action-receipt-costs", syntheticOnly: true,
      nodeVersion: process.version, platform: process.platform, sessionSchemaVersion: SESSION_SCHEMA_VERSION,
      inputsSha256: inputHash,
      boundaries: ["structuredClone calls inside real in-memory Session dispatch completion",
        "JSON UTF-8 representation of clone inputs, summed including repeated inputs",
        "independent wall-clock windows for 80 commits with reducer, patch generation, model projection and one event subscriber"],
      exclusions: ["initialization, input creation, expected reducer states, correctness checks and request preparation excluded",
        "clone instrumentation serializes arguments; only uninstrumented runs are timed"],
      notMeasured: ["heap/RSS or physical allocation", "CPU time", "SQLite or filesystem writes",
        "Provider/tool execution", "full task quality or latency"],
      remainingWork: ["reducer still clones complete state", "full state subscribers still receive independent snapshots",
        "custom dispatch/receipt hooks and old adapters retain their original dispatch path",
        "public dispatch and tool dispatch/onOutput callbacks keep full return values"],
    },
    input: { ...INPUT, historicalMessages: seed.messages.length, initialStateJsonUtf8Bytes: jsonBytes(seed),
      finalStateJsonUtf8Bytes: jsonBytes(expected), eventSubscribers: 1, stateSubscribers: 0,
      actionTypes: [...new Set(actions.map((action) => action.type))], journal: "none; real in-memory AgentSession" },
    commits: {
      baseline: { strategy: "actual session.dispatch(action); caller discards returned state", ...baseline.metrics },
      current: { strategy: "actual dispatchSessionAction on an unmodified AgentSession", ...current.metrics },
      fullStateCloneCallsSaved: baseline.metrics.fullStateCloneCalls - current.metrics.fullStateCloneCalls,
      cloneInputJsonUtf8BytesSaved: baseline.metrics.cloneInputJsonUtf8Bytes - current.metrics.cloneInputJsonUtf8Bytes,
      cloneInputJsonUtf8ReductionPercent: percentSaved(baseline.metrics.cloneInputJsonUtf8Bytes, current.metrics.cloneInputJsonUtf8Bytes),
    },
    commitTiming: timing,
    checks: { allPerCommitStatesEqualReducer: true, eventEnvelopesAndJsonEqual: true,
      allPreparedRequestsIncludingHashAndBudgetEqual: true, resultingStatesEqual: true,
      retainedSnapshotsUnaffected: true, inputUnmodified: true, instrumentationRestored: true,
      cursorSequenceEqual: true, noSpeedThreshold: true },
    checksPassed: true,
  };
}

function seedState() {
  let state = createSession({ id: INPUT.id, provider: "synthetic-offline", workspace: "/synthetic-receipt", createdAt: INPUT.at });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "合成长任务", at: INPUT.at });
  for (let index = 0; index < INPUT.historicalAssistantMessages; index++) {
    state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant",
      content: `合成记录 ${index}：${"普通文本 alpha 0123456789；".repeat(INPUT.contentRepeats)}` }, at: atSecond(index + 1) });
  }
  return state;
}

function createActions() {
  const actions = [];
  for (let round = 0; round < 4; round++) {
    actions.push({ type: "MODEL_REQUESTED" }, { type: "MODEL_STREAM_STARTED" });
    for (let index = 0; index < 14; index++) actions.push({ type: "MODEL_STREAM_DELTA", delta: `合成输出 ${round}/${index}。` });
    actions.push({ type: "MODEL_STREAM_COMPLETED" },
      { type: "MODEL_COMPLETED", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, durationMs: 0, finishReason: "stop" },
      { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: `合成结束 ${round}` } },
      { type: "READY" });
  }
  assert.equal(actions.length, INPUT.commits);
  return actions.map((action, index) => ({ ...action, at: atSecond(500 + index) }));
}

function fixture(seed) {
  const session = new AgentSession({ state: seed, reducer: reduceSession });
  const events = [];
  session.subscribeEvents((event) => events.push(event));
  return { session, events };
}

async function countCommits(seed, actions, expectedStates, commit) {
  const { session, events } = fixture(seed);
  const retained = session.state;
  const requests = [];
  const metrics = { cloneCalls: 0, fullStateCloneCalls: 0, cloneInputJsonUtf8Bytes: 0 };
  const clone = globalThis.structuredClone;
  const observe = (value, ...options) => {
    metrics.cloneCalls++;
    metrics.cloneInputJsonUtf8Bytes += jsonBytes(value);
    if (value?.id === INPUT.id && value.schemaVersion === SESSION_SCHEMA_VERSION
      && Array.isArray(value.messages) && Array.isArray(value.events)) metrics.fullStateCloneCalls++;
    return clone(value, ...options);
  };
  try {
    for (const [index, action] of actions.entries()) {
      globalThis.structuredClone = observe;
      try { await commit(session, action); }
      finally { globalThis.structuredClone = clone; }
      assert.deepEqual(session.state, expectedStates[index]);
      assert.equal(session.cursor, index + 1);
      requests.push(session.prepareModelRequest(requestOptions));
    }
    assert.deepEqual(retained, seed);
    retained.messages.length = 0;
    assert.deepEqual(session.state, expectedStates.at(-1));
    return { metrics, events, requests, finalState: session.state };
  } finally {
    globalThis.structuredClone = clone;
    session.close();
  }
}

async function measureTiming(seed, actions, expected, expectedEvents) {
  async function run(commit) {
    const { session, events } = fixture(seed);
    try {
      const start = performance.now();
      for (const action of actions) await commit(session, action);
      const elapsed = performance.now() - start;
      assert.deepEqual(session.state, expected);
      assert.deepEqual(events, expectedEvents);
      return elapsed;
    } finally { session.close(); }
  }
  for (let index = 0; index < 2; index++) {
    for (const commit of index % 2 ? [dispatchSessionAction, baselineCommit] : [baselineCommit, dispatchSessionAction]) await run(commit);
  }
  const baseline = [], current = [];
  for (let index = 0; index < 10; index++) {
    for (const optimized of index % 2 ? [true, false] : [false, true]) {
      (optimized ? current : baseline).push(await run(optimized ? dispatchSessionAction : baselineCommit));
    }
  }
  return { commitsPerSample: actions.length, warmupsPerStrategy: 2, measurementOrder: "alternating baseline/current first",
    clock: "performance.now", percentileMethod: "nearest rank", instrumentationInsideWindow: false,
    assertionsInsideWindow: false, baseline: summarize(baseline), current: summarize(current),
    limitation: "synthetic in-memory commits with one event subscriber; includes scheduling/GC, excludes real I/O, tools and providers" };
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value) => Number(value.toFixed(4));
  return { samplesMs: samples.map(round), sampleCount: samples.length,
    p50Ms: round(sorted[Math.ceil(samples.length * 0.5) - 1]),
    p95Ms: round(sorted[Math.ceil(samples.length * 0.95) - 1]), maxMs: round(sorted.at(-1)) };
}
function atSecond(second) { return new Date(Date.UTC(2026, 8, 9, 0, 0, second)).toISOString(); }
function jsonBytes(value) { const json = JSON.stringify(value); return json === undefined ? 0 : Buffer.byteLength(json); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function percentSaved(a, b) { return Number(((1 - b / a) * 100).toFixed(4)); }

try {
  process.stdout.write(JSON.stringify(await measure(), null, 2) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? "measurement_assertion_failed" : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
