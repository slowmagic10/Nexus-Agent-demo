#!/usr/bin/env node
// PROTOTYPE — 用来验证 Agent Harness 状态模型，确认方向后应吸收核心并删除 TUI 外壳。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, reduceSession } from "./core/state.js";
import { AgentRuntime } from "./core/agent.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { DemoProvider } from "./providers/demo.js";
import { createToolRegistry } from "./tools/registry.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";
import { TerminalUI, helpText } from "./ui.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const workspaceArg = args.find((arg) => arg.startsWith("--workspace="))?.split("=").slice(1).join("=");
const workspace = path.resolve(workspaceArg || path.resolve(here, ".."));
const forceDemo = args.includes("--demo");
const provider = !forceDemo && process.env.OPENAI_API_KEY
  ? new OpenAICompatibleProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    })
  : new DemoProvider();

const context = await loadWorkspaceContext(workspace);
const tools = createToolRegistry({ workspace, bundledSkills: path.resolve(here, "../skills") });
const ui = new TerminalUI();
const initialState = createSession({ provider: provider.name, workspace });
const runtime = new AgentRuntime({
  state: initialState,
  reducer: reduceSession,
  provider,
  tools,
  systemPrompt: buildSystemPrompt(context),
  onState: (state) => ui.render(state),
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

  await runtime.runTurn(input, (call, description) => ui.approve(call, description, runtime.state));
  ui.answerFrom(runtime.state);
  ui.render(runtime.state);
}

ui.close();
console.log("已退出 Nexus 原型；会话内存已清空。");
