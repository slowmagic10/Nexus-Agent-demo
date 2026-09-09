import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMemoryAdapter } from "../src/memory/sqlite-adapter.js";
import { normalizeSearchOptions } from "../src/memory/interface.js";
import { migrateDatabase } from "../src/persistence/migrations.js";

const NOW = "2026-09-09T00:00:00.000Z";
const SCOPE = { workspace: "/memory-search-test", agentId: "default", userId: "local" };

test("关键词检索召回中文自然语言问题，literal 保留完整 query 基线", async (t) => {
  const fixture = createFixture(t);
  const record = await fixture.memory.add({ content: "项目使用 TypeScript，测试使用 Vitest" }, fixture.access);
  const query = "我们项目使用什么语言和测试框架？";
  assert.deepEqual(await fixture.memory.search(query, fixture.access, { strategy: "literal" }), []);
  const [hit] = await fixture.memory.search(query, fixture.access);
  assert.equal(hit.id, record.id);
  assert.equal(hit.retrievalVersion, "memory-keywords-v1");
  assert.ok(hit.queryTerms.length > 0 && hit.queryTerms.length <= 24);
  assert.ok(hit.score > 0 && hit.score <= 0.59);
  assert.equal(hit.provenance.origin, "user_explicit");
});

test("精确内容、全文片段、标签片段优先于关键词，关键词按内容和标签覆盖稳定排序", async (t) => {
  const fixture = createFixture(t);
  for (const [id, content, tags] of [
    ["exact", "alpha beta", []],
    ["phrase", "before alpha beta after", []],
    ["tag-phrase", "tag phrase holder", ["alpha beta"]],
    ["coverage-content", "alpha then beta", []],
    ["coverage-tags", "tag token holder", ["alpha", "beta"]],
    ["tie-z", "alpha alone z", ["beta"]],
    ["tie-a", "alpha alone a", ["beta"]],
  ]) await fixture.memory.add({ id, content, tags }, fixture.access);
  const hits = await fixture.memory.search("alpha beta", fixture.access, { limit: 20 });
  assert.deepEqual(hits.map((hit) => hit.id), ["exact", "phrase", "tag-phrase", "coverage-content", "tie-a", "tie-z", "coverage-tags"]);
  assert.deepEqual(hits.slice(0, 3).map((hit) => hit.score), [1, 0.8, 0.6]);
  assert.equal(hits[3].score, 0.59);
  assert.equal(hits[4].score, 0.59 * 0.875);
  assert.equal(hits[5].score, hits[4].score);
  assert.equal(hits[6].score, 0.59 * 0.75);
  const literal = await fixture.memory.search("alpha beta", fixture.access, { strategy: "literal", limit: 20 });
  assert.deepEqual(literal.map((hit) => hit.id), ["exact", "phrase", "tag-phrase"]);
});

test("FTS 大量其他 scope 命中不会占用当前 scope 的 LIMIT 或影响分数", async (t) => {
  const fixture = createFixture(t);
  const local = await fixture.memory.add({ content: "alpha local beta" }, fixture.access);
  const before = await fixture.memory.search("alpha beta", fixture.access, { limit: 1 });
  fixture.db.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < 1500; index += 1) {
    insertRaw(fixture.db, { id: `foreign-${index}`, content: "alpha beta", scope: {
      ...SCOPE,
      ...(index % 3 === 0 ? { workspace: "/other" } : index % 3 === 1 ? { agentId: "other" } : { userId: "other" }),
    } });
  }
  fixture.db.exec("COMMIT");
  const after = await fixture.memory.search("alpha beta", fixture.access, { limit: 1 });
  assert.deepEqual(after, before);
  assert.equal(after[0].id, local.id);
});

test("关键词检索沿用状态、过期和 pinned 过滤，并保留未验证 legacy 来源", async (t) => {
  const fixture = createFixture(t);
  for (const [id, status, pinned, expiresAt] of [
    ["active", "active", false, null],
    ["pinned", "active", true, null],
    ["candidate", "candidate", false, null],
    ["superseded", "superseded", false, null],
    ["deleted", "deleted", false, null],
    ["expired-status", "expired", false, null],
    ["expired-time", "active", false, NOW],
  ]) insertRaw(fixture.db, { id, content: `alpha ${id} beta`, status, pinned, expiresAt });
  const query = "alpha beta";
  assert.deepEqual((await fixture.memory.search(query, fixture.access)).map((hit) => hit.id), ["active", "pinned"]);
  const [legacy] = await fixture.memory.search(query, fixture.access, { pinned: false });
  assert.equal(legacy.id, "active");
  assert.equal(legacy.provenanceValidated, false);
  assert.equal(legacy.provenance.origin, "legacy");
  assert.deepEqual((await fixture.memory.search(query, fixture.access, { pinned: true })).map((hit) => hit.id), ["pinned"]);
  assert.deepEqual((await fixture.memory.search(query, fixture.access, {
    statuses: ["candidate", "superseded", "deleted", "expired"],
  })).map((hit) => hit.id), ["candidate", "deleted", "expired-status", "superseded"]);
  fixture.db.prepare("UPDATE memories SET scope_agent = 'other' WHERE id = 'active'").run();
  assert.deepEqual(await fixture.memory.search(query, fixture.access, { pinned: false }), []);
});

test("空 query 仍按更新日期检索固定记忆，不附加关键词排序", async (t) => {
  const fixture = createFixture(t);
  insertRaw(fixture.db, { id: "older", content: "alpha old", pinned: true, updatedAt: "2026-09-08T00:00:00.000Z" });
  insertRaw(fixture.db, { id: "newer", content: "beta new", pinned: true });
  insertRaw(fixture.db, { id: "ordinary", content: "alpha beta" });
  const hits = await fixture.memory.search("", fixture.access, { pinned: true });
  assert.deepEqual(hits.map((hit) => hit.id), ["newer", "older"]);
  assert.ok(hits.every((hit) => hit.score === 1 && hit.adapter === "sqlite-lexical"));
  assert.deepEqual(hits, await fixture.memory.search("", fixture.access, { pinned: true, strategy: "literal" }));
});

test("短中文词使用 scoped 词法候选，FTS 运算符只能作为字面查询", async (t) => {
  const fixture = createFixture(t);
  const short = await fixture.memory.add({ content: "我喜欢猫狗" }, fixture.access);
  const alpha = await fixture.memory.add({ content: "alpha fact beta" }, fixture.access);
  await fixture.memory.add({ content: "completely unrelated" }, fixture.access);
  assert.equal((await fixture.memory.search("请问猫狗", fixture.access))[0].id, short.id);
  assert.deepEqual(await fixture.memory.search("猫狗 火星", fixture.access), []);
  for (const query of ['"alpha" OR NOT NEAR(beta*)', 'alpha : { beta }', "alpha* OR 'beta'"]) {
    const hits = await fixture.memory.search(query, fixture.access);
    assert.ok(hits.some((hit) => hit.id === alpha.id));
    assert.ok(hits.every((hit) => !hit.content.includes("unrelated")));
  }
  assert.deepEqual(await fixture.memory.search('"*{}():', fixture.access), []);
});

test("关键词召回需要组合证据，单个共有词或只有泛词不能成为自然问题命中", async (t) => {
  const fixture = createFixture(t);
  await fixture.memory.add({ content: "项目使用新的目录布局，上下文预算保持稳定。" }, fixture.access);
  await fixture.memory.add({ content: "alpha fact" }, fixture.access);
  for (const query of ["晨光预算", "payload alpha", "项目使用什么语言和测试框架？"]) {
    assert.deepEqual(await fixture.memory.search(query, fixture.access), [], query);
  }
  assert.equal((await fixture.memory.search("预算", fixture.access)).length, 1);
});

test("检索选项拒绝不完整类型，query 保留转换兼容且两策略都限制长度", async (t) => {
  const fixture = createFixture(t);
  for (const options of [null, false, "keywords", [], { strategy: true }, { strategy: "vector" }, { limit: 0 }, { pinned: 1 }, { statuses: [] }]) {
    assert.throws(() => normalizeSearchOptions(options));
  }
  assert.equal(normalizeSearchOptions().strategy, "keywords");
  assert.deepEqual(await fixture.memory.search(null, fixture.access), []);
  assert.deepEqual(await fixture.memory.search(123, fixture.access), []);
  for (const strategy of ["keywords", "literal"]) {
    await assert.rejects(fixture.memory.search("x".repeat(4097), fixture.access, { strategy }), /4096/);
  }
  const controller = new AbortController();
  controller.abort(new Error("search cancelled"));
  await assert.rejects(fixture.memory.search("alpha", { ...fixture.access, signal: controller.signal }), /search cancelled/);
});

test("FTS 索引只含业务 content/tags，不把 provenance 或 Session 来源变成召回内容", async (t) => {
  const fixture = createFixture(t);
  const record = await fixture.memory.add({ content: "alpha actual fact", tags: ["tagvisible"] }, {
    scope: SCOPE, provenance: { origin: "import", importedFrom: "provenanceonlymarker" },
  });
  assert.deepEqual(await fixture.memory.search("provenanceonlymarker", fixture.access), []);
  assert.equal((await fixture.memory.search("tagvisible", fixture.access))[0].id, record.id);
  assert.deepEqual(Object.keys(fixture.db.prepare("SELECT * FROM memory_search_fts LIMIT 1").get()).sort(), ["content", "memory_id", "tags_json"]);
});

test("v9 旧记录在 migration v10 回填，重复迁移不重写派生索引或审计", async (t) => {
  const fixture = createFixture(t);
  fixture.db.exec(`
    DROP TRIGGER memories_search_insert;
    DROP TRIGGER memories_search_update;
    DROP TRIGGER memories_search_delete;
    DROP TABLE memory_search_fts;
    DELETE FROM schema_migrations WHERE version = 10;
  `);
  insertRaw(fixture.db, { id: "legacy", content: "alpha legacy beta" });
  migrateDatabase(fixture.db);
  assert.equal((await fixture.memory.search("alpha beta", fixture.access))[0].id, "legacy");
  const before = fixture.db.prepare("SELECT rowid, * FROM memory_search_fts").all();
  migrateDatabase(fixture.db);
  assert.deepEqual(fixture.db.prepare("SELECT rowid, * FROM memory_search_fts").all(), before);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_events").get().count, 0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_mutations").get().count, 0);
});

test("contentful FTS 通过业务 ID 关联，VACUUM 和旧 writer 修改或硬删除保持一致", async (t) => {
  const fixture = createFixture(t);
  insertRaw(fixture.db, { id: "removed", content: "removed marker" });
  insertRaw(fixture.db, { id: "retained", content: "alpha retained beta" });
  fixture.db.prepare("DELETE FROM memories WHERE id = 'removed'").run();
  fixture.db.exec("VACUUM");
  assert.equal((await fixture.memory.search("alpha beta", fixture.access))[0].id, "retained");
  fixture.db.prepare("UPDATE memories SET id = 'renamed', content = 'gamma then delta', tags_json = '[\"newtag\"]' WHERE id = 'retained'").run();
  assert.deepEqual(await fixture.memory.search("alpha beta", fixture.access), []);
  assert.equal((await fixture.memory.search("gamma delta", fixture.access))[0].id, "renamed");
  assert.equal((await fixture.memory.search("newtag", fixture.access))[0].id, "renamed");
  fixture.db.prepare("DELETE FROM memories WHERE id = 'renamed'").run();
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_search_fts").get().count, 0);
});

test("重开临时 SQLite 数据库后保留索引和同步触发器，不需要 search 时回填", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nexus-memory-search-"));
  const filename = path.join(directory, "memory.db");
  let db = new DatabaseSync(filename);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  migrateDatabase(db);
  insertRaw(db, { id: "persistent", content: "alpha durable beta" });
  db.close();
  db = new DatabaseSync(filename);
  migrateDatabase(db);
  const memory = new SQLiteMemoryAdapter({ db, defaultScope: SCOPE, clock: () => new Date(NOW) });
  assert.equal((await memory.search("alpha beta", { scope: SCOPE }))[0].id, "persistent");
  db.prepare("UPDATE memories SET content = 'gamma reopened delta' WHERE id = 'persistent'").run();
  assert.deepEqual(await memory.search("alpha beta", { scope: SCOPE }), []);
  assert.equal((await memory.search("gamma delta", { scope: SCOPE }))[0].id, "persistent");
});

test("mutation 审计失败回滚 Memory 和 FTS，成功重试及幂等 replay 不重复索引或 receipt", async (t) => {
  const fixture = createFixture(t);
  const record = await fixture.memory.add({ content: "alpha initial beta" }, fixture.access);
  fixture.db.exec(`CREATE TRIGGER reject_search_test_audit BEFORE INSERT ON memory_events
    WHEN NEW.type = 'memory.updated' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;`);
  const mutationAccess = { ...fixture.access, mutationId: "search-update-1" };
  await assert.rejects(fixture.memory.update(record.id, { content: "gamma final delta" }, mutationAccess), /test audit failure/);
  assert.equal((await fixture.memory.search("alpha beta", fixture.access))[0].id, record.id);
  assert.deepEqual(await fixture.memory.search("gamma delta", fixture.access), []);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_mutations").get().count, 0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_events").get().count, 1);
  fixture.db.exec("DROP TRIGGER reject_search_test_audit");
  const updated = await fixture.memory.update(record.id, { content: "gamma final delta" }, mutationAccess);
  assert.deepEqual(await fixture.memory.update(record.id, { content: "gamma final delta" }, mutationAccess), updated);
  assert.equal((await fixture.memory.search("gamma delta", fixture.access))[0].id, record.id);
  assert.deepEqual(await fixture.memory.search("alpha beta", fixture.access), []);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_search_fts").get().count, 1);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_mutations").get().count, 1);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_events").get().count, 2);
});

test("去重合并标签、替代和软删除立即反映在检索，来源和 audit 仍由原表维护", async (t) => {
  const fixture = createFixture(t);
  const first = await fixture.memory.add({ content: "alpha first beta" }, fixture.access);
  const duplicate = await fixture.memory.add({ content: "alpha first beta", tags: ["mergedtag"] }, fixture.access);
  assert.equal(duplicate.id, first.id);
  assert.equal((await fixture.memory.search("mergedtag", fixture.access))[0].id, first.id);
  const replacement = await fixture.memory.add({ content: "alpha replacement beta" }, fixture.access);
  await fixture.memory.supersede(first.id, replacement.id, fixture.access);
  assert.deepEqual((await fixture.memory.search("alpha beta", fixture.access)).map((hit) => hit.id), [replacement.id]);
  await fixture.memory.delete(replacement.id, "test removal", fixture.access);
  assert.deepEqual(await fixture.memory.search("alpha beta", fixture.access), []);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_search_fts").get().count, 2);
  assert.deepEqual((await fixture.memory.verify(first.id, fixture.access)).events.map((event) => event.type), ["memory.added", "memory.observed_again", "memory.superseded"]);
});

test("显式 rebuild 修复派生索引，不创建 Memory event 或 receipt；普通 search 不自动重建", async (t) => {
  const fixture = createFixture(t);
  const record = await fixture.memory.add({ content: "alpha durable beta" }, fixture.access);
  fixture.db.exec("DELETE FROM memory_search_fts");
  assert.deepEqual(await fixture.memory.search("alpha beta", fixture.access), []);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_search_fts").get().count, 0);
  assert.deepEqual(await fixture.memory.rebuildSearchIndex(), { indexedRecords: 1 });
  assert.equal((await fixture.memory.search("alpha beta", fixture.access))[0].id, record.id);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_events").get().count, 1);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_mutations").get().count, 0);
});

test("显式 rebuild 在中途失败时回滚到原派生索引", async (t) => {
  const fixture = createFixture(t);
  const record = await fixture.memory.add({ content: "alpha durable beta" }, fixture.access);
  const interrupted = new SQLiteMemoryAdapter({ db: {
    prepare: fixture.db.prepare.bind(fixture.db),
    exec(sql) {
      if (sql.includes("DELETE FROM memory_search_fts;")) {
        fixture.db.exec("DELETE FROM memory_search_fts");
        throw new Error("test rebuild interrupted");
      }
      fixture.db.exec(sql);
    },
  }, defaultScope: SCOPE });
  await assert.rejects(interrupted.rebuildSearchIndex(), /test rebuild interrupted/);
  assert.equal((await fixture.memory.search("alpha beta", fixture.access))[0].id, record.id);
});

function createFixture(t) {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db);
  t.after(() => db.close());
  let nextId = 0;
  const memory = new SQLiteMemoryAdapter({
    db, defaultScope: SCOPE, clock: () => new Date(NOW), idFactory: () => `search-memory-${++nextId}`,
  });
  return { db, memory, access: { scope: SCOPE, provenance: { origin: "user_explicit" } } };
}

function insertRaw(db, { id, content, scope = SCOPE, tags = [], status = "active", pinned = false, expiresAt = null, updatedAt = NOW }) {
  db.prepare(`INSERT INTO memories(id, content, tags_json, created_at, updated_at,
    scope_workspace, scope_agent, scope_user, status, pinned, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, content, JSON.stringify(tags), NOW, updatedAt, scope.workspace, scope.agentId, scope.userId,
    status, pinned ? 1 : 0, expiresAt,
  );
}
