import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { SQLiteMemoryAdapter } from "../memory/sqlite-adapter.js";
import { migrateDatabase } from "../persistence/migrations.js";

export const MEMORY_RETRIEVAL_SUITE_VERSION = "memory-retrieval-evaluation-v1";
const STRATEGIES = ["literal", "keywords"];

// A labelled lexical retrieval comparison in an isolated in-memory database.
// No Provider, tool execution, environment loading or business Session is used.
export async function runMemoryRetrievalSuite(input, { signal } = {}) {
  const suite = normalizeSuite(input);
  if (signal && typeof signal.throwIfAborted !== "function") throw new Error("Memory Evaluation signal 无效");
  signal?.throwIfAborted();
  const db = new DatabaseSync(":memory:");
  const started = performance.now();
  const results = [];
  let cancelled = false;
  try {
    migrateDatabase(db);
    const memory = new SQLiteMemoryAdapter({ db, clock: () => new Date(suite.now) });
    for (let index = 0; index < suite.records.length; index++) {
      signal?.throwIfAborted();
      const { scope, ...record } = suite.records[index];
      const seeded = await memory.add(record, { scope, signal, provenance: { origin: "system" } });
      if (seeded.id !== record.id) throw new Error("Memory fixture 去重后记录身份与标注不一致");
      if (index % 20 === 19) await setImmediate();
    }
    const byId = new Map(suite.records.map((record) => [record.id, record]));
    for (const query of suite.queries) {
      signal?.throwIfAborted();
      const item = { queryId: query.id, expectedCount: query.expectedIds.length, limit: query.limit };
      for (const strategy of STRATEGIES) {
        signal?.throwIfAborted();
        const found = await memory.search(query.query, { scope: query.scope, signal },
          { limit: query.limit, pinned: query.pinned, statuses: ["active"], strategy });
        item[strategy] = grade(found, query, byId, suite.now);
      }
      results.push(item);
      await setImmediate();
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    cancelled = true;
  } finally {
    db.close();
  }
  cancelled ||= Boolean(signal?.aborted);
  const strategies = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, aggregate(results, strategy)]));
  return {
    version: MEMORY_RETRIEVAL_SUITE_VERSION,
    acceptance: { positive: "all-labelled-ids-within-k", negative: "empty", scopeAndStatus: "no-leaks", precision: "reported-not-gated" },
    suite: { id: suite.id, records: suite.records.length, queries: suite.queries.length, fixtureHash: digest(suite) },
    passed: !cancelled && results.length === suite.queries.length && results.every((item) => item.keywords.passed),
    cancelled, completedQueries: results.length, notRun: suite.queries.length - results.length,
    strategies,
    comparison: {
      recallAtKDelta: difference(strategies.keywords.recallAtK, strategies.literal.recallAtK),
      precisionAtKDelta: difference(strategies.keywords.precisionAtK, strategies.literal.precisionAtK),
      meanReciprocalRankDelta: difference(strategies.keywords.meanReciprocalRank, strategies.literal.meanReciprocalRank),
      negativeEmptyRateDelta: difference(strategies.keywords.negativeEmptyRate, strategies.literal.negativeEmptyRate),
      recallImprovedQueries: results.filter((item) => quality(item.keywords) > quality(item.literal)).length,
      recallRegressedQueries: results.filter((item) => quality(item.keywords) < quality(item.literal)).length,
      precisionRegressedQueries: results.filter((item) => item.literal.precisionAtK !== null
        && item.keywords.precisionAtK !== null && item.keywords.precisionAtK < item.literal.precisionAtK).length,
      scopeOrStatusLeaks: strategies.keywords.ineligibleHits,
    },
    elapsedMs: Math.round(performance.now() - started),
    results,
  };
}

function grade(found, query, byId, now) {
  const expected = new Set(query.expectedIds);
  const returned = [...new Set(found.map((record) => record.id))];
  const relevant = returned.filter((id) => expected.has(id));
  const first = returned.findIndex((id) => expected.has(id));
  const ineligibleHits = returned.filter((id) => !eligible(byId.get(id), query, now)).length;
  return {
    retrievedIds: returned, relevantHits: relevant.length, retrievedCount: returned.length, ineligibleHits,
    recallAtK: expected.size ? rounded(relevant.length / expected.size) : null,
    precisionAtK: returned.length ? rounded(relevant.length / returned.length) : null,
    reciprocalRank: expected.size ? (first < 0 ? 0 : rounded(1 / (first + 1))) : null,
    hitAtK: expected.size ? relevant.length > 0 : null,
    negativeEmpty: expected.size ? null : returned.length === 0,
    passed: ineligibleHits === 0 && (expected.size ? relevant.length === expected.size : returned.length === 0),
  };
}

function aggregate(results, strategy) {
  const values = results.map((item) => item[strategy]);
  const positive = values.filter((item) => item.recallAtK !== null);
  const negative = values.filter((item) => item.negativeEmpty !== null);
  const retrievedCount = values.reduce((sum, item) => sum + item.retrievedCount, 0);
  const relevantHits = values.reduce((sum, item) => sum + item.relevantHits, 0);
  return {
    queries: values.length, positiveQueries: positive.length, negativeQueries: negative.length,
    passedQueries: values.filter((item) => item.passed).length,
    recallAtK: average(positive.map((item) => item.recallAtK)),
    precisionAtK: retrievedCount ? rounded(relevantHits / retrievedCount) : null,
    hitAtK: positive.length ? rounded(positive.filter((item) => item.hitAtK).length / positive.length) : null,
    meanReciprocalRank: average(positive.map((item) => item.reciprocalRank)),
    negativeEmptyRate: negative.length ? rounded(negative.filter((item) => item.negativeEmpty).length / negative.length) : null,
    retrievedCount, relevantHits,
    ineligibleHits: values.reduce((sum, item) => sum + item.ineligibleHits, 0),
  };
}

function normalizeSuite(input) {
  keys(input, ["id", "now", "records", "queries"], "Memory suite");
  const id = identifier(input.id);
  const now = date(input.now, "now");
  boundedArray(input.records, 1, 1000, "records");
  boundedArray(input.queries, 1, 100, "queries");
  let bytes = 0;
  const records = input.records.map((source) => {
    keys(source, ["id", "content", "tags", "scope", "status", "pinned", "expiresAt"], "Memory fixture record");
    const content = text(source.content, 8192, "content");
    bytes += Buffer.byteLength(content);
    const status = source.status ?? "active";
    if (!["active", "candidate"].includes(status)) throw new Error("Memory fixture status 只接受 active/candidate");
    const pinned = source.pinned ?? false;
    if (typeof pinned !== "boolean" || (pinned && status !== "active")) throw new Error("Memory fixture pinned 无效");
    const tags = source.tags ?? [];
    boundedArray(tags, 0, 20, "tags");
    return { id: identifier(source.id), content, scope: scope(source.scope), status, pinned,
      tags: tags.map((tag) => text(tag, 128, "tag")), expiresAt: source.expiresAt == null ? null : date(source.expiresAt, "expiresAt") };
  });
  if (bytes > 2_000_000) throw new Error("Memory fixture 正文总量超限");
  uniqueIds(records, "Memory");
  const byId = new Map(records.map((record) => [record.id, record]));
  // Avoid Adapter active-dedup changing the fixture's labelled record identity.
  const activeFacts = new Set();
  for (const record of records.filter((item) => item.status === "active")) {
    const key = JSON.stringify([record.scope, record.content.replace(/[A-Z]/g, (character) => character.toLowerCase())]);
    if (activeFacts.has(key)) throw new Error("Memory fixture 包含同 scope 的重复 active 正文");
    activeFacts.add(key);
  }
  const queries = input.queries.map((source) => {
    keys(source, ["id", "query", "scope", "expectedIds", "limit", "pinned"], "Memory fixture query");
    const query = text(source.query, 4096, "query", true);
    const limit = source.limit ?? 3;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Memory fixture limit 必须是1到20整数");
    const pinned = source.pinned === undefined ? false : source.pinned;
    if (pinned !== null && typeof pinned !== "boolean") throw new Error("Memory query pinned 无效");
    boundedArray(source.expectedIds, 0, limit, "expectedIds");
    const expectedIds = source.expectedIds.map(identifier);
    if (new Set(expectedIds).size !== expectedIds.length) throw new Error("Memory query expectedIds 重复");
    const result = { id: identifier(source.id), query, scope: scope(source.scope), expectedIds, limit, pinned };
    if (expectedIds.some((id) => !eligible(byId.get(id), result, now))) throw new Error("Memory query 标注引用不存在或不符合范围/状态的记录");
    return result;
  });
  uniqueIds(queries, "Query");
  return { id, now, records, queries };
}

function eligible(record, query, now) {
  return Boolean(record) && record.status === "active" && (!record.expiresAt || record.expiresAt > now)
    && ["workspace", "agentId", "userId"].every((key) => record.scope[key] === query.scope[key])
    && (query.pinned === null || record.pinned === query.pinned);
}
function scope(value) {
  keys(value, ["workspace", "agentId", "userId"], "Memory fixture scope");
  return Object.fromEntries(["workspace", "agentId", "userId"].map((key) => [key, text(value[key], 256, `scope.${key}`)]));
}
function keys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} 字段无效`);
}
function text(value, max, label, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) throw new Error(`Memory fixture ${label} 无效或超限`);
  return value.trim();
}
function identifier(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error("Memory fixture id 无效");
  return value;
}
function date(value, label) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error(`Memory fixture ${label} 日期无效`);
  return new Date(value).toISOString();
}
function boundedArray(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Memory fixture ${label} 数量无效`);
}
function uniqueIds(values, label) { if (new Set(values.map((value) => value.id)).size !== values.length) throw new Error(`${label} fixture id 重复`); }
function rounded(value) { return Math.round(value * 10000) / 10000; }
function average(values) { return values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null; }
function difference(left, right) { return left === null || right === null ? null : rounded(left - right); }
function quality(result) { return result.negativeEmpty === null ? result.recallAtK : Number(result.negativeEmpty); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
