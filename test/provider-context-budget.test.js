import assert from "node:assert/strict";
import test from "node:test";
import { assertContextBudget, configuredContextBudget, normalizeProviderRequestPolicy, providerRequestOverrides, resolveContextBudget } from "../src/providers/request-policy.js";
import { ContextLifecycle } from "../src/core/context-lifecycle.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { createProviderHttpError } from "../src/providers/errors.js";

test("窗口、常用输入目标与输出额度独立，取最窄边界且不改默认策略", () => {
  assert.deepEqual(resolveContextBudget({ contextWindowTokens: 1_000_000 }), {
    version: "context-budget-v1", contextWindowTokens: 1_000_000, contextTargetTokens: 1_000_000,
    reservedOutputTokens: 0, maxInputTokens: 1_000_000,
  });
  assert.equal(configuredContextBudget({ contextWindowTokens: 1_000_000 }), null);
  assert.deepEqual(providerRequestOverrides({ adapter: "openai-compatible" }), {});
  assert.equal(resolveContextBudget({ contextWindowTokens: 1_000_000, contextTargetTokens: 64_000, maxOutputTokens: 16_000 }).maxInputTokens, 64_000);
  assert.equal(resolveContextBudget({ contextWindowTokens: 32_000, contextTargetTokens: 31_000, maxOutputTokens: 8_000 }).maxInputTokens, 24_000);
  assert.equal(resolveContextBudget({ contextWindowTokens: 32_000, maxOutputTokens: 8_000 }).maxInputTokens, 24_000);
});

test("非法数值、无限窗口或不支持的wire能力不能进入请求策略", () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", true]) {
    assert.throws(() => resolveContextBudget({ contextWindowTokens: value }));
    assert.throws(() => resolveContextBudget({ contextTargetTokens: value }));
    assert.throws(() => resolveContextBudget({ maxOutputTokens: value }));
  }
  assert.throws(() => resolveContextBudget({ contextWindowTokens: 10, contextTargetTokens: 11 }), /不能超过/);
  assert.throws(() => resolveContextBudget({ contextWindowTokens: 10, maxOutputTokens: 10 }), /必须小于/);
  assert.throws(() => normalizeProviderRequestPolicy({ maxOutputTokens: 100 }, { adapter: "openai-compatible" }), /显式/);
  assert.throws(() => normalizeProviderRequestPolicy({ outputTokenParameter: "max_tokens" }, { adapter: "openai-responses" }), /仅支持/);
  assert.throws(() => normalizeProviderRequestPolicy({ streamUsage: "true" }, { adapter: "openai-compatible" }), /布尔/);
  assert.throws(() => normalizeProviderRequestPolicy({ maxOutputTokens: 100 }, { adapter: "unknown" }), /Adapter/);
});

test("Context budget 只接收自洽的配置证据并防止对象被外部改写", () => {
  const budget = resolveContextBudget({ contextWindowTokens: 1000, maxOutputTokens: 100 });
  assert.deepEqual(assertContextBudget(budget), budget);
  assert.notEqual(assertContextBudget(budget), budget);
  for (const altered of [{ ...budget, maxInputTokens: 1000 }, { ...budget, reservedOutputTokens: -1 },
    { ...budget, version: "unknown" }, { ...budget, hidden: "unsafe" }, {}]) assert.throws(() => assertContextBudget(altered));
});

test("主请求按有效目标压缩旧完整轮次，日志分别记录真实容量和目标", async () => {
  const budget = resolveContextBudget({ contextWindowTokens: 100_000, contextTargetTokens: 600, maxOutputTokens: 2000 });
  const { session, lifecycle, requests } = await fixture({ budget, history: true, maxInputTokens: 100_000 });
  const before = structuredClone(session.state.messages);
  const turn = await lifecycle.startTurn({ query: "当前任务" });
  await turn.completeModelStep();
  const plan = plans(session).at(-1);
  assert.equal(plan.maxInputTokens, 600);
  assert.deepEqual(plan.contextBudget, budget);
  assert.equal(plan.contextBudget.contextWindowTokens, 100_000);
  assert.equal(plan.compacted, true);
  assert.ok(requests[0].messages.some((message) => message.content === "当前任务"));
  assert.deepEqual(session.state.messages, before);
  assert.equal(Object.hasOwn(requests[0], "contextBudget"), false);
});

test("直接调用指定更窄的输入预算仍优先，不因容量大而放宽", async () => {
  const budget = resolveContextBudget({ contextWindowTokens: 100000, contextTargetTokens: 64000, maxOutputTokens: 16000 });
  const { session, lifecycle } = await fixture({ budget, maxInputTokens: 8000 });
  await (await lifecycle.startTurn({ query: "当前任务" })).completeModelStep();
  assert.equal(plans(session)[0].maxInputTokens, 8000);
  assert.equal(plans(session)[0].contextBudget.maxInputTokens, 64000);
});

test("缺省策略不增加上下文审计字段或改变已有请求Hash", async () => {
  const original = await fixture({ maxInputTokens: 1000 });
  const explicit = await fixture({ budget: resolveContextBudget({ contextWindowTokens: 1000, contextTargetTokens: 1000 }), maxInputTokens: 1000 });
  await (await original.lifecycle.startTurn({ query: "当前任务" })).completeModelStep();
  await (await explicit.lifecycle.startTurn({ query: "当前任务" })).completeModelStep();
  assert.equal(Object.hasOwn(plans(original.session)[0], "contextBudget"), false);
  assert.equal(plans(original.session)[0].contextHash, plans(explicit.session)[0].contextHash);
});

test("服务端overflow按实际容量扣输出预留，再收紧并延续整个用户轮", async () => {
  let calls = 0;
  const budget = resolveContextBudget({ contextWindowTokens: 100_000, maxOutputTokens: 2000 });
  const { session, lifecycle } = await fixture({ budget, maxInputTokens: budget.maxInputTokens, history: true,
    requestModel: async () => { if (++calls === 1) throw overflow(2500); return done(); },
  });
  const turn = await lifecycle.startTurn({ query: "当前任务" });
  await turn.completeModelStep();
  await turn.completeModelStep();
  assert.equal(calls, 3);
  const prepared = plans(session);
  assert.equal(prepared[1].maxInputTokens, 350);
  assert.equal(prepared[2].maxInputTokens, 350);
  assert.ok(prepared.every((plan) => plan.contextBudget.contextWindowTokens === 100_000));
  assert.ok(prepared.every((plan) => plan.contextBudget.reservedOutputTokens === 2000));
});

test("服务端实际容量已被输出额度占满时明确返回可恢复原因，不试不可能成功的重发", async () => {
  let calls = 0;
  const { session, lifecycle } = await fixture({ budget: resolveContextBudget({ contextWindowTokens: 100_000, maxOutputTokens: 2000 }),
    requestModel: async () => { calls++; throw overflow(2000); },
  });
  const turn = await lifecycle.startTurn({ query: "当前任务" });
  await assert.rejects(turn.completeModelStep(), (error) => error.reason === "context_replan_exhausted" && /输出额度/.test(error.message));
  assert.equal(calls, 1);
  assert.equal(session.state.events.filter((event) => event.type === "context.replan_exhausted").length, 1);
});

test("输入目标仍是规划目标，当前不可拆轮次超出估算时不直接截断或结束", async () => {
  const { session, lifecycle, requests } = await fixture({ budget: resolveContextBudget({ contextWindowTokens: 1000, contextTargetTokens: 1 }), maxInputTokens: 1000 });
  await (await lifecycle.startTurn({ query: "当前任务" })).completeModelStep();
  assert.equal(requests.length, 1);
  assert.equal(plans(session)[0].estimatedOverTarget, true);
  assert.ok(requests[0].messages.some((message) => message.content === "当前任务"));
});

const done = () => ({ text: "完成", toolCalls: [], finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
const overflow = (limit) => createProviderHttpError(400, JSON.stringify({ error: { code: "context_length_exceeded", message: `maximum context length is ${limit} tokens` } }));
const plans = (session) => session.state.events.filter((event) => ["model.context_prepared", "model.context_compacted"].includes(event.type));
async function fixture({ budget = null, history = false, maxInputTokens = 32_000, requestModel } = {}) {
  const session = new AgentSession({ state: createSession({ provider: "offline", workspace: "/tmp" }), reducer: reduceSession });
  if (history) {
    await session.dispatch({ type: "USER_MESSAGE", content: "旧资料".repeat(4000) });
    await session.dispatch({ type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "旧轮结束" } });
  }
  await session.dispatch({ type: "USER_MESSAGE", content: "当前任务" });
  const requests = [];
  const lifecycle = new ContextLifecycle({ session, provider: { complete: async () => done() }, systemPrompt: "系统要求", getTools: () => [],
    summarizeContext: Object.assign(async () => { throw new Error("本测试使用最近完整轮次投影"); }, { usesModel: false }),
    maxInputTokens, contextBudget: budget, requestModel: async (request) => { requests.push(request); return requestModel ? requestModel(request) : done(); },
  });
  return { session, lifecycle, requests };
}
