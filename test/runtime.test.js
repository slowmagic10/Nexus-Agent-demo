import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { redactSensitiveText, redactSensitiveValue } from "../src/security/redact.js";

test("模型用量和耗时进入状态指标", async () => {
  const runtime = createRuntime({
    provider: {
      complete: async () => ({ text: "完成", toolCalls: [], finishReason: "stop", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }),
    },
  });
  await runtime.runTurn("测试", async () => false);
  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.metrics.totalTokens, 14);
  assert.equal(runtime.state.metrics.modelCalls, 1);
  assert.equal(runtime.state.events.find((event) => event.type === "model.completed").finishReason, "stop");
});

test("默认无限步骤与累计 Token 预算允许持续工具循环直到模型完成", async () => {
  let calls = 0;
  const runtime = createRuntime({
    provider: {
      complete: async () => {
        calls += 1;
        return calls <= 3
          ? {
              text: "继续执行",
              toolCalls: [{ id: `budget-call-${calls}`, name: "noop", arguments: {} }],
              usage: { inputTokens: 17_000, outputTokens: 500, totalTokens: 17_500 },
            }
          : {
              text: "目标已完成并验证",
              toolCalls: [],
              finishReason: "stop",
              usage: { inputTokens: 17_000, outputTokens: 500, totalTokens: 17_500 },
            };
      },
    },
    tools: {
      schemas: () => [],
      get: () => ({ approval: "never", effects: ["read"], idempotency: "safe", execute: async () => "ok" }),
    },
  });

  await runtime.runTurn("完成需要多轮工具调用的任务", async () => false);

  assert.equal(calls, 4);
  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.messages.at(-1).content, "目标已完成并验证");
});

test("显式累计 Token 预算在下一工具启动前停止并闭合工具协议", async () => {
  let modelCalls = 0;
  let executions = 0;
  const runtime = createRuntime({
    provider: {
      complete: async () => {
        modelCalls += 1;
        return {
          text: "继续执行",
          toolCalls: [{ id: `limited-call-${modelCalls}`, name: "noop", arguments: {} }],
          usage: { inputTokens: 19_500, outputTokens: 500, totalTokens: 20_000 },
        };
      },
    },
    toolHost: {
      schemas: () => [],
      execute: async (call, context) => {
        executions += 1;
        await context.session.dispatch({ type: "TOOL_REQUESTED", call });
        await context.session.dispatch({ type: "TOOL_RESULT", call, ok: true, result: "ok", durationMs: 1 });
      },
    },
    maxTokensPerTurn: 30_000,
  });

  await runtime.runTurn("执行直到预算边界", async () => false);

  assert.equal(modelCalls, 2);
  assert.equal(executions, 1, runtime.state.lastError);
  assert.equal(runtime.state.phase, "failed");
  assert.match(runtime.state.lastError, /累计 Token 用量超过预算 30000/);
  assert.equal(runtime.state.messages.at(-1).role, "tool");
  assert.match(runtime.state.messages.at(-1).content, /没有执行/);
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

test("运行时在压缩前生成 durable semantic summary 并注入主模型请求", async () => {
  let state = createSession({ provider: "test", workspace: "/tmp" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "旧任务".repeat(1_200) });
  state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "旧任务已经完成" } });
  let summarizedMessages;
  let receivedMessages;
  const runtime = createRuntime({
    state,
    maxInputTokens: 400,
    summarizeContext: async ({ messages }) => {
      summarizedMessages = messages;
      return {
        summary: {
          objective: "继续开发 Nexus",
          completed: ["旧任务已经完成"],
          active: ["处理新任务"],
          decisions: [],
          files: ["src/core/agent.js"],
          blockers: [],
          nextMoves: ["完成验证"],
        },
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        model: "summary-test",
      };
    },
    provider: {
      complete: async ({ messages }) => {
        receivedMessages = messages;
        return { text: "新任务完成", toolCalls: [], usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } };
      },
    },
  });

  await runtime.runTurn("开始新任务", async () => false);

  assert.deepEqual(summarizedMessages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(runtime.state.contextSummary.revision, 1);
  assert.equal(runtime.state.contextSummary.throughMessage, 2);
  assert.equal(runtime.state.contextSummary.model, "summary-test");
  assert.equal(receivedMessages[0].role, "assistant");
  assert.match(receivedMessages[0].content, /历史会话语义摘要/);
  assert.deepEqual(receivedMessages.at(-1), { role: "user", content: "开始新任务" });
  assert.equal(runtime.state.metrics.modelCalls, 2);
  assert.equal(runtime.state.metrics.totalTokens, 36);
  assert.ok(runtime.state.events.some((event) => event.type === "context.summary_completed"));
  assert.equal(runtime.state.events.findLast((event) => event.type === "model.context_compacted").summary.included, true);
});

test("滚动摘要只合并上次覆盖范围之后新省略的完整 turn", async () => {
  let state = createSession({ provider: "test", workspace: "/tmp" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "第一轮".repeat(900) });
  state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "第一轮完成" } });
  state = reduceSession(state, {
    type: "CONTEXT_SUMMARY_COMPLETED",
    summary: {
      objective: "完成全部轮次",
      completed: ["第一轮完成"],
      active: [],
      decisions: [],
      files: [],
      blockers: [],
      nextMoves: [],
    },
    fromMessage: 0,
    throughMessage: 2,
    sourceCursor: 2,
    sourceComplete: true,
    model: "summary-test",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "第二轮".repeat(900) });
  state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "第二轮完成" } });
  let input;
  const runtime = createRuntime({
    state,
    maxInputTokens: 400,
    summarizeContext: async (value) => {
      input = value;
      return {
        summary: {
          objective: "完成全部轮次",
          completed: ["第一轮完成", "第二轮完成"],
          active: ["第三轮"],
          decisions: [],
          files: [],
          blockers: [],
          nextMoves: ["继续"],
        },
        model: "summary-test",
      };
    },
    provider: { complete: async () => ({ text: "完成", toolCalls: [] }) },
  });

  await runtime.runTurn("第三轮", async () => false);

  assert.equal(input.previousSummary.revision, 1);
  assert.deepEqual(input.messages.map((message) => message.content), ["第二轮".repeat(900), "第二轮完成"]);
  assert.equal(runtime.state.contextSummary.revision, 2);
  assert.equal(runtime.state.contextSummary.throughMessage, 4);
});

test("语义摘要失败时记录 degraded 并继续使用最近完整 turn", async () => {
  let state = createSession({ provider: "test", workspace: "/tmp" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "旧历史".repeat(1_200) });
  state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "旧回答" } });
  let receivedMessages;
  const runtime = createRuntime({
    state,
    maxInputTokens: 220,
    summarizeContext: async () => { throw new Error("summary provider unavailable"); },
    provider: {
      complete: async ({ messages }) => {
        receivedMessages = messages;
        return { text: "降级后完成", toolCalls: [] };
      },
    },
  });

  await runtime.runTurn("继续", async () => false);

  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.contextSummary, null);
  assert.deepEqual(receivedMessages, [{ role: "user", content: "继续" }]);
  const degraded = runtime.state.events.find((event) => event.type === "context.summary_degraded");
  assert.match(degraded.error, /summary provider unavailable/);
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
  assert.equal(redactSensitiveText("sshpass -p plain-secret ssh user@host"), "sshpass -p [REDACTED] ssh user@host");
  assert.equal(redactSensitiveText("expect /tmp/login.exp host user 'plain-secret' 'uptime'"), "expect /tmp/login.exp host user [REDACTED] 'uptime'");
  assert.deepEqual(
    redactSensitiveValue({ password: "plain-secret", totalTokens: 14 }),
    { password: "[REDACTED]", totalTokens: 14 },
  );
});

test("Assistant 正文中的高熵引号凭据会在持久化前脱敏", async () => {
  const runtime = createRuntime({
    provider: {
      complete: async () => ({
        text: "登录密码是 'FakePass@4321'，不要公开。",
        toolCalls: [],
      }),
    },
  });

  await runtime.runTurn("检查输出脱敏", async () => false);

  const content = runtime.state.messages.at(-1).content;
  assert.equal(content.includes("FakePass@4321"), false);
  assert.match(content, /\[REDACTED\]/);
});

test("无限步骤模式允许单次任务执行超过默认八步", async () => {
  let calls = 0;
  const tools = {
    schemas: () => [],
    get: () => ({
      approval: "never",
      effects: ["read"],
      idempotency: "safe",
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
  maxTokensPerTurn,
  tools,
  retrieveMemory,
  reconcile,
  memorySearchTimeoutMs,
  memoryReconcileTimeoutMs,
  flushMemory,
  toolHost,
  summarizeContext,
  contextSummaryTimeoutMs,
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
    summarizeContext,
    contextSummaryTimeoutMs,
    maxInputTokens,
    maxSteps,
    maxTokensPerTurn,
  });
}
