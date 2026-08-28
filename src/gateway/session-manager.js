// FOUNDATION — coordinates isolated Agent sessions for local HTTP/SSE clients.
import { randomUUID } from "node:crypto";
import { createDelegatedSession, createSession, reduceSession } from "../core/state.js";
import {
  assertAgentProfileSnapshot,
  createAgentProfileSnapshot,
  deriveAgentProfileSnapshot,
} from "../core/agent-profile.js";
import { appendAgentInstructions } from "../core/named-agent-profiles.js";
import { AgentRuntime } from "../core/agent.js";
import { AgentSession } from "../core/session.js";
import { assertMemoryInspection, assertMemoryInterface } from "../memory/interface.js";
import { assertArtifactStore } from "../artifacts/interface.js";
import { createModelMemoryExtractor, MemoryFlushPolicy } from "../memory/flush-policy.js";
import { createMemoryScope } from "../memory/scope.js";
import {
  discardMemoryMutation,
  executeMemoryMutation,
  reconcileMemoryOutbox,
  resolveMemoryMutation,
  retryMemoryMutation,
} from "../memory/outbox.js";
import { ToolHost } from "../tools/host.js";
import { PermissionToolHostRouter } from "../tools/permission-router.js";
import { revokeSessionGrant } from "../tools/authorization.js";

const PERMISSION_MODE_INFO = Object.freeze([
  Object.freeze({
    id: "read-only",
    label: "只读模式",
    description: "只读取和分析，禁止修改、联网和非只读命令",
    icon: "eye",
  }),
  Object.freeze({
    id: "workspace-confirm",
    label: "每次确认",
    description: "读取自动执行，写入和命令请求确认并可记住到本会话",
    icon: "hand",
  }),
  Object.freeze({
    id: "workspace-untrusted",
    label: "谨慎工作区",
    description: "自动编辑文件，Shell 仅自动执行明确只读检查",
    icon: "shield",
  }),
  Object.freeze({
    id: "workspace-auto",
    label: "帮我批准",
    description: "沙箱内安全操作自动执行，仅风险操作请求批准",
    icon: "auto",
  }),
  Object.freeze({
    id: "danger-full-access",
    label: "完全访问",
    description: "可不受限制访问互联网和宿主文件",
    icon: "warning",
    dangerous: true,
  }),
]);

export class GatewaySessionManager {
  constructor({ workspace, provider, providerDescriptor, agentProfile, agentProfiles, agentProviders, tools, toolHost, permissionToolHosts, defaultPermissionProfile, workspacePolicy, projectGrantStore = null, executionInfo = null, systemPrompt, store, memory = store?.memory, artifactStore = store?.artifacts, memoryScope, maxSteps, maxTokensPerTurn, memoryFlushPolicy }) {
    this.workspace = workspace;
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.store = store;
    this.memory = assertMemoryInterface(memory);
    this.artifactStore = artifactStore ? assertArtifactStore(artifactStore) : null;
    this.projectGrantStore = projectGrantStore;
    assertMemoryInspection(this.memory);
    this.defaultMemoryScope = createMemoryScope(memoryScope || { workspace });
    const fallbackHost = toolHost || new ToolHost({ registry: tools, policy: workspacePolicy, artifactStore });
    const hosts = permissionToolHosts || { [defaultPermissionProfile || workspacePolicy?.profile?.name || "approval-required"]: fallbackHost };
    if (Object.hasOwn(hosts, "danger-full-access") && executionInfo?.isolation !== "trusted-local") {
      throw new Error("danger-full-access Tool Host 只能在 trusted-local Gateway 中注册");
    }
    this.toolHost = new PermissionToolHostRouter({
      hosts,
      defaultProfile: defaultPermissionProfile || Object.keys(hosts)[0],
    });
    this.defaultPermissionProfile = this.toolHost.defaultProfile;
    this.safePermissionProfile = ["workspace-auto", "workspace-confirm", "approval-required"].find((profile) => this.toolHost.has(profile)) || null;
    if (this.toolHost.has("danger-full-access") && !this.safePermissionProfile) {
      throw new Error("启用 danger-full-access 时必须同时提供安全 Permission Profile");
    }
    this.executionInfo = executionInfo;
    this.maxSteps = maxSteps ?? Infinity;
    this.maxTokensPerTurn = maxTokensPerTurn ?? Infinity;
    const runtimeProfiles = createRuntimeAgentProfiles({
      catalog: agentProfiles,
      snapshot: agentProfile,
      providerClient: provider,
      providerDescriptor: providerDescriptor || {
        name: provider.name,
        adapter: provider.constructor?.name || "unknown",
        model: provider.model || provider.name,
        baseUrl: provider.baseUrl || null,
      },
      providerBindings: agentProviders,
      workspace,
      systemPrompt,
      toolSchemas: () => typeof tools?.schemas === "function" ? tools.schemas() : this.toolHost.schemas(),
      permission: inspectPermissionConfiguration(this.toolHost),
      execution: executionInfo,
      memoryScope: this.defaultMemoryScope,
      maxSteps: this.maxSteps,
      maxTokensPerTurn: this.maxTokensPerTurn,
    });
    this.defaultAgentProfileId = runtimeProfiles.defaultProfile;
    this.agentProfiles = new Map(runtimeProfiles.profiles.map((profile) => [profile.id, profile]));
    for (const profile of this.agentProfiles.values()) {
      profile.memoryFlushPolicy = memoryFlushPolicy || new MemoryFlushPolicy({
        memory: this.memory,
        extractCandidates: createModelMemoryExtractor(profile.provider),
      });
    }
    this.agentProfile = this.#currentAgentProfile(this.defaultAgentProfileId);
    this.sessions = new Map();
  }

  async create({ resume, agentProfileId, permissionProfile, permissionConfirmation } = {}) {
    let state = resume === "latest"
      ? this.store.latest(this.workspace)
      : resume
        ? this.store.load(resume)
        : null;

    if (resume && (!state || state.workspace !== this.workspace)) {
      throw new GatewayError(404, resume === "latest" ? "没有可恢复的会话" : `未找到会话：${resume}`);
    }

    const existing = state ? this.sessions.get(state.id) : null;
    if (existing) {
      assertResumeAgentProfile(existing.state, agentProfileId);
      return existing.state;
    }

    const resumed = Boolean(state);
    const runtimeProfile = this.#selectAgentProfile(state, agentProfileId);
    const effectiveBudgets = effectiveSessionBudgets(state, runtimeProfile);
    const runtimeAgentProfile = state?.lineage?.kind === "delegation"
      ? deriveAgentProfileSnapshot(runtimeProfile.snapshot(), { budgets: effectiveBudgets })
      : runtimeProfile.snapshot();
    const selectedProfile = resumedProfile(state, permissionProfile, runtimeProfile.permissionProfile);
    const downgradeDangerousResume = resumed
      && selectedProfile === "danger-full-access"
      && permissionConfirmation !== "danger-full-access";
    const activeProfile = downgradeDangerousResume ? this.safePermissionProfile : selectedProfile;
    this.#assertPermissionProfile(activeProfile, permissionConfirmation);
    state ||= createSession({
      provider: runtimeProfile.provider.name,
      workspace: this.workspace,
      memoryScope: runtimeProfile.memoryScope,
      permissionProfile: activeProfile,
      agentProfile: runtimeAgentProfile,
    });
    const session = new AgentSession({ state, reducer: reduceSession, journal: this.store });
    if (downgradeDangerousResume) {
      await session.dispatch({
        type: "PERMISSION_PROFILE_DOWNGRADED",
        profile: activeProfile,
        reason: "resume_requires_confirmation",
      });
    }

    const entry = this.#registerSession(session, {
      maxSteps: effectiveBudgets.maxSteps,
      maxTokensPerTurn: effectiveBudgets.maxTokensPerTurn,
    }, runtimeProfile);
    if (resumed) {
      await reconcileMemoryOutbox({ session, memory: this.memory });
      await session.dispatch({
        type: "RESUMED",
        provider: runtimeProfile.provider.name,
        workspace: this.workspace,
        agentProfile: runtimeAgentProfile,
        profileReason: "gateway_resume",
      });
    }
    return session.state;
  }

  list() {
    return this.store.list(this.workspace);
  }

  runtimeInfo() {
    const profile = this.#currentAgentProfile(this.defaultAgentProfileId);
    return {
      execution: this.executionInfo,
      runtime: {
        maxSteps: this.maxSteps === Infinity ? "unlimited" : this.maxSteps,
        maxTokensPerTurn: this.maxTokensPerTurn === Infinity ? "unlimited" : this.maxTokensPerTurn,
      },
      agentProfile: {
        id: profile.id,
        version: profile.version,
        provider: profile.provider,
        toolCount: profile.toolset.names.length,
      },
      agentProfiles: {
        defaultProfile: this.defaultAgentProfileId,
        profiles: [...this.agentProfiles.values()].map((item) => {
          const snapshot = item.snapshot();
          return {
            id: item.id,
            label: item.label,
            description: item.description,
            permissionProfile: item.permissionProfile,
            maxSteps: durableLimit(item.maxSteps),
            maxTokensPerTurn: durableLimit(item.maxTokensPerTurn),
            provider: snapshot.provider,
            version: snapshot.version,
          };
        }),
      },
      permission: {
        defaultProfile: this.defaultPermissionProfile,
        modes: PERMISSION_MODE_INFO.map((mode) => ({
          ...mode,
          available: this.toolHost.has(mode.id),
          ...(!this.toolHost.has(mode.id) ? { unavailableReason: mode.dangerous ? "完全访问仅在显式 --execution=local 的 Gateway 中可用" : "当前运行环境未启用" } : {}),
        })),
      },
    };
  }

  async setPermissionProfile(id, profile, { confirmation } = {}) {
    this.#assertPermissionProfile(profile, confirmation);
    const entry = await this.ensureLoaded(id);
    if (entry.run) throw new GatewayError(409, "会话运行期间不能切换权限档位");
    if (entry.state.permissionProfile === profile) return entry.state;
    await entry.session.dispatch({
      type: "PERMISSION_PROFILE_CHANGED",
      profile,
      riskAcknowledged: profile === "danger-full-access",
    });
    return entry.state;
  }

  async get(id) {
    const entry = await this.ensureLoaded(id);
    return entry.state;
  }

  async listArtifacts(id) {
    await this.ensureLoaded(id);
    if (!this.artifactStore) return [];
    return this.artifactStore.list({ sessionId: id });
  }

  async getArtifact(id, artifactId) {
    await this.ensureLoaded(id);
    const artifact = this.artifactStore
      ? await this.artifactStore.get(artifactId, { sessionId: id })
      : null;
    if (!artifact) throw new GatewayError(404, "Artifact 不存在或不属于当前 Session");
    return artifact;
  }

  async view(id) {
    const entry = await this.ensureLoaded(id);
    return { state: entry.state, cursor: entry.session.cursor };
  }

  async branch(id, { cursor } = {}) {
    const entry = await this.ensureLoaded(id);
    const parentCursor = cursor ?? entry.session.cursor;
    if (!Number.isInteger(parentCursor) || parentCursor < 1 || parentCursor > entry.session.cursor) {
      throw new GatewayError(400, `cursor 必须是 1 到 ${entry.session.cursor} 的整数`);
    }
    return this.store.branchSession(id, {
      cursor: parentCursor,
      provider: this.#runtimeProfileForState(entry.state).provider.name,
      workspace: this.workspace,
      agentProfile: this.#runtimeProfileForState(entry.state).snapshot(),
    });
  }

  async exportSession(id) {
    await this.ensureLoaded(id);
    return this.store.exportJournal(id);
  }

  async importSession(archive, { id } = {}) {
    try {
      const imported = this.store.importJournal(archive, { id, workspace: this.workspace });
      return await this.#downgradeImportedDangerousSession(imported);
    } catch (error) {
      if (/会话已存在/.test(error.message)) throw new GatewayError(409, error.message);
      throw new GatewayError(400, error.message);
    }
  }

  async sendMessage(id, content) {
    if (typeof content !== "string" || !content.trim()) {
      throw new GatewayError(400, "content 必须是非空字符串");
    }
    const entry = await this.ensureLoaded(id);
    if (entry.run) throw new GatewayError(409, "该会话已有正在运行的任务");

    this.#startRun(entry, content.trim());
    return entry.state;
  }

  async delegate(id, specification, { signal } = {}) {
    const parent = await this.ensureLoaded(id);
    if (parent.state.lineage?.kind === "delegation") {
      throw new GatewayError(409, "当前只支持单层委派，Child Session 不能继续创建 Child");
    }
    if (parent.children.size) throw new GatewayError(409, "当前 Session 已有正在运行的 Child");
    if (signal?.aborted) throw signal.reason || new Error("委派已取消");
    const input = normalizeDelegationSpec(specification, {
      maxSteps: parent.runtime.maxSteps,
      maxTokensPerTurn: parent.runtime.maxTokensPerTurn,
    });
    const delegationId = `delegation-${randomUUID().slice(0, 12)}`;
    const childSessionId = `session-${randomUUID().slice(0, 12)}`;
    await parent.session.dispatch({
      type: "DELEGATION_REQUESTED",
      delegation: {
        id: delegationId,
        childSessionId,
        objective: input.objective,
        contextItems: input.context.length,
        context: input.context,
        budget: input.durableBudget,
      },
    });

    let child;
    const delegatedAt = new Date().toISOString();
    try {
      const state = createDelegatedSession(parent.state, {
        id: childSessionId,
        delegationId,
        parentCursor: parent.session.cursor,
        provider: this.#runtimeProfileForState(parent.state).provider.name,
        workspace: this.workspace,
        agentProfile: deriveAgentProfileSnapshot(parent.state.agentProfile, {
          budgets: input.runtimeBudget,
        }),
        delegatedAt,
      });
      const session = new AgentSession({ state, reducer: reduceSession, journal: this.store });
      child = this.#registerSession(session, input.runtimeBudget, this.#runtimeProfileForState(parent.state));
      parent.children.add(childSessionId);
      const onAbort = () => this.#cancelEntry(child, signal.reason?.message || "Parent Session 已取消");
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const completed = await this.#startRun(child, delegatedPrompt(input), {
          objective: input.objective,
          approvalParent: parent,
          delegationId,
        });
        const result = lastAssistantText(completed);
        if (completed.phase === "completed") {
          await parent.session.dispatch({
            type: "DELEGATION_COMPLETED",
            delegationId,
            result,
            childCursor: child.session.cursor,
          });
          return `Child Session ${childSessionId} 已完成：\n${result || "（无文本结果）"}`;
        }
        const actionType = completed.phase === "cancelled" ? "DELEGATION_CANCELLED" : "DELEGATION_FAILED";
        const reason = completed.lastError || result || `Child Session ${completed.phase}`;
        await parent.session.dispatch({
          type: actionType,
          delegationId,
          result: reason,
          childCursor: child.session.cursor,
        });
        throw new Error(`Child Session ${childSessionId} ${completed.phase}：${reason}`);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      const current = parent.state.delegations?.find((item) => item.id === delegationId);
      if (current?.status === "running") {
        await parent.session.dispatch({
          type: signal?.aborted ? "DELEGATION_CANCELLED" : "DELEGATION_FAILED",
          delegationId,
          result: error.message,
          childCursor: child?.session.cursor || null,
        });
      }
      throw error;
    } finally {
      parent.children.delete(childSessionId);
    }
  }

  async decideApproval(id, callId, approved, scope = "once") {
    if (typeof approved !== "boolean") throw new GatewayError(400, "approved 必须是布尔值");
    const entry = await this.ensureLoaded(id);
    if (!entry.approval || entry.approval.call.id !== callId) {
      throw new GatewayError(409, "该工具调用当前不在等待审批");
    }
    if (approved && !entry.approval.scopes.includes(scope)) {
      throw new GatewayError(400, `当前审批不支持授权范围：${scope}`);
    }
    const approval = entry.approval;
    const { resolve } = approval;
    entry.approval = null;
    approval.signal?.removeEventListener("abort", approval.onAbort);
    if (approval.delegated) {
      await entry.session.dispatch({
        type: "DELEGATION_APPROVAL_DECIDED",
        callId,
        approved,
        scope: approved ? scope : null,
      });
    }
    resolve(approved ? { approved: true, scope } : false);
    return entry.state;
  }

  async listGrants(id) {
    const entry = await this.ensureLoaded(id);
    const now = Date.now();
    const session = (entry.state.toolGrants || []).filter((grant) => (
      !grant.revokedAt && !grant.consumedAt && new Date(grant.expiresAt).getTime() > now
    ));
    const project = this.projectGrantStore?.list({ workspace: entry.state.workspace }) || [];
    return { session, project };
  }

  async revokeGrant(id, grantId, scope, reason = "用户通过 Gateway 撤销授权") {
    const entry = await this.ensureLoaded(id);
    if (entry.run) throw new GatewayError(409, "会话运行期间不能撤销授权");
    try {
      if (scope === "session" || scope === "once") {
        const now = Date.now();
        const grant = (entry.state.toolGrants || []).find((item) => (
          item.id === grantId
          && !item.revokedAt
          && !item.consumedAt
          && new Date(item.expiresAt).getTime() > now
          && (item.scope || (item.callId || item.argsHash ? "once" : "session")) === scope
        ));
        if (!grant) throw new GatewayError(404, `未找到当前会话的 ${scope} Grant：${grantId}`);
        await revokeSessionGrant(entry.session, grantId, reason);
      } else if (scope === "project") {
        if (!this.projectGrantStore) throw new GatewayError(400, "当前运行环境未配置 Project Grant Store");
        const grant = this.projectGrantStore.list({ workspace: entry.state.workspace }).find((item) => item.id === grantId);
        if (!grant) throw new GatewayError(404, `未找到当前项目的 Grant：${grantId}`);
        this.projectGrantStore.revoke(grantId, reason);
        await entry.session.dispatch({ type: "TOOL_PROJECT_GRANT_REVOKED", grantId, reason });
      } else {
        throw new GatewayError(400, `授权范围无效：${scope || "未指定"}`);
      }
      return await this.listGrants(id);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (/未找到/.test(error.message)) throw new GatewayError(404, error.message);
      throw error;
    }
  }

  async cancel(id) {
    const entry = await this.ensureLoaded(id);
    if (!entry.run && !entry.children.size) throw new GatewayError(409, "该会话当前没有正在运行的任务");
    this.#cancelEntry(entry, "用户通过 Gateway 取消了任务");
    return entry.state;
  }

  async retryMemoryMutation(id, mutationId) {
    const entry = await this.ensureLoaded(id);
    this.#assertMutationIdle(entry);
    try {
      await retryMemoryMutation({ session: entry.session, memory: this.memory, mutationId });
      return entry.state;
    } catch (error) {
      throw this.#mutationError(error);
    }
  }

  async discardMemoryMutation(id, mutationId, reason) {
    const entry = await this.ensureLoaded(id);
    this.#assertMutationIdle(entry);
    try {
      await discardMemoryMutation({ session: entry.session, mutationId, reason });
      return entry.state;
    } catch (error) {
      throw this.#mutationError(error);
    }
  }

  async resolveMemoryMutation(id, mutationId, memoryId = null) {
    const entry = await this.ensureLoaded(id);
    this.#assertMutationIdle(entry);
    try {
      await resolveMemoryMutation({ session: entry.session, mutationId, memoryId });
      return entry.state;
    } catch (error) {
      throw this.#mutationError(error);
    }
  }

  async listMemories(query = "") {
    return await this.memory.search(query, { scope: this.defaultMemoryScope }, { limit: 100 });
  }

  async listMemoryCandidates() {
    return await this.memory.search("", { scope: this.defaultMemoryScope }, {
      limit: 100,
      statuses: ["candidate"],
    });
  }

  async addMemory(content, tags = []) {
    if (typeof content !== "string" || !content.trim()) throw new GatewayError(400, "content 必须是非空字符串");
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) throw new GatewayError(400, "tags 必须是字符串数组");
    return await this.memory.add({ content, tags, kind: "fact", confidence: 1 }, {
      scope: this.defaultMemoryScope,
      provenance: { origin: "user_explicit", actor: this.defaultMemoryScope.userId },
    });
  }

  async deleteMemory(id, reason = "用户通过 Gateway 请求删除") {
    if (!await this.memory.delete(id, reason, {
      scope: this.defaultMemoryScope,
      provenance: { origin: "user_explicit", actor: this.defaultMemoryScope.userId },
    })) {
      throw new GatewayError(404, `未找到长期记忆：${id}`);
    }
  }

  async verifyMemory(id) {
    const verification = await this.memory.verify(id, { scope: this.defaultMemoryScope });
    if (!verification) throw new GatewayError(404, `未找到长期记忆：${id}`);
    return verification;
  }

  async approveMemoryCandidate(id, memoryId) {
    const entry = await this.ensureLoaded(id);
    this.#assertMutationIdle(entry);
    await this.#candidate(memoryId, entry.state.memoryScope);
    try {
      const record = await executeMemoryMutation({
        memory: this.memory,
        dispatch: (action) => entry.session.dispatch(action),
        mutation: {
          id: `${id}:memory-candidate:${memoryId}:approve`,
          operation: "update",
          memoryId,
          patch: { status: "active" },
          scope: entry.state.memoryScope,
          provenance: { origin: "user_explicit", actor: entry.state.memoryScope.userId },
        },
      });
      await entry.session.dispatch({ type: "MEMORY_CANDIDATE_APPROVED", memoryId });
      return record;
    } catch (error) {
      throw this.#mutationError(error);
    }
  }

  async rejectMemoryCandidate(id, memoryId, reason = "用户拒绝候选记忆") {
    const entry = await this.ensureLoaded(id);
    this.#assertMutationIdle(entry);
    await this.#candidate(memoryId, entry.state.memoryScope);
    try {
      const deleted = await executeMemoryMutation({
        memory: this.memory,
        dispatch: (action) => entry.session.dispatch(action),
        mutation: {
          id: `${id}:memory-candidate:${memoryId}:reject`,
          operation: "delete",
          memoryId,
          reason,
          scope: entry.state.memoryScope,
          provenance: { origin: "user_explicit", actor: entry.state.memoryScope.userId },
        },
      });
      await entry.session.dispatch({ type: "MEMORY_CANDIDATE_REJECTED", memoryId, reason });
      return deleted;
    } catch (error) {
      throw this.#mutationError(error);
    }
  }

  async subscribe(id, listener) {
    const entry = await this.ensureLoaded(id);
    entry.subscribers.add(listener);
    listener(entry.state);
    return () => entry.subscribers.delete(listener);
  }

  async subscribeEvents(id, listener, { after = 0 } = {}) {
    const entry = await this.ensureLoaded(id);
    return entry.session.subscribeEvents(listener, { after });
  }

  async cursor(id) {
    const entry = await this.ensureLoaded(id);
    return entry.session.cursor;
  }

  async close() {
    const runs = [];
    for (const entry of this.sessions.values()) {
      if (entry.run) {
        this.#cancelEntry(entry, "Gateway 正在关闭");
        runs.push(entry.run);
      }
    }
    await Promise.allSettled(runs);
  }

  async ensureLoaded(id) {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const stored = this.store.load(id);
    if (!stored || stored.workspace !== this.workspace) throw new GatewayError(404, `未找到会话：${id}`);
    await this.create({ resume: id });
    return this.sessions.get(id);
  }

  update(entry, state) {
    entry.state = state;
    for (const listener of entry.subscribers) listener(state);
  }

  #registerSession(session, { maxSteps, maxTokensPerTurn }, runtimeProfile = this.#runtimeProfileForState(session.state)) {
    const entry = {
      state: session.state,
      session,
      runtime: null,
      run: null,
      approval: null,
      children: new Set(),
      subscribers: new Set(),
    };
    entry.runtime = new AgentRuntime({
      session,
      provider: runtimeProfile.provider,
      toolHost: this.toolHost,
      systemPrompt: runtimeProfile.systemPrompt,
      retrieveMemory: (query, { signal } = {}) => this.memory.search(query, {
        scope: session.state.memoryScope,
        signal,
      }, { limit: 5 }),
      reconcile: ({ signal } = {}) => reconcileMemoryOutbox({ session, memory: this.memory, signal }),
      flushMemory: (input) => runtimeProfile.memoryFlushPolicy.flush(input),
      maxSteps,
      maxTokensPerTurn,
    });
    session.subscribe((next) => this.update(entry, next));
    this.sessions.set(session.id, entry);
    return entry;
  }

  #currentAgentProfile(id = this.defaultAgentProfileId) {
    const runtimeProfile = this.agentProfiles.get(id);
    if (!runtimeProfile) throw new GatewayError(400, `Agent Profile 不可用：${id}`);
    this.agentProfile = runtimeProfile.snapshot();
    return this.agentProfile;
  }

  #selectAgentProfile(state, requested) {
    assertResumeAgentProfile(state, requested);
    const id = state?.agentProfile?.id;
    if (id && this.agentProfiles.has(id)) return this.agentProfiles.get(id);
    if (id && id !== "legacy-default") {
      throw new GatewayError(409, `会话绑定的 Agent Profile 已不可用：${id}`);
    }
    const selected = this.agentProfiles.get(requested || this.defaultAgentProfileId);
    if (!selected) throw new GatewayError(400, `Agent Profile 不可用：${requested}`);
    return selected;
  }

  #runtimeProfileForState(state) {
    return this.agentProfiles.get(state?.agentProfile?.id) || this.agentProfiles.get(this.defaultAgentProfileId);
  }

  #startRun(entry, content, options = {}) {
    if (entry.run) throw new GatewayError(409, "该会话已有正在运行的任务");
    const operation = entry.runtime.runTurn(content, (call, description, approvalSignal) => (
      options.approvalParent
        ? this.#requestDelegationApproval(options.approvalParent, entry, options.delegationId, call, description, approvalSignal)
        : new Promise((resolve) => {
        entry.approval = {
          call,
          description,
          scopes: entry.state.pendingApproval?.approvalScopes || ["once"],
          resolve,
        };
      })
    ), options);
    entry.run = operation.finally(() => {
      entry.run = null;
      entry.approval = null;
    });
    return entry.run;
  }

  #cancelEntry(entry, reason, visited = new Set()) {
    if (!entry || visited.has(entry.session.id)) return;
    visited.add(entry.session.id);
    entry.runtime.cancel(reason);
    if (entry.approval) {
      const { resolve } = entry.approval;
      entry.approval.signal?.removeEventListener("abort", entry.approval.onAbort);
      entry.approval = null;
      resolve(false);
    }
    for (const childId of entry.children) this.#cancelEntry(this.sessions.get(childId), reason, visited);
  }

  #requestDelegationApproval(parent, child, delegationId, call, description, signal) {
    return new Promise((resolve, reject) => {
      const proxyCall = {
        ...call,
        id: `${delegationId}:${call.id}`,
      };
      const approval = {
        call: proxyCall,
        childCall: call,
        childSessionId: child.session.id,
        delegated: true,
        description,
        scopes: child.state.pendingApproval?.approvalScopes || ["once"],
        resolve,
        signal,
        onAbort: null,
      };
      const onAbort = () => {
        if (parent.approval !== approval) return;
        parent.approval = null;
        signal?.removeEventListener("abort", onAbort);
        void parent.session.dispatch({
          type: "DELEGATION_APPROVAL_DECIDED",
          callId: proxyCall.id,
          approved: false,
        }).then(() => resolve(false), reject);
      };
      approval.onAbort = onAbort;
      void parent.session.dispatch({
        type: "DELEGATION_APPROVAL_REQUESTED",
        delegationId,
        childCallId: call.id,
        call: proxyCall,
        reason: description,
        approvalScopes: approval.scopes,
      }).then(() => {
        parent.approval = approval;
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }, reject);
    });
  }

  #assertMutationIdle(entry) {
    if (entry.run) throw new GatewayError(409, "会话运行期间不能处理 Memory mutation");
  }

  #assertPermissionProfile(profile, confirmation = null) {
    if (typeof profile !== "string" || !this.toolHost.has(profile)) {
      throw new GatewayError(400, `权限档位不可用：${profile || "未指定"}`);
    }
    if (profile === "danger-full-access" && confirmation !== "danger-full-access") {
      throw new GatewayError(400, "启用完全访问需要显式风险确认");
    }
  }

  async #downgradeImportedDangerousSession(state) {
    if (state.permissionProfile !== "danger-full-access") return state;
    const session = new AgentSession({ state, reducer: reduceSession, journal: this.store });
    return await session.dispatch({
      type: "PERMISSION_PROFILE_DOWNGRADED",
      profile: this.safePermissionProfile,
      reason: "journal_import",
    });
  }

  async #candidate(memoryId, scope) {
    const record = await this.memory.get(memoryId, { scope }, { includeInactive: true });
    if (!record || record.status !== "candidate") {
      throw new GatewayError(404, `未找到候选记忆：${memoryId}`);
    }
    return record;
  }

  #mutationError(error) {
    if (/未找到.*Memory mutation/.test(error.message)) return new GatewayError(404, error.message);
    return error instanceof GatewayError ? error : new GatewayError(400, error.message);
  }
}

function createRuntimeAgentProfiles({
  catalog,
  snapshot,
  providerClient,
  providerDescriptor,
  providerBindings,
  workspace,
  systemPrompt,
  toolSchemas,
  permission,
  execution,
  memoryScope,
  maxSteps,
  maxTokensPerTurn,
}) {
  if (snapshot) {
    const fixed = assertAgentProfileSnapshot(snapshot);
    return {
      defaultProfile: fixed.id,
      profiles: [{
        id: fixed.id,
        label: fixed.id,
        description: "",
        permissionProfile: fixed.permission.defaultProfile,
        maxSteps: runtimeLimit(fixed.budgets.maxSteps),
        maxTokensPerTurn: runtimeLimit(fixed.budgets.maxTokensPerTurn),
        memoryScope: fixed.memoryScope,
        systemPrompt,
        provider: providerClient,
        providerDescriptor,
        snapshot: () => assertAgentProfileSnapshot(fixed),
      }],
    };
  }
  const definitions = catalog?.profiles || [{
    id: "default",
    label: "default",
    description: "",
    instructions: "",
    permissionProfile: permission.defaultProfile,
    maxSteps,
    maxTokensPerTurn,
  }];
  const defaultProfile = catalog?.defaultProfile || "default";
  if (!definitions.some((item) => item.id === defaultProfile)) {
    throw new Error(`默认 Agent Profile 不存在：${defaultProfile}`);
  }
  const seen = new Set();
  const bindings = providerBindings instanceof Map
    ? providerBindings
    : new Map(Object.entries(providerBindings || {}));
  const profiles = definitions.map((definition) => {
    if (!definition?.id || seen.has(definition.id)) throw new Error(`Agent Profile id 重复或无效：${definition?.id || "未指定"}`);
    seen.add(definition.id);
    const profilePermission = definition.permissionProfile || permission.defaultProfile;
    if (!permission.profiles.some((item) => item.name === profilePermission)) {
      throw new Error(`Agent Profile ${definition.id} 的权限档位不可用：${profilePermission}`);
    }
    const profileMaxSteps = definition.maxSteps ?? maxSteps;
    const profileMaxTokens = definition.maxTokensPerTurn ?? maxTokensPerTurn;
    const profileMemoryScope = definition.id === "default"
      ? memoryScope
      : createMemoryScope({ ...memoryScope, agentId: definition.id });
    const profileSystemPrompt = appendAgentInstructions(systemPrompt, definition.instructions);
    const binding = bindings.get(definition.id) || { provider: providerClient, descriptor: providerDescriptor };
    if (!binding?.provider || typeof binding.provider.complete !== "function") {
      throw new Error(`Agent Profile ${definition.id} 缺少可用 Provider`);
    }
    const descriptor = binding.descriptor || {
      name: binding.provider.name,
      adapter: binding.provider.constructor?.name || "unknown",
      model: binding.provider.model || binding.provider.name,
      baseUrl: binding.provider.baseUrl || null,
    };
    const snapshotFactory = () => createAgentProfileSnapshot({
      id: definition.id,
      provider: descriptor,
      workspace,
      systemPrompt: profileSystemPrompt,
      toolSchemas: toolSchemas(),
      permission: { ...permission, defaultProfile: profilePermission },
      execution,
      memoryScope: profileMemoryScope,
      budgets: {
        maxSteps: profileMaxSteps,
        maxTokensPerTurn: profileMaxTokens,
      },
    });
    return {
      id: definition.id,
      label: definition.label || definition.id,
      description: definition.description || "",
      permissionProfile: profilePermission,
      maxSteps: profileMaxSteps,
      maxTokensPerTurn: profileMaxTokens,
      memoryScope: profileMemoryScope,
      systemPrompt: profileSystemPrompt,
      provider: binding.provider,
      providerDescriptor: descriptor,
      snapshot: snapshotFactory,
    };
  });
  return { defaultProfile, profiles };
}

function runtimeLimit(value) {
  return value === "unlimited" ? Infinity : value;
}

function durableLimit(value) {
  return value === Infinity ? "unlimited" : value;
}

function effectiveSessionBudgets(state, runtimeProfile) {
  const profileBudgets = {
    maxSteps: runtimeProfile.maxSteps,
    maxTokensPerTurn: runtimeProfile.maxTokensPerTurn,
  };
  if (state?.lineage?.kind !== "delegation") return profileBudgets;
  return {
    maxSteps: stricterLimit(runtimeLimit(state.agentProfile.budgets.maxSteps), profileBudgets.maxSteps),
    maxTokensPerTurn: stricterLimit(
      runtimeLimit(state.agentProfile.budgets.maxTokensPerTurn),
      profileBudgets.maxTokensPerTurn,
    ),
  };
}

function stricterLimit(left, right) {
  if (left === Infinity) return right;
  if (right === Infinity) return left;
  return Math.min(left, right);
}

function assertResumeAgentProfile(state, requested) {
  if (!state || !requested) return;
  if (state.agentProfile?.id !== requested) {
    throw new GatewayError(409, "恢复会话时不能覆盖其 Agent Profile");
  }
}

function inspectPermissionConfiguration(toolHost) {
  if (typeof toolHost.inspect === "function") return toolHost.inspect();
  return {
    defaultProfile: toolHost.policy?.profile?.name || "workspace-auto",
    profiles: [{
      name: toolHost.policy?.profile?.name || "workspace-auto",
      policyVersion: toolHost.policy?.version || null,
    }],
  };
}

function resumedProfile(state, requested, fallback) {
  if (state) {
    if (requested && requested !== state.permissionProfile) throw new GatewayError(409, "恢复会话时不能覆盖其权限档位");
    return state.permissionProfile || fallback;
  }
  return requested || fallback;
}

function normalizeDelegationSpec(specification, inherited) {
  if (!specification || typeof specification !== "object" || Array.isArray(specification)) {
    throw new GatewayError(400, "委派 specification 必须是对象");
  }
  const objective = typeof specification.objective === "string" ? specification.objective.trim() : "";
  if (!objective || objective.length > 4_000) throw new GatewayError(400, "委派 objective 必须是 1 到 4000 字符");
  const context = specification.context ?? [];
  if (!Array.isArray(context) || context.length > 20 || context.some((item) => typeof item !== "string" || !item.trim() || item.length > 2_000)) {
    throw new GatewayError(400, "委派 context 最多 20 条，每条必须是 1 到 2000 字符");
  }
  if (context.reduce((total, item) => total + item.length, 0) > 10_000) {
    throw new GatewayError(400, "委派 context 总长度不能超过 10000 字符");
  }
  const requested = specification.budget ?? {};
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
    throw new GatewayError(400, "委派 budget 必须是对象");
  }
  const maxSteps = childLimit(requested.maxSteps, inherited.maxSteps, "maxSteps");
  const maxTokensPerTurn = childLimit(requested.maxTokensPerTurn, inherited.maxTokensPerTurn, "maxTokensPerTurn");
  return {
    objective,
    context: context.map((item) => item.trim()),
    runtimeBudget: { maxSteps, maxTokensPerTurn },
    durableBudget: {
      maxSteps: maxSteps === Infinity ? "unlimited" : maxSteps,
      maxTokensPerTurn: maxTokensPerTurn === Infinity ? "unlimited" : maxTokensPerTurn,
    },
  };
}

function childLimit(requested, inherited, label) {
  if (requested === undefined) return inherited;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new GatewayError(400, `委派 ${label} 必须是正整数`);
  }
  if (inherited !== Infinity && requested > inherited) {
    throw new GatewayError(400, `委派 ${label} 不能超过 Parent 预算 ${inherited}`);
  }
  return requested;
}

function delegatedPrompt(input) {
  const context = input.context.length
    ? input.context.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "（无额外上下文；只根据当前 workspace 完成目标）";
  return `你是由 Parent Session 创建的单层 Child Agent。\n\n委派目标：\n${input.objective}\n\n显式上下文子集：\n${context}\n\n要求：只完成这个边界清晰的目标；不能继续委派；完成后返回可供 Parent 直接使用的简洁结果与验证依据。`;
}

function lastAssistantText(state) {
  return [...(state.messages || [])].reverse().find((message) => message.role === "assistant")?.content || "";
}

export class GatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
