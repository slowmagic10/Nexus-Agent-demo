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

  close() {
    this.closed = true;
  }
}
