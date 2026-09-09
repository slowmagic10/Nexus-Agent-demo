import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession, SESSION_SCHEMA_VERSION } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { redactSensitiveValue } from "../src/security/redact.js";
import { createStatePatch } from "../src/state-patch.js";

test("每次增量提交保留完整脱敏缓存，重新打开和归档导入仍恢复同一状态", async (t) => {
  const f = fixture(t, { checkpointInterval: 4 });
  const session = makeSession(f);
  assert.equal(cacheRow(f, session.id).cache_cursor, 1);
  const actions = [
    { type: "USER_MESSAGE", content: "实现缓存；password='private-value'" },
    { type: "MEMORY_ADDED", content: "保留已有历史" },
    { type: "SESSION_DISPLAY_TITLE_CHANGED", title: "缓存实现" },
    { type: "MEMORY_ADDED", content: "checkpoint 之后继续追加" },
  ];
  for (const action of actions) {
    await session.dispatch(action);
    assertCacheState(f, session);
    assert.deepEqual(f.store.load(session.id), session.state);
  }
  const reopened = new SessionStore(f.store.file, { workspace: f.workspace });
  try { assert.deepEqual(reopened.load(session.id), session.state); }
  finally { reopened.close(); }
  const target = fixture(t);
  const imported = target.store.importJournal(f.store.exportJournal(session.id), {
    id: "imported-cache-history", workspace: target.workspace,
  });
  assert.deepEqual(target.store.load(imported.id), imported);
  assert.deepEqual(JSON.parse(cacheRow(target, imported.id).state_json), redactSensitiveValue(imported));
  assert.equal(cacheRow(target, imported.id).cache_cursor, target.store.latestSessionCursor(imported.id));
});

test("旧 direct commit 的不完整 patch 仍以 nextState 完整刷新兼容缓存", (t) => {
  const f = fixture(t);
  const initial = createSession({ provider: "demo", workspace: f.workspace });
  f.store.ensureJournal(initial);
  const action = { type: "USER_MESSAGE", content: "旧调用没有传完整 patch", at: "2026-09-09T01:00:00.000Z" };
  const next = reduceSession(initial, action);
  const event = f.store.commitSessionEvent(next, action, {});
  assert.equal(event.cursor, 2);
  assert.equal(cacheRow(f, initial.id).cache_cursor, null);
  assert.deepEqual(JSON.parse(cacheRow(f, initial.id).state_json), redactSensitiveValue(next));
  assert.deepEqual(f.store.load(initial.id), next);
});

test("显式 save 不把兼容快照冒充为已验证的 Journal 缓存，下一次 Session 提交修复它", async (t) => {
  const f = fixture(t);
  const session = makeSession(f);
  await session.dispatch({ type: "USER_MESSAGE", content: "真实历史" });
  const expected = session.state;
  f.store.save({ ...expected, messages: [], events: [], displayTitle: "外部保存的标题" });
  assert.equal(cacheRow(f, session.id).cache_cursor, null);
  assert.equal(f.store.list(f.workspace)[0].title, "外部保存的标题");
  assert.deepEqual(f.store.load(session.id), expected);
  await session.dispatch({ type: "MEMORY_ADDED", content: "完整刷新后继续" });
  assertCacheState(f, session);
});

test("旧 writer 覆盖 state_json 会作废 cursor 和标题，后续提交不在陈旧正文上追加", async (t) => {
  const f = fixture(t);
  const session = makeSession(f);
  await session.dispatch({ type: "USER_MESSAGE", content: "必须保留的真实消息" });
  const before = cacheRow(f, session.id);
  const stale = { ...session.state, messages: [], events: [], displayTitle: "服务器地址: prod.internal" };
  f.store.db.prepare("UPDATE sessions SET state_json = ? WHERE id = ?").run(JSON.stringify(stale), session.id);
  const invalidated = cacheRow(f, session.id);
  assert.equal(invalidated.cache_cursor, null);
  assert.equal(invalidated.display_title, null);
  assert.equal(invalidated.cache_generation, before.cache_generation);
  assert.equal(f.store.list(f.workspace)[0].title, "受保护任务");
  assert.deepEqual(f.store.load(session.id), session.state);
  await session.dispatch({ type: "MEMORY_ADDED", content: "使用 Journal 基态刷新" });
  assertCacheState(f, session);
});

test("重复显式 save 和无 Journal 旧状态保持可列出、可恢复并正确建立基线", (t) => {
  const f = fixture(t);
  let state = createSession({ provider: "demo", workspace: f.workspace });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "无 Journal 的旧状态" });
  f.store.save(state);
  f.store.save(state);
  assert.equal(cacheRow(f, state.id).cache_cursor, null);
  assert.equal(f.store.list(f.workspace)[0].title, "无 Journal 的旧状态");
  assert.deepEqual(f.store.load(state.id), state);
  assert.deepEqual(f.store.ensureJournal(state), state);
  assert.equal(cacheRow(f, state.id).cache_cursor, 1);
  assert.deepEqual(f.store.load(state.id), state);
});

for (const [label, body] of [
  ["无效 JSON", () => "{broken"],
  ["JSON 原始值", () => '"a scalar"'],
  ["JSON 数组", () => "[]"],
  ["其他 Session ID", (state) => JSON.stringify({ ...state, id: "wrong-session", messages: [] })],
  ["旧 schema", (state) => JSON.stringify({ ...state, schemaVersion: 17, messages: [] })],
]) {
  test(`即使缓存游标匹配，${label}也必须完整刷新`, async (t) => {
    const f = fixture(t);
    const session = makeSession(f);
    await session.dispatch({ type: "USER_MESSAGE", content: "校验缓存资格" });
    // Preserve the candidate cursor while deliberately changing generation to
    // exercise eligibility checks independently of the legacy-writer trigger.
    f.store.db.prepare(`UPDATE sessions SET state_json = ?, cache_generation = cache_generation + 1
      WHERE id = ?`).run(body(session.state), session.id);
    assert.equal(cacheRow(f, session.id).cache_cursor, session.cursor);
    await session.dispatch({ type: "MEMORY_ADDED", content: "资格不符时修复" });
    assertCacheState(f, session);
  });
}

test("恢复 schema17 基线后首次提交把迁移所得字段同步到完整缓存", async (t) => {
  const f = fixture(t);
  const legacy = { ...createSession({ provider: "demo", workspace: f.workspace }), schemaVersion: 17 };
  f.store.ensureJournal(legacy);
  assert.equal(JSON.parse(cacheRow(f, legacy.id).state_json).schemaVersion, 17);
  const restored = new AgentSession({ state: f.store.load(legacy.id), reducer: reduceSession, journal: f.store });
  assert.equal(restored.state.schemaVersion, SESSION_SCHEMA_VERSION);
  await restored.dispatch({ type: "MEMORY_ADDED", content: "迁移后普通动作" });
  assertCacheState(f, restored);
});

test("当前 schema 的恢复标题规范化也会同步进完整缓存", async (t) => {
  const f = fixture(t);
  const initial = { ...createSession({ provider: "demo", workspace: f.workspace }), displayTitle: "  含   空白标题  " };
  f.store.ensureJournal(initial);
  const restored = new AgentSession({ state: initial, reducer: reduceSession, journal: f.store });
  assert.equal(restored.state.displayTitle, "含 空白标题");
  await restored.dispatch({ type: "MEMORY_ADDED", content: "与标题无关的动作" });
  assertCacheState(f, restored);
});

test("Journal 恢复不读取缓存正文，旧缓存损坏的列表仍明确报错", async (t) => {
  const f = fixture(t);
  const session = makeSession(f);
  await session.dispatch({ type: "USER_MESSAGE", content: "从 Journal 恢复" });
  f.store.db.prepare("UPDATE sessions SET state_json = '{broken' WHERE id = ?").run(session.id);
  assert.throws(() => f.store.list(f.workspace), /损坏|JSON|json/i);
  const database = f.store.db;
  const cacheReads = [];
  f.store.db = new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql) => {
        if (/\bSELECT\b[\s\S]*\bstate_json\b[\s\S]*\bFROM\s+sessions\b/i.test(sql)) cacheReads.push(sql);
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try { assert.deepEqual(f.store.load(session.id), session.state); }
  finally { f.store.db = database; }
  assert.deepEqual(cacheReads, [], "Journal 路径不应先读取不被使用的完整缓存");
  await session.dispatch({ type: "MEMORY_ADDED", content: "修复缓存" });
  assertCacheState(f, session);
});

test("并发 Session 的旧基态提交被拒绝，不推进状态、游标或通知", async (t) => {
  const f = fixture(t);
  const first = makeSession(f);
  const stale = new AgentSession({ state: first.state, reducer: reduceSession, journal: f.store });
  const before = stale.state;
  let states = 0;
  let events = 0;
  stale.subscribe(() => { states += 1; });
  stale.subscribeEvents(() => { events += 1; }, { after: stale.cursor });
  await first.dispatch({ type: "USER_MESSAGE", content: "先成功的请求" });
  await assert.rejects(stale.dispatch({ type: "USER_MESSAGE", content: "来自旧状态的请求" }), /cursor|游标|过期|并发|冲突/i);
  assert.deepEqual(stale.state, before);
  assert.equal(stale.cursor, 1);
  assert.equal(states, 0);
  assert.equal(events, 0);
  assert.equal(f.store.latestSessionCursor(first.id), 2);
  assertCacheState(f, first);
  assert.deepEqual(f.store.load(first.id), first.state);
});

test("checkpoint 写入失败回滚事件、缓存和小投影，且同一 Session 可重试", async (t) => {
  const f = fixture(t, { checkpointInterval: 3 });
  const session = makeSession(f);
  await session.dispatch({ type: "USER_MESSAGE", content: "checkpoint 前的状态" });
  const beforeState = session.state;
  const beforeRow = cacheRow(f, session.id);
  let notifications = 0;
  session.subscribe(() => { notifications += 1; });
  f.store.db.exec(`CREATE TRIGGER fail_test_checkpoint BEFORE INSERT ON session_checkpoints
    BEGIN SELECT RAISE(ABORT, 'checkpoint write failure'); END;`);
  await assert.rejects(session.dispatch({ type: "SESSION_DISPLAY_TITLE_CHANGED", title: "不应提前公开" }), /checkpoint write failure/);
  assert.deepEqual(session.state, beforeState);
  assert.deepEqual(cacheRow(f, session.id), beforeRow);
  assert.equal(session.cursor, 2);
  assert.equal(f.store.latestSessionCursor(session.id), 2);
  assert.equal(notifications, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM session_checkpoints").get().n, 0);
  f.store.db.exec("DROP TRIGGER fail_test_checkpoint");
  await session.dispatch({ type: "SESSION_DISPLAY_TITLE_CHANGED", title: "重试成功" });
  assertCacheState(f, session);
  assert.equal(f.store.list(f.workspace)[0].title, "重试成功");
  assert.equal(notifications, 1);
});

test("安全标题小投影随首消息及重命名同步，不暴露连接信息", async (t) => {
  const f = fixture(t);
  const session = makeSession(f);
  await session.dispatch({ type: "USER_MESSAGE", content: "SSH 到 root@192.168.121.110 部署" });
  assert.equal(cacheRow(f, session.id).display_title, "受保护任务");
  assert.equal(f.store.list(f.workspace)[0].title, "受保护任务");
  await session.dispatch({ type: "SESSION_DISPLAY_TITLE_CHANGED", title: "部署验证" });
  assert.equal(cacheRow(f, session.id).display_title, "部署验证");
  assert.equal(f.store.list(f.workspace)[0].title, "部署验证");
  await session.dispatch({ type: "SESSION_DISPLAY_TITLE_CHANGED", title: "服务器地址: prod.internal" });
  assert.equal(cacheRow(f, session.id).display_title, "受保护任务");
  assertCacheState(f, session);
});

for (const [label, alter] of [
  ["缺失", (state) => { delete state.memory; }],
  ["非数组", (state) => { state.memory = "不是数组"; }],
]) {
  test(`SQL append 目标${label}时完整刷新，不丢失其他状态字段`, async (t) => {
    const f = fixture(t);
    const session = makeSession(f);
    await session.dispatch({ type: "USER_MESSAGE", content: "完整状态不能被局部缓存故障破坏" });
    const corrupt = session.state;
    alter(corrupt);
    f.store.db.prepare(`UPDATE sessions SET state_json = ?, cache_generation = cache_generation + 1
      WHERE id = ?`).run(JSON.stringify(corrupt), session.id);
    await session.dispatch({ type: "MEMORY_ADDED", content: "追加需要一个数组" });
    assertCacheState(f, session);
    assert.deepEqual(f.store.load(session.id), session.state);
  });
}

for (const [label, additions] of [
  ["超过 128 项", Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`custom_${index}`, `value ${index}`]))],
  ["包含特殊键", { "path.with.dots": "字面字段", "含中文字段": [null, { value: "保留类型" }] }],
]) {
  test(`补丁${label}时仍完整保存自定义 reducer 的结果`, async (t) => {
    const f = fixture(t);
    const initial = createSession({ provider: "demo", workspace: f.workspace });
    const session = new AgentSession({ state: initial, journal: f.store,
      reducer: (state, action) => ({ ...reduceSession(state, action), ...additions }),
    });
    await session.dispatch({ type: "USER_MESSAGE", content: "不支持的优化形状仍保持保存语义" });
    assertCacheState(f, session);
    for (const [key, value] of Object.entries(additions)) assert.deepEqual(session.state[key], value);
  });
}

test("缓存 UPDATE 失败回滚已插入的 Journal 事件，随后可正常重试", async (t) => {
  const f = fixture(t);
  const session = makeSession(f);
  const beforeState = session.state;
  const beforeRow = cacheRow(f, session.id);
  let notifications = 0;
  session.subscribe(() => { notifications += 1; });
  f.store.db.exec(`CREATE TRIGGER fail_test_cache BEFORE UPDATE OF state_json ON sessions
    BEGIN SELECT RAISE(ABORT, 'cache write failure'); END;`);
  await assert.rejects(session.dispatch({ type: "USER_MESSAGE", content: "缓存事务必须原子" }), /cache write failure/);
  assert.deepEqual(session.state, beforeState);
  assert.deepEqual(cacheRow(f, session.id), beforeRow);
  assert.equal(session.cursor, 1);
  assert.equal(f.store.latestSessionCursor(session.id), 1);
  assert.equal(notifications, 0);
  f.store.db.exec("DROP TRIGGER fail_test_cache");
  await session.dispatch({ type: "USER_MESSAGE", content: "故障解除后的重试" });
  assert.equal(notifications, 1);
  assertCacheState(f, session);
});

test("真实旧数据库迁移留下未认证缓存，安全回查标题后首次提交完整刷新", async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-cache-legacy-"));
  const file = path.join(workspace, "session.sqlite");
  const legacyDb = new DatabaseSync(file);
  let state = createSession({ provider: "demo", workspace });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "SSH 到 root@192.168.121.110 部署" });
  legacyDb.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    provider TEXT NOT NULL, workspace TEXT NOT NULL, phase TEXT NOT NULL,
    message_count INTEGER NOT NULL, state_json TEXT NOT NULL
  );
  CREATE TABLE session_events (
    session_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL,
    event_json TEXT NOT NULL, PRIMARY KEY(session_id, seq)
  );`);
  legacyDb.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    state.id, state.createdAt, state.updatedAt, state.provider, workspace, state.phase,
    state.messages.length, JSON.stringify(state),
  );
  legacyDb.prepare("INSERT INTO session_events VALUES (?, 1, ?, 'SESSION_BASELINE', ?)").run(
    state.id, state.createdAt, JSON.stringify({ type: "SESSION_BASELINE", at: state.createdAt, state }),
  );
  legacyDb.close();
  const store = new SessionStore(file, { workspace });
  t.after(() => { store.close(); rmSync(workspace, { recursive: true, force: true }); });
  const f = { workspace, store };
  assert.equal(cacheRow(f, state.id).cache_cursor, null);
  assert.equal(cacheRow(f, state.id).display_title, null);
  assert.equal(store.list(workspace)[0].title, "受保护任务");
  assert.deepEqual(store.load(state.id), state);
  const session = new AgentSession({ state: store.load(state.id), journal: store, reducer: reduceSession });
  await session.dispatch({ type: "MEMORY_ADDED", content: "迁移后继续" });
  assertCacheState(f, session);
  assert.equal(store.list(workspace)[0].title, "受保护任务");
});

test("Session 初始化使用同次恢复 receipt，不再组合旧 ensureJournal 的状态和独立 head", async (t) => {
  const f = fixture(t);
  const initial = makeSession(f);
  await initial.dispatch({ type: "USER_MESSAGE", content: "应从同一事实边界恢复" });
  const legacyEnsure = f.store.ensureJournal;
  f.store.ensureJournal = () => { throw new Error("不应调用旧状态恢复接口"); };
  let restored;
  try { restored = new AgentSession({ state: initial.state, reducer: reduceSession, journal: f.store }); }
  finally { f.store.ensureJournal = legacyEnsure; }
  assert.deepEqual(restored.state, initial.state);
  assert.equal(restored.cursor, initial.cursor);
  assert.deepEqual(
    restored.prepareModelRequest({ systemPrompt: () => "恢复", tools: [] }).messages,
    initial.prepareModelRequest({ systemPrompt: () => "恢复", tools: [] }).messages,
  );
});

test("恢复事务阻止第二连接在状态与 head 之间插入，释放事务后旧 receipt 提交明确冲突", async (t) => {
  const f = fixture(t);
  const initial = makeSession(f);
  const before = initial.state;
  const writer = new SessionStore(f.store.file, { workspace: f.workspace });
  const action = { type: "USER_MESSAGE", content: "第二连接的已提交消息", at: "2026-09-09T02:00:00.000Z" };
  const next = reduceSession(before, action);
  const patch = createStatePatch(before, next);
  const project = f.store.readProjectionEvents.bind(f.store);
  let blockedWrites = 0;
  f.store.readProjectionEvents = (...args) => {
    const events = project(...args);
    assert.throws(() => writer.commitSessionEvent(next, action, patch, { expectedCursor: initial.cursor }), /locked|busy/i);
    blockedWrites += 1;
    return events;
  };
  try {
    const restored = new AgentSession({ state: before, reducer: reduceSession, journal: f.store });
    f.store.readProjectionEvents = project;
    assert.equal(blockedWrites, 1);
    assert.deepEqual(restored.state, before);
    assert.equal(restored.cursor, initial.cursor);
    const committed = writer.commitSessionEvent(next, action, patch, { expectedCursor: initial.cursor });
    assert.equal(committed.cursor, initial.cursor + 1);
    let notifications = 0;
    restored.subscribe(() => { notifications += 1; });
    await assert.rejects(restored.dispatch({ type: "MEMORY_ADDED", content: "不应基于旧 receipt 覆盖" }), /cursor|游标|冲突/i);
    assert.equal(notifications, 0);
    assert.deepEqual(restored.state, before);
    assert.equal(restored.cursor, initial.cursor);
    assert.deepEqual(writer.load(initial.id), next);
    assert.deepEqual(JSON.parse(cacheRow(f, initial.id).state_json), redactSensitiveValue(next));
  } finally {
    f.store.readProjectionEvents = project;
    writer.close();
  }
});

test("有认证缓存但 Journal 已丢失时，恢复 receipt 不用传入状态重新制造基线", (t) => {
  const f = fixture(t);
  const session = makeSession(f);
  const before = cacheRow(f, session.id);
  f.store.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(session.id);
  assert.throws(() => f.store.load(session.id), /基线|Journal|事件日志/i);
  assert.throws(() => f.store.ensureJournalWithReceipt(session.state), /基线|Journal|事件日志/i);
  assert.throws(() => new AgentSession({ state: session.state, reducer: reduceSession, journal: f.store }), /基线|Journal|事件日志/i);
  assert.deepEqual(cacheRow(f, session.id), before);
  assert.equal(f.store.latestSessionCursor(session.id), 0);
});

function fixture(t, options = {}) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-session-cache-"));
  const store = new SessionStore(path.join(workspace, "session.sqlite"), { workspace, ...options });
  t.after(() => { store.close(); rmSync(workspace, { recursive: true, force: true }); });
  return { workspace, store };
}

function makeSession(f) {
  return new AgentSession({ state: createSession({ provider: "demo", workspace: f.workspace }), reducer: reduceSession, journal: f.store });
}

function cacheRow(f, id) {
  return f.store.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
}

function assertCacheState(f, session) {
  const row = cacheRow(f, session.id);
  assert.equal(row.cache_cursor, session.cursor);
  assert.deepEqual(JSON.parse(row.state_json), redactSensitiveValue(session.state));
  assert.equal(row.message_count, session.state.messages.length);
  assert.equal(row.phase, session.state.phase);
  assert.equal(row.updated_at, session.state.updatedAt);
}
