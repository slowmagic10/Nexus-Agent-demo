import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";

test("OpenAI Responses Adapter 转换 durable 消息、工具和流式函数调用", async () => {
  let request;
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1/",
    model: "gpt-test",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return sseResponse([
        event("response.output_text.delta", { type: "response.output_text.delta", delta: "已" }),
        event("response.output_text.delta", { type: "response.output_text.delta", delta: "完成\n" }),
        event("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 1,
          item: { id: "fc-item", type: "function_call", call_id: "call-2", name: "write_file", arguments: "" },
        }),
        event("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: "fc-item",
          output_index: 1,
          delta: "{\"path\":",
        }),
        event("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: "fc-item",
          output_index: 1,
          name: "write_file",
          arguments: "{\"path\":\"result.txt\",\"content\":\"ok\"}",
        }),
        event("response.completed", {
          type: "response.completed",
          response: {
            id: "resp-1",
            status: "completed",
            output_text: "已完成\n",
            output: [
              { type: "message", role: "assistant", content: [{ type: "output_text", text: "已完成\n" }] },
              {
                id: "fc-item",
                type: "function_call",
                call_id: "call-2",
                name: "write_file",
                arguments: "{\"path\":\"result.txt\",\"content\":\"ok\"}",
              },
            ],
            usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
          },
        }),
      ]);
    },
  });

  const events = [];
  for await (const item of provider.stream({
    systemPrompt: "system rules",
    messages: [
      { role: "user", content: "读取文件" },
      {
        role: "assistant",
        content: "开始读取",
        provider_items: [{ type: "reasoning", id: "rs-previous", encrypted_content: "encrypted-state", summary: [] }],
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
      },
      { role: "tool", tool_call_id: "call-1", content: "README content" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "write_file",
        description: "write a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
  })) events.push(item);

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.body.model, "gpt-test");
  assert.equal(request.body.instructions, "system rules");
  assert.equal(request.body.stream, true);
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(request.body.tools, [{
    type: "function",
    name: "write_file",
    description: "write a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }]);
  assert.deepEqual(request.body.input, [
    { role: "user", content: "读取文件" },
    { type: "reasoning", id: "rs-previous", encrypted_content: "encrypted-state", summary: [] },
    { role: "assistant", content: "开始读取" },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
    { type: "function_call_output", call_id: "call-1", output: "README content" },
  ]);
  assert.deepEqual(events.slice(0, 2), [
    { type: "text_delta", delta: "已" },
    { type: "text_delta", delta: "完成\n" },
  ]);
  assert.deepEqual(events.at(-1), {
    type: "completed",
    response: {
      text: "已完成\n",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call-2", name: "write_file", arguments: { path: "result.txt", content: "ok" } }],
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    },
  });
});

test("OpenAI Responses Adapter 的非流式 complete 与 JSON streaming fallback 使用同一结果语义", async () => {
  const payload = {
    id: "resp-json",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      { type: "reasoning", id: "rs-json", encrypted_content: "encrypted-json", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "部分回答" }] },
    ],
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  };
  const requests = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test",
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    },
  });

  const completed = await provider.complete({ systemPrompt: "system", messages: [], tools: [] });
  const streamed = [];
  for await (const item of provider.stream({ systemPrompt: "system", messages: [], tools: [] })) streamed.push(item);

  assert.deepEqual(completed, {
    text: "部分回答",
    finishReason: "max_output_tokens",
    toolCalls: [],
    usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
    providerItems: [{ type: "reasoning", id: "rs-json", encrypted_content: "encrypted-json", summary: [] }],
  });
  assert.deepEqual(streamed, [
    { type: "text_delta", delta: "部分回答" },
    { type: "completed", response: completed },
  ]);
  assert.equal(requests[0].stream, undefined);
  assert.equal(requests[1].stream, true);
});

test("OpenAI Responses incomplete 即使携带函数调用也保留非正常终态", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{
        type: "function_call",
        call_id: "partial-call",
        name: "write_file",
        arguments: "{\"path\":\"partial.txt\"}",
      }],
    }), { headers: { "content-type": "application/json" } }),
  });

  const completed = await provider.complete({ systemPrompt: "system", messages: [], tools: [] });

  assert.equal(completed.finishReason, "max_output_tokens");
  assert.deepEqual(completed.toolCalls, [{ id: "partial-call", name: "write_file", arguments: { path: "partial.txt" } }]);
});

test("OpenAI Responses Adapter 拒绝非法 Tool Arguments JSON", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "completed",
      output: [{
        type: "function_call",
        call_id: "bad-call",
        name: "dangerous_optional",
        arguments: "{bad",
      }],
    }), { headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    provider.complete({ systemPrompt: "system", messages: [], tools: [] }),
    /Tool Arguments/,
  );
});

test("OpenAI Responses 流式失败事件规范化为 Provider 错误", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test",
    fetchImpl: async () => sseResponse([event("response.failed", {
      type: "response.failed",
      response: { status: "failed", error: { code: "rate_limit_exceeded", message: "Too many requests" } },
    })]),
  });

  await assert.rejects(async () => {
    for await (const _item of provider.stream({ systemPrompt: "system", messages: [], tools: [] })) {
      // consume
    }
  }, (error) => error.providerCode === "rate_limit_exceeded" && error.kind === "http_error");
});

function event(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(parts) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
