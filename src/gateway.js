#!/usr/bin/env node
// FOUNDATION — local Gateway and Web console entrypoint.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeRuntimeConfig, createConfiguredProvider, inspectRuntimeConfig } from "./config/composer.js";
import { createToolRegistry } from "./tools/registry.js";
import { loadWorkspacePolicy } from "./tools/authorization.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";
import { SessionStore } from "./persistence/session-store.js";
import { GatewaySessionManager } from "./gateway/session-manager.js";
import { createGatewayServer } from "./gateway/server.js";
import { loadMcpConfig } from "./mcp/config.js";
import { connectMcpTools } from "./mcp/tool-adapter.js";
import { formatMaxSteps } from "./runtime-options.js";
import { loadLocalEnvironment } from "./local-environment.js";
import { createLocalMemoryScope } from "./memory/scope.js";

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
const provider = createConfiguredProvider(config);
const context = await loadWorkspaceContext(workspace);
const mcp = await connectMcpTools(await loadMcpConfig(config.mcp.file, workspace));
const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace, memoryScope });
const tools = createToolRegistry({
  workspace,
  bundledSkills: path.resolve(here, "../skills"),
  extraTools: mcp.tools,
  memory: store.memory,
  memoryScope,
});
const manager = new GatewaySessionManager({
  workspace,
  provider,
  tools,
  workspacePolicy: await loadWorkspacePolicy(workspace),
  systemPrompt: buildSystemPrompt(context),
  store,
  memory: store.memory,
  maxSteps: config.runtime.maxSteps,
});
const gateway = createGatewayServer({ manager, port: config.gateway.port, staticRoot: path.resolve(here, "web") });
let address;
try {
  address = await gateway.listen();
} catch (error) {
  await manager.close();
  store.close();
  await mcp.close();
  throw error;
}

console.log(`Nexus Gateway (${provider.name}) 正在监听 ${address.url}`);
if (mcp.servers.length) console.log(`已连接 MCP：${mcp.servers.join(", ")}（${mcp.tools.length} 个工具）`);
console.log(`Web 控制台：${address.url}/`);
console.log(`单次任务步骤上限：${formatMaxSteps(config.runtime.maxSteps)}（仍受单轮 Token 预算约束）`);
console.log("仅允许本机连接。按 Ctrl+C 安全退出。");

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    if (closing) return;
    closing = true;
    console.log("\n正在关闭 Gateway；未决审批将被拒绝……");
    await gateway.close();
    store.close();
    await mcp.close();
  });
}
