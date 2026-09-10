// Offline synthetic Session state-read measurements. No configuration, existing
// database, service, filesystem tool, or model provider is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession, SESSION_SCHEMA_VERSION } from "../src/core/state.js";

const INPUT = Object.freeze({ sessionId: "synthetic-state-view-cost", createdAt: "2026-09-09T00:00:00.000Z",
  historicalAssistantMessages: 120, historicalContentRepeat: 160, queryGroups: 100 });
const QUERIES = Object.freeze([
  Object.freeze(["phase"]), Object.freeze(["metrics"]), Object.freeze(["plan"]),
  Object.freeze(["permissionProfile", "toolGrants"]), Object.freeze(["modelStream"]),
]);

async function measure() {
  const seed = seedState();
  const session = new AgentSession({ state: seed, reducer: reduceSession });
  assert.equal(typeof session.readState, "function");
  const clone = globalThis.structuredClone;
  const initialStateHash = hash(seed);

  // Exercise the real commit boundary before every counter/clock is installed.
  // Old values must survive both subsequent commits and caller-side mutation.
  const continuity = await verifyContinuity(session);
  assert.equal(hash(seed), initialStateHash);
  const expectedState = session.state;
  const expectedReads = QUERIES.map((fields) => selectFields(expectedState, fields));
  const finalStateHash = hash(expectedState);

  const baseline = countClones(() => runQueries(session, baselineReadState));
  assert.equal(globalThis.structuredClone, clone);
  verifyQueryResults(session, baseline.results, expectedReads, expectedState);
  const current = countClones(() => runQueries(session, currentReadState));
  assert.equal(globalThis.structuredClone, clone);
  verifyQueryResults(session, current.results, expectedReads, expectedState);
  const timing = measureTiming(session, expectedReads, expectedState);
  assert.equal(globalThis.structuredClone, clone);
  assert.equal(hash(session.state), finalStateHash);
  session.close();

  return {
    metadata: {
      version: 1, benchmark: "nexus.synthetic-session-state-read-costs", syntheticOnly: true,
      nodeVersion: process.version, platform: process.platform, sessionSchemaVersion: SESSION_SCHEMA_VERSION,
      inputsSha256: hash({ input: INPUT, queries: QUERIES, initialStateHash, finalStateHash }),
      boundaries: ["structuredClone calls strictly inside 500 Session state queries",
        "UTF-8 size of JSON representations of observed structuredClone inputs, summed including repeated inputs",
        "independent performance.now windows around the same 500 Session state queries with clone instrumentation disabled"],
      exclusions: ["Session creation, reducer calls, real in-memory dispatches, and expected results excluded",
        "result assertions, caller mutations, state-isolation checks, hashing, and output formatting excluded",
        "JSON serialization is measurement instrumentation only and is never used in timing windows"],
      interpretation: "JSON input bytes approximate repeatedly visited snapshot payload; they are not actual cloned heap bytes, allocation counts, RSS, or an end-to-end speedup",
      notMeasured: ["RSS or heap peak", "V8 allocation or CPU time", "SQLite writes or disk I/O",
        "full Runtime or Session dispatch latency", "real-model task quality"],
      remainingWork: ["public state getter still returns a complete detached snapshot",
        "a selected large field still incurs a large clone", "reducer and full state subscribers still clone complete state",
        "results describe the selected query mix, not the distribution of queries in real tasks"],
    },
    input: { ...INPUT, queryFields: QUERIES, queriesPerGroup: QUERIES.length,
      totalQueriesPerWindow: INPUT.queryGroups * QUERIES.length, historicalMessages: seed.messages.length,
      historicalEvents: seed.events.length, finalMessages: expectedState.messages.length,
      finalEvents: expectedState.events.length, initialStateJsonUtf8Bytes: jsonBytes(seed),
      finalStateJsonUtf8Bytes: jsonBytes(expectedState), continuityDispatches: continuity.dispatches,
      journal: "none; real AgentSession with in-memory commits" },
    stateReads: {
      baseline: { strategy: "frozen original session.state getter followed by selection; selected values are already detached", ...baseline.metrics },
      current: { strategy: "actual AgentSession.readState(fields)", ...current.metrics },
      fullStateClonesSaved: baseline.metrics.fullStateClones - current.metrics.fullStateClones,
      cloneInputJsonUtf8BytesSaved: baseline.metrics.cloneInputJsonUtf8Bytes - current.metrics.cloneInputJsonUtf8Bytes,
      cloneInputJsonUtf8ReductionPercent: percentSaved(baseline.metrics.cloneInputJsonUtf8Bytes, current.metrics.cloneInputJsonUtf8Bytes),
    },
    stateReadTiming: timing,
    checks: { allPerQueryResultsEqualCompleteSnapshotSelection: true,
      callerMutationOfEveryMeasuredResultLeavesSessionUnchanged: true,
      detachedSnapshotsRemainUnchangedAcrossRealDispatches: true,
      readsReflectLatestPhaseMetricsPlanPermissionAndModelStream: true,
      inputSeedRemainsUnmodified: true, noStateMutationDuringMeasurement: true,
      structuredCloneInstrumentationRestoredAfterEachWindow: true, noSpeedThreshold: true },
    checksPassed: true,
  };
}

// Frozen baseline: before readState existed, each internal read first obtained
// the complete detached public state. Do not call the new API from this oracle.
function baselineReadState(session, fields) {
  const state = session.state;
  return selectFields(state, fields);
}
function currentReadState(session, fields) { return session.readState(fields); }
function selectFields(state, fields) {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(state, field)).map((field) => [field, state[field]]));
}

function seedState() {
  let state = createSession({ id: INPUT.sessionId, provider: "synthetic-offline", workspace: "/synthetic-state-view",
    createdAt: INPUT.createdAt });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "合成历史任务", at: INPUT.createdAt });
  for (let index = 0; index < INPUT.historicalAssistantMessages; index += 1) {
    state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant",
      content: `合成历史 ${index}：${"普通历史内容 alpha 0123456789；".repeat(INPUT.historicalContentRepeat)}` }, at: atSecond(index + 1) });
  }
  state = reduceSession(state, { type: "PLAN_UPDATED", steps: [{ step: "合成步骤", status: "pending" }], at: atSecond(200) });
  state = reduceSession(state, { type: "READY", at: atSecond(201) });
  return state;
}

async function verifyContinuity(session) {
  const allFields = QUERIES.flat();
  const oldBaseline = baselineReadState(session, allFields);
  const oldCurrent = currentReadState(session, allFields);
  assert.deepEqual(oldCurrent, oldBaseline);
  const preservedSnapshot = structuredClone(oldCurrent);
  const batches = [
    [{ type: "MODEL_REQUESTED" }, { type: "MODEL_STREAM_STARTED" },
      { type: "MODEL_STREAM_DELTA", delta: "合成模型增量。" },
      { type: "PLAN_UPDATED", steps: [{ step: "合成步骤", status: "in_progress" }] },
      { type: "PERMISSION_PROFILE_DOWNGRADED", profile: "read-only" }],
    [{ type: "MODEL_STREAM_COMPLETED" }, { type: "READY" },
      { type: "PLAN_UPDATED", steps: [{ step: "合成步骤", status: "completed" }] },
      { type: "PERMISSION_PROFILE_CHANGED", profile: "workspace-auto" }],
  ];
  let dispatches = 0;
  let previous = oldCurrent;
  for (const batch of batches) {
    for (const action of batch) {
      await session.dispatchWithReceipt({ ...action, at: atSecond(300 + dispatches) }, { includeState: false });
      dispatches += 1;
    }
    const state = session.state;
    const baseline = baselineReadState(session, allFields);
    const current = currentReadState(session, allFields);
    assert.deepEqual(current, baseline);
    assert.deepEqual(current, selectFields(state, allFields));
    assert.notDeepEqual(current, previous);
    assert.deepEqual(oldCurrent, preservedSnapshot);
    assert.deepEqual(oldBaseline, preservedSnapshot);
    mutateSnapshot(current);
    mutateSnapshot(baseline);
    assert.deepEqual(session.state, state);
    previous = selectFields(state, allFields);
  }
  assert.equal(session.readState(["metrics"]).metrics.modelCalls, 1);
  assert.equal(session.readState(["phase"]).phase, "idle");
  assert.equal(session.readState(["plan"]).plan.steps[0].status, "completed");
  assert.equal(session.readState(["permissionProfile"]).permissionProfile, "workspace-auto");
  assert.equal(session.readState(["modelStream"]).modelStream.status, "completed");
  assert.deepEqual(oldCurrent, preservedSnapshot);
  assert.deepEqual(oldBaseline, preservedSnapshot);
  return { dispatches };
}

function runQueries(session, implementation) {
  const results = [];
  for (let group = 0; group < INPUT.queryGroups; group += 1) {
    for (const fields of QUERIES) results.push(implementation(session, fields));
  }
  return results;
}

function countClones(operation) {
  const clone = globalThis.structuredClone;
  const metrics = { structuredCloneCalls: 0, fullStateClones: 0, cloneInputJsonUtf8Bytes: 0 };
  globalThis.structuredClone = function (...args) {
    const [value] = args;
    metrics.structuredCloneCalls += 1;
    if (value?.id === INPUT.sessionId && value.schemaVersion === SESSION_SCHEMA_VERSION
      && Array.isArray(value.messages) && Array.isArray(value.events)) metrics.fullStateClones += 1;
    metrics.cloneInputJsonUtf8Bytes += jsonBytes(value);
    return Reflect.apply(clone, globalThis, args);
  };
  try { return { results: operation(), metrics }; }
  finally { globalThis.structuredClone = clone; }
}

function verifyQueryResults(session, results, expectedReads, expectedState) {
  assert.equal(results.length, INPUT.queryGroups * QUERIES.length);
  for (const [index, result] of results.entries()) {
    assert.deepEqual(result, expectedReads[index % QUERIES.length]);
    mutateSnapshot(result);
  }
  // Deliberately outside the measured window; also detects shared references
  // between results because each following result is checked after prior edits.
  assert.deepEqual(session.state, expectedState);
}
function mutateSnapshot(snapshot) {
  snapshot.syntheticCallerMarker = true;
  if (Object.hasOwn(snapshot, "phase")) snapshot.phase = "caller-only";
  if (Object.hasOwn(snapshot, "permissionProfile")) snapshot.permissionProfile = "caller-only";
  if (snapshot.metrics) snapshot.metrics.modelCalls = -100;
  if (snapshot.plan?.steps?.[0]) snapshot.plan.steps[0].step = "caller-only";
  if (snapshot.toolGrants) snapshot.toolGrants.push({ id: "caller-only" });
  if (snapshot.modelStream) snapshot.modelStream.status = "caller-only";
}

function measureTiming(session, expectedReads, expectedState) {
  function run(implementation) {
    const started = performance.now();
    const results = runQueries(session, implementation);
    const elapsedMs = performance.now() - started;
    verifyQueryResults(session, results, expectedReads, expectedState);
    return elapsedMs;
  }
  for (let warmup = 0; warmup < 2; warmup += 1) {
    for (const implementation of warmup % 2 === 0 ? [baselineReadState, currentReadState] : [currentReadState, baselineReadState]) run(implementation);
  }
  const baselineSamples = [];
  const currentSamples = [];
  for (let sample = 0; sample < 10; sample += 1) {
    for (const current of sample % 2 === 0 ? [false, true] : [true, false]) {
      (current ? currentSamples : baselineSamples).push(run(current ? currentReadState : baselineReadState));
    }
  }
  function summarize(samples) {
    const sorted = [...samples].sort((left, right) => left - right);
    const round = (value) => Number(value.toFixed(4));
    const percentile = (proportion) => sorted[Math.ceil(samples.length * proportion) - 1];
    return { sampleCount: samples.length, samplesMs: samples.map(round), p50Ms: round(percentile(0.5)),
      p95Ms: round(percentile(0.95)), maxMs: round(sorted.at(-1)) };
  }
  return { queriesPerSample: INPUT.queryGroups * QUERIES.length, warmupRunsPerStrategy: 2,
    measurementOrder: "alternating baseline/current first", clock: "performance.now", percentileMethod: "nearest rank",
    assertionsInsideWindow: false, structuredCloneInstrumentationInsideWindow: false,
    allResultsAndCallerIsolationCheckedAfterEveryWindow: true,
    baseline: summarize(baselineSamples), current: summarize(currentSamples),
    limitation: "single-process synthetic state-read wall time; may include GC/scheduling effects and is not CPU time, Runtime or Session dispatch latency, a real query distribution, or an end-to-end speedup guarantee" };
}

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function percentSaved(before, after) { return before === 0 ? 0 : Number(((1 - after / before) * 100).toFixed(4)); }
function atSecond(second) { return new Date(Date.UTC(2026, 8, 9, 0, 0, second)).toISOString(); }

try {
  process.stdout.write(JSON.stringify(await measure(), null, 2) + "\n");
} catch (error) {
  // Never emit raw assertion records, local paths, inputs, arbitrary exception
  // messages, prompts, tool arguments, credentials, or business data.
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? "measurement_assertion_failed" : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
