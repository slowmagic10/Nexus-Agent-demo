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
