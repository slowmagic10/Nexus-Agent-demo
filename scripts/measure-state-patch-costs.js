// Offline synthetic state-patch measurements. No application configuration,
// existing database, service, filesystem tools, or model provider is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSession, reduceSession, SESSION_SCHEMA_VERSION } from "../src/core/state.js";
import { applyStatePatch, createStatePatch } from "../src/state-patch.js";

const INPUT = Object.freeze({ sessionId: "synthetic-state-patch-cost", createdAt: "2026-09-09T00:00:00.000Z",
  historicalAssistantMessages: 120, historicalContentRepeat: 160, measuredEvents: 80 });

function measure() {
  // Every reducer call and action/state construction finishes before counters
  // or clocks are installed. Both strategies receive the identical objects.
  const seed = seedState();
  const actions = measuredActions();
  const steps = [];
  let state = seed;
  for (const action of actions) {
    const next = reduceSession(state, action);
    steps.push({ previous: state, next, action });
    state = next;
  }
  const expectedInputHash = inputHash(seed, steps);
  const originalStringify = JSON.stringify;
  const baseline = countSerialization(() => generatePatches(steps, baselineCreateStatePatch));
  assert.equal(JSON.stringify, originalStringify);
  const current = countSerialization(() => generatePatches(steps, createStatePatch));
  assert.equal(JSON.stringify, originalStringify);
  assert.deepEqual(current.patches, baseline.patches);

  for (const [index, { previous, next }] of steps.entries()) {
    assert.deepEqual(applyStatePatch(previous, baseline.patches[index]), next);
    assert.deepEqual(applyStatePatch(previous, current.patches[index]), next);
  }
  const beforeJournal = journal(seed, steps, baseline.patches);
  const afterJournal = journal(seed, steps, current.patches);
  assert.equal(JSON.stringify(afterJournal), JSON.stringify(beforeJournal));
  // The persisted JSON representation is replayed in memory: this verifies
  // baseline/action/patch bytes and patch recovery without opening SQLite.
  const persisted = JSON.parse(JSON.stringify(afterJournal));
  let patchRecovered = persisted[0].baseline;
  let reducerRecovered = persisted[0].baseline;
  for (const event of persisted.slice(1)) {
    patchRecovered = applyStatePatch(patchRecovered, event.patch);
    reducerRecovered = reduceSession(reducerRecovered, event.action);
    assert.deepEqual(patchRecovered, JSON.parse(JSON.stringify(reducerRecovered)));
  }
  assert.deepEqual(patchRecovered, JSON.parse(JSON.stringify(state)));
  const timing = measureTiming(steps, baseline.patches);
  assert.equal(inputHash(seed, steps), expectedInputHash);

  return {
    metadata: {
      version: 1, benchmark: "nexus.synthetic-state-patch-generation-costs", syntheticOnly: true,
      nodeVersion: process.version, platform: process.platform, sessionSchemaVersion: SESSION_SCHEMA_VERSION,
      inputsSha256: expectedInputHash,
      boundaries: ["JSON.stringify calls strictly inside 80 createStatePatch invocations",
        "UTF-8 bytes of every string returned by observed JSON.stringify calls, summed including repeated serializations",
        "independent performance.now windows around 80 createStatePatch invocations with no serialization instrumentation"],
      exclusions: ["all reducer calls and action/state construction excluded",
        "patch application, Journal construction/replay, hashing, output formatting, and assertions excluded",
        "serialization counters add overhead; instrumented runs are never used for timing"],
      interpretation: "serialized UTF-8 output is repeated temporary string volume, not total allocation, actual heap pressure, or a guaranteed runtime speedup",
      notMeasured: ["RSS or heap peak", "V8 allocation or CPU time", "SQLite writes and disk I/O",
        "Session dispatch or end-to-end latency", "real-model task quality"],
      remainingWork: ["reducer still clones complete state", "state patch generation still visits history and array prefixes",
        "patch values remain detached structuredClone snapshots", "checkpoints and request snapshots still process full state or model context"],
    },
    input: { ...INPUT, historicalMessages: seed.messages.length, historicalEvents: seed.events.length,
      initialStateJsonUtf8Bytes: jsonBytes(seed), finalStateJsonUtf8Bytes: jsonBytes(state),
      actionTypes: [...new Set(actions.map(({ type }) => type))],
      eventsAppendingMessages: current.patches.filter((patch) => patch.append?.messages?.length).length,
      modelStreamDeltaEvents: actions.filter(({ type }) => type === "MODEL_STREAM_DELTA").length,
      toolStreamUpdateEvents: actions.filter(({ type }) => type === "TOOL_OUTPUT_UPDATED").length },
    patchGeneration: {
      baseline: { strategy: "frozen original createStatePatch using JSON.stringify equality and per-element JSON.stringify prefix comparison", ...baseline.metrics },
      current: { strategy: "actual imported createStatePatch", ...current.metrics },
      stringifyCallsSaved: baseline.metrics.stringifyCalls - current.metrics.stringifyCalls,
      serializedStringUtf8BytesSaved: baseline.metrics.serializedStringUtf8Bytes - current.metrics.serializedStringUtf8Bytes,
      serializedStringUtf8ReductionPercent: percentSaved(baseline.metrics.serializedStringUtf8Bytes, current.metrics.serializedStringUtf8Bytes),
    },
    patchGenerationTiming: timing,
    checks: { allPerEventPatchesDeepEqual: true, allBaselinePatchesReconstructReducerState: true,
      allCurrentPatchesReconstructReducerState: true, completeJournalJsonUnchanged: true,
      inMemoryJsonJournalPatchAndReducerReplayEqual: true, finalReplayEqualsReducerState: true,
      seedAndStepsRemainUnmodified: true, stringifyInstrumentationRestoredAfterEachWindow: true,
      noSpeedThreshold: true },
    checksPassed: true,
  };
}

// Frozen oracle: copied from src/state-patch.js before this optimization.
// Keep this independent of the production equality/prefix implementation.
function baselineCreateStatePatch(previous, next) {
  const patch = { set: {}, append: {}, remove: [] };
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (!(key in next)) {
      patch.remove.push(key);
      continue;
    }
    if (baselineSameValue(previous[key], next[key])) continue;
    if (Array.isArray(previous[key]) && Array.isArray(next[key]) && baselineIsPrefix(previous[key], next[key])) {
      patch.append[key] = structuredClone(next[key].slice(previous[key].length));
      continue;
    }
    patch.set[key] = structuredClone(next[key]);
  }
  if (!Object.keys(patch.set).length) delete patch.set;
  if (!Object.keys(patch.append).length) delete patch.append;
  if (!patch.remove.length) delete patch.remove;
  return patch;
}
function baselineIsPrefix(previous, next) {
  if (previous.length > next.length) return false;
  return previous.every((value, index) => baselineSameValue(value, next[index]));
}
function baselineSameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function seedState() {
  let state = createSession({ id: INPUT.sessionId, provider: "synthetic-offline", workspace: "/synthetic-state-patch",
    createdAt: INPUT.createdAt });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "合成历史任务", at: INPUT.createdAt });
  for (let index = 0; index < INPUT.historicalAssistantMessages; index += 1) {
    state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant",
      content: `合成历史 ${index}：${"普通历史内容 alpha 0123456789；".repeat(INPUT.historicalContentRepeat)}` }, at: atSecond(index + 1) });
  }
  return state;
}

function measuredActions() {
  const actions = [];
  for (let cycle = 0; cycle < 4; cycle += 1) {
    const call = { id: `synthetic-read-${cycle}`, name: "read_file", arguments: { path: `synthetic-${cycle}.txt` } };
    actions.push({ type: "MODEL_REQUESTED" }, { type: "MODEL_STREAM_STARTED" });
    for (let index = 0; index < 5; index += 1) actions.push({ type: "MODEL_STREAM_DELTA", delta: `合成增量 ${cycle}/${index}。` });
    actions.push({ type: "MODEL_STREAM_COMPLETED" },
      { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "合成读取", tool_calls: [
        { id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
      ] } },
      { type: "TOOL_REQUESTED", call, effects: ["read"] }, { type: "TOOL_EXECUTION_STARTED", call });
    for (let index = 0; index < 3; index += 1) {
      const preview = `合成输出 ${cycle}。`.repeat(index + 1);
      actions.push({ type: "TOOL_OUTPUT_UPDATED", callId: call.id, preview, capturedChars: preview.length, channel: "stdout" });
    }
    actions.push({ type: "TOOL_RESULT", call, ok: true, result: `合成结果 ${cycle}`, durationMs: 1 },
      { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: `合成阶段 ${cycle} 完成` } },
      { type: "MEMORY_ADDED", content: `合成普通偏好 ${cycle}` },
      { type: "MEMORY_CONTEXT_SET", query: "合成记忆", memories: [{ id: `synthetic-memory-${cycle}`, content: `合成检索记忆 ${cycle}` }] },
      { type: "READY" }, { type: "SESSION_DISPLAY_TITLE_CHANGED", title: `合成阶段 ${cycle}` });
  }
  assert.equal(actions.length, INPUT.measuredEvents);
  return actions.map((action, index) => ({ ...action, at: atSecond(500 + index) }));
}

function generatePatches(steps, implementation) {
  return steps.map(({ previous, next }) => implementation(previous, next));
}

function countSerialization(operation) {
  const stringify = JSON.stringify;
  const metrics = { stringifyCalls: 0, serializedStrings: 0, serializedStringUtf8Bytes: 0, undefinedResults: 0 };
  JSON.stringify = function (...args) {
    const result = Reflect.apply(stringify, JSON, args);
    metrics.stringifyCalls += 1;
    if (result === undefined) metrics.undefinedResults += 1;
    else {
      metrics.serializedStrings += 1;
      metrics.serializedStringUtf8Bytes += Buffer.byteLength(result, "utf8");
    }
    return result;
  };
  try { return { patches: operation(), metrics }; }
  finally { JSON.stringify = stringify; }
}

function measureTiming(steps, expectedPatches) {
  function run(implementation) {
    // Assertions and serialization observers are deliberately outside the clock.
    const started = performance.now();
    const patches = generatePatches(steps, implementation);
    const elapsedMs = performance.now() - started;
    assert.deepEqual(patches, expectedPatches);
    return elapsedMs;
  }
  for (let warmup = 0; warmup < 2; warmup += 1) {
    for (const implementation of warmup % 2 === 0 ? [baselineCreateStatePatch, createStatePatch] : [createStatePatch, baselineCreateStatePatch]) run(implementation);
  }
  const baselineSamples = [];
  const currentSamples = [];
  for (let sample = 0; sample < 10; sample += 1) {
    for (const current of sample % 2 === 0 ? [false, true] : [true, false]) {
      (current ? currentSamples : baselineSamples).push(run(current ? createStatePatch : baselineCreateStatePatch));
    }
  }
  function summarize(samples) {
    const sorted = [...samples].sort((left, right) => left - right);
    const round = (value) => Number(value.toFixed(4));
    const percentile = (proportion) => sorted[Math.ceil(samples.length * proportion) - 1];
    return { sampleCount: samples.length, samplesMs: samples.map(round), p50Ms: round(percentile(0.5)),
      p95Ms: round(percentile(0.95)), maxMs: round(sorted.at(-1)) };
  }
  return { patchesPerSample: steps.length, warmupRunsPerStrategy: 2, measurementOrder: "alternating baseline/current first",
    clock: "performance.now", percentileMethod: "nearest rank", assertionsInsideWindow: false,
    stringifyInstrumentationInsideWindow: false, allPatchesCheckedAfterEveryWindow: true,
    baseline: summarize(baselineSamples), current: summarize(currentSamples),
    limitation: "single-process synthetic patch-generation wall time; may include GC/scheduling effects and is not CPU time, Session dispatch, a real workload, or an end-to-end speedup guarantee" };
}

function journal(seed, steps, patches) {
  return [{ cursor: 1, sessionId: seed.id, type: "SESSION_BASELINE", at: seed.createdAt, baseline: seed },
    ...steps.map(({ action }, index) => ({ cursor: index + 2, sessionId: seed.id, type: action.type,
      at: action.at, action, patch: patches[index] }))];
}
function inputHash(seed, steps) {
  const hash = createHash("sha256").update(JSON.stringify(INPUT)).update(JSON.stringify(seed));
  for (const { previous, next, action } of steps) hash.update(JSON.stringify({ previous, next, action }));
  return hash.digest("hex");
}
function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function percentSaved(before, after) { return before === 0 ? 0 : Number(((1 - after / before) * 100).toFixed(4)); }
function atSecond(second) { return new Date(Date.UTC(2026, 8, 9, 0, 0, second)).toISOString(); }

try {
  process.stdout.write(JSON.stringify(measure(), null, 2) + "\n");
} catch (error) {
  // Never dump assertion records, arbitrary exception messages, raw inputs,
  // local paths, prompts, credentials, or business data into the report.
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? "measurement_assertion_failed" : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
