import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { redactSensitiveText } from "../src/security/redact.js";

test("模型用量和耗时进入状态指标", async () => {
  const runtime = createRuntime({
    provider: {
      complete: async () => ({ text: "完成", toolCalls: [], usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }),
    },
  });
  await runtime.runTurn("测试", async () => false);
  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.metrics.totalTokens, 14);
  assert.equal(runtime.state.metrics.modelCalls, 1);
  assert.ok(runtime.state.events.some((event) => event.type === "model.completed"));
});

test("运行时按预算压缩历史 turn 并留下 durable audit event", async () => {
  let state = createSession({ provider: "test", workspace: "/tmp" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "H".repeat(1_200), at: "2026-08-17T01:00:00.000Z" });
  state = reduceSession(state, {
    type: "ASSISTANT_MESSAGE",
    message: { role: "assistant", content: "旧回答" },
    at: "2026-08-17T01:00:01.000Z",
  });
  let receivedMessages;
  const runtime = createRuntime({
    provider: {
      complete: async ({ messages }) => {
        receivedMessages = messages;
        return { text: "完成", toolCalls: [], usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } };
      },
    },
    state,
    maxInputTokens: 120,
  });

  await runtime.runTurn("新任务", async () => false);

  assert.deepEqual(receivedMessages, [{ role: "user", content: "新任务" }]);
  const audit = runtime.state.events.find((event) => event.type === "model.context_compacted");
  assert.equal(audit.compacted, true);
  assert.equal(audit.omittedTurns, 1);
  assert.equal(runtime.state.phase, "completed");
});

test("当前 turn 超预算时运行时 fail closed 且不调用模型", async () => {
  let calls = 0;
  const runtime = createRuntime({
    provider: {
      complete: async () => {
        calls += 1;
        return { text: "不应调用", toolCalls: [] };
      },
    },
    maxInputTokens: 60,
  });

  await runtime.runTurn("X".repeat(1_000), async () => false);

  assert.equal(calls, 0);
  assert.equal(runtime.state.phase, "failed");
  assert.match(runtime.state.lastError, /当前 turn.*超过 Model Context 预算 60/);
  assert.equal(runtime.state.metrics.modelCalls, 0);
});

test("取消会中止模型请求并进入 cancelled", async () => {
  const runtime = createRuntime({
    provider: {
      complete: async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    },
  });
  const turn = runtime.runTurn("等待", async () => false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  runtime.cancel("测试取消");
  await turn;
  assert.equal(runtime.state.phase, "cancelled");
  assert.equal(runtime.state.lastError, "测试取消");
});

test("取消会为未闭合工具调用补充安全结果", () => {
  let state = createSession({ provider: "test", workspace: "/tmp" });
  state = reduceSession(state, {
    type: "ASSISTANT_MESSAGE",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "write_file", arguments: "{}" } }],
    },
  });
  state = reduceSession(state, { type: "CANCELLED", reason: "用户取消" });
  assert.equal(state.messages.at(-1).tool_call_id, "call-1");
  assert.match(state.messages.at(-1).content, /不会自动重放/);
});

test("敏感凭据会从工具日志文本中脱敏", () => {
  assert.equal(redactSensitiveText("OPENAI_API_KEY=sk-1234567890abcdefghijklmnop"), "OPENAI_API_KEY=[REDACTED]");
  assert.equal(redactSensitiveText("Authorization: Bearer secret-token"), "Authorization: Bearer [REDACTED]");
});

test("无限步骤模式允许单次任务执行超过默认八步", async () => {
  let calls = 0;
  const tools = {
    schemas: () => [],
    get: () => ({
      approval: "never",
      execute: async () => "继续",
    }),
  };
  const runtime = createRuntime({
    provider: {
      complete: async () => {
        calls += 1;
        return calls <= 10
          ? { text: "", toolCalls: [{ id: `call-${calls}`, name: "noop", arguments: {} }] }
          : { text: "完成", toolCalls: [] };
      },
    },
    tools,
    maxSteps: Infinity,
  });

  await runtime.runTurn("执行长任务", async () => false);

  assert.equal(calls, 11);
  assert.equal(runtime.state.phase, "completed");
});

test("长期记忆检索失败时降级为空并继续 Agent Loop", async () => {
  const runtime = createRuntime({
    provider: {
      complete: async () => ({ text: "仍然完成", toolCalls: [] }),
    },
    retrieveMemory: async () => {
      throw new Error("semantic memory unavailable");
    },
  });

  await runtime.runTurn("继续执行", async () => false);

  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.messages.at(-1).content, "仍然完成");
  const audit = runtime.state.events.find((event) => event.type === "memory.context_loaded");
  assert.equal(audit.status, "degraded");
  assert.equal(audit.count, 0);
  assert.match(audit.error, /semantic memory unavailable/);
});

test("长期记忆检索超时后降级并继续模型请求", async () => {
  const runtime = createRuntime({
    provider: {
      complete: async () => ({ text: "超时后完成", toolCalls: [] }),
    },
    retrieveMemory: async (_query, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    memorySearchTimeoutMs: 5,
  });

  await runtime.runTurn("继续执行", async () => false);

  assert.equal(runtime.state.phase, "completed");
  const audit = runtime.state.events.find((event) => event.type === "memory.context_loaded");
  assert.equal(audit.status, "degraded");
  assert.match(audit.error, /timeout|timed out/i);
});

test("Memory reconcile 超时后留下审计并继续 turn", async () => {
  let providerCalls = 0;
  const runtime = createRuntime({
    provider: {
      complete: async () => {
        providerCalls += 1;
        return { text: "reconcile 超时后完成", toolCalls: [] };
      },
    },
    reconcile: async () => new Promise(() => {}),
    memoryReconcileTimeoutMs: 5,
  });

  await runtime.runTurn("继续", async () => false);

  assert.equal(providerCalls, 1);
  assert.equal(runtime.state.phase, "completed");
  const audit = runtime.state.events.find((event) => event.type === "memory.reconciliation_degraded");
  assert.match(audit.error, /timeout|timed out/i);
});

test("turn 完成后触发 Memory flush，flush 失败不推翻完成状态", async () => {
  let received;
  const runtime = createRuntime({
    provider: {
      complete: async () => ({ text: "已完成", toolCalls: [] }),
    },
    flushMemory: async (input) => {
      received = input;
      throw new Error("flush unavailable");
    },
  });

  await runtime.runTurn("请处理", async () => false);

  assert.equal(runtime.state.phase, "completed");
  assert.equal(received.messages.at(-2).content, "请处理");
  assert.equal(received.messages.at(-1).content, "已完成");
  assert.ok(Number.isSafeInteger(received.sourceCursor));
  assert.match(runtime.state.events.find((event) => event.type === "memory.flush_degraded").error, /flush unavailable/);
});

test("AgentRuntime 只通过 Tool Host Interface 执行工具", async () => {
  let modelCalls = 0;
  let execution;
  const toolHost = {
    schemas: () => [{ type: "function", function: { name: "host_tool", description: "test", parameters: { type: "object" } } }],
    execute: async (call, context) => {
      execution = { call, hasSession: Boolean(context.session), hasApproval: typeof context.requestApproval === "function" };
      await context.session.dispatch({ type: "TOOL_REQUESTED", call });
      await context.session.dispatch({ type: "TOOL_RESULT", call, ok: true, result: "host result", durationMs: 1 });
    },
  };
  const runtime = createRuntime({
    provider: {
      complete: async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? { text: "", toolCalls: [{ id: "host-call", name: "host_tool", arguments: { value: 1 } }] }
          : { text: "完成", toolCalls: [] };
      },
    },
    toolHost,
  });

  await runtime.runTurn("执行", async () => true);

  assert.equal(execution.call.name, "host_tool");
  assert.equal(execution.hasSession, true);
  assert.equal(execution.hasApproval, true);
  assert.equal(runtime.state.phase, "completed");
});

function createRuntime({
  provider,
  state,
  maxInputTokens,
  maxSteps,
  tools,
  retrieveMemory,
  reconcile,
  memorySearchTimeoutMs,
  memoryReconcileTimeoutMs,
  flushMemory,
  toolHost,
} = {}) {
  tools ||= { schemas: () => [], get: () => null };
  return new AgentRuntime({
    session: new AgentSession({
      state: state || createSession({ provider: "test", workspace: "/tmp" }),
      reducer: reduceSession,
    }),
    provider: { name: "test", ...provider },
    tools,
    toolHost,
    systemPrompt: () => "test",
    retrieveMemory,
    reconcile,
    memorySearchTimeoutMs,
    memoryReconcileTimeoutMs,
    flushMemory,
    maxInputTokens,
    maxSteps,
  });
}
