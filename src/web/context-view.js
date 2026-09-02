const PLAN_EVENTS = new Set(["model.context_prepared", "model.context_compacted"]);
const SUMMARY_EVENTS = new Set(["context.summary_completed", "context.summary_degraded"]);
const REPLAN_EVENTS = new Set(["context.replan_requested", "context.replanned", "context.replan_exhausted"]);

export function contextObservabilityViewModel(session = {}) {
  const events = Array.isArray(session.events) ? session.events : [];
  const plan = findLast(events, (event) => PLAN_EVENTS.has(event.type));
  const summaryEvent = findRelevantSummary(events, plan);
  const replanEvent = findRelevantReplan(events, plan);
  if (!plan && !session.contextSummary && !summaryEvent && !replanEvent) return null;

  const maxTokens = safeNumber(plan?.maxInputTokens);
  const estimatedTokens = safeNumber(plan?.estimatedInputTokens);
  const percent = maxTokens ? Math.round((estimatedTokens / maxTokens) * 100) : 0;
  const summary = summaryView(plan?.summary, session.contextSummary, summaryEvent);
  const historyProjection = historicalToolProjectionView(plan?.historyProjection);
  const activeToolProjection = activeToolProjectionView(plan?.activeToolProjection);

  return {
    plan: plan ? {
      compacted: plan.compacted === true,
      statusLabel: plan.compacted
        ? "已压缩"
        : activeToolProjection.applied
          ? "活动工具轮已精简"
          : historyProjection.applied
            ? "工具历史已精简"
            : "完整窗口",
      strategy: plan.strategy || "unknown",
      strategyLabel: strategyLabel(plan.strategy),
      at: plan.at || null,
    } : null,
    usage: {
      estimatedTokens,
      maxTokens,
      percent,
      meterPercent: Math.min(100, Math.max(0, percent)),
      level: percent >= 90 ? "danger" : percent >= 75 ? "warning" : "normal",
      fixedTokens: safeNumber(plan?.fixedTokens),
      messageTokens: safeNumber(plan?.messageTokens),
    },
    history: {
      includedMessages: safeNumber(plan?.includedMessages),
      omittedMessages: safeNumber(plan?.omittedMessages),
      includedTurns: safeNumber(plan?.includedTurns),
      omittedTurns: safeNumber(plan?.omittedTurns),
      toolProjection: historyProjection,
      activeToolProjection,
    },
    memory: {
      pinned: memoryView(plan?.memoryBudget?.pinned, plan?.pinnedMemoryHits),
      relevant: memoryView(plan?.memoryBudget?.relevant, plan?.memoryHits),
      estimatorVersion: plan?.memoryBudget?.estimatorVersion || null,
    },
    summary,
    replan: replanView(replanEvent),
    identity: {
      contextHash: plan?.contextHash || null,
      contextHashShort: shortHash(plan?.contextHash),
      contextHashVersion: plan?.contextHashVersion || null,
      estimatorVersion: plan?.estimatorVersion || null,
    },
  };
}

function activeToolProjectionView(projection = {}) {
  const savedChars = safeNumber(projection?.savedChars);
  const savedTokens = safeNumber(projection?.savedTokens) || Math.ceil(savedChars / 3);
  return {
    version: projection?.version || null,
    applied: projection?.applied === true,
    eligibleRounds: safeNumber(projection?.eligibleRounds),
    preservedRounds: safeNumber(projection?.preservedRounds),
    compactedRounds: safeNumber(projection?.compactedRounds),
    compactedToolCalls: safeNumber(projection?.compactedToolCalls),
    compactedToolResults: safeNumber(projection?.compactedToolResults),
    savedChars,
    savedTokens,
  };
}

function historicalToolProjectionView(projection = {}) {
  const savedChars = safeNumber(projection?.savedChars);
  const savedTokens = safeNumber(projection?.savedTokens) || Math.ceil(savedChars / 3);
  return {
    version: projection?.version || null,
    applied: projection?.applied === true,
    eligibleTurns: safeNumber(projection?.eligibleTurns),
    compactedToolCalls: safeNumber(projection?.compactedToolCalls),
    compactedToolResults: safeNumber(projection?.compactedToolResults),
    savedChars,
    savedTokens,
  };
}

function memoryView(budget = {}, hits = []) {
  const safeHits = Array.isArray(hits) ? hits : [];
  return {
    included: safeNumber(budget?.included) || safeHits.length,
    estimatedTokens: safeNumber(budget?.estimatedTokens),
    maxTokens: nullableNumber(budget?.maxTokens),
    truncated: safeNumber(budget?.truncated),
  };
}

function summaryView(plan = {}, stored = null, event = null) {
  const available = plan?.available === true || Boolean(stored);
  const included = plan?.included === true;
  const degraded = event?.type === "context.summary_degraded";
  let statusLabel = "尚未生成";
  if (degraded && available) statusLabel = "更新降级，沿用已有摘要";
  else if (degraded) statusLabel = "生成降级";
  else if (included) statusLabel = "已纳入本次请求";
  else if (available) statusLabel = "已保存，本次未纳入";
  return {
    available,
    included,
    degraded,
    statusLabel,
    revision: safeNumber(plan?.revision) || safeNumber(stored?.revision),
    throughMessage: safeNumber(plan?.throughMessage) || safeNumber(stored?.throughMessage),
    requiredThroughMessage: safeNumber(plan?.requiredThroughMessage),
    sourceComplete: plan?.sourceComplete ?? stored?.sourceComplete ?? null,
    omittedReason: plan?.omittedReason || null,
  };
}

function findRelevantReplan(events, plan) {
  const candidates = events.filter((event) => REPLAN_EVENTS.has(event.type));
  if (!plan) return candidates.at(-1) || null;
  if (!plan.contextHash) {
    return candidates.findLast((event) => safeNumber(event.seq) >= safeNumber(plan.seq)) || null;
  }
  return candidates.findLast((event) => (
    event.contextHash === plan.contextHash
    || event.toContextHash === plan.contextHash
    || event.fromContextHash === plan.contextHash
  )) || null;
}

function findRelevantSummary(events, plan) {
  const candidates = events.filter((event) => SUMMARY_EVENTS.has(event.type));
  if (!plan) return candidates.at(-1) || null;
  const planIndex = events.lastIndexOf(plan);
  const previousPlan = findLast(events.slice(0, planIndex), (event) => PLAN_EVENTS.has(event.type));
  const lowerBound = safeNumber(previousPlan?.seq);
  const upperBound = safeNumber(plan.seq);
  return candidates.findLast((event) => {
    const seq = safeNumber(event.seq);
    return seq > lowerBound && seq < upperBound;
  }) || null;
}

function replanView(event) {
  if (!event) return null;
  if (event.type === "context.replanned") {
    return {
      status: "replanned",
      statusLabel: "已自动重新规划",
      level: "warning",
      fromMaxInputTokens: safeNumber(event.fromMaxInputTokens),
      toMaxInputTokens: safeNumber(event.toMaxInputTokens),
      omittedMessages: safeNumber(event.omittedMessages),
      omittedTurns: safeNumber(event.omittedTurns),
    };
  }
  if (event.type === "context.replan_exhausted") {
    return {
      status: "exhausted",
      statusLabel: "自动缩减后仍超限",
      level: "danger",
      maxInputTokens: safeNumber(event.maxInputTokens),
      contextLimit: nullableNumber(event.overflow?.contextLimit),
    };
  }
  return {
    status: "requested",
    statusLabel: "正在缩减上下文",
    level: "warning",
    fromMaxInputTokens: safeNumber(event.maxInputTokens),
    toMaxInputTokens: safeNumber(event.nextMaxInputTokens),
  };
}

function strategyLabel(strategy) {
  return ({
    "recent-complete-turns-v1": "最近完整轮次",
    "semantic-summary+recent-complete-turns-v1": "语义摘要 + 最近轮次",
  })[strategy] || strategy || "尚无规划";
}

function shortHash(value) {
  if (typeof value !== "string" || !value) return null;
  return value.replace(/^sha256:/, "").slice(0, 12);
}

function safeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function nullableNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function findLast(values, predicate) {
  return values.findLast(predicate) || null;
}
