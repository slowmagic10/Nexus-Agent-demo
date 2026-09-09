import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";

const baseOptions = { apiKey: "test-key", baseUrl: "https://example.invalid/v1/", model: "unclassified-model" };
const input = { systemPrompt: "规则", messages: [{ role: "user", content: "执行" }], tools: [] };
const chatPayload = { choices: [{ message: { content: "完成" }, finish_reason: "stop" }] };
const responsesPayload = { status: "completed", output_text: "完成", output: [] };

test("两个 Provider 未配置请求策略时 complete 和 stream 保持原有 JSON 字节形状", async () => {
  for (const [Provider, path, expected, payload] of [
    [OpenAICompatibleProvider, "chat/completions", '{"model":"unclassified-model","messages":[{"role":"system","content":"规则"},{"role":"user","content":"执行"}]}', chatPayload],
    [OpenAIResponsesProvider, "responses", '{"model":"unclassified-model","instructions":"规则","input":[{"role":"user","content":"执行"}],"store":false,"include":["reasoning.encrypted_content"]}', responsesPayload],
  ]) {
    const requests = [];
    const provider = new Provider({ ...baseOptions, fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      return jsonResponse(payload);
    } });
    const signal = new AbortController().signal;
    await provider.complete({ ...input, signal });
    await consume(provider.stream({ ...input, signal }));
    assert.equal(requests[0].body, expected);
    assert.equal(requests[1].body, expected.slice(0, -1) + ',"stream":true}');
    for (const request of requests) {
      assert.equal(request.url, `https://example.invalid/v1/${path}`);
      assert.equal(request.method, "POST");
      assert.deepEqual(request.headers, { "content-type": "application/json", authorization: "Bearer test-key" });
      assert.equal(request.signal, signal);
    }
  }
});

for (const outputTokenParameter of ["max_tokens", "max_completion_tokens"]) {
  test(`兼容 Provider 明确选择 ${outputTokenParameter} 后只发送该上限，usage 只加在流式请求`, async () => {
    const requests = [];
    const provider = new OpenAICompatibleProvider({
      ...baseOptions,
      maxOutputTokens: 2_048,
      outputTokenParameter,
      streamUsage: true,
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return jsonResponse({ ...chatPayload, usage: { prompt_tokens: 8, completion_tokens: 2 } });
      },
    });
    const completed = await provider.complete(input);
    const streamed = await consume(provider.stream(input));
    const expected = {
      model: baseOptions.model,
      messages: [{ role: "system", content: input.systemPrompt }, ...input.messages],
      [outputTokenParameter]: 2_048,
    };
    assert.deepEqual(requests[0], expected);
    assert.deepEqual(requests[1], { ...expected, stream: true, stream_options: { include_usage: true } });
    assert.deepEqual(completed.usage, { inputTokens: 8, outputTokens: 2, totalTokens: 10 });
    assert.deepEqual(streamed.at(-1).response.usage, completed.usage);
  });
}

for (const streamUsage of [false, true]) {
  test(`兼容 Provider streamUsage=${streamUsage} 仍接收 choices 为空的最终 usage 块`, async () => {
    let request;
    const provider = new OpenAICompatibleProvider({
      ...baseOptions,
      streamUsage,
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return sseResponse([
          { choices: [{ delta: { content: "完成" }, finish_reason: "stop" }], usage: null },
          { choices: [], usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 } },
          "[DONE]",
        ]);
      },
    });
    const events = await consume(provider.stream(input));
    assert.deepEqual(events, [
      { type: "text_delta", delta: "完成" },
      { type: "completed", response: { text: "完成", finishReason: "stop", toolCalls: [], usage: { inputTokens: 11, outputTokens: 9, totalTokens: 20 } } },
    ]);
    assert.deepEqual(request.stream_options, streamUsage ? { include_usage: true } : undefined);
    assert.equal("max_tokens" in request, false);
    assert.equal("max_completion_tokens" in request, false);
  });
}

test("仅配置兼容输出参数名不会臆造输出上限，显式关闭 usage 不发送 stream_options", async () => {
  let request;
  const provider = new OpenAICompatibleProvider({ ...baseOptions, outputTokenParameter: "max_tokens", streamUsage: false, fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return jsonResponse(chatPayload);
  } });
  await consume(provider.stream(input));
  assert.deepEqual(request, { model: baseOptions.model, messages: [{ role: "system", content: input.systemPrompt }, ...input.messages], stream: true });
});

test("兼容 Provider 的直接构造器拒绝不明确或非法请求策略", () => {
  for (const options of [
    { maxOutputTokens: 1 },
    { maxOutputTokens: 0, outputTokenParameter: "max_tokens" },
    { maxOutputTokens: -1, outputTokenParameter: "max_tokens" },
    { maxOutputTokens: 1.5, outputTokenParameter: "max_tokens" },
    { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokenParameter: "max_tokens" },
    { maxOutputTokens: "2048", outputTokenParameter: "max_tokens" },
    { maxOutputTokens: 2048, outputTokenParameter: "max_output_tokens" },
    { streamUsage: "true" },
    { streamUsage: 1 },
  ]) assert.throws(() => new OpenAICompatibleProvider({ ...baseOptions, ...options }));
});

test("兼容 Provider 配置输出上限后仍完整保留工具轮的 reasoning_content", async () => {
  const requests = [];
  const provider = new OpenAICompatibleProvider({ ...baseOptions, maxOutputTokens: 4096, outputTokenParameter: "max_completion_tokens", streamUsage: true, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return sseResponse([
      { choices: [{ delta: { reasoning_content: "检查 " } }] },
      { choices: [{ delta: { reasoning_content: "文件", tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 40 } },
      "[DONE]",
    ]);
    return jsonResponse({ choices: [{ message: { content: "完成", reasoning_content: "确认结果" }, finish_reason: "stop" }] });
  } });
  const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
  const first = (await consume(provider.stream({ ...input, tools }))).at(-1).response;
  assert.deepEqual(first.toolCalls, [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }]);
  const second = await provider.complete({ ...input, tools, messages: [
    ...input.messages,
    { role: "assistant", content: "", provider_items: first.providerItems, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: "README" },
  ] });
  assert.deepEqual(first.providerItems, [{ type: "reasoning_content", content: "检查 文件" }]);
  assert.deepEqual(second.providerItems, [{ type: "reasoning_content", content: "确认结果" }]);
  assert.deepEqual(first.usage, { inputTokens: 20, outputTokens: 40, totalTokens: 60 });
  assert.equal(requests[1].messages[2].reasoning_content, "检查 文件");
  for (const request of requests) {
    assert.equal(request.max_completion_tokens, 4096);
    assert.equal("max_tokens" in request, false);
    assert.equal(request.tool_choice, "auto");
  }
  assert.deepEqual(requests[0].stream_options, { include_usage: true });
  assert.equal("stream_options" in requests[1], false);
});

test("Responses 输出上限仅映射 max_output_tokens，工具轮的加密 reasoning 仍原样续传", async () => {
  const requests = [];
  const reasoning = { type: "reasoning", id: "rs-1", encrypted_content: "opaque-state", summary: [] };
  const provider = new OpenAIResponsesProvider({ ...baseOptions, maxOutputTokens: 3072, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return sseResponse([{ type: "response.completed", response: {
      status: "completed",
      output: [reasoning, { type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
      usage: { input_tokens: 20, output_tokens: 30 },
    } }]);
    return jsonResponse(responsesPayload);
  } });
  const first = (await consume(provider.stream(input))).at(-1).response;
  await provider.complete({ ...input, messages: [
    ...input.messages,
    { role: "assistant", content: "", provider_items: first.providerItems, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: "README" },
  ] });
  assert.deepEqual(first.providerItems, [reasoning]);
  assert.deepEqual(first.usage, { inputTokens: 20, outputTokens: 30, totalTokens: 50 });
  assert.deepEqual(requests[1].input, [
    ...input.messages,
    reasoning,
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' },
    { type: "function_call_output", call_id: "call-1", output: "README" },
  ]);
  for (const request of requests) {
    assert.equal(request.max_output_tokens, 3072);
    assert.equal(request.store, false);
    assert.deepEqual(request.include, ["reasoning.encrypted_content"]);
    assert.equal("max_tokens" in request, false);
    assert.equal("max_completion_tokens" in request, false);
    assert.equal("stream_options" in request, false);
  }
  assert.equal(requests[0].stream, true);
  assert.equal("stream" in requests[1], false);
});

test("Responses 的直接构造器拒绝兼容层参数和非法输出上限", () => {
  for (const options of [
    { outputTokenParameter: "max_tokens" },
    { outputTokenParameter: "max_completion_tokens" },
    { outputTokenParameter: "max_output_tokens" },
    { streamUsage: true },
    { streamUsage: "false" },
    { maxOutputTokens: 0 },
    { maxOutputTokens: -1 },
    { maxOutputTokens: 1.5 },
    { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { maxOutputTokens: "3072" },
  ]) assert.throws(() => new OpenAIResponsesProvider({ ...baseOptions, ...options }));
});

for (const [name, Provider, policy] of [
  ["兼容", OpenAICompatibleProvider, { maxOutputTokens: 2048, outputTokenParameter: "max_completion_tokens", streamUsage: true }],
  ["Responses", OpenAIResponsesProvider, { maxOutputTokens: 2048 }],
]) {
  test(`${name} Provider 上限参数被服务端拒绝时不更换字段或重放请求`, async () => {
    for (const stream of [false, true]) {
      let requests = 0;
      const provider = new Provider({ ...baseOptions, ...policy, fetchImpl: async () => {
        requests += 1;
        return new Response(JSON.stringify({ error: { code: "unsupported_parameter", message: "Unsupported output limit parameter" } }), { status: 400 });
      } });
      await assert.rejects(stream ? consume(provider.stream(input)) : provider.complete(input), (error) => error.status === 400 && error.providerCode === "unsupported_parameter");
      assert.equal(requests, 1);
    }
  });

  test(`${name} Provider 请求策略不改变取消信号，也不重试取消请求`, async () => {
    for (const stream of [false, true]) {
      const controller = new AbortController();
      const abortError = new DOMException("停止本次请求", "AbortError");
      let requests = 0;
      const provider = new Provider({ ...baseOptions, ...policy, fetchImpl: async (_url, options) => {
        requests += 1;
        assert.equal(options.signal, controller.signal);
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
          controller.abort(abortError);
        });
      } });
      await assert.rejects(stream ? consume(provider.stream({ ...input, signal: controller.signal })) : provider.complete({ ...input, signal: controller.signal }), (error) => error === abortError);
      assert.equal(requests, 1);
    }
  });

  test(`${name} Provider 显式请求策略保留异常 JSON 和工具参数拒绝语义`, async () => {
    for (const [payload, expected] of [
      ["{invalid-json", /JSON/],
      [Provider === OpenAICompatibleProvider
        ? JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "bad", function: { name: "read_file", arguments: "[]" } }] }, finish_reason: "tool_calls" }] })
        : JSON.stringify({ status: "completed", output: [{ type: "function_call", call_id: "bad", name: "read_file", arguments: "[]" }] }), /Tool Arguments/],
    ]) {
      for (const stream of [false, true]) {
        let requests = 0;
        const provider = new Provider({ ...baseOptions, ...policy, fetchImpl: async () => {
          requests += 1;
          return new Response(payload, { headers: { "content-type": "application/json" } });
        } });
        await assert.rejects(stream ? consume(provider.stream(input)) : provider.complete(input), expected);
        assert.equal(requests, 1);
      }
    }
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function sseResponse(values) {
  return new Response(values.map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function consume(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}
