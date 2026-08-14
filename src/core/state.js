// FOUNDATION: portable state machine for an executable Agent session.
import { randomUUID } from "node:crypto";
import { redactSensitiveValue } from "../security/redact.js";

export function createSession({ provider, workspace }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: `session-${randomUUID().slice(0, 12)}`,
    createdAt: now,
    updatedAt: now,
    phase: "idle",
    provider,
    workspace,
    messages: [],
    events: [],
    memory: [],
    contextMemory: [],
    loadedSkills: [],
    pendingApproval: null,
    step: 0,
    metrics: {
      modelCalls: 0,
      toolCalls: 0,
      approvals: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      modelDurationMs: 0,
      toolDurationMs: 0,
      lastTurnDurationMs: 0,
    },
    turnStartedAt: null,
    lastError: null,
  };
}

export function reduceSession(state, action) {
  const next = structuredClone(state);
  next.updatedAt = new Date().toISOString();
  const emit = (type, detail = {}) => {
    next.events.push({
      seq: next.events.length + 1,
      at: new Date().toISOString(),
      type,
      ...detail,
    });
  };

  switch (action.type) {
    case "USER_MESSAGE":
      next.phase = "thinking";
      next.turnStartedAt = new Date().toISOString();
      next.messages.push({ role: "user", content: action.content });
      emit("message.user", { preview: action.content.slice(0, 120) });
      break;
    case "MODEL_REQUESTED":
      next.phase = "thinking";
      next.step += 1;
      next.metrics.modelCalls += 1;
      emit("model.requested", { step: next.step });
      break;
    case "MODEL_COMPLETED":
      next.metrics.inputTokens += action.usage.inputTokens;
      next.metrics.outputTokens += action.usage.outputTokens;
      next.metrics.totalTokens += action.usage.totalTokens;
      next.metrics.modelDurationMs += action.durationMs;
      emit("model.completed", { durationMs: action.durationMs, usage: action.usage });
      break;
    case "ASSISTANT_MESSAGE":
      next.messages.push(action.message);
      emit("message.assistant", { preview: (action.message.content || "[工具调用]").slice(0, 120) });
      break;
    case "TOOL_REQUESTED":
      next.phase = "executing";
      next.metrics.toolCalls += 1;
      emit("tool.requested", { tool: action.call.name, args: redactSensitiveValue(action.call.arguments) });
      break;
    case "APPROVAL_REQUESTED":
      next.phase = "awaiting_approval";
      next.pendingApproval = { ...action.call, arguments: redactSensitiveValue(action.call.arguments) };
      emit("approval.requested", { tool: action.call.name, args: redactSensitiveValue(action.call.arguments) });
      break;
    case "APPROVAL_DECIDED":
      next.metrics.approvals += 1;
      next.pendingApproval = null;
      next.phase = action.approved ? "executing" : "thinking";
      emit(action.approved ? "approval.granted" : "approval.denied", { tool: action.call.name });
      break;
    case "TOOL_RESULT":
      next.messages.push({ role: "tool", tool_call_id: action.call.id, content: action.result });
      next.phase = "thinking";
      next.metrics.toolDurationMs += action.durationMs || 0;
      emit("tool.completed", { tool: action.call.name, ok: action.ok, durationMs: action.durationMs || 0, preview: action.result.slice(0, 160) });
      break;
    case "MEMORY_ADDED":
      next.memory.push({ content: action.content, at: new Date().toISOString() });
      emit("memory.added", { preview: action.content.slice(0, 120) });
      break;
    case "MEMORY_CONTEXT_SET":
      next.contextMemory = action.memories;
      emit("memory.context_loaded", { count: action.memories.length, query: action.query.slice(0, 120) });
      break;
    case "SKILL_LOADED":
      if (!next.loadedSkills.some((skill) => skill.name === action.skill.name)) {
        next.loadedSkills.push(action.skill);
      }
      emit("skill.loaded", { skill: action.skill.name });
      break;
    case "COMPLETED":
      next.phase = "completed";
      next.metrics.lastTurnDurationMs = elapsedSince(next.turnStartedAt);
      next.turnStartedAt = null;
      emit("session.turn_completed", { durationMs: next.metrics.lastTurnDurationMs });
      break;
    case "FAILED":
      next.phase = "failed";
      next.lastError = action.error;
      next.metrics.lastTurnDurationMs = elapsedSince(next.turnStartedAt);
      next.turnStartedAt = null;
      emit("session.failed", { error: action.error, durationMs: next.metrics.lastTurnDurationMs });
      break;
    case "CANCELLED":
      for (const call of findUnresolvedToolCalls(next.messages)) {
        next.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "任务已取消：该工具调用不会自动重放，执行状态未知。",
        });
      }
      next.phase = "cancelled";
      next.lastError = action.reason;
      next.pendingApproval = null;
      next.metrics.lastTurnDurationMs = elapsedSince(next.turnStartedAt);
      next.turnStartedAt = null;
      emit("session.cancelled", { reason: action.reason, durationMs: next.metrics.lastTurnDurationMs });
      break;
    case "READY":
      next.phase = "idle";
      next.lastError = null;
      break;
    case "RESUMED": {
      next.contextMemory ||= [];
      next.metrics = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        modelDurationMs: 0,
        toolDurationMs: 0,
        lastTurnDurationMs: 0,
        ...next.metrics,
      };
      next.turnStartedAt = null;
      const previousPhase = next.phase;
      const discardedApproval = next.pendingApproval?.name || null;
      const unresolvedCalls = findUnresolvedToolCalls(next.messages);
      for (const call of unresolvedCalls) {
        const wasPending = call.id === next.pendingApproval?.id;
        next.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: wasPending
            ? "会话恢复：该工具调用尚未获得审批，已取消且未执行。"
            : "会话恢复：该工具调用在进程中断时没有结果，执行状态未知，出于安全考虑不会自动重放。",
        });
      }
      next.phase = "idle";
      next.provider = action.provider;
      next.workspace = action.workspace;
      next.pendingApproval = null;
      next.lastError = null;
      emit("session.resumed", {
        previousPhase,
        discardedApproval,
        reconciledToolCalls: unresolvedCalls.map((call) => call.name),
      });
      break;
    }
    default:
      throw new Error(`未知状态动作：${action.type}`);
  }

  return next;
}

function findUnresolvedToolCalls(messages) {
  const completed = new Set(
    messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
  );
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
    return message.tool_calls
      .filter((call) => call.id && !completed.has(call.id))
      .map((call) => ({ id: call.id, name: call.function?.name || "unknown" }));
  });
}

function elapsedSince(value) {
  return value ? Math.max(0, Date.now() - new Date(value).getTime()) : 0;
}
