// FOUNDATION — event-derived projection of everything visible to the model.
import { createHash } from "node:crypto";
import { applyStatePatch } from "../state-patch.js";
import { renderContextSummaryMessage } from "./context-summary.js";

const MODEL_CONTEXT_DEFAULTS = {
  messages: [],
  memory: [],
  contextMemory: [],
  contextSummary: null,
  loadedSkills: [],
  objective: null,
  plan: null,
  delegations: [],
};
const MODEL_CONTEXT_KEYS = Object.keys(MODEL_CONTEXT_DEFAULTS);
const DEFAULT_MAX_INPUT_TOKENS = 32_000;
const COMPACTION_MARKER = "[Model Context 已压缩：仅保留最近的完整会话轮次；更早事实仍保存在 durable journal 中。]";
const CONTEXT_STRATEGY = "recent-complete-turns-v1";
const SEMANTIC_CONTEXT_STRATEGY = "semantic-summary+recent-complete-turns-v1";
const CONTEXT_HASH_VERSION = "model-request-sha256-v1";
const TOKEN_ESTIMATOR_VERSION = "utf8-bytes-div3-v1";
const HISTORICAL_TOOL_TRANSCRIPT_VERSION = "historical-tool-transcript-v1";
const HISTORICAL_TOOL_ARGUMENTS_PREVIEW_CHARS = 80;
const HISTORICAL_TOOL_RESULT_PREVIEW_CHARS = 80;
const HISTORICAL_TOOL_PROSE_PREVIEW_CHARS = 160;
const ACTIVE_TOOL_TRANSCRIPT_VERSION = "active-tool-transcript-v1";
const ACTIVE_TOOL_FULL_ROUNDS = 2;

export function projectModelContext(events, fallbackState) {
  if (!events.length || !events[0].baseline) return selectModelContext(fallbackState);
  let context = selectModelContext(events[0].baseline);
  for (const event of events.slice(1)) {
    if (!event.patch) return selectModelContext(fallbackState);
    context = applyModelContextPatch(context, event.patch);
  }
  return context;
}

export function applyModelContextEvent(context, event, fallbackState) {
  return event.patch
    ? applyModelContextPatch(context, event.patch)
    : selectModelContext(fallbackState);
}

export function prepareModelRequest(context, {
  systemPrompt,
  tools,
  maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
}) {
  if (!Number.isInteger(maxInputTokens) || maxInputTokens < 1) {
    throw new Error("Model Context maxInputTokens 必须是正整数");
  }
  const promptContext = structuredClone(context);
  const memoryPlan = summarizeContextMemories(promptContext.contextMemory);
  const baseSystemPrompt = typeof systemPrompt === "function"
    ? String(systemPrompt(promptContext) || "")
    : String(systemPrompt || "");
  const durableMessages = structuredClone(context.messages);
  const projectedTurns = projectHistoricalToolTranscripts(groupCompleteTurns(durableMessages));
  const projectedMessages = projectedTurns.flatMap((turn) => turn.messages);
  const durableTools = structuredClone(tools || []);
  const full = measureRequest(baseSystemPrompt, projectedMessages, durableTools);

  if (full.estimatedInputTokens <= maxInputTokens) {
    return buildRequest(baseSystemPrompt, projectedMessages, durableTools, {
      ...full,
      maxInputTokens,
      includedMessages: projectedMessages.length,
      omittedMessages: 0,
      includedTurns: projectedTurns.length,
      omittedTurns: 0,
      compacted: false,
      strategy: CONTEXT_STRATEGY,
      historyProjection: summarizeHistoricalToolProjection(projectedTurns),
      activeToolProjection: summarizeActiveToolProjection(projectedTurns),
      ...memoryPlan,
      summary: summaryPlan(promptContext.contextSummary),
    });
  }

  const compactedSystemPrompt = `${baseSystemPrompt}\n\n${COMPACTION_MARKER}`;
  const turns = projectedTurns.map((turn) => turn.messages);
  const fixed = measureRequest(compactedSystemPrompt, [], durableTools);
  const recentOnly = selectCompactedTurns({
    systemPrompt: compactedSystemPrompt,
    turns,
    tools: durableTools,
    maxInputTokens,
    prefixMessages: [],
    strictLatest: true,
  });
  if (recentOnly.omittedMessages === 0) {
    const measured = measureRequest(baseSystemPrompt, recentOnly.selectedMessages, durableTools);
    return buildRequest(baseSystemPrompt, recentOnly.selectedMessages, durableTools, {
      ...recentOnly,
      ...measured,
      maxInputTokens,
      compacted: false,
      strategy: CONTEXT_STRATEGY,
      historyProjection: summarizeHistoricalToolProjection(projectedTurns),
      activeToolProjection: summarizeActiveToolProjection(projectedTurns),
      ...memoryPlan,
      summary: summaryPlan(promptContext.contextSummary),
    });
  }
  let selection = recentOnly;
  let semanticMessage = null;
  let summary = summaryPlan(promptContext.contextSummary, {
    requiredThroughMessage: recentOnly.omittedMessages,
  });
  const availableSummary = promptContext.contextSummary;
  if (availableSummary && availableSummary.throughMessage >= recentOnly.omittedMessages) {
    const candidateMessage = renderContextSummaryMessage(availableSummary);
    const withSummary = selectCompactedTurns({
      systemPrompt: compactedSystemPrompt,
      turns,
      tools: durableTools,
      maxInputTokens,
      prefixMessages: [candidateMessage],
      strictLatest: false,
    });
    if (!withSummary) {
      summary = summaryPlan(availableSummary, {
        requiredThroughMessage: availableSummary.throughMessage,
        omittedReason: "budget",
      });
    } else if (availableSummary.throughMessage >= withSummary.omittedMessages) {
      selection = withSummary;
      semanticMessage = candidateMessage;
      summary = summaryPlan(availableSummary, {
        included: true,
        requiredThroughMessage: withSummary.omittedMessages,
      });
    } else {
      summary = summaryPlan(availableSummary, {
        requiredThroughMessage: withSummary.omittedMessages,
        omittedReason: "coverage",
      });
    }
  }

  const requestMessages = semanticMessage
    ? [semanticMessage, ...selection.selectedMessages]
    : selection.selectedMessages;
  const measured = measureRequest(compactedSystemPrompt, requestMessages, durableTools);
  return buildRequest(compactedSystemPrompt, requestMessages, durableTools, {
    ...selection,
    ...measured,
    maxInputTokens,
    compacted: true,
    strategy: semanticMessage ? SEMANTIC_CONTEXT_STRATEGY : CONTEXT_STRATEGY,
    historyProjection: summarizeHistoricalToolProjection(projectedTurns.slice(selection.firstIncludedTurn)),
    activeToolProjection: summarizeActiveToolProjection(projectedTurns),
    ...memoryPlan,
    summary,
  });
}

function selectModelContext(state) {
  return Object.fromEntries(MODEL_CONTEXT_KEYS.map((key) => [
    key,
    structuredClone(state[key] ?? MODEL_CONTEXT_DEFAULTS[key]),
  ]));
}

function applyModelContextPatch(context, patch) {
  const allowed = new Set(MODEL_CONTEXT_KEYS);
  const filtered = {
    set: Object.fromEntries(Object.entries(patch.set || {}).filter(([key]) => allowed.has(key))),
    append: Object.fromEntries(Object.entries(patch.append || {}).filter(([key]) => allowed.has(key))),
    remove: (patch.remove || []).filter((key) => allowed.has(key)),
  };
  return applyStatePatch(context, filtered);
}

function buildRequest(systemPrompt, messages, tools, contextPlan) {
  const contextHash = hashModelRequest({ systemPrompt, messages, tools });
  return {
    systemPrompt,
    messages,
    tools,
    contextPlan: {
      contextHash,
      contextHashVersion: CONTEXT_HASH_VERSION,
      estimatorVersion: TOKEN_ESTIMATOR_VERSION,
      maxInputTokens: contextPlan.maxInputTokens,
      estimatedOverTarget: contextPlan.estimatedInputTokens > contextPlan.maxInputTokens,
      estimatedInputTokens: contextPlan.estimatedInputTokens,
      fixedTokens: contextPlan.fixedTokens,
      messageTokens: contextPlan.messageTokens,
      includedMessages: contextPlan.includedMessages,
      omittedMessages: contextPlan.omittedMessages,
      includedTurns: contextPlan.includedTurns,
      omittedTurns: contextPlan.omittedTurns,
      compacted: contextPlan.compacted,
      strategy: contextPlan.strategy,
      historyProjection: contextPlan.historyProjection || emptyHistoricalToolProjection(),
      activeToolProjection: contextPlan.activeToolProjection || emptyActiveToolProjection(),
      memoryHits: contextPlan.memoryHits || [],
      pinnedMemoryHits: contextPlan.pinnedMemoryHits || [],
      memoryBudget: contextPlan.memoryBudget || emptyMemoryBudget(),
      summary: contextPlan.summary || summaryPlan(null),
    },
  };
}

function selectCompactedTurns({ systemPrompt, turns, tools, maxInputTokens, prefixMessages, strictLatest }) {
  const latestTurn = turns.at(-1) || [];
  const latestMessages = [...prefixMessages, ...latestTurn];
  const latest = measureRequest(systemPrompt, latestMessages, tools);
  if (latest.estimatedInputTokens > maxInputTokens) {
    if (!strictLatest) return null;
    const firstIncludedTurn = Math.max(0, turns.length - 1);
    return {
      selectedMessages: latestTurn,
      firstIncludedTurn,
      includedMessages: latestTurn.length,
      omittedMessages: turns.flat().length - latestTurn.length,
      includedTurns: latestTurn.length ? 1 : 0,
      omittedTurns: firstIncludedTurn,
    };
  }
  let firstIncludedTurn = Math.max(0, turns.length - 1);
  let selectedTurns = latestTurn.length ? [latestTurn] : [];
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const candidate = [...prefixMessages, turns[index], ...selectedTurns].flat();
    if (measureRequest(systemPrompt, candidate, tools).estimatedInputTokens > maxInputTokens) break;
    selectedTurns = [turns[index], ...selectedTurns];
    firstIncludedTurn = index;
  }
  const selectedMessages = selectedTurns.flat();
  return {
    selectedMessages,
    firstIncludedTurn,
    includedMessages: selectedMessages.length,
    omittedMessages: turns.flat().length - selectedMessages.length,
    includedTurns: selectedTurns.length,
    omittedTurns: Math.max(0, firstIncludedTurn),
  };
}

function summaryPlan(summary, {
  included = false,
  requiredThroughMessage = 0,
  omittedReason = null,
} = {}) {
  return {
    available: Boolean(summary),
    included,
    revision: summary?.revision || null,
    throughMessage: summary?.throughMessage || 0,
    requiredThroughMessage,
    sourceCursor: summary?.sourceCursor || null,
    sourceComplete: summary?.sourceComplete ?? null,
    omittedReason,
  };
}

function summarizeMemoryHits(memories = []) {
  return memories.map((memory) => ({
    id: memory.id,
    adapter: memory.adapter || "unknown",
    score: memory.score ?? null,
    confidence: memory.confidence ?? null,
    scope: structuredClone(memory.scope || null),
    sourceSession: memory.sourceSession || null,
    sourceCursor: memory.sourceCursor ?? null,
    sourceToolCall: memory.sourceToolCall || null,
    version: memory.version ?? null,
  }));
}

function summarizeContextMemories(memories = []) {
  const pinned = memories.filter((memory) => memory.pinned === true || memory.contextRetrievalClass === "pinned");
  const relevant = memories.filter((memory) => !pinned.includes(memory));
  return {
    pinnedMemoryHits: summarizeMemoryHits(pinned),
    memoryHits: summarizeMemoryHits(relevant),
    memoryBudget: {
      estimatorVersion: memories.find((memory) => memory.contextEstimatorVersion)?.contextEstimatorVersion || null,
      pinned: memoryBudgetSection(pinned),
      relevant: memoryBudgetSection(relevant),
    },
  };
}

function memoryBudgetSection(memories) {
  return {
    maxTokens: memories.find((memory) => Number.isSafeInteger(memory.contextBudgetTokens))?.contextBudgetTokens || null,
    estimatedTokens: memories.reduce((total, memory) => total + (memory.contextEstimatedTokens || 0), 0),
    included: memories.length,
    truncated: memories.filter((memory) => memory.contextTruncated === true).length,
  };
}

function emptyMemoryBudget() {
  return {
    estimatorVersion: null,
    pinned: memoryBudgetSection([]),
    relevant: memoryBudgetSection([]),
  };
}

function groupCompleteTurns(messages) {
  const turns = [];
  for (const message of messages) {
    if (message.role === "user" || !turns.length) turns.push([]);
    turns.at(-1).push(message);
  }
  return turns;
}

function projectHistoricalToolTranscripts(turns) {
  const lastTurnIndex = turns.length - 1;
  return turns.map((turn, turnIndex) => {
    if (turnIndex === lastTurnIndex) {
      const { messages, ...activeToolProjection } = projectActiveToolTurn(turn);
      return {
        messages,
        ...emptyHistoricalToolProjection(),
        activeToolProjection,
      };
    }
    return {
      ...projectHistoricalToolTurn(turn),
      activeToolProjection: emptyActiveToolProjection(),
    };
  });
}

function projectActiveToolTurn(turn) {
  const projection = emptyActiveToolProjection();
  const rounds = collectToolRounds(turn);
  projection.preservedRounds = Math.min(ACTIVE_TOOL_FULL_ROUNDS, rounds.length);
  const eligibleRounds = rounds.slice(0, Math.max(0, rounds.length - ACTIVE_TOOL_FULL_ROUNDS));
  projection.eligibleRounds = eligibleRounds.length;
  const messages = structuredClone(turn);
  if (hasOpaqueProviderState(turn)) return { messages, ...projection };

  for (const round of eligibleRounds) {
    const original = turn.slice(round.start, round.end + 1);
    const toolNames = new Map((original[0]?.tool_calls || []).map((call) => [
      call?.id,
      call?.function?.name || "unknown",
    ]));
    const candidate = original.map((message) => projectHistoricalToolMessage(message, toolNames, "本轮较早"));
    const originalChars = JSON.stringify(original).length;
    const originalTokens = estimateMessages(original);
    const candidateChars = JSON.stringify(candidate).length;
    const candidateTokens = estimateMessages(candidate);
    projection.originalChars += originalChars;
    projection.originalTokens += originalTokens;

    if (candidateTokens >= originalTokens) {
      projection.projectedChars += originalChars;
      projection.projectedTokens += originalTokens;
      continue;
    }

    messages.splice(round.start, original.length, ...candidate);
    projection.compactedRounds += 1;
    projection.compactedToolCalls += original[0].tool_calls.length;
    projection.compactedToolResults += original.filter((message) => message?.role === "tool").length;
    projection.projectedChars += candidateChars;
    projection.projectedTokens += candidateTokens;
  }

  projection.applied = projection.compactedRounds > 0;
  projection.savedChars = Math.max(0, projection.originalChars - projection.projectedChars);
  projection.savedTokens = Math.max(0, projection.originalTokens - projection.projectedTokens);
  return { messages, ...projection };
}

function collectToolRounds(turn) {
  const rounds = [];
  for (let index = 0; index < turn.length; index += 1) {
    const message = turn[index];
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue;
    let end = index;
    while (turn[end + 1]?.role === "tool") end += 1;
    rounds.push({ start: index, end });
    index = end;
  }
  return rounds;
}

function projectHistoricalToolTurn(turn) {
  const projection = { ...emptyHistoricalToolProjection(), eligibleTurns: 1 };
  const compactedToolCalls = turn.reduce(
    (total, message) => total + (Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0),
    0,
  );
  const compactedToolResults = turn.filter((message) => message?.role === "tool").length;
  if (!compactedToolCalls && !compactedToolResults) {
    return { messages: structuredClone(turn), ...projection };
  }
  if (hasOpaqueProviderState(turn)) return { messages: structuredClone(turn), ...projection };

  const toolNames = new Map(turn.flatMap((message) => (
    Array.isArray(message?.tool_calls) ? message.tool_calls : []
  ).map((call) => [call?.id, call?.function?.name || "unknown"])));
  const candidate = turn.map((message) => projectHistoricalToolMessage(message, toolNames));
  const originalChars = JSON.stringify(turn).length;
  const projectedChars = JSON.stringify(candidate).length;
  const originalTokens = estimateMessages(turn);
  const projectedTokens = estimateMessages(candidate);
  if (projectedTokens >= originalTokens) {
    return { messages: structuredClone(turn), ...projection };
  }

  return {
    messages: candidate,
    ...projection,
    applied: true,
    compactedToolCalls,
    compactedToolResults,
    originalChars,
    projectedChars,
    savedChars: originalChars - projectedChars,
    originalTokens,
    projectedTokens,
    savedTokens: Math.max(0, originalTokens - projectedTokens),
  };
}

function hasOpaqueProviderState(messages) {
  return messages.some((message) => Array.isArray(message?.provider_items) && message.provider_items.length > 0);
}

function projectHistoricalToolMessage(message, toolNames, scopeLabel = "历史") {
  if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const calls = message.tool_calls.map((call) => {
      const name = call?.function?.name || "unknown";
      const argumentsPreview = truncateMiddle(
        String(call?.function?.arguments || "{}"),
        HISTORICAL_TOOL_ARGUMENTS_PREVIEW_CHARS,
      );
      return `- ${name}: ${argumentsPreview}`;
    });
    const prose = String(message.content || "").trim();
    return {
      role: "assistant",
      content: [
        ...(prose ? [truncateMiddle(prose, HISTORICAL_TOOL_PROSE_PREVIEW_CHARS)] : []),
        `[${scopeLabel}工具调用；完整参数见 durable journal]`,
        ...calls,
      ].join("\n"),
    };
  }
  if (message?.role === "tool") {
    const value = String(message.content || "");
    const toolName = toolNames.get(message.tool_call_id) || "工具";
    return {
      role: "assistant",
      content: [
        `[${scopeLabel} ${toolName} 结果；完整内容见 durable journal]`,
        truncateMiddle(value, HISTORICAL_TOOL_RESULT_PREVIEW_CHARS),
      ].join("\n"),
    };
  }
  return structuredClone(message);
}

function summarizeHistoricalToolProjection(turns) {
  const summary = emptyHistoricalToolProjection();
  for (const turn of turns) {
    summary.eligibleTurns += turn.eligibleTurns || 0;
    summary.compactedToolCalls += turn.compactedToolCalls || 0;
    summary.compactedToolResults += turn.compactedToolResults || 0;
    summary.originalChars += turn.originalChars || 0;
    summary.projectedChars += turn.projectedChars || 0;
    summary.originalTokens += turn.originalTokens || 0;
    summary.projectedTokens += turn.projectedTokens || 0;
  }
  summary.applied = summary.compactedToolCalls > 0 || summary.compactedToolResults > 0;
  summary.savedChars = Math.max(0, summary.originalChars - summary.projectedChars);
  summary.savedTokens = Math.max(0, summary.originalTokens - summary.projectedTokens);
  return summary;
}

function emptyHistoricalToolProjection() {
  return {
    version: HISTORICAL_TOOL_TRANSCRIPT_VERSION,
    applied: false,
    eligibleTurns: 0,
    compactedToolCalls: 0,
    compactedToolResults: 0,
    originalChars: 0,
    projectedChars: 0,
    savedChars: 0,
    originalTokens: 0,
    projectedTokens: 0,
    savedTokens: 0,
  };
}

function summarizeActiveToolProjection(turns) {
  const summary = emptyActiveToolProjection();
  for (const turn of turns) {
    const projection = turn.activeToolProjection;
    if (!projection) continue;
    summary.eligibleRounds += projection.eligibleRounds || 0;
    summary.preservedRounds += projection.preservedRounds || 0;
    summary.compactedRounds += projection.compactedRounds || 0;
    summary.compactedToolCalls += projection.compactedToolCalls || 0;
    summary.compactedToolResults += projection.compactedToolResults || 0;
    summary.originalChars += projection.originalChars || 0;
    summary.projectedChars += projection.projectedChars || 0;
    summary.originalTokens += projection.originalTokens || 0;
    summary.projectedTokens += projection.projectedTokens || 0;
  }
  summary.applied = summary.compactedRounds > 0;
  summary.savedChars = Math.max(0, summary.originalChars - summary.projectedChars);
  summary.savedTokens = Math.max(0, summary.originalTokens - summary.projectedTokens);
  return summary;
}

function emptyActiveToolProjection() {
  return {
    version: ACTIVE_TOOL_TRANSCRIPT_VERSION,
    applied: false,
    eligibleRounds: 0,
    preservedRounds: 0,
    compactedRounds: 0,
    compactedToolCalls: 0,
    compactedToolResults: 0,
    originalChars: 0,
    projectedChars: 0,
    savedChars: 0,
    originalTokens: 0,
    projectedTokens: 0,
    savedTokens: 0,
  };
}

function truncateMiddle(value, maxLength) {
  if (value.length <= maxLength) return value;
  const marker = "\n…[历史工具内容已省略中段]…\n";
  const side = Math.max(0, Math.floor((maxLength - marker.length) / 2));
  return `${value.slice(0, side)}${marker}${value.slice(-side)}`;
}

function measureRequest(systemPrompt, messages, tools) {
  const fixedTokens = estimateValue(systemPrompt) + estimateValue(tools) + 8;
  const messageTokens = estimateMessages(messages);
  return {
    fixedTokens,
    messageTokens,
    estimatedInputTokens: fixedTokens + messageTokens,
  };
}

function estimateMessages(messages) {
  return messages.reduce((total, message) => total + estimateValue(message) + 4, 0);
}

function estimateValue(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(new TextEncoder().encode(serialized || "").length / 3));
}

function hashModelRequest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(",")}}`;
}
