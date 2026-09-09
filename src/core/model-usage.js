export const TOKEN_ESTIMATOR_VERSION = "utf8-bytes-div3-v1";

// The window planner and accounting use the same final, provider-visible input.
// This is an estimate, not a claim about the provider's tokenizer.
export function measureModelRequest({ systemPrompt = "", messages = [], tools = [] } = {}) {
  const fixedTokens = estimateTokenValue(systemPrompt) + estimateTokenValue(tools) + 8;
  const messageTokens = messages.reduce((total, message) => total + estimateTokenValue(message) + 4, 0);
  return { fixedTokens, messageTokens, estimatedInputTokens: fixedTokens + messageTokens };
}

export function estimateTokenValue(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(new TextEncoder().encode(serialized || "").length / 3));
}

export function normalizeModelUsage(supplied, request, response = {}) {
  if (supplied != null && (typeof supplied !== "object" || Array.isArray(supplied))) {
    throw new Error("Provider Token usage 必须是对象");
  }
  const input = readCount(supplied, "inputTokens", ["inputTokens", "prompt_tokens", "input_tokens"]);
  const output = readCount(supplied, "outputTokens", ["outputTokens", "completion_tokens", "output_tokens"]);
  const total = readCount(supplied, "totalTokens", ["totalTokens", "total_tokens"]);
  if (total !== undefined && ((input !== undefined && input > total)
    || (output !== undefined && output > total)
    || (input !== undefined && output !== undefined && input + output !== total))) {
    throw new Error("Provider Token usage 分项与总量不一致");
  }
  let inputTokens = input;
  let outputTokens = output;
  let estimated = false;
  if (total !== undefined && (input !== undefined || output !== undefined)) {
    inputTokens ??= total - output;
    outputTokens ??= total - input;
  } else if (input === undefined || output === undefined) {
    const estimatedInput = measureModelRequest(request).estimatedInputTokens;
    const estimatedOutput = estimateOutput(response);
    estimated = true;
    if (total !== undefined) {
      // Preserve an authoritative reported total. Only its allocation is inferred.
      inputTokens = Math.round(total * (estimatedInput / (estimatedInput + estimatedOutput)));
      outputTokens = total - inputTokens;
    } else {
      inputTokens ??= estimatedInput;
      outputTokens ??= estimatedOutput;
    }
  }
  const totalTokens = total ?? inputTokens + outputTokens;
  for (const [field, count] of Object.entries({ inputTokens, outputTokens, totalTokens })) assertTokenCount(count, field);
  return {
    usage: { inputTokens, outputTokens, totalTokens },
    usageEstimated: estimated,
    usageEstimator: estimated ? TOKEN_ESTIMATOR_VERSION : null,
    usageMissingFields: Object.entries({ inputTokens: input, outputTokens: output, totalTokens: total })
      .filter(([, count]) => count === undefined).map(([field]) => field),
  };
}

export function noModelUsage() {
  return {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageEstimated: false,
    usageEstimator: null,
    usageMissingFields: [],
  };
}

function estimateOutput(response) {
  let tokens = response.text ? estimateTokenValue(response.text) : 0;
  if (response.toolCalls?.length) tokens += estimateTokenValue(response.toolCalls);
  if (response.providerItems?.length) tokens += estimateTokenValue(response.providerItems);
  return tokens;
}

function readCount(supplied, field, aliases) {
  let count;
  for (const alias of aliases) {
    if (supplied?.[alias] === undefined) continue;
    assertTokenCount(supplied[alias], alias);
    if (count !== undefined && count !== supplied[alias]) throw new Error(`Provider Token usage ${field} 别名不一致`);
    count = supplied[alias];
  }
  return count;
}

function assertTokenCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Provider Token usage ${field} 必须是非负安全整数`);
}
