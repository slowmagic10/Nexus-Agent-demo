import assert from "node:assert/strict";
import test from "node:test";
import { ContextLifecycle } from "../src/core/context-lifecycle.js";
import { AgentRuntime } from "../src/core/agent.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";

const summary = { objective: "完成当前任务", completed: ["已核对旧历史"] };
const complete = { text: "完成", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };

function sessionWithHistory(turns = 0) {
  let state = createSession({ provider: "budget-fixture", workspace: "/tmp" });
  for (let index = 0; index < turns; index += 1) {
    state = reduceSession(state, { type: "USER_MESSAGE", content: `旧任务${index}`.repeat(2_400) });
    state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "历史回复".repeat(2_400) } });
  }
  state = reduceSession(state, { type: "USER_MESSAGE", content: "继续当前任务" });
  return new AgentSession({ state, reducer: reduceSession });
}

function lifecycleFixture({ session = sessionWithHistory(), ...options } = {}) {
  const lifecycle = new ContextLifecycle({
    session,
    provider: { name: "budget-fixture", complete: async () => ({ text: JSON.stringify(summary) }) },
    systemPrompt: "system",
    getTools: () => [],
    requestModel: async () => complete,
    ...options,
  });
  return { session, lifecycle };
}

test("成功请求缺失 usage 时按最终 system、工具和消息的相同窗口估算记账", async () => {
  const { session, lifecycle } = lifecycleFixture({
    systemPrompt: "系统说明".repeat(6_000),
    getTools: () => [{ type: "function", function: { name: "read", description: "工具说明".repeat(6_000) } }],
    requestModel: async () => ({ text: "好", toolCalls: [], usage: null }),
  });
  await (await lifecycle.startTurn()).completeModelStep();
  const planned = session.state.events.findLast((event) => event.type.startsWith("model.context_"));
  const completed = session.state.events.findLast((event) => event.type === "model.completed");
  assert.equal(completed.usage.inputTokens, planned.estimatedInputTokens);
  assert.ok(completed.usage.inputTokens > 40_000);
  assert.equal(completed.usageEstimated, true);
  assert.equal(completed.usageEstimator, "utf8-bytes-div3-v1");
  assert.deepEqual(completed.usageMissingFields, ["inputTokens", "outputTokens", "totalTokens"]);
});

test("成功请求的部分 usage 补齐固定输入，total-only 保留报告总量并标记估算分摊", async () => {
  for (const usage of [{ outputTokens: 7 }, { total_tokens: 123 }]) {
    const { session, lifecycle } = lifecycleFixture({
      systemPrompt: "系统说明".repeat(100),
      requestModel: async () => ({ text: "完成", toolCalls: [], usage }),
    });
    await (await lifecycle.startTurn()).completeModelStep();
    const completed = session.state.events.findLast((event) => event.type === "model.completed");
    const planned = session.state.events.findLast((event) => event.type.startsWith("model.context_"));
    if (usage.outputTokens) assert.equal(completed.usage.inputTokens, planned.estimatedInputTokens);
    else assert.equal(completed.usage.totalTokens, 123);
    assert.equal(completed.usageEstimated, true);
    assert.equal(completed.usage.totalTokens, completed.usage.inputTokens + completed.usage.outputTokens);
  }
});

test("成功请求不接受矛盾或非法 total usage", async () => {
  for (const usage of [
    { inputTokens: 3, outputTokens: 2, totalTokens: 4 },
    { totalTokens: -1 },
    { total_tokens: "100" },
  ]) {
    const { session, lifecycle } = lifecycleFixture({ requestModel: async () => ({ ...complete, usage }) });
    await assert.rejects((await lifecycle.startTurn()).completeModelStep(), /Token usage/);
    assert.equal(session.state.metrics.totalTokens, 0);
  }
});

test("摘要第一批耗尽本轮预算时，第二批和主调用都不得启动", async () => {
  const session = sessionWithHistory(4);
  let summaries = 0;
  let mainRequests = 0;
  const { lifecycle } = lifecycleFixture({
    session,
    maxInputTokens: 400,
    summarizeContext: async () => {
      summaries += 1;
      return { summary, usage: { inputTokens: 99, outputTokens: 1, totalTokens: 100 } };
    },
    requestModel: async () => { mainRequests += 1; return complete; },
  });
  const turn = await lifecycle.startTurn({ assertCanRequest: () => {
    if (session.state.metrics.totalTokens >= 10) throw new Error("本轮预算耗尽");
  } });
  await assert.rejects(turn.completeModelStep(), /本轮预算耗尽/);
  assert.equal(summaries, 1);
  assert.equal(mainRequests, 0);
  assert.equal(session.state.metrics.totalTokens, 100);
  assert.equal(session.state.events.some((event) => event.type === "context.summary_degraded"), false);
});

test("真实 AgentRuntime 的摘要预算复现只允许首批，保留暂停目标", async () => {
  let summaries = 0;
  let mainRequests = 0;
  const runtime = new AgentRuntime({
    session: sessionWithHistory(4), systemPrompt: "完成任务",
    tools: { schemas: () => [], get: () => null },
    provider: { name: "budget-fixture", complete: async () => { mainRequests += 1; return complete; } },
    summarizeContext: async () => {
      summaries += 1;
      return { summary, usage: { inputTokens: 99, outputTokens: 1, totalTokens: 100 } };
    },
    maxInputTokens: 400, maxTokensPerTurn: 10,
  });
  await runtime.runTurn("继续完成当前任务", async () => false);
  assert.equal(summaries, 1);
  assert.equal(mainRequests, 0);
  assert.equal(runtime.state.metrics.totalTokens, 100);
  assert.equal(runtime.state.phase, "failed");
  assert.equal(runtime.state.objective.status, "paused");
  assert.match(runtime.state.lastError, /预算 10/);
});

test("预算在摘要之前已耗尽时不调用摘要，也不把预算错误降级", async () => {
  let summaries = 0;
  const { session, lifecycle } = lifecycleFixture({
    session: sessionWithHistory(2), maxInputTokens: 400,
    summarizeContext: async () => { summaries += 1; return { summary }; },
  });
  const turn = await lifecycle.startTurn({ assertCanRequest: () => { throw new Error("本轮预算耗尽"); } });
  await assert.rejects(turn.completeModelStep(), /本轮预算耗尽/);
  assert.equal(summaries, 0);
  assert.equal(session.state.metrics.modelCalls, 0);
  assert.equal(session.state.events.some((event) => event.type === "context.summary_degraded"), false);
});

test("模型摘要无 usage 或失败时仍计完整摘要请求成本，达到预算就停止主调用", async () => {
  for (const mode of ["success", "failure", "invalid-json"]) {
    let mainRequests = 0;
    let request;
    const { session, lifecycle } = lifecycleFixture({
      session: sessionWithHistory(1), maxInputTokens: 400,
      provider: { name: "budget-fixture", complete: async (value) => {
        request = value;
        if (mode === "failure") throw new Error("network unavailable");
        return { text: mode === "invalid-json" ? "not JSON" : JSON.stringify(summary), usage: null };
      } },
      requestModel: async () => { mainRequests += 1; return complete; },
    });
    const turn = await lifecycle.startTurn({ assertCanRequest: () => {
      if (session.state.metrics.totalTokens >= 10) throw new Error("本轮预算耗尽");
    } });
    await assert.rejects(turn.completeModelStep(), /本轮预算耗尽/);
    const event = session.state.events.findLast((item) => ["context.summary_completed", "context.summary_degraded"].includes(item.type));
    assert.equal(event.usage.inputTokens, estimateRequest(request));
    assert.equal(event.usageEstimated, true);
    assert.equal(mainRequests, 0);
  }
});

test("默认 extractive 摘要既不计模型调用也不消耗模型 token 预算", async () => {
  const { session, lifecycle } = lifecycleFixture({
    session: sessionWithHistory(1), maxInputTokens: 400,
    provider: { name: "offline-demo", complete: async () => { throw new Error("不可调用模型"); } },
  });
  const turn = await lifecycle.startTurn({ assertCanRequest: () => { throw new Error("主调用预算耗尽"); } });
  await assert.rejects(turn.completeModelStep(), /主调用预算耗尽/);
  const event = session.state.events.find((item) => item.type === "context.summary_completed");
  assert.ok(event);
  assert.deepEqual(event.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(event.usageEstimated, false);
  assert.equal(session.state.metrics.modelCalls, 0);
  assert.equal(session.state.metrics.totalTokens, 0);
  assert.equal(session.state.metrics.modelDurationMs, 0);
});

test("模型摘要超时也计入未知成本且不会越预算调用主模型", async (t) => {
  // Keep the event loop alive while AbortSignal.timeout's unref timer expires.
  const keepAlive = setTimeout(() => {}, 1_000);
  t.after(() => clearTimeout(keepAlive));
  let mainRequests = 0;
  const { session, lifecycle } = lifecycleFixture({
    session: sessionWithHistory(1), maxInputTokens: 400, contextSummaryTimeoutMs: 5,
    provider: { name: "budget-fixture", complete: async () => new Promise(() => {}) },
    requestModel: async () => { mainRequests += 1; return complete; },
  });
  const turn = await lifecycle.startTurn({ assertCanRequest: () => {
    if (session.state.metrics.totalTokens >= 10) throw new Error("本轮预算耗尽");
  } });
  await assert.rejects(turn.completeModelStep(), /本轮预算耗尽/);
  const event = session.state.events.find((item) => item.type === "context.summary_degraded");
  assert.ok(event.usage.inputTokens > 0);
  assert.equal(event.usageEstimated, true);
  assert.equal(mainRequests, 0);
});

test("摘要在两批之间取消，不启动后续摘要或主模型", async () => {
  const controller = new AbortController();
  let summaries = 0;
  let mainRequests = 0;
  const { session, lifecycle } = lifecycleFixture({
    session: sessionWithHistory(4), maxInputTokens: 400,
    summarizeContext: async () => {
      summaries += 1;
      return { summary, usage: { inputTokens: 9, outputTokens: 1, totalTokens: 10 } };
    },
    requestModel: async () => { mainRequests += 1; return complete; },
  });
  session.subscribeEvents((event) => {
    if (event.action.type === "CONTEXT_SUMMARY_COMPLETED") controller.abort(new Error("用户取消"));
  });
  const turn = await lifecycle.startTurn({ signal: controller.signal });
  await assert.rejects(turn.completeModelStep(), /用户取消/);
  assert.equal(summaries, 1);
  assert.equal(mainRequests, 0);
  assert.equal(session.state.metrics.totalTokens, 10);
});

test("已取消的轮次不启动摘要，摘要进行中取消保留尝试成本", async () => {
  for (const beforeCall of [true, false]) {
    const controller = new AbortController();
    let summaries = 0;
    const { session, lifecycle } = lifecycleFixture({
      session: sessionWithHistory(1), maxInputTokens: 400,
      provider: { name: "budget-fixture", complete: async () => {
        summaries += 1;
        controller.abort(new Error("用户取消"));
        throw controller.signal.reason;
      } },
    });
    if (beforeCall) controller.abort(new Error("用户取消"));
    const turn = await lifecycle.startTurn({ signal: controller.signal });
    await assert.rejects(turn.completeModelStep(), /用户取消/);
    assert.equal(summaries, beforeCall ? 0 : 1);
    assert.equal(session.state.metrics.totalTokens > 0, !beforeCall);
  }
});

test("工具调用和 provider opaque 输出缺 usage 时仍被输出估算计入", async () => {
  const { session, lifecycle } = lifecycleFixture({ requestModel: async () => ({
    text: "", toolCalls: [{ id: "call", name: "write", arguments: { content: "正文".repeat(100) } }],
    providerItems: [{ type: "reasoning", encrypted_content: "opaque".repeat(100) }],
  }) });
  await (await lifecycle.startTurn()).completeModelStep();
  assert.ok(session.state.metrics.outputTokens > 300);
});

test("报告 total 和任一分项时可精确推导另一分项，不标估算", async () => {
  for (const usage of [{ inputTokens: 8, totalTokens: 10 }, { completion_tokens: 2, total_tokens: 10 }]) {
    const { session, lifecycle } = lifecycleFixture({ requestModel: async () => ({ ...complete, usage }) });
    await (await lifecycle.startTurn()).completeModelStep();
    const event = session.state.events.find((item) => item.type === "model.completed");
    assert.deepEqual(event.usage, { inputTokens: 8, outputTokens: 2, totalTokens: 10 });
    assert.equal(event.usageEstimated, false);
    assert.equal(event.usageEstimator, null);
  }
});

test("预算超额后的已付费最终回答仍可交付，不再追加模型请求", async () => {
  const session = new AgentSession({ state: createSession({ provider: "budget-fixture", workspace: "/tmp" }), reducer: reduceSession });
  const runtime = new AgentRuntime({
    session, systemPrompt: "完成用户任务",
    tools: { schemas: () => [], get: () => null },
    provider: { name: "budget-fixture", complete: async () => ({ ...complete, usage: { totalTokens: 100 } }) },
    maxTokensPerTurn: 1,
  });
  await runtime.runTurn("告诉我你已收到这条消息", async () => false);
  assert.equal(runtime.state.phase, "completed", runtime.state.lastError);
  assert.equal(runtime.state.metrics.totalTokens, 100);
  assert.equal(runtime.state.metrics.modelCalls, 1);
});

function estimateRequest(request) {
  const value = (item) => Math.max(1, Math.ceil(Buffer.byteLength(typeof item === "string" ? item : JSON.stringify(item)) / 3));
  return value(request.systemPrompt) + value(request.tools) + 8 + request.messages.reduce((total, message) => total + value(message) + 4, 0);
}
