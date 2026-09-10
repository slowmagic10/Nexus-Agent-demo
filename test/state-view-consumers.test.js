import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { ContextLifecycle } from "../src/core/context-lifecycle.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { PermissionToolHostRouter } from "../src/tools/permission-router.js";

for (const narrow of [true, false]) {
  test(`Runtime ${narrow ? "窄状态读取" : "旧 Session fallback"}仍按每步最新用量阻止超额工具`, async () => {
    const native = new AgentSession({ state: initialState(), reducer: reduceSession });
    const traced = traceSession(native, { narrow });
    let modelCalls = 0;
    let toolCalls = 0;
    const runtime = new AgentRuntime({
      session: traced.session,
      systemPrompt: "完成任务",
      maxTokensPerTurn: 30,
      provider: { name: "state-view-test", complete: async () => {
        modelCalls += 1;
        return { text: "继续执行", toolCalls: [{ id: `call-${modelCalls}`, name: "noop", arguments: {} }],
          usage: { inputTokens: 19, outputTokens: 1, totalTokens: 20 } };
      } },
      toolHost: { schemas: () => [], execute: async (call, { session }) => {
        toolCalls += 1;
        await session.dispatch({ type: "TOOL_REQUESTED", call });
        await session.dispatch({ type: "TOOL_RESULT", call, ok: true, result: "ok", durationMs: 1 });
      } },
    });

    const result = await runtime.runTurn("执行到预算边界", async () => false);

    assert.equal(modelCalls, 2);
    assert.equal(toolCalls, 1);
    assert.equal(result.metrics.totalTokens, 40);
    assert.equal(result.phase, "failed");
    assert.match(result.lastError, /累计 Token 用量超过预算 30/);
    assert.match(result.messages.at(-1).content, /没有执行/);
    if (narrow) assert.equal(traced.fullReads(), 1, "仅最终公开返回需要完整快照");
    else assert.ok(traced.fullReads() > 1, "旧接口应通过 state fallback 读取");
    result.messages.length = 0;
    assert.ok(native.state.messages.length > 0, "公开返回值保持独立快照");
  });
}

test("摘要窄读取在 REQUESTED 后更新计划，历史批次及 sourceCursor 保持原来源", async () => {
  const state = [
    { type: "USER_MESSAGE", content: "旧任务内容".repeat(900) },
    { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "旧任务完成" } },
    { type: "USER_MESSAGE", content: "当前任务" },
  ].reduce(reduceSession, initialState());
  const native = new AgentSession({ state, reducer: reduceSession });
  const traced = traceSession(native);
  let requestedEvent;
  let planUpdate;
  native.subscribeEvents((event) => {
    if (event.action.type !== "CONTEXT_SUMMARY_REQUESTED") return;
    requestedEvent = event;
    planUpdate = native.dispatch({ type: "PLAN_UPDATED", explanation: "摘要请求提交后更新",
      steps: [{ step: "核对当前任务", status: "in_progress" }] });
  });
  let summaryInput;
  const lifecycle = new ContextLifecycle({
    session: traced.session,
    provider: { name: "state-view-test", complete: async () => ({}) },
    systemPrompt: "完成任务",
    getTools: () => [],
    maxInputTokens: 400,
    summarizeContext: Object.assign(async (input) => {
      summaryInput = { messages: structuredClone(input.messages), plan: structuredClone(input.plan),
        objective: structuredClone(input.objective), fromMessage: input.fromMessage, throughMessage: input.throughMessage };
      input.plan.explanation = "不可写回 Session";
      return { summary: { objective: "继续当前任务", completed: ["旧任务完成"] } };
    }, { usesModel: false }),
    requestModel: async () => ({ text: "完成", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
  });

  await (await lifecycle.startTurn({ query: "当前任务" })).completeModelStep();
  await planUpdate;

  assert.ok(requestedEvent);
  assert.equal(requestedEvent.action.sourceCursor, requestedEvent.cursor - 1);
  assert.equal(summaryInput.plan.explanation, "摘要请求提交后更新");
  assert.equal(summaryInput.objective.id, native.state.objective.id);
  assert.equal(summaryInput.fromMessage, 0);
  assert.equal(summaryInput.throughMessage, 2);
  assert.deepEqual(summaryInput.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(summaryInput.messages[0].content, "旧任务内容".repeat(900));
  assert.equal(native.state.contextSummary.sourceCursor, requestedEvent.action.sourceCursor);
  assert.equal(native.state.plan.explanation, "摘要请求提交后更新");
  assert.equal(traced.fullReads(), 0);
});

test("Router 窄读取在批次串行边界后按最新权限重选 Host", async () => {
  const native = new AgentSession({ state: initialState(), reducer: reduceSession });
  const traced = traceSession(native);
  const actions = [];
  const host = (profile) => ({
    schemas: () => [{ type: "function", function: { name: profile } }],
    prepareParallelRead: (call) => {
      actions.push(`prepare:${profile}:${call.id}`);
      return null;
    },
    execute: async (call) => {
      actions.push(`execute:${profile}:${call.id}`);
      if (call.id === "first") await native.dispatch({ type: "PERMISSION_PROFILE_DOWNGRADED", profile: "read-only" });
      return profile;
    },
    refreshVerification: () => profile,
  });
  const router = new PermissionToolHostRouter({ hosts: {
    "workspace-auto": host("workspace-auto"), "read-only": host("read-only"),
  } });
  const results = await router.executeBatch([
    { id: "first", name: "noop", arguments: {} },
    { id: "second", name: "noop", arguments: {} },
  ], { session: traced.session });

  assert.deepEqual(results, ["workspace-auto", "read-only"]);
  assert.deepEqual(actions, ["prepare:workspace-auto:first", "execute:workspace-auto:first",
    "prepare:read-only:second", "execute:read-only:second"]);
  assert.equal(router.schemas({ session: traced.session })[0].function.name, "read-only");
  assert.equal(router.refreshVerification({ session: traced.session }), "read-only");
  assert.equal(router.schemas()[0].function.name, "workspace-auto");
  assert.equal(traced.fullReads(), 0);
});

function initialState() {
  return createSession({ provider: "state-view-test", workspace: "/tmp", permissionProfile: "workspace-auto" });
}

function traceSession(native, { narrow = true } = {}) {
  let fullReads = 0;
  const session = {
    get id() { return native.id; },
    get cursor() { return native.cursor; },
    get state() { fullReads += 1; return native.state; },
    ...(narrow ? { readState: (fields) => native.readState(fields) } : {}),
    dispatch: (action) => native.dispatch(action),
    subscribeEvents: (...args) => native.subscribeEvents(...args),
    prepareModelRequest: (options) => native.prepareModelRequest(options),
  };
  return { session, fullReads: () => fullReads };
}
