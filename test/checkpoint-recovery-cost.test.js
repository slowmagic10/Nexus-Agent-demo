import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession, migrateSessionState, reduceSession, SESSION_SCHEMA_VERSION } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { createStatePatch } from "../src/state-patch.js";

test("恢复最新有效 checkpoint 只物化一个快照，不随旧快照总量增长", (t) => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 96, padding: 16_000 });
    const aggregate = fixture.store.db.prepare(`
      SELECT COUNT(*) AS count, SUM(length(CAST(state_json AS BLOB))) AS bytes
      FROM session_checkpoints WHERE session_id = ?
    `).get(state.id);
    const stats = instrumentCheckpoints(fixture.store);

    assert.deepEqual(fixture.store.load(state.id), state);
    assert.equal(aggregate.count, 96);
    assert.equal(stats.payloads.length, 1, `实际物化 ${stats.payloads.length} 个 checkpoint`);
    assert.equal(stats.payloads[0].cursor, 97);
    assert.ok(stats.bytes < aggregate.bytes / 30);
    assert.equal(stats.activeIterators, 0);
    assert.equal(stats.iteratorReturns, 1);
    t.diagnostic(JSON.stringify({ candidateCount: aggregate.count, eagerPayloadBytes: aggregate.bytes,
      materializedCount: stats.payloads.length, materializedPayloadBytes: stats.bytes }));
  } finally { fixture.close(); }
});

test("坏 checkpoint 逐个降序回退，不以固定候选上限丢弃更早的有效快照", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 40 });
    fixture.store.db.prepare("UPDATE session_checkpoints SET checksum = 'bad' WHERE cursor > 2").run();
    // If recovery silently abandons the old valid checkpoint, full journal
    // replay would now fail on this damaged baseline.
    fixture.store.db.prepare("UPDATE session_events SET event_json = '{broken' WHERE seq = 1").run();
    const stats = instrumentCheckpoints(fixture.store);

    assert.deepEqual(fixture.store.load(state.id), state);
    assert.deepEqual(stats.payloads.map(({ cursor }) => cursor), Array.from({ length: 40 }, (_, i) => 41 - i));
    assert.equal(stats.activeIterators, 0);
    assert.equal(stats.iteratorReturns, 1);
  } finally { fixture.close(); }
});

test("checkpoint 检索同时保留 until 与 Session 隔离，只读取目标历史", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { id: "target", count: 12 });
    const expected = fixture.store.loadAt(state.id, 6);
    seedHistory(fixture.store, { id: "other", count: 20 });
    const stats = instrumentCheckpoints(fixture.store);

    assert.deepEqual(fixture.store.loadAt(state.id, 6), expected);
    assert.deepEqual(stats.payloads.map(({ id, cursor }) => ({ id, cursor })), [{ id: "target", cursor: 6 }]);
    assert.equal(stats.activeIterators, 0);
  } finally { fixture.close(); }
});

test("checksum 正确但 JSON、schema、Session ID 或 Journal cursor 无效仍回退", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 6 });
    replaceCheckpoint(fixture.store, state.id, 7, "{broken");
    replaceCheckpoint(fixture.store, state.id, 6, JSON.stringify({ ...state, schemaVersion: SESSION_SCHEMA_VERSION + 1 }));
    replaceCheckpoint(fixture.store, state.id, 5, JSON.stringify({ ...state, id: "wrong-session" }));
    replaceCheckpoint(fixture.store, state.id, 8, JSON.stringify(state));
    const stats = instrumentCheckpoints(fixture.store);

    assert.deepEqual(fixture.store.load(state.id), state);
    assert.deepEqual(stats.payloads.map(({ cursor }) => cursor), [8, 7, 6, 5, 4]);
    assert.equal(stats.activeIterators, 0);
  } finally { fixture.close(); }
});

test("所有 checkpoint 失效仍从原 Journal 恢复，不改写或删除旧 checkpoint", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 5 });
    fixture.store.db.prepare("UPDATE session_checkpoints SET checksum = 'bad'").run();
    const before = fixture.store.db.prepare("SELECT * FROM session_checkpoints ORDER BY cursor").all();
    const stats = instrumentCheckpoints(fixture.store);

    assert.deepEqual(fixture.store.load(state.id), state);
    assert.equal(stats.payloads.length, 5);
    assert.equal(stats.activeIterators, 0);
    assert.deepEqual(fixture.store.db.prepare("SELECT * FROM session_checkpoints ORDER BY cursor").all(), before);
  } finally { fixture.close(); }
});

test("checkpoint 旧 schema 继续迁移，Journal 原始导出和重定位导入保持可恢复", () => {
  const source = createFixture();
  const destination = createFixture();
  try {
    const state = seedHistory(source.store, { count: 4 });
    const legacy = { ...state, schemaVersion: 15 };
    delete legacy.displayTitle;
    replaceCheckpoint(source.store, state.id, 5, JSON.stringify(legacy));
    const stats = instrumentCheckpoints(source.store);

    assert.deepEqual(source.store.load(state.id), migrateSessionState(legacy));
    const archive = source.store.exportJournal(state.id);
    assert.equal("checkpoints" in archive, false);
    assert.deepEqual(archive.events.map(({ cursor }) => cursor), [1, 2, 3, 4, 5]);
    const imported = destination.store.importJournal(archive, { id: "imported", workspace: destination.workspace });
    assert.deepEqual(destination.store.load(imported.id), imported);
    assert.equal(imported.workspace, destination.workspace);
    assert.deepEqual(imported.messages, state.messages);
    assert.deepEqual(imported.memory, state.memory);
    assert.equal(stats.activeIterators, 0);
  } finally { source.close(); destination.close(); }
});

test("checkpoint 迭代期间 SQLite 查询失败会关闭 iterator 并保留原错误", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 3 });
    const stats = instrumentCheckpoints(fixture.store, { failEventExists: true });
    assert.throws(() => fixture.store.load(state.id), /instrumented event lookup failure/);
    assert.equal(stats.payloads.length, 1);
    assert.equal(stats.activeIterators, 0);
    assert.equal(stats.iteratorReturns, 1);
    // A subsequent ordinary SQLite write must not be left with an active
    // checkpoint read statement after the exceptional recovery path.
    fixture.store.db.exec("BEGIN IMMEDIATE; COMMIT;");
  } finally { fixture.close(); }
});

test("checkpoint iterator.next 抛错也会显式释放读取资源", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 3 });
    const stats = instrumentCheckpoints(fixture.store, { failNext: true });
    assert.throws(() => fixture.store.load(state.id), /instrumented iterator failure/);
    assert.equal(stats.activeIterators, 0);
    assert.equal(stats.iteratorReturns, 1);
  } finally { fixture.close(); }
});

test("缺少 statement.iterate 的旧 SQLite API 仍只物化最新一个有效 checkpoint", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 40 });
    const expectedAt = fixture.store.loadAt(state.id, 12);
    const stats = instrumentCheckpoints(fixture.store, { hideIterate: true });
    assert.deepEqual(fixture.store.load(state.id), state);
    assert.deepEqual(stats.payloads.map(({ cursor }) => cursor), [41]);
    assert.deepEqual(fixture.store.loadAt(state.id, 12), expectedAt);
    assert.deepEqual(stats.payloads.map(({ cursor }) => cursor), [41, 12]);
    assert.equal(stats.activeIterators, 0);
  } finally { fixture.close(); }
});

test("旧 SQLite API 逐条 keyset 回退，不限制坏 checkpoint 的候选数量", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 40 });
    fixture.store.db.prepare("UPDATE session_checkpoints SET checksum = 'bad' WHERE cursor > 2").run();
    fixture.store.db.prepare("UPDATE session_events SET event_json = '{broken' WHERE seq = 1").run();
    const stats = instrumentCheckpoints(fixture.store, { hideIterate: true });
    assert.deepEqual(fixture.store.load(state.id), state);
    assert.deepEqual(stats.payloads.map(({ cursor }) => cursor), Array.from({ length: 40 }, (_, i) => 41 - i));
  } finally { fixture.close(); }
});

test("旧 SQLite API 所有 checkpoint 无效时仍从原 Journal 恢复", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 4 });
    fixture.store.db.prepare("UPDATE session_checkpoints SET checksum = 'bad'").run();
    const stats = instrumentCheckpoints(fixture.store, { hideIterate: true });
    assert.deepEqual(fixture.store.load(state.id), state);
    assert.deepEqual(stats.payloads.map(({ cursor }) => cursor), [5, 4, 3, 2]);
  } finally { fixture.close(); }
});

test("checkpoint iterator 关闭也失败时保留原始读取错误", () => {
  const fixture = createFixture();
  try {
    const state = seedHistory(fixture.store, { count: 3 });
    const stats = instrumentCheckpoints(fixture.store, { failNext: true, failReturn: true });
    assert.throws(() => fixture.store.load(state.id), /instrumented iterator failure/);
    assert.equal(stats.activeIterators, 0);
    assert.equal(stats.iteratorReturns, 1);
  } finally { fixture.close(); }
});

function createFixture() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-checkpoint-cost-"));
  const store = new SessionStore(path.join(workspace, "session.sqlite"), { workspace, checkpointInterval: 1 });
  return { workspace, store, close() { store.close(); rmSync(workspace, { recursive: true, force: true }); } };
}

function seedHistory(store, { id = "checkpoint-history", count, padding = 0 }) {
  let state = createSession({ id, provider: "demo", workspace: store.workspace, createdAt: "2026-09-09T00:00:00.000Z" });
  if (padding) state = reduceSession(state, { type: "USER_MESSAGE", content: "a".repeat(padding), at: state.createdAt });
  store.ensureJournal(state);
  for (let index = 0; index < count; index += 1) {
    const action = { type: "MEMORY_ADDED", content: `记忆 ${index}`, at: new Date(Date.UTC(2026, 8, 9, 0, 0, index + 1)).toISOString() };
    const next = reduceSession(state, action);
    store.commitSessionEvent(next, action, createStatePatch(state, next));
    state = next;
  }
  return state;
}

function replaceCheckpoint(store, id, cursor, stateJson) {
  const checksum = `sha256:${createHash("sha256").update(`${id}\n${cursor}\n${stateJson}`).digest("hex")}`;
  store.db.prepare(`
    INSERT INTO session_checkpoints (session_id, cursor, state_json, checksum, created_at)
    VALUES (?, ?, ?, ?, '2026-09-09T00:00:00.000Z')
    ON CONFLICT(session_id, cursor) DO UPDATE SET state_json = excluded.state_json, checksum = excluded.checksum
  `).run(id, cursor, stateJson, checksum);
}

// Instrument only data crossing the real SQLite -> JS checkpoint boundary.
// Neither wall-clock timing nor heap/GC behavior is used as an assertion.
function instrumentCheckpoints(store, { failEventExists = false, failNext = false, hideIterate = false, failReturn = false } = {}) {
  const stats = { payloads: [], bytes: 0, activeIterators: 0, iteratorReturns: 0 };
  const observe = (row) => {
    if (typeof row?.stateJson !== "string") return;
    stats.payloads.push({ cursor: row.cursor, id: (() => { try { return JSON.parse(row.stateJson).id; } catch { return null; } })() });
    stats.bytes += Buffer.byteLength(row.stateJson);
  };
  const database = store.db;
  store.db = new Proxy(database, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql) => {
        const statement = target.prepare(sql);
        const checkpointQuery = /FROM\s+session_checkpoints\b/i.test(sql) && /state_json\s+AS\s+stateJson/i.test(sql);
        const eventExists = /SELECT 1 AS found FROM session_events WHERE session_id = \? AND seq = \?/.test(sql);
        return new Proxy(statement, {
          get(value, method) {
            if (failEventExists && eventExists && method === "get") return () => { throw new Error("instrumented event lookup failure"); };
            if (hideIterate && checkpointQuery && method === "iterate") return undefined;
            if (checkpointQuery && method === "all") return (...args) => {
              const rows = value.all(...args); rows.forEach(observe); return rows;
            };
            if (checkpointQuery && method === "get") return (...args) => {
              const row = value.get(...args); observe(row); return row;
            };
            if (checkpointQuery && method === "iterate") return (...args) => {
              const iterator = value.iterate(...args);
              let active = true;
              stats.activeIterators += 1;
              const close = () => { if (active) { stats.activeIterators -= 1; active = false; } };
              return {
                [Symbol.iterator]() { return this; },
                next() {
                  if (failNext) throw new Error("instrumented iterator failure");
                  const result = iterator.next();
                  if (result.done) close(); else observe(result.value);
                  return result;
                },
                return() {
                  stats.iteratorReturns += 1;
                  close();
                  const result = iterator.return();
                  if (failReturn) throw new Error("instrumented iterator close failure");
                  return result;
                },
              };
            };
            const member = Reflect.get(value, method, value);
            return typeof member === "function" ? member.bind(value) : member;
          },
        });
      };
    },
  });
  return stats;
}
