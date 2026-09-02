#!/usr/bin/env node
// FOUNDATION — local CLI over the shared Agent runtime.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { createSession, reduceSession } from "./core/state.js";
import { createAgentProfileSnapshot } from "./core/agent-profile.js";
import { appendAgentInstructions } from "./core/named-agent-profiles.js";
import { AgentSession } from "./core/session.js";
import { composeRuntimeConfig, inspectRuntimeConfig } from "./config/composer.js";
import { TerminalUI, helpText } from "./ui.js";
import { loadLocalEnvironment } from "./local-environment.js";
import { createMemoryScope } from "./memory/scope.js";
import { evaluateSession } from "./evaluation/session-evaluation.js";
import { compareReplayEvaluations, evaluateJournalArchive } from "./evaluation/replay-harness.js";
import { runScenarioEvaluation } from "./evaluation/scenario-harness.js";
import { loadScenarioSuiteDirectory, runScenarioSuite } from "./evaluation/scenario-suite.js";
import { compareScenarioSuiteReports } from "./evaluation/scenario-suite-comparison.js";
import { createRuntimeAssembly } from "./runtime/assembly.js";
import {
  discardMemoryMutation,
  executeMemoryMutation,
  reconcileMemoryOutbox,
  resolveMemoryMutation,
  retryMemoryMutation,
} from "./memory/outbox.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const evaluationArchiveFile = args.find((arg) => arg.startsWith("--evaluate-archive="))?.slice("--evaluate-archive=".length);
const comparisonArchiveFile = args.find((arg) => arg.startsWith("--compare-archive="))?.slice("--compare-archive=".length);
const evaluationScenarioFile = args.find((arg) => arg.startsWith("--evaluate-scenario="))?.slice("--evaluate-scenario=".length);
const evaluationSuiteDirectory = args.find((arg) => arg.startsWith("--evaluate-suite="))?.slice("--evaluate-suite=".length);
const suiteTags = args.find((arg) => arg.startsWith("--suite-tags="))?.slice("--suite-tags=".length);
const suiteBaselineFile = args.find((arg) => arg.startsWith("--suite-baseline="))?.slice("--suite-baseline=".length);
const suiteTokenTolerance = args.find((arg) => arg.startsWith("--suite-token-tolerance="))?.slice("--suite-token-tolerance=".length);
for (const [flag, value] of Object.entries({
  "--evaluate-archive": evaluationArchiveFile,
  "--compare-archive": comparisonArchiveFile,
  "--evaluate-scenario": evaluationScenarioFile,
  "--evaluate-suite": evaluationSuiteDirectory,
  "--suite-baseline": suiteBaselineFile,
  "--suite-token-tolerance": suiteTokenTolerance,
})) {
  if (value === "") {
    console.error(`${flag} 不能为空`);
    process.exit(1);
  }
}
const evaluationModes = [evaluationArchiveFile || comparisonArchiveFile, evaluationScenarioFile, evaluationSuiteDirectory].filter(Boolean);
if (evaluationModes.length > 1) {
  console.error("Archive、Scenario 和 Scenario Suite 评测参数不能同时使用");
  process.exit(1);
}
if ((suiteTags !== undefined || suiteBaselineFile !== undefined || suiteTokenTolerance !== undefined) && !evaluationSuiteDirectory) {
  console.error("--suite-tags、--suite-baseline 和 --suite-token-tolerance 必须与 --evaluate-suite 一起使用");
  process.exit(1);
}
if (suiteTokenTolerance !== undefined && suiteBaselineFile === undefined) {
  console.error("--suite-token-tolerance 必须与 --suite-baseline 一起使用");
  process.exit(1);
}
if (evaluationSuiteDirectory) {
  try {
    const suite = await loadScenarioSuiteDirectory(path.resolve(evaluationSuiteDirectory));
    const report = await runScenarioSuite(suite, { includeTags: suiteTags || [] });
    const output = suiteBaselineFile !== undefined
      ? {
          current: report,
          comparison: compareScenarioSuiteReports(
            JSON.parse(await fs.readFile(path.resolve(suiteBaselineFile), "utf8")),
            report,
            { maxTokenIncreasePercent: suiteTokenTolerance === undefined ? 0 : Number(suiteTokenTolerance) },
          ),
        }
      : report;
    console.log(JSON.stringify(output, null, 2));
    process.exit(report.passed && (!output.comparison || output.comparison.passed) ? 0 : 2);
  } catch (error) {
    console.error(`场景套件评测失败：${error.message}`);
    process.exit(1);
  }
}
if (evaluationScenarioFile) {
  try {
    const report = await runScenarioEvaluation(JSON.parse(await fs.readFile(path.resolve(evaluationScenarioFile), "utf8")));
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.passed ? 0 : 2);
  } catch (error) {
    console.error(`场景评测失败：${error.message}`);
    process.exit(1);
  }
}
if (evaluationArchiveFile || comparisonArchiveFile) {
  if (!evaluationArchiveFile) {
    console.error("--compare-archive 必须与 --evaluate-archive 一起使用");
    process.exit(1);
  }
  try {
    const primary = evaluateJournalArchive(JSON.parse(await fs.readFile(path.resolve(evaluationArchiveFile), "utf8")));
    const output = comparisonArchiveFile
      ? {
          primary,
          comparison: compareReplayEvaluations(
            primary,
            evaluateJournalArchive(JSON.parse(await fs.readFile(path.resolve(comparisonArchiveFile), "utf8"))),
          ),
        }
      : primary;
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`离线评测失败：${error.message}`);
    process.exit(1);
  }
}
const localEnvironment = loadLocalEnvironment(root);
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
const { workspace, baseMemoryScope, agentProviders, store } = assembly;
const resumeArg = args.find((arg) => arg === "--resume" || arg.startsWith("--resume="));
const resumeTarget = resumeArg === "--resume" ? "latest" : resumeArg?.slice("--resume=".length);
const importFile = args.find((arg) => arg.startsWith("--import="))?.slice("--import=".length);
const importAs = args.find((arg) => arg.startsWith("--import-as="))?.slice("--import-as=".length);
const listOnly = args.includes("--sessions");

if (listOnly) {
  printSessions(store.list(workspace));
  await assembly.close();
  process.exit(0);
}

if (importFile) {
  try {
    const archive = JSON.parse(await fs.readFile(path.resolve(importFile), "utf8"));
    const imported = store.importJournal(archive, { id: importAs, workspace });
    console.log(`已导入会话 ${imported.id}（${store.latestSessionCursor(imported.id)} 个 durable events）到 ${workspace}`);
    await assembly.close();
    process.exit(0);
  } catch (error) {
    await assembly.close();
    console.error(`导入失败：${error.message}`);
    process.exit(1);
  }
}

if (importAs) {
  await assembly.close();
  console.error("--import-as 必须与 --import 一起使用");
  process.exit(1);
}

let initialState = resumeTarget === "latest"
  ? store.latest(workspace)
  : resumeTarget
    ? store.load(resumeTarget)
    : null;

if (resumeTarget && !initialState) {
  await assembly.close();
  console.error(resumeTarget === "latest" ? "没有可恢复的会话。" : `未找到会话：${resumeTarget}`);
  process.exit(1);
}

const explicitAgentProfile = ["cli", "environment", "local_environment"].includes(config.sources["agents.default"]);
const resumedAgentProfileId = initialState?.agentProfile?.id;
if (resumedAgentProfileId && explicitAgentProfile && resumedAgentProfileId !== config.agents.defaultProfile) {
  await assembly.close();
  console.error("恢复会话时不能覆盖其 Agent Profile。");
  process.exit(1);
}
const selectedAgentProfileId = resumedAgentProfileId || config.agents.defaultProfile;
const selectedAgentProfile = config.agents.profiles.find((profile) => profile.id === selectedAgentProfileId);
if (!selectedAgentProfile) {
  await assembly.close();
  console.error(`会话绑定的 Agent Profile 已不可用：${selectedAgentProfileId}`);
  process.exit(1);
}
const memoryScope = selectedAgentProfile.id === "default"
  ? baseMemoryScope
  : createMemoryScope({ ...baseMemoryScope, agentId: selectedAgentProfile.id });
const selectedProviderBinding = agentProviders.get(selectedAgentProfile.id);
const provider = selectedProviderBinding.provider;
const activated = await assembly.activate({
  defaultPermissionProfile: selectedAgentProfile.permissionProfile,
  permissionProfileNames: [selectedAgentProfile.permissionProfile],
});
const { tools, toolHost, permissionProfile, workspaceExecution } = activated;
const systemPrompt = appendAgentInstructions(activated.systemPrompt, selectedAgentProfile.instructions);
const agentProfile = createAgentProfileSnapshot({
  id: selectedAgentProfile.id,
  provider: {
    ...selectedProviderBinding.descriptor,
  },
  workspace,
  systemPrompt,
  toolSchemas: tools.schemas(),
  permission: {
    defaultProfile: permissionProfile.name,
    profiles: [{ name: permissionProfile.name, policyVersion: toolHost.policy.version }],
  },
  execution: workspaceExecution.inspect?.() || { id: workspaceExecution.id },
  memoryScope,
  budgets: {
    maxSteps: selectedAgentProfile.maxSteps,
    maxTokensPerTurn: selectedAgentProfile.maxTokensPerTurn,
  },
});
const ui = new TerminalUI();
const resumed = Boolean(initialState);
initialState ||= createSession({ provider: provider.name, workspace, memoryScope, agentProfile });
const session = new AgentSession({ state: initialState, reducer: reduceSession, journal: store });
session.subscribe((state) => ui.render(state));
if (resumed) {
  await reconcileMemoryOutbox({ session, memory: store.memory });
  await session.dispatch({
    type: "RESUMED",
    provider: provider.name,
    workspace,
    agentProfile,
    profileReason: "cli_resume",
  });
}
const runtime = assembly.createAgentRuntime({
  session,
  provider,
  toolHost,
  systemPrompt,
  maxSteps: selectedAgentProfile.maxSteps,
  maxTokensPerTurn: selectedAgentProfile.maxTokensPerTurn,
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
  if (input === "/evaluation") {
    ui.lastAnswer = formatSessionEvaluation(evaluateSession(runtime.state));
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
  if (input.startsWith("/pin=") || input.startsWith("/unpin=")) {
    const pinned = input.startsWith("/pin=");
    const prefix = pinned ? "/pin=" : "/unpin=";
    const id = input.slice(prefix.length).trim();
    try {
      ui.lastAnswer = id
        ? await setMemoryPinned({ memory: store.memory, session, memoryId: id, pinned })
        : "请提供 Memory ID。";
    } catch (error) {
      ui.lastAnswer = `${pinned ? "固定" : "取消固定"}长期记忆失败：${error.message}`;
    }
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
await assembly.close();
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
    const pinned = item.pinned ? "固定" : "普通";
    return `${item.id}\t${pinned}\t${item.kind}/${item.status}\t${source}\t${item.tags.join(",")}\t${item.content}`;
  }).join("\n") || "长期记忆为空。";
}

async function setMemoryPinned({ memory, session, memoryId, pinned }) {
  const current = await memory.get(memoryId, { scope: session.state.memoryScope }, { includeInactive: true });
  if (!current || current.status !== "active") throw new Error(`未找到可固定的 active 长期记忆：${memoryId}`);
  if (current.pinned === pinned) return pinned ? `长期记忆已处于固定状态：${memoryId}` : `长期记忆已取消固定：${memoryId}`;
  await executeMemoryMutation({
    memory,
    dispatch: (action) => session.dispatch(action),
    mutation: {
      id: `${session.state.id}:memory-pin:${memoryId}:v${current.version}:${pinned ? "on" : "off"}`,
      operation: "update",
      memoryId,
      patch: { pinned },
      scope: session.state.memoryScope,
      provenance: { origin: "user_explicit", actor: session.state.memoryScope.userId },
    },
  });
  await session.dispatch({ type: "MEMORY_PIN_CHANGED", memoryId, pinned });
  return `${pinned ? "已固定" : "已取消固定"}长期记忆：${memoryId}`;
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

function formatSessionEvaluation(report) {
  const issueLines = report.issues.length
    ? report.issues.map((issue) => `- [${issue.severity}] ${issue.label}${issue.count > 1 ? ` × ${issue.count}` : ""}`)
    : ["- 未发现需要关注的问题"];
  return [
    `诊断状态：${report.status} · phase=${report.phase} · cursor=${report.cursor}`,
    `Objective：${report.objective.status || "无"} · Plan ${report.objective.completedSteps}/${report.objective.totalSteps}`,
    `工具：成功 ${report.tools.succeeded}/${report.tools.completed} · 失败 ${report.tools.failed} · 结果未知 ${report.tools.executionUnknown}`,
    `Context：规划 ${report.context.plans} · 压缩 ${report.context.compacted} · 重规划 ${report.context.replanned} · 最高占用 ${report.context.maxUtilizationPercent}%`,
    `审批：请求 ${report.approvals.requested} · 通过 ${report.approvals.granted} · 拒绝 ${report.approvals.denied}`,
    `用量：${report.metrics.totalTokens} tokens · 模型 ${report.metrics.modelDurationMs}ms · 工具 ${report.metrics.toolDurationMs}ms`,
    "问题：",
    ...issueLines,
  ].join("\n");
}
