export const MEMORY_CONTEXT_ESTIMATOR_VERSION = "utf8-bytes-div3-v1";
export const DEFAULT_PINNED_MEMORY_TOKENS = 1_200;
export const DEFAULT_RELEVANT_MEMORY_TOKENS = 2_000;

export async function retrieveContextMemories(memory, query, {
  scope,
  signal,
  pinnedLimit = 20,
  relevantLimit = 5,
  pinnedTokenBudget = DEFAULT_PINNED_MEMORY_TOKENS,
  relevantTokenBudget = DEFAULT_RELEVANT_MEMORY_TOKENS,
} = {}) {
  if (!memory || typeof memory.search !== "function") throw new Error("Context Memory retrieval 需要 Memory Adapter");
  validateBudget(pinnedTokenBudget, "pinnedTokenBudget");
  validateBudget(relevantTokenBudget, "relevantTokenBudget");
  const access = { scope, signal };
  const pinned = await memory.search("", access, { limit: pinnedLimit, statuses: ["active"], pinned: true });
  const relevant = await memory.search(query, access, { limit: relevantLimit, statuses: ["active"], pinned: false });
  const pinnedIds = new Set(pinned.map((item) => item.id));
  return [
    ...selectWithinBudget(pinned, "pinned", pinnedTokenBudget),
    ...selectWithinBudget(relevant.filter((item) => !pinnedIds.has(item.id)), "relevant", relevantTokenBudget),
  ];
}

function selectWithinBudget(records, retrievalClass, maxTokens) {
  const selected = [];
  let remaining = maxTokens;
  for (const record of records) {
    const fitted = fitRecord(record, remaining);
    if (!fitted) continue;
    remaining -= fitted.estimatedTokens;
    selected.push({
      ...fitted.record,
      pinned: retrievalClass === "pinned",
      contextRetrievalClass: retrievalClass,
      contextTruncated: fitted.truncated,
      contextEstimatedTokens: fitted.estimatedTokens,
      contextBudgetTokens: maxTokens,
      contextEstimatorVersion: MEMORY_CONTEXT_ESTIMATOR_VERSION,
    });
    if (remaining < 1) break;
  }
  return selected;
}

function fitRecord(record, remaining) {
  const overhead = 24;
  if (remaining <= overhead) return null;
  const contentTokens = estimateTokens(record.content);
  if (contentTokens + overhead <= remaining) {
    return { record, estimatedTokens: contentTokens + overhead, truncated: false };
  }
  const marker = "…[按上下文预算截断]";
  const contentBudget = remaining - overhead - estimateTokens(marker);
  if (contentBudget < 1) return null;
  const content = truncateToTokens(record.content, contentBudget);
  if (!content) return null;
  return {
    record: { ...record, content: `${content}${marker}` },
    estimatedTokens: Math.min(remaining, estimateTokens(content) + estimateTokens(marker) + overhead),
    truncated: true,
  };
}

function truncateToTokens(value, maxTokens) {
  const characters = Array.from(String(value || ""));
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, middle).join("")) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(new TextEncoder().encode(String(value || "")).length / 3));
}

function validateBudget(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是正整数`);
}
