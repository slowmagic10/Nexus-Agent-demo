export const SESSION_EVALUATION_VERSION = "session-evaluation-v1";

const RUNNING_PHASES = new Set(["thinking", "executing", "awaiting_approval"]);

export function evaluateSession(state) {
  if (!state || typeof state !== "object" || typeof state.id !== "string" || !Array.isArray(state.events)) {
    throw new Error("Session Evaluation 需要包含 id 与 events 的 Session state");
  }
  const events = state.events;
  const ofType = (type) => events.filter((event) => event.type === type);
  const toolCompleted = ofType("tool.completed");
  const toolSucceeded = toolCompleted.filter((event) => event.ok === true);
  const toolFailed = toolCompleted.filter((event) => event.ok !== true);
  const contextPlans = events.filter((event) => ["model.context_prepared", "model.context_compacted"].includes(event.type));
  const memoryLoaded = ofType("memory.context_loaded");
  const issues = collectIssues(state, events, {
    toolFailed: toolFailed.length,
    validationFailed: ofType("tool.validation_failed").length,
    capabilityUnavailable: ofType("tool.capability_unavailable").length,
  });
  const planSteps = Array.isArray(state.plan?.steps) ? state.plan.steps : [];
  const delegations = Array.isArray(state.delegations) ? state.delegations : [];

  return {
    version: SESSION_EVALUATION_VERSION,
    sessionId: state.id,
    cursor: safeInteger(events.at(-1)?.seq),
    status: reportStatus(state.phase, state.objective?.status, issues),
    phase: state.phase || "unknown",
    objective: {
      status: state.objective?.status || null,
      planRevision: safeInteger(state.plan?.revision),
      completedSteps: planSteps.filter((step) => step.status === "completed").length,
      totalSteps: planSteps.length,
    },
    tools: {
      requested: ofType("tool.requested").length,
      completed: toolCompleted.length,
      succeeded: toolSucceeded.length,
      failed: toolFailed.length,
      executionUnknown: ofType("tool.execution_unknown").length,
      validationFailed: ofType("tool.validation_failed").length,
      capabilityUnavailable: ofType("tool.capability_unavailable").length,
      successRate: ratio(toolSucceeded.length, toolCompleted.length),
    },
    approvals: {
      requested: ofType("approval.requested").length,
      granted: ofType("approval.granted").length,
      denied: ofType("approval.denied").length,
      stale: ofType("approval.stale").length,
    },
    context: {
      plans: contextPlans.length,
      compacted: ofType("model.context_compacted").length,
      replanned: ofType("context.replanned").length,
      replanExhausted: ofType("context.replan_exhausted").length,
      summaryCompleted: ofType("context.summary_completed").length,
      summaryDegraded: ofType("context.summary_degraded").length,
      maxUtilizationPercent: maxContextUtilization(contextPlans),
      latestContextHash: contextPlans.at(-1)?.contextHash || null,
      historyProjected: contextPlans.filter((plan) => plan.historyProjection?.applied === true).length,
      historySavedTokens: contextPlans.reduce(
        (total, plan) => total + safeInteger(plan.historyProjection?.savedTokens),
        0,
      ),
      latestHistorySavedTokens: safeInteger(contextPlans.at(-1)?.historyProjection?.savedTokens),
      activeToolProjected: contextPlans.filter((plan) => plan.activeToolProjection?.applied === true).length,
      activeToolSavedTokens: contextPlans.reduce(
        (total, plan) => total + safeInteger(plan.activeToolProjection?.savedTokens),
        0,
      ),
      latestActiveToolSavedTokens: safeInteger(contextPlans.at(-1)?.activeToolProjection?.savedTokens),
    },
    memory: {
      retrievals: memoryLoaded.length,
      retrievalDegraded: memoryLoaded.filter((event) => event.status && event.status !== "ok").length,
      pinnedHits: sum(memoryLoaded, "pinnedCount"),
      relevantHits: sum(memoryLoaded, "relevantCount"),
      flushCompleted: ofType("memory.flush_completed").length,
      flushDegraded: ofType("memory.flush_degraded").length,
      mutationIssues: Array.isArray(state.memoryMutationIssues) ? state.memoryMutationIssues.length : 0,
    },
    delegations: {
      total: delegations.length,
      completed: delegations.filter((item) => item.status === "completed").length,
      failed: delegations.filter((item) => ["failed", "cancelled", "interrupted"].includes(item.status)).length,
    },
    metrics: normalizeMetrics(state.metrics),
    issues,
  };
}

function collectIssues(state, events, counts) {
  const issues = [];
  const add = (code, severity, label, count, eventType = null) => {
    if (!count) return;
    const event = eventType ? events.findLast((candidate) => candidate.type === eventType) : null;
    issues.push({ code, severity, label, count, eventSeq: safeInteger(event?.seq) || null });
  };
  const sessionFailed = state.phase === "failed" || state.objective?.status === "failed";
  const failedEventType = events.some((event) => event.type === "session.failed") ? "session.failed" : "objective.failed";
  add("session_failed", "high", "任务以失败状态结束", sessionFailed ? 1 : 0, failedEventType);
  add("context_replan_exhausted", "high", "Context 自动缩减后仍超限", count(events, "context.replan_exhausted"), "context.replan_exhausted");
  add("execution_unknown", "high", "存在执行结果未知的工具调用", count(events, "tool.execution_unknown"), "tool.execution_unknown");
  add("tool_failed", "medium", "存在失败的工具结果", counts.toolFailed, "tool.completed");
  add("tool_validation_failed", "medium", "模型产生了无效工具参数", counts.validationFailed, "tool.validation_failed");
  add("tool_capability_unavailable", "medium", "工具能力在执行前不可用", counts.capabilityUnavailable, "tool.capability_unavailable");
  add("memory_mutation_issue", "medium", "存在待处理的 Memory mutation", state.memoryMutationIssues?.length || 0);
  add("summary_degraded", "low", "Context 摘要生成发生降级", count(events, "context.summary_degraded"), "context.summary_degraded");
  add("memory_retrieval_degraded", "low", "长期记忆检索发生降级", events.filter((event) => event.type === "memory.context_loaded" && event.status && event.status !== "ok").length, "memory.context_loaded");
  add("memory_flush_degraded", "low", "记忆候选提取发生降级", count(events, "memory.flush_degraded"), "memory.flush_degraded");
  if (["idle", "completed"].includes(state.phase) && ["active", "paused"].includes(state.objective?.status)) {
    add("objective_incomplete", "medium", "Objective 尚未闭合", 1);
  }
  return issues.sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.code.localeCompare(right.code));
}

function reportStatus(phase, objectiveStatus, issues) {
  if (phase === "failed" || objectiveStatus === "failed") return "failed";
  if (phase === "cancelled" || objectiveStatus === "cancelled") return "cancelled";
  if (RUNNING_PHASES.has(phase)) return "running";
  if (issues.some((issue) => ["high", "medium"].includes(issue.severity))) return "attention";
  if (phase === "completed" || objectiveStatus === "completed") return "healthy";
  return "idle";
}

function maxContextUtilization(plans) {
  let maximum = 0;
  for (const plan of plans) {
    if (!Number.isFinite(plan.maxInputTokens) || plan.maxInputTokens <= 0 || !Number.isFinite(plan.estimatedInputTokens)) continue;
    maximum = Math.max(maximum, Math.round((plan.estimatedInputTokens / plan.maxInputTokens) * 100));
  }
  return maximum;
}

function normalizeMetrics(metrics = {}) {
  return {
    modelCalls: safeInteger(metrics.modelCalls),
    toolCalls: safeInteger(metrics.toolCalls),
    approvals: safeInteger(metrics.approvals),
    inputTokens: safeInteger(metrics.inputTokens),
    outputTokens: safeInteger(metrics.outputTokens),
    totalTokens: safeInteger(metrics.totalTokens),
    modelDurationMs: safeInteger(metrics.modelDurationMs),
    toolDurationMs: safeInteger(metrics.toolDurationMs),
    lastTurnDurationMs: safeInteger(metrics.lastTurnDurationMs),
  };
}

function count(events, type) {
  return events.filter((event) => event.type === type).length;
}

function sum(events, field) {
  return events.reduce((total, event) => total + safeInteger(event[field]), 0);
}

function ratio(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 100) : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function severityRank(severity) {
  return ({ high: 0, medium: 1, low: 2 })[severity] ?? 3;
}
