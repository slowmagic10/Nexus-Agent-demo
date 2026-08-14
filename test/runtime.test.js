import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { redactSensitiveText } from "../src/security/redact.js";

test("模型用量和耗时进入状态指标", async () => {
  const runtime = createRuntime({
    complete: async () => ({ text: "完成", toolCalls: [], usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }),
  });
  await runtime.runTurn("测试", async () => false);
  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.metrics.totalTokens, 14);
  assert.equal(runtime.state.metrics.modelCalls, 1);
  assert.ok(runtime.state.events.some((event) => event.type === "model.completed"));
});

test("取消会中止模型请求并进入 cancelled", async () => {
  const runtime = createRuntime({
    complete: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
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

function createRuntime(provider) {
  const tools = { schemas: () => [], get: () => null };
  return new AgentRuntime({
    state: createSession({ provider: "test", workspace: "/tmp" }),
    reducer: reduceSession,
    provider: { name: "test", ...provider },
    tools,
    systemPrompt: () => "test",
  });
}
