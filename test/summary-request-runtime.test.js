import assert from "node:assert/strict";
import test from "node:test";
import { ContextLifecycle } from "../src/core/context-lifecycle.js";
import { prepareContextSummaryRequest } from "../src/core/context-summary.js";
import { measureModelRequest } from "../src/core/model-usage.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { resolveContextBudget } from "../src/providers/request-policy.js";

const summary = { objective: "继续当前目标", completed: ["保留已验证结果"] };
const mainResponse = { text: "完成", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };

test("真实摘要请求使用独立默认预算，主上下文软目标不限制摘要输入", async () => {
  const session = historySession();
  const { lifecycle, summaryRequests, mainRequests } = fixture(session);
  await (await lifecycle.startTurn()).completeModelStep();

  assert.equal(summaryRequests.length, 1);
  const actual = measureModelRequest(summaryRequests[0]).estimatedInputTokens;
  assert.ok(actual > 400);
  assert.ok(actual <= 32_000);
  assert.equal(lifecycle.summaryMaxInputTokens, 32_000);
  assert.equal(mainRequests.length, 1);
  assert.equal(session.state.contextSummary.throughMessage, 2);
  assert.equal(lastEvent(session, "context.summary_completed").usage.inputTokens, actual);
});

test("自定义摘要预算缩短实际来源，成功费用与完整请求估算一致", async () => {
  const session = historySession({ content: `目标首部 ${"摘要正文".repeat(8_000)}` });
  const original = session.state.messages;
  const { lifecycle, summaryRequests, mainRequests } = fixture(session, { summaryMaxInputTokens: 1_500 });
  await (await lifecycle.startTurn()).completeModelStep();

  assert.equal(summaryRequests.length, 1);
  const actual = measureModelRequest(summaryRequests[0]).estimatedInputTokens;
  assert.ok(actual <= 1_500);
  const input = JSON.parse(summaryRequests[0].messages[0].content);
  assert.equal(typeof input.sourceNotice, "string");
  assert.match(summaryRequests[0].messages[0].content, /目标首部/);
  assert.match(summaryRequests[0].messages[0].content, /历史尾部证据/);
  assert.equal(session.state.contextSummary.sourceComplete, false);
  assert.equal(session.state.contextSummary.throughMessage, 2);
  assert.deepEqual(session.state.messages, original);
  assert.deepEqual(mainRequests[0].messages.at(-1), original.at(-1));
  const event = lastEvent(session, "context.summary_completed");
  assert.equal(event.usage.inputTokens, actual);
  assert.equal(event.usageEstimated, true);
  assert.equal(event.usageEstimator, "utf8-bytes-div3-v1");
});

test("摘要显式预算受窗口减输出预留约束，保持独立于软目标", async () => {
  const session = historySession();
  const contextBudget = resolveContextBudget({ contextWindowTokens: 2_000, contextTargetTokens: 400, maxOutputTokens: 500 });
  const { lifecycle, summaryRequests } = fixture(session, { contextBudget, summaryMaxInputTokens: 4_000 });
  await (await lifecycle.startTurn()).completeModelStep();

  assert.equal(lifecycle.summaryMaxInputTokens, 1_500);
  assert.equal(summaryRequests.length, 1);
  const actual = measureModelRequest(summaryRequests[0]).estimatedInputTokens;
  assert.ok(actual > contextBudget.maxInputTokens);
  assert.ok(actual <= 1_500);
});

test("已有窗口描述时默认摘要预算取窗口减输出预留，可超过通用 32000", async () => {
  const messages = [{ role: "user", content: "目标首部" }];
  for (let index = 0; index < 10; index++) messages.push({ role: "assistant", content: "中文历史".repeat(3_000) });
  messages.push({ role: "assistant", content: "历史尾部证据" }, { role: "user", content: "继续当前目标" });
  const state = createSession({ provider: "summary-request-fixture", workspace: "/tmp" });
  state.messages = messages;
  const session = new AgentSession({ state, reducer: reduceSession });
  const contextBudget = resolveContextBudget({ contextWindowTokens: 55_000, contextTargetTokens: 400, maxOutputTokens: 5_000 });
  const { lifecycle, summaryRequests } = fixture(session, { contextBudget });
  await (await lifecycle.startTurn()).completeModelStep();

  assert.equal(lifecycle.summaryMaxInputTokens, 50_000);
  assert.equal(summaryRequests.length, 1);
  const actual = measureModelRequest(summaryRequests[0]).estimatedInputTokens;
  assert.ok(actual > 32_000);
  assert.ok(actual <= 50_000);
});

for (const mode of ["固定提示无法容纳", "旧摘要无法容纳"]) {
  test(`${mode}时本地零成本降级，不登记摘要请求或推进覆盖`, async () => {
    const session = mode === "旧摘要无法容纳" ? previousSummarySession(largeSummary()) : historySession();
    const before = session.state.contextSummary;
    const actions = [];
    session.subscribeEvents((event) => actions.push(event.action));
    const { lifecycle, summaryRequests, mainRequests } = fixture(session,
      mode === "固定提示无法容纳" ? { summaryMaxInputTokens: 1 } : {});
    await (await lifecycle.startTurn()).completeModelStep();

    assert.equal(summaryRequests.length, 0);
    assert.equal(mainRequests.length, 1);
    assert.equal(actions.some((action) => action.type === "CONTEXT_SUMMARY_REQUESTED"), false);
    assert.deepEqual(session.state.contextSummary, before);
    const action = actions.find((entry) => entry.type === "CONTEXT_SUMMARY_DEGRADED");
    assert.ok(action);
    assert.equal(action.modelCall, false);
    assert.equal(action.durationMs, 0);
    assert.deepEqual(action.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.equal(action.usageEstimated, false);
    assert.equal(action.usageEstimator, null);
    assert.match(action.error, /完整请求.*估算输入预算/);
    assert.equal(session.state.metrics.modelCalls, 1);
    assert.equal(session.state.metrics.totalTokens, mainResponse.usage.totalTokens);
  });
}

for (const mode of ["failure", "cancel"]) {
  test(`已实际调用的有界摘要 ${mode} 仍保留尝试费用和原覆盖`, async () => {
    const controller = new AbortController();
    const session = previousSummarySession(summary);
    const before = session.state.contextSummary;
    const { lifecycle, summaryRequests, mainRequests } = fixture(session, { summaryMaxInputTokens: 1_500,
      completeSummary: async () => {
        if (mode === "cancel") controller.abort(new Error("用户取消摘要"));
        throw controller.signal.reason || new Error("摘要服务失败");
      } });
    const turn = await lifecycle.startTurn({ signal: controller.signal });
    if (mode === "cancel") await assert.rejects(turn.completeModelStep(), /用户取消摘要/);
    else await turn.completeModelStep();

    assert.equal(summaryRequests.length, 1);
    assert.equal(mainRequests.length, mode === "cancel" ? 0 : 1);
    assert.deepEqual(session.state.contextSummary, before);
    const actual = measureModelRequest(summaryRequests[0]).estimatedInputTokens;
    assert.ok(actual <= 1_500);
    const event = lastEvent(session, "context.summary_degraded");
    assert.equal(event.usage.inputTokens, actual);
    assert.equal(event.usageEstimated, true);
    assert.equal(event.fromMessage, 2);
    assert.equal(event.throughMessage, 4);
  });
}

test("本地抽取摘要忽略模型输入预算，保留零模型成本与原来源范围", async () => {
  const session = historySession();
  const { lifecycle, summaryRequests, mainRequests } = fixture(session, {
    summaryMaxInputTokens: 1, providerName: "offline-demo",
  });
  await (await lifecycle.startTurn()).completeModelStep();

  assert.equal(summaryRequests.length, 0);
  assert.equal(mainRequests.length, 1);
  assert.equal(session.state.contextSummary.throughMessage, 2);
  const event = lastEvent(session, "context.summary_completed");
  assert.deepEqual(event.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(event.usageEstimated, false);
  assert.equal(session.state.metrics.modelCalls, 1);
});

for (const mode of ["cancel", "turn-budget"]) {
  test(`摘要规划前 ${mode} 退出，不产生本地降级、请求或费用`, async () => {
    const controller = new AbortController();
    const session = historySession();
    const { lifecycle, summaryRequests, mainRequests } = fixture(session, { summaryMaxInputTokens: 1 });
    if (mode === "cancel") controller.abort(new Error("用户取消"));
    const turn = await lifecycle.startTurn({ signal: controller.signal,
      assertCanRequest: () => { if (mode === "turn-budget") throw new Error("本轮预算耗尽"); } });
    await assert.rejects(turn.completeModelStep(), mode === "cancel" ? /用户取消/ : /本轮预算耗尽/);

    assert.equal(summaryRequests.length, 0);
    assert.equal(mainRequests.length, 0);
    assert.equal(session.state.events.some((event) => event.type.startsWith("context.summary_")), false);
    assert.equal(session.state.metrics.modelCalls, 0);
    assert.equal(session.state.metrics.totalTokens, 0);
  });
}

for (const mode of ["cancel", "turn-budget"]) {
  test(`摘要 REQUESTED 后 ${mode} 退出，不调用 provider 或误作可恢复摘要失败`, async () => {
    const controller = new AbortController();
    const session = historySession();
    let denied = false;
    session.subscribeEvents((event) => {
      if (event.action.type !== "CONTEXT_SUMMARY_REQUESTED") return;
      denied = true;
      if (mode === "cancel") controller.abort(new Error("REQUESTED 后取消"));
    });
    const { lifecycle, summaryRequests, mainRequests } = fixture(session, { summaryMaxInputTokens: 1_500 });
    const turn = await lifecycle.startTurn({ signal: controller.signal,
      assertCanRequest: () => { if (denied && mode === "turn-budget") throw new Error("REQUESTED 后预算耗尽"); } });
    await assert.rejects(turn.completeModelStep(), mode === "cancel" ? /REQUESTED 后取消/ : /REQUESTED 后预算耗尽/);

    assert.equal(summaryRequests.length, 0);
    assert.equal(mainRequests.length, 0);
    assert.equal(session.state.contextSummary, null);
    assert.equal(session.state.events.some((event) => event.type === "context.summary_degraded"), false);
    assert.equal(session.state.metrics.totalTokens, 0);
  });
}

test("REQUESTED 后观察者更新来源，模型仍使用规划快照且读取最新计划", async () => {
  const original = previousSummarySession({ ...summary, sourceComplete: false }).state;
  const session = new AgentSession({ state: original, reducer: (state, action) => {
    if (action.type !== "TEST_OBSERVER_SOURCE_CHANGED") return reduceSession(state, action);
    // A legacy Session adapter may update its source snapshot during dispatch.
    // Keep coverage unchanged to isolate request planning from reducer conflicts.
    const next = structuredClone(state);
    next.contextSummary = { ...next.contextSummary, objective: "观察者换入的新摘要", sourceComplete: true };
    next.messages[2].content = "观察者换入的新来源";
    next.plan = { ...next.plan, explanation: "观察者更新后的计划" };
    return next;
  } });
  let update;
  let requested;
  let input;
  let actualRequest;
  session.subscribeEvents((event) => {
    if (event.action.type !== "CONTEXT_SUMMARY_REQUESTED") return;
    requested = event;
    update = session.dispatch({ type: "TEST_OBSERVER_SOURCE_CHANGED" });
  });
  const { lifecycle } = fixture(session, { summaryMaxInputTokens: 2_000,
    summarizeContext: async (value) => {
      input = structuredClone({ ...value, signal: undefined });
      actualRequest = prepareContextSummaryRequest(value);
      return { summary, usage: null };
    } });
  await (await lifecycle.startTurn()).completeModelStep();
  await update;

  assert.equal(input.previousSummary.objective, original.contextSummary.objective);
  assert.equal(input.previousSummary.sourceComplete, false);
  assert.equal(input.sourceComplete, false);
  assert.equal(input.plan.explanation, "观察者更新后的计划");
  assert.doesNotMatch(actualRequest.messages[0].content, /观察者换入的新摘要|观察者换入的新来源/);
  assert.match(actualRequest.messages[0].content, /新增历史目标/);
  const event = lastEvent(session, "context.summary_completed");
  assert.equal(event.sourceCursor, requested.action.sourceCursor);
  assert.equal(requested.action.sourceCursor, requested.cursor - 1);
  assert.equal(event.usage.inputTokens, measureModelRequest(actualRequest).estimatedInputTokens);
  assert.equal(event.sourceComplete, false);
});

function historySession({ content = "历史目标".repeat(2_000) } = {}) {
  const state = createSession({ provider: "summary-request-fixture", workspace: "/tmp" });
  state.messages = [{ role: "user", content }, { role: "assistant", content: "历史尾部证据" },
    { role: "user", content: "继续当前目标" }];
  return new AgentSession({ state, reducer: reduceSession });
}

function previousSummarySession(previous) {
  let state = createSession({ provider: "summary-request-fixture", workspace: "/tmp" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "旧目标" });
  state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "旧结果" } });
  state = reduceSession(state, { type: "CONTEXT_SUMMARY_COMPLETED", summary: previous,
    fromMessage: 0, throughMessage: 2, sourceCursor: 2, sourceComplete: previous.sourceComplete !== false, modelCall: false });
  state = reduceSession(state, { type: "USER_MESSAGE", content: `新增历史目标 ${"历史事实".repeat(2_000)}` });
  state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "新增历史尾部证据" } });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "继续当前目标" });
  return new AgentSession({ state, reducer: reduceSession });
}

function fixture(session, { completeSummary = async () => ({ text: JSON.stringify(summary), usage: null }),
  providerName = "summary-request-fixture", ...options } = {}) {
  const summaryRequests = [];
  const mainRequests = [];
  const lifecycle = new ContextLifecycle({ session, systemPrompt: "完成当前任务", getTools: () => [],
    maxInputTokens: 400,
    provider: { name: providerName, complete: async (request) => { summaryRequests.push(request); return completeSummary(request); } },
    requestModel: async (request) => { mainRequests.push(request); return mainResponse; },
    ...options,
  });
  return { lifecycle, summaryRequests, mainRequests };
}

function lastEvent(session, type) {
  const event = session.state.events.findLast((entry) => entry.type === type);
  assert.ok(event, `缺少 ${type}`);
  return event;
}

function largeSummary() {
  return { objective: "中".repeat(1_000), ...Object.fromEntries(
    ["completed", "active", "decisions", "files", "blockers", "nextMoves"]
      .map((field) => [field, Array.from({ length: 20 }, (_, index) => `${index} ${"文".repeat(497)}`)]),
  ) };
}
