import assert from "node:assert/strict";
import test from "node:test";
import { ContextLifecycle } from "../src/core/context-lifecycle.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { createProviderHttpError } from "../src/providers/errors.js";

test("Context Lifecycle 通过一个 turn Interface 收拢 retrieval、规划和模型审计", async () => {
  const session = createAgentSession(withMessages([
    { type: "USER_MESSAGE", content: "当前任务" },
  ]));
  const requests = [];
  const lifecycle = new ContextLifecycle({
    session,
    provider: { name: "context-test", complete: async () => ({}) },
    systemPrompt: () => "system",
    getTools: () => [],
    retrieveMemory: async () => [{ id: "memory-1", content: "相关事实", pinned: false }],
    requestModel: async (request) => {
      requests.push(request);
      return {
        text: "完成",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      };
    },
  });

  const turn = await lifecycle.startTurn({ query: "当前任务", signal: new AbortController().signal });
  const response = await turn.completeModelStep();

  assert.equal(response.text, "完成");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].systemPrompt, "system");
  assert.deepEqual(session.state.contextMemory.map((memory) => memory.id), ["memory-1"]);
  assert.ok(session.state.events.some((event) => event.type === "memory.context_loaded"));
  assert.ok(session.state.events.some((event) => event.type === "model.context_prepared"));
  assert.ok(session.state.events.some((event) => event.type === "model.completed"));
  assert.equal(session.state.metrics.totalTokens, 10);
});

test("Context Lifecycle 在同一 turn 内隐藏并延续 overflow 后的收紧预算", async () => {
  const session = createAgentSession(withMessages([
    { type: "USER_MESSAGE", content: "旧历史".repeat(400) },
    { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "旧历史完成" } },
    { type: "USER_MESSAGE", content: "当前任务" },
  ]));
  let calls = 0;
  const lifecycle = new ContextLifecycle({
    session,
    provider: { name: "context-test", complete: async () => ({}) },
    systemPrompt: () => "system",
    getTools: () => [],
    retrieveMemory: async () => [],
    summarizeContext: Object.assign(async () => {
      throw new Error("本测试不应生成新摘要");
    }, { usesModel: false }),
    maxInputTokens: 2_000,
    requestModel: async () => {
      calls += 1;
      if (calls === 1) {
        throw createProviderHttpError(400, JSON.stringify({
          error: { code: "context_length_exceeded", message: "maximum context length is 800 tokens" },
        }));
      }
      return { text: `完成-${calls}`, toolCalls: [], finishReason: "stop" };
    },
  });

  const turn = await lifecycle.startTurn({ query: "当前任务", signal: new AbortController().signal });
  await turn.completeModelStep();
  await turn.completeModelStep();

  assert.equal(calls, 3);
  const replanned = session.state.events.find((event) => event.type === "context.replanned");
  const prepared = session.state.events.filter((event) => event.type.startsWith("model.context_"));
  assert.ok(replanned.toMaxInputTokens < replanned.fromMaxInputTokens);
  assert.equal(prepared.at(-1).maxInputTokens, replanned.toMaxInputTokens);
});

test("Context Lifecycle 在 turn 开始前已取消时闭合 retrieval，不留下未处理拒绝", async () => {
  const session = createAgentSession(withMessages([
    { type: "USER_MESSAGE", content: "立即取消" },
  ]));
  const controller = new AbortController();
  controller.abort(new Error("立即取消"));
  const lifecycle = new ContextLifecycle({
    session,
    provider: { name: "context-test", complete: async () => ({}) },
    systemPrompt: "system",
    getTools: () => [],
    requestModel: async () => ({ text: "", toolCalls: [] }),
    retrieveMemory: async (_query, { signal }) => {
      if (signal.aborted) throw signal.reason;
      return [];
    },
  });

  await lifecycle.startTurn({ query: "立即取消", signal: controller.signal });

  const retrieval = session.state.events.find((event) => event.type === "memory.context_loaded");
  assert.equal(retrieval.status, "degraded");
  assert.match(retrieval.error, /立即取消/);
});

test("Context Lifecycle 拒绝非法 Provider Token usage，预算指标不被污染", async () => {
  const session = createAgentSession(withMessages([
    { type: "USER_MESSAGE", content: "usage test" },
  ]));
  const lifecycle = new ContextLifecycle({
    session,
    provider: { name: "context-test", complete: async () => ({}) },
    systemPrompt: () => "system",
    getTools: () => [],
    retrieveMemory: async () => [],
    requestModel: async () => ({
      text: "不应完成",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: "not-a-number", outputTokens: -5, totalTokens: "NaN" },
    }),
  });
  const turn = await lifecycle.startTurn({ query: "usage test", signal: new AbortController().signal });

  await assert.rejects(turn.completeModelStep(), /Token usage/);

  assert.deepEqual(
    Object.fromEntries(["inputTokens", "outputTokens", "totalTokens"].map((key) => [key, session.state.metrics[key]])),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  assert.equal(session.state.events.some((event) => event.type === "model.completed"), false);
});

test("Context Lifecycle 拒绝分量求和后越过安全整数的 Token usage", async () => {
  const session = createAgentSession(withMessages([
    { type: "USER_MESSAGE", content: "usage overflow test" },
  ]));
  const lifecycle = new ContextLifecycle({
    session,
    provider: { name: "context-test", complete: async () => ({}) },
    systemPrompt: () => "system",
    getTools: () => [],
    retrieveMemory: async () => [],
    requestModel: async () => ({
      text: "不应完成",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
    }),
  });
  const turn = await lifecycle.startTurn({ query: "usage overflow test", signal: new AbortController().signal });

  await assert.rejects(turn.completeModelStep(), /Token usage totalTokens/);

  assert.equal(session.state.metrics.totalTokens, 0);
  assert.equal(session.state.events.some((event) => event.type === "model.completed"), false);
});

function createAgentSession(state) {
  return new AgentSession({ state, reducer: reduceSession });
}

function withMessages(actions) {
  return actions.reduce(
    (state, action) => reduceSession(state, action),
    createSession({ provider: "test", workspace: "/tmp" }),
  );
}
