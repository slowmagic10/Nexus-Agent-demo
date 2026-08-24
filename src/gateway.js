#!/usr/bin/env node
// FOUNDATION — local Gateway and Web console entrypoint.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DemoProvider } from "./providers/demo.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { createToolRegistry } from "./tools/registry.js";
import { loadWorkspacePolicy } from "./tools/authorization.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";
import { SessionStore } from "./persistence/session-store.js";
import { GatewaySessionManager } from "./gateway/session-manager.js";
import { createGatewayServer } from "./gateway/server.js";
import { loadMcpConfig } from "./mcp/config.js";
import { connectMcpTools } from "./mcp/tool-adapter.js";
import { formatMaxSteps, readRuntimeOptions } from "./runtime-options.js";
import { loadLocalEnvironment } from "./local-environment.js";
import { createLocalMemoryScope } from "./memory/scope.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadLocalEnvironment(path.resolve(here, ".."));
const args = process.argv.slice(2);
const workspaceArg = valueArg(args, "workspace");
const portArg = valueArg(args, "port");
const mcpConfigArg = valueArg(args, "mcp");
const workspace = path.resolve(workspaceArg || path.resolve(here, ".."));
const memoryScope = createLocalMemoryScope(workspace);
const port = portArg ? Number(portArg) : 4317;
const runtimeOptions = readRuntimeOptions(args, process.env);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port 必须是 0 到 65535 的整数");

const provider = !args.includes("--demo") && process.env.OPENAI_API_KEY
  ? new OpenAICompatibleProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    })
  : new DemoProvider();
const context = await loadWorkspaceContext(workspace);
const mcp = await connectMcpTools(await loadMcpConfig(mcpConfigArg, workspace));
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
  maxSteps: runtimeOptions.maxSteps,
});
const gateway = createGatewayServer({ manager, port, staticRoot: path.resolve(here, "web") });
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
console.log(`单次任务步骤上限：${formatMaxSteps(runtimeOptions.maxSteps)}（仍受单轮 Token 预算约束）`);
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

function valueArg(values, name) {
  return values.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}
