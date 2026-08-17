// FOUNDATION — coordinates isolated Agent sessions for local HTTP/SSE clients.
import { createSession, reduceSession } from "../core/state.js";
import { AgentRuntime } from "../core/agent.js";
import { AgentSession } from "../core/session.js";

export class GatewaySessionManager {
  constructor({ workspace, provider, tools, systemPrompt, store }) {
    this.workspace = workspace;
    this.provider = provider;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.store = store;
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
    state ||= createSession({ provider: this.provider.name, workspace: this.workspace });
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
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      retrieveMemory: (query) => this.store.searchMemories(query, 5),
    });
    session.subscribe((next) => this.update(entry, next));
    this.sessions.set(state.id, entry);
    if (resumed) {
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

  listMemories(query = "") {
    return this.store.searchMemories(query, 100);
  }

  addMemory(content, tags = []) {
    if (typeof content !== "string" || !content.trim()) throw new GatewayError(400, "content 必须是非空字符串");
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) throw new GatewayError(400, "tags 必须是字符串数组");
    return this.store.addMemory(content, { tags });
  }

  deleteMemory(id) {
    if (!this.store.deleteMemory(id)) throw new GatewayError(404, `未找到长期记忆：${id}`);
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
}

export class GatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
