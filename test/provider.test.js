import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { contextOverflowInfo, createProviderHttpError } from "../src/providers/errors.js";

test("本地模型配置仍为占位 Key 时立即给出明确错误", () => {
  assert.throws(
    () => new OpenAICompatibleProvider({
      apiKey: "REPLACE_WITH_YOUR_API_KEY",
      baseUrl: "https://example.com/v1",
      model: "example-model",
    }),
    /API Key 尚未配置/,
  );
});

test("OpenAI-compatible Provider 解析分块 SSE 并组装增量工具调用", async () => {
  let request;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1/",
    model: "test-model",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\r",
        "\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"好\\n\",\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"read_\",\"arguments\":\"{\\\"pa\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"file\",\"arguments\":\"th\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":5,\"total_tokens\":13}}\n\n",
        "data: [DONE]\n\n",
      ]);
    },
  });

  const events = [];
  for await (const event of provider.stream({
    systemPrompt: "system",
    messages: [{ role: "user", content: "test" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  })) events.push(event);

  assert.equal(request.url, "https://example.com/v1/chat/completions");
  assert.equal(request.body.stream, true);
  assert.equal(request.body.tool_choice, "auto");
  assert.deepEqual(events.slice(0, 2), [
    { type: "text_delta", delta: "你" },
    { type: "text_delta", delta: "好\n" },
  ]);
  assert.deepEqual(events.at(-1), {
    type: "completed",
    response: {
      text: "你好\n",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
    },
  });
});

test("OpenAI-compatible Streaming 在兼容端返回 JSON 时安全降级为单次增量", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    model: "test-model",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "兼容完成", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }), { headers: { "content-type": "application/json" } }),
  });

  const events = [];
  for await (const event of provider.stream({ systemPrompt: "system", messages: [], tools: [] })) events.push(event);

  assert.equal(events[0].delta, "兼容完成");
  assert.equal(events.at(-1).response.usage.totalTokens, 5);
});

test("OpenAI-compatible Streaming 在 SSE 截断且没有明确终态时失败", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    model: "test-model",
    fetchImpl: async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
    ]),
  });

  await assert.rejects(async () => {
    for await (const _event of provider.stream({ systemPrompt: "system", messages: [], tools: [] })) {
      // consume
    }
  }, /终态/);
});

test("OpenAI-compatible Provider 拒绝非法 Tool Arguments JSON", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    model: "test-model",
    fetchImpl: async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"bad-call\",\"function\":{\"name\":\"dangerous_optional\",\"arguments\":\"{bad\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ]),
  });

  await assert.rejects(async () => {
    for await (const _event of provider.stream({ systemPrompt: "system", messages: [], tools: [] })) {
      // consume
    }
  }, /Tool Arguments/);
});

test("OpenAI-compatible Provider 持久化并回传思考模式的 reasoning_content", async () => {
  const requests = [];
  let calls = 0;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    model: "thinking-model",
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      calls += 1;
      if (calls === 1) {
        return sseResponse([
          "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"检查 \"}}]}\n\n",
          "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"文件\",\"tool_calls\":[{\"index\":0,\"id\":\"call-think\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
          "data: [DONE]\n\n",
        ]);
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { content: "完成", reasoning_content: "确认结果", tool_calls: [] },
          finish_reason: "stop",
        }],
      }), { headers: { "content-type": "application/json" } });
    },
  });

  const firstEvents = [];
  for await (const event of provider.stream({
    systemPrompt: "system",
    messages: [{ role: "user", content: "读取文件" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  })) firstEvents.push(event);
  const firstResponse = firstEvents.at(-1).response;

  assert.deepEqual(firstResponse.providerItems, [
    { type: "reasoning_content", content: "检查 文件" },
  ]);

  const secondResponse = await provider.complete({
    systemPrompt: "system",
    messages: [
      { role: "user", content: "读取文件" },
      {
        role: "assistant",
        content: "",
        provider_items: firstResponse.providerItems,
        tool_calls: [{
          id: "call-think",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call-think", content: "README" },
    ],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  });

  assert.equal(requests[1].messages[2].reasoning_content, "检查 文件");
  assert.deepEqual(secondResponse.providerItems, [
    { type: "reasoning_content", content: "确认结果" },
  ]);
});

test("OpenAI-compatible Provider 只在显式配置时发送 thinking 开关", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: "完成", tool_calls: [] }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
  };
  const defaultProvider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    model: "test-model",
    fetchImpl,
  });
  const disabledProvider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    model: "test-model",
    thinking: "disabled",
    fetchImpl,
  });

  await defaultProvider.complete({ systemPrompt: "system", messages: [], tools: [] });
  await disabledProvider.complete({ systemPrompt: "system", messages: [], tools: [] });

  assert.equal("thinking" in requests[0], false);
  assert.deepEqual(requests[1].thinking, { type: "disabled" });
  assert.equal(disabledProvider.thinking, "disabled");
  assert.throws(() => new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    model: "test-model",
    thinking: "sometimes",
    fetchImpl,
  }), /thinking/);
});

test("Provider 错误只把明确的 Context overflow 分类为可重规划", () => {
  const overflow = createProviderHttpError(400, JSON.stringify({
    error: {
      code: "context_length_exceeded",
      type: "invalid_request_error",
      message: "This model's maximum context length is 65,536 tokens. However, you requested 70,000 tokens.",
    },
  }));
  const rateLimit = createProviderHttpError(429, JSON.stringify({
    error: { code: "rate_limit_exceeded", message: "Too many requests" },
  }));

  assert.deepEqual(contextOverflowInfo(overflow), {
    kind: "context_overflow",
    status: 400,
    providerCode: "context_length_exceeded",
    contextLimit: 65_536,
  });
  assert.equal(contextOverflowInfo(rateLimit), null);
});

test("认证和限流 code 优先于冲突的 Context 文案", () => {
  const invalidApiKey = createProviderHttpError(401, JSON.stringify({
    error: {
      code: "invalid_api_key",
      type: "authentication_error",
      message: "Invalid API key. Model maximum context length is 65536 tokens.",
    },
  }));
  const rateLimit = createProviderHttpError(429, JSON.stringify({
    error: {
      code: "rate_limit_exceeded",
      type: "rate_limit_error",
      message: "Rate limit reached. Model maximum context length is 65536 tokens.",
    },
  }));

  assert.equal(invalidApiKey.kind, "http_error");
  assert.equal(invalidApiKey.contextLimit, null);
  assert.equal(contextOverflowInfo(invalidApiKey), null);
  assert.equal(rateLimit.kind, "http_error");
  assert.equal(rateLimit.contextLimit, null);
  assert.equal(contextOverflowInfo(rateLimit), null);
});

function sseResponse(parts) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
