export const CONTEXT_BUDGET_VERSION = "context-budget-v1";
const OUTPUT_PARAMETERS = new Set(["max_tokens", "max_completion_tokens"]);

// Explicit request settings describe what this adapter sends, not capabilities
// discovered from a model name or a remote service probe.
export function normalizeProviderRequestPolicy(source = {}, { adapter = source?.type ?? source?.adapter } = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Provider request policy 必须是对象");
  const contextTargetTokens = optionalTokens(source.contextTargetTokens, "provider.contextTargetTokens");
  const maxOutputTokens = optionalTokens(source.maxOutputTokens, "provider.maxOutputTokens");
  const outputTokenParameter = source.outputTokenParameter ?? null;
  const streamUsage = source.streamUsage === undefined ? false : source.streamUsage;
  if (outputTokenParameter !== null && !OUTPUT_PARAMETERS.has(outputTokenParameter)) {
    throw new Error("provider.outputTokenParameter 必须是 max_tokens、max_completion_tokens 或 null");
  }
  if (typeof streamUsage !== "boolean") throw new Error("provider.streamUsage 必须是布尔值");
  if (adapter === "openai-compatible") {
    if (maxOutputTokens !== null && outputTokenParameter === null) {
      throw new Error("openai-compatible 设置 maxOutputTokens 时必须显式选择 outputTokenParameter");
    }
  } else if (outputTokenParameter !== null || streamUsage) {
    throw new Error("outputTokenParameter 与 streamUsage 仅支持 openai-compatible Adapter");
  }
  if (maxOutputTokens !== null && !["openai-compatible", "openai-responses"].includes(adapter)) {
    throw new Error("maxOutputTokens 需要支持输出上限的 Provider Adapter");
  }
  if (source.contextWindowTokens !== undefined) {
    const window = positiveTokens(source.contextWindowTokens, "provider.contextWindowTokens");
    if (contextTargetTokens !== null && contextTargetTokens > window) {
      throw new Error("provider.contextTargetTokens 不能超过 contextWindowTokens");
    }
    if (maxOutputTokens !== null && maxOutputTokens >= window) {
      throw new Error("provider.maxOutputTokens 必须小于 contextWindowTokens，为输入保留空间");
    }
  }
  return { contextTargetTokens, maxOutputTokens, outputTokenParameter, streamUsage };
}

// Omit defaults so old profiles and old request hashes remain unchanged.
export function providerRequestOverrides(source = {}, options) {
  const policy = normalizeProviderRequestPolicy(source, options);
  return Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== null && value !== false));
}

export function resolveContextBudget(source = {}) {
  const contextWindowTokens = positiveTokens(source.contextWindowTokens ?? 32_000, "provider.contextWindowTokens");
  const contextTargetTokens = optionalTokens(source.contextTargetTokens, "provider.contextTargetTokens") ?? contextWindowTokens;
  const reservedOutputTokens = optionalTokens(source.maxOutputTokens, "provider.maxOutputTokens") ?? 0;
  if (contextTargetTokens > contextWindowTokens) throw new Error("provider.contextTargetTokens 不能超过 contextWindowTokens");
  if (reservedOutputTokens >= contextWindowTokens) throw new Error("provider.maxOutputTokens 必须小于 contextWindowTokens，为输入保留空间");
  return { version: CONTEXT_BUDGET_VERSION, contextWindowTokens, contextTargetTokens, reservedOutputTokens,
    maxInputTokens: Math.min(contextTargetTokens, contextWindowTokens - reservedOutputTokens) };
}

export function configuredContextBudget(source) {
  return source && (source.contextTargetTokens != null || source.maxOutputTokens != null)
    ? resolveContextBudget(source) : null;
}

export function assertContextBudget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Number.isSafeInteger(value.reservedOutputTokens) || value.reservedOutputTokens < 0) {
    throw new Error("Context budget 无效");
  }
  const expected = resolveContextBudget({ contextWindowTokens: value.contextWindowTokens,
    contextTargetTokens: value.contextTargetTokens, maxOutputTokens: value.reservedOutputTokens || null });
  if (Object.keys(value).length !== Object.keys(expected).length
      || Object.entries(expected).some(([key, field]) => value[key] !== field)) {
    throw new Error("Context budget 与窗口、目标和输出预留不一致");
  }
  return expected;
}

function optionalTokens(value, label) {
  return value === undefined || value === null ? null : positiveTokens(value, label);
}

function positiveTokens(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是安全的正整数`);
  return value;
}
