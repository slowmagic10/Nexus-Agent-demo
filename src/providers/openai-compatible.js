import { createProviderHttpError } from "./errors.js";
import { readSseData } from "./sse.js";

export class OpenAICompatibleProvider {
  constructor({ apiKey, baseUrl, model, thinking = "provider-default", fetchImpl = globalThis.fetch }) {
    if (!apiKey || apiKey.startsWith("REPLACE_WITH_")) {
      throw new Error("模型 API Key 尚未配置；请先填写本地环境文件中的 OPENAI_API_KEY");
    }
    if (typeof fetchImpl !== "function") throw new Error("OpenAI-compatible Provider 需要 fetch 实现");
    this.name = `openai-compatible/${model}`;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.thinking = normalizeThinkingMode(thinking);
    this.fetch = fetchImpl;
  }

  async complete({ systemPrompt, messages, tools, signal }) {
    const response = await this.#request({ systemPrompt, messages, tools, signal, stream: false });
    return normalizeCompletionPayload(await response.json());
  }

  async *stream({ systemPrompt, messages, tools, signal }) {
    const response = await this.#request({ systemPrompt, messages, tools, signal, stream: true });
    const contentType = response.headers.get("content-type") || "";

    // 部分 OpenAI-compatible 服务会忽略 stream=true 并返回普通 JSON。
    if (contentType.includes("application/json")) {
      const completed = normalizeCompletionPayload(await response.json());
      if (completed.text) yield { type: "text_delta", delta: completed.text };
      yield { type: "completed", response: completed };
      return;
    }
    if (!response.body) throw new Error("模型流式接口没有返回响应正文");

    let text = "";
    let reasoningContent = "";
    let finishReason = null;
    let usage = null;
    let sawTerminal = false;
    const toolCalls = new Map();

    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") {
        sawTerminal = true;
        break;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error("模型流式接口返回了无效 SSE JSON");
      }
      if (payload.error) {
        throw createProviderHttpError(payload.error.status || 500, JSON.stringify(payload));
      }

      if (payload.usage) usage = normalizeUsage(payload.usage);
      const choice = payload.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason != null) {
        finishReason = choice.finish_reason;
        sawTerminal = true;
      }
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        yield { type: "text_delta", delta: delta.content };
      }
      if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
      appendToolCallDeltas(toolCalls, delta.tool_calls);
    }

    if (!sawTerminal) throw new Error("模型输出流未返回明确终态（缺少 [DONE] 或 finish_reason）");

    yield {
      type: "completed",
      response: {
        text,
        finishReason,
        toolCalls: normalizeStreamToolCalls(toolCalls),
        usage,
        ...reasoningProviderItems(reasoningContent),
      },
    };
  }

  async #request({ systemPrompt, messages, tools, signal, stream }) {
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: systemPrompt }, ...normalizeMessages(messages)],
        ...(hasTools ? { tools, tool_choice: "auto" } : {}),
        ...(this.thinking === "provider-default" ? {} : { thinking: { type: this.thinking } }),
        ...(stream ? { stream: true } : {}),
      }),
      signal,
    });

    if (!response.ok) throw createProviderHttpError(response.status, await response.text());
    return response;
  }
}

function normalizeThinkingMode(value) {
  if (value === undefined || value === null || value === "provider-default") return "provider-default";
  if (value === "enabled" || value === "disabled") return value;
  throw new Error("OpenAI-compatible Provider thinking 必须是 provider-default、enabled 或 disabled");
}

function normalizeMessages(messages) {
  return (messages || []).map((message) => {
    const reasoningContent = reasoningContentFromProviderItems(message.provider_items);
    return {
      role: message.role,
      content: message.content ?? "",
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
      ...(reasoningContent != null ? { reasoning_content: reasoningContent } : {}),
    };
  });
}

function normalizeCompletionPayload(payload) {
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("模型接口没有返回 assistant message");
  return {
    text: message.content || "",
    finishReason: payload.choices?.[0]?.finish_reason || null,
    toolCalls: (message.tool_calls || []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: parseArguments(call.function.arguments),
    })),
    usage: normalizeUsage(payload.usage),
    ...reasoningProviderItems(message.reasoning_content),
  };
}

function reasoningProviderItems(value) {
  return typeof value === "string" && value.length
    ? { providerItems: [{ type: "reasoning_content", content: value }] }
    : {};
}

function reasoningContentFromProviderItems(items) {
  if (!Array.isArray(items)) return null;
  const content = items
    .filter((item) => item?.type === "reasoning_content" && typeof item.content === "string")
    .map((item) => item.content)
    .join("");
  return content || null;
}

function appendToolCallDeltas(target, deltas) {
  if (!Array.isArray(deltas)) return;
  for (const [position, delta] of deltas.entries()) {
    const index = Number.isSafeInteger(delta.index) ? delta.index : position;
    const current = target.get(index) || { index, id: "", name: "", arguments: "" };
    if (delta.id && !current.id) current.id = delta.id;
    if (delta.function?.name) current.name += delta.function.name;
    if (delta.function?.arguments) current.arguments += delta.function.arguments;
    target.set(index, current);
  }
}

function normalizeStreamToolCalls(toolCalls) {
  return [...toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) => ({
      id: call.id || `stream-tool-${call.index}`,
      name: call.name,
      arguments: parseArguments(call.arguments),
    }));
}

function normalizeUsage(value) {
  const inputTokens = value?.inputTokens ?? value?.prompt_tokens ?? 0;
  const outputTokens = value?.outputTokens ?? value?.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: value?.totalTokens ?? value?.total_tokens ?? inputTokens + outputTokens,
  };
}

function parseArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Tool Arguments JSON 无效：工具参数必须是 JSON 对象");
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error("Tool Arguments JSON 无效：无法解析工具参数");
  }
}
