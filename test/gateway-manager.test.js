import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeNamedAgentProfiles } from "../src/core/named-agent-profiles.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";
import {
  createProjectGrant,
  createSessionGrant,
  issueSessionGrant,
} from "../src/tools/authorization.js";
import { ProjectGrantStore } from "../src/tools/project-grant-store.js";

test("Gateway runtimeInfo 暴露当前 Model Context 预算", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-context-window-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "context-window-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
    maxInputTokens: 1_000_000,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  assert.equal(manager.runtimeInfo().runtime.maxInputTokens, 1_000_000);
});

test("Gateway 让具名 Agent Profile 使用各自的 Model Context 预算", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-profile-context-window-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const provider = { name: "profile-context-provider", complete: async () => ({ text: "完成", toolCalls: [] }) };
  const toolHost = { schemas: () => [], execute: async () => { throw new Error("不应执行"); } };
  const agentProfiles = normalizeNamedAgentProfiles({
    large: { provider: { contextWindowTokens: 1_000_000 } },
  }, {
    defaultProvider: {
      type: "demo",
      apiKey: null,
      baseUrl: null,
      model: "offline-demo",
      contextWindowTokens: 32_000,
    },
  });
  const manager = new GatewaySessionManager({
    workspace,
    provider,
    providerDescriptor: {
      name: provider.name,
      adapter: "demo",
      model: "offline-demo",
      contextWindowTokens: 32_000,
    },
    agentProfiles,
    tools: { schemas: () => [], get: () => null },
    permissionToolHosts: { "workspace-auto": toolHost },
    defaultPermissionProfile: "workspace-auto",
    systemPrompt: () => "test",
    store,
    maxInputTokens: 32_000,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const session = await manager.create({ agentProfileId: "large" });
  await manager.sendMessage(session.id, "只回复完成");
  await waitFor(async () => (await manager.get(session.id)).phase === "completed");

  const restored = store.load(session.id);
  const contextPlan = restored.events.findLast((event) => event.type === "model.context_prepared");
  assert.equal(contextPlan.maxInputTokens, 1_000_000);
  const profile = manager.runtimeInfo().agentProfiles.profiles.find((item) => item.id === "large");
  assert.equal(profile.maxInputTokens, 1_000_000);
  assert.equal(profile.provider.contextWindowTokens, 1_000_000);
});

test("Gateway 可持久化安全的自定义 Session Display Title", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-title-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "title-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const session = await manager.create();
  const renamed = await manager.setDisplayTitle(session.id, "  本地架构复盘  ");
  assert.equal(renamed.displayTitle, "本地架构复盘");
  assert.equal(manager.list()[0].title, "本地架构复盘");

  const protectedTitle = await manager.setDisplayTitle(session.id, "连接 root@192.168.1.8");
  assert.equal(protectedTitle.displayTitle, "受保护任务");
  assert.ok(protectedTitle.events.some((event) => event.type === "session.display_title_changed"));
  const durableTitleEvent = store.listSessionEvents(session.id).findLast((event) => event.type === "SESSION_DISPLAY_TITLE_CHANGED");
  assert.equal(JSON.stringify(durableTitleEvent).includes("192.168.1.8"), false);
});

test("关闭 Gateway 会取消仍在运行的任务", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const provider = {
    name: "waiting-provider",
    complete: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  };
  const manager = new GatewaySessionManager({
    workspace,
    provider,
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  const session = await manager.create();
  await manager.sendMessage(session.id, "保持运行");

  await manager.close();

  assert.equal((await manager.get(session.id)).phase, "cancelled");
  assert.equal((await manager.get(session.id)).lastError, "Gateway 正在关闭");
});

test("Gateway 可在模型运行中由用户显式打断任务", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-cancel-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: {
      name: "interruptible-provider",
      complete: async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const session = await manager.create();
  await manager.sendMessage(session.id, "开始长任务");

  await manager.cancel(session.id);
  await waitFor(async () => (await manager.get(session.id)).phase === "cancelled");

  const cancelled = await manager.get(session.id);
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.lastError, "用户通过 Gateway 取消了任务");
  await assert.rejects(manager.cancel(session.id), /当前没有正在运行/);
});

test("Gateway 可按 Session 返回不含正文的确定性诊断报告", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-evaluation-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: {
      name: "evaluation-provider",
      complete: async () => ({
        text: "私密回答正文不应进入诊断",
        toolCalls: [],
        usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      }),
    },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "私密 System Prompt",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const session = await manager.create();
  await manager.sendMessage(session.id, "私密用户任务");
  await waitFor(async () => (await manager.get(session.id)).phase === "completed");
  const report = await manager.evaluate(session.id);

  assert.equal(report.status, "healthy");
  assert.equal(report.metrics.totalTokens, 10);
  assert.ok(report.cursor > 0);
  assert.equal(JSON.stringify(report).includes("私密"), false);
});

test("Gateway 审批只接受当前卡片公开的 Grant scope", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-approval-scope-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "approval-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const state = await manager.create();
  const entry = manager.sessions.get(state.id);
  let resolved;
  entry.approval = {
    call: { id: "approval-scope-call" },
    scopes: ["once", "session"],
    resolve: (value) => { resolved = value; },
  };

  await assert.rejects(
    manager.decideApproval(state.id, "approval-scope-call", true, "project"),
    (error) => error.status === 400 && /不支持授权范围/.test(error.message),
  );
  assert.ok(entry.approval);
  await manager.decideApproval(state.id, "approval-scope-call", true, "session");
  assert.deepEqual(resolved, { approved: true, scope: "session" });
});

test("Gateway 只列出可用 Grant，并按真实 scope 撤销", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-project-grant-"));
  const projectGrantStore = new ProjectGrantStore(path.join(workspace, "private", "project-grants.db"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "grant-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    projectGrantStore,
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    projectGrantStore.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const state = await manager.create();
  const entry = manager.sessions.get(state.id);
  const sessionGrant = createSessionGrant({
    id: "session-grant-active",
    sessionId: state.id,
    workspace,
    tool: "write_file",
    capabilityHash: "cap-session",
    policyVersion: "policy-session",
    resources: [{ kind: "workspace_path", value: "notes/a.md", access: "write" }],
  });
  await issueSessionGrant(entry.session, sessionGrant);
  const consumedGrant = createSessionGrant({
    id: "once-grant-consumed",
    sessionId: state.id,
    workspace,
    tool: "run_shell",
    capabilityHash: "cap-once",
    policyVersion: "policy-once",
    resources: [{ kind: "shell_command", value: "npm test", access: "execute" }],
    callId: "once-call",
    argsHash: "once-args",
  });
  await issueSessionGrant(entry.session, consumedGrant);
  await entry.session.dispatch({ type: "TOOL_GRANT_CONSUMED", grantId: consumedGrant.id, callId: "once-call" });
  const grant = createProjectGrant({
    workspace,
    tool: "run_shell",
    capabilityHash: "cap",
    policyVersion: "policy",
    resources: [{ kind: "shell_command", value: "npm test", access: "execute" }],
  });
  projectGrantStore.issue(grant);
  const listed = await manager.listGrants(state.id);
  assert.deepEqual(listed.session.map((item) => item.id), [sessionGrant.id]);
  assert.equal(listed.project[0].id, grant.id);

  await assert.rejects(
    manager.revokeGrant(state.id, sessionGrant.id, "project", "错误 scope"),
    (error) => error.status === 404,
  );
  await assert.rejects(
    manager.revokeGrant(state.id, grant.id, "session", "错误 scope"),
    (error) => error.status === 404,
  );

  const afterSessionRevoke = await manager.revokeGrant(state.id, sessionGrant.id, "session", "测试撤销 Session Grant");
  assert.deepEqual(afterSessionRevoke.session, []);
  assert.ok((await manager.get(state.id)).events.some((event) => event.type === "tool.grant_revoked"));

  const grants = await manager.revokeGrant(state.id, grant.id, "project", "测试撤销");
  assert.deepEqual(grants.project, []);
  assert.ok((await manager.get(state.id)).events.some((event) => event.type === "tool.project_grant_revoked"));
});

test("Gateway 从指定游标补发事件后继续推送实时事件", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-events-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: {
      name: "instant-provider",
      complete: async () => ({ text: "完成", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
    },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const session = await manager.create();
  const events = [];
  const unsubscribe = await manager.subscribeEvents(session.id, (event) => events.push(event), { after: 1 });
  await manager.sendMessage(session.id, "执行");
  await waitFor(() => events.some((event) => event.type === "COMPLETED"));
  unsubscribe();

  assert.equal(events[0].cursor, 2);
  assert.ok(events.every((event, index) => index === 0 || event.cursor > events[index - 1].cursor));
  assert.equal(await manager.cursor(session.id), events.at(-1).cursor);
});

test("Gateway 可以导出 journal 并从指定 cursor 创建分支", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-branch-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "branch-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const parent = await manager.create();
  const archive = await manager.exportSession(parent.id);
  const child = await manager.branch(parent.id, { cursor: 1 });

  assert.equal(archive.format, "nexus.session-journal");
  assert.equal(archive.session.cursor, 1);
  assert.equal(child.lineage.parentSessionId, parent.id);
  assert.equal(child.lineage.parentCursor, 1);
  await assert.rejects(manager.branch(parent.id, { cursor: 2 }), /cursor 必须是/);
});

test("Gateway 可导入 journal，并把存储错误映射为客户端错误", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-import-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "import-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const source = await manager.create();
  const archive = await manager.exportSession(source.id);
  const imported = await manager.importSession(archive, { id: "session-gateway-imported" });

  assert.equal(imported.id, "session-gateway-imported");
  assert.equal(imported.workspace, workspace);
  await assert.rejects(
    manager.importSession(archive, { id: imported.id }),
    (error) => error.status === 409 && /会话已存在/.test(error.message),
  );
  archive.events[0].baseline.provider = "tampered";
  await assert.rejects(
    manager.importSession(archive, { id: "session-invalid-import" }),
    (error) => error.status === 400 && /checksum/.test(error.message),
  );
});

test("Gateway 可查看、验证来源并软删除长期记忆", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-memory-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "memory-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const record = await manager.addMemory("偏好深色主题", ["preference"]);
  assert.equal((await manager.listMemories("深色"))[0].id, record.id);
  const verification = await manager.verifyMemory(record.id);
  assert.equal(verification.record.provenance.origin, "user_explicit");
  assert.equal(verification.events[0].type, "memory.added");

  await manager.deleteMemory(record.id, "用户修改偏好");
  assert.deepEqual(await manager.listMemories("深色"), []);
  assert.equal((await manager.verifyMemory(record.id)).record.status, "deleted");
  await assert.rejects(manager.deleteMemory(record.id), (error) => error.status === 404);
});

test("Gateway 暴露 Memory mutation retry、discard 与 resolve API", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-mutation-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "mutation-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const state = await manager.create();
  const session = manager.sessions.get(state.id).session;
  const mutation = (id, content) => ({
    id,
    operation: "add",
    candidate: { content },
    scope: session.state.memoryScope,
    provenance: { origin: "user_explicit" },
  });

  const retry = mutation("gateway-retry", "Gateway retry fact");
  await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: retry });
  await session.dispatch({
    type: "MEMORY_MUTATION_FAILED",
    mutationId: retry.id,
    error: "temporary",
    retryable: true,
  });
  const retried = await manager.retryMemoryMutation(state.id, retry.id);
  assert.deepEqual(retried.memoryMutationIssues, []);
  assert.equal((await manager.listMemories("Gateway retry"))[0].content, "Gateway retry fact");

  const discarded = mutation("gateway-discard", "Gateway discard fact");
  await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: discarded });
  assert.deepEqual((await manager.discardMemoryMutation(state.id, discarded.id, "用户放弃")).pendingMemoryMutations, []);

  const resolved = mutation("gateway-resolve", "Gateway resolve fact");
  await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: resolved });
  await assert.rejects(
    manager.resolveMemoryMutation(state.id, resolved.id, "bypass"),
    (error) => error.status === 404 && /待处理/.test(error.message),
  );
  await session.dispatch({
    type: "MEMORY_MUTATION_MANUAL_REQUIRED",
    mutationId: resolved.id,
    error: "人工确认",
    retryable: true,
    outcome: "safe_to_retry",
  });
  const resolvedState = await manager.resolveMemoryMutation(state.id, resolved.id, "external-memory");
  assert.deepEqual(resolvedState.pendingMemoryMutations, []);
  assert.ok(resolvedState.events.some((event) => (
    event.type === "memory.mutation_applied" && event.memoryId === "external-memory"
  )));
});

test("Gateway 可列出、批准和拒绝候选记忆", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-candidate-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "candidate-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const state = await manager.create();
  const access = {
    scope: state.memoryScope,
    provenance: { origin: "auto_extract", sessionId: state.id, sourceCursor: 1, model: "candidate-provider" },
  };
  const approve = await store.memory.add({ content: "用户偏好精简界面", status: "candidate" }, access);
  const reject = await store.memory.add({ content: "可能不准确的事实", status: "candidate" }, access);

  assert.deepEqual((await manager.listMemoryCandidates()).map((item) => item.id).sort(), [approve.id, reject.id].sort());
  await manager.approveMemoryCandidate(state.id, approve.id);
  await manager.rejectMemoryCandidate(state.id, reject.id, "内容不准确");

  assert.equal((await manager.listMemories("精简界面"))[0].status, "active");
  assert.deepEqual(await manager.listMemoryCandidates(), []);
  assert.equal((await manager.verifyMemory(reject.id)).record.status, "deleted");
  const finalState = await manager.get(state.id);
  assert.ok(finalState.events.some((event) => event.type === "memory.candidate_approved"));
  assert.ok(finalState.events.some((event) => event.type === "memory.candidate_rejected"));
});

test("Gateway 通过 Session durable outbox 固定和取消固定长期记忆", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-pinned-memory-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "pinned-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const session = await manager.create();
  const memory = await manager.addMemory("始终使用中文回答");

  const pinned = await manager.setMemoryPinned(session.id, memory.id, true);
  assert.equal(pinned.pinned, true);
  assert.equal((await manager.listMemories())[0].id, memory.id);
  assert.equal((await manager.listSessionMemories(session.id))[0].pinned, true);
  let state = await manager.get(session.id);
  assert.ok(state.events.some((event) => event.type === "memory.pin_changed" && event.pinned === true));
  assert.ok(state.events.some((event) => event.type === "memory.mutation_applied"));

  const unpinned = await manager.setMemoryPinned(session.id, memory.id, false);
  assert.equal(unpinned.pinned, false);
  state = await manager.get(session.id);
  assert.equal(state.events.filter((event) => event.type === "memory.pin_changed").length, 2);
  await assert.rejects(manager.setMemoryPinned(session.id, memory.id, "yes"), /pinned 必须是布尔值/);
});

test("Gateway 权限菜单按会话持久切换且运行中禁止变化", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-permission-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const host = { schemas: () => [], execute: async () => { throw new Error("不应执行"); } };
  const provider = {
    name: "permission-provider",
    complete: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  };
  const manager = new GatewaySessionManager({
    workspace,
    provider,
    tools: { schemas: () => [], get: () => null },
    permissionToolHosts: { "read-only": host, "approval-required": host, "workspace-confirm": host, "workspace-untrusted": host, "workspace-auto": host },
    defaultPermissionProfile: "workspace-auto",
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const created = await manager.create({ permissionProfile: "approval-required" });
  assert.equal(created.permissionProfile, "approval-required");
  assert.equal(manager.runtimeInfo().permission.modes.find((mode) => mode.id === "read-only").available, true);
  assert.equal(manager.runtimeInfo().permission.modes.find((mode) => mode.id === "workspace-confirm").available, true);
  assert.equal(manager.runtimeInfo().permission.modes.find((mode) => mode.id === "workspace-untrusted").available, true);
  assert.equal(manager.runtimeInfo().permission.modes.find((mode) => mode.id === "danger-full-access").available, false);
  const cautious = await manager.setPermissionProfile(created.id, "workspace-untrusted");
  assert.equal(cautious.permissionProfile, "workspace-untrusted");
  const confirm = await manager.setPermissionProfile(created.id, "workspace-confirm");
  assert.equal(confirm.permissionProfile, "workspace-confirm");
  const readOnly = await manager.setPermissionProfile(created.id, "read-only");
  assert.equal(readOnly.permissionProfile, "read-only");
  const changed = await manager.setPermissionProfile(created.id, "workspace-auto");
  assert.equal(changed.permissionProfile, "workspace-auto");
  assert.equal(store.load(created.id).permissionProfile, "workspace-auto");
  assert.ok(changed.events.some((event) => event.type === "permission.profile_changed"));
  await assert.rejects(manager.setPermissionProfile(created.id, "danger-full-access"), /权限档位不可用/);

  await manager.sendMessage(created.id, "保持运行");
  await assert.rejects(manager.setPermissionProfile(created.id, "approval-required"), /运行期间不能切换/);
  await manager.cancel(created.id);
});

test("Gateway 完全访问要求可用 trusted-local Host 和显式二次确认", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-danger-permission-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const host = { schemas: () => [], execute: async () => { throw new Error("不应执行"); } };
  const options = {
    workspace,
    provider: { name: "danger-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    permissionToolHosts: {
      "approval-required": host,
      "workspace-auto": host,
      "danger-full-access": host,
    },
    defaultPermissionProfile: "workspace-auto",
    systemPrompt: () => "test",
    store,
  };
  assert.throws(
    () => new GatewaySessionManager({ ...options, executionInfo: { id: "native-sandbox", isolation: "macos-seatbelt" } }),
    /只能在 trusted-local Gateway/,
  );
  const manager = new GatewaySessionManager({
    ...options,
    executionInfo: { id: "local-workspace", isolation: "trusted-local" },
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  assert.equal(manager.runtimeInfo().permission.modes.find((mode) => mode.id === "danger-full-access").available, true);
  await assert.rejects(manager.create({ permissionProfile: "danger-full-access" }), /需要显式风险确认/);
  const session = await manager.create({
    permissionProfile: "danger-full-access",
    permissionConfirmation: "danger-full-access",
  });
  assert.equal(session.permissionProfile, "danger-full-access");

  await manager.setPermissionProfile(session.id, "workspace-auto");
  await assert.rejects(manager.setPermissionProfile(session.id, "danger-full-access"), /需要显式风险确认/);
  const changed = await manager.setPermissionProfile(session.id, "danger-full-access", { confirmation: "danger-full-access" });
  assert.equal(changed.permissionProfile, "danger-full-access");
  const event = changed.events.findLast((item) => item.type === "permission.profile_changed");
  assert.equal(event.riskAcknowledged, true);
});

test("Gateway 恢复和导入危险会话时不会复用历史确认", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-danger-resume-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const host = { schemas: () => [], execute: async () => { throw new Error("不应执行"); } };
  const options = {
    workspace,
    provider: { name: "danger-resume-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    toolHost: host,
    permissionToolHosts: {
      "approval-required": host,
      "workspace-auto": host,
      "danger-full-access": host,
    },
    defaultPermissionProfile: "workspace-auto",
    executionInfo: { id: "local-workspace", isolation: "trusted-local" },
    systemPrompt: () => "test",
    store,
  };
  const sourceManager = new GatewaySessionManager(options);
  t.after(async () => {
    await sourceManager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const resumable = await sourceManager.create({
    permissionProfile: "danger-full-access",
    permissionConfirmation: "danger-full-access",
  });
  const explicitlyResumable = await sourceManager.create({
    permissionProfile: "danger-full-access",
    permissionConfirmation: "danger-full-access",
  });
  const archive = await sourceManager.exportSession(resumable.id);
  await sourceManager.close();

  const resumedManager = new GatewaySessionManager(options);
  t.after(() => resumedManager.close());
  const resumed = await resumedManager.create({ resume: resumable.id });
  assert.equal(resumed.permissionProfile, "workspace-auto");
  assert.ok(resumed.events.some((event) => (
    event.type === "permission.profile_downgraded"
    && event.reason === "resume_requires_confirmation"
  )));

  const explicitlyResumed = await resumedManager.create({
    resume: explicitlyResumable.id,
    permissionConfirmation: "danger-full-access",
  });
  assert.equal(explicitlyResumed.permissionProfile, "danger-full-access");

  const imported = await resumedManager.importSession(archive, { id: "session-danger-imported" });
  assert.equal(imported.permissionProfile, "workspace-auto");
  assert.ok(imported.events.some((event) => (
    event.type === "permission.profile_downgraded"
    && event.reason === "journal_import"
  )));
});

async function waitFor(predicate) {
  for (let index = 0; index < 50; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("等待事件超时");
}
