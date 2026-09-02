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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const localEnvironment = loadLocalEnvironment(root);
const args = process.argv.slice(2);
const config = await composeRuntimeConfig({ args, env: process.env, root, localEnvironment });
if (config.printConfig) {
  console.log(JSON.stringify(inspectRuntimeConfig(config), null, 2));
  process.exit(0);
}
const assembly = await createRuntimeAssembly({
  config,
  bundledSkills: path.resolve(here, "../skills"),
  environment: process.env,
});
const { workspace, baseMemoryScope: memoryScope, agentProviders, defaultProviderBinding, store } = assembly;
const provider = defaultProviderBinding.provider;
const enabledPermissionProfiles = ["read-only", "approval-required", "workspace-confirm", "workspace-untrusted", "workspace-auto"];
if (config.execution.type === "local") enabledPermissionProfiles.push("danger-full-access");
let manager = null;
let runtime;
let gateway;
let address;
try {
  runtime = await assembly.activate({
    defaultPermissionProfile: config.permission.profile,
    permissionProfileNames: enabledPermissionProfiles,
    delegateTask: (input, toolContext) => {
      if (!manager) throw new Error("Gateway Delegation Coordinator 尚未就绪");
      return manager.delegate(toolContext.state.id, input, { signal: toolContext.signal });
    },
  });
  manager = new GatewaySessionManager({
    workspace,
    provider,
    providerDescriptor: defaultProviderBinding.descriptor,
    agentProviders,
    tools: runtime.tools,
    permissionToolHosts: runtime.permissionToolHosts,
    defaultPermissionProfile: config.permission.profile,
    agentProfiles: config.agents,
    projectGrantStore: runtime.projectGrantStore,
    executionInfo: runtime.workspaceExecution.inspect?.() || { id: runtime.workspaceExecution.id },
    systemPrompt: runtime.systemPrompt,
    store,
    memory: store.memory,
    maxSteps: config.runtime.maxSteps,
    maxTokensPerTurn: config.runtime.maxTokensPerTurn,
    runtimeFactory: (options) => assembly.createAgentRuntime(options),
  });
  gateway = createGatewayServer({ manager, port: config.gateway.port, staticRoot: path.resolve(here, "web") });
  address = await gateway.listen();
} catch (error) {
  await manager?.close();
  await assembly.close();
  throw error;
}

console.log(`Nexus Gateway (${provider.name}) 正在监听 ${address.url}`);
if (runtime.mcp.servers.length) console.log(`已连接 MCP：${runtime.mcp.servers.join(", ")}（${runtime.mcp.tools.length} 个工具）`);
console.log(`Web 控制台：${address.url}/`);
console.log(`单次任务步骤上限：${formatMaxSteps(config.runtime.maxSteps)}`);
console.log(`单次任务累计 Token 预算：${config.runtime.maxTokensPerTurn === Infinity ? "不限制" : config.runtime.maxTokensPerTurn}`);
console.log(`Workspace 执行环境：${runtime.workspaceExecution.id}`);
console.log(`权限档位：${runtime.permissionProfile.name}`);
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
    await assembly.close();
  });
}
