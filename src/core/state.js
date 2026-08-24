// FOUNDATION: portable state machine for an executable Agent session.
import { randomUUID } from "node:crypto";
import { redactSensitiveValue } from "../security/redact.js";
import { createMemoryScope } from "../memory/scope.js";

export const SESSION_SCHEMA_VERSION = 7;

export function createSession({ provider, workspace, memoryScope, id, createdAt }) {
  const now = createdAt || new Date().toISOString();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: id || `session-${randomUUID().slice(0, 12)}`,
    createdAt: now,
    updatedAt: now,
    phase: "idle",
    provider,
    workspace,
    memoryScope: createMemoryScope(memoryScope || { workspace }),
    messages: [],
    events: [],
    memory: [],
    contextMemory: [],
    pendingMemoryMutations: [],
    memoryMutationIssues: [],
    loadedSkills: [],
    toolGrants: [],
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
    lineage: null,
  };
}

export function reduceSession(state, action) {
  const next = structuredClone(migrateSessionState(state));
  const at = action.at || new Date().toISOString();
  next.updatedAt = at;
  const emit = (type, detail = {}) => {
    next.events.push({
      seq: next.events.length + 1,
      at,
      type,
      ...detail,
    });
  };

  switch (action.type) {
    case "USER_MESSAGE":
      next.phase = "thinking";
      next.turnStartedAt = at;
      next.messages.push({ role: "user", content: action.content });
      emit("message.user", { preview: action.content.slice(0, 120) });
      break;
    case "MODEL_REQUESTED":
      next.phase = "thinking";
      next.step += 1;
      next.metrics.modelCalls += 1;
      emit("model.requested", { step: next.step });
      break;
    case "MODEL_CONTEXT_PREPARED":
      emit(action.plan.compacted ? "model.context_compacted" : "model.context_prepared", action.plan);
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
      emit("tool.requested", {
        callId: action.call.id,
        tool: action.call.name,
        args: redactSensitiveValue(action.call.arguments),
        argsHash: action.argsHash || null,
        effects: action.effects || [],
        idempotency: action.idempotency || "unknown",
        adapter: action.adapter || "unknown",
      });
      break;
    case "TOOL_VALIDATION_FAILED":
      emit("tool.validation_failed", {
        callId: action.call.id,
        tool: action.call.name,
        argsHash: action.argsHash,
        error: action.error,
      });
      break;
    case "TOOL_AUTHORIZATION_DECIDED":
      emit("tool.authorization_decided", {
        callId: action.call.id,
        tool: action.call.name,
        argsHash: action.argsHash,
        toolVersion: action.toolVersion,
        effects: action.effects,
        idempotency: action.idempotency,
        adapter: action.adapter,
        risk: action.risk,
        decision: action.decision,
        policyVersion: action.policyVersion,
        ruleId: action.ruleId,
        reason: action.reason,
        capabilityHash: action.capabilityHash,
        readOnly: action.readOnly,
        resources: action.resources || [],
        grantId: action.grantId || null,
        baseDecision: action.baseDecision || null,
      });
      break;
    case "TOOL_EXECUTION_STARTED":
      emit("tool.execution_started", {
        callId: action.call.id,
        tool: action.call.name,
        argsHash: action.argsHash,
        toolVersion: action.toolVersion,
        effects: action.effects,
        idempotency: action.idempotency,
        adapter: action.adapter,
        policyVersion: action.policyVersion || null,
        capabilityHash: action.capabilityHash || null,
        grantId: action.grantId || null,
      });
      break;
    case "TOOL_APPROVAL_STALE":
      emit("approval.stale", {
        callId: action.call.id,
        tool: action.call.name,
        argsHash: action.argsHash,
        currentArgsHash: action.currentArgsHash,
        toolVersion: action.toolVersion,
        policyVersion: action.policyVersion || null,
        currentPolicyVersion: action.currentPolicyVersion || null,
      });
      break;
    case "TOOL_EXECUTION_UNKNOWN":
      emit("tool.execution_unknown", {
        callId: action.call.id,
        tool: action.call.name,
        argsHash: action.argsHash,
        effects: action.effects,
        idempotency: action.idempotency,
        adapter: action.adapter,
        reason: action.reason,
      });
      break;
    case "APPROVAL_REQUESTED":
      next.phase = "awaiting_approval";
      next.pendingApproval = {
        ...action.call,
        arguments: redactSensitiveValue(action.call.arguments),
        argsHash: action.argsHash || null,
        toolVersion: action.toolVersion || null,
        risk: action.risk || null,
        policyVersion: action.policyVersion || null,
        capabilityHash: action.capabilityHash || null,
        resources: action.resources || [],
        ruleId: action.ruleId || null,
      };
      emit("approval.requested", {
        callId: action.call.id,
        tool: action.call.name,
        args: redactSensitiveValue(action.call.arguments),
        argsHash: action.argsHash || null,
        toolVersion: action.toolVersion || null,
        risk: action.risk || null,
        policyVersion: action.policyVersion || null,
        capabilityHash: action.capabilityHash || null,
        resources: action.resources || [],
        ruleId: action.ruleId || null,
      });
      break;
    case "APPROVAL_DECIDED":
      next.metrics.approvals += 1;
      next.pendingApproval = null;
      next.phase = action.approved ? "executing" : "thinking";
      emit(action.approved ? "approval.granted" : "approval.denied", {
        callId: action.call.id,
        tool: action.call.name,
        argsHash: action.argsHash || null,
        toolVersion: action.toolVersion || null,
        policyVersion: action.policyVersion || null,
        capabilityHash: action.capabilityHash || null,
      });
      break;
    case "TOOL_GRANT_ISSUED":
      next.toolGrants = (next.toolGrants || []).filter((grant) => grant.id !== action.grant.id);
      next.toolGrants.push(redactSensitiveValue(action.grant));
      emit("tool.grant_issued", {
        grantId: action.grant.id,
        tool: action.grant.tool,
        capabilityHash: action.grant.capabilityHash,
        policyVersion: action.grant.policyVersion,
        resources: action.grant.resources,
        expiresAt: action.grant.expiresAt,
        callId: action.grant.callId || null,
      });
      break;
    case "TOOL_GRANT_REVOKED": {
      const grant = (next.toolGrants || []).find((candidate) => candidate.id === action.grantId);
      if (!grant) throw new Error(`未找到 Session Grant：${action.grantId}`);
      grant.revokedAt = at;
      emit("tool.grant_revoked", { grantId: grant.id, tool: grant.tool, reason: action.reason || null });
      break;
    }
    case "TOOL_RESULT":
      next.messages.push({ role: "tool", tool_call_id: action.call.id, content: action.result });
      next.phase = "thinking";
      next.metrics.toolDurationMs += action.durationMs || 0;
      emit("tool.completed", {
        callId: action.call.id,
        tool: action.call.name,
        ok: action.ok,
        status: action.status || (action.ok ? "completed" : "failed"),
        durationMs: action.durationMs || 0,
        preview: action.result.slice(0, 160),
      });
      break;
    case "MEMORY_ADDED":
      next.memory.push({ content: action.content, at });
      emit("memory.added", { preview: action.content.slice(0, 120) });
      break;
    case "MEMORY_CONTEXT_SET":
      next.contextMemory = action.memories;
      emit("memory.context_loaded", {
        count: action.memories.length,
        query: action.query.slice(0, 120),
        status: action.retrieval?.status || "ok",
        memoryIds: action.memories.map((memory) => memory.id).filter(Boolean),
        ...(action.retrieval?.error ? { error: action.retrieval.error } : {}),
      });
      break;
    case "MEMORY_FLUSH_REQUESTED":
      emit("memory.flush_requested", { sourceCursor: action.sourceCursor });
      break;
    case "MEMORY_FLUSH_COMPLETED":
      emit("memory.flush_completed", {
        sourceCursor: action.sourceCursor,
        extracted: action.extracted,
        created: action.created,
        skipped: action.skipped,
      });
      break;
    case "MEMORY_FLUSH_DEGRADED":
      emit("memory.flush_degraded", {
        sourceCursor: action.sourceCursor || null,
        error: action.error,
      });
      break;
    case "MEMORY_CANDIDATE_CREATED":
      emit("memory.candidate_created", {
        memoryId: action.memoryId,
        sourceCursor: action.sourceCursor,
        preview: action.preview,
      });
      break;
    case "MEMORY_CANDIDATE_APPROVED":
      emit("memory.candidate_approved", { memoryId: action.memoryId });
      break;
    case "MEMORY_CANDIDATE_REJECTED":
      emit("memory.candidate_rejected", { memoryId: action.memoryId, reason: action.reason });
      break;
    case "MEMORY_MUTATION_REQUESTED":
      if (!next.pendingMemoryMutations.some((mutation) => mutation.id === action.mutation.id)) {
        next.pendingMemoryMutations.push(redactSensitiveValue(action.mutation));
      }
      emit("memory.mutation_requested", {
        mutationId: action.mutation.id,
        operation: action.mutation.operation,
        toolCallId: action.mutation.provenance?.toolCallId || null,
        reconcilePolicy: action.mutation.reconcilePolicy || "automatic",
      });
      break;
    case "MEMORY_MUTATION_APPLIED":
      next.pendingMemoryMutations = next.pendingMemoryMutations.filter((mutation) => mutation.id !== action.mutationId);
      next.memoryMutationIssues = next.memoryMutationIssues.filter((issue) => issue.mutation.id !== action.mutationId);
      emit("memory.mutation_applied", {
        mutationId: action.mutationId,
        operation: action.operation,
        memoryId: action.memoryId || null,
      });
      break;
    case "MEMORY_MUTATION_FAILED":
    case "MEMORY_MUTATION_OUTCOME_UNKNOWN":
    case "MEMORY_MUTATION_MANUAL_REQUIRED": {
      const previousIssue = next.memoryMutationIssues.find((issue) => issue.mutation.id === action.mutationId);
      const mutation = next.pendingMemoryMutations.find((item) => item.id === action.mutationId)
        || previousIssue?.mutation;
      if (!mutation) throw new Error(`未找到 Memory mutation：${action.mutationId}`);
      const status = action.type === "MEMORY_MUTATION_OUTCOME_UNKNOWN"
        ? "outcome_unknown"
        : action.type === "MEMORY_MUTATION_FAILED"
          ? "failed"
          : "manual_required";
      const outcome = action.outcome || (status === "outcome_unknown"
        ? "outcome_unknown"
        : status === "manual_required"
          ? "safe_to_retry"
          : action.retryable === false
            ? "non_retryable"
            : "safe_to_retry");
      const retryable = typeof action.retryable === "boolean" ? action.retryable : outcome === "safe_to_retry";
      next.pendingMemoryMutations = next.pendingMemoryMutations.filter((item) => item.id !== action.mutationId);
      next.memoryMutationIssues = next.memoryMutationIssues.filter((issue) => issue.mutation.id !== action.mutationId);
      next.memoryMutationIssues.push({
        mutation: redactSensitiveValue(mutation),
        status,
        error: action.error || null,
        outcome,
        retryable,
        retryPolicy: retryable ? "manual" : "resolve_or_discard",
        attempts: ["failed", "outcome_unknown"].includes(status)
          ? (previousIssue?.attempts || 0) + 1
          : (previousIssue?.attempts || 0),
        at,
      });
      emit(`memory.mutation_${status}`, {
        mutationId: action.mutationId,
        operation: mutation.operation,
        error: action.error || null,
        outcome,
        retryable,
      });
      break;
    }
    case "MEMORY_MUTATION_DISCARDED":
      next.pendingMemoryMutations = next.pendingMemoryMutations.filter((mutation) => mutation.id !== action.mutationId);
      next.memoryMutationIssues = next.memoryMutationIssues.filter((issue) => issue.mutation.id !== action.mutationId);
      emit("memory.mutation_discarded", {
        mutationId: action.mutationId,
        reason: action.reason,
      });
      break;
    case "MEMORY_RECONCILIATION_DEGRADED":
      emit("memory.reconciliation_degraded", { error: action.error });
      break;
    case "SKILL_LOADED":
      if (!next.loadedSkills.some((skill) => skill.name === action.skill.name)) {
        next.loadedSkills.push(action.skill);
      }
      emit("skill.loaded", { skill: action.skill.name });
      break;
    case "COMPLETED":
      next.phase = "completed";
      next.metrics.lastTurnDurationMs = elapsedSince(next.turnStartedAt, at);
      next.turnStartedAt = null;
      emit("session.turn_completed", { durationMs: next.metrics.lastTurnDurationMs });
      break;
    case "FAILED":
      next.phase = "failed";
      next.lastError = action.error;
      next.metrics.lastTurnDurationMs = elapsedSince(next.turnStartedAt, at);
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
      next.metrics.lastTurnDurationMs = elapsedSince(next.turnStartedAt, at);
      next.turnStartedAt = null;
      emit("session.cancelled", { reason: action.reason, durationMs: next.metrics.lastTurnDurationMs });
      break;
    case "READY":
      next.phase = "idle";
      next.lastError = null;
      break;
    case "RESUMED": {
      next.contextMemory ||= [];
      next.pendingMemoryMutations ||= [];
      next.memoryMutationIssues ||= [];
      next.toolGrants ||= [];
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
        if (!wasPending) {
          emit("tool.execution_unknown", {
            callId: call.id,
            tool: call.name,
            reason: "process_interrupted",
          });
        }
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
      next.memoryScope = createMemoryScope({ ...next.memoryScope, workspace: action.workspace });
      next.pendingApproval = null;
      next.lastError = null;
      emit("session.resumed", {
        previousPhase,
        discardedApproval,
        reconciledToolCalls: unresolvedCalls.map((call) => call.name),
        pendingMemoryMutations: next.pendingMemoryMutations.length,
      });
      break;
    }
    default:
      throw new Error(`未知状态动作：${action.type}`);
  }

  return next;
}

export function migrateSessionState(state) {
  if (!state || typeof state !== "object") throw new Error("会话状态必须是对象");
  if (state.schemaVersion === SESSION_SCHEMA_VERSION) return state;
  if ([2, 3, 4, 5, 6].includes(state.schemaVersion)) {
    return {
      ...state,
      schemaVersion: SESSION_SCHEMA_VERSION,
      lineage: state.lineage || null,
      memoryScope: createMemoryScope(state.memoryScope || { workspace: state.workspace }),
      pendingMemoryMutations: state.pendingMemoryMutations || [],
      memoryMutationIssues: migrateMemoryMutationIssues(state.memoryMutationIssues || []),
      toolGrants: state.toolGrants || [],
    };
  }
  if (state.schemaVersion > SESSION_SCHEMA_VERSION) {
    throw new Error(`会话 schema v${state.schemaVersion} 高于当前支持的 v${SESSION_SCHEMA_VERSION}`);
  }
  throw new Error(`不支持的会话 schema version：${state.schemaVersion}`);
}

export function createSessionBranch(parentState, {
  id,
  parentCursor,
  provider,
  workspace,
  branchedAt = new Date().toISOString(),
}) {
  const parent = migrateSessionState(parentState);
  const reconciled = reduceSession(parent, {
    type: "RESUMED",
    provider,
    workspace,
    at: branchedAt,
  });
  return {
    ...reconciled,
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    createdAt: branchedAt,
    updatedAt: branchedAt,
    phase: "idle",
    provider,
    workspace,
    events: [{
      seq: 1,
      at: branchedAt,
      type: "session.branched",
      parentSessionId: parent.id,
      parentCursor,
    }],
    contextMemory: [],
    memoryScope: createMemoryScope({ ...parent.memoryScope, workspace }),
    pendingMemoryMutations: [],
    memoryMutationIssues: [],
    toolGrants: [],
    pendingApproval: null,
    step: 0,
    metrics: emptyMetrics(),
    turnStartedAt: null,
    lastError: null,
    lineage: {
      parentSessionId: parent.id,
      parentCursor,
      branchedAt,
    },
  };
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

function elapsedSince(value, at) {
  return value ? Math.max(0, new Date(at).getTime() - new Date(value).getTime()) : 0;
}

function emptyMetrics() {
  return {
    modelCalls: 0,
    toolCalls: 0,
    approvals: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelDurationMs: 0,
    toolDurationMs: 0,
    lastTurnDurationMs: 0,
  };
}

function migrateMemoryMutationIssues(issues) {
  return issues.map((issue) => {
    const outcome = issue.outcome || (issue.status === "outcome_unknown"
      ? "outcome_unknown"
      : issue.status === "manual_required"
        ? "safe_to_retry"
        : issue.retryable === false
          ? "non_retryable"
          : "safe_to_retry");
    return {
      ...issue,
      outcome,
      retryPolicy: issue.retryable === false ? "resolve_or_discard" : (issue.retryPolicy || "manual"),
    };
  });
}
