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
  #publishedBoundary = 0;
  #publishedPreview = null;
  #lastChannel = "stdout";
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

    const boundary = completeLineBoundary(this.#raw);
    if (boundary <= this.#publishedBoundary) return this.#tail;
    if (this.#publishedPreview !== null
      && !this.#truncated
      && boundary - this.#publishedBoundary < this.#minUpdateChars) return this.#tail;
    return this.#publish(boundary);
  }

  async close() {
    if (this.#closed) return await this.#tail;
    this.#closed = true;
    const boundary = this.#truncated ? completeLineBoundary(this.#raw) : this.#raw.length;
    await this.#publish(boundary, { force: true });
    return await this.#tail;
  }

  #publish(boundary, { force = false } = {}) {
    const visible = this.#raw.slice(0, boundary);
    let preview = redactSensitiveText(visible);
    if (this.#truncated) {
      preview = preview
        ? `${preview}${preview.endsWith("\n") ? "" : "\n"}…（实时输出达到预览上限）`
        : "…（实时输出达到预览上限；不完整首行未写入预览）";
    }
    if (!preview || (!force && preview === this.#publishedPreview)) return this.#tail;
    if (force && preview === this.#publishedPreview) return this.#tail;

    const action = {
      type: "TOOL_OUTPUT_UPDATED",
      callId: this.#call.id,
      tool: this.#call.name,
      preview,
      capturedChars: this.#raw.length,
      truncated: this.#truncated,
      channel: this.#lastChannel,
    };
    const operation = this.#tail
      .catch(() => {})
      .then(() => this.#dispatch(action))
      .then((value) => {
        this.#publishedBoundary = boundary;
        this.#publishedPreview = preview;
        return value;
      });
    this.#tail = operation;
    return operation;
  }
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
