import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import {
  createSessionGrant,
  issueSessionGrant,
  revokeSessionGrant,
  WorkspacePolicy,
} from "../src/tools/authorization.js";
import { ToolHost } from "../src/tools/host.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { ProjectGrantStore } from "../src/tools/project-grant-store.js";

test("Tool Host 在审批和执行前校验参数", async () => {
  let approvals = 0;
  let executions = 0;
  const { host, session } = fixture({
    name: "write_note",
    description: "写入内容",
    parameters: objectSchema({ content: { type: "string" } }, ["content"]),
    approval: "always",
    effects: ["write"],
    idempotency: "unknown",
    execute: async () => { executions += 1; return "不应执行"; },
  });

  const result = await host.execute({ id: "call-invalid", name: "write_note", arguments: {} }, {
    session,
    requestApproval: async () => { approvals += 1; return true; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "validation_failed");
  assert.equal(approvals, 0);
  assert.equal(executions, 0);
  assert.match(session.state.messages.at(-1).content, /缺少必填字段 content/);
  assert.ok(session.state.events.some((event) => event.type === "tool.validation_failed"));
});

test("Tool Host 将 Approval 绑定 args hash，并统一脱敏执行结果", async () => {
  let pending;
  const { host, session } = fixture({
    name: "external_write",
    description: "外部写入",
    parameters: objectSchema({ value: { type: "string" } }, ["value"]),
    approval: "always",
    effects: ["network", "write"],
    idempotency: "keyed",
    adapter: "mcp",
    execute: async ({ value }) => `已写入 ${value}；Authorization: Bearer secret-token`,
  });

  const result = await host.execute({ id: "call-approved", name: "external_write", arguments: { value: "ok" } }, {
    session,
    requestApproval: async () => {
      pending = session.state.pendingApproval;
      return true;
    },
  });

  assert.equal(result.ok, true);
  assert.match(pending.argsHash, /^[a-f0-9]{64}$/);
  assert.match(pending.toolVersion, /^[a-f0-9]{64}$/);
  assert.equal(session.state.pendingApproval, null);
  assert.match(session.state.messages.at(-1).content, /Bearer \[REDACTED\]/);
  const authorization = session.state.events.find((event) => event.type === "tool.authorization_decided");
  assert.equal(authorization.adapter, "mcp");
  assert.equal(authorization.risk, "R2");
  assert.equal(authorization.argsHash, pending.argsHash);
  assert.equal(authorization.decision, "approval_required");
  assert.equal(authorization.ruleId, "profile.approval-required.elevated_approval");
  assert.match(authorization.reason, /Permission Profile/);
  assert.equal(pending.policyVersion, authorization.policyVersion);
  assert.equal(session.state.toolGrants.length, 1);
  assert.equal(session.state.toolGrants[0].policyVersion, authorization.policyVersion);
  assert.ok(session.state.events.some((event) => event.type === "tool.execution_started"));
});

test("Approval 自动签发的 call-bound Grant 不能重放", async () => {
  let approvals = 0;
  let executions = 0;
  const { host, session } = fixture({
    name: "replay_write",
    description: "重放保护写入",
    parameters: objectSchema({ value: { type: "string" } }, ["value"]),
    effects: ["write"],
    idempotency: "unknown",
    execute: async () => { executions += 1; return "ok"; },
  });
  const call = { id: "call-replayed", name: "replay_write", arguments: { value: "same" } };
  const requestApproval = async () => {
    approvals += 1;
    return approvals === 1;
  };

  const first = await host.execute(call, { session, requestApproval });
  const replay = await host.execute(call, { session, requestApproval });

  assert.equal(first.status, "completed");
  assert.equal(replay.status, "denied");
  assert.equal(executions, 1);
  assert.equal(approvals, 2);
  const grant = session.state.toolGrants[0];
  assert.equal(grant.usage, "single_use");
  assert.equal(grant.consumedByCallId, call.id);
  assert.ok(grant.consumedAt);
  const eventTypes = session.state.events.map((event) => event.type);
  assert.ok(eventTypes.indexOf("tool.grant_issued") < eventTypes.indexOf("tool.grant_consumed"));
  assert.ok(eventTypes.indexOf("tool.grant_consumed") < eventTypes.indexOf("tool.execution_started"));
});

test("Approval 可签发精确资源的 Session Grant，并拒绝跨资源复用", async () => {
  let approvals = 0;
  let executions = 0;
  const tool = {
    name: "session_write",
    description: "Session 授权写入",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    effects: ["write"],
    idempotency: "unknown",
    capability: {
      risk: "R1",
      readOnly: false,
      resources: [{ kind: "workspace_path", argument: "path", access: "write" }],
    },
    execute: async () => { executions += 1; return "ok"; },
  };
  const { host, session } = fixture(tool, { workspace: "/tmp" });
  const approveForSession = async () => {
    approvals += 1;
    return { approved: true, scope: "session" };
  };

  assert.equal((await host.execute({ id: "session-1", name: tool.name, arguments: { path: "notes/a.md" } }, {
    session,
    requestApproval: approveForSession,
  })).status, "completed");
  assert.equal((await host.execute({ id: "session-2", name: tool.name, arguments: { path: "notes/a.md" } }, {
    session,
    requestApproval: async () => { approvals += 1; return false; },
  })).status, "completed");
  assert.equal((await host.execute({ id: "session-3", name: tool.name, arguments: { path: "notes/b.md" } }, {
    session,
    requestApproval: async () => { approvals += 1; return false; },
  })).status, "denied");

  assert.equal(approvals, 2);
  assert.equal(executions, 2);
  assert.equal(session.state.toolGrants[0].usage, "session");
  assert.equal(session.state.toolGrants[0].callId, null);
  assert.equal(session.state.events.find((event) => event.type === "approval.granted").grantScope, "session");
});

test("Project Grant 仅在同一规范 workspace 复用，且策略变化后失效", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-grant-workspace-"));
  const otherWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-grant-other-"));
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-grant-store-"));
  const projectGrantStore = new ProjectGrantStore(path.join(storeRoot, "grants.db"));
  t.after(async () => {
    projectGrantStore.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(otherWorkspace, { recursive: true, force: true });
    await fs.rm(storeRoot, { recursive: true, force: true });
  });
  let approvals = 0;
  let executions = 0;
  const tool = {
    name: "project_shell",
    description: "项目授权命令",
    parameters: objectSchema({ command: { type: "string" } }, ["command"]),
    effects: ["execute"],
    idempotency: "unknown",
    capability: {
      risk: "R2",
      readOnly: false,
      resources: [{ kind: "shell_command", argument: "command", access: "execute" }],
    },
    execute: async () => { executions += 1; return "ok"; },
  };
  const policy = new WorkspacePolicy();
  const first = fixture(tool, { workspace, policy, projectGrantStore });
  await first.host.execute({ id: "project-1", name: tool.name, arguments: { command: "npm test" } }, {
    session: first.session,
    requestApproval: async () => { approvals += 1; return { approved: true, scope: "project" }; },
  });
  const second = fixture(tool, { workspace, policy, projectGrantStore });
  assert.equal((await second.host.execute({ id: "project-2", name: tool.name, arguments: { command: "npm test" } }, {
    session: second.session,
    requestApproval: async () => { approvals += 1; return false; },
  })).status, "completed");
  const foreign = fixture(tool, { workspace: otherWorkspace, policy, projectGrantStore });
  assert.equal((await foreign.host.execute({ id: "project-foreign", name: tool.name, arguments: { command: "npm test" } }, {
    session: foreign.session,
    requestApproval: async () => { approvals += 1; return false; },
  })).status, "denied");

  policy.replace({ rules: [{ id: "still-approval", tools: [tool.name], decision: "approval_required" }] });
  const changedPolicy = fixture(tool, { workspace, policy, projectGrantStore });
  assert.equal((await changedPolicy.host.execute({ id: "project-stale", name: tool.name, arguments: { command: "npm test" } }, {
    session: changedPolicy.session,
    requestApproval: async () => { approvals += 1; return false; },
  })).status, "denied");

  assert.equal(approvals, 3);
  assert.equal(executions, 2);
  assert.equal(projectGrantStore.list({ workspace }).length, 1);
  assert.ok(first.session.state.events.some((event) => event.type === "tool.project_grant_issued"));
});

test("有副作用工具超时后记录 execution_unknown 且不悬挂", async () => {
  const { host, session } = fixture({
    name: "slow_write",
    description: "缓慢写入",
    parameters: objectSchema({}),
    approval: "never",
    effects: ["write"],
    idempotency: "unknown",
    timeoutMs: 5,
    execute: async () => new Promise(() => {}),
  }, { policy: new WorkspacePolicy({ rules: [{ id: "allow-slow-test", tools: ["slow_write"], decision: "allow" }] }) });

  const result = await host.execute({ id: "call-timeout", name: "slow_write", arguments: {} }, {
    session,
    requestApproval: async () => false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "execution_unknown");
  assert.match(result.result, /超时.*未知/);
  assert.ok(session.state.events.some((event) => (
    event.type === "tool.execution_unknown" && event.callId === "call-timeout"
  )));
  assert.equal(session.state.messages.at(-1).tool_call_id, "call-timeout");
});

test("执行中的有副作用工具被取消后仍记录实际工具耗时", async () => {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const { host, session } = fixture({
    name: "cancelled_slow_write",
    description: "会被取消的缓慢写入",
    parameters: objectSchema({}),
    approval: "never",
    effects: ["write"],
    idempotency: "unknown",
    execute: async () => {
      markStarted();
      return new Promise(() => {});
    },
  }, { policy: new WorkspacePolicy({ rules: [{ id: "allow-cancel-test", tools: ["cancelled_slow_write"], decision: "allow" }] }) });
  const controller = new AbortController();

  const execution = host.execute({ id: "call-cancelled-running", name: "cancelled_slow_write", arguments: {} }, {
    session,
    signal: controller.signal,
  });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 15));
  controller.abort(new Error("cancelled by test"));

  await assert.rejects(execution, /cancelled by test/);
  const completed = session.state.events.find((event) => (
    event.type === "tool.completed" && event.callId === "call-cancelled-running"
  ));
  assert.equal(completed.status, "execution_unknown");
  assert.ok(completed.durationMs > 0);
  assert.equal(session.state.metrics.toolDurationMs, completed.durationMs);
  assert.ok(session.state.events.some((event) => (
    event.type === "tool.execution_unknown" && event.callId === "call-cancelled-running"
  )));
});

test("Tool Host 收到预取消信号时不会启动有副作用工具", async () => {
  let executions = 0;
  const { host, session } = fixture({
    name: "cancelled_write",
    description: "不应启动的写入",
    parameters: objectSchema({}),
    approval: "never",
    effects: ["write"],
    idempotency: "unknown",
    execute: async () => { executions += 1; return "不应执行"; },
  });
  const controller = new AbortController();
  controller.abort(new Error("pre-cancelled"));

  await assert.rejects(
    host.execute({ id: "call-pre-cancelled", name: "cancelled_write", arguments: {} }, {
      session,
      signal: controller.signal,
    }),
    /pre-cancelled/,
  );

  assert.equal(executions, 0);
  assert.equal(session.state.events.some((event) => event.type === "tool.execution_started"), false);
  assert.equal(session.state.events.some((event) => event.type === "tool.execution_unknown"), false);
  assert.equal(session.state.messages.at(-1).tool_call_id, "call-pre-cancelled");
  assert.match(session.state.messages.at(-1).content, /取消.*尚未启动/);
});

test("Approval 后参数变化会失效且不会执行", async () => {
  let executions = 0;
  const call = { id: "call-stale", name: "write_value", arguments: { value: "before" } };
  const { host, session } = fixture({
    name: "write_value",
    description: "写入值",
    parameters: objectSchema({ value: { type: "string" } }, ["value"]),
    approval: "always",
    effects: ["write"],
    idempotency: "unknown",
    execute: async () => { executions += 1; return "不应执行"; },
  });

  const result = await host.execute(call, {
    session,
    requestApproval: async () => {
      call.arguments.value = "after";
      return true;
    },
  });

  assert.equal(result.status, "approval_stale");
  assert.equal(executions, 0);
  assert.ok(session.state.events.some((event) => event.type === "approval.stale"));
});

test("workspace 外路径在 Adapter 启动前始终拒绝", async () => {
  let executions = 0;
  const { host, session } = fixture({
    name: "read_workspace_file",
    description: "读取工作区文件",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    effects: ["read"],
    idempotency: "safe",
    capability: {
      risk: "R0",
      readOnly: true,
      resources: [{ kind: "workspace_path", argument: "path", access: "read" }],
    },
    execute: async () => { executions += 1; return "不应执行"; },
  });

  const result = await host.execute({
    id: "call-outside",
    name: "read_workspace_file",
    arguments: { path: "../outside.txt" },
  }, { session });

  assert.equal(result.status, "policy_denied");
  assert.equal(executions, 0);
  const authorization = session.state.events.find((event) => event.type === "tool.authorization_decided");
  assert.equal(authorization.decision, "deny");
  assert.equal(authorization.ruleId, "builtin.workspace_boundary");
  assert.match(authorization.reason, /工作区外路径/);
  assert.equal(session.state.events.some((event) => event.type === "tool.execution_started"), false);
});

test("指向 workspace 外部的符号链接在 Adapter 启动前拒绝", async (t) => {
  let executions = 0;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-policy-workspace-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-policy-outside-"));
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.symlink(outside, path.join(workspace, "escape"));
  const { host, session } = fixture({
    name: "read_symlink",
    description: "读取符号链接",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    effects: ["read"],
    idempotency: "safe",
    capability: {
      risk: "R0",
      readOnly: true,
      resources: [{ kind: "workspace_path", argument: "path", access: "read" }],
    },
    execute: async () => { executions += 1; return "不应执行"; },
  }, { workspace });

  const result = await host.execute({ id: "call-symlink", name: "read_symlink", arguments: { path: "escape/secret.txt" } }, { session });

  assert.equal(result.status, "policy_denied");
  assert.equal(executions, 0);
  assert.equal(session.state.events.find((event) => event.type === "tool.authorization_decided").ruleId, "builtin.workspace_boundary");
});

test("Workspace Policy deny 会隐藏 schema 并阻止 Adapter", async () => {
  let executions = 0;
  const policy = new WorkspacePolicy({
    rules: [{ id: "deny-shell", tools: ["run_shell"], decision: "deny", reason: "测试环境禁用 Shell" }],
  });
  const { host, session } = fixture({
    name: "run_shell",
    description: "执行 Shell",
    parameters: objectSchema({ command: { type: "string" } }, ["command"]),
    effects: ["execute"],
    idempotency: "unknown",
    capability: { risk: "R2", readOnly: false, resources: [{ kind: "workspace", access: "execute" }] },
    execute: async () => { executions += 1; return "不应执行"; },
  }, { policy });

  assert.deepEqual(host.schemas({ session }), []);
  const result = await host.execute({ id: "call-denied-shell", name: "run_shell", arguments: { command: "pwd" } }, { session });

  assert.equal(result.status, "policy_denied");
  assert.equal(executions, 0);
  const authorization = session.state.events.find((event) => event.type === "tool.authorization_decided");
  assert.equal(authorization.ruleId, "deny-shell");
  assert.equal(authorization.reason, "测试环境禁用 Shell");
});

test("Session Grant 只在绑定会话和 workspace 内生效，并支持撤销", async () => {
  let executions = 0;
  let approvals = 0;
  const tool = {
    name: "write_note",
    description: "写入笔记",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    effects: ["write"],
    idempotency: "unknown",
    capability: {
      risk: "R1",
      readOnly: false,
      resources: [{ kind: "workspace_path", argument: "path", access: "write" }],
    },
    execute: async () => { executions += 1; return "ok"; },
  };
  const primary = fixture(tool, { workspace: "/tmp" });
  await primary.host.execute({ id: "grant-seed", name: tool.name, arguments: { path: "notes/a.md" } }, {
    session: primary.session,
    requestApproval: async () => true,
  });
  const authorization = primary.session.state.events.find((event) => event.type === "tool.authorization_decided");
  const grant = createSessionGrant({
    id: "grant-session-write-note",
    sessionId: primary.session.id,
    workspace: primary.session.state.workspace,
    tool: tool.name,
    capabilityHash: authorization.capabilityHash,
    policyVersion: authorization.policyVersion,
    resources: authorization.resources.map((resource) => ({ ...resource, match: "prefix", value: "notes" })),
  });
  await issueSessionGrant(primary.session, grant);

  await primary.host.execute({ id: "grant-reuse", name: tool.name, arguments: { path: "notes/b.md" } }, {
    session: primary.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(approvals, 0);
  assert.equal(executions, 2);

  const foreignSession = fixture(tool, { workspace: "/tmp" });
  await assert.rejects(issueSessionGrant(foreignSession.session, grant), /不能跨 Session/);
  await foreignSession.session.dispatch({ type: "TOOL_GRANT_ISSUED", grant });
  const foreignResult = await foreignSession.host.execute({
    id: "foreign-session",
    name: tool.name,
    arguments: { path: "notes/c.md" },
  }, {
    session: foreignSession.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(foreignResult.status, "denied");
  assert.equal(executions, 2);

  const foreignWorkspace = fixture(tool, { workspace: "/var/tmp", sessionId: primary.session.id });
  await assert.rejects(issueSessionGrant(foreignWorkspace.session, grant), /不能跨 Session 或 workspace/);
  await foreignWorkspace.session.dispatch({ type: "TOOL_GRANT_ISSUED", grant });
  const foreignWorkspaceResult = await foreignWorkspace.host.execute({
    id: "foreign-workspace",
    name: tool.name,
    arguments: { path: "notes/c.md" },
  }, {
    session: foreignWorkspace.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(foreignWorkspaceResult.status, "denied");
  assert.equal(executions, 2);

  await revokeSessionGrant(primary.session, grant.id, "测试撤销");
  const revokedResult = await primary.host.execute({ id: "grant-revoked", name: tool.name, arguments: { path: "notes/d.md" } }, {
    session: primary.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(revokedResult.status, "denied");
  assert.equal(primary.session.state.toolGrants.find((item) => item.id === grant.id).revokedAt !== null, true);
  assert.ok(primary.session.state.events.some((event) => event.type === "tool.grant_revoked"));

  const expiredGrant = createSessionGrant({
    id: "grant-expired",
    sessionId: primary.session.id,
    workspace: primary.session.state.workspace,
    tool: tool.name,
    capabilityHash: authorization.capabilityHash,
    policyVersion: authorization.policyVersion,
    resources: authorization.resources,
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:01:00.000Z",
  });
  await issueSessionGrant(primary.session, expiredGrant);
  const expiredResult = await primary.host.execute({ id: "grant-expired-call", name: tool.name, arguments: { path: "notes/a.md" } }, {
    session: primary.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(expiredResult.status, "denied");
  assert.equal(executions, 2);
});

test("Workspace Policy 变化后旧 Approval 自动失效", async () => {
  let executions = 0;
  const policy = new WorkspacePolicy();
  const { host, session } = fixture({
    name: "policy_write",
    description: "策略变化测试",
    parameters: objectSchema({ value: { type: "string" } }, ["value"]),
    effects: ["write"],
    idempotency: "unknown",
    execute: async () => { executions += 1; return "不应执行"; },
  }, { policy });

  const result = await host.execute({ id: "policy-stale", name: "policy_write", arguments: { value: "x" } }, {
    session,
    requestApproval: async () => {
      policy.replace({ rules: [{ id: "deny-policy-write", tools: ["policy_write"], decision: "deny" }] });
      return true;
    },
  });

  assert.equal(result.status, "approval_stale");
  assert.equal(executions, 0);
  const stale = session.state.events.find((event) => event.type === "approval.stale");
  assert.notEqual(stale.policyVersion, stale.currentPolicyVersion);
});

test("workspace-auto 自动允许普通文件写入和 Native 沙箱常规命令", async () => {
  const profile = createPermissionProfile({ name: "workspace-auto", workspace: "/tmp", executionType: "native" });
  let executions = 0;
  let approvals = 0;
  const write = fixture({
    name: "write_file",
    description: "写入文件",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    effects: ["write"],
    idempotency: "unknown",
    capability: {
      risk: "R1",
      readOnly: false,
      resources: [{ kind: "workspace_path", argument: "path", access: "write" }],
    },
    execute: async () => { executions += 1; return "written"; },
  }, { policy: new WorkspacePolicy({}, { profile, allowElevation: false }), workspace: "/tmp" });

  const writeResult = await write.host.execute({ id: "auto-write", name: "write_file", arguments: { path: "src/a.js" } }, {
    session: write.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(writeResult.status, "completed");
  assert.equal(approvals, 0);

  const shell = fixture({
    name: "run_shell",
    description: "执行 Shell",
    parameters: objectSchema({ command: { type: "string" } }, ["command"]),
    effects: ["execute"],
    idempotency: "unknown",
    capability: {
      risk: "R2",
      readOnly: false,
      resources: [
        { kind: "workspace", access: "execute" },
        { kind: "shell_command", argument: "command", access: "execute" },
      ],
    },
    execute: async () => { executions += 1; return "tests passed"; },
  }, { policy: new WorkspacePolicy({}, { profile, allowElevation: false }), workspace: "/tmp" });
  const shellResult = await shell.host.execute({ id: "auto-shell", name: "run_shell", arguments: { command: "npm test" } }, {
    session: shell.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(shellResult.status, "completed");
  assert.equal(approvals, 0);
  assert.equal(executions, 2);
  const authorization = shell.session.state.events.find((event) => event.type === "tool.authorization_decided");
  assert.equal(authorization.profile, "workspace-auto");
  assert.equal(authorization.ruleId, "profile.workspace-auto.sandboxed_shell");
  assert.equal(authorization.explanation.category, "sandboxed_shell");
});

test("workspace-auto 对网络 Shell 要求审批，Workspace allow 不能提权", async () => {
  const profile = createPermissionProfile({ name: "workspace-auto", workspace: "/tmp", executionType: "native" });
  const policy = new WorkspacePolicy({
    rules: [{ id: "workspace-tries-allow-curl", tools: ["run_shell"], decision: "allow" }],
  }, { profile, allowElevation: false });
  let executions = 0;
  let approvals = 0;
  const { host, session } = fixture({
    name: "run_shell",
    description: "执行 Shell",
    parameters: objectSchema({ command: { type: "string" } }, ["command"]),
    effects: ["execute"],
    idempotency: "unknown",
    capability: {
      risk: "R2",
      readOnly: false,
      resources: [
        { kind: "workspace", access: "execute" },
        { kind: "shell_command", argument: "command", access: "execute" },
      ],
    },
    execute: async () => { executions += 1; return "不应执行"; },
  }, { policy, workspace: "/tmp" });

  const result = await host.execute({ id: "curl-approval", name: "run_shell", arguments: { command: "curl https://example.com" } }, {
    session,
    requestApproval: async (_call, description) => {
      approvals += 1;
      assert.match(description, /网络、依赖安装或远程发布/);
      return false;
    },
  });
  assert.equal(result.status, "denied");
  assert.equal(approvals, 1);
  assert.equal(executions, 0);
  const authorization = session.state.events.find((event) => event.type === "tool.authorization_decided");
  assert.equal(authorization.decision, "approval_required");
  assert.equal(authorization.explanation.elevationBlocked, true);
  assert.equal(authorization.explanation.workspaceRuleId, "workspace-tries-allow-curl");
  const requested = session.state.events.find((event) => event.type === "approval.requested");
  assert.deepEqual(requested.approvalScopes, ["once", "session"]);
});

test("沙箱内破坏性 Shell 可经 Session Grant 避免重复确认", async () => {
  const profile = createPermissionProfile({ name: "workspace-auto", workspace: "/tmp", executionType: "native" });
  const policy = new WorkspacePolicy({}, { profile, allowElevation: false });
  let executions = 0;
  let approvals = 0;
  const { host, session } = fixture({
    name: "run_shell",
    description: "执行 Shell",
    parameters: objectSchema({ command: { type: "string" } }, ["command"]),
    effects: ["execute"],
    idempotency: "unknown",
    capability: {
      risk: "R2",
      readOnly: false,
      resources: [
        { kind: "workspace", access: "execute" },
        { kind: "shell_command", argument: "command", access: "execute" },
      ],
    },
    execute: async () => { executions += 1; return "removed"; },
  }, { policy, workspace: "/tmp" });

  const first = await host.execute({ id: "rm-first", name: "run_shell", arguments: { command: "rm -rf build" } }, {
    session,
    requestApproval: async () => {
      approvals += 1;
      return { approved: true, scope: "session" };
    },
  });
  const second = await host.execute({ id: "rm-second", name: "run_shell", arguments: { command: "rm -rf build" } }, {
    session,
    requestApproval: async () => {
      approvals += 1;
      return false;
    },
  });

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(executions, 2);
  assert.equal(approvals, 1);
  const decisions = session.state.events.filter((event) => event.type === "tool.authorization_decided");
  assert.equal(decisions[0].explanation.category, "workspace_destructive");
  assert.equal(decisions[1].grantScope, "session");
});

test("workspace-untrusted 自动编辑但只自动执行明确只读 Shell", async () => {
  const profile = createPermissionProfile({ name: "workspace-untrusted", workspace: "/tmp", executionType: "native" });
  const policy = new WorkspacePolicy({}, { profile, allowElevation: false });
  let writes = 0;
  let shellExecutions = 0;
  let approvals = 0;
  const write = fixture({
    name: "write_file",
    description: "写入文件",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    effects: ["write"],
    idempotency: "unknown",
    capability: {
      risk: "R1",
      readOnly: false,
      resources: [{ kind: "workspace_path", argument: "path", access: "write" }],
    },
    execute: async () => { writes += 1; return "written"; },
  }, { policy, workspace: "/tmp" });
  const written = await write.host.execute({ id: "untrusted-write", name: "write_file", arguments: { path: "src/a.js" } }, {
    session: write.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(written.status, "completed");
  assert.equal(writes, 1);

  const shellTool = {
    name: "run_shell",
    description: "执行 Shell",
    parameters: objectSchema({ command: { type: "string" } }, ["command"]),
    effects: ["execute"],
    idempotency: "unknown",
    capability: {
      risk: "R2",
      readOnly: false,
      resources: [
        { kind: "workspace", access: "execute" },
        { kind: "shell_command", argument: "command", access: "execute" },
      ],
    },
    execute: async () => { shellExecutions += 1; return "ok"; },
  };
  const safe = fixture(shellTool, { policy, workspace: "/tmp" });
  const safeResult = await safe.host.execute({ id: "untrusted-status", name: "run_shell", arguments: { command: "git status --short" } }, {
    session: safe.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(safeResult.status, "completed");

  const build = fixture(shellTool, { policy, workspace: "/tmp" });
  const buildResult = await build.host.execute({ id: "untrusted-test", name: "run_shell", arguments: { command: "npm test" } }, {
    session: build.session,
    requestApproval: async () => { approvals += 1; return false; },
  });
  assert.equal(buildResult.status, "denied");
  assert.equal(shellExecutions, 1);
  assert.equal(approvals, 1);
});

test("read-only 隐藏写能力，且 Workspace allow 与旧 Grant 都不能提权", async () => {
  const profile = createPermissionProfile({ name: "read-only", workspace: "/tmp", executionType: "native" });
  const policy = new WorkspacePolicy({
    rules: [{ id: "workspace-allow-write", tools: ["write_file"], decision: "allow" }],
  }, { profile, allowElevation: false });
  let executions = 0;
  let approvals = 0;
  const tool = {
    name: "write_file",
    description: "写文件",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    effects: ["write"],
    idempotency: "unknown",
    capability: {
      risk: "R1",
      readOnly: false,
      resources: [{ kind: "workspace_path", argument: "path", access: "write" }],
    },
    execute: async () => { executions += 1; return "不应执行"; },
  };
  const { host, session } = fixture(tool, { policy, workspace: "/tmp" });
  assert.deepEqual(host.schemas(), []);
  const call = { id: "read-only-write", name: tool.name, arguments: { path: "src/a.js" } };
  const denied = policy.authorize({
    definition: { ...tool, adapter: "native", capability: tool.capability },
    call,
    state: session.state,
    argsHash: "args",
  });
  const grant = createSessionGrant({
    sessionId: session.id,
    workspace: session.state.workspace,
    tool: tool.name,
    capabilityHash: denied.capabilityHash,
    policyVersion: denied.policyVersion,
    resources: denied.resources,
  });
  await issueSessionGrant(session, grant);

  const result = await host.execute(call, {
    session,
    requestApproval: async () => { approvals += 1; return true; },
  });
  assert.equal(result.status, "policy_denied");
  assert.equal(approvals, 0);
  assert.equal(executions, 0);
  assert.equal(session.state.events.findLast((event) => event.type === "tool.authorization_decided").ruleId, "profile.read-only.mutation_deny");
});

function fixture(tool, { policy = new WorkspacePolicy(), workspace = "/tmp", sessionId, projectGrantStore } = {}) {
  const registry = {
    get: (name) => name === tool.name ? tool : null,
    schemas: () => [{
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }],
  };
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace, id: sessionId }),
    reducer: reduceSession,
  });
  return { host: new ToolHost({ registry, policy, projectGrantStore }), session, policy };
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
