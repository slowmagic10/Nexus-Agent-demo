// FOUNDATION — routes local Gateway operations to one isolated runtime per Project Workspace.
import { GatewayError } from "../gateway/session-manager.js";
import { SessionStore } from "../persistence/session-store.js";
import {
  existingWorkspaceStateDatabase,
  ProjectCatalogError,
  publicProject,
} from "./catalog.js";

export class GatewayProjectCoordinator {
  #catalog;
  #createProjectManager;
  #bundles = new Map();
  #bundlePromises = new Map();
  #sessionProjects = new Map();
  #closed = false;

  constructor({ catalog, createProjectManager } = {}) {
    if (!catalog || typeof catalog.list !== "function" || typeof catalog.get !== "function") {
      throw new TypeError("Gateway Project Coordinator 需要 Project Catalog");
    }
    if (typeof createProjectManager !== "function") {
      throw new TypeError("Gateway Project Coordinator 需要 Project Manager factory");
    }
    this.#catalog = catalog;
    this.#createProjectManager = createProjectManager;
  }

  async listProjects() {
    this.#assertOpen();
    const projects = await this.#catalog.list();
    return {
      defaultProjectId: this.#catalog.defaultProjectId,
      root: this.#catalog.root,
      projects: projects.map(publicProject),
    };
  }

  async createProject(input) {
    this.#assertOpen();
    try {
      return publicProject(await this.#catalog.create(input));
    } catch (error) {
      throw projectError(error);
    }
  }

  async runtimeInfo(projectId) {
    const { project, manager } = await this.#managerForProject(projectId);
    return {
      ...await manager.runtimeInfo(),
      project: publicProject(project),
      projects: {
        root: this.#catalog.root,
        defaultProjectId: this.#catalog.defaultProjectId,
      },
    };
  }

  async list(projectId = null) {
    this.#assertOpen();
    const projects = projectId ? [await this.#project(projectId)] : await this.#catalog.list();
    const sessions = [];
    const discovered = new Map();
    for (const project of projects) {
      const bundle = this.#bundles.get(project.id);
      const summaries = bundle
        ? await bundle.manager.list(100)
        : await readStoredSummaries(project);
      for (const summary of summaries) {
        const existingProjectId = discovered.get(summary.id) || this.#sessionProjects.get(summary.id);
        if (existingProjectId && existingProjectId !== project.id) {
          throw new GatewayError(409, `Session ID 跨项目冲突：${summary.id}`);
        }
        discovered.set(summary.id, project.id);
        sessions.push(annotate(summary, project));
      }
    }
    // List windows are deliberately bounded and therefore cannot prove global
    // ownership. Only controlled create/import/branch operations, or an exact
    // ID scan in #managerForSession, may populate the fast routing index.
    return sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async create({ projectId, ...options } = {}) {
    if (!options.resume) {
      const { project, manager } = await this.#managerForProject(projectId);
      const state = await manager.create(options);
      this.#sessionProjects.set(state.id, project.id);
      return annotate(state, project);
    }
    const project = await this.#project(projectId);
    let resume = options.resume;
    if (resume === "latest") {
      const loaded = this.#bundles.get(project.id);
      const latest = loaded?.manager.store?.latest(project.workspace) || await readStoredLatestState(project);
      if (!latest) throw new GatewayError(404, "没有可恢复的会话");
      resume = latest.id;
    }
    if (resume) {
      const owner = await this.#findStoredOwner(resume);
      if (!owner) throw new GatewayError(404, `未找到会话：${resume}`);
      if (owner.id !== project.id) {
        throw new GatewayError(409, `Session ID 已属于另一个项目：${resume}`);
      }
    }
    const { manager } = await this.#managerForProject(project.id);
    const state = await manager.create({ ...options, ...(resume ? { resume } : {}) });
    this.#sessionProjects.set(state.id, project.id);
    return annotate(state, project);
  }

  async importSession(archive, { id, projectId } = {}) {
    const { project, manager } = await this.#managerForProject(projectId);
    const requestedId = id || archive?.session?.id || null;
    if (requestedId) {
      const owner = await this.#findStoredOwner(requestedId);
      if (owner && owner.id !== project.id) {
        throw new GatewayError(409, `Session ID 已属于另一个项目：${requestedId}`);
      }
    }
    const state = await manager.importSession(archive, { id });
    this.#sessionProjects.set(state.id, project.id);
    return annotate(state, project);
  }

  async view(id) {
    const resolved = await this.#managerForSession(id);
    const view = await resolved.manager.view(id);
    return { ...view, state: annotate(view.state, resolved.project) };
  }

  async get(id) {
    return this.#stateOperation(id, "get");
  }

  async setDisplayTitle(id, title) {
    return this.#stateOperation(id, "setDisplayTitle", title);
  }

  async setPermissionProfile(id, profile, options) {
    return this.#stateOperation(id, "setPermissionProfile", profile, options);
  }

  async branch(id, options) {
    const resolved = await this.#managerForSession(id);
    const state = await resolved.manager.branch(id, options);
    this.#sessionProjects.set(state.id, resolved.project.id);
    return annotate(state, resolved.project);
  }

  async sendMessage(id, content) {
    return this.#stateOperation(id, "sendMessage", content);
  }

  async decideApproval(id, callId, approved, scope) {
    return this.#stateOperation(id, "decideApproval", callId, approved, scope);
  }

  async cancel(id) {
    return this.#stateOperation(id, "cancel");
  }

  async retryMemoryMutation(id, mutationId) {
    return this.#stateOperation(id, "retryMemoryMutation", mutationId);
  }

  async discardMemoryMutation(id, mutationId, reason) {
    return this.#stateOperation(id, "discardMemoryMutation", mutationId, reason);
  }

  async resolveMemoryMutation(id, mutationId, memoryId) {
    return this.#stateOperation(id, "resolveMemoryMutation", mutationId, memoryId);
  }

  async listArtifacts(id) {
    return this.#sessionOperation(id, "listArtifacts");
  }

  async getArtifact(id, artifactId) {
    return this.#sessionOperation(id, "getArtifact", artifactId);
  }

  async exportSession(id) {
    return this.#sessionOperation(id, "exportSession");
  }

  async evaluate(id) {
    return this.#sessionOperation(id, "evaluate");
  }

  async listGrants(id) {
    return this.#sessionOperation(id, "listGrants");
  }

  async revokeGrant(id, grantId, scope, reason) {
    return this.#sessionOperation(id, "revokeGrant", grantId, scope, reason);
  }

  async listSessionMemories(id, query) {
    return this.#sessionOperation(id, "listSessionMemories", query);
  }

  async listSessionMemoryCandidates(id) {
    return this.#sessionOperation(id, "listSessionMemoryCandidates");
  }

  async addSessionMemory(id, content, tags) {
    return this.#sessionOperation(id, "addSessionMemory", content, tags);
  }

  async deleteSessionMemory(id, memoryId, reason) {
    return this.#sessionOperation(id, "deleteSessionMemory", memoryId, reason);
  }

  async setMemoryPinned(id, memoryId, pinned) {
    return this.#sessionOperation(id, "setMemoryPinned", memoryId, pinned);
  }

  async approveMemoryCandidate(id, memoryId) {
    return this.#sessionOperation(id, "approveMemoryCandidate", memoryId);
  }

  async rejectMemoryCandidate(id, memoryId, reason) {
    return this.#sessionOperation(id, "rejectMemoryCandidate", memoryId, reason);
  }

  async listMemories(query = "", projectId = null) {
    const { manager } = await this.#managerForProject(projectId);
    return manager.listMemories(query);
  }

  async listMemoryCandidates(projectId = null) {
    const { manager } = await this.#managerForProject(projectId);
    return manager.listMemoryCandidates();
  }

  async addMemory(content, tags = [], projectId = null) {
    const { manager } = await this.#managerForProject(projectId);
    return manager.addMemory(content, tags);
  }

  async deleteMemory(id, reason, projectId = null) {
    const { manager } = await this.#managerForProject(projectId);
    return manager.deleteMemory(id, reason);
  }

  async verifyMemory(id, projectId = null) {
    const { manager } = await this.#managerForProject(projectId);
    return manager.verifyMemory(id);
  }

  async subscribe(id, listener) {
    const resolved = await this.#managerForSession(id);
    return resolved.manager.subscribe(id, (state) => listener(annotate(state, resolved.project)));
  }

  async subscribeEvents(id, listener, options) {
    const resolved = await this.#managerForSession(id);
    return resolved.manager.subscribeEvents(id, (event) => {
      listener(event.baseline
        ? { ...event, baseline: annotate(event.baseline, resolved.project) }
        : event);
    }, options);
  }

  async cursor(id) {
    return this.#sessionOperation(id, "cursor");
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const pending = [...this.#bundlePromises.values()];
    const pendingResults = await Promise.allSettled(pending);
    const bundles = [...this.#bundles.values()].reverse();
    const closeResults = await Promise.allSettled(bundles.map((bundle) => closeProjectBundle(bundle)));
    this.#bundles.clear();
    this.#bundlePromises.clear();
    this.#sessionProjects.clear();
    const errors = [
      ...pendingResults
        .filter((result) => result.status === "rejected" && !(result.reason instanceof GatewayError && result.reason.status === 503))
        .map((result) => result.reason),
      ...closeResults.filter((result) => result.status === "rejected").map((result) => result.reason),
    ];
    if (errors.length) throw new AggregateError(errors, "关闭 Project Runtime 时发生错误");
  }

  async #stateOperation(id, method, ...args) {
    const resolved = await this.#managerForSession(id);
    return annotate(await resolved.manager[method](id, ...args), resolved.project);
  }

  async #sessionOperation(id, method, ...args) {
    const resolved = await this.#managerForSession(id);
    return resolved.manager[method](id, ...args);
  }

  async #managerForProject(projectId = null) {
    this.#assertOpen();
    const project = await this.#project(projectId);
    const loaded = this.#bundles.get(project.id);
    if (loaded) return { project, manager: loaded.manager };
    let pending = this.#bundlePromises.get(project.id);
    if (!pending) {
      pending = Promise.resolve(this.#createProjectManager(project))
        .then(async (bundle) => {
          if (!bundle?.manager) throw new Error("Project Manager factory 未返回 manager");
          if (this.#closed) {
            await closeProjectBundle(bundle);
            throw new GatewayError(503, "Gateway Project Coordinator 已关闭");
          }
          this.#bundles.set(project.id, bundle);
          return bundle;
        })
        .finally(() => {
          if (this.#bundlePromises.get(project.id) === pending) this.#bundlePromises.delete(project.id);
        });
      this.#bundlePromises.set(project.id, pending);
    }
    const bundle = await pending;
    return { project, manager: bundle.manager };
  }

  async #managerForSession(id) {
    if (typeof id !== "string" || !id) throw new GatewayError(404, "Session 不存在");
    const indexed = this.#sessionProjects.get(id);
    if (indexed) return this.#managerForProject(indexed);
    const owner = await this.#findStoredOwner(id);
    if (!owner) throw new GatewayError(404, `未找到会话：${id}`);
    this.#sessionProjects.set(id, owner.id);
    return this.#managerForProject(owner.id);
  }

  async #findStoredOwner(id) {
    const matches = [];
    for (const project of await this.#catalog.list()) {
      const bundle = this.#bundles.get(project.id);
      const state = bundle?.manager.store?.load(id) || await readStoredState(project, id);
      if (state?.workspace === project.workspace) matches.push(project);
    }
    if (matches.length > 1) throw new GatewayError(409, `Session ID 跨项目冲突：${id}`);
    return matches[0] || null;
  }

  async #project(projectId) {
    try {
      return await this.#catalog.get(projectId || this.#catalog.defaultProjectId);
    } catch (error) {
      throw projectError(error);
    }
  }

  #assertOpen() {
    if (this.#closed) throw new GatewayError(503, "Gateway Project Coordinator 已关闭");
  }
}

async function closeProjectBundle(bundle) {
  const errors = [];
  try {
    await bundle.manager.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await bundle.close?.();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "Project Runtime 资源未完全关闭");
}

function annotate(value, project) {
  return { ...value, project: publicProject(project) };
}

async function readStoredSummaries(project) {
  return withStoredProject(project, (store) => store.list(project.workspace, 100), []);
}

async function readStoredState(project, id) {
  return withStoredProject(project, (store) => store.load(id), null);
}

async function readStoredLatestState(project) {
  return withStoredProject(project, (store) => store.latest(project.workspace), null);
}

async function withStoredProject(project, read, fallback) {
  const file = await existingWorkspaceStateDatabase(project.workspace);
  if (!file) return fallback;
  const store = new SessionStore(file, { workspace: project.workspace });
  try {
    return read(store);
  } finally {
    store.close();
  }
}

function projectError(error) {
  if (error instanceof GatewayError) return error;
  if (error instanceof ProjectCatalogError) return new GatewayError(error.status, error.message);
  return error;
}
