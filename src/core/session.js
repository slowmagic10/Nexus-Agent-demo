// FOUNDATION — the single durable mutation boundary for an Agent session.
import { redactSensitiveValue } from "../security/redact.js";
import { createStatePatch } from "../state-patch.js";
import { ModelContextProjection } from "./model-context.js";
import { queryToolHistory } from "./tool-history.js";

export class AgentSession {
  #state;
  #reducer;
  #journal;
  #subscribers = new Set();
  #eventSubscribers = new Set();
  #dispatchTail = Promise.resolve();
  #cursor = 0;
  #modelContext;
  #closed = false;

  constructor({ state, reducer, journal = null, onState = null }) {
    if (!state?.id) throw new Error("AgentSession 需要有效的初始状态");
    if (typeof reducer !== "function") throw new Error("AgentSession 需要 reducer");
    this.#reducer = reducer;
    this.#journal = journal;
    const restored = journal?.ensureJournalWithReceipt?.(state);
    this.#state = restored?.state || journal?.ensureJournal(state) || structuredClone(state);
    this.#cursor = restored?.cursor ?? (journal?.latestSessionCursor?.(this.#state.id) || 0);
    const durableEvents = restored?.events ?? (journal?.readProjectionEvents?.(this.#state.id)
      || journal?.readSessionEvents?.(this.#state.id)
      || []);
    this.#modelContext = new ModelContextProjection(durableEvents, this.#state);
    if (onState) this.subscribe(onState);
  }

  get id() {
    return this.#state.id;
  }

  get state() {
    return structuredClone(this.#state);
  }

  get cursor() {
    return this.#cursor;
  }

  dispatch(action) {
    return this.dispatchWithReceipt(action).then(({ state }) => state);
  }

  dispatchWithReceipt(action, { includeState = true } = {}) {
    if (this.#closed) return Promise.reject(new Error(`会话已删除或关闭：${this.id}`));
    const operation = this.#dispatchTail.then(() => this.#commit(action, includeState));
    this.#dispatchTail = operation.catch(() => {});
    return operation;
  }

  async drain() {
    let tail;
    do {
      tail = this.#dispatchTail;
      await tail;
    } while (tail !== this.#dispatchTail);
  }

  close() {
    this.#closed = true;
    this.#subscribers.clear();
    this.#eventSubscribers.clear();
  }

  subscribe(listener, { immediate = false } = {}) {
    if (typeof listener !== "function") throw new Error("会话订阅者必须是函数");
    this.#subscribers.add(listener);
    if (immediate) listener(this.state);
    return () => this.#subscribers.delete(listener);
  }

  prepareModelRequest(options) {
    return this.#modelContext.prepareRequest(options);
  }

  queryToolHistory(options = {}) {
    if (this.#closed) throw new Error(`会话已删除或关闭：${this.id}`);
    return queryToolHistory(this.#journal, this.id, options);
  }

  events({ after = 0, limit = 500 } = {}) {
    validateCursor(after);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("事件读取 limit 必须是 1 到 1000 的整数");
    }
    return this.#journal?.readSessionEvents?.(this.id, { after, limit }) || [];
  }

  subscribeEvents(listener, { after = 0 } = {}) {
    if (typeof listener !== "function") throw new Error("事件订阅者必须是函数");
    validateCursor(after);
    let cursor = after;
    while (true) {
      const batch = this.events({ after: cursor, limit: 1000 });
      for (const event of batch) {
        listener(structuredClone(event));
        cursor = event.cursor;
      }
      if (batch.length < 1000) break;
    }
    const subscription = { listener, cursor };
    this.#eventSubscribers.add(subscription);
    return () => this.#eventSubscribers.delete(subscription);
  }

  async #commit(action, includeState) {
    if (this.#closed) throw new Error(`会话已删除或关闭：${this.id}`);
    const durableAction = normalizeAction(action);
    const next = this.#reducer(this.#state, durableAction);
    const patch = createStatePatch(this.#state, next);
    const event = this.#journal?.commitSessionEvent(next, durableAction, patch, { expectedCursor: this.#cursor }) || {
      cursor: this.#cursor + 1,
      sessionId: this.id,
      type: durableAction.type,
      at: durableAction.at,
      action: durableAction,
      patch,
    };
    this.#cursor = event.cursor;
    this.#state = next;
    this.#modelContext.applyEvent(event, next);
    for (const subscription of this.#eventSubscribers) {
      if (event.cursor <= subscription.cursor) continue;
      subscription.cursor = event.cursor;
      notifyObserver(subscription.listener, structuredClone(event));
    }
    for (const listener of this.#subscribers) notifyObserver(listener, structuredClone(next));
    // Return this commit's cursor with its detached state. Another queued
    // dispatch may finish before the caller resumes from awaiting the receipt.
    return includeState ? { state: this.state, cursor: event.cursor } : { cursor: event.cursor };
  }
}

function notifyObserver(listener, value) {
  try {
    const result = listener(value);
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Durable commit 已经完成；投影层异常不能将成功提交伪装成失败。
  }
}

function validateCursor(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error("事件游标必须是非负整数");
}

function normalizeAction(action) {
  if (!action || typeof action.type !== "string") throw new Error("会话动作必须包含 type");
  return redactSensitiveValue({
    ...structuredClone(action),
    at: action.at || new Date().toISOString(),
  });
}
