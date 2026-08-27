import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDelegatedSession, createSession, reduceSession } from "../src/core/state.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { ToolHost } from "../src/tools/host.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("单层委派具有 durable Parent/Child 生命周期", () => {
  let parent = reduceSession(createSession({ provider: "test", workspace: "/tmp" }), {
    type: "USER_MESSAGE",
    content: "完成父任务",
    at: "2026-08-27T08:00:00.000Z",
  });
  parent = reduceSession(parent, {
    type: "DELEGATION_REQUESTED",
    delegation: {
      id: "delegation-1",
      childSessionId: "session-child",
      objective: "检查一个独立问题",
      contextItems: 1,
      context: ["一个明确事实"],
      budget: { maxSteps: 5, maxTokensPerTurn: 10_000 },
    },
    at: "2026-08-27T08:00:01.000Z",
  });
  assert.equal(parent.delegations[0].status, "running");
  assert.deepEqual(parent.delegations[0].context, ["一个明确事实"]);
  assert.equal(parent.events.at(-1).type, "agent.transfer_requested");
  assert.throws(() => reduceSession(parent, {
    type: "DELEGATION_REQUESTED",
    delegation: { id: "delegation-2", childSessionId: "session-other", objective: "重复" },
  }), /已有正在运行的委派/);
  const interrupted = reduceSession(parent, {
    type: "RESUMED",
    provider: "test",
    workspace: "/tmp",
    at: "2026-08-27T08:00:01.500Z",
  });
  assert.equal(interrupted.delegations[0].status, "interrupted");
  assert.ok(interrupted.events.some((event) => event.type === "agent.transfer_interrupted"));

  const child = createDelegatedSession(parent, {
    id: "session-child",
    delegationId: "delegation-1",
    parentCursor: 3,
    provider: "test",
    workspace: "/tmp",
    delegatedAt: "2026-08-27T08:00:02.000Z",
  });
  assert.deepEqual(child.messages, []);
  assert.equal(child.lineage.kind, "delegation");
  assert.equal(child.lineage.parentSessionId, parent.id);
  assert.throws(() => reduceSession(child, {
    type: "DELEGATION_REQUESTED",
    delegation: { id: "nested", childSessionId: "nested-child", objective: "嵌套" },
  }), /Child Session 不能继续创建 Child/);

  parent = reduceSession(parent, {
    type: "DELEGATION_COMPLETED",
    delegationId: "delegation-1",
    result: "检查完成",
    childCursor: 5,
    at: "2026-08-27T08:00:03.000Z",
  });
  assert.equal(parent.delegations[0].status, "completed");
  assert.equal(parent.delegations[0].childCursor, 5);
  assert.equal(parent.events.at(-1).type, "agent.transfer_completed");
});

test("Gateway 单层委派只传显式上下文、继承受限预算并回填结果", async (t) => {
  const fixture = await createDelegationFixture({ childResult: "子任务验证通过" });
  t.after(fixture.close);

  const parent = await fixture.manager.create();
  await fixture.manager.sendMessage(parent.id, "父任务中的私有 transcript 不应整体复制");
  await waitFor(async () => (await fixture.manager.get(parent.id)).phase === "completed");

  const completed = await fixture.manager.get(parent.id);
  const delegation = completed.delegations[0];
  const child = await fixture.manager.get(delegation.childSessionId);
  assert.equal(delegation.status, "completed");
  assert.deepEqual(delegation.budget, { maxSteps: 4, maxTokensPerTurn: 2_000 });
  assert.deepEqual(delegation.context, ["只传递这一条事实"]);
  assert.equal(child.lineage.parentSessionId, parent.id);
  assert.equal(child.objective.text, "检查独立模块");
  assert.match(child.messages[0].content, /只传递这一条事实/);
  assert.doesNotMatch(child.messages[0].content, /私有 transcript/);
  assert.match(completed.messages.at(-1).content, /父任务已合并 Child 结果/);
  assert.ok(fixture.host.schemas({ session: fixture.manager.sessions.get(parent.id).session })
    .some((schema) => schema.function.name === "delegate_task"));
  assert.ok(!fixture.host.schemas({ session: fixture.manager.sessions.get(child.id).session })
    .some((schema) => schema.function.name === "delegate_task"));
});

test("取消 Parent 会级联取消正在运行的 Child", async (t) => {
  const fixture = await createDelegationFixture({ waitForChildAbort: true });
  t.after(fixture.close);
  const parent = await fixture.manager.create();
  await fixture.manager.sendMessage(parent.id, "启动可取消委派");
  await waitFor(async () => (await fixture.manager.get(parent.id)).delegations?.[0]?.status === "running");
  const childId = (await fixture.manager.get(parent.id)).delegations[0].childSessionId;

  await fixture.manager.cancel(parent.id);
  await waitFor(async () => (
    (await fixture.manager.get(parent.id)).phase === "cancelled"
    && (await fixture.manager.get(childId)).phase === "cancelled"
  ));

  const cancelled = await fixture.manager.get(parent.id);
  assert.equal(cancelled.delegations[0].status, "cancelled");
  assert.ok(cancelled.events.some((event) => event.type === "agent.transfer_cancelled"));
});

test("Child 的风险工具审批代理到 Parent 后继续执行", async (t) => {
  const fixture = await createDelegationFixture({ childNeedsApproval: true });
  t.after(fixture.close);
  const parent = await fixture.manager.create();
  await fixture.manager.sendMessage(parent.id, "委派一个需要确认的动作");
  await waitFor(async () => (await fixture.manager.get(parent.id)).pendingApproval?.delegated === true);

  const waiting = await fixture.manager.get(parent.id);
  assert.equal(waiting.phase, "awaiting_approval");
  assert.equal(waiting.pendingApproval.name, "child_action");
  assert.ok(waiting.pendingApproval.childSessionId);
  await fixture.manager.decideApproval(parent.id, waiting.pendingApproval.id, true, "once");
  await waitFor(async () => (await fixture.manager.get(parent.id)).phase === "completed");

  const completed = await fixture.manager.get(parent.id);
  const child = await fixture.manager.get(completed.delegations[0].childSessionId);
  assert.ok(completed.events.some((event) => event.type === "agent.transfer_approval_granted"));
  assert.ok(child.events.some((event) => event.type === "approval.granted"));
  assert.match(child.messages.find((message) => message.role === "tool")?.content || "", /Child 动作完成/);
});

async function createDelegationFixture({ childResult = "完成", waitForChildAbort = false, childNeedsApproval = false } = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-delegation-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  let manager;
  let parentCalls = 0;
  let childCalls = 0;
  const provider = {
    name: "delegation-provider",
    complete: async ({ messages, signal }) => {
      const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content || "";
      if (/单层 Child Agent/.test(lastUser)) {
        if (waitForChildAbort) {
          return await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        childCalls += 1;
        if (childNeedsApproval && childCalls === 1) {
          return {
            text: "需要执行 Child 风险动作",
            toolCalls: [{ id: "child-action-call", name: "child_action", arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        }
        return { text: childResult, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          text: "交给 Child 检查",
          toolCalls: [{
            id: "delegate-call",
            name: "delegate_task",
            arguments: {
              objective: "检查独立模块",
              context: ["只传递这一条事实"],
              budget: { maxSteps: 4, maxTokensPerTurn: 2_000 },
            },
          }],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      }
      return { text: "父任务已合并 Child 结果", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
  };
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    delegateTask: (input, context) => manager.delegate(context.state.id, input, { signal: context.signal }),
    extraTools: [{
      name: "child_action",
      description: "需要用户确认的 Child 测试动作",
      approval: "always",
      effects: ["execute"],
      idempotency: "safe",
      capability: { risk: "R2", readOnly: false, resources: [{ kind: "external", access: "execute", value: "child-action" }] },
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => "Child 动作完成",
    }],
  });
  const host = new ToolHost({
    registry,
    policy: new WorkspacePolicy({}, { profile: registry.accessPolicy, allowElevation: false }),
  });
  manager = new GatewaySessionManager({
    workspace,
    provider,
    toolHost: host,
    permissionToolHosts: { "workspace-auto": host },
    defaultPermissionProfile: "workspace-auto",
    systemPrompt: () => "test",
    store,
    maxSteps: 8,
    maxTokensPerTurn: 5_000,
  });
  return {
    manager,
    host,
    close: async () => {
      await manager.close();
      store.close();
      await fs.rm(workspace, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待条件超时");
}
