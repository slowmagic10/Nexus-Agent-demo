import { createProviderHttpError } from "./errors.js";
import { readSseData } from "./sse.js";

export class OpenAIResponsesProvider {
  constructor({ apiKey, baseUrl = "https://api.openai.com/v1", model, fetchImpl = globalThis.fetch }) {
    if (!apiKey || apiKey.startsWith("REPLACE_WITH_")) {
      throw new Error("OpenAI API Key 尚未配置；请先填写本地环境文件中的 OPENAI_API_KEY");
    }
    if (typeof fetchImpl !== "function") throw new Error("OpenAI Responses Provider 需要 fetch 实现");
    this.name = `openai-responses/${model}`;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.fetch = fetchImpl;
  }

  async complete({ systemPrompt, messages, tools, signal }) {
    const response = await this.#request({ systemPrompt, messages, tools, signal, stream: false });
    const payload = await response.json();
    throwForTerminalError(payload);
    return normalizeResponse(payload);
  }

  async *stream({ systemPrompt, messages, tools, signal }) {
    const response = await this.#request({ systemPrompt, messages, tools, signal, stream: true });
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      throwForTerminalError(payload);
      const completed = normalizeResponse(payload);
      if (completed.text) yield { type: "text_delta", delta: completed.text };
      yield { type: "completed", response: completed };
      return;
    }
    if (!response.body) throw new Error("OpenAI Responses 流式接口没有返回响应正文");

    let text = "";
    const toolCalls = new Map();
    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") break;
      const event = parseStreamEvent(data);
      switch (event.type) {
        case "response.output_text.delta":
          if (typeof event.delta === "string" && event.delta) {
            text += event.delta;
            yield { type: "text_delta", delta: event.delta };
          }
          break;
        case "response.output_item.added":
        case "response.output_item.done":
          captureFunctionCallItem(toolCalls, event.item, event.output_index);
          break;
        case "response.function_call_arguments.delta":
          appendFunctionArguments(toolCalls, event);
          break;
        case "response.function_call_arguments.done":
          finishFunctionArguments(toolCalls, event);
          break;
        case "response.completed":
        case "response.incomplete": {
          const completed = normalizeResponse(event.response || {}, {
            fallbackText: text,
            fallbackToolCalls: normalizeCapturedCalls(toolCalls),
          });
          yield { type: "completed", response: completed };
          return;
        }
        case "response.failed":
        case "response.cancelled":
          throw responseEventError(event.response?.error || event.error || event, event.type);
        case "error":
          throw responseEventError(event, event.type);
        default:
          break;
      }
    }
    throw new Error("OpenAI Responses 输出流未返回终态事件");
  }

  async #request({ systemPrompt, messages, tools, signal, stream }) {
    const responsesTools = normalizeTools(tools);
    const response = await this.fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        instructions: String(systemPrompt || ""),
        input: normalizeInput(messages),
        store: false,
        include: ["reasoning.encrypted_content"],
        ...(responsesTools.length ? { tools: responsesTools, tool_choice: "auto" } : {}),
        ...(stream ? { stream: true } : {}),
      }),
      signal,
    });
    if (!response.ok) throw createProviderHttpError(response.status, await response.text());
    return response;
  }
}

function normalizeInput(messages) {
  const input = [];
  for (const message of messages || []) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: String(message.content || ""),
      });
      continue;
    }
    for (const item of message.provider_items || []) input.push(normalizeProviderItem(item));
    if (message.content) input.push({ role: message.role, content: message.content });
    for (const call of message.tool_calls || []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function?.name,
        arguments: normalizeArgumentsText(call.function?.arguments),
      });
    }
  }
  return input;
}

function normalizeTools(tools) {
  return (tools || []).map((tool) => {
    if (tool?.type !== "function" || !tool.function?.name) {
      throw new Error("OpenAI Responses Adapter 只接受 Nexus function tool schema");
    }
    return {
      type: "function",
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters || { type: "object", properties: {} },
      ...(tool.function.strict !== undefined ? { strict: tool.function.strict === true } : {}),
    };
  });
}

function normalizeResponse(payload, { fallbackText = "", fallbackToolCalls = [] } = {}) {
  throwForTerminalError(payload);
  const toolCalls = normalizeOutputToolCalls(payload.output);
  const resolvedCalls = toolCalls.length ? toolCalls : fallbackToolCalls;
  const text = typeof payload.output_text === "string"
    ? payload.output_text
    : outputText(payload.output) || fallbackText;
  const providerItems = normalizeProviderItems(payload.output);
  const incompleteReason = payload.incomplete_details?.reason
    || (payload.status === "incomplete" ? "incomplete" : null);
  return {
    text,
    finishReason: incompleteReason || (resolvedCalls.length
      ? "tool_calls"
      : payload.status === "completed" ? "stop" : payload.status || null),
    toolCalls: resolvedCalls,
    usage: normalizeUsage(payload.usage),
    ...(providerItems.length ? { providerItems } : {}),
  };
}

function normalizeProviderItems(output) {
  return (output || [])
    .filter((item) => item?.type === "reasoning")
    .map(normalizeProviderItem);
}

function normalizeProviderItem(item) {
  if (item?.type !== "reasoning") throw new Error("OpenAI Responses provider_items 只接受 reasoning item");
  return {
    type: "reasoning",
    ...(item.id ? { id: item.id } : {}),
    ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}),
    summary: Array.isArray(item.summary) ? item.summary : [],
  };
}

function normalizeOutputToolCalls(output) {
  return (output || [])
    .filter((item) => item?.type === "function_call")
    .map((item, index) => ({
      id: item.call_id || item.id || `response-tool-${index}`,
      name: item.name,
      arguments: parseArguments(item.arguments),
    }));
}

function outputText(output) {
  return (output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .map((part) => part?.type === "output_text" ? part.text : part?.type === "refusal" ? part.refusal : "")
    .join("");
}

function captureFunctionCallItem(target, item, outputIndex) {
  if (item?.type !== "function_call") return;
  const key = item.id || `output-${outputIndex}`;
  const current = target.get(key) || { key, index: outputIndex, id: "", name: "", arguments: "" };
  current.id = item.call_id || current.id;
  current.name = item.name || current.name;
  if (typeof item.arguments === "string" && item.arguments) current.arguments = item.arguments;
  target.set(key, current);
}

function appendFunctionArguments(target, event) {
  const key = event.item_id || `output-${event.output_index}`;
  const current = target.get(key) || { key, index: event.output_index, id: event.call_id || "", name: event.name || "", arguments: "" };
  current.arguments += String(event.delta || "");
  target.set(key, current);
}

function finishFunctionArguments(target, event) {
  const key = event.item_id || `output-${event.output_index}`;
  const current = target.get(key) || { key, index: event.output_index, id: event.call_id || "", name: "", arguments: "" };
  current.id = event.call_id || current.id;
  current.name = event.name || current.name;
  if (typeof event.arguments === "string") current.arguments = event.arguments;
  target.set(key, current);
}

function normalizeCapturedCalls(target) {
  return [...target.values()]
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((call, index) => ({
      id: call.id || `response-tool-${index}`,
      name: call.name,
      arguments: parseArguments(call.arguments),
    }));
}

function throwForTerminalError(payload) {
  if (payload?.error) throw responseEventError(payload.error, payload.status || "response.failed");
  if (payload?.status === "failed" || payload?.status === "cancelled") {
    throw responseEventError(payload.error || { message: `Responses 状态为 ${payload.status}` }, payload.status);
  }
}

function responseEventError(error, type) {
  const normalized = error && typeof error === "object" ? error : { message: String(error || type) };
  return createProviderHttpError(500, JSON.stringify({ error: normalized }));
}

function parseStreamEvent(data) {
  try {
    const event = JSON.parse(data);
    if (!event || typeof event.type !== "string") throw new Error("missing type");
    return event;
  } catch {
    throw new Error("OpenAI Responses 流式接口返回了无效 SSE JSON");
  }
}

function normalizeUsage(value) {
  if (!value) return null;
  const reportedInput = value.inputTokens ?? value.input_tokens;
  const reportedOutput = value.outputTokens ?? value.output_tokens;
  if (reportedInput === undefined && reportedOutput === undefined) return null;
  return {
    ...(reportedInput === undefined ? {} : { inputTokens: reportedInput }),
    ...(reportedOutput === undefined ? {} : { outputTokens: reportedOutput }),
    ...(reportedInput === undefined || reportedOutput === undefined
      ? {}
      : { totalTokens: value.totalTokens ?? value.total_tokens ?? reportedInput + reportedOutput }),
  };
}

function normalizeArgumentsText(value) {
  return typeof value === "string" ? value : JSON.stringify(value || {});
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
