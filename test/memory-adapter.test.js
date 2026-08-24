import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assertMemoryInspection, assertMemoryInterface } from "../src/memory/interface.js";
import { SQLiteMemoryAdapter } from "../src/memory/sqlite-adapter.js";
import { migrateDatabase } from "../src/persistence/migrations.js";

test("SQLite Memory Adapter 按 scope 检索并返回完整 provenance", async () => {
  const fixture = createFixture();
  try {
    assert.equal(assertMemoryInterface(fixture.memory), fixture.memory);
    assert.equal(fixture.memory.capabilities.mutationIdempotency, "mutation-key");
    assert.equal(assertMemoryInspection(fixture.memory), fixture.memory);
    const record = await fixture.memory.add({
      content: "用户偏好本地模型 OPENAI_API_KEY=sk-1234567890abcdefghijklmnop",
      kind: "preference",
      confidence: 0.95,
      tags: ["preference", "local"],
    }, access(fixture, { origin: "user_explicit", actor: "local-user" }));

    assert.match(record.content, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.equal((await fixture.memory.search("本地", access(fixture), { limit: 5 }))[0].adapter, "sqlite-lexical");
    assert.equal((await fixture.memory.search("preference", access(fixture), { limit: 5 }))[0].id, record.id);
    assert.deepEqual(await fixture.memory.search("本地", access(fixture, {}, { workspace: "/other" })), []);

    const verification = await fixture.memory.verify(record.id, access(fixture));
    assert.equal(verification.record.sourceSession, null);
    assert.equal(verification.record.sourceCursor, null);
    assert.equal(verification.events[0].type, "memory.added");
    assert.equal(verification.events[0].provenance.origin, "user_explicit");
  } finally {
    fixture.close();
  }
});

test("重复事实合并到同一条 Memory Record", async () => {
  const fixture = createFixture();
  try {
    const first = await fixture.memory.add({ content: "项目使用 Node.js", tags: ["runtime"] }, access(fixture));
    const second = await fixture.memory.add({ content: "项目使用 Node.js", tags: ["project"] }, access(fixture));

    assert.equal(second.id, first.id);
    assert.equal(second.version, 2);
    assert.deepEqual(second.tags.sort(), ["project", "runtime"]);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 1);
    assert.deepEqual((await fixture.memory.verify(first.id, access(fixture))).events.map((event) => event.type), [
      "memory.added",
      "memory.observed_again",
    ]);
  } finally {
    fixture.close();
  }
});

test("更新、替代和删除都保留软删除状态与审计历史", async () => {
  const fixture = createFixture();
  try {
    const oldRecord = await fixture.memory.add({ content: "使用旧接口" }, access(fixture));
    const replacement = await fixture.memory.add({ content: "使用新接口" }, access(fixture));
    const updated = await fixture.memory.update(oldRecord.id, { kind: "decision", confidence: 0.9 }, access(fixture));
    assert.equal(updated.kind, "decision");
    assert.equal(updated.version, 2);

    const superseded = await fixture.memory.supersede(oldRecord.id, replacement.id, access(fixture));
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.replacementId, replacement.id);
    assert.deepEqual(await fixture.memory.search("旧接口", access(fixture)), []);

    assert.equal(await fixture.memory.delete(replacement.id, "用户要求忘记", access(fixture)), true);
    assert.equal(await fixture.memory.delete(replacement.id, "重复删除", access(fixture)), false);
    assert.equal(await fixture.memory.get(replacement.id, access(fixture)), null);
    const deleted = await fixture.memory.verify(replacement.id, access(fixture));
    assert.equal(deleted.record.status, "deleted");
    assert.equal(deleted.record.deletedReason, "用户要求忘记");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 2);
    assert.deepEqual(deleted.events.map((event) => event.type), ["memory.added", "memory.deleted"]);
  } finally {
    fixture.close();
  }
});

test("已过期 Memory 不会进入检索结果", async () => {
  const fixture = createFixture();
  try {
    await fixture.memory.add({
      content: "临时任务信息",
      expiresAt: "2026-08-19T00:00:00.000Z",
    }, access(fixture));
    assert.deepEqual(await fixture.memory.search("临时", access(fixture)), []);
  } finally {
    fixture.close();
  }
});

test("Adapter 拒绝非法终态创建和不可变字段更新", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      fixture.memory.add({ content: "非法终态", status: "deleted" }, access(fixture)),
      /只能是 active 或 candidate/,
    );
    const record = await fixture.memory.add({ content: "合法事实" }, access(fixture));
    await assert.rejects(
      fixture.memory.update(record.id, { id: "memory-rewritten" }, access(fixture)),
      /不可修改字段：id/,
    );
    assert.equal((await fixture.memory.get(record.id, access(fixture))).version, 1);
  } finally {
    fixture.close();
  }
});

test("所有 ID 操作都按 caller scope 隔离且普通更新不能移动 scope", async () => {
  const fixture = createFixture();
  try {
    const record = await fixture.memory.add({ content: "仅 A 可见" }, access(fixture));
    const other = access(fixture, {}, { workspace: "/other", agentId: "other" });

    assert.equal(await fixture.memory.get(record.id, other), null);
    assert.equal(await fixture.memory.verify(record.id, other), null);
    assert.equal(await fixture.memory.delete(record.id, "越权删除", other), false);
    await assert.rejects(fixture.memory.update(record.id, { content: "越权修改" }, other), /未找到可更新/);
    await assert.rejects(
      fixture.memory.update(record.id, { scope: other.scope }, access(fixture)),
      /不可修改字段：scope/,
    );
    assert.equal((await fixture.memory.get(record.id, access(fixture))).status, "active");
  } finally {
    fixture.close();
  }
});

test("SQLite Adapter 暴露统一 Promise 契约并要求 Inspection capability", async () => {
  const fixture = createFixture();
  try {
    const pending = fixture.memory.search("", access(fixture));
    assert.ok(pending instanceof Promise);
    await pending;
    assert.throws(
      () => assertMemoryInspection({ search() {}, add() {}, update() {}, supersede() {}, delete() {}, flush() {} }),
      /get, verify/,
    );
    assert.throws(
      () => assertMemoryInterface({ search() {}, add() {}, update() {}, supersede() {}, delete() {}, flush() {} }),
      /mutationIdempotency/,
    );
  } finally {
    fixture.close();
  }
});

test("lexical 排序在 LIMIT 前优先保留旧 exact match", async () => {
  const fixture = createFixture();
  try {
    const exact = await fixture.memory.add({ content: "needle" }, access(fixture));
    fixture.setClock("2026-08-20T00:01:00.000Z");
    await fixture.memory.add({ content: "newer contains needle text" }, access(fixture));

    const [hit] = await fixture.memory.search("needle", access(fixture), { limit: 1 });
    assert.equal(hit.id, exact.id);
    assert.equal(hit.score, 1);
  } finally {
    fixture.close();
  }
});

test("不存在的本地 provenance 不得伪装成可验证来源", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      fixture.memory.add({ content: "伪造来源" }, access(fixture, {
        origin: "tool",
        sessionId: "missing-session",
        sourceCursor: 999,
        toolCallId: "missing-call",
      })),
      /provenance 来源不存在/,
    );
  } finally {
    fixture.close();
  }
});

test("本地 provenance 的来源 Session 必须属于当前 Memory scope", async () => {
  const fixture = createFixture();
  try {
    const otherScope = { workspace: fixture.scope.workspace, agentId: "other-agent", userId: "other-user" };
    const now = "2026-08-20T00:00:00.000Z";
    fixture.db.prepare(`
      INSERT INTO sessions (id, created_at, updated_at, provider, workspace, phase, message_count, state_json)
      VALUES (?, ?, ?, 'test', ?, 'idle', 0, ?)
    `).run("session-other", now, now, fixture.scope.workspace, JSON.stringify({
      id: "session-other",
      workspace: fixture.scope.workspace,
      memoryScope: otherScope,
    }));
    fixture.db.prepare(`
      INSERT INTO session_events (session_id, seq, at, type, event_json, schema_version)
      VALUES (?, 1, ?, 'SESSION_BASELINE', ?, 1)
    `).run("session-other", now, JSON.stringify({
      type: "SESSION_BASELINE",
      at: now,
      state: {
        id: "session-other",
        workspace: fixture.scope.workspace,
        memoryScope: otherScope,
      },
    }));
    fixture.db.prepare(`
      INSERT INTO session_events (session_id, seq, at, type, event_json, schema_version)
      VALUES (?, 2, ?, 'TOOL_REQUESTED', ?, 1)
    `).run("session-other", now, JSON.stringify({
      action: { type: "TOOL_REQUESTED", call: { id: "call-other", name: "memory_save", arguments: {} } },
    }));

    await assert.rejects(
      fixture.memory.add({ content: "跨 scope 来源" }, access(fixture, {
        origin: "tool",
        sessionId: "session-other",
        sourceCursor: 2,
        toolCallId: "call-other",
      })),
      /provenance 来源 Session 不属于当前 Memory scope/,
    );
  } finally {
    fixture.close();
  }
});

test("mutationId 重用时必须绑定相同规范化请求内容", async () => {
  const fixture = createFixture();
  try {
    const mutationAccess = { ...access(fixture), mutationId: "mutation-payload-bound" };
    const first = await fixture.memory.add({ content: "payload alpha", tags: ["one"] }, mutationAccess);
    const replay = await fixture.memory.add({ tags: ["one"], content: "payload alpha" }, mutationAccess);
    assert.equal(replay.id, first.id);

    await assert.rejects(
      fixture.memory.add({ content: "payload beta", tags: ["changed"] }, mutationAccess),
      /mutationId 请求内容冲突/,
    );
    assert.deepEqual(await fixture.memory.search("payload beta", access(fixture)), []);
  } finally {
    fixture.close();
  }
});

test("legacy NULL request_hash 不允许自动 replay", async () => {
  const fixture = createFixture();
  try {
    const mutationAccess = { ...access(fixture), mutationId: "mutation-legacy-null-hash" };
    await fixture.memory.add({ content: "legacy alpha" }, mutationAccess);
    fixture.db.prepare(
      "UPDATE memory_mutations SET request_hash = NULL WHERE mutation_id = ?",
    ).run(mutationAccess.mutationId);

    await assert.rejects(
      fixture.memory.add({ content: "legacy beta" }, mutationAccess),
      /legacy mutationId.*无法验证请求内容.*人工处理/,
    );
    assert.deepEqual(await fixture.memory.search("legacy beta", access(fixture)), []);
  } finally {
    fixture.close();
  }
});

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nexus-memory-adapter-"));
  const db = new DatabaseSync(path.join(root, "memory.db"));
  migrateDatabase(db);
  let id = 0;
  const scope = { workspace: "/repo", agentId: "default", userId: "local" };
  let now = "2026-08-20T00:00:00.000Z";
  const memory = new SQLiteMemoryAdapter({
    db,
    defaultScope: scope,
    clock: () => new Date(now),
    idFactory: () => `memory-test-${++id}`,
  });
  return {
    root,
    db,
    memory,
    scope,
    setClock(value) { now = value; },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function access(fixture, provenance = { origin: "user_explicit" }, scope = fixture.scope) {
  return { scope, provenance };
}
