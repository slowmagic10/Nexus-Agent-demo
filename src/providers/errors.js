const CONTEXT_OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "context_window_exceeded",
  "max_context_length_exceeded",
  "max_tokens_exceeded",
  "prompt_too_long",
]);

const NON_CONTEXT_ERROR_CODES = new Set([
  "invalid_api_key",
  "authentication_error",
  "rate_limit_exceeded",
  "insufficient_quota",
  "billing_not_active",
  "permission_denied",
  "access_denied",
  "model_not_found",
]);

const NON_CONTEXT_ERROR_TYPES = new Set([
  "authentication_error",
  "rate_limit_error",
  "permission_error",
]);

const NON_CONTEXT_HTTP_STATUSES = new Set([401, 403, 429]);

const CONTEXT_OVERFLOW_PATTERNS = [
  /maximum context length/i,
  /context[_\s-]*(?:length|window)[^\n]{0,120}(?:exceed|limit|too (?:large|long))/i,
  /(?:input|prompt)[^\n]{0,80}tokens?[^\n]{0,80}(?:exceed|too (?:many|large|long))/i,
  /reduce (?:the )?length of (?:the )?(?:messages|prompt|input)/i,
];

export class ProviderHttpError extends Error {
  constructor(message, { status, providerCode = null, providerType = null, contextLimit = null, kind = "http_error" } = {}) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = Number.isInteger(status) ? status : null;
    this.providerCode = providerCode;
    this.providerType = providerType;
    this.contextLimit = contextLimit;
    this.kind = kind;
  }
}

export function createProviderHttpError(status, responseText) {
  const parsed = parseProviderPayload(responseText);
  const providerCode = textOrNull(parsed?.error?.code ?? parsed?.code);
  const providerType = textOrNull(parsed?.error?.type ?? parsed?.type);
  const detail = textOrNull(parsed?.error?.message ?? parsed?.message) || String(responseText || "请求失败").slice(0, 2_000);
  const overflow = matchesContextOverflow({ status, providerCode, providerType, message: detail });
  return new ProviderHttpError(`模型接口返回 ${status}：${detail}`, {
    status,
    providerCode,
    providerType,
    contextLimit: overflow ? extractContextLimit(parsed, detail) : null,
    kind: overflow ? "context_overflow" : "http_error",
  });
}

export function contextOverflowInfo(error) {
  if (!error || typeof error !== "object") return null;
  const providerCode = textOrNull(error.providerCode ?? error.code);
  const providerType = textOrNull(error.providerType ?? error.type);
  const message = String(error.message || "");
  if (!matchesContextOverflow({
    status: error.status,
    providerCode,
    providerType,
    declaredKind: error.kind,
    message,
  })) return null;
  return {
    kind: "context_overflow",
    status: Number.isInteger(error.status) ? error.status : null,
    providerCode,
    contextLimit: positiveInteger(error.contextLimit) || extractContextLimit(null, message),
  };
}

function matchesContextOverflow({ status, providerCode, providerType, declaredKind, message }) {
  const normalizedCode = String(providerCode || "").trim().toLowerCase();
  const normalizedType = String(providerType || "").trim().toLowerCase();
  if (CONTEXT_OVERFLOW_CODES.has(normalizedCode)) return true;
  if (NON_CONTEXT_ERROR_CODES.has(normalizedCode)) return false;
  if (NON_CONTEXT_ERROR_TYPES.has(normalizedType)) return false;
  if (NON_CONTEXT_HTTP_STATUSES.has(status)) return false;
  if (declaredKind === "context_overflow") return true;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(String(message || "")));
}

function extractContextLimit(payload, message) {
  const explicit = positiveInteger(
    payload?.error?.max_context_length
    ?? payload?.error?.context_length
    ?? payload?.max_context_length
    ?? payload?.context_length,
  );
  if (explicit) return explicit;
  const patterns = [
    /maximum context length (?:is|of)\s*([\d,]+)/i,
    /context (?:length|window)[^\d]{0,30}([\d,]+)\s*tokens?/i,
  ];
  for (const pattern of patterns) {
    const match = String(message || "").match(pattern);
    const parsed = positiveInteger(match?.[1]?.replaceAll(",", ""));
    if (parsed) return parsed;
  }
  return null;
}

function parseProviderPayload(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function positiveInteger(value) {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
