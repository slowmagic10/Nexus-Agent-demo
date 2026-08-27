// FOUNDATION — event-derived projection of everything visible to the model.
import { applyStatePatch } from "../state-patch.js";

const MODEL_CONTEXT_DEFAULTS = {
  messages: [],
  memory: [],
  contextMemory: [],
  loadedSkills: [],
  objective: null,
  plan: null,
  delegations: [],
};
const MODEL_CONTEXT_KEYS = Object.keys(MODEL_CONTEXT_DEFAULTS);
const DEFAULT_MAX_INPUT_TOKENS = 32_000;
const COMPACTION_MARKER = "[Model Context 已压缩：仅保留最近的完整会话轮次；更早事实仍保存在 durable journal 中。]";
const CONTEXT_STRATEGY = "recent-complete-turns-v1";

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
  const memoryHits = summarizeMemoryHits(promptContext.contextMemory);
  const baseSystemPrompt = typeof systemPrompt === "function"
    ? String(systemPrompt(promptContext) || "")
    : String(systemPrompt || "");
  const durableMessages = structuredClone(context.messages);
  const durableTools = structuredClone(tools || []);
  const full = measureRequest(baseSystemPrompt, durableMessages, durableTools);

  if (full.fixedTokens > maxInputTokens) {
    throw new Error(`固定上下文预计 ${full.fixedTokens} tokens，超过 Model Context 预算 ${maxInputTokens}`);
  }
  if (full.estimatedInputTokens <= maxInputTokens) {
    return buildRequest(baseSystemPrompt, durableMessages, durableTools, {
      ...full,
      maxInputTokens,
      includedMessages: durableMessages.length,
      omittedMessages: 0,
      includedTurns: groupCompleteTurns(durableMessages).length,
      omittedTurns: 0,
      compacted: false,
      strategy: CONTEXT_STRATEGY,
      memoryHits,
    });
  }

  const compactedSystemPrompt = `${baseSystemPrompt}\n\n${COMPACTION_MARKER}`;
  const turns = groupCompleteTurns(durableMessages);
  const fixed = measureRequest(compactedSystemPrompt, [], durableTools);
  if (fixed.fixedTokens > maxInputTokens) {
    throw new Error(`固定上下文预计 ${fixed.fixedTokens} tokens，超过 Model Context 预算 ${maxInputTokens}`);
  }
  const latestTurn = turns.at(-1) || [];
  const latest = measureRequest(compactedSystemPrompt, latestTurn, durableTools);
  if (latest.estimatedInputTokens > maxInputTokens) {
    throw new Error(`当前 turn 预计 ${latest.messageTokens} tokens，超过 Model Context 预算 ${maxInputTokens} 可容纳的消息空间`);
  }

  let firstIncludedTurn = turns.length - 1;
  let selectedTurns = latestTurn.length ? [latestTurn] : [];
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const candidate = [turns[index], ...selectedTurns].flat();
    if (measureRequest(compactedSystemPrompt, candidate, durableTools).estimatedInputTokens > maxInputTokens) break;
    selectedTurns = [turns[index], ...selectedTurns];
    firstIncludedTurn = index;
  }

  const selectedMessages = selectedTurns.flat();
  const measured = measureRequest(compactedSystemPrompt, selectedMessages, durableTools);
  return buildRequest(compactedSystemPrompt, selectedMessages, durableTools, {
    ...measured,
    maxInputTokens,
    includedMessages: selectedMessages.length,
    omittedMessages: durableMessages.length - selectedMessages.length,
    includedTurns: selectedTurns.length,
    omittedTurns: Math.max(0, firstIncludedTurn),
    compacted: true,
    strategy: CONTEXT_STRATEGY,
    memoryHits,
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
  return {
    systemPrompt,
    messages,
    tools,
    contextPlan: {
      maxInputTokens: contextPlan.maxInputTokens,
      estimatedInputTokens: contextPlan.estimatedInputTokens,
      fixedTokens: contextPlan.fixedTokens,
      messageTokens: contextPlan.messageTokens,
      includedMessages: contextPlan.includedMessages,
      omittedMessages: contextPlan.omittedMessages,
      includedTurns: contextPlan.includedTurns,
      omittedTurns: contextPlan.omittedTurns,
      compacted: contextPlan.compacted,
      strategy: contextPlan.strategy,
      memoryHits: contextPlan.memoryHits || [],
    },
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

function groupCompleteTurns(messages) {
  const turns = [];
  for (const message of messages) {
    if (message.role === "user" || !turns.length) turns.push([]);
    turns.at(-1).push(message);
  }
  return turns;
}

function measureRequest(systemPrompt, messages, tools) {
  const fixedTokens = estimateValue(systemPrompt) + estimateValue(tools) + 8;
  const messageTokens = messages.reduce((total, message) => total + estimateValue(message) + 4, 0);
  return {
    fixedTokens,
    messageTokens,
    estimatedInputTokens: fixedTokens + messageTokens,
  };
}

function estimateValue(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(new TextEncoder().encode(serialized || "").length / 3));
}
