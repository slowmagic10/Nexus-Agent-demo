#!/usr/bin/env node
// FOUNDATION — local Gateway and Web console entrypoint.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeRuntimeConfig, inspectRuntimeConfig } from "./config/composer.js";
import { GatewaySessionManager } from "./gateway/session-manager.js";
import { createGatewayServer } from "./gateway/server.js";
import { formatMaxSteps } from "./runtime-options.js";
import { loadLocalEnvironment } from "./local-environment.js";
import { formatNetworkTarget } from "./execution/network-target.js";
import { createRuntimeAssembly } from "./runtime/assembly.js";
import { ProjectCatalog } from "./projects/catalog.js";
import { GatewayProjectCoordinator } from "./projects/gateway-coordinator.js";
import { projectRuntimeArgs } from "./projects/runtime-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const localEnvironment = loadLocalEnvironment(root);
const args = process.argv.slice(2);
const config = await composeRuntimeConfig({ args, env: process.env, root, localEnvironment, useProjectsDefault: true });
if (config.printConfig) {
  console.log(JSON.stringify(inspectRuntimeConfig(config), null, 2));
  process.exit(0);
}
const catalog = await new ProjectCatalog({
  root: config.projects.root,
  defaultWorkspace: config.workspace,
  legacyProjects: [{ workspace: root, name: "Nexus Agent（旧工作区）" }],
}).initialize();
const manager = new GatewayProjectCoordinator({
  catalog,
  createProjectManager: async (project) => createProjectManager(project),
});
let gateway;
let address;
try {
  gateway = createGatewayServer({ manager, port: config.gateway.port, staticRoot: path.resolve(here, "web") });
  address = await gateway.listen();
} catch (error) {
  await manager.close();
  throw error;
}

console.log(`Nexus Gateway (${providerLabel(config)}) 正在监听 ${address.url}`);
console.log(`Web 控制台：${address.url}/`);
console.log(`Projects Root：${catalog.root}`);
console.log(`默认 Workspace：${config.workspace}`);
console.log(`单次任务步骤上限：${formatMaxSteps(config.runtime.maxSteps)}`);
console.log(`单次任务累计 Token 预算：${config.runtime.maxTokensPerTurn === Infinity ? "不限制" : config.runtime.maxTokensPerTurn}`);
console.log(`Workspace 执行环境：${config.execution.type}`);
console.log(`权限档位：${config.permission.profile}`);
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
  });
}

async function createProjectManager(project) {
  const projectConfig = await composeRuntimeConfig({
    args: projectRuntimeArgs({
      startupArgs: args,
      startupWorkspace: config.workspace,
      mcpFile: config.mcp.file,
      workspace: project.workspace,
    }),
    env: process.env,
    root,
    localEnvironment,
    useProjectsDefault: true,
  });
  const assembly = await createRuntimeAssembly({
    config: projectConfig,
    bundledSkills: path.resolve(here, "../skills"),
    environment: process.env,
  });
  const { workspace, baseMemoryScope: memoryScope, agentProviders, defaultProviderBinding, store } = assembly;
  const enabledPermissionProfiles = ["read-only", "approval-required", "workspace-confirm", "workspace-untrusted", "workspace-auto"];
  if (projectConfig.execution.type === "local") enabledPermissionProfiles.push("danger-full-access");
  let projectManager = null;
  try {
    const runtime = await assembly.activate({
      defaultPermissionProfile: projectConfig.permission.profile,
      permissionProfileNames: enabledPermissionProfiles,
      delegateTask: (input, toolContext) => {
        if (!projectManager) throw new Error("Gateway Session Manager 尚未就绪");
        return projectManager.delegate(toolContext.state.id, input, { signal: toolContext.signal });
      },
    });
    projectManager = new GatewaySessionManager({
      workspace,
      provider: defaultProviderBinding.provider,
      providerDescriptor: defaultProviderBinding.descriptor,
      agentProviders,
      tools: runtime.tools,
      permissionToolHosts: runtime.permissionToolHosts,
      defaultPermissionProfile: projectConfig.permission.profile,
      agentProfiles: projectConfig.agents,
      projectGrantStore: runtime.projectGrantStore,
      executionInfo: runtime.workspaceExecution.inspect?.() || { id: runtime.workspaceExecution.id },
      systemPrompt: runtime.systemPrompt,
      store,
      memory: store.memory,
      memoryScope,
      maxSteps: projectConfig.runtime.maxSteps,
      maxTokensPerTurn: projectConfig.runtime.maxTokensPerTurn,
      runtimeFactory: (options) => assembly.createAgentRuntime(options),
    });
    return {
      manager: projectManager,
      close: () => assembly.close(),
    };
  } catch (error) {
    await projectManager?.close();
    await assembly.close();
    throw error;
  }
}

function providerLabel(runtimeConfig) {
  return runtimeConfig.provider.type === "demo"
    ? "offline-demo"
    : `${runtimeConfig.provider.type}/${runtimeConfig.provider.model}`;
}
