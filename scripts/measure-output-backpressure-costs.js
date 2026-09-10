// Offline ToolOutputStream measurements with a controlled first-dispatch gate.
// No child process, Session database, model or service is started.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createToolOutputStream } from "../src/tools/output-stream.js";
import { createToolOutputStream as createReferenceStream } from "../test/support/output-stream-reference.js";

const cases = [
  { name: "burst-1000-preview-12", appends: 1000, maxPreviewChars: 12 },
  { name: "burst-10000-preview-12", appends: 10000, maxPreviewChars: 12 },
  { name: "burst-1000-preview-12000", appends: 1000, maxPreviewChars: 12_000 },
  { name: "burst-10000-preview-12000", appends: 10000, maxPreviewChars: 12_000 },
];

async function measure() {
  const results = [];
  for (const sample of cases) results.push(await measureCase(sample));
  return {
    metadata: {
      version: 1,
      benchmark: "nexus.synthetic-tool-output-backpressure-costs",
      syntheticOnly: true,
      nodeVersion: process.version,
      platform: process.platform,
      baseline: "frozen pre-coalescing ToolOutputStream; only relative redaction import adjusted",
      method: "hold the first actual dispatch; append all remaining identical line chunks synchronously; call close; release the gate; await every append and close",
      boundaries: [
        "actual dispatch invocation count, exact unique preview strings and duplicate previews",
        "UTF-8 bytes of JSON.stringify(action) only at actual dispatch invocations",
        "distinct Promise identities returned by append, not internal Promise allocation count",
      ],
      interpretation: "coalescing deliberately changes intermediate output-update events; final complete output-update action fields must remain equal",
      notMeasured: [
        "real child-process pipe pause/resume, output throughput or producer buffering",
        "complete tool output, artifacts or ToolResult content",
        "Session reducer, Journal persistence, SQLite bytes or durability latency",
        "internal Promise allocations, peak heap/RSS or end-to-end task performance",
        "wall-clock speed; the artificial dispatch gate is never used as a timing result",
      ],
      limitations: [
        "a synchronous burst against one deliberately blocked consumer is a queue-boundary stress case",
        "a producer awaiting every append will have a different update pattern",
        "preview payload bytes are dispatch-bound work, not measured database I/O or memory savings",
        "successful dispatch only; retry and cancellation are covered by separate regression tests",
      ],
    },
    results,
    checksPassed: results.every(({ checks }) => Object.values(checks).every(Boolean)),
  };
}

async function measureCase(sample) {
  const before = await runBurst(createReferenceStream, sample);
  const after = await runBurst(createToolOutputStream, sample);
  assert.deepEqual(after.finalAction, before.finalAction);
  assert.equal(before.metrics.dispatchCalls, sample.appends + 1);
  assert.equal(after.metrics.dispatchCalls, 2);
  assert.equal(after.metrics.duplicatePreviews, 0);
  assert.equal(after.finalAction.capturedChars, Math.min(sample.appends * 5, sample.maxPreviewChars));
  assert.equal(after.finalAction.truncated, sample.appends * 5 > sample.maxPreviewChars);
  return {
    name: sample.name,
    input: { appends: sample.appends, chunk: "line\n", channel: "stdout", minUpdateChars: 256,
      maxPreviewChars: sample.maxPreviewChars, totalChunkChars: sample.appends * 5 },
    dispatch: {
      baseline: before.metrics,
      current: after.metrics,
      callsReductionPercent: percentSaved(before.metrics.dispatchCalls, after.metrics.dispatchCalls),
      actionJsonUtf8ReductionPercent: percentSaved(before.metrics.actionJsonUtf8Bytes, after.metrics.actionJsonUtf8Bytes),
    },
    finalAction: {
      type: after.finalAction.type,
      callId: after.finalAction.callId,
      tool: after.finalAction.tool,
      capturedChars: after.finalAction.capturedChars,
      truncated: after.finalAction.truncated,
      channel: after.finalAction.channel,
      previewChars: after.finalAction.preview.length,
      previewSha256: hash(after.finalAction.preview),
      actionSha256: hash(JSON.stringify(after.finalAction)),
    },
    checks: {
      firstDispatchBlockedBeforeBurst: true,
      noSecondDispatchBeforeRelease: true,
      dispatchesRemainSerial: true,
      allAppendPromisesAndCloseSettled: true,
      finalCompleteActionDeepEqual: true,
      finalCaptureAndTruncationCorrect: true,
      boundedCurrentDispatches: true,
      noDuplicateCurrentPreview: true,
    },
  };
}

async function runBurst(createStream, sample) {
  const gate = deferred();
  const started = deferred();
  const previews = new Set();
  const appendPromises = new Set();
  const metrics = { dispatchCalls: 0, uniquePreviews: 0, duplicatePreviews: 0,
    actionJsonUtf8Bytes: 0, uniqueAppendPromises: 0, maxConcurrentDispatches: 0,
    dispatchCallsBeforeGateRelease: 0 };
  let concurrent = 0;
  let finalAction;
  const stream = createStream({ call: { id: "synthetic-output", name: "run_shell" },
    maxPreviewChars: sample.maxPreviewChars, minUpdateChars: 256,
    async dispatch(action) {
      concurrent++;
      metrics.maxConcurrentDispatches = Math.max(metrics.maxConcurrentDispatches, concurrent);
      metrics.dispatchCalls++;
      metrics.actionJsonUtf8Bytes += Buffer.byteLength(JSON.stringify(action), "utf8");
      previews.add(action.preview);
      finalAction = structuredClone(action);
      if (metrics.dispatchCalls === 1) {
        started.resolve();
        await gate.promise;
      }
      concurrent--;
      return { cursor: metrics.dispatchCalls };
    },
  });
  appendPromises.add(stream.append({ channel: "stdout", chunk: "line\n" }));
  await started.promise;
  assert.equal(concurrent, 1);
  for (let index = 1; index < sample.appends; index++) {
    appendPromises.add(stream.append({ channel: "stdout", chunk: "line\n" }));
  }
  const closed = stream.close();
  const drained = Promise.all([...appendPromises, closed]);
  await Promise.resolve();
  metrics.dispatchCallsBeforeGateRelease = metrics.dispatchCalls;
  assert.equal(metrics.dispatchCallsBeforeGateRelease, 1);
  gate.resolve();
  await drained;
  assert.equal(concurrent, 0);
  assert.equal(metrics.maxConcurrentDispatches, 1);
  metrics.uniquePreviews = previews.size;
  metrics.duplicatePreviews = metrics.dispatchCalls - previews.size;
  metrics.uniqueAppendPromises = appendPromises.size;
  return { metrics, finalAction };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function percentSaved(before, after) { return Number(((1 - after / before) * 100).toFixed(4)); }

try { process.stdout.write(JSON.stringify(await measure(), null, 2) + "\n"); }
catch (error) {
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? "measurement_assertion_failed" : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
