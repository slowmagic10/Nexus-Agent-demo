export const MEMORY_KINDS = Object.freeze([
  "preference", "fact", "decision", "lesson", "task", "profile",
]);
export const MEMORY_STATUSES = Object.freeze([
  "active", "candidate", "superseded", "expired", "deleted",
]);
export const MEMORY_ORIGINS = Object.freeze([
  "user_explicit", "tool", "auto_extract", "import", "legacy", "system",
]);
export const MEMORY_MUTATION_OUTCOMES = Object.freeze([
  "safe_to_retry", "outcome_unknown", "non_retryable",
]);
export const MEMORY_MUTATION_IDEMPOTENCY = Object.freeze([
  "mutation-key", "none",
]);

export class MemoryMutationError extends Error {
  constructor(message, { code = "MEMORY_MUTATION_FAILED", outcome = "non_retryable", retryable } = {}) {
    super(message);
    if (!MEMORY_MUTATION_OUTCOMES.includes(outcome)) throw new Error(`无效 Memory mutation outcome：${outcome}`);
    this.name = "MemoryMutationError";
    this.code = code;
    this.outcome = outcome;
    if (typeof retryable === "boolean") this.retryable = retryable;
  }
}

export class MemoryInterface {
  async search(_query, _access, _options) { throw new Error("MemoryInterface.search 尚未实现"); }
  async add(_candidate, _access) { throw new Error("MemoryInterface.add 尚未实现"); }
  async update(_id, _patch, _access) { throw new Error("MemoryInterface.update 尚未实现"); }
  async supersede(_id, _replacementId, _access) { throw new Error("MemoryInterface.supersede 尚未实现"); }
  async delete(_id, _reason, _access) { throw new Error("MemoryInterface.delete 尚未实现"); }
  async flush(_input, _access) { throw new Error("MemoryInterface.flush 尚未实现"); }
}

export function assertMemoryInterface(value) {
  const methods = ["search", "add", "update", "supersede", "delete", "flush"];
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new Error(`Memory Adapter 必须实现：${methods.join(", ")}`);
  }
  if (!MEMORY_MUTATION_IDEMPOTENCY.includes(value.capabilities?.mutationIdempotency)) {
    throw new Error(`Memory Adapter capabilities.mutationIdempotency 必须是：${MEMORY_MUTATION_IDEMPOTENCY.join(" 或 ")}`);
  }
  return value;
}

export function memoryMutationIdempotency(value) {
  return MEMORY_MUTATION_IDEMPOTENCY.includes(value?.capabilities?.mutationIdempotency)
    ? value.capabilities.mutationIdempotency
    : "none";
}

export function assertMemoryInspection(value) {
  const methods = ["get", "verify"];
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new Error(`Memory Inspection capability 必须实现：${methods.join(", ")}`);
  }
  return value;
}

export function normalizeMemoryAccess(access, defaults = {}, { requireProvenance = false } = {}) {
  if (!access || typeof access !== "object" || Array.isArray(access) || !access.scope) {
    throw new Error("Memory 操作必须提供包含 scope 的 MemoryAccessContext");
  }
  const scope = normalizeMemoryScope(access.scope, defaults);
  if (!scope.workspace || !scope.agentId || !scope.userId) {
    throw new Error("Memory scope 必须明确提供 workspace、agentId 和 userId");
  }
  if (requireProvenance && !access.provenance) throw new Error("Memory mutation 必须提供 provenance");
  const signal = access.signal || null;
  if (signal && typeof signal.aborted !== "boolean") throw new Error("MemoryAccessContext.signal 必须是 AbortSignal");
  throwIfAborted(signal);
  return {
    scope,
    signal,
    mutationId: optionalString(access.mutationId, "memory.mutationId"),
    provenance: access.provenance ? normalizeProvenance(access.provenance) : null,
  };
}

export function normalizeMemoryScope(scope = {}, defaults = {}) {
  const source = { ...defaults, ...scope };
  return {
    workspace: optionalString(source.workspace, "scope.workspace"),
    agentId: optionalString(source.agentId ?? "default", "scope.agentId"),
    userId: optionalString(source.userId ?? "local", "scope.userId"),
  };
}

export function normalizeMemoryCandidate(candidate, defaultScope = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("MemoryCandidate 必须是对象");
  }
  const content = requiredString(candidate.content, "memory.content");
  const kind = candidate.kind || "fact";
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`不支持的 memory.kind：${kind}`);
  const status = candidate.status || "active";
  if (!MEMORY_STATUSES.includes(status)) throw new Error(`不支持的 memory.status：${status}`);
  const confidence = candidate.confidence ?? 1;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("memory.confidence 必须是 0 到 1 的数字");
  }
  return {
    ...candidate,
    content,
    kind,
    status,
    confidence,
    scope: normalizeMemoryScope(candidate.scope, defaultScope),
    tags: normalizeTags(candidate.tags),
    observedAt: optionalDate(candidate.observedAt, "memory.observedAt"),
    expiresAt: optionalDate(candidate.expiresAt, "memory.expiresAt"),
  };
}

export function normalizeProvenance(provenance = {}) {
  const origin = provenance.origin || "system";
  if (!MEMORY_ORIGINS.includes(origin)) throw new Error(`不支持的 provenance.origin：${origin}`);
  const sourceCursor = provenance.sourceCursor ?? null;
  if (sourceCursor !== null && (!Number.isSafeInteger(sourceCursor) || sourceCursor < 1)) {
    throw new Error("provenance.sourceCursor 必须是正整数或 null");
  }
  return {
    origin,
    sessionId: optionalString(provenance.sessionId, "provenance.sessionId"),
    sourceCursor,
    toolCallId: optionalString(provenance.toolCallId, "provenance.toolCallId"),
    actor: optionalString(provenance.actor, "provenance.actor"),
    model: optionalString(provenance.model, "provenance.model"),
    importedFrom: optionalString(provenance.importedFrom, "provenance.importedFrom"),
    externalRef: optionalString(provenance.externalRef, "provenance.externalRef"),
  };
}

export function normalizeSearchOptions(options = {}) {
  const limit = options.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Memory search limit 必须是 1 到 500 的整数");
  }
  const statuses = options.statuses || ["active"];
  if (!Array.isArray(statuses) || !statuses.length || statuses.some((status) => !MEMORY_STATUSES.includes(status))) {
    throw new Error("Memory search statuses 无效");
  }
  return { limit, statuses: [...new Set(statuses)] };
}

export function normalizeTags(tags = []) {
  if (!Array.isArray(tags)) throw new Error("memory.tags 必须是字符串数组");
  if (tags.some((tag) => typeof tag !== "string")) throw new Error("memory.tags 必须是字符串数组");
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是字符串或 null`);
  return value.trim();
}

function optionalDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${label} 必须是 ISO 日期字符串或 null`);
  }
  return new Date(value).toISOString();
}

export function throwIfMemoryAborted(signal) {
  throwIfAborted(signal);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error("Memory 操作已取消");
}
