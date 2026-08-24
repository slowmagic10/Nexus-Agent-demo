import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";
import { MEMORY_MUTATION_OUTCOMES, memoryMutationIdempotency } from "./interface.js";

export async function executeMemoryMutation({ memory, dispatch, mutation, signal }) {
  validateMutation(mutation);
  await dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: redactSensitiveValue(mutation) });
  try {
    const result = await applyMemoryMutation(memory, mutation, signal);
    await dispatch(appliedAction(mutation, result));
    return result;
  } catch (error) {
    await dispatch(failureAction(mutation, error, classifyMutationFailure(error, { memory })));
    throw error;
  }
}

export async function reconcileMemoryOutbox({ session, memory, signal, timeoutMs = 2_000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Memory reconcile timeoutMs 必须是正整数");
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const reconcileSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const pending = session.state.pendingMemoryMutations || [];
  const reconciled = [];
  for (const mutation of pending) {
    if (mutation.reconcilePolicy === "manual" || session.state.phase === "cancelled") {
      await session.dispatch({
        type: "MEMORY_MUTATION_MANUAL_REQUIRED",
        mutationId: mutation.id,
        error: mutation.reconcilePolicy === "manual"
          ? "Memory mutation 需要人工确认"
          : "会话已取消，Memory mutation 不会自动重放",
        retryable: true,
        outcome: "safe_to_retry",
      });
      reconciled.push({
        mutationId: mutation.id,
        operation: mutation.operation,
        memoryId: null,
        status: "manual_required",
      });
      continue;
    }
    try {
      const result = await raceWithSignal(applyMemoryMutation(memory, mutation, reconcileSignal), reconcileSignal);
      await session.dispatch(appliedAction(mutation, result));
      reconciled.push({
        mutationId: mutation.id,
        operation: mutation.operation,
        memoryId: resultMemoryId(mutation, result),
        status: "applied",
      });
    } catch (error) {
      const failure = classifyMutationFailure(error, { memory });
      await session.dispatch(failureAction(mutation, error, failure));
      reconciled.push({
        mutationId: mutation.id,
        operation: mutation.operation,
        memoryId: null,
        status: failure.status,
        outcome: failure.outcome,
        retryable: failure.retryable,
        error: redactSensitiveText(error.message),
      });
    }
  }
  return reconciled;
}

export async function retryMemoryMutation({ session, memory, mutationId, signal }) {
  const issue = findMutationIssue(session, mutationId);
  if (!issue.retryable) throw new Error(`Memory mutation 不可重试：${mutationId}`);
  return await executeMemoryMutation({ memory, dispatch: (action) => session.dispatch(action), mutation: issue.mutation, signal });
}

export async function discardMemoryMutation({ session, mutationId, reason }) {
  findMutation(session, mutationId);
  if (typeof reason !== "string" || !reason.trim()) throw new Error("丢弃 Memory mutation 必须提供原因");
  await session.dispatch({ type: "MEMORY_MUTATION_DISCARDED", mutationId, reason: redactSensitiveText(reason.trim()) });
}

export async function resolveMemoryMutation({ session, mutationId, memoryId = null }) {
  const mutation = findMutationIssue(session, mutationId).mutation;
  await session.dispatch({
    type: "MEMORY_MUTATION_APPLIED",
    mutationId,
    operation: mutation.operation,
    memoryId,
  });
}

async function applyMemoryMutation(memory, mutation, signal) {
  const access = {
    scope: mutation.scope,
    provenance: mutation.provenance,
    mutationId: mutation.id,
    signal,
  };
  switch (mutation.operation) {
    case "add":
      return await memory.add(mutation.candidate, access);
    case "update":
      return await memory.update(mutation.memoryId, mutation.patch, access);
    case "supersede":
      return await memory.supersede(mutation.memoryId, mutation.replacementId, access);
    case "delete":
      return await memory.delete(mutation.memoryId, mutation.reason, access);
    default:
      throw new Error(`不支持的 Memory mutation operation：${mutation.operation}`);
  }
}

function appliedAction(mutation, result) {
  return {
    type: "MEMORY_MUTATION_APPLIED",
    mutationId: mutation.id,
    operation: mutation.operation,
    memoryId: resultMemoryId(mutation, result),
  };
}

function failureAction(mutation, error, failure) {
  return {
    type: failure.outcome === "outcome_unknown"
      ? "MEMORY_MUTATION_OUTCOME_UNKNOWN"
      : "MEMORY_MUTATION_FAILED",
    mutationId: mutation.id,
    error: redactSensitiveText(error?.message || "Memory mutation 执行失败"),
    outcome: failure.outcome,
    retryable: failure.retryable,
  };
}

function resultMemoryId(mutation, result) {
  return result && typeof result === "object" ? result.id : result ? mutation.memoryId : null;
}

function validateMutation(mutation) {
  if (!mutation || typeof mutation !== "object" || typeof mutation.id !== "string" || !mutation.id.trim()) {
    throw new Error("Memory mutation 必须包含稳定 ID");
  }
  if (!mutation.scope || !mutation.provenance) throw new Error("Memory mutation 必须包含 scope 与 provenance");
}

function findMutation(session, mutationId) {
  const pending = session.state.pendingMemoryMutations.find((mutation) => mutation.id === mutationId);
  if (pending) return pending;
  const issue = session.state.memoryMutationIssues.find((item) => item.mutation.id === mutationId);
  if (issue) return issue.mutation;
  throw new Error(`未找到 Memory mutation：${mutationId}`);
}

function findMutationIssue(session, mutationId) {
  const issue = session.state.memoryMutationIssues.find((item) => item.mutation.id === mutationId);
  if (!issue) throw new Error(`未找到待处理的 Memory mutation：${mutationId}`);
  return issue;
}

function classifyMutationFailure(error, { memory }) {
  const declaredOutcome = MEMORY_MUTATION_OUTCOMES.includes(error?.outcome) ? error.outcome : null;
  const outcome = declaredOutcome || "outcome_unknown";
  const adapterIsIdempotent = memoryMutationIdempotency(memory) === "mutation-key";
  const retryable = typeof error?.retryable === "boolean"
    ? error.retryable
    : outcome === "safe_to_retry" || (outcome === "outcome_unknown" && adapterIsIdempotent);
  return {
    outcome,
    retryable,
    status: outcome === "outcome_unknown" ? "outcome_unknown" : "failed",
  };
}

function raceWithSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error("Memory reconcile 已取消"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("Memory reconcile 已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
