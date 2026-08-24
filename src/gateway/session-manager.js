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

export class GatewaySessionManager {
  constructor({ workspace, provider, tools, toolHost, workspacePolicy, systemPrompt, store, memory = store?.memory, memoryScope, maxSteps, memoryFlushPolicy }) {
    this.workspace = workspace;
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.store = store;
    this.memory = assertMemoryInterface(memory);
    assertMemoryInspection(this.memory);
    this.defaultMemoryScope = createMemoryScope(memoryScope || { workspace });
    this.memoryFlushPolicy = memoryFlushPolicy || new MemoryFlushPolicy({
      memory: this.memory,
      extractCandidates: createModelMemoryExtractor(provider),
    });
    this.toolHost = toolHost || new ToolHost({ registry: tools, policy: workspacePolicy });
    this.maxSteps = maxSteps;
    this.sessions = new Map();
  }

  async create({ resume } = {}) {
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
    state ||= createSession({ provider: this.provider.name, workspace: this.workspace, memoryScope: this.defaultMemoryScope });
    const session = new AgentSession({ state, reducer: reduceSession, journal: this.store });

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
      return this.store.importJournal(archive, { id, workspace: this.workspace });
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
        entry.approval = { call, description, resolve };
      })
    )).finally(() => {
      entry.run = null;
      entry.approval = null;
    });
    return entry.state;
  }

  async decideApproval(id, callId, approved) {
    if (typeof approved !== "boolean") throw new GatewayError(400, "approved 必须是布尔值");
    const entry = await this.ensureLoaded(id);
    if (!entry.approval || entry.approval.call.id !== callId) {
      throw new GatewayError(409, "该工具调用当前不在等待审批");
    }
    const { resolve } = entry.approval;
    entry.approval = null;
    resolve(approved);
    return entry.state;
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

export class GatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
