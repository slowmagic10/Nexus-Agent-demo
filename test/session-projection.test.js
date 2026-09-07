import assert from "node:assert/strict";
import test from "node:test";
import { createSessionProjection } from "../src/web/session-projection.js";

test("Client Session Projection 应用连续事件并在游标缺口时恢复 baseline", async () => {
  const reads = [
    { session: session("session-a", "idle"), cursor: 4 },
    { session: session("session-a", "completed"), cursor: 7 },
  ];
  const sources = [];
  const changes = [];
  const events = [];
  const projection = createSessionProjection({
    readSession: async () => structuredClone(reads.shift()),
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    onChange: (snapshot, reason) => changes.push({ snapshot, reason }),
    onEvent: (event) => events.push(event),
  });

  const selected = await projection.select("session-a");
  assert.equal(selected.session.phase, "idle");
  assert.equal(sources[0].url, "/sessions/session-a/events?after=4");

  await sources[0].emit({ cursor: 5, patch: { set: { phase: "thinking" } }, type: "MODEL_REQUESTED" });
  assert.equal(projection.session.phase, "thinking");
  assert.equal(projection.cursor, 5);

  await sources[0].emit({ cursor: 5, patch: { set: { phase: "failed" } }, type: "DUPLICATE" });
  assert.equal(projection.session.phase, "thinking");

  await sources[0].emit({ cursor: 7, patch: { set: { phase: "failed" } }, type: "GAPPED" });
  assert.equal(projection.session.phase, "completed");
  assert.equal(projection.cursor, 7);
  assert.deepEqual(events.map((event) => event.type), ["MODEL_REQUESTED"]);
  assert.deepEqual(changes.map((item) => item.reason), ["selected", "event", "recovered"]);
});

test("Client Session Projection 丢弃快速选择返回的旧 Session", async () => {
  const pending = new Map();
  const sources = [];
  const projection = createSessionProjection({
    readSession: (id) => new Promise((resolve) => pending.set(id, resolve)),
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
  });

  const selectingA = projection.select("session-a");
  const selectingB = projection.select("session-b");
  pending.get("session-b")({ session: session("session-b", "idle"), cursor: 2 });
  await selectingB;
  pending.get("session-a")({ session: session("session-a", "completed"), cursor: 9 });

  assert.equal(await selectingA, null);
  assert.equal(projection.sessionId, "session-b");
  assert.equal(projection.session.id, "session-b");
  assert.equal(sources.length, 1);
  assert.match(sources[0].url, /session-b/);
});

test("Client Session Projection 在切换和 refresh 后拒绝旧事件源", async () => {
  const reads = new Map([
    ["session-a", [
      { session: session("session-a", "idle"), cursor: 1 },
      { session: session("session-a", "thinking"), cursor: 2 },
      { session: session("session-a", "completed"), cursor: 4 },
    ]],
    ["session-b", [{ session: session("session-b", "idle"), cursor: 3 }]],
  ]);
  const sources = [];
  const projection = createSessionProjection({
    readSession: async (id) => structuredClone(reads.get(id).shift()),
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
  });

  await projection.select("session-a");
  const sourceA = sources[0];
  await projection.select("session-b");
  assert.equal(sourceA.closed, true);
  await sourceA.emit({ cursor: 2, patch: { set: { phase: "failed" } }, type: "STALE" });
  assert.equal(projection.session.id, "session-b");

  await projection.select("session-a");
  const beforeRefresh = sources.at(-1);
  await projection.refresh();
  assert.equal(beforeRefresh.closed, true);
  assert.equal(projection.session.phase, "completed");
  assert.match(sources.at(-1).url, /after=4/);

  projection.close();
  assert.equal(sources.at(-1).closed, true);
});

test("Client Session Projection 取消迟到的 feature query 且同类请求只保留最新结果", async () => {
  const reads = new Map([
    ["session-a", { session: session("session-a", "idle"), cursor: 1 }],
    ["session-b", { session: session("session-b", "idle"), cursor: 2 }],
  ]);
  const pending = [];
  const projection = createSessionProjection({
    readSession: async (id) => structuredClone(reads.get(id)),
    eventSourceFactory: (url) => new FakeEventSource(url),
  });

  await projection.select("session-a");
  const oldSessionQuery = projection.query("memories", (sessionId, { signal }) => pendingQuery(pending, sessionId, signal));
  assert.equal(pending[0].sessionId, "session-a");
  await projection.select("session-b");
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({ memories: ["old"] });
  assert.equal(await oldSessionQuery, null);

  const older = projection.query("grants", (sessionId, { signal }) => pendingQuery(pending, sessionId, signal));
  const newer = projection.query("grants", (sessionId, { signal }) => pendingQuery(pending, sessionId, signal));
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve({ grants: ["stale"] });
  pending[2].resolve({ grants: ["current"] });
  assert.equal(await older, null);
  assert.deepEqual(await newer, {
    sessionId: "session-b",
    value: { grants: ["current"] },
  });
});

test("清空删除任务会断开事件源、清游标、取消 feature query 并拒绝迟到 baseline", async () => {
  let resolveRead;
  let delaying = false;
  const queries = [];
  const sources = [];
  const projection = createSessionProjection({
    readSession: async (id) => delaying
      ? new Promise((resolve) => { resolveRead = resolve; })
      : { session: session(id, "idle"), cursor: 8 },
    eventSourceFactory: (url) => { const source = new FakeEventSource(url); sources.push(source); return source; },
  });
  await projection.select("a");
  const query = projection.query("memories", (sessionId, { signal }) => pendingQuery(queries, sessionId, signal));
  projection.clear();
  assert.equal(queries[0].signal.aborted, true);
  queries[0].resolve({ memories: ["stale"] });
  assert.equal(await query, null);
  assert.equal(sources[0].closed, true);
  assert.equal(projection.sessionId, null);
  assert.equal(projection.session, null);
  assert.equal(projection.cursor, 0);
  delaying = true;
  const selection = projection.select("a");
  projection.clear();
  resolveRead({ session: session("a", "completed"), cursor: 9 });
  assert.equal(await selection, null);
  assert.equal(projection.sessionId, null);
  assert.equal(sources.length, 1);
});

test("跨标签删除事件立即清空当前投影，切换后的旧删除事件不会清空新任务", async () => {
  const sources = [];
  const deletions = [];
  const changes = [];
  const projection = createSessionProjection({
    readSession: async (id) => ({ session: session(id, "idle"), cursor: 1 }),
    eventSourceFactory: (url) => { const source = new FakeEventSource(url); sources.push(source); return source; },
    onDeleted: (event) => deletions.push(event),
    onChange: (snapshot, reason) => changes.push({ snapshot, reason }),
  });
  await projection.select("a");
  await projection.select("b");
  sources[0].emitDeleted({ sessionId: "a", deleted: true, deletedSessionIds: ["a"] });
  assert.equal(projection.sessionId, "b");
  sources[1].emitDeleted({ sessionId: "a", deleted: true, deletedSessionIds: ["a"] });
  assert.equal(projection.sessionId, "b");
  sources[1].emitDeleted({ sessionId: "b", deleted: true, deletedSessionIds: ["b", "child"] });
  assert.equal(projection.sessionId, null);
  assert.equal(projection.cursor, 0);
  assert.equal(sources[1].closed, true);
  assert.equal(deletions.length, 1);
  assert.equal(changes.at(-1).reason, "cleared");
  assert.equal(changes.at(-1).snapshot.session, null);
  await sources[1].emit({ cursor: 2, type: "STALE", patch: { set: { phase: "thinking" } } });
  assert.equal(projection.session, null);
});

test("refresh 和事件缺口恢复期间漏掉删除事件时，404 仍清空任务且不重新连接", async () => {
  for (const action of ["refresh", "recover", "select"]) {
    let missing = false;
    const sources = [];
    const deleted = [];
    const projection = createSessionProjection({
      readSession: async (id) => {
        if (missing) throw Object.assign(new Error("任务不存在"), { status: 404 });
        return { session: session(id, "idle"), cursor: 1 };
      },
      eventSourceFactory: (url) => { const source = new FakeEventSource(url); sources.push(source); return source; },
      onDeleted: (event) => deleted.push(event),
    });
    await projection.select("a");
    missing = true;
    if (action === "refresh") await projection.refresh();
    if (action === "recover") await sources[0].emit({ cursor: 3, type: "GAPPED" });
    if (action === "select") await projection.select("a");
    assert.equal(projection.sessionId, null, action);
    assert.equal(sources.length, 1, action);
    assert.equal(sources[0].closed, true, action);
    assert.deepEqual(deleted[0].deletedSessionIds, ["a"], action);
  }
});

test("SSE 断线后探测 404 停止重连，迟到的探测不影响已切换任务", async () => {
  const sources = [];
  let rejectProbe;
  let probing = false;
  const projection = createSessionProjection({
    readSession: async (id) => {
      if (probing && id === "a") return new Promise((resolve, reject) => { rejectProbe = reject; });
      return { session: session(id, "idle"), cursor: 1 };
    },
    eventSourceFactory: (url) => { const source = new FakeEventSource(url); sources.push(source); return source; },
  });
  await projection.select("a");
  probing = true;
  sources[0].onerror();
  sources[0].onerror();
  await Promise.resolve();
  rejectProbe(Object.assign(new Error("任务不存在"), { status: 404 }));
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  assert.equal(projection.sessionId, null);
  assert.equal(sources[0].closed, true);

  probing = false;
  await projection.select("a");
  probing = true;
  sources[1].onerror();
  await Promise.resolve();
  await projection.select("b");
  rejectProbe(Object.assign(new Error("任务不存在"), { status: 404 }));
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  assert.equal(projection.sessionId, "b");
  projection.close();
});

function session(id, phase) {
  return { id, phase, messages: [], events: [] };
}

function pendingQuery(pending, sessionId, signal) {
  return new Promise((resolve) => pending.push({ sessionId, signal, resolve }));
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = new Map();
    this.onerror = null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(event) {
    return this.listeners.get("session_event")?.({ data: JSON.stringify(event) });
  }

  emitDeleted(event) {
    return this.listeners.get("session_deleted")?.({ data: JSON.stringify(event) });
  }

  close() {
    this.closed = true;
  }
}
