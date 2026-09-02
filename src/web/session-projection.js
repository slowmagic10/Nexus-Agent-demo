// FOUNDATION — one selected Agent Session projected from baseline + ordered durable event patches.
import { applyStatePatch } from "../state-patch.js";

export function createSessionProjection({
  readSession,
  eventSourceFactory = (url) => new EventSource(url),
  onChange = () => {},
  onEvent = () => {},
  onDisconnect = () => {},
} = {}) {
  if (typeof readSession !== "function") throw new Error("Client Session Projection 需要 readSession");
  if (typeof eventSourceFactory !== "function") throw new Error("Client Session Projection 需要 EventSource factory");
  for (const [label, callback] of Object.entries({ onChange, onEvent, onDisconnect })) {
    if (typeof callback !== "function") throw new Error(`Client Session Projection ${label} 必须是函数`);
  }
  return new ClientSessionProjection({ readSession, eventSourceFactory, onChange, onEvent, onDisconnect });
}

class ClientSessionProjection {
  #readSession;
  #eventSourceFactory;
  #onChange;
  #onEvent;
  #onDisconnect;
  #sessionId = null;
  #session = null;
  #cursor = 0;
  #source = null;
  #revision = 0;
  #eventTail = Promise.resolve();
  #queries = new Map();

  constructor(options) {
    this.#readSession = options.readSession;
    this.#eventSourceFactory = options.eventSourceFactory;
    this.#onChange = options.onChange;
    this.#onEvent = options.onEvent;
    this.#onDisconnect = options.onDisconnect;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get session() {
    return this.#session == null ? null : structuredClone(this.#session);
  }

  get cursor() {
    return this.#cursor;
  }

  get phase() {
    return this.#session?.phase || null;
  }

  get permissionProfile() {
    return this.#session?.permissionProfile || null;
  }

  get snapshot() {
    return this.#snapshot();
  }

  async query(key, read) {
    const name = normalizeQueryKey(key);
    if (typeof read !== "function") throw new Error("Client Session Projection query 需要 reader");
    if (!this.#sessionId) throw new Error("当前没有可查询的 Agent Session");

    this.#queries.get(name)?.controller.abort();
    const ticket = {
      controller: new AbortController(),
      revision: this.#revision,
      sessionId: this.#sessionId,
    };
    this.#queries.set(name, ticket);
    try {
      const value = await read(ticket.sessionId, { signal: ticket.controller.signal });
      if (!this.#isCurrentQuery(name, ticket)) return null;
      return { sessionId: ticket.sessionId, value };
    } catch (error) {
      if (!this.#isCurrentQuery(name, ticket) || ticket.controller.signal.aborted) return null;
      throw error;
    } finally {
      if (this.#queries.get(name) === ticket) this.#queries.delete(name);
    }
  }

  async select(sessionId) {
    const id = normalizeSessionId(sessionId);
    const revision = ++this.#revision;
    this.#cancelQueries();
    this.#disconnect();
    let payload;
    try {
      payload = await this.#readSession(id);
    } catch (error) {
      if (revision === this.#revision && this.#sessionId) this.#connect(revision);
      if (revision !== this.#revision) return null;
      throw error;
    }
    if (revision !== this.#revision) return null;
    const current = normalizeReadPayload(payload, id);
    this.#commit(current, "selected");
    this.#connect(revision);
    return this.#snapshot();
  }

  async refresh() {
    if (!this.#sessionId) throw new Error("当前没有可刷新的 Agent Session");
    const id = this.#sessionId;
    const revision = ++this.#revision;
    this.#cancelQueries();
    this.#disconnect();
    let payload;
    try {
      payload = await this.#readSession(id);
    } catch (error) {
      if (revision === this.#revision) this.#connect(revision);
      if (revision !== this.#revision) return null;
      throw error;
    }
    if (revision !== this.#revision) return null;
    const current = normalizeReadPayload(payload, id);
    this.#commit(current, "refreshed");
    this.#connect(revision);
    return this.#snapshot();
  }

  close() {
    this.#revision += 1;
    this.#cancelQueries();
    this.#disconnect();
  }

  #isCurrentQuery(name, ticket) {
    return this.#queries.get(name) === ticket
      && ticket.revision === this.#revision
      && ticket.sessionId === this.#sessionId
      && !ticket.controller.signal.aborted;
  }

  #cancelQueries() {
    for (const ticket of this.#queries.values()) ticket.controller.abort();
    this.#queries.clear();
  }

  #connect(revision) {
    if (!this.#sessionId || revision !== this.#revision) return;
    const url = `/sessions/${encodeURIComponent(this.#sessionId)}/events?after=${this.#cursor}`;
    const source = this.#eventSourceFactory(url);
    if (!source || typeof source.addEventListener !== "function" || typeof source.close !== "function") {
      throw new Error("Client Session Projection 收到无效 EventSource");
    }
    this.#source = source;
    source.addEventListener("session_event", (message) => this.#enqueueEvent(message, revision, source));
    source.onerror = () => {
      if (revision !== this.#revision || source !== this.#source) return;
      this.#notifyDisconnect(new Error("事件流暂时断开，浏览器将自动重连"));
    };
  }

  #disconnect() {
    this.#source?.close();
    this.#source = null;
  }

  #enqueueEvent(message, revision, source) {
    const operation = this.#eventTail
      .then(() => this.#handleEvent(message, revision, source))
      .catch((error) => this.#notifyDisconnect(error));
    this.#eventTail = operation;
    return operation;
  }

  async #handleEvent(message, revision, source) {
    if (revision !== this.#revision || source !== this.#source) return;
    let event;
    try {
      event = JSON.parse(message?.data);
    } catch {
      await this.#recover(revision, source);
      return;
    }
    if (!Number.isSafeInteger(event?.cursor) || event.cursor < 1) {
      await this.#recover(revision, source);
      return;
    }
    if (event.cursor <= this.#cursor) return;

    if (event.baseline) {
      const current = normalizeReadPayload({ session: event.baseline, cursor: event.cursor }, this.#sessionId);
      this.#commit(current, "event");
      this.#notifyEvent(event);
      return;
    }
    if (!event.patch || event.cursor !== this.#cursor + 1) {
      await this.#recover(revision, source);
      return;
    }
    try {
      const next = applyStatePatch(this.#session, event.patch);
      const current = normalizeReadPayload({ session: next, cursor: event.cursor }, this.#sessionId);
      this.#commit(current, "event");
      this.#notifyEvent(event);
    } catch {
      await this.#recover(revision, source);
    }
  }

  async #recover(revision, source) {
    const id = this.#sessionId;
    const payload = await this.#readSession(id);
    if (revision !== this.#revision || source !== this.#source) return;
    this.#commit(normalizeReadPayload(payload, id), "recovered");
  }

  #commit(current, reason) {
    this.#sessionId = current.session.id;
    this.#session = current.session;
    this.#cursor = current.cursor;
    this.#onChange(this.#snapshot(), reason);
  }

  #notifyEvent(event) {
    Promise.resolve(this.#onEvent(structuredClone(event), this.#snapshot()))
      .catch((error) => this.#notifyDisconnect(error));
  }

  #notifyDisconnect(error) {
    this.#onDisconnect(error instanceof Error ? error : new Error(String(error || "事件流异常")));
  }

  #snapshot() {
    return {
      sessionId: this.#sessionId,
      session: this.#session == null ? null : structuredClone(this.#session),
      cursor: this.#cursor,
    };
  }
}

function normalizeSessionId(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Agent Session ID 必须是非空字符串");
  return value.trim();
}

function normalizeQueryKey(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Client Session Projection query key 必须是非空字符串");
  return value.trim();
}

function normalizeReadPayload(payload, expectedId) {
  if (!payload?.session || typeof payload.session !== "object" || Array.isArray(payload.session)) {
    throw new Error("Client Session Projection 缺少 Session baseline");
  }
  if (payload.session.id !== expectedId) throw new Error("Session baseline 与当前选择不匹配");
  if (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0) {
    throw new Error("Session baseline cursor 必须是非负安全整数");
  }
  return { session: structuredClone(payload.session), cursor: payload.cursor };
}
