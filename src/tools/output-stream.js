// FOUNDATION — bounded, redacted durable preview for in-flight tool output.
import { redactSensitiveText } from "../security/redact.js";

const OUTPUT_CHANNELS = new Set(["stdout", "stderr"]);

export function createToolOutputStream({
  call,
  dispatch,
  maxPreviewChars = 12_000,
  minUpdateChars = 256,
} = {}) {
  if (!call?.id || !call?.name) throw new Error("Tool Output Stream 需要 Tool Call identity");
  if (typeof dispatch !== "function") throw new Error("Tool Output Stream 需要 durable dispatch");
  if (!Number.isSafeInteger(maxPreviewChars) || maxPreviewChars < 1) {
    throw new Error("Tool Output Stream maxPreviewChars 必须是正整数");
  }
  if (!Number.isSafeInteger(minUpdateChars) || minUpdateChars < 1) {
    throw new Error("Tool Output Stream minUpdateChars 必须是正整数");
  }
  return new ToolOutputStream({ call, dispatch, maxPreviewChars, minUpdateChars });
}

class ToolOutputStream {
  #call;
  #dispatch;
  #maxPreviewChars;
  #minUpdateChars;
  #raw = "";
  #truncated = false;
  #lastChannel = "stdout";
  #published = null;
  #active = null;
  #pending = null;
  #tail = Promise.resolve();
  #closed = false;

  constructor({ call, dispatch, maxPreviewChars, minUpdateChars }) {
    this.#call = { id: call.id, name: call.name };
    this.#dispatch = dispatch;
    this.#maxPreviewChars = maxPreviewChars;
    this.#minUpdateChars = minUpdateChars;
  }

  append(event) {
    if (this.#closed) throw new Error("Tool Output Stream 已关闭");
    const { channel, chunk } = normalizeOutputEvent(event);
    this.#lastChannel = channel;
    const remaining = this.#maxPreviewChars - this.#raw.length;
    if (remaining > 0) this.#raw += chunk.slice(0, remaining);
    if (chunk.length > remaining) this.#truncated = true;
    return this.#publish(completeLineBoundary(this.#raw));
  }

  async close() {
    if (this.#closed) return await this.#tail;
    this.#closed = true;
    const boundary = this.#truncated ? completeLineBoundary(this.#raw) : this.#raw.length;
    return await this.#publish(boundary, { force: true });
  }

  #publish(boundary, { force = false } = {}) {
    const snapshot = { boundary, visible: this.#raw.slice(0, boundary),
      capturedChars: this.#raw.length, truncated: this.#truncated, channel: this.#lastChannel };
    if (!snapshot.visible && !snapshot.truncated) return this.#tail;
    if (this.#pending) {
      // All burst callers share this acknowledgement. No per-chunk Promise or
      // captured action accumulates while the current dispatch is unresolved.
      this.#pending.snapshot = snapshot;
      return this.#pending.promise;
    }
    if (this.#active) {
      if (!force && sameVisible(snapshot, this.#active.snapshot)) return this.#active.promise;
      // close keeps one pending retry even for the active preview: a successful
      // active commit deduplicates it, while a failed one may be repaired.
      this.#pending = deferredSnapshot(snapshot);
      this.#tail = this.#pending.promise;
      return this.#tail;
    }
    if (this.#published) {
      if (sameVisible(snapshot, this.#published.snapshot)) return this.#tail;
      if (!force && !snapshot.truncated
        && boundary - this.#published.snapshot.boundary < this.#minUpdateChars) return this.#tail;
    }
    const slot = deferredSnapshot(snapshot);
    this.#tail = slot.promise;
    this.#start(slot);
    return slot.promise;
  }

  #start(slot) {
    this.#active = slot;
    const snapshot = slot.snapshot;
    let preview;
    Promise.resolve().then(() => {
      preview = redactSensitiveText(snapshot.visible);
      if (snapshot.truncated) {
        preview = preview
          ? `${preview}${preview.endsWith("\n") ? "" : "\n"}…（实时输出达到预览上限）`
          : "…（实时输出达到预览上限；不完整首行未写入预览）";
      }
      if (preview === this.#published?.preview) return this.#published.value;
      return this.#dispatch({ type: "TOOL_OUTPUT_UPDATED", callId: this.#call.id, tool: this.#call.name,
        preview, capturedChars: snapshot.capturedChars, truncated: snapshot.truncated, channel: snapshot.channel });
    }).then((value) => {
      this.#published = { snapshot, preview, value };
      slot.resolve(value);
      this.#finish(slot);
    }, (error) => {
      slot.reject(error);
      this.#finish(slot);
    });
  }

  #finish(slot) {
    if (this.#active !== slot) return;
    this.#active = null;
    const next = this.#pending;
    this.#pending = null;
    if (next) this.#start(next);
  }
}

function sameVisible(left, right) {
  return left.visible === right.visible && left.truncated === right.truncated;
}

function deferredSnapshot(snapshot) {
  let resolve;
  let reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  // Fire-and-forget producers are supported. The original Promise still
  // rejects for callers/close; this only prevents an unobserved rejection.
  promise.catch(() => {});
  return { snapshot, promise, resolve, reject };
}

function normalizeOutputEvent(event) {
  if (!event || typeof event !== "object") throw new Error("Tool Output Stream event 必须是对象");
  if (!OUTPUT_CHANNELS.has(event.channel)) throw new Error(`Tool Output Stream channel 无效：${event.channel}`);
  const chunk = typeof event.chunk === "string" ? event.chunk : event.chunk?.toString?.();
  if (typeof chunk !== "string" || !chunk) throw new Error("Tool Output Stream chunk 必须是非空字符串");
  return { channel: event.channel, chunk };
}

function completeLineBoundary(value) {
  return value.lastIndexOf("\n") + 1;
}
