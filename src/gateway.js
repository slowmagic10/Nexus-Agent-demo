#!/usr/bin/env node
// FOUNDATION — local Gateway and Web console entrypoint.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityRuntime } from "./capabilities/runtime.js";
import { composeRuntimeConfig, createConfiguredAgentProviders, inspectRuntimeConfig } from "./config/composer.js";
import { createToolRegistry } from "./tools/registry.js";
import { loadWorkspacePolicy, WorkspacePolicy } from "./tools/authorization.js";
import { ToolHost } from "./tools/host.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";
import { SessionStore } from "./persistence/session-store.js";
import { GatewaySessionManager } from "./gateway/session-manager.js";
import { createGatewayServer } from "./gateway/server.js";
import { loadMcpConfig } from "./mcp/config.js";
import { connectMcpTools } from "./mcp/tool-adapter.js";
import { formatMaxSteps } from "./runtime-options.js";
import { loadLocalEnvironment } from "./local-environment.js";
import { createLocalMemoryScope } from "./memory/scope.js";
import { createWorkspaceExecution } from "./execution/factory.js";
import { createPermissionProfile } from "./tools/permission-profile.js";
import { defaultProjectGrantStoreFile, ProjectGrantStore } from "./tools/project-grant-store.js";
import { formatNetworkTarget } from "./execution/network-target.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const localEnvironment = loadLocalEnvironment(root);
const args = process.argv.slice(2);
const config = await composeRuntimeConfig({ args, env: process.env, root, localEnvironment });
if (config.printConfig) {
  console.log(JSON.stringify(inspectRuntimeConfig(config), null, 2));
  process.exit(0);
}
const workspace = config.workspace;
const memoryScope = createLocalMemoryScope(workspace);
const agentProviders = createConfiguredAgentProviders(config);
const defaultProviderBinding = agentProviders.get(config.agents.defaultProfile);
const provider = defaultProviderBinding.provider;
const context = await loadWorkspaceContext(workspace);
const systemPrompt = buildSystemPrompt(context);
const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace, memoryScope });
const capabilityRuntime = new CapabilityRuntime();
const workspaceExecution = createWorkspaceExecution(config, { environment: process.env });
const permissionProfile = createPermissionProfile({
  name: config.permission.profile,
  workspace,
  executionType: config.execution.type,
  networkTargets: config.network.targets,
});
const enabledPermissionProfiles = ["read-only", "approval-required", "workspace-confirm", "workspace-untrusted", "workspace-auto"];
if (config.execution.type === "local") enabledPermissionProfiles.push("danger-full-access");
const permissionProfiles = Object.fromEntries(enabledPermissionProfiles.map((name) => [name, createPermissionProfile({
  name,
  workspace,
  executionType: config.execution.type,
  networkTargets: config.network.targets,
})]));
let manager = null;
const tools = createToolRegistry({
  workspace,
  bundledSkills: path.resolve(here, "../skills"),
  memory: store.memory,
  artifactStore: store.artifacts,
  memoryScope,
  capabilityRuntime,
  workspaceExecution,
  accessPolicy: permissionProfile,
  accessPolicies: permissionProfiles,
  delegateTask: (input, toolContext) => {
    if (!manager) throw new Error("Gateway Delegation Coordinator 尚未就绪");
    return manager.delegate(toolContext.state.id, input, { signal: toolContext.signal });
  },
});
const mcp = await connectMcpTools(await loadMcpConfig(config.mcp.file, workspace), { capabilityRuntime });
const workspacePolicy = await loadWorkspacePolicy(workspace, { profile: permissionProfile });
const projectGrantStore = new ProjectGrantStore(defaultProjectGrantStoreFile(process.env));
const permissionToolHosts = Object.fromEntries(Object.entries(permissionProfiles).map(([name, profile]) => {
  const policy = new WorkspacePolicy(workspacePolicy.config, { profile, allowElevation: false });
  return [name, new ToolHost({ registry: tools, policy, projectGrantStore, artifactStore: store.artifacts })];
}));
manager = new GatewaySessionManager({
  workspace,
  provider,
  providerDescriptor: defaultProviderBinding.descriptor,
  agentProviders,
  tools,
  permissionToolHosts,
  defaultPermissionProfile: config.permission.profile,
  agentProfiles: config.agents,
  projectGrantStore,
  executionInfo: workspaceExecution.inspect?.() || { id: workspaceExecution.id },
  systemPrompt,
  store,
  memory: store.memory,
  maxSteps: config.runtime.maxSteps,
  maxTokensPerTurn: config.runtime.maxTokensPerTurn,
});
const gateway = createGatewayServer({ manager, port: config.gateway.port, staticRoot: path.resolve(here, "web") });
let address;
try {
  address = await gateway.listen();
} catch (error) {
  await manager.close();
  store.close();
  projectGrantStore.close();
  await mcp.close();
  throw error;
}

console.log(`Nexus Gateway (${provider.name}) 正在监听 ${address.url}`);
if (mcp.servers.length) console.log(`已连接 MCP：${mcp.servers.join(", ")}（${mcp.tools.length} 个工具）`);
console.log(`Web 控制台：${address.url}/`);
console.log(`单次任务步骤上限：${formatMaxSteps(config.runtime.maxSteps)}`);
console.log(`单次任务累计 Token 预算：${config.runtime.maxTokensPerTurn === Infinity ? "不限制" : config.runtime.maxTokensPerTurn}`);
console.log(`Workspace 执行环境：${workspaceExecution.id}`);
console.log(`权限档位：${permissionProfile.name}`);
console.log(`默认 Agent Profile：${config.agents.defaultProfile}（共 ${config.agents.profiles.length} 个）`);
if (config.network.targets.length) console.log(`可信网络目标：${config.network.targets.map(formatNetworkTarget).join(", ")}（支持本次或本会话审批）`);
console.log("仅允许本机连接。按 Ctrl+C 安全退出。");

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    if (closing) return;
    closing = true;
    console.log("\n正在关闭 Gateway；未决审批将被拒绝……");
    await gateway.close();
    store.close();
    projectGrantStore.close();
    await mcp.close();
  });
}
