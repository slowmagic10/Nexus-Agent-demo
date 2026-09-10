// Synthetic native Session + SQLite commits and the actual Gateway cache
// binding. No services, configuration, business databases or model calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyStatePatch } from "../src/state-patch.js";
import { cacheActionTime, countStateClones, createStateCacheFixture } from "../test/support/session-state-cache-fixture.js";

const cases = [
  { name: "120-turns-events-only-checkpoint", turns: 120, commits: 120, readEvery: 0 },
  { name: "960-turns-events-only", turns: 960, commits: 80, readEvery: 0 },
  { name: "960-turns-read-every-10", turns: 960, commits: 80, readEvery: 10 },
  { name: "960-turns-read-every-commit", turns: 960, commits: 80, readEvery: 1 },
  { name: "120-turns-legacy-subscriber", turns: 120, commits: 80, readEvery: 0, legacy: true },
  { name: "120-turns-custom-journal", turns: 120, commits: 80, readEvery: 0, customJournal: true },
];

async function run(input, eager) {
  const fixture = createStateCacheFixture({ eager, turns: input.turns,
    beforeAttach: input.customJournal ? ({ store }) => {
      const native = store.commitSessionEvent;
      store.commitSessionEvent = function (...args) { return Reflect.apply(native, this, args); };
    } : undefined });
  const { entry, session, store } = fixture;
  try {
    await session.dispatchWithReceipt({ type: "MODEL_REQUESTED", at: cacheActionTime(1) }, { includeState: false });
    await session.dispatchWithReceipt({ type: "MODEL_STREAM_STARTED", at: cacheActionTime(2) }, { includeState: false });
    const before = session.state;
    // Align both caches before the measurement. Only subsequent commits/reads
    // belong to the counters; initial Session and Journal work is excluded.
    assert.deepEqual(entry.state, before);
    const events = [];
    const reads = [];
    const notifications = [];
    session.subscribeEvents((event) => events.push(event), { after: session.cursor });
    if (input.legacy) entry.subscribers.add((state) => notifications.push(state.modelStreamChunks.length));
    const { metrics } = await countStateClones(async () => {
      for (let index = 1; index <= input.commits; index++) {
        await session.dispatchWithReceipt({ type: "MODEL_STREAM_DELTA", delta: `合成流片段 ${index}。\n`,
          at: cacheActionTime(index + 2) }, { includeState: false });
        if (input.readEvery && index % input.readEvery === 0) {
          const state = entry.state;
          reads.push({ chunks: state.modelStreamChunks.length, cursor: session.cursor });
          assert.strictEqual(entry.state, state);
        }
      }
    });
    const final = entry.state;
    let projected = before;
    for (const event of events) projected = applyStatePatch(projected, event.patch);
    assert.deepEqual(final, projected);
    assert.deepEqual(final, store.load(session.id));
    assert.deepEqual(final, session.state);
    assert.equal(events.length, input.commits);
    assert.equal(final.modelStreamChunks.length, input.commits);
    assert.equal(notifications.length, input.legacy ? input.commits : 0);
    for (const [index, read] of reads.entries()) {
      assert.equal(read.chunks, (index + 1) * input.readEvery);
      assert.equal(read.cursor, read.chunks + 3);
    }
    // Each measured native reducer copies one full state. The remaining full
    // state clones are exactly the cache's eager notifications or demand reads.
    const expectedCacheClones = eager || input.legacy || input.customJournal
      ? input.commits : reads.length;
    assert.equal(metrics.fullStateClones, input.commits + expectedCacheClones);
    const stateHash = hash(final);
    final.messages[0].content = "客户端修改副本";
    final.metrics.modelCalls = -1;
    assert.equal(hash(session.state), stateHash);
    assert.equal(hash(store.load(session.id)), stateHash);
    return { metrics: { ...metrics, reducerFullStateClones: input.commits,
      gatewayCacheFullStateClones: expectedCacheClones },
      stateHash, eventsHash: hash(events), finalCursor: session.cursor, reads, notifications };
  } finally { fixture.close(); }
}

async function measure() {
  const results = [];
  for (const input of cases) {
    const baseline = await run(input, true);
    const current = await run(input, false);
    assert.deepEqual({ ...baseline, metrics: null }, { ...current, metrics: null });
    results.push({ input, baseline: baseline.metrics, current: current.metrics,
      cloneInputJsonUtf8ReductionPercent: Number(((1 - current.metrics.cloneInputJsonUtf8Bytes / baseline.metrics.cloneInputJsonUtf8Bytes) * 100).toFixed(2)),
      stateHash: current.stateHash, eventsHash: current.eventsHash, finalCursor: current.finalCursor,
      demandReads: current.reads.length, legacyNotifications: current.notifications.length, checksPassed: true });
  }
  return { metadata: { version: 1, benchmark: "nexus.synthetic-gateway-state-cache-copies", syntheticOnly: true,
    nodeVersion: process.version, sessionSchemaVersion: 18, sqliteSchemaVersion: 11,
    baseline: "stage-19 eager session.subscribe(next => manager.update(entry, next))",
    current: "actual attachSessionStateCache with native AgentSession, reducer and temporary SessionStore",
    counted: ["structuredClone calls during real durable MODEL_STREAM_DELTA dispatches, event delivery and configured cache reads",
      "sum of UTF-8 JSON sizes of clone inputs, including repeated inputs"],
    excluded: ["fixture setup, initial stream actions, cache warmup, final read, replay, load, hashes and mutation checks"],
    limitations: ["clone input JSON bytes are not actual V8 allocation, heap peak or RSS",
      "no CPU timing, HTTP/SSE encoding, real model throughput or task quality measured",
      "reducer still clones complete state on every action; SQL still processes complete JSON",
      "synthetic read frequency is not a measured production access distribution",
      "one unmaterialized committed version can remain alive until the next notification or first read"] },
    results, checksPassed: true };
}

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
try { process.stdout.write(JSON.stringify(await measure(), null, 2) + "\n"); }
catch (error) {
  process.stderr.write(JSON.stringify({ syntheticOnly: true, checksPassed: false,
    error: error instanceof assert.AssertionError ? "measurement_assertion_failed" : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
