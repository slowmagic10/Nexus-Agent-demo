const DEFAULT_MAX_STEPS = Infinity;
const DEFAULT_MAX_TOKENS_PER_TURN = Infinity;
const UNLIMITED_VALUES = new Set(["0", "unlimited", "infinite", "none", "无限", "不限制"]);

export function readRuntimeOptions(args = [], env = {}) {
  const argument = valueArg(args, "max-steps");
  const tokenArgument = valueArg(args, "max-tokens-per-turn");
  return {
    maxSteps: parseMaxSteps(argument ?? env.NEXUS_MAX_STEPS),
    maxTokensPerTurn: parseMaxTokensPerTurn(tokenArgument ?? env.NEXUS_MAX_TOKENS_PER_TURN),
  };
}

export function parseMaxSteps(value, fallback = DEFAULT_MAX_STEPS) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  if (value === Infinity) return Infinity;
  const normalized = String(value).trim().toLowerCase();
  if (UNLIMITED_VALUES.has(normalized)) return Infinity;
  if (!/^\d+$/.test(normalized)) {
    throw new Error("最大步骤数必须是正整数，或使用 unlimited/0 表示不限制");
  }
  const steps = Number(normalized);
  if (!Number.isSafeInteger(steps) || steps < 1) {
    throw new Error("最大步骤数必须是安全的正整数，或使用 unlimited/0 表示不限制");
  }
  return steps;
}

export function formatMaxSteps(value) {
  return value === Infinity ? "不限制" : String(value);
}

export function parseMaxTokensPerTurn(value, fallback = DEFAULT_MAX_TOKENS_PER_TURN) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  if (value === Infinity) return Infinity;
  const normalized = String(value).trim().toLowerCase();
  if (UNLIMITED_VALUES.has(normalized)) return Infinity;
  if (!/^\d+$/.test(normalized)) {
    throw new Error("单次任务 Token 预算必须是正整数，或使用 unlimited/0 表示不限制");
  }
  const tokens = Number(normalized);
  if (!Number.isSafeInteger(tokens) || tokens < 1) {
    throw new Error("单次任务 Token 预算必须是安全的正整数，或使用 unlimited/0 表示不限制");
  }
  return tokens;
}

export function formatMaxTokensPerTurn(value) {
  return value === Infinity ? "不限制" : String(value);
}

function valueArg(values, name) {
  return values.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}
