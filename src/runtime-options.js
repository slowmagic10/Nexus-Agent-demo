const DEFAULT_MAX_STEPS = 8;
const UNLIMITED_VALUES = new Set(["0", "unlimited", "infinite", "none", "无限", "不限制"]);

export function readRuntimeOptions(args = [], env = {}) {
  const argument = valueArg(args, "max-steps");
  return {
    maxSteps: parseMaxSteps(argument ?? env.NEXUS_MAX_STEPS),
  };
}

export function parseMaxSteps(value, fallback = DEFAULT_MAX_STEPS) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
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

function valueArg(values, name) {
  return values.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}
