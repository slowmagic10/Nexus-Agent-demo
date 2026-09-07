import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createProviderHttpError } from "../src/providers/errors.js";
import { SessionStore } from "../src/persistence/session-store.js";

const complete = (text = "验证完成。", toolCalls = []) => ({
  text, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop",
  usage: { inputTokens: 10, outputTokens: 2 },
});

function fixture({ provider, state, journal, ...options } = {}) {
  const session = new AgentSession({
    state: state || createSession({ provider: "retry-offline", workspace: "/tmp" }),
    reducer: reduceSession,
    journal,
  });
  const executed = [];
  const runtime = new AgentRuntime({
    session,
    provider,
    systemPrompt: "完成任务并验证后交付。",
    modelRetryDelaysMs: [0, 0],
    toolHost: {
      schemas: () => [],
      execute: async (call, { session: active }) => {
        executed.push(call.id);
        await active.dispatch({ type: "TOOL_REQUESTED", call });
        await active.dispatch({ type: "TOOL_RESULT", call, ok: true, result: "ok", durationMs: 1 });
      },
    },
    ...options,
  });
  return { runtime, session, executed };
}

function adapter(fetchImpl) {
  return new OpenAICompatibleProvider({
    apiKey: "offline-fixture-key", baseUrl: "https://offline.invalid/v1", model: "fixture", fetchImpl,
  });
}

function jsonCompletion(text, calls = []) {
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }), { headers: { "content-type": "application/json" } });
}

test("真实 seq 4155 的 fetch failed 通过实际 Provider seam 在同一用户轮恢复", async () => {
  const requests = [];
  const { runtime } = fixture({ provider: adapter(async (_url, request) => {
    requests.push(request.body);
    if (requests.length === 1) throw new TypeError("fetch failed");
    return jsonCompletion("验证完成。");
  }), maxSteps: 1 });

  await runtime.runTurn("开发并一次性完成验证", async () => false);

  assert.equal(runtime.state.phase, "completed", runtime.state.lastError);
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  assert.equal(runtime.state.metrics.modelCalls, 2);
  assert.equal(runtime.state.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(runtime.state.events.filter((event) => event.type === "model.retry_requested").length, 1);
});

test("流中断丢弃部分文本和工具参数，已完成工具不重放，重试只执行完整的新工具", async () => {
  let calls = 0;
  const requests = [];
  const tool = (id) => ({ id, type: "function", function: { name: "write", arguments: "{}" } });
  const { runtime, executed } = fixture({ provider: adapter(async (_url, request) => {
    calls += 1;
    requests.push(request.body);
    if (calls === 1) return jsonCompletion("执行一次写入", [tool("already-done")]);
    if (calls === 2) {
      let pulled = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (pulled) {
            controller.error(new TypeError("terminated", { cause: Object.assign(new Error("private transport detail"), { code: "UND_ERR_SOCKET" }) }));
            return;
          }
          pulled = true;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {
            content: "不完整回答。",
            tool_calls: [{ index: 0, id: "partial-call", function: { name: "write", arguments: "{\"path\":" } }],
          } }] })}\n\n`));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (calls === 3) return jsonCompletion("执行第二次写入", [tool("new-complete-call")]);
    return jsonCompletion("全部完成。");
  }) });

  await runtime.runTurn("执行并验证", async () => false);

  assert.equal(runtime.state.phase, "completed", runtime.state.lastError);
  assert.equal(calls, 4);
  assert.equal(requests[1], requests[2]);
  assert.deepEqual(executed, ["already-done", "new-complete-call"]);
  assert.ok(!runtime.state.messages.some((message) => /不完整回答|partial-call/.test(JSON.stringify(message))));
  assert.equal(runtime.state.modelStream, null);
  assert.ok(runtime.state.events.some((event) => event.type === "model.stream_discarded" && event.reason === "model_retry"));
});

test("连续暂态失败仅额外重试两次，安全审计并保留原目标计划", async () => {
  let state = createSession({ provider: "retry-offline", workspace: "/tmp" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "原始目标：完成游戏" });
  state = reduceSession(state, { type: "PLAN_UPDATED", steps: [{ step: "验证游戏", status: "in_progress" }] });
  const originalId = state.objective.id;
  let calls = 0;
  const { runtime } = fixture({ state, provider: { complete: async () => {
    calls += 1;
    const cause = Object.assign(new Error("https://private.internal/?token=unsafe-credential"), { code: "ECONNRESET", hostname: "private.internal" });
    throw new TypeError("fetch failed", { cause });
  } } });

  await runtime.runTurn("继续", async () => false);

  assert.equal(calls, 3);
  assert.equal(runtime.state.phase, "failed");
  assert.equal(runtime.state.objective.id, originalId);
  assert.equal(runtime.state.objective.status, "paused");
  assert.equal(runtime.state.plan.status, "paused");
  assert.equal(runtime.state.plan.steps[0].status, "in_progress");
  const failed = runtime.state.events.filter((event) => event.type === "model.request_failed");
  assert.equal(failed.length, 3);
  assert.ok(failed.every((event) => event.failure.code === "ECONNRESET" && event.failure.status === null));
  assert.equal(runtime.state.events.filter((event) => event.type === "model.retry_requested").length, 2);
  assert.equal(runtime.state.events.filter((event) => event.type === "model.retry_exhausted").length, 1);
  assert.doesNotMatch(JSON.stringify(runtime.state), /private\.internal|unsafe-credential/);
  assert.match(runtime.state.lastError, /2.*重试|重试.*2/);
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} 暂态失败在第三次成功后继续`, async () => {
    let calls = 0;
    const { runtime } = fixture({ provider: { complete: async () => {
      calls += 1;
      if (calls < 3) throw createProviderHttpError(status, JSON.stringify({ error: { code: status === 429 ? "rate_limit_exceeded" : "server_error", message: "temporary" } }));
      return complete();
    } } });
    await runtime.runTurn("继续当前任务", async () => false);
    assert.equal(runtime.state.phase, "completed", runtime.state.lastError);
    assert.equal(calls, 3);
    assert.equal(runtime.state.events.some((event) => event.type.startsWith("context.replan")), false);
  });
}

for (const [label, error] of [
  ...[400, 401, 403, 404, 422, 501].map((status) => [String(status), createProviderHttpError(status, '{"error":{"message":"permanent"}}')]),
  ["quota", createProviderHttpError(429, '{"error":{"code":"insufficient_quota","message":"quota"}}')],
  ["billing", createProviderHttpError(429, '{"error":{"type":"billing_not_active","message":"billing"}}')],
  ["ordinary TypeError", new TypeError("Cannot read properties of undefined")],
  ["TLS certificate", new TypeError("fetch failed", { cause: Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" }) })],
  ["invalid SSE JSON", new Error("模型流式接口返回了无效 SSE JSON")],
]) {
  test(`永久错误 ${label} 不自动重试`, async () => {
    let calls = 0;
    const { runtime } = fixture({ provider: { complete: async () => { calls += 1; throw error; } } });
    await runtime.runTurn("执行任务", async () => false);
    assert.equal(calls, 1);
    assert.equal(runtime.state.phase, "failed");
    assert.equal(runtime.state.events.some((event) => event.type === "model.retry_requested"), false);
  });
}

test("退避期间用户取消立即结束，绝不发送重试", { timeout: 2_000 }, async () => {
  let calls = 0;
  const { runtime, session } = fixture({ modelRetryDelaysMs: [30_000, 30_000], provider: { complete: async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  } } });
  session.subscribe((next) => {
    if (next.events.at(-1)?.type === "model.retry_requested") setTimeout(() => runtime.cancel("用户取消退避"), 0);
  });
  await runtime.runTurn("执行任务", async () => false);
  assert.equal(calls, 1);
  assert.equal(runtime.state.phase, "cancelled");
  assert.equal(runtime.state.lastError, "用户取消退避");
});

test("失败请求已报告 usage 必须计入本轮预算，达到上限不能继续重试", async () => {
  let calls = 0;
  const { runtime } = fixture({ maxTokensPerTurn: 100, provider: { complete: async () => {
    calls += 1;
    throw Object.assign(new TypeError("fetch failed"), { usage: { inputTokens: 80, outputTokens: 20 } });
  } } });
  await runtime.runTurn("执行任务", async () => false);
  assert.equal(calls, 1);
  assert.equal(runtime.state.metrics.totalTokens, 100);
  assert.equal(runtime.state.objective.status, "paused");
  assert.match(runtime.state.lastError, /预算/);
  assert.equal(runtime.state.events.find((event) => event.type === "model.request_failed").usageEstimated, false);
});

test("未知 usage 的失败请求保守估算输入和部分输出，避免重试绕过 Token 预算", async () => {
  let calls = 0;
  const { runtime } = fixture({ maxTokensPerTurn: 1, provider: { complete: async () => { calls += 1; throw new TypeError("fetch failed"); } } });
  await runtime.runTurn("开发并验证游戏", async () => false);
  assert.equal(calls, 1);
  assert.ok(runtime.state.metrics.totalTokens > 1);
  assert.equal(runtime.state.objective.status, "paused");
  assert.match(runtime.state.lastError, /预算/);
  assert.equal(runtime.state.events.find((event) => event.type === "model.request_failed").usageEstimated, true);
});

test("网络重试与 Context replan 交错时最多四次请求，重规划不重置网络计数", async () => {
  let calls = 0;
  const { runtime } = fixture({ provider: { complete: async () => {
    calls += 1;
    if (calls === 2) throw createProviderHttpError(400, '{"error":{"code":"context_length_exceeded","message":"maximum context length is 800 tokens"}}');
    throw new TypeError("fetch failed");
  } } });
  await runtime.runTurn("完整开发项目", async () => false);
  assert.equal(calls, 4);
  assert.equal(runtime.state.phase, "failed");
  assert.equal(runtime.state.objective.status, "paused");
  assert.equal(runtime.state.events.filter((event) => event.type === "context.replan_requested").length, 1);
  assert.equal(runtime.state.events.filter((event) => event.type === "model.retry_requested").length, 2);
  assert.equal(runtime.state.events.filter((event) => event.type === "model.retry_exhausted").length, 1);
});

test("网络重试不能给 Context overflow 额外的重规划机会", async () => {
  let calls = 0;
  const { runtime } = fixture({ provider: { complete: async () => {
    calls += 1;
    if (calls === 2) throw new TypeError("fetch failed");
    throw createProviderHttpError(400, '{"error":{"code":"context_length_exceeded","message":"maximum context length is 800 tokens"}}');
  } } });
  await runtime.runTurn("完整开发项目", async () => false);
  assert.equal(calls, 3);
  assert.equal(runtime.state.events.filter((event) => event.type === "context.replan_requested").length, 1);
  assert.equal(runtime.state.events.filter((event) => event.type === "context.replan_exhausted").length, 1);
  assert.match(runtime.state.lastError, /自动缩减并重试一次后仍然超限/);
});

test("永久 HTTP 错误的服务端原文和任意错误码不能进入 durable 诊断", async () => {
  let calls = 0;
  const { runtime } = fixture({ provider: { complete: async () => {
    calls += 1;
    throw createProviderHttpError(400, JSON.stringify({ error: {
      code: "https://private.host/key-do-not-store",
      message: "request failed at https://private.host/secret-do-not-store",
    } }));
  } } });
  await runtime.runTurn("执行任务", async () => false);
  assert.equal(calls, 1);
  const failure = runtime.state.events.find((event) => event.type === "model.request_failed").failure;
  assert.deepEqual(failure, { kind: "http_error", status: 400, code: "http_400", retryable: false });
  assert.doesNotMatch(JSON.stringify(runtime.state), /private\.host|do-not-store/);
});

test("失败请求的非法 usage 不能污染预算或被暂态分类反复重试", async () => {
  let calls = 0;
  const { runtime } = fixture({ provider: { complete: async () => {
    calls += 1;
    throw Object.assign(new TypeError("fetch failed"), { usage: { inputTokens: -1, outputTokens: 2 } });
  } } });
  await runtime.runTurn("执行任务", async () => false);
  assert.equal(calls, 1);
  assert.equal(runtime.state.metrics.totalTokens, 0);
  assert.equal(runtime.state.events.find((event) => event.type === "model.request_failed").failure.code, "invalid_token_usage");
  assert.match(runtime.state.lastError, /invalid_token_usage/);
});

test("失败 usage 的总量与部分分项共同提供时不丢弃总量，矛盾分项禁止重试", async () => {
  for (const usage of [
    { inputTokens: 10, totalTokens: 1000 },
    { completion_tokens: 12, total_tokens: 1000 },
    { inputTokens: 10, outputTokens: 2, totalTokens: 5 },
  ]) {
    let calls = 0;
    const { runtime } = fixture({ maxTokensPerTurn: 100, provider: { complete: async () => {
      calls += 1;
      throw Object.assign(new TypeError("fetch failed"), { usage });
    } } });
    await runtime.runTurn("验证预算", async () => false);
    assert.equal(calls, 1);
    const failure = runtime.state.events.find((event) => event.type === "model.request_failed");
    if (usage.totalTokens === 5) assert.equal(failure.failure.code, "invalid_token_usage");
    else assert.equal(runtime.state.metrics.totalTokens, 1000);
  }
});

test("失败请求仅报告 totalTokens 时仍按实际总量守住预算", async () => {
  let calls = 0;
  const { runtime } = fixture({ maxTokensPerTurn: 100, provider: { complete: async () => {
    calls += 1;
    throw Object.assign(new TypeError("fetch failed"), { usage: { totalTokens: 100 } });
  } } });
  await runtime.runTurn("执行任务", async () => false);
  assert.equal(calls, 1);
  assert.equal(runtime.state.metrics.totalTokens, 100);
  assert.match(runtime.state.lastError, /预算/);
});

for (const usage of ["invalid", { totalTokens: Infinity }, { inputTokens: 2, totalTokens: -1 }]) {
  test(`失败请求的非法 usage 形状或 total 不能重试：${JSON.stringify(usage)}`, async () => {
    let calls = 0;
    const { runtime } = fixture({ provider: { complete: async () => {
      calls += 1;
      throw Object.assign(new TypeError("fetch failed"), { usage });
    } } });
    await runtime.runTurn("执行任务", async () => false);
    assert.equal(calls, 1);
    assert.equal(runtime.state.metrics.totalTokens, 0);
    assert.equal(runtime.state.events.find((event) => event.type === "model.request_failed").failure.code, "invalid_token_usage");
    assert.ok(Number.isFinite(runtime.state.metrics.totalTokens));
  });
}

test("真实 Adapter 缺失 SSE 终态是协议错误，不当作网络中断重试", async () => {
  let calls = 0;
  const { runtime, executed } = fixture({ provider: adapter(async () => {
    calls += 1;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "部分回答。" } }] })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) });
  await runtime.runTurn("执行任务", async () => false);
  assert.equal(calls, 1);
  assert.equal(runtime.state.phase, "failed");
  assert.deepEqual(executed, []);
  assert.equal(runtime.state.messages.some((message) => message.role === "assistant"), false);
  assert.match(runtime.state.lastError, /未返回明确终态/);
});

test("system 位置错误保留固定可读诊断，不持久化服务端其他原文", async () => {
  const { runtime } = fixture({ provider: { complete: async () => {
    throw createProviderHttpError(400, '{"error":{"message":"System message must be at the beginning. See https://private.host/key-do-not-store"}}');
  } } });
  await runtime.runTurn("执行任务", async () => false);
  assert.equal(runtime.state.events.find((event) => event.type === "model.request_failed").failure.code, "system_message_position");
  assert.match(runtime.state.lastError, /system 消息必须位于对话开头/);
  assert.doesNotMatch(JSON.stringify(runtime.state), /private\.host|do-not-store/);
  assert.equal(runtime.state.metrics.modelCalls, 1);
});

test("模型重试与耗尽事件经 SQLite journal 严格导出导入重放，状态及 Token 指标不漂移", async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-model-retry-journal-"));
  const source = new SessionStore(path.join(workspace, "source.db"), { workspace });
  const target = new SessionStore(path.join(workspace, "target.db"), { workspace });
  t.after(() => {
    source.close();
    target.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const { runtime, session } = fixture({
    state: createSession({ provider: "retry-offline", workspace }),
    journal: source,
    provider: { complete: async () => { throw new TypeError("fetch failed"); } },
  });
  await runtime.runTurn("完整开发并验证", async () => false);
  const archive = source.exportJournal(session.id);
  assert.equal(archive.events.filter((event) => event.type === "MODEL_REQUEST_FAILED").length, 3);
  assert.equal(archive.events.filter((event) => event.type === "MODEL_RETRY_REQUESTED").length, 2);
  assert.equal(archive.events.filter((event) => event.type === "MODEL_RETRY_EXHAUSTED").length, 1);
  assert.ok(runtime.state.metrics.totalTokens > 0);
  const imported = target.importJournal(JSON.parse(JSON.stringify(archive)));
  assert.deepEqual(imported, runtime.state);
  assert.deepEqual(target.load(session.id), runtime.state);
  const restored = new AgentSession({ state: target.load(session.id), reducer: reduceSession, journal: target });
  assert.deepEqual(restored.state, session.state);
  assert.equal(restored.cursor, session.cursor);
  assert.equal(target.exportJournal(session.id).checksum, archive.checksum);
});
