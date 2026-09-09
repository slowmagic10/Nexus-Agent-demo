import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { MAX_TOOL_HISTORY_RECORD_BYTES, SessionStore } from "../src/persistence/session-store.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ToolHost } from "../src/tools/host.js";

function fixture(t) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-tool-history-"));
  const store = new SessionStore(path.join(workspace, "journal.db"), { workspace });
  t.after(() => { store.close(); rmSync(workspace, { recursive: true, force: true }); });
  const session = new AgentSession({ state: createSession({ provider: "demo", workspace }), reducer: reduceSession, journal: store });
  return { workspace, store, session };
}

async function requested(session, { id = "repeated", name = "run_shell", args = { command: "first" }, effects = ["execute"] } = {}) {
  const call = { id, name, arguments: args };
  await session.dispatch({ type: "TOOL_REQUESTED", call, effects });
  return { call, cursor: session.cursor };
}

async function completed(session, request, result = "ok", extra = {}) {
  await session.dispatch({ type: "TOOL_RESULT", call: request.call, ok: true, status: "completed", result, ...extra });
  return session.cursor;
}

function record(session, sourceCursor, options = {}) {
  const response = session.queryToolHistory({ source_cursor: sourceCursor, ...options });
  return { response, value: JSON.parse(response.page.content) };
}

test("工具历史用durable request cursor区分重复call ID，不读取投影序号或整份日志", async (t) => {
  const { session, store } = fixture(t);
  await session.dispatch({ type: "USER_MESSAGE", content: "private user body" });
  const first = await requested(session);
  const firstResult = await completed(session, first, "first result");
  const second = await requested(session, { args: { command: "second" } });
  await completed(session, second, "second result");
  store.readSessionEvents = () => { throw new Error("不能加载完整journal"); };
  store.load = () => { throw new Error("不能加载完整state"); };
  const discovery = session.queryToolHistory({ call_id: "repeated" });
  assert.deepEqual(discovery.occurrences.map((item) => item.sourceCursor), [first.cursor, second.cursor]);
  assert.equal(discovery.occurrences[0].resultCursor, firstResult);
  assert.equal(record(session, first.cursor).value.request.arguments.command, "first");
  assert.equal(record(session, first.cursor).value.result.content, "first result");
  assert.equal(record(session, second.cursor).value.result.content, "second result");
  assert.throws(() => session.queryToolHistory({ source_cursor: 2 }), /TOOL_REQUESTED/);
  assert.equal(JSON.stringify(discovery).includes("private user body"), false);
});

test("发现分页冻结snapshot，不混入新写入的occurrence", async (t) => {
  const { session } = fixture(t);
  const cursors = [];
  for (let i = 0; i < 3; i += 1) cursors.push((await requested(session)).cursor);
  const first = session.queryToolHistory({ call_id: "repeated", page_size: 2 });
  await requested(session);
  const second = session.queryToolHistory({ call_id: "repeated", page_size: 2, after_cursor: first.nextAfterCursor, snapshot_cursor: first.snapshotCursor });
  assert.deepEqual(first.occurrences.map((item) => item.sourceCursor), cursors.slice(0, 2));
  assert.deepEqual(second.occurrences.map((item) => item.sourceCursor), cursors.slice(2));
  assert.equal(second.nextAfterCursor, null);
  assert.throws(() => session.queryToolHistory({ after_cursor: first.nextAfterCursor }), /snapshot_cursor/);
});

test("长参数和结果按Unicode字符分页并绑定snapshot和sha256", async (t) => {
  const { session } = fixture(t);
  const request = await requested(session, { args: { text: "汉😀𠮷".repeat(100) } });
  const pending = session.queryToolHistory({ source_cursor: request.cursor, limit: 17 });
  await completed(session, request, "new result");
  let content = pending.page.content;
  let offset = pending.page.nextOffset;
  while (offset !== null) {
    const page = session.queryToolHistory({ source_cursor: request.cursor, snapshot_cursor: pending.snapshotCursor,
      expected_sha256: pending.page.sha256, offset, limit: 17 }).page;
    assert.equal(Array.from(page.content).length <= 17, true);
    assert.equal(/[\uD800-\uDBFF]$/.test(page.content), false);
    assert.equal(/^[\uDC00-\uDFFF]/.test(page.content), false);
    content += page.content;
    offset = page.nextOffset;
  }
  assert.equal(JSON.parse(content).request.arguments.text, "汉😀𠮷".repeat(100));
  assert.equal(JSON.parse(content).result, null);
  assert.equal(record(session, request.cursor).value.result.content, "new result");
  assert.throws(() => session.queryToolHistory({ source_cursor: request.cursor, offset: 1 }), /snapshot_cursor|expected_sha256/);
  assert.throws(() => session.queryToolHistory({ source_cursor: request.cursor, snapshot_cursor: pending.snapshotCursor,
    expected_sha256: "0".repeat(64), offset: 1 }), /sha256/);
  assert.throws(() => session.queryToolHistory({ source_cursor: request.cursor, snapshot_cursor: session.cursor,
    expected_sha256: pending.page.sha256, offset: 1 }), /sha256/);
});

test("只返回脱敏工具字段并屏蔽memory/credential正文和Artifact引用", async (t) => {
  const { session } = fixture(t);
  await session.dispatch({ type: "MEMORY_ADDED", content: "private memory body" });
  const ordinary = await requested(session, { args: { password: "plain-secret", command: "API_KEY=secret-value" } });
  await completed(session, ordinary, "authorization: bearer secret-value");
  const text = record(session, ordinary.cursor).response.page.content;
  assert.equal(text.includes("secret-value"), false);
  assert.equal(text.includes("plain-secret"), false);
  assert.equal(text.includes("private memory body"), false);
  for (const [name, effects] of [["memory_search", ["read"]], ["custom_memory", ["memory"]], ["custom_secret", ["credential"]]]) {
    const request = await requested(session, { name, args: { query: "private-input" }, effects });
    await completed(session, request, "private-output", { artifact: { id: "private-artifact" } });
    const response = record(session, request.cursor);
    assert.equal(response.value.contentOmitted, "private_tool");
    assert.equal(JSON.stringify(response).includes("private-input"), false);
    assert.equal(JSON.stringify(response).includes("private-output"), false);
    assert.equal(JSON.stringify(response).includes("private-artifact"), false);
  }
});

test("结果与Diff Artifact仅返回当前occurrence的引用，不抓取Artifact正文", async (t) => {
  const { session, store } = fixture(t);
  const first = await requested(session);
  const artifact = await store.artifacts.put({ sessionId: session.id, callId: first.call.id, kind: "tool_output", content: "large result" });
  await completed(session, first, "preview", { artifact });
  const second = await requested(session);
  await completed(session, second, "different");
  store.artifacts.get = () => { throw new Error("不应读取Artifact正文"); };
  assert.equal(record(session, first.cursor).value.result.artifact.id, artifact.id);
  assert.equal(record(session, first.cursor).response.record.artifacts[0].id, artifact.id);
  assert.deepEqual(record(session, second.cursor).response.record.artifacts, []);
});

test("内存Session明确不支持；关闭、删除后拒绝旧引用回查", async (t) => {
  const { workspace, store, session } = fixture(t);
  const memory = new AgentSession({ state: createSession({ provider: "demo", workspace }), reducer: reduceSession });
  await requested(memory);
  assert.deepEqual(memory.queryToolHistory({}), { available: false, reason: "durable_journal_unavailable" });
  memory.close();
  assert.throws(() => memory.queryToolHistory({}), /关闭|删除/);
  await requested(session);
  store.deleteSessions([session.id]);
  assert.throws(() => session.queryToolHistory({}), /删除|不存在/);
});

test("归档导入保留本Session cursor；分支不能越界回查父Session历史", async (t) => {
  const { workspace, store, session } = fixture(t);
  const request = await requested(session);
  await completed(session, request, "source");
  const importedState = store.importJournal(store.exportJournal(session.id), { id: "imported-tool-history" });
  const imported = new AgentSession({ state: importedState, reducer: reduceSession, journal: store });
  assert.equal(record(imported, request.cursor).value.result.content, "source");
  const branchState = store.branchSession(session.id, { id: "branched-tool-history", workspace, cursor: session.cursor });
  const branch = new AgentSession({ state: branchState, reducer: reduceSession, journal: store });
  assert.deepEqual(branch.queryToolHistory({ call_id: request.call.id }).occurrences, []);
  assert.throws(() => branch.queryToolHistory({ source_cursor: request.cursor }), /snapshot|cursor|TOOL_REQUESTED/);
});

test("read_tool_history经Host只读当前Session且拒绝任意sessionId和无效分页参数", async (t) => {
  const { workspace, store, session } = fixture(t);
  const request = await requested(session);
  await completed(session, request, "original-result");
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts });
  const host = new ToolHost({ registry });
  assert.ok(host.schemas({ session }).some((schema) => schema.function.name === "read_tool_history"));
  const result = await host.execute({ id: "read-history", name: "read_tool_history", arguments: { source_cursor: request.cursor } }, { session });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(JSON.parse(result.result).page.content).result.content, "original-result");
  for (const argumentsValue of [{ sessionId: "other" }, { session_id: "other" }, { page_size: 21 }, { limit: 8001 }, { source_cursor: 0 }, { offset: -1 }]) {
    const invalid = await host.execute({ id: "invalid-history", name: "read_tool_history", arguments: argumentsValue }, { session });
    assert.equal(invalid.status, "validation_failed");
  }
  assert.throws(() => session.queryToolHistory({ source_cursor: request.cursor, call_id: "different" }), /call_id/);
  assert.throws(() => session.queryToolHistory({ session_id: "other" }), /session_id/);
});

test("字符页按最终JSON转义预算收缩，通过Host仍是完整有效的分页响应", async (t) => {
  const { workspace, store, session } = fixture(t);
  const request = await requested(session, { args: { text: "\u0000\\\"😀".repeat(8_000) } });
  await completed(session, request);
  const direct = session.queryToolHistory({ source_cursor: request.cursor, limit: 8_000 });
  assert.equal(JSON.stringify(direct).length <= 10_000, true);
  assert.equal(direct.page.nextOffset < 8_000, true);
  const host = new ToolHost({ registry: createToolRegistry({ workspace, artifactStore: store.artifacts }) });
  const executed = await host.execute({ id: "escaped-history", name: "read_tool_history", arguments: { source_cursor: request.cursor, limit: 8_000 } }, { session });
  assert.equal(executed.ok, true);
  assert.equal(executed.result.length <= 10_000, true);
  assert.equal(JSON.parse(executed.result).page.nextOffset, direct.page.nextOffset);
  assert.equal(session.queryToolHistory({ call_id: "escaped-history" }).occurrences.length, 0);
  const ownCursor = session.events().find((event) => event.type === "TOOL_REQUESTED" && event.action.call.id === "escaped-history").cursor;
  assert.equal(record(session, ownCursor).value.contentOmitted, "history_read");
});

test("同ID重叠请求没有明确sourceCursor时不把另一次结果拼接到本次记录", async (t) => {
  const { session } = fixture(t);
  const first = await requested(session);
  const second = await requested(session);
  await completed(session, first, "belongs to first");
  assert.equal(record(session, first.cursor).value.result, null);
  const uncertain = record(session, second.cursor);
  assert.equal(uncertain.value.result, null);
  assert.equal(uncertain.value.resultUnavailable, "ambiguous_call_id_occurrence");
  assert.equal(uncertain.response.record.association, "ambiguous");
  const third = await requested(session);
  await completed(session, second, "belongs to second");
  assert.equal(record(session, third.cursor).value.result, null);
  assert.equal(record(session, third.cursor).response.record.association, "ambiguous");
  await completed(session, third, "explicit third", { sourceCursor: third.cursor });
  // An earlier unlabeled result remains ambiguous; do not skip it and claim a
  // convenient later record is the sole outcome of this occurrence.
  assert.equal(record(session, third.cursor).value.result, null);
});

test("读取不会推进durablecursor或状态，范围无效时快速拒绝", async (t) => {
  const { session, store } = fixture(t);
  const request = await requested(session);
  await completed(session, request);
  const before = session.state;
  const beforeCursor = session.cursor;
  const beforeEvents = store.latestSessionCursor(session.id);
  session.queryToolHistory({});
  record(session, request.cursor);
  assert.equal(session.cursor, beforeCursor);
  assert.equal(store.latestSessionCursor(session.id), beforeEvents);
  assert.deepEqual(session.state, before);
  assert.throws(() => session.queryToolHistory({ snapshot_cursor: beforeCursor + 1 }), /snapshot_cursor/);
  assert.throws(() => session.queryToolHistory({ source_cursor: request.cursor, page_size: 2 }), /混用/);
  assert.throws(() => session.queryToolHistory({ offset: 0 }), /source_cursor/);
  assert.throws(() => store.readToolHistoryOccurrences(session.id, { until: beforeCursor, limit: 1_000 }), /范围/);
  session.close();
  assert.throws(() => session.queryToolHistory({}), /关闭/);
});

test("Host再次脱敏不会破坏含已脱敏凭据标记的JSON历史页", async (t) => {
  const { workspace, session } = fixture(t);
  const request = await requested(session, { args: { command: "API_KEY=secret-value" } });
  await completed(session, request, "authorization: bearer secret-value");
  const host = new ToolHost({ registry: createToolRegistry({ workspace }) });
  const result = await host.execute({ id: "safe-json-history", name: "read_tool_history", arguments: { source_cursor: request.cursor } }, { session });
  assert.equal(result.ok, true);
  assert.equal(result.result.length <= 10_000, true);
  const value = JSON.parse(JSON.parse(result.result).page.content);
  assert.equal(value.request.arguments.command, "API_KEY=[REDACTED]");
  assert.equal(value.result.content, "authorization: bearer [REDACTED]");
});

test("SQLite在读取正文前限制request/result合计4MB，limit1也仅返回省略元数据及Artifact引用", async (t) => {
  const { session, store } = fixture(t);
  for (const kind of ["request", "result", "combined"]) {
    const request = await requested(session, { id: `oversized-${kind}` });
    const artifact = await store.artifacts.put({ sessionId: session.id, callId: request.call.id, kind: "tool_output", content: "artifact fallback" });
    const resultCursor = await completed(session, request, "ok", { artifact });
    const requestAction = session.events().find((event) => event.cursor === request.cursor).action;
    const resultAction = session.events().find((event) => event.cursor === resultCursor).action;
    if (kind === "request") requestAction.call.arguments = { text: "R".repeat(MAX_TOOL_HISTORY_RECORD_BYTES) };
    if (kind === "result") resultAction.result = "R".repeat(MAX_TOOL_HISTORY_RECORD_BYTES);
    if (kind === "combined") {
      requestAction.call.arguments = { text: "R".repeat(MAX_TOOL_HISTORY_RECORD_BYTES / 2) };
      resultAction.call.arguments = requestAction.call.arguments;
    }
    const update = store.db.prepare("UPDATE session_events SET event_json = ? WHERE session_id = ? AND seq = ?");
    update.run(JSON.stringify({ action: requestAction, patch: [] }), session.id, request.cursor);
    update.run(JSON.stringify({ action: resultAction, patch: [] }), session.id, resultCursor);
    const prepare = store.db.prepare;
    store.db.prepare = function (sql) {
      assert.equal(/AS action_json/i.test(sql), false, "大记录预检后不能读取action正文");
      return prepare.call(this, sql);
    };
    try {
      const single = session.queryToolHistory({ source_cursor: request.cursor, limit: 1 });
      assert.equal(single.page.content, "{");
      assert.equal(single.record.artifacts[0].id, artifact.id);
      const response = record(session, request.cursor);
      assert.equal(response.value.contentOmitted, "record_too_large");
      assert.equal(response.value.maxRecordBytes, MAX_TOOL_HISTORY_RECORD_BYTES);
      assert.equal(response.value.recordBytes > MAX_TOOL_HISTORY_RECORD_BYTES, true);
      assert.equal(response.value.artifacts[0].id, artifact.id);
      assert.equal(Object.hasOwn(response.value, "request"), false);
      assert.equal(Object.hasOwn(response.value, "result"), false);
    } finally {
      store.db.prepare = prepare;
    }
  }
});
