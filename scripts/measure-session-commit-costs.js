// Offline synthetic boundary measurements. This script never reads application
// configuration, opens an existing database, starts a service, or calls a model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/core/session.js";
import { createSession, migrateSessionState, reduceSession, SESSION_SCHEMA_VERSION } from "../src/core/state.js";
import { resolveSessionDisplayTitle } from "../src/core/session-display-title.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { createStatePatch } from "../src/state-patch.js";

const INPUT = Object.freeze({ sessionId: "synthetic-session-commit-cost", createdAt: "2026-09-09T00:00:00.000Z",
  historicalAssistantMessages: 120, historicalContentRepeat: 160, measuredCommits: 40, checkpointInterval: 10 });

async function measure() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-session-commit-cost-"));
  const stores = [];
  try {
    const seed = seedState(workspace);
    const actions = measuredActions();
    const baselineStore = new SessionStore(path.join(workspace, "full-save.sqlite"), { workspace, checkpointInterval: INPUT.checkpointInterval });
    stores.push(baselineStore);
    const currentStore = new SessionStore(path.join(workspace, "incremental.sqlite"), { workspace, checkpointInterval: INPUT.checkpointInterval });
    stores.push(currentStore);
    baselineStore.ensureJournal(seed);
    currentStore.ensureJournal(seed);
    const baseline = measureCommits(baselineStore, seed, actions, false);
    const current = measureCommits(currentStore, seed, actions, true);
    assert.deepEqual(current.finalState, baseline.finalState);
    assert.deepEqual(current.checkpoints, baseline.checkpoints);
    assert.deepEqual(currentStore.readSessionEvents(seed.id), baselineStore.readSessionEvents(seed.id));
    assert.equal(baseline.metrics.fullStateJsonBindings.cache.count, INPUT.measuredCommits);
    assert.equal(current.metrics.fullStateJsonBindings.cache.count, 4);
    assert.equal(baseline.metrics.fullStateJsonBindings.checkpoint.count, 4);
    assert.equal(current.metrics.fullStateJsonBindings.checkpoint.count, 4);
    assert.ok(current.metrics.sqlWriteTextParameterUtf8Bytes < baseline.metrics.sqlWriteTextParameterUtf8Bytes);

    const load = measureLoad(currentStore, current.finalState);
    const list = measureList(currentStore, current.finalState);
    const receipts = await measureReceipts(seed);
    return {
      metadata: {
        version: 1, benchmark: "nexus.synthetic-session-commit-boundary-costs",
        nodeVersion: process.version, platform: process.platform, sessionSchemaVersion: SESSION_SCHEMA_VERSION,
        syntheticOnly: true, inputsSha256: sha256(JSON.stringify({ input: INPUT, actions })),
        boundaries: ["UTF-8 bytes of textual SQLite write bindings at StatementSync calls",
          "complete state JSON bindings to sessions and session_checkpoints",
          "sessions.state_json payloads returned across SQLite-to-JavaScript boundary",
          "global structuredClone calls receiving a complete synthetic Session state during one receipt dispatch"],
        exclusions: ["baseline creation, schema migration, and correctness checks excluded from commit binding counters",
          "numeric bindings counted separately without treating their text length as physical SQLite storage",
          "baseline is today's compatibility full-save path, not a CPU comparison with the old double full-state redaction",
          "instrumentation parsing and UTF-8 counting add overhead; no elapsed-time claim is made"],
        notMeasured: ["SQLite internal JSON parsing or complete document rewrites", "WAL size or disk I/O",
          "RSS or heap peak", "total throughput or end-to-end latency", "real-model task quality"],
        remainingWork: ["reducer still clones full state", "state patch generation still scans state and array prefixes",
          "baseline, checkpoints, explicit save, and fallback still serialize complete state",
          "observers requesting state still receive detached complete snapshots"],
      },
      input: { ...INPUT, historicalMessages: seed.messages.length, historicalEvents: seed.events.length,
        initialStateUtf8Bytes: Buffer.byteLength(JSON.stringify(seed)), finalStateUtf8Bytes: Buffer.byteLength(JSON.stringify(current.finalState)),
        actionTypes: [...new Set(actions.map((action) => action.type))] },
      commit: {
        baseline: { strategy: "actual SessionStore.commitSessionEvent without expectedCursor (compatibility full-save path)", ...baseline.metrics },
        current: { strategy: "actual SessionStore.commitSessionEvent with exact preceding expectedCursor; due checkpoints reuse a full snapshot for cache and checkpoint bindings", ...current.metrics },
        textBindingUtf8BytesSaved: baseline.metrics.sqlWriteTextParameterUtf8Bytes - current.metrics.sqlWriteTextParameterUtf8Bytes,
        textBindingReductionPercent: percentageSaved(baseline.metrics.sqlWriteTextParameterUtf8Bytes, current.metrics.sqlWriteTextParameterUtf8Bytes),
        checkpointCursors: current.checkpoints.map((checkpoint) => checkpoint.cursor),
        checks: { allPerCommitCachesEqualReducer: true, allRecoveredStatesEqualReducer: true,
          allCheckpointStatesAndChecksumsValid: true, fullAndIncrementalCheckpointsEqual: true,
          completeJournalEqual: true, sameFinalState: true, checkpointIntervalPreserved: true },
      },
      load, list, receipts,
      checksPassed: true,
    };
  } finally {
    for (const store of stores) store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

function seedState(workspace) {
  let state = createSession({ id: INPUT.sessionId, provider: "synthetic-offline", workspace, createdAt: INPUT.createdAt });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "检查合成端点 192.0.2.17 的任务记录", at: INPUT.createdAt });
  for (let index = 0; index < INPUT.historicalAssistantMessages; index += 1) {
    state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant",
      content: `合成历史 ${index}：${"普通历史内容 alpha 0123456789；".repeat(INPUT.historicalContentRepeat)}` }, at: atSecond(index + 1) });
  }
  assert.equal(resolveSessionDisplayTitle(state), "受保护任务");
  return state;
}

function measuredActions() {
  const actions = [];
  for (let cycle = 0; cycle < 4; cycle += 1) {
    actions.push({ type: "MODEL_REQUESTED" }, { type: "MODEL_STREAM_STARTED" });
    for (let index = 0; index < 5; index += 1) actions.push({ type: "MODEL_STREAM_DELTA", delta: `合成增量 ${cycle}/${index}。` });
    actions.push({ type: "MODEL_STREAM_COMPLETED" }, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: `合成完成文本 ${cycle}。` } });
    actions.push(cycle === 1 ? { type: "SESSION_DISPLAY_TITLE_CHANGED", title: "合成提交开销任务" }
      : cycle === 2 ? { type: "SESSION_DISPLAY_TITLE_CHANGED", title: "服务器地址: 192.0.2.17" }
        : { type: "MEMORY_ADDED", content: `合成普通偏好 ${cycle}` });
  }
  assert.equal(actions.length, INPUT.measuredCommits);
  return actions.map((action, index) => ({ ...action, at: atSecond(500 + index) }));
}

function measureCommits(store, seed, actions, incremental) {
  let state = seed;
  let cursor = store.latestSessionCursor(seed.id);
  const expectedCheckpoints = new Map();
  const metrics = { successfulWriteCalls: 0, stringBindings: 0, numericBindings: 0,
    sqlWriteTextParameterUtf8Bytes: 0,
    fullStateJsonBindings: { cache: { count: 0, utf8Bytes: 0 }, checkpoint: { count: 0, utf8Bytes: 0 } } };
  const observer = observeDatabase(store, {
    writes(sql, params) {
      metrics.successfulWriteCalls += 1;
      for (const value of params) {
        if (typeof value === "number" || typeof value === "bigint") metrics.numericBindings += 1;
        if (typeof value !== "string") continue;
        const bytes = Buffer.byteLength(value, "utf8");
        metrics.stringBindings += 1;
        metrics.sqlWriteTextParameterUtf8Bytes += bytes;
        if (!isCompleteStateJson(value, seed.id)) continue;
        const category = /\bsession_checkpoints\b/i.test(sql) ? "checkpoint" : /\bsessions\b/i.test(sql) ? "cache" : null;
        assert.ok(category, "complete state binding must have an identified destination");
        metrics.fullStateJsonBindings[category].count += 1;
        metrics.fullStateJsonBindings[category].utf8Bytes += bytes;
      }
    },
  });
  try {
    for (const action of actions) {
      const next = reduceSession(state, action);
      const patch = createStatePatch(state, next);
      observer.enabled = true;
      let event;
      try {
        event = incremental ? store.commitSessionEvent(next, action, patch, { expectedCursor: cursor })
          : store.commitSessionEvent(next, action, patch);
      } finally { observer.enabled = false; }
      assert.equal(event.cursor, cursor + 1);
      cursor = event.cursor;
      state = next;
      const cached = store.db.prepare("SELECT state_json FROM sessions WHERE id = ?").get(seed.id);
      assert.deepEqual(JSON.parse(cached.state_json), state);
      assert.deepEqual(store.load(seed.id), state);
      if (cursor % INPUT.checkpointInterval === 0) expectedCheckpoints.set(cursor, state);
    }
  } finally { observer.restore(); }
  const checkpoints = store.db.prepare("SELECT cursor, state_json, checksum, created_at FROM session_checkpoints WHERE session_id = ? ORDER BY cursor").all(seed.id);
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.cursor), [10, 20, 30, 40]);
  for (const checkpoint of checkpoints) {
    assert.deepEqual(JSON.parse(checkpoint.state_json), expectedCheckpoints.get(checkpoint.cursor));
    assert.equal(checkpoint.checksum, `sha256:${sha256(`${seed.id}\n${checkpoint.cursor}\n${checkpoint.state_json}`)}`);
  }
  assert.equal(resolveSessionDisplayTitle(state), "受保护任务");
  return { finalState: state, metrics, checkpoints };
}

function measureLoad(store, expected) {
  const baseline = observeSessionPayloads(store, () => JSON.parse(store.db.prepare("SELECT state_json FROM sessions WHERE id = ?").get(expected.id).state_json));
  const current = observeSessionPayloads(store, () => store.load(expected.id));
  assert.deepEqual(baseline.value, expected);
  assert.deepEqual(current.value, expected);
  assert.equal(baseline.metrics.payloadCount, 1);
  assert.equal(current.metrics.payloadCount, 0);
  return { baseline: { strategy: "independent former eager sessions SELECT state_json probe; not a timed historical load implementation", ...baseline.metrics },
    current: { strategy: "actual SessionStore.load with valid Journal and checkpoints", ...current.metrics },
    checks: { cachedAndRecoveredStatesEqual: true, journalRecoveryPreserved: true, redundantSessionsPayloadEliminated: true } };
}

function measureList(store, expected) {
  const baseline = observeSessionPayloads(store, () => store.db.prepare(`SELECT id, created_at AS createdAt, updated_at AS updatedAt,
    provider, phase, message_count AS messageCount, state_json AS stateJson FROM sessions
    WHERE workspace = ? ORDER BY updated_at DESC LIMIT ?`).all(store.workspace, 20).map(({ stateJson, ...row }) => ({
      ...row, title: resolveSessionDisplayTitle(migrateSessionState(JSON.parse(stateJson))),
    })));
  const current = observeSessionPayloads(store, () => store.list(store.workspace, 20));
  assert.deepEqual(current.value, baseline.value);
  assert.equal(current.value.length, 1);
  assert.equal(current.value[0].id, expected.id);
  assert.equal(current.value[0].title, "受保护任务");
  assert.equal(baseline.metrics.payloadCount, 1);
  assert.equal(current.metrics.payloadCount, 0);
  return { baseline: { strategy: "independent former full-state list query plus migrated title resolution", ...baseline.metrics },
    current: { strategy: "actual SessionStore.list", ...current.metrics },
    checks: { listRowsEqual: true, protectedTitlePreserved: true, ordinaryAndProtectedTitleChangesCommitted: true,
      fullSessionsPayloadEliminated: true } };
}

async function measureReceipts(seed) {
  const action = { type: "MEMORY_ADDED", content: "合成回执检查", at: atSecond(900) };
  const expected = reduceSession(seed, action);
  async function run(includeState) {
    const session = new AgentSession({ state: seed, reducer: reduceSession });
    const clone = globalThis.structuredClone;
    let completeStateCloneCalls = 0;
    let receipt;
    globalThis.structuredClone = (value, ...options) => {
      if (value?.id === seed.id && Array.isArray(value.messages) && Array.isArray(value.events)) completeStateCloneCalls += 1;
      return clone(value, ...options);
    };
    try { receipt = await session.dispatchWithReceipt(action, { includeState }); }
    finally { globalThis.structuredClone = clone; }
    assert.deepEqual(session.state, expected);
    assert.equal(receipt.cursor, 1);
    if (includeState) assert.deepEqual(receipt.state, expected);
    else assert.equal(Object.hasOwn(receipt, "state"), false);
    session.close();
    return { completeStateCloneCalls };
  }
  const baseline = await run(true);
  const current = await run(false);
  assert.equal(baseline.completeStateCloneCalls - current.completeStateCloneCalls, 1);
  return { input: { observers: 0, journal: false, dispatchesPerCase: 1, constructorExcluded: true },
    baseline: { strategy: "actual dispatchWithReceipt with includeState true", ...baseline },
    current: { strategy: "actual dispatchWithReceipt with includeState false", ...current },
    completeStateCloneCallsSaved: baseline.completeStateCloneCalls - current.completeStateCloneCalls,
    checks: { resultingStatesEqual: true, sameCursor: true, optionalSnapshotOmitted: true, globalCloneRestored: true },
    limitation: "counts calls receiving a complete state object, not bytes, nested clones, peak memory, or reducer copies avoided" };
}

function observeSessionPayloads(store, operation) {
  const metrics = { sessionQueries: 0, payloadCount: 0, payloadUtf8Bytes: 0 };
  const observer = observeDatabase(store, { reads(sql, rows) {
    if (!/\bFROM\s+sessions\b/i.test(sql)) return;
    metrics.sessionQueries += 1;
    for (const row of rows) {
      const value = row?.state_json ?? row?.stateJson;
      if (typeof value !== "string") continue;
      metrics.payloadCount += 1;
      metrics.payloadUtf8Bytes += Buffer.byteLength(value, "utf8");
    }
  } });
  observer.enabled = true;
  try { return { value: operation(), metrics }; }
  finally { observer.restore(); }
}

function observeDatabase(store, { writes = () => {}, reads = () => {} }) {
  const database = store.db;
  const upsert = store.upsert;
  const observer = { enabled: false, restore() { store.db = database; store.upsert = upsert; } };
  function wrap(statement, sql) {
    const isWrite = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
      || /^\s*WITH\b[\s\S]*\bUPDATE\s+sessions\b/i.test(sql);
    return new Proxy(statement, { get(target, member) {
      if (!["run", "get", "all"].includes(member)) return boundMember(target, member);
      return (...args) => {
        const result = target[member](...args);
        if (observer.enabled) {
          if (isWrite) writes(sql, args);
          if (member === "get") reads(sql, result ? [result] : []);
          if (member === "all") reads(sql, result);
        }
        return result;
      };
    } });
  }
  store.db = new Proxy(database, { get(target, member) {
    if (member !== "prepare") return boundMember(target, member);
    return (sql) => wrap(target.prepare(sql), sql);
  } });
  // The compatibility full-save statement is prepared in the constructor.
  if (upsert) store.upsert = wrap(upsert, "INSERT INTO sessions state_json (preprepared full-save statement)");
  return observer;
}

function isCompleteStateJson(value, id) {
  if (!value.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(value);
    return parsed?.id === id && Array.isArray(parsed.messages) && Array.isArray(parsed.events);
  } catch { return false; }
}

function atSecond(second) { return new Date(Date.UTC(2026, 8, 9, 0, 0, second)).toISOString(); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function percentageSaved(before, after) { return Number(((1 - after / before) * 100).toFixed(4)); }
function boundMember(target, member) {
  const value = Reflect.get(target, member, target);
  return typeof value === "function" ? value.bind(target) : value;
}

try {
  const report = await measure();
  assert.equal(report.checksPassed, true);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  // The durable report contains counts and fixed labels, never source records,
  // SQL bindings, temporary paths, endpoints, or arbitrary exception messages.
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? "measurement_assertion_failed" : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
