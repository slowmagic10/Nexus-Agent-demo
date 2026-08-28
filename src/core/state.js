// FOUNDATION: portable state machine for an executable Agent session.
import { randomUUID } from "node:crypto";
import { redactSensitiveValue } from "../security/redact.js";
import { createMemoryScope } from "../memory/scope.js";
import {
  assertAgentProfileSnapshot,
  compareAgentProfileSnapshots,
  createAgentProfileSnapshot,
  createLegacyAgentProfileSnapshot,
  deriveAgentProfileSnapshot,
} from "./agent-profile.js";
import { CONTEXT_SUMMARY_VERSION, normalizeSemanticSummary } from "./context-summary.js";

export const SESSION_SCHEMA_VERSION = 13;
const PLAN_STEP_STATUSES = new Set(["pending", "in_progress", "completed"]);

export function createSession({ provider, workspace, memoryScope, permissionProfile = "workspace-auto", agentProfile, id, createdAt }) {
  const now = createdAt || new Date().toISOString();
  const resolvedMemoryScope = createMemoryScope(memoryScope || { workspace });
  const resolvedProfile = agentProfile
    ? assertAgentProfileSnapshot(agentProfile)
    : createAgentProfileSnapshot({
        id: "default",
        provider: { name: provider, adapter: "unspecified", model: provider },
        workspace,
        permission: { defaultProfile: permissionProfile, profiles: [permissionProfile] },
        memoryScope: resolvedMemoryScope,
      });
  assertProfileSessionBinding(resolvedProfile, { provider, workspace, memoryScope: resolvedMemoryScope });
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: id || `session-${randomUUID().slice(0, 12)}`,
    createdAt: now,
    updatedAt: now,
    phase: "idle",
    provider,
    workspace,
    agentProfile: resolvedProfile,
    permissionProfile,
    memoryScope: resolvedMemoryScope,
    objective: null,
    plan: null,
    delegations: [],
    messages: [],
    events: [],
    memory: [],
    contextMemory: [],
    contextSummary: null,
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
      next.objective = {
        id: `objective-${next.events.length + 1}`,
        text: redactSensitiveValue(typeof action.objective === "string" && action.objective.trim() ? action.objective.trim() : action.content),
        status: "active",
        createdAt: at,
        updatedAt: at,
      };
      next.plan = null;
      emit("objective.created", { objectiveId: next.objective.id, preview: next.objective.text.slice(0, 160) });
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
    case "CONTEXT_SUMMARY_REQUESTED":
      if (action.modelCall !== false) next.metrics.modelCalls += 1;
      emit("context.summary_requested", {
        fromMessage: action.fromMessage,
        throughMessage: action.throughMessage,
        sourceCursor: action.sourceCursor,
        previousRevision: next.contextSummary?.revision || 0,
      });
      break;
    case "CONTEXT_SUMMARY_COMPLETED": {
      if (!Number.isSafeInteger(action.throughMessage) || action.throughMessage < 1 || action.throughMessage > next.messages.length) {
        throw new Error("Context summary throughMessage 无效");
      }
      if (!Number.isSafeInteger(action.sourceCursor) || action.sourceCursor < 1) {
        throw new Error("Context summary sourceCursor 无效");
      }
      const previousThrough = next.contextSummary?.throughMessage || 0;
      if (action.fromMessage !== previousThrough) throw new Error("Context summary 必须从上次覆盖位置连续推进");
      if (action.throughMessage <= previousThrough) throw new Error("Context summary 必须推进消息覆盖范围");
      if (action.throughMessage < next.messages.length && next.messages[action.throughMessage]?.role !== "user") {
        throw new Error("Context summary throughMessage 必须位于完整 turn 边界");
      }
      const summary = normalizeSemanticSummary(action.summary);
      const usage = normalizeSummaryUsage(action.usage);
      next.metrics.inputTokens += usage.inputTokens;
      next.metrics.outputTokens += usage.outputTokens;
      next.metrics.totalTokens += usage.totalTokens;
      next.metrics.modelDurationMs += action.durationMs || 0;
      next.contextSummary = {
        summaryVersion: CONTEXT_SUMMARY_VERSION,
        revision: (next.contextSummary?.revision || 0) + 1,
        ...summary,
        throughMessage: action.throughMessage,
        sourceCursor: action.sourceCursor,
        sourceComplete: action.sourceComplete !== false,
        model: action.model || next.provider,
        updatedAt: at,
      };
      emit("context.summary_completed", {
        revision: next.contextSummary.revision,
        throughMessage: next.contextSummary.throughMessage,
        sourceCursor: next.contextSummary.sourceCursor,
        sourceComplete: next.contextSummary.sourceComplete,
        model: next.contextSummary.model,
        durationMs: action.durationMs || 0,
        usage,
        preview: summary.objective || summary.active[0] || summary.completed[0] || "已更新滚动摘要",
      });
      break;
    }
    case "CONTEXT_SUMMARY_DEGRADED": {
      const usage = normalizeSummaryUsage(action.usage);
      next.metrics.inputTokens += usage.inputTokens;
      next.metrics.outputTokens += usage.outputTokens;
      next.metrics.totalTokens += usage.totalTokens;
      next.metrics.modelDurationMs += action.durationMs || 0;
      emit("context.summary_degraded", {
        fromMessage: action.fromMessage,
        throughMessage: action.throughMessage,
        sourceCursor: action.sourceCursor,
        durationMs: action.durationMs || 0,
        usage,
        error: action.error,
      });
      break;
    }
    case "MODEL_COMPLETED":
      next.metrics.inputTokens += action.usage.inputTokens;
      next.metrics.outputTokens += action.usage.outputTokens;
      next.metrics.totalTokens += action.usage.totalTokens;
      next.metrics.modelDurationMs += action.durationMs;
      emit("model.completed", {
        durationMs: action.durationMs,
        usage: action.usage,
        finishReason: action.finishReason || null,
      });
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
        grantScope: action.grantScope || null,
        baseDecision: action.baseDecision || null,
        profile: action.profile || null,
        explanation: action.explanation || null,
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
        grantScope: action.grantScope || null,
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
    case "TOOL_CAPABILITY_UNAVAILABLE":
      emit("tool.capability_unavailable", {
        callId: action.call.id,
        tool: action.call.name,
        argsHash: action.argsHash,
        registrationId: action.registrationId || null,
        reason: action.reason,
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
        durationMs: action.durationMs || 0,
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
        profile: action.profile || null,
        reason: action.reason || null,
        explanation: action.explanation || null,
        approvalScopes: action.approvalScopes || ["once"],
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
        profile: action.profile || null,
        reason: action.reason || null,
        explanation: action.explanation || null,
        approvalScopes: action.approvalScopes || ["once"],
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
        grantScope: action.grantScope || null,
      });
      break;
    case "TOOL_GRANT_ISSUED":
      if ((next.toolGrants || []).some((grant) => grant.id === action.grant.id)) {
        throw new Error(`Session Grant ID 已存在：${action.grant.id}`);
      }
      next.toolGrants ||= [];
      next.toolGrants.push(redactSensitiveValue(action.grant));
      emit("tool.grant_issued", {
        grantId: action.grant.id,
        tool: action.grant.tool,
        capabilityHash: action.grant.capabilityHash,
        policyVersion: action.grant.policyVersion,
        resources: action.grant.resources,
        expiresAt: action.grant.expiresAt,
        callId: action.grant.callId || null,
        usage: action.grant.usage || (action.grant.callId || action.grant.argsHash ? "single_use" : "session"),
        scope: action.grant.scope || (action.grant.callId || action.grant.argsHash ? "once" : "session"),
      });
      break;
    case "TOOL_PROJECT_GRANT_ISSUED":
      emit("tool.project_grant_issued", {
        grantId: action.grant.id,
        scope: "project",
        projectId: action.grant.projectId,
        tool: action.grant.tool,
        capabilityHash: action.grant.capabilityHash,
        policyVersion: action.grant.policyVersion,
        resources: action.grant.resources,
        expiresAt: action.grant.expiresAt,
      });
      break;
    case "TOOL_PROJECT_GRANT_REVOKED":
      emit("tool.project_grant_revoked", {
        grantId: action.grantId,
        scope: "project",
        reason: action.reason || null,
      });
      break;
    case "TOOL_GRANT_CONSUMED": {
      const grant = (next.toolGrants || []).find((candidate) => candidate.id === action.grantId);
      if (!grant) throw new Error(`未找到 Session Grant：${action.grantId}`);
      const usage = grant.usage || (grant.callId || grant.argsHash ? "single_use" : "session");
      if (usage !== "single_use") throw new Error(`Session Grant 不是单次授权：${action.grantId}`);
      if (grant.consumedAt) throw new Error(`Session Grant 已消费：${action.grantId}`);
      if (grant.sessionId !== next.id || grant.workspace !== next.workspace) {
        throw new Error(`Session Grant 与当前 Session 或 workspace 不匹配：${action.grantId}`);
      }
      if (grant.callId && grant.callId !== action.callId) throw new Error(`Session Grant 与 Tool Call 不匹配：${action.grantId}`);
      grant.usage = "single_use";
      grant.consumedAt = at;
      grant.consumedByCallId = action.callId;
      emit("tool.grant_consumed", { grantId: grant.id, tool: grant.tool, callId: action.callId });
      break;
    }
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
        ...(action.artifact ? { artifact: action.artifact } : {}),
        ...(action.fileChanges ? { fileChanges: action.fileChanges } : {}),
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
    case "PLAN_UPDATED": {
      if (!next.objective || next.objective.status !== "active") {
        throw new Error("Plan 只能更新当前 active Objective");
      }
      const steps = normalizePlanSteps(action.steps);
      const revision = next.plan?.objectiveId === next.objective.id ? next.plan.revision + 1 : 1;
      next.plan = {
        objectiveId: next.objective.id,
        revision,
        status: "active",
        explanation: typeof action.explanation === "string" ? redactSensitiveValue(action.explanation.trim()).slice(0, 1000) : "",
        steps,
        createdAt: next.plan?.objectiveId === next.objective.id ? next.plan.createdAt : at,
        updatedAt: at,
      };
      emit("plan.updated", {
        objectiveId: next.objective.id,
        revision,
        explanation: next.plan.explanation,
        steps: structuredClone(steps),
      });
      break;
    }
    case "DELEGATION_REQUESTED": {
      if (next.lineage?.kind === "delegation") throw new Error("单层委派 Child Session 不能继续创建 Child");
      if ((next.delegations || []).some((item) => item.status === "running")) {
        throw new Error("当前 Session 已有正在运行的委派");
      }
      if (!action.delegation?.id || !action.delegation?.childSessionId || !action.delegation?.objective) {
        throw new Error("委派必须包含 id、childSessionId 与 objective");
      }
      next.delegations ||= [];
      next.delegations.push(redactSensitiveValue({
        ...action.delegation,
        status: "running",
        requestedAt: at,
        updatedAt: at,
      }));
      emit("agent.transfer_requested", {
        delegationId: action.delegation.id,
        childSessionId: action.delegation.childSessionId,
        objective: redactSensitiveValue(action.delegation.objective).slice(0, 240),
        budget: structuredClone(action.delegation.budget || null),
        contextItems: action.delegation.contextItems || 0,
        context: redactSensitiveValue(action.delegation.context || []),
      });
      break;
    }
    case "DELEGATION_COMPLETED":
    case "DELEGATION_FAILED":
    case "DELEGATION_CANCELLED": {
      const delegation = (next.delegations || []).find((item) => item.id === action.delegationId);
      if (!delegation) throw new Error(`未找到委派：${action.delegationId}`);
      if (delegation.status !== "running") throw new Error(`委派已闭合：${action.delegationId}`);
      const status = action.type === "DELEGATION_COMPLETED"
        ? "completed"
        : action.type === "DELEGATION_CANCELLED"
          ? "cancelled"
          : "failed";
      delegation.status = status;
      delegation.updatedAt = at;
      delegation.finishedAt = at;
      delegation.result = redactSensitiveValue(action.result || "").slice(0, 12_000);
      delegation.childCursor = action.childCursor || null;
      emit(`agent.transfer_${status}`, {
        delegationId: delegation.id,
        childSessionId: delegation.childSessionId,
        childCursor: delegation.childCursor,
        preview: delegation.result.slice(0, 240),
      });
      break;
    }
    case "DELEGATION_APPROVAL_REQUESTED": {
      const delegation = (next.delegations || []).find((item) => item.id === action.delegationId);
      if (!delegation || delegation.status !== "running") throw new Error("只有运行中的委派可以代理审批");
      next.phase = "awaiting_approval";
      next.pendingApproval = {
        ...action.call,
        arguments: redactSensitiveValue(action.call.arguments),
        delegated: true,
        delegationId: delegation.id,
        childSessionId: delegation.childSessionId,
        childCallId: action.childCallId,
        reason: action.reason || "Child Session 请求执行需确认的工具",
        approvalScopes: action.approvalScopes || ["once"],
      };
      emit("agent.transfer_approval_requested", {
        delegationId: delegation.id,
        childSessionId: delegation.childSessionId,
        childCallId: action.childCallId,
        callId: action.call.id,
        tool: action.call.name,
        approvalScopes: action.approvalScopes || ["once"],
      });
      break;
    }
    case "DELEGATION_APPROVAL_DECIDED": {
      if (!next.pendingApproval?.delegated || next.pendingApproval.id !== action.callId) {
        throw new Error("当前没有匹配的 Child 委派审批");
      }
      const pending = next.pendingApproval;
      next.pendingApproval = null;
      next.phase = "executing";
      emit(action.approved ? "agent.transfer_approval_granted" : "agent.transfer_approval_denied", {
        delegationId: pending.delegationId,
        childSessionId: pending.childSessionId,
        childCallId: pending.childCallId,
        callId: pending.id,
        tool: pending.name,
        grantScope: action.approved ? action.scope || "once" : null,
      });
      break;
    }
    case "COMPLETED":
      next.phase = "completed";
      next.metrics.lastTurnDurationMs = elapsedSince(next.turnStartedAt, at);
      next.turnStartedAt = null;
      finalizeObjective(next, "completed", at, emit);
      emit("session.turn_completed", { durationMs: next.metrics.lastTurnDurationMs });
      break;
    case "FAILED":
      for (const call of findUnresolvedToolCalls(next.messages)) {
        next.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "任务在工具启动前停止：该工具调用没有执行。",
        });
      }
      next.phase = "failed";
      next.lastError = action.error;
      next.pendingApproval = null;
      next.metrics.lastTurnDurationMs = elapsedSince(next.turnStartedAt, at);
      next.turnStartedAt = null;
      finalizeObjective(next, "failed", at, emit);
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
      finalizeObjective(next, "cancelled", at, emit);
      emit("session.cancelled", { reason: action.reason, durationMs: next.metrics.lastTurnDurationMs });
      break;
    case "READY":
      next.phase = "idle";
      next.lastError = null;
      break;
    case "PERMISSION_PROFILE_CHANGED":
      if (!["read-only", "approval-required", "workspace-confirm", "workspace-untrusted", "workspace-auto", "danger-full-access"].includes(action.profile)) {
        throw new Error(`会话权限档位无效：${action.profile}`);
      }
      if (["thinking", "executing", "awaiting_approval"].includes(next.phase)) {
        throw new Error("会话运行期间不能切换权限档位");
      }
      next.permissionProfile = action.profile;
      next.toolGrants = [];
      emit("permission.profile_changed", {
        profile: action.profile,
        previousProfile: state.permissionProfile || "workspace-auto",
        riskAcknowledged: action.profile === "danger-full-access" ? action.riskAcknowledged === true : false,
      });
      break;
    case "PERMISSION_PROFILE_DOWNGRADED":
      if (!["read-only", "approval-required", "workspace-confirm", "workspace-untrusted", "workspace-auto"].includes(action.profile)) {
        throw new Error(`会话安全降级档位无效：${action.profile}`);
      }
      next.permissionProfile = action.profile;
      next.toolGrants = [];
      emit("permission.profile_downgraded", {
        profile: action.profile,
        previousProfile: state.permissionProfile || "workspace-auto",
        reason: action.reason || "dangerous_profile_requires_confirmation",
      });
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
      const reboundProfile = action.agentProfile
        ? assertAgentProfileSnapshot(action.agentProfile)
        : deriveProfileForResume(next.agentProfile, action.provider, action.workspace, next.memoryScope);
      assertProfileSessionBinding(reboundProfile, {
        provider: action.provider,
        workspace: action.workspace,
        memoryScope: createMemoryScope({ ...next.memoryScope, workspace: action.workspace }),
      });
      if (reboundProfile.version !== next.agentProfile.version) {
        const previousProfile = next.agentProfile;
        const changes = compareAgentProfileSnapshots(previousProfile, reboundProfile);
        next.agentProfile = reboundProfile;
        emit("agent.profile_selected", {
          profileId: reboundProfile.id,
          profileVersion: reboundProfile.version,
          previousProfileVersion: previousProfile.version,
          provider: reboundProfile.provider.name,
          reason: action.profileReason || "runtime_rebound",
          changes,
          changeCategories: [...new Set(changes.map((change) => change.category))],
        });
      }
      next.phase = "idle";
      next.provider = action.provider;
      next.workspace = action.workspace;
      next.memoryScope = createMemoryScope({ ...next.memoryScope, workspace: action.workspace });
      next.pendingApproval = null;
      next.lastError = null;
      if (next.objective?.status === "active") {
        next.objective.status = "paused";
        next.objective.updatedAt = at;
        if (next.plan?.status === "active") {
          next.plan.status = "paused";
          next.plan.updatedAt = at;
        }
        emit("objective.paused", { objectiveId: next.objective.id, reason: "process_interrupted" });
      }
      for (const delegation of next.delegations || []) {
        if (delegation.status !== "running") continue;
        delegation.status = "interrupted";
        delegation.updatedAt = at;
        delegation.finishedAt = at;
        delegation.result = "Gateway 恢复时委派仍未闭合；不会自动重放 Child 副作用。";
        emit("agent.transfer_interrupted", {
          delegationId: delegation.id,
          childSessionId: delegation.childSessionId,
        });
      }
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
  if (state.schemaVersion === SESSION_SCHEMA_VERSION) {
    assertAgentProfileSnapshot(state.agentProfile);
    return state;
  }
  if (state.schemaVersion === 12) {
    assertAgentProfileSnapshot(state.agentProfile);
    return {
      ...state,
      schemaVersion: SESSION_SCHEMA_VERSION,
      contextSummary: state.contextSummary || null,
    };
  }
  if ([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(state.schemaVersion)) {
    const migratedMemoryScope = createMemoryScope(state.memoryScope || { workspace: state.workspace });
    return {
      ...state,
      schemaVersion: SESSION_SCHEMA_VERSION,
      lineage: state.lineage || null,
      permissionProfile: state.permissionProfile || "workspace-auto",
      memoryScope: migratedMemoryScope,
      agentProfile: createLegacyAgentProfileSnapshot({ ...state, memoryScope: migratedMemoryScope }),
      objective: state.objective || null,
      plan: state.plan || null,
      delegations: state.delegations || [],
      contextSummary: null,
      pendingMemoryMutations: state.pendingMemoryMutations || [],
      memoryMutationIssues: migrateMemoryMutationIssues(state.memoryMutationIssues || []),
      toolGrants: migrateToolGrants(state.toolGrants || []),
    };
  }
  if (state.schemaVersion > SESSION_SCHEMA_VERSION) {
    throw new Error(`会话 schema v${state.schemaVersion} 高于当前支持的 v${SESSION_SCHEMA_VERSION}`);
  }
  throw new Error(`不支持的会话 schema version：${state.schemaVersion}`);
}

export function createDelegatedSession(parentState, {
  id,
  delegationId,
  parentCursor,
  provider,
  workspace,
  agentProfile,
  delegatedAt = new Date().toISOString(),
}) {
  const parent = migrateSessionState(parentState);
  if (!id || !delegationId || !Number.isInteger(parentCursor) || parentCursor < 1) {
    throw new Error("Delegated Session 需要 id、delegationId 与有效 parentCursor");
  }
  const child = createSession({
    id,
    provider: provider || parent.provider,
    workspace: workspace || parent.workspace,
    memoryScope: { ...parent.memoryScope, workspace: workspace || parent.workspace },
    agentProfile: agentProfile || deriveAgentProfileSnapshot(parent.agentProfile, {
      provider: {
        ...parent.agentProfile.provider,
        name: provider || parent.provider,
        model: provider && provider !== parent.provider ? provider : parent.agentProfile.provider.model,
      },
      workspace: workspace || parent.workspace,
      memoryScope: { ...parent.memoryScope, workspace: workspace || parent.workspace },
    }),
    permissionProfile: parent.permissionProfile,
    createdAt: delegatedAt,
  });
  child.lineage = {
    kind: "delegation",
    parentSessionId: parent.id,
    parentCursor,
    delegationId,
    delegatedAt,
  };
  child.events.push({
    seq: 1,
    at: delegatedAt,
    type: "session.delegated",
    parentSessionId: parent.id,
    parentCursor,
    delegationId,
  });
  return child;
}

function normalizePlanSteps(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("Plan 至少包含一个步骤");
  if (value.length > 50) throw new Error("Plan 最多包含 50 个步骤");
  const seen = new Set();
  let inProgress = 0;
  const steps = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Plan 第 ${index + 1} 个步骤无效`);
    const step = typeof item.step === "string" ? redactSensitiveValue(item.step.trim()).slice(0, 500) : "";
    if (!step) throw new Error(`Plan 第 ${index + 1} 个步骤必须是非空文本`);
    if (seen.has(step)) throw new Error("Plan 步骤不能重复");
    seen.add(step);
    if (!PLAN_STEP_STATUSES.has(item.status)) throw new Error(`Plan 第 ${index + 1} 个步骤状态无效`);
    if (item.status === "in_progress") inProgress += 1;
    return { step, status: item.status };
  });
  if (inProgress > 1) throw new Error("Plan 最多一个步骤处于 in_progress");
  return steps;
}

function finalizeObjective(state, status, at, emit) {
  if (!state.objective || !["active", "paused"].includes(state.objective.status)) return;
  state.objective.status = status;
  state.objective.updatedAt = at;
  state.objective.completedAt = at;
  if (state.plan && ["active", "paused"].includes(state.plan.status)) {
    state.plan.status = status;
    state.plan.updatedAt = at;
  }
  emit(`objective.${status}`, { objectiveId: state.objective.id });
}

function migrateToolGrants(grants) {
  return grants.map((grant) => {
    const singleUse = grant.usage === "single_use" || (!grant.usage && (grant.callId || grant.argsHash));
    return {
      ...grant,
      usage: singleUse ? "single_use" : "session",
      consumedAt: grant.consumedAt || (singleUse ? grant.issuedAt || grant.expiresAt || new Date(0).toISOString() : null),
      consumedByCallId: grant.consumedByCallId || (singleUse ? grant.callId || null : null),
    };
  });
}

export function createSessionBranch(parentState, {
  id,
  parentCursor,
  provider,
  workspace,
  agentProfile,
  branchedAt = new Date().toISOString(),
}) {
  const parent = migrateSessionState(parentState);
  const branchProfile = agentProfile || deriveAgentProfileSnapshot(parent.agentProfile, {
    provider: {
      ...parent.agentProfile.provider,
      name: provider,
      model: provider === parent.provider ? parent.agentProfile.provider.model : provider,
    },
    workspace,
    memoryScope: { ...parent.memoryScope, workspace },
  });
  const reconciled = reduceSession(parent, {
    type: "RESUMED",
    provider,
    workspace,
    agentProfile: branchProfile,
    profileReason: "session_branch",
    at: branchedAt,
  });
  const inheritedFileChanges = parent.events
    .filter((event) => event.callId && event.fileChanges)
    .map((event, index) => ({
      seq: index + 2,
      at: branchedAt,
      type: "tool.file_changes_inherited",
      callId: event.callId,
      tool: event.tool || null,
      fileChanges: {
        ...structuredClone(event.fileChanges),
        ...(event.fileChanges.diffArtifact ? {
          diffArtifact: { ...event.fileChanges.diffArtifact, sessionId: id },
        } : {}),
      },
      parentSessionId: parent.id,
      parentCursor,
    }));
  return {
    ...reconciled,
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    createdAt: branchedAt,
    updatedAt: branchedAt,
    phase: "idle",
    provider,
    workspace,
    agentProfile: branchProfile,
    events: [
      {
        seq: 1,
        at: branchedAt,
        type: "session.branched",
        parentSessionId: parent.id,
        parentCursor,
      },
      ...inheritedFileChanges,
    ],
    contextMemory: [],
    contextSummary: null,
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

function deriveProfileForResume(profile, provider, workspace, memoryScope) {
  if (profile.provider.name === provider && profile.workspace === workspace) return profile;
  return deriveAgentProfileSnapshot(profile, {
    provider: {
      ...profile.provider,
      name: provider,
      model: provider === profile.provider.name ? profile.provider.model : provider,
    },
    workspace,
    memoryScope: { ...memoryScope, workspace },
  });
}

function assertProfileSessionBinding(profile, { provider, workspace, memoryScope }) {
  if (profile.provider.name !== provider) throw new Error("Agent Profile provider 与 Session 不匹配");
  if (profile.workspace !== workspace) throw new Error("Agent Profile workspace 与 Session 不匹配");
  if (profile.memoryScope.workspace !== memoryScope.workspace
    || profile.memoryScope.agentId !== memoryScope.agentId
    || profile.memoryScope.userId !== memoryScope.userId) {
    throw new Error("Agent Profile memoryScope 与 Session 不匹配");
  }
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

function normalizeSummaryUsage(value = {}) {
  const inputTokens = Number.isSafeInteger(value?.inputTokens) && value.inputTokens >= 0 ? value.inputTokens : 0;
  const outputTokens = Number.isSafeInteger(value?.outputTokens) && value.outputTokens >= 0 ? value.outputTokens : 0;
  const totalTokens = Number.isSafeInteger(value?.totalTokens) && value.totalTokens >= 0
    ? value.totalTokens
    : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
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
