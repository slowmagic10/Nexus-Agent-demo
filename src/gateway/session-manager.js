// FOUNDATION — coordinates isolated Agent sessions for local HTTP/SSE clients.
import { createSession, reduceSession } from "../core/state.js";
import { AgentRuntime } from "../core/agent.js";
import { AgentSession } from "../core/session.js";
import { assertMemoryInspection, assertMemoryInterface } from "../memory/interface.js";
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
  constructor({ workspace, provider, tools, toolHost, permissionToolHosts, defaultPermissionProfile, workspacePolicy, projectGrantStore = null, executionInfo = null, systemPrompt, store, memory = store?.memory, memoryScope, maxSteps, maxTokensPerTurn, memoryFlushPolicy }) {
    this.workspace = workspace;
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.store = store;
    this.memory = assertMemoryInterface(memory);
    this.projectGrantStore = projectGrantStore;
    assertMemoryInspection(this.memory);
    this.defaultMemoryScope = createMemoryScope(memoryScope || { workspace });
    this.memoryFlushPolicy = memoryFlushPolicy || new MemoryFlushPolicy({
      memory: this.memory,
      extractCandidates: createModelMemoryExtractor(provider),
    });
    const fallbackHost = toolHost || new ToolHost({ registry: tools, policy: workspacePolicy });
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
    this.maxSteps = maxSteps;
    this.maxTokensPerTurn = maxTokensPerTurn;
    this.sessions = new Map();
  }

  async create({ resume, permissionProfile, permissionConfirmation } = {}) {
    let state = resume === "latest"
      ? this.store.latest(this.workspace)
      : resume
        ? this.store.load(resume)
        : null;

    if (resume && (!state || state.workspace !== this.workspace)) {
      throw new GatewayError(404, resume === "latest" ? "没有可恢复的会话" : `未找到会话：${resume}`);
    }

    const existing = state ? this.sessions.get(state.id) : null;
    if (existing) return existing.state;

    const resumed = Boolean(state);
    const selectedProfile = resumedProfile(state, permissionProfile, this.defaultPermissionProfile);
    const downgradeDangerousResume = resumed
      && selectedProfile === "danger-full-access"
      && permissionConfirmation !== "danger-full-access";
    const activeProfile = downgradeDangerousResume ? this.safePermissionProfile : selectedProfile;
    this.#assertPermissionProfile(activeProfile, permissionConfirmation);
    state ||= createSession({
      provider: this.provider.name,
      workspace: this.workspace,
      memoryScope: this.defaultMemoryScope,
      permissionProfile: activeProfile,
    });
    const session = new AgentSession({ state, reducer: reduceSession, journal: this.store });
    if (downgradeDangerousResume) {
      await session.dispatch({
        type: "PERMISSION_PROFILE_DOWNGRADED",
        profile: activeProfile,
        reason: "resume_requires_confirmation",
      });
    }

    const entry = {
      state: session.state,
      session,
      runtime: null,
      run: null,
      approval: null,
      subscribers: new Set(),
    };
    entry.runtime = new AgentRuntime({
      session,
      provider: this.provider,
      toolHost: this.toolHost,
      systemPrompt: this.systemPrompt,
      retrieveMemory: (query, { signal } = {}) => this.memory.search(query, {
        scope: session.state.memoryScope,
        signal,
      }, { limit: 5 }),
      reconcile: ({ signal } = {}) => reconcileMemoryOutbox({ session, memory: this.memory, signal }),
      flushMemory: (input) => this.memoryFlushPolicy.flush(input),
      maxSteps: this.maxSteps,
      maxTokensPerTurn: this.maxTokensPerTurn,
    });
    session.subscribe((next) => this.update(entry, next));
    this.sessions.set(state.id, entry);
    if (resumed) {
      await reconcileMemoryOutbox({ session, memory: this.memory });
      await session.dispatch({ type: "RESUMED", provider: this.provider.name, workspace: this.workspace });
    }
    return session.state;
  }

  list() {
    return this.store.list(this.workspace);
  }

  runtimeInfo() {
    return {
      execution: this.executionInfo,
      runtime: {
        maxSteps: this.maxSteps === Infinity ? "unlimited" : this.maxSteps,
        maxTokensPerTurn: this.maxTokensPerTurn === Infinity ? "unlimited" : this.maxTokensPerTurn,
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
      provider: this.provider.name,
      workspace: this.workspace,
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

    entry.run = entry.runtime.runTurn(content.trim(), (call, description) => (
      new Promise((resolve) => {
        entry.approval = {
          call,
          description,
          scopes: entry.state.pendingApproval?.approvalScopes || ["once"],
          resolve,
        };
      })
    )).finally(() => {
      entry.run = null;
      entry.approval = null;
    });
    return entry.state;
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
    const { resolve } = entry.approval;
    entry.approval = null;
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
    if (!entry.run) throw new GatewayError(409, "该会话当前没有正在运行的任务");
    entry.runtime.cancel("用户通过 Gateway 取消了任务");
    if (entry.approval) {
      const { resolve } = entry.approval;
      entry.approval = null;
      resolve(false);
    }
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
        entry.runtime.cancel("Gateway 正在关闭");
        runs.push(entry.run);
      }
      if (entry.approval) {
        const { resolve } = entry.approval;
        entry.approval = null;
        resolve(false);
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

function resumedProfile(state, requested, fallback) {
  if (state) {
    if (requested && requested !== state.permissionProfile) throw new GatewayError(409, "恢复会话时不能覆盖其权限档位");
    return state.permissionProfile || fallback;
  }
  return requested || fallback;
}

export class GatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
