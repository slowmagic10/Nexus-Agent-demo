#!/usr/bin/env node
// FOUNDATION — local CLI over the shared Agent runtime.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { createSession, reduceSession } from "./core/state.js";
import { AgentRuntime } from "./core/agent.js";
import { AgentSession } from "./core/session.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { DemoProvider } from "./providers/demo.js";
import { createToolRegistry } from "./tools/registry.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";
import { TerminalUI, helpText } from "./ui.js";
import { SessionStore } from "./persistence/session-store.js";
import { loadMcpConfig } from "./mcp/config.js";
import { connectMcpTools } from "./mcp/tool-adapter.js";
import { readRuntimeOptions } from "./runtime-options.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const workspaceArg = args.find((arg) => arg.startsWith("--workspace="))?.split("=").slice(1).join("=");
const mcpConfigArg = args.find((arg) => arg.startsWith("--mcp="))?.slice("--mcp=".length);
const workspace = path.resolve(workspaceArg || path.resolve(here, ".."));
const forceDemo = args.includes("--demo");
const resumeArg = args.find((arg) => arg === "--resume" || arg.startsWith("--resume="));
const resumeTarget = resumeArg === "--resume" ? "latest" : resumeArg?.slice("--resume=".length);
const importFile = args.find((arg) => arg.startsWith("--import="))?.slice("--import=".length);
const importAs = args.find((arg) => arg.startsWith("--import-as="))?.slice("--import-as=".length);
const listOnly = args.includes("--sessions");
const runtimeOptions = readRuntimeOptions(args, process.env);
const provider = !forceDemo && process.env.OPENAI_API_KEY
  ? new OpenAICompatibleProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    })
  : new DemoProvider();

const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"));

if (listOnly) {
  printSessions(store.list(workspace));
  store.close();
  process.exit(0);
}

if (importFile) {
  try {
    const archive = JSON.parse(await fs.readFile(path.resolve(importFile), "utf8"));
    const imported = store.importJournal(archive, { id: importAs, workspace });
    console.log(`已导入会话 ${imported.id}（${store.latestSessionCursor(imported.id)} 个 durable events）到 ${workspace}`);
    store.close();
    process.exit(0);
  } catch (error) {
    store.close();
    console.error(`导入失败：${error.message}`);
    process.exit(1);
  }
}

if (importAs) {
  store.close();
  console.error("--import-as 必须与 --import 一起使用");
  process.exit(1);
}

const context = await loadWorkspaceContext(workspace);

const mcp = await connectMcpTools(await loadMcpConfig(mcpConfigArg, workspace));
const tools = createToolRegistry({
  workspace,
  bundledSkills: path.resolve(here, "../skills"),
  extraTools: mcp.tools,
  memoryStore: store,
});
const ui = new TerminalUI();
let initialState = resumeTarget === "latest"
  ? store.latest(workspace)
  : resumeTarget
    ? store.load(resumeTarget)
    : null;

if (resumeTarget && !initialState) {
  store.close();
  ui.close();
  await mcp.close();
  console.error(resumeTarget === "latest" ? "没有可恢复的会话。" : `未找到会话：${resumeTarget}`);
  process.exit(1);
}

const resumed = Boolean(initialState);
initialState ||= createSession({ provider: provider.name, workspace });
const session = new AgentSession({ state: initialState, reducer: reduceSession, journal: store });
session.subscribe((state) => ui.render(state));
if (resumed) {
  await session.dispatch({ type: "RESUMED", provider: provider.name, workspace });
}
const runtime = new AgentRuntime({
  session,
  provider,
  tools,
  systemPrompt: buildSystemPrompt(context),
  retrieveMemory: (query) => store.searchMemories(query, 5),
  maxSteps: runtimeOptions.maxSteps,
});

ui.render(runtime.state);
while (true) {
  const answer = await ui.question("\n你 › ");
  if (answer === null) break;
  const input = answer.trim();
  if (!input) continue;
  if (input === "/quit") break;
  if (input === "/help") {
    ui.lastAnswer = helpText();
    ui.render(runtime.state);
    continue;
  }
  if (input === "/state") {
    ui.lastAnswer = JSON.stringify(runtime.state, null, 2);
    ui.render(runtime.state);
    continue;
  }
  if (input === "/events") {
    ui.lastAnswer = runtime.state.events.slice(-20).map((event) => `${event.seq}. ${event.type} ${event.tool || ""}`).join("\n") || "暂无事件";
    ui.render(runtime.state);
    continue;
  }
  if (input === "/memory") {
    ui.lastAnswer = runtime.state.memory.map((item, index) => `${index + 1}. ${item.content}`).join("\n") || "记忆为空";
    ui.render(runtime.state);
    continue;
  }
  if (input === "/long-memory") {
    ui.lastAnswer = formatMemories(store.searchMemories("", 50));
    ui.render(runtime.state);
    continue;
  }
  if (input === "/sessions") {
    ui.lastAnswer = formatSessions(store.list(workspace));
    ui.render(runtime.state);
    continue;
  }
  if (input === "/export") {
    const exportDir = path.join(workspace, ".nexus", "exports");
    const exportFile = path.join(exportDir, `${runtime.state.id}.journal.json`);
    const archive = store.exportJournal(runtime.state.id);
    await fs.mkdir(exportDir, { recursive: true });
    await fs.writeFile(exportFile, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
    ui.lastAnswer = `可重放 journal 已导出：${exportFile}`;
    ui.render(runtime.state);
    continue;
  }

  await runtime.runTurn(input, (call, description) => ui.approve(call, description, runtime.state));
  ui.answerFrom(runtime.state);
  ui.render(runtime.state);
}

ui.close();
store.close();
await mcp.close();
console.log(`已退出 Nexus 基础版；会话 ${runtime.state.id} 已保存。`);

function printSessions(sessions) {
  console.log(formatSessions(sessions));
}

function formatSessions(sessions) {
  return sessions.length
    ? sessions.map((session) => `${session.id}\t${session.phase}\t${session.messageCount} 条消息\t${session.updatedAt}`).join("\n")
    : "暂无已保存会话。";
}

function formatMemories(memories) {
  return memories.map((item) => `${item.id}\t${item.tags.join(",")}\t${item.content}`).join("\n") || "长期记忆为空。";
}
