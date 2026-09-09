// Offline synthetic projection measurements. No application configuration,
// existing database, service, filesystem tools, or model provider is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ModelContextProjection, applyModelContextEvent, prepareModelRequest, projectModelContext } from "../src/core/model-context.js";
import { createSession, reduceSession, SESSION_SCHEMA_VERSION } from "../src/core/state.js";
import { createStatePatch } from "../src/state-patch.js";

const MODEL_KEYS = ["messages", "memory", "contextMemory", "contextSummary", "loadedSkills", "objective", "plan", "delegations"];
const INPUT = Object.freeze({ sessionId: "synthetic-model-projection-cost", createdAt: "2026-09-09T00:00:00.000Z",
  historicalAssistantMessages: 120, historicalContentRepeat: 160, measuredEvents: 80, requestMaxInputTokens: 4000 });

function measure() {
  // Reducer execution, patch generation, and synthetic event construction are
  // completed before any clone observer is installed.
  const seed = seedState();
  const actions = measuredActions();
  const baseline = { cursor: 1, sessionId: seed.id, type: "SESSION_BASELINE", at: seed.createdAt, baseline: seed };
  const steps = [];
  let state = seed;
  for (const [index, action] of actions.entries()) {
    const nextState = reduceSession(state, action);
    const patch = createStatePatch(state, nextState);
    steps.push({ event: { cursor: index + 2, sessionId: seed.id, type: action.type, at: action.at, action, patch }, nextState });
    state = nextState;
  }
  const events = [baseline, ...steps.map(({ event }) => event)];
  const appendValues = new WeakSet();
  for (const { event } of steps) {
    for (const [key, value] of Object.entries(event.patch.append || {})) {
      if (MODEL_KEYS.includes(key) && Array.isArray(value)) appendValues.add(value);
    }
  }
  const expectedInputHash = sha256(JSON.stringify({ seed, events, input: INPUT }));

  const coldBefore = recorder(appendValues);
  const coldAfter = recorder(appendValues);
  const oldRecovered = coldBefore.run(() => projectModelContext(events, state));
  const newRecovered = coldAfter.run(() => new ModelContextProjection(events, state));
  const recovered = compareViews(oldRecovered, newRecovered);
  assert.deepEqual(recovered.context, projectModelContext([], state));

  // Hot-path initialization is excluded from both counters. A cold recovery
  // above separately includes one initial selection plus all replayed events.
  let oldContext = projectModelContext([baseline], seed);
  const owned = new ModelContextProjection([baseline], seed);
  const initialView = compareViews(oldContext, owned);
  const retainedRequest = structuredClone(initialView.request);
  const oldRetainedRequest = initialView.oldRequest;
  const newRetainedRequest = initialView.request;
  const hotBefore = recorder(appendValues);
  const hotAfter = recorder(appendValues);
  for (const { event, nextState } of steps) {
    oldContext = hotBefore.run(() => applyModelContextEvent(oldContext, event, nextState));
    hotAfter.run(() => owned.applyEvent(event, nextState));
    // Request shaping, budget/hash computation, and correctness comparisons
    // occur outside every measured window.
    const current = compareViews(oldContext, owned);
    assert.deepEqual(current.context, projectModelContext([], nextState));
  }
  const finalView = compareViews(oldContext, owned);
  assert.deepEqual(finalView.request, recovered.request);
  assert.deepEqual(oldRetainedRequest, retainedRequest);
  assert.deepEqual(newRetainedRequest, retainedRequest);
  // Simulate a provider retaining and then mutating an earlier request. Its
  // nested arrays and opaque extension fields cannot contaminate projection.
  for (const request of [oldRetainedRequest, newRetainedRequest]) {
    request.messages.push({ role: "user", content: "synthetic provider mutation" });
    request.messages[0].content = "synthetic overwritten snapshot";
    request.messages[0].provider_items = [{ type: "synthetic", nested: { modified: true } }];
    request.tools[0].function.parameters.properties.path.type = "number";
    request.contextPlan.contextHash = "synthetic mutated request hash";
  }
  assert.deepEqual(compareViews(oldContext, owned).request, finalView.request);
  assert.equal(sha256(JSON.stringify({ seed, events, input: INPUT })), expectedInputHash);
  assert.equal(hotBefore.metrics.completeModelContextCloneCalls, steps.length);
  assert.equal(hotAfter.metrics.completeModelContextCloneCalls, 0);
  assert.ok(hotAfter.metrics.cloneInputJsonUtf8Bytes < hotBefore.metrics.cloneInputJsonUtf8Bytes);
  assert.ok(coldAfter.metrics.cloneInputJsonUtf8Bytes < coldBefore.metrics.cloneInputJsonUtf8Bytes);
  const hotProjectionTiming = measureHotTiming(baseline, seed, steps, finalView.request.contextPlan.contextHash);

  return {
    metadata: {
      version: 1, benchmark: "nexus.synthetic-model-context-projection-costs", syntheticOnly: true,
      nodeVersion: process.version, platform: process.platform, sessionSchemaVersion: SESSION_SCHEMA_VERSION,
      inputsSha256: expectedInputHash,
      boundaries: ["global structuredClone input calls strictly inside model projection construction or event application",
        "UTF-8 bytes of JSON.stringify(value) for each observed clone argument, summed including repeated inputs",
        "complete model context arguments identified by the exact eight allowed model keys",
        "append array inputs identified by reference to the precomputed allowed event.patch.append values",
        "independent performance.now windows around 80 hot event applications without clone instrumentation or correctness assertions"],
      exclusions: ["all reducer calls, state patch generation, and input construction excluded",
        "prepareModelRequest, request isolation checks, request hashes, budgets, and assertions excluded",
        "hot initialization excluded; cold counters include initial selection and all replayed events",
        "clone instrumentation serializes inputs and adds overhead; byte counters are never used for timing",
        "independent hot timing excludes construction, input generation, request shaping, and hash validation"],
      interpretation: "JSON serialization size of clone inputs is a proxy for repeated input volume, not actual structuredClone allocation, copied bytes, CPU time, or speedup",
      notMeasured: ["actual heap/RSS peak or V8 allocation", "CPU or end-to-end latency", "SQLite persistence and disk I/O", "real model task quality"],
      remainingWork: ["reducer still clones full Session state", "createStatePatch still scans state and array prefixes",
        "each model request still creates isolated prompt/history/tools snapshots",
        "observer and default receipt state snapshots remain complete"],
    },
    input: { ...INPUT, historicalMessages: seed.messages.length, baselineModelContextJsonUtf8Bytes: jsonBytes(projectModelContext([], seed)),
      finalModelContextJsonUtf8Bytes: jsonBytes(oldContext), actionTypes: [...new Set(actions.map(({ type }) => type))],
      eventsWithModelPatch: steps.filter(({ event }) => hasModelPatch(event.patch)).length,
      eventsWithoutModelPatch: steps.filter(({ event }) => !hasModelPatch(event.patch)).length },
    coldRecovery: comparison(coldBefore.metrics, coldAfter.metrics,
      "public projectModelContext over baseline plus all events",
      "ModelContextProjection constructor over the identical baseline and events"),
    hotEvents: comparison(hotBefore.metrics, hotAfter.metrics,
      "public applyModelContextEvent called once per event",
      "private owned ModelContextProjection.applyEvent called once per event"),
    hotProjectionTiming,
    checks: { allPerEventModelKeysEqual: true, allPerEventRequestsIncludingHashAndBudgetEqual: true,
      recoveredAndIncrementalRequestsEqual: true, finalProjectionEqualsReducerModelFields: true,
      retainedRequestsUnaffectedByLaterEvents: true, mutatedRequestDoesNotAffectNewRequests: true,
      seedAndEventsRemainUnmodified: true, cloneInstrumentationRestoredAfterEachWindow: true },
    checksPassed: true,
  };
}

function seedState() {
  let state = createSession({ id: INPUT.sessionId, provider: "synthetic-offline", workspace: "/synthetic-model-projection",
    createdAt: INPUT.createdAt });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "合成历史任务", at: INPUT.createdAt });
  for (let index = 0; index < INPUT.historicalAssistantMessages; index += 1) {
    state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant",
      content: `合成历史 ${index}：${"普通历史内容 alpha 0123456789；".repeat(INPUT.historicalContentRepeat)}` }, at: atSecond(index + 1) });
  }
  return reduceSession(state, { type: "USER_MESSAGE", content: "继续当前合成任务", at: atSecond(200) });
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
      { type: "TOOL_REQUESTED", call, effects: ["read"] },
      { type: "APPROVAL_REQUESTED", call }, { type: "APPROVAL_DECIDED", call, approved: true },
      { type: "TOOL_EXECUTION_STARTED", call }, { type: "TOOL_RESULT", call, ok: true, result: `合成结果 ${cycle}`, durationMs: 1 },
      { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: `合成阶段 ${cycle} 完成` } },
      { type: "MEMORY_ADDED", content: `合成普通偏好 ${cycle}` },
      { type: "MEMORY_CONTEXT_SET", query: "合成记忆", memories: [{ id: `synthetic-memory-${cycle}`, content: `合成检索记忆 ${cycle}` }] },
      { type: "SKILL_LOADED", skill: { name: `synthetic-${cycle}`, content: "合成技能内容" } },
      { type: "READY" }, { type: "SESSION_DISPLAY_TITLE_CHANGED", title: `合成阶段 ${cycle}` });
  }
  assert.equal(actions.length, INPUT.measuredEvents);
  return actions.map((action, index) => ({ ...action, at: atSecond(500 + index) }));
}

function compareViews(context, projection) {
  const options = () => ({ systemPrompt: () => "固定合成系统提示", maxInputTokens: INPUT.requestMaxInputTokens,
    tools: [{ type: "function", function: { name: "read_file", description: "合成读取接口",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }] });
  const oldOptions = options();
  const newOptions = options();
  let oldCaptured;
  let captured;
  oldOptions.systemPrompt = (value) => { oldCaptured = value; return "固定合成系统提示"; };
  newOptions.systemPrompt = (value) => { captured = value; return "固定合成系统提示"; };
  const oldRequest = prepareModelRequest(context, oldOptions);
  const request = projection.prepareRequest(newOptions);
  assert.deepEqual(Object.keys(captured).sort(), [...MODEL_KEYS].sort());
  assert.deepEqual(captured, oldCaptured);
  assert.deepEqual(request, oldRequest);
  return { context: captured, request, oldRequest };
}

function recorder(appendValues) {
  const metrics = { cloneCalls: 0, cloneInputJsonUtf8Bytes: 0, completeModelContextCloneCalls: 0,
    completeModelContextCloneInputJsonUtf8Bytes: 0, appendArrayCloneCalls: 0, appendArrayCloneInputJsonUtf8Bytes: 0 };
  return { metrics, run(operation) {
    const clone = globalThis.structuredClone;
    globalThis.structuredClone = (value, ...options) => {
      const bytes = jsonBytes(value);
      metrics.cloneCalls += 1;
      metrics.cloneInputJsonUtf8Bytes += bytes;
      if (isCompleteModelContext(value)) {
        metrics.completeModelContextCloneCalls += 1;
        metrics.completeModelContextCloneInputJsonUtf8Bytes += bytes;
      }
      if (value && typeof value === "object" && appendValues.has(value)) {
        metrics.appendArrayCloneCalls += 1;
        metrics.appendArrayCloneInputJsonUtf8Bytes += bytes;
      }
      return clone(value, ...options);
    };
    try { return operation(); }
    finally { globalThis.structuredClone = clone; }
  } };
}

function measureHotTiming(baseline, seed, steps, expectedHash) {
  const options = { systemPrompt: "固定合成系统提示", maxInputTokens: INPUT.requestMaxInputTokens,
    tools: [{ type: "function", function: { name: "read_file", description: "合成读取接口",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }] };
  function run(owned) {
    // Initial projections and result verification stay outside the wall-clock
    // window. No hooks, counters, JSON measurement, or tests run inside it.
    const projection = owned ? new ModelContextProjection([baseline], seed) : null;
    let context = owned ? null : projectModelContext([baseline], seed);
    const started = performance.now();
    if (owned) {
      for (const { event, nextState } of steps) projection.applyEvent(event, nextState);
    } else {
      for (const { event, nextState } of steps) context = applyModelContextEvent(context, event, nextState);
    }
    const elapsedMs = performance.now() - started;
    const request = owned ? projection.prepareRequest(options) : prepareModelRequest(context, options);
    assert.equal(request.contextPlan.contextHash, expectedHash);
    return elapsedMs;
  }
  for (let warmup = 0; warmup < 2; warmup += 1) {
    run(warmup % 2 === 1);
    run(warmup % 2 === 0);
  }
  const baselineSamples = [];
  const currentSamples = [];
  for (let sample = 0; sample < 10; sample += 1) {
    for (const owned of sample % 2 === 0 ? [false, true] : [true, false]) {
      (owned ? currentSamples : baselineSamples).push(run(owned));
    }
  }
  function summarize(samples) {
    const sorted = [...samples].sort((left, right) => left - right);
    const round = (value) => Number(value.toFixed(4));
    const percentile = (proportion) => sorted[Math.ceil(samples.length * proportion) - 1];
    return { sampleCount: samples.length, samplesMs: samples.map(round), p50Ms: round(percentile(0.5)),
      p95Ms: round(percentile(0.95)), maxMs: round(sorted.at(-1)) };
  }
  return { eventsPerSample: steps.length, warmupRunsPerStrategy: 2, measurementOrder: "alternating baseline/current first",
    clock: "performance.now", percentileMethod: "nearest rank", assertionsInsideWindow: false,
    cloneInstrumentationInsideWindow: false, requestHashCheckedAfterEveryWindow: true,
    baseline: summarize(baselineSamples), current: summarize(currentSamples),
    limitation: "single-process synthetic hot projection wall time; may include GC/scheduling effects and is not Session dispatch, real workload, CPU time, or an end-to-end speedup guarantee" };
}

function hasModelPatch(patch) {
  return [...Object.keys(patch.set || {}), ...Object.keys(patch.append || {}), ...(patch.remove || [])]
    .some((key) => MODEL_KEYS.includes(key));
}
function isCompleteModelContext(value) {
  return value && !Array.isArray(value) && typeof value === "object"
    && Object.keys(value).length === MODEL_KEYS.length && MODEL_KEYS.every((key) => Object.hasOwn(value, key));
}
function comparison(before, after, oldStrategy, newStrategy) {
  return { baseline: { strategy: oldStrategy, ...before }, current: { strategy: newStrategy, ...after },
    cloneInputJsonUtf8BytesSaved: before.cloneInputJsonUtf8Bytes - after.cloneInputJsonUtf8Bytes,
    cloneInputJsonUtf8ReductionPercent: Number(((1 - after.cloneInputJsonUtf8Bytes / before.cloneInputJsonUtf8Bytes) * 100).toFixed(4)) };
}
function jsonBytes(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
}
function atSecond(second) { return new Date(Date.UTC(2026, 8, 9, 0, 0, second)).toISOString(); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

try {
  process.stdout.write(JSON.stringify(measure(), null, 2) + "\n");
} catch (error) {
  // Fail without serializing arbitrary assertion values, raw input records,
  // exception messages, local paths, or provider content into the report.
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? "measurement_assertion_failed" : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
