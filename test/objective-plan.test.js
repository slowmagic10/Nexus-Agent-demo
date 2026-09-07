import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ToolHost } from "../src/tools/host.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { isObjectiveStatusQuestion, resolveObjectiveMode } from "../src/core/objective-continuation.js";

test("Objective 与 Plan 通过 durable action 进入明确生命周期", () => {
  let state = createSession({ provider: "test", workspace: "/tmp" });
  state = reduceSession(state, {
    type: "USER_MESSAGE",
    content: "完成 Objective 与 Plan 首个切片",
    at: "2026-08-27T01:00:00.000Z",
  });

  assert.equal(state.objective.text, "完成 Objective 与 Plan 首个切片");
  assert.equal(state.objective.status, "active");
  assert.equal(state.plan, null);
  assert.equal(state.events.find((event) => event.type === "objective.created").objectiveId, state.objective.id);

  state = reduceSession(state, {
    type: "PLAN_UPDATED",
    explanation: "先建立 durable 状态，再接 Web 投影",
    steps: [
      { step: "实现状态", status: "completed" },
      { step: "接入 Web", status: "in_progress" },
      { step: "完成验证", status: "pending" },
    ],
    at: "2026-08-27T01:00:01.000Z",
  });

  assert.equal(state.plan.objectiveId, state.objective.id);
  assert.equal(state.plan.revision, 1);
  assert.equal(state.plan.status, "active");
  assert.equal(state.plan.steps[1].status, "in_progress");
  assert.equal(state.events.at(-1).type, "plan.updated");

  state = reduceSession(state, { type: "COMPLETED", at: "2026-08-27T01:00:02.000Z" });
  assert.equal(state.objective.status, "completed");
  assert.equal(state.plan.status, "completed");
  assert.equal(state.objective.completedAt, "2026-08-27T01:00:02.000Z");
});

test("Plan 拒绝空步骤、重复步骤和多个进行中步骤", () => {
  const state = reduceSession(createSession({ provider: "test", workspace: "/tmp" }), {
    type: "USER_MESSAGE",
    content: "验证计划约束",
  });
  assert.throws(() => reduceSession(state, { type: "PLAN_UPDATED", steps: [] }), /至少包含一个步骤/);
  assert.throws(() => reduceSession(state, {
    type: "PLAN_UPDATED",
    steps: [
      { step: "重复", status: "pending" },
      { step: "重复", status: "completed" },
    ],
  }), /步骤不能重复/);
  assert.throws(() => reduceSession(state, {
    type: "PLAN_UPDATED",
    steps: [
      { step: "第一步", status: "in_progress" },
      { step: "第二步", status: "in_progress" },
    ],
  }), /最多一个步骤处于 in_progress/);
});

test("update_plan 在 read-only 中自动执行并写入 Session Journal", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-objective-plan-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const profile = createPermissionProfile({ name: "read-only", workspace, executionType: "native" });
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    accessPolicy: profile,
    workspaceExecution: {
      id: "native-sandbox",
      execute: async () => { throw new Error("Plan 不应启动 WorkspaceExecution Adapter"); },
    },
  });
  const host = new ToolHost({ registry, policy: new WorkspacePolicy({}, { profile, allowElevation: false }) });
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace, permissionProfile: "read-only" }),
    reducer: reduceSession,
  });
  await session.dispatch({ type: "USER_MESSAGE", content: "先规划再执行" });
  let approvals = 0;

  const result = await host.execute({
    id: "plan-call",
    name: "update_plan",
    arguments: {
      explanation: "建立首版计划",
      plan: [
        { step: "理解目标", status: "completed" },
        { step: "实现功能", status: "in_progress" },
      ],
    },
  }, {
    session,
    requestApproval: async () => { approvals += 1; return false; },
  });

  assert.equal(result.status, "completed");
  assert.equal(approvals, 0);
  assert.equal(session.state.plan.steps[1].step, "实现功能");
  assert.ok(host.schemas().some((schema) => schema.function.name === "update_plan"));
  const authorization = session.state.events.find((event) => (
    event.type === "tool.authorization_decided" && event.callId === "plan-call"
  ));
  assert.equal(authorization.decision, "allow");
  assert.equal(authorization.explanation.category, "internal_state");
});

test("Objective 与 Plan 可从 SQLite Journal 重放恢复", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-objective-replay-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace }),
    reducer: reduceSession,
    journal: store,
  });

  await session.dispatch({ type: "USER_MESSAGE", content: "恢复当前目标" });
  await session.dispatch({
    type: "PLAN_UPDATED",
    explanation: "验证 durable replay",
    steps: [
      { step: "写入 Journal", status: "completed" },
      { step: "恢复投影", status: "in_progress" },
    ],
  });

  const restored = store.load(session.id);
  assert.deepEqual(restored.objective, session.state.objective);
  assert.deepEqual(restored.plan, session.state.plan);
  assert.deepEqual(
    store.listSessionEvents(session.id).map((event) => event.type),
    ["SESSION_BASELINE", "USER_MESSAGE", "PLAN_UPDATED"],
  );

  let promptContext;
  const resumed = new AgentSession({ state: restored, reducer: reduceSession, journal: store });
  resumed.prepareModelRequest({
    systemPrompt: (context) => {
      promptContext = context;
      return "恢复计划";
    },
    tools: [],
  });
  assert.deepEqual(promptContext.objective, restored.objective);
  assert.deepEqual(promptContext.plan, restored.plan);
});

test("继续与状态询问只匹配完整短句，明确新目标不会误用旧计划", () => {
  const state = createPlannedState();
  for (const status of ["active", "paused", "failed"]) {
    state.objective.status = status;
    for (const content of ["继续吧", "请继续执行。", "修复好了吗？", "现在修复好了吗", "现在进度如何", "Continue!"]) {
      assert.equal(resolveObjectiveMode(state, content), "continue", `${status}: ${content}`);
    }
    for (const content of ["继续开发另一个项目", "请解释‘继续执行’的含义", "这次不要继续，先讲讲方案", "我怎么启动游戏", "新任务：修复好了吗页面"]) {
      assert.equal(resolveObjectiveMode(state, content), "new", `${status}: ${content}`);
    }
  }
  assert.equal(resolveObjectiveMode(state, "继续吧", { objective: "另一项完整目标" }), "new");
  assert.equal(resolveObjectiveMode(state, "继续吧", { objectiveMode: "new" }), "new");
  assert.equal(resolveObjectiveMode(state, "补充验收要求", { objectiveMode: "continue" }), "continue");
  assert.equal(resolveObjectiveMode(createSession({ provider: "test", workspace: "/tmp" }), "继续吧"), "new");
  assert.throws(() => resolveObjectiveMode(state, "继续", { objectiveMode: "guess" }), /objectiveMode/);
});

test("运行状态追问在普通失败后保留原始 Objective、Plan 和已知阻塞", () => {
  const base = createPlannedState();
  const blockedReason = "需要用户提供测试数据路径";
  const blocked = reduceSession(base, { type: "PLAN_UPDATED", steps: base.plan.steps, blockedReason });
  const failed = reduceSession(blocked, { type: "FAILED", error: "fetch failed" });
  assert.equal(failed.objective.status, "failed");
  assert.equal(failed.plan.status, "failed");

  for (const content of ["跑完了吗", "跑完了吗？", "现在跑完了吗？", "运行完了吗", "现在运行完了吗", "执行完了吗", "现在执行完了吗"]) {
    assert.equal(isObjectiveStatusQuestion(content), true, content);
    const objectiveMode = resolveObjectiveMode(failed, content);
    assert.equal(objectiveMode, "continue", content);
    const queried = reduceSession(failed, {
      type: "USER_MESSAGE", content, objectiveMode,
      preserveBlockedReason: isObjectiveStatusQuestion(content),
    });
    assert.equal(queried.objective.id, base.objective.id, content);
    assert.equal(queried.objective.text, base.objective.text, content);
    assert.equal(queried.objective.createdAt, base.objective.createdAt, content);
    assert.equal(queried.objective.status, "active", content);
    assert.equal(queried.plan.objectiveId, base.objective.id, content);
    assert.equal(queried.plan.status, "active", content);
    assert.equal(queried.plan.revision, blocked.plan.revision, content);
    assert.deepEqual(queried.plan.steps, base.plan.steps, content);
    assert.equal(queried.plan.blockedReason, blockedReason, content);
  }
});

test("运行状态问句保持完整短句和目标生命周期边界", () => {
  const state = createPlannedState();
  for (const content of [
    "跑完了吗，接着开发另一个项目", "现在运行完了吗？顺便加一个删除功能",
    "帮我做一个显示‘跑完了吗’的页面", "说明执行完了吗这个按钮的作用",
  ]) {
    assert.equal(isObjectiveStatusQuestion(content), false, content);
    assert.equal(resolveObjectiveMode(state, content), "new", content);
  }
  for (const content of ["跑完了吗", "现在跑完了吗", "运行完了吗", "现在执行完了吗"]) {
    for (const status of ["active", "paused", "failed"]) {
      const unfinished = { ...state, objective: { ...state.objective, status } };
      assert.equal(resolveObjectiveMode(unfinished, content), "continue", `${status}: ${content}`);
    }
    for (const status of ["completed", "cancelled", "unknown"]) {
      const finished = { ...state, objective: { ...state.objective, status } };
      assert.equal(resolveObjectiveMode(finished, content), "new", `${status}: ${content}`);
    }
    assert.equal(resolveObjectiveMode(state, content, { objectiveMode: "new" }), "new", content);
    assert.equal(resolveObjectiveMode(state, content, { objective: "明确的新任务" }), "new", content);
    assert.equal(resolveObjectiveMode(state, content, { objective: "明确的新任务", objectiveMode: "continue" }), "new", content);
    assert.equal(resolveObjectiveMode(createSession({ provider: "test", workspace: "/tmp" }), content), "new", content);
  }
});

test("完成目标不会复活；取消后仅用户明确继续才恢复目标", () => {
  const state = createPlannedState();
  state.objective.status = "completed";
  assert.equal(resolveObjectiveMode(state, "继续吧"), "new");
  assert.equal(resolveObjectiveMode(state, "修复好了吗"), "new");
  state.objective.status = "cancelled";
  assert.equal(resolveObjectiveMode(state, "继续吧"), "continue");
  assert.equal(resolveObjectiveMode(state, "恢复上一个目标", { objectiveMode: "continue" }), "continue");
  assert.equal(resolveObjectiveMode(state, "修复好了吗"), "new");
  assert.equal(resolveObjectiveMode(state, "现在进度如何"), "new");
});

test("显式继续保留原始目标和步骤，旧 USER_MESSAGE 缺省行为不变", () => {
  let state = createPlannedState();
  const original = structuredClone(state);
  state = reduceSession(state, { type: "FAILED", error: "暂时无法完成", recoverable: true });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "继续吧", objectiveMode: "continue" });
  assert.equal(state.objective.id, original.objective.id);
  assert.equal(state.objective.text, original.objective.text);
  assert.equal(state.objective.createdAt, original.objective.createdAt);
  assert.equal(state.objective.status, "active");
  assert.equal(state.objective.completedAt, undefined);
  assert.deepEqual(state.plan.steps, original.plan.steps);
  assert.equal(state.plan.revision, original.plan.revision);
  assert.equal(state.plan.status, "active");
  assert.equal(state.events.at(-2).type, "objective.continued");

  const replaced = reduceSession(state, { type: "USER_MESSAGE", content: "继续吧" });
  assert.notEqual(replaced.objective.id, original.objective.id);
  assert.equal(replaced.objective.text, "继续吧");
  assert.equal(replaced.plan, null);
  const explicit = reduceSession(state, { type: "USER_MESSAGE", content: "继续", objective: "明确的新目标", objectiveMode: "new" });
  assert.equal(explicit.objective.text, "明确的新目标");
  assert.equal(explicit.plan, null);

  const cancelled = reduceSession(state, { type: "CANCELLED", reason: "用户停止" });
  const resumed = reduceSession(cancelled, { type: "USER_MESSAGE", content: "继续", objectiveMode: "continue" });
  assert.equal(resumed.objective.id, original.objective.id);
  assert.equal(resumed.objective.status, "active");
  assert.equal(resumed.objective.completedAt, undefined);
  assert.deepEqual(resumed.plan.steps, original.plan.steps);
  assert.throws(() => reduceSession(state, { type: "USER_MESSAGE", content: "继续", objectiveMode: "invalid" }), /objectiveMode/);
  const completed = reduceSession(state, { type: "COMPLETED" });
  assert.throws(() => reduceSession(completed, { type: "USER_MESSAGE", content: "继续", objectiveMode: "continue" }), /继续/);
});

test("完成拒绝写入纠正消息，有限失败保持目标计划可恢复", () => {
  let state = createPlannedState();
  const original = structuredClone(state);
  state = reduceSession(state, {
    type: "COMPLETION_REJECTED",
    attempt: 1,
    reasons: ["unfinished_plan"],
    message: "运行时检查发现计划尚未完成，请继续执行并验证。",
  });
  assert.equal(state.phase, "thinking");
  assert.equal(state.messages.at(-1).role, "system");
  assert.match(state.messages.at(-1).content, /计划尚未完成/);
  assert.deepEqual(state.events.at(-1).reasons, ["unfinished_plan"]);
  assert.equal(state.events.at(-1).attempt, 1);
  assert.equal(state.events.at(-1).type, "session.completion_rejected");
  state = reduceSession(state, { type: "FAILED", error: "自动纠正次数耗尽", recoverable: true, reason: "completion_validation_exhausted" });
  assert.equal(state.phase, "failed");
  assert.equal(state.objective.status, "paused");
  assert.equal(state.plan.status, "paused");
  assert.equal(state.objective.completedAt, undefined);
  assert.deepEqual(state.plan.steps, original.plan.steps);
  assert.equal(state.events.findLast((event) => event.type === "objective.paused").reason, "completion_validation_exhausted");
  assert.equal(state.events.at(-1).type, "session.failed");
  const legacyFailure = reduceSession(original, { type: "FAILED", error: "普通失败" });
  assert.equal(legacyFailure.objective.status, "failed");
  assert.equal(legacyFailure.plan.status, "failed");
});

test("Plan 的明确阻塞原因经过校验，并在继续或更新后清除", () => {
  const base = createPlannedState();
  const update = { type: "PLAN_UPDATED", steps: base.plan.steps };
  let state = reduceSession(base, { ...update, blockedReason: "缺少测试服务的访问凭证" });
  assert.equal(state.plan.blockedReason, "缺少测试服务的访问凭证");
  assert.equal(state.events.at(-1).blockedReason, state.plan.blockedReason);
  for (const blockedReason of ["", "  ", null, 42, "a".repeat(1001)]) {
    assert.throws(() => reduceSession(base, { ...update, blockedReason }), /blockedReason/);
  }
  assert.equal(reduceSession(state, update).plan.blockedReason, undefined);
  state = reduceSession(state, { type: "FAILED", error: state.plan.blockedReason, recoverable: true, reason: "blocked" });
  assert.equal(state.plan.blockedReason, "缺少测试服务的访问凭证");
  state = reduceSession(state, { type: "USER_MESSAGE", content: "凭证已配置，继续", objectiveMode: "continue" });
  assert.equal(state.plan.blockedReason, undefined);
  assert.equal(state.plan.status, "active");
});

test("状态追问保留已知阻塞，明确继续和操作请求仍可重新尝试", () => {
  const base = createPlannedState();
  const blocked = reduceSession(base, { type: "PLAN_UPDATED", steps: base.plan.steps, blockedReason: "需要用户提供测试数据路径" });
  const paused = reduceSession(blocked, { type: "FAILED", error: blocked.plan.blockedReason, recoverable: true, reason: "objective_blocked" });
  for (const content of ["修复好了吗？", "现在进度如何", "Are you done?"]) {
    assert.equal(isObjectiveStatusQuestion(content), true);
    const queried = reduceSession(paused, {
      type: "USER_MESSAGE", content,
      objectiveMode: resolveObjectiveMode(paused, content),
      preserveBlockedReason: isObjectiveStatusQuestion(content),
    });
    assert.equal(queried.objective.id, base.objective.id);
    assert.equal(queried.plan.blockedReason, blocked.plan.blockedReason);
    assert.deepEqual(queried.plan.steps, base.plan.steps);
  }
  for (const content of ["继续", "修复检查看下", "不要修复，只说明现在进度如何"]) {
    assert.equal(isObjectiveStatusQuestion(content), false);
  }
  const continued = reduceSession(paused, {
    type: "USER_MESSAGE", content: "继续", objectiveMode: "continue",
  });
  assert.equal(continued.plan.blockedReason, undefined);
});

test("纠正、可恢复失败和继续可通过 SQLite 导出导入严格重放", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-objective-continuation-"));
  const store = new SessionStore(path.join(workspace, "source.db"), { workspace });
  const destination = new SessionStore(path.join(workspace, "destination.db"), { workspace });
  t.after(async () => {
    store.close();
    destination.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const session = new AgentSession({ state: createSession({ provider: "test", workspace }), reducer: reduceSession, journal: store });
  await session.dispatch({ type: "USER_MESSAGE", content: "一次性完成全部开发与测试" });
  await session.dispatch({ type: "PLAN_UPDATED", steps: [{ step: "完成测试", status: "in_progress" }] });
  await session.dispatch({ type: "COMPLETION_REJECTED", attempt: 1, reasons: ["unfinished_plan"], message: "请完成测试后再交付。" });
  await session.dispatch({ type: "FAILED", error: "纠正次数耗尽", recoverable: true });
  const restored = store.load(session.id);
  assert.equal(restored.objective.status, "paused");
  const loaded = new AgentSession({ state: restored, reducer: reduceSession, journal: store });
  const request = loaded.prepareModelRequest({ systemPrompt: "测试", tools: [] });
  assert.match(request.systemPrompt, /完成测试/);
  assert.equal(request.messages.some((message) => message.role === "system"), false);
  await loaded.dispatch({ type: "USER_MESSAGE", content: "继续吧", objectiveMode: "continue" });
  await loaded.dispatch({ type: "PLAN_UPDATED", steps: loaded.state.plan.steps, blockedReason: "需要配置测试服务" });
  await loaded.dispatch({ type: "FAILED", error: "需要配置测试服务", recoverable: true, reason: "blocked" });
  await loaded.dispatch({ type: "USER_MESSAGE", content: "修复好了吗", objectiveMode: "continue", preserveBlockedReason: true });
  assert.equal(loaded.state.plan.blockedReason, "需要配置测试服务");
  const imported = destination.importJournal(store.exportJournal(session.id), { id: "session-continuation-imported", workspace });
  assert.deepEqual(imported.objective, loaded.state.objective);
  assert.deepEqual(imported.plan, loaded.state.plan);
  assert.deepEqual(imported.messages, loaded.state.messages);
  assert.deepEqual(imported.events, loaded.state.events);
});

function createPlannedState() {
  let state = reduceSession(createSession({ provider: "test", workspace: "/tmp" }), {
    type: "USER_MESSAGE", content: "一次性完成全部开发与测试", at: "2026-09-07T01:00:00.000Z",
  });
  return reduceSession(state, {
    type: "PLAN_UPDATED",
    steps: [{ step: "实现功能", status: "completed" }, { step: "完成测试", status: "in_progress" }],
    at: "2026-09-07T01:00:01.000Z",
  });
}
