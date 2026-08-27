#!/usr/bin/env node
// FOUNDATION — local CLI over the shared Agent runtime.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { createSession, reduceSession } from "./core/state.js";
import { AgentRuntime } from "./core/agent.js";
import { AgentSession } from "./core/session.js";
import { CapabilityRuntime } from "./capabilities/runtime.js";
import { composeRuntimeConfig, createConfiguredProvider, inspectRuntimeConfig } from "./config/composer.js";
import { createToolRegistry } from "./tools/registry.js";
import { ToolHost } from "./tools/host.js";
import { loadWorkspacePolicy } from "./tools/authorization.js";
import { loadWorkspaceContext, buildSystemPrompt } from "./workspace.js";
import { TerminalUI, helpText } from "./ui.js";
import { SessionStore } from "./persistence/session-store.js";
import { loadMcpConfig } from "./mcp/config.js";
import { connectMcpTools } from "./mcp/tool-adapter.js";
import { loadLocalEnvironment } from "./local-environment.js";
import { createLocalMemoryScope } from "./memory/scope.js";
import { createWorkspaceExecution } from "./execution/factory.js";
import { createPermissionProfile } from "./tools/permission-profile.js";
import { createModelMemoryExtractor, MemoryFlushPolicy } from "./memory/flush-policy.js";
import { defaultProjectGrantStoreFile, ProjectGrantStore } from "./tools/project-grant-store.js";
import {
  discardMemoryMutation,
  reconcileMemoryOutbox,
  resolveMemoryMutation,
  retryMemoryMutation,
} from "./memory/outbox.js";

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
const resumeArg = args.find((arg) => arg === "--resume" || arg.startsWith("--resume="));
const resumeTarget = resumeArg === "--resume" ? "latest" : resumeArg?.slice("--resume=".length);
const importFile = args.find((arg) => arg.startsWith("--import="))?.slice("--import=".length);
const importAs = args.find((arg) => arg.startsWith("--import-as="))?.slice("--import-as=".length);
const listOnly = args.includes("--sessions");
const provider = createConfiguredProvider(config);

const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace, memoryScope });

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

const capabilityRuntime = new CapabilityRuntime();
const workspaceExecution = createWorkspaceExecution(config, { environment: process.env });
const permissionProfile = createPermissionProfile({
  name: config.permission.profile,
  workspace,
  executionType: config.execution.type,
  networkTargets: config.network.targets,
});
const tools = createToolRegistry({
  workspace,
  bundledSkills: path.resolve(here, "../skills"),
  memory: store.memory,
  capabilityRuntime,
  workspaceExecution,
  accessPolicy: permissionProfile,
});
const mcp = await connectMcpTools(await loadMcpConfig(config.mcp.file, workspace), { capabilityRuntime });
const projectGrantStore = new ProjectGrantStore(defaultProjectGrantStoreFile(process.env));
const toolHost = new ToolHost({
  registry: tools,
  policy: await loadWorkspacePolicy(workspace, { profile: permissionProfile }),
  projectGrantStore,
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
  projectGrantStore.close();
  console.error(resumeTarget === "latest" ? "没有可恢复的会话。" : `未找到会话：${resumeTarget}`);
  process.exit(1);
}

const resumed = Boolean(initialState);
initialState ||= createSession({ provider: provider.name, workspace, memoryScope });
const session = new AgentSession({ state: initialState, reducer: reduceSession, journal: store });
const memoryFlushPolicy = new MemoryFlushPolicy({
  memory: store.memory,
  extractCandidates: createModelMemoryExtractor(provider),
});
session.subscribe((state) => ui.render(state));
if (resumed) {
  await reconcileMemoryOutbox({ session, memory: store.memory });
  await session.dispatch({ type: "RESUMED", provider: provider.name, workspace });
}
const runtime = new AgentRuntime({
  session,
  provider,
  toolHost,
  systemPrompt: buildSystemPrompt(context),
  retrieveMemory: (query, { signal } = {}) => store.memory.search(query, {
    scope: session.state.memoryScope,
    signal,
  }, { limit: 5 }),
  reconcile: ({ signal } = {}) => reconcileMemoryOutbox({ session, memory: store.memory, signal }),
  flushMemory: (input) => memoryFlushPolicy.flush(input),
  maxSteps: config.runtime.maxSteps,
  maxTokensPerTurn: config.runtime.maxTokensPerTurn,
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
    ui.lastAnswer = formatMemories(await store.memory.search("", { scope: runtime.state.memoryScope }, { limit: 50 }));
    ui.render(runtime.state);
    continue;
  }
  if (input.startsWith("/memory-info=")) {
    const id = input.slice("/memory-info=".length).trim();
    ui.lastAnswer = id ? formatMemoryVerification(await store.memory.verify(id, { scope: runtime.state.memoryScope })) : "请提供 Memory ID。";
    ui.render(runtime.state);
    continue;
  }
  if (input.startsWith("/forget=")) {
    const id = input.slice("/forget=".length).trim();
    ui.lastAnswer = !id
      ? "请提供 Memory ID。"
      : await store.memory.delete(id, "用户通过 CLI 请求删除", {
          scope: runtime.state.memoryScope,
          provenance: { origin: "user_explicit", actor: runtime.state.memoryScope.userId },
        })
        ? `已软删除长期记忆：${id}`
        : `未找到可删除的长期记忆：${id}`;
    ui.render(runtime.state);
    continue;
  }
  if (input === "/memory-issues") {
    ui.lastAnswer = formatMemoryIssues(runtime.state.memoryMutationIssues);
    ui.render(runtime.state);
    continue;
  }
  if (input.startsWith("/memory-retry=")) {
    const mutationId = input.slice("/memory-retry=".length).trim();
    try {
      const result = await retryMemoryMutation({ session, memory: store.memory, mutationId });
      ui.lastAnswer = `Memory mutation 已重试成功：${mutationId}${result?.id ? ` → ${result.id}` : ""}`;
    } catch (error) {
      ui.lastAnswer = `Memory mutation 重试失败：${error.message}`;
    }
    ui.render(runtime.state);
    continue;
  }
  if (input.startsWith("/memory-discard=")) {
    const mutationId = input.slice("/memory-discard=".length).trim();
    try {
      await discardMemoryMutation({ session, mutationId, reason: "用户通过 CLI 放弃" });
      ui.lastAnswer = `Memory mutation 已放弃：${mutationId}`;
    } catch (error) {
      ui.lastAnswer = `Memory mutation 放弃失败：${error.message}`;
    }
    ui.render(runtime.state);
    continue;
  }
  if (input.startsWith("/memory-resolve=")) {
    const [mutationId, memoryId] = input.slice("/memory-resolve=".length).split(",").map((value) => value.trim());
    try {
      await resolveMemoryMutation({ session, mutationId, memoryId: memoryId || null });
      ui.lastAnswer = `Memory mutation 已人工确认完成：${mutationId}`;
    } catch (error) {
      ui.lastAnswer = `Memory mutation 处理失败：${error.message}`;
    }
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
projectGrantStore.close();
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
  return memories.map((item) => {
    const source = item.sourceSession
      ? `${item.sourceSession}${item.sourceCursor ? `#${item.sourceCursor}` : ""}`
      : item.provenance?.origin || "unknown";
    return `${item.id}\t${item.kind}/${item.status}\t${source}\t${item.tags.join(",")}\t${item.content}`;
  }).join("\n") || "长期记忆为空。";
}

function formatMemoryVerification(verification) {
  if (!verification) return "未找到该长期记忆。";
  const { record, events } = verification;
  return [
    `ID：${record.id}`,
    `状态：${record.status} · 类型：${record.kind} · 版本：${record.version}`,
    `作用域：${JSON.stringify(record.scope)}`,
    `来源：${record.sourceSession || record.provenance.origin}${record.sourceCursor ? `#${record.sourceCursor}` : ""}`,
    `可信度：${record.confidence}`,
    `内容：${record.content}`,
    "审计：",
    ...events.map((event) => `- ${event.seq} ${event.at} ${event.type} ${JSON.stringify(event.detail)}`),
  ].join("\n");
}

function formatMemoryIssues(issues) {
  return issues.map((issue) => (
    `${issue.mutation.id}\t${issue.status}/${issue.outcome || "unknown"}\t${issue.mutation.operation}\t${issue.retryPolicy}\t${issue.error || ""}`
  )).join("\n") || "没有待处理的 Memory mutation。";
}
