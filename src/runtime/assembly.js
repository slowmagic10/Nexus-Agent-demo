// FOUNDATION — shared runtime object graph and lifecycle for local entrypoint adapters.
import path from "node:path";
import { CapabilityRuntime } from "../capabilities/runtime.js";
import { createConfiguredAgentProviders } from "../config/composer.js";
import { AgentRuntime } from "../core/agent.js";
import { createWorkspaceExecution } from "../execution/factory.js";
import { loadMcpConfig } from "../mcp/config.js";
import { connectMcpTools } from "../mcp/tool-adapter.js";
import { createModelMemoryExtractor, MemoryFlushPolicy } from "../memory/flush-policy.js";
import { retrieveContextMemories } from "../memory/context-retrieval.js";
import { reconcileMemoryOutbox } from "../memory/outbox.js";
import { createLocalMemoryScope } from "../memory/scope.js";
import { SessionStore } from "../persistence/session-store.js";
import { ensureManagedProjectWorkspace, ensureWorkspaceStateDirectory } from "../projects/catalog.js";
import { loadWorkspacePolicy, WorkspacePolicy } from "../tools/authorization.js";
import { ToolHost } from "../tools/host.js";
import { createPermissionProfile } from "../tools/permission-profile.js";
import { defaultProjectGrantStoreFile, ProjectGrantStore } from "../tools/project-grant-store.js";
import { createToolRegistry } from "../tools/registry.js";
import { buildSystemPrompt, loadWorkspaceContext } from "../workspace.js";

export async function createRuntimeAssembly({
  config,
  bundledSkills,
  environment = process.env,
} = {}) {
  assertRuntimeConfig(config);
  if (typeof bundledSkills !== "string" || !bundledSkills.trim()) {
    throw new Error("Runtime Assembly 需要 bundledSkills 路径");
  }
  if (!environment || typeof environment !== "object") {
    throw new Error("Runtime Assembly environment 无效");
  }

  const workspace = path.resolve(config.workspace);
  if (config.sources?.workspace === "default") {
    await ensureManagedProjectWorkspace(workspace, { root: config.projects.root });
  }
  await ensureWorkspaceStateDirectory(workspace);
  const baseMemoryScope = createLocalMemoryScope(workspace);
  const agentProviders = createConfiguredAgentProviders(config);
  const defaultProviderBinding = agentProviders.get(config.agents.defaultProfile);
  if (!defaultProviderBinding) {
    throw new Error(`Runtime Assembly 找不到默认 Agent Profile：${config.agents.defaultProfile}`);
  }
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), {
    workspace,
    memoryScope: baseMemoryScope,
  });

  return new RuntimeAssembly({
    config,
    workspace,
    bundledSkills: path.resolve(bundledSkills),
    environment,
    baseMemoryScope,
    agentProviders,
    defaultProviderBinding,
    store,
  });
}

class RuntimeAssembly {
  #bundledSkills;
  #environment;
  #activation = null;
  #closed = false;

  constructor({
    config,
    workspace,
    bundledSkills,
    environment,
    baseMemoryScope,
    agentProviders,
    defaultProviderBinding,
    store,
  }) {
    this.config = config;
    this.workspace = workspace;
    this.baseMemoryScope = baseMemoryScope;
    this.agentProviders = agentProviders;
    this.defaultProviderBinding = defaultProviderBinding;
    this.store = store;
    this.#bundledSkills = bundledSkills;
    this.#environment = environment;
  }

  async activate({
    defaultPermissionProfile = this.config.permission.profile,
    permissionProfileNames = [defaultPermissionProfile],
    delegateTask = null,
  } = {}) {
    this.#assertOpen();
    if (this.#activation) throw new Error("Runtime Assembly 已激活");
    const profileNames = normalizePermissionProfileNames(permissionProfileNames, defaultPermissionProfile);
    if (delegateTask !== null && typeof delegateTask !== "function") {
      throw new Error("Runtime Assembly delegateTask 必须是函数或 null");
    }

    let mcp = null;
    let projectGrantStore = null;
    let capabilityRuntime = null;
    try {
      const context = await loadWorkspaceContext(this.workspace);
      const systemPrompt = buildSystemPrompt(context);
      capabilityRuntime = new CapabilityRuntime();
      const workspaceExecution = createWorkspaceExecution(this.config, { environment: this.#environment });
      const permissionProfiles = Object.fromEntries(profileNames.map((name) => [name, createPermissionProfile({
        name,
        workspace: this.workspace,
        executionType: this.config.execution.type,
        networkTargets: this.config.network.targets,
      })]));
      const permissionProfile = permissionProfiles[defaultPermissionProfile];
      const workspacePolicy = await loadWorkspacePolicy(this.workspace, { profile: permissionProfile });
      const tools = createToolRegistry({
        workspace: this.workspace,
        bundledSkills: this.#bundledSkills,
        memory: this.store.memory,
        artifactStore: this.store.artifacts,
        capabilityRuntime,
        workspaceExecution,
        accessPolicy: permissionProfile,
        accessPolicies: permissionProfiles,
        delegateTask,
      });
      mcp = await connectMcpTools(await loadMcpConfig(this.config.mcp.file, this.workspace), { capabilityRuntime });
      projectGrantStore = new ProjectGrantStore(defaultProjectGrantStoreFile(this.#environment));
      const permissionToolHosts = Object.fromEntries(Object.entries(permissionProfiles).map(([name, profile]) => {
        const policy = new WorkspacePolicy(workspacePolicy.config, { profile, allowElevation: false });
        return [name, new ToolHost({
          registry: tools,
          policy,
          projectGrantStore,
          artifactStore: this.store.artifacts,
        })];
      }));

      this.#activation = Object.freeze({
        context,
        systemPrompt,
        capabilityRuntime,
        workspaceExecution,
        permissionProfile,
        permissionProfiles: Object.freeze(permissionProfiles),
        workspacePolicy,
        tools,
        mcp,
        projectGrantStore,
        permissionToolHosts: Object.freeze(permissionToolHosts),
        toolHost: permissionToolHosts[defaultPermissionProfile],
      });
      return this.#activation;
    } catch (error) {
      this.#closed = true;
      try {
        await closeResources({ mcp, capabilityRuntime, projectGrantStore, store: this.store });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Runtime Assembly 激活失败且资源清理未完全成功");
      }
      throw error;
    }
  }

  createAgentRuntime({
    session,
    provider,
    toolHost = this.#activation?.toolHost,
    systemPrompt = this.#activation?.systemPrompt,
    memoryFlushPolicy = null,
    maxSteps,
    maxTokensPerTurn,
  } = {}) {
    this.#assertOpen();
    if (!this.#activation) throw new Error("Runtime Assembly 尚未激活");
    if (!provider || typeof provider.complete !== "function") {
      throw new Error("Runtime Assembly 需要模型 Provider");
    }
    const flushPolicy = memoryFlushPolicy || new MemoryFlushPolicy({
      memory: this.store.memory,
      extractCandidates: createModelMemoryExtractor(provider),
    });
    return new AgentRuntime({
      session,
      provider,
      toolHost,
      systemPrompt,
      retrieveMemory: (query, { signal } = {}) => retrieveContextMemories(this.store.memory, query, {
        scope: session.state.memoryScope,
        signal,
      }),
      reconcile: ({ signal } = {}) => reconcileMemoryOutbox({
        session,
        memory: this.store.memory,
        signal,
      }),
      flushMemory: (input) => flushPolicy.flush(input),
      maxSteps,
      maxTokensPerTurn,
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await closeResources({
      mcp: this.#activation?.mcp,
      capabilityRuntime: this.#activation?.capabilityRuntime,
      projectGrantStore: this.#activation?.projectGrantStore,
      store: this.store,
    });
  }

  #assertOpen() {
    if (this.#closed) throw new Error("Runtime Assembly 已关闭");
  }
}

function normalizePermissionProfileNames(values, defaultProfile) {
  if (!Array.isArray(values) || !values.length) {
    throw new Error("Runtime Assembly 至少需要一个 Permission Profile");
  }
  const names = [...new Set(values.map((value) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("Runtime Assembly Permission Profile 名称无效");
    return value.trim();
  }))];
  if (!names.includes(defaultProfile)) {
    throw new Error(`Runtime Assembly 默认 Permission Profile 未注册：${defaultProfile}`);
  }
  return names;
}

async function closeResources({ mcp, capabilityRuntime, projectGrantStore, store }) {
  const errors = [];
  if (mcp) {
    try {
      await mcp.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (capabilityRuntime) {
    const owners = [...new Set(capabilityRuntime.list().map((registration) => registration.owner))];
    for (const owner of owners) {
      try {
        const result = await capabilityRuntime.revokeOwner(owner, "Runtime Assembly closed");
        errors.push(...result.failures.map((failure) => new Error(
          `Capability ${failure.registrationId} 清理失败：${failure.error}`,
        )));
      } catch (error) {
        errors.push(error);
      }
    }
  }
  for (const resource of [projectGrantStore, store]) {
    if (!resource) continue;
    try {
      resource.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Runtime Assembly 关闭失败");
}

function assertRuntimeConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Runtime Assembly 需要 RuntimeConfig");
  if (typeof config.workspace !== "string" || !config.workspace.trim()) {
    throw new Error("Runtime Assembly workspace 无效");
  }
  if (!config.agents?.defaultProfile || !Array.isArray(config.agents.profiles)) {
    throw new Error("Runtime Assembly Agent Profile 配置无效");
  }
}
