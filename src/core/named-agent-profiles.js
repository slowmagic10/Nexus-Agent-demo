// FOUNDATION — trusted local presets over one active Provider; routing stays explicit.
import {
  formatMaxSteps,
  formatMaxTokensPerTurn,
  parseMaxSteps,
  parseMaxTokensPerTurn,
} from "../runtime-options.js";

const SAFE_PERMISSION_PROFILES = new Set([
  "read-only",
  "approval-required",
  "workspace-confirm",
  "workspace-untrusted",
  "workspace-auto",
]);
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROVIDER_TYPES = new Set(["auto", "demo", "openai-compatible"]);

export function normalizeNamedAgentProfiles(raw, {
  defaultId = "default",
  defaultPermissionProfile = "workspace-auto",
  maxSteps = Infinity,
  maxTokensPerTurn = Infinity,
  defaultProvider = {
    type: "demo",
    apiKey: null,
    baseUrl: null,
    model: "offline-demo",
  },
} = {}) {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("agents.profiles 必须是对象");
  }
  const source = raw || {};
  if (Object.keys(source).length > 32) throw new Error("具名 Agent Profile 最多 32 个");
  const profiles = Object.entries(source).map(([id, value]) => normalizeProfile(id, value, {
    defaultPermissionProfile,
    maxSteps,
    maxTokensPerTurn,
    defaultProvider,
  }));
  if (!profiles.some((profile) => profile.id === "default")) {
    profiles.unshift(normalizeProfile("default", {}, {
      defaultPermissionProfile,
      maxSteps,
      maxTokensPerTurn,
      defaultProvider,
    }));
  }
  profiles.sort((left, right) => left.id.localeCompare(right.id));
  const selected = normalizeId(defaultId, "agents.default");
  if (!profiles.some((profile) => profile.id === selected)) {
    throw new Error(`默认 Agent Profile 不存在：${selected}`);
  }
  return Object.freeze({
    defaultProfile: selected,
    profiles: Object.freeze(profiles.map(Object.freeze)),
  });
}

export function inspectNamedAgentProfiles(catalog) {
  return {
    defaultProfile: catalog.defaultProfile,
    profiles: catalog.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      description: profile.description,
      permissionProfile: profile.permissionProfile,
      maxSteps: formatMaxSteps(profile.maxSteps),
      maxTokensPerTurn: formatMaxTokensPerTurn(profile.maxTokensPerTurn),
      hasInstructions: Boolean(profile.instructions),
      provider: {
        type: profile.provider.type,
        model: profile.provider.model,
        baseUrl: profile.provider.baseUrl,
        apiKey: profile.provider.apiKey ? "[REDACTED]" : null,
      },
    })),
  };
}

export function appendAgentInstructions(systemPrompt, instructions) {
  const addition = String(instructions || "").trim();
  if (!addition) return systemPrompt;
  return (context) => {
    const base = typeof systemPrompt === "function" ? systemPrompt(context) : systemPrompt;
    return `${String(base || "").trim()}\n\n## Agent Profile instructions\n${addition}`.trim();
  };
}

function normalizeProfile(id, value, defaults) {
  normalizeId(id, "Agent Profile id");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent Profile ${id} 必须是对象`);
  }
  assertKnownKeys(value, new Set([
    "label",
    "description",
    "instructions",
    "permissionProfile",
    "maxSteps",
    "maxTokensPerTurn",
    "provider",
  ]), `Agent Profile ${id}`);
  const permissionProfile = value.permissionProfile ?? defaults.defaultPermissionProfile;
  if (!SAFE_PERMISSION_PROFILES.has(permissionProfile)) {
    throw new Error(`Agent Profile ${id} 的 permissionProfile 必须是安全档位`);
  }
  return {
    id,
    label: normalizeOptionalText(value.label, id, `Agent Profile ${id}.label`, 80),
    description: normalizeOptionalText(value.description, "", `Agent Profile ${id}.description`, 240),
    instructions: normalizeOptionalText(value.instructions, "", `Agent Profile ${id}.instructions`, 12_000),
    provider: normalizeProvider(value.provider, defaults.defaultProvider, id),
    permissionProfile,
    maxSteps: value.maxSteps === undefined ? defaults.maxSteps : parseMaxSteps(value.maxSteps),
    maxTokensPerTurn: value.maxTokensPerTurn === undefined
      ? defaults.maxTokensPerTurn
      : parseMaxTokensPerTurn(value.maxTokensPerTurn),
  };
}

function normalizeProvider(value, fallback, profileId) {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`Agent Profile ${profileId}.provider 必须是对象`);
  }
  const override = value || {};
  assertKnownKeys(override, new Set(["type", "apiKey", "baseUrl", "model"]), `Agent Profile ${profileId}.provider`);
  const provider = {
    type: override.type ?? fallback.type,
    apiKey: override.apiKey ?? fallback.apiKey ?? null,
    baseUrl: override.baseUrl ?? fallback.baseUrl ?? null,
    model: override.model ?? fallback.model,
  };
  if (!PROVIDER_TYPES.has(provider.type)) {
    throw new Error(`Agent Profile ${profileId}.provider.type 必须是 auto、demo 或 openai-compatible`);
  }
  if (provider.type === "auto") provider.type = provider.apiKey ? "openai-compatible" : "demo";
  if (provider.type === "demo") {
    return Object.freeze({ type: "demo", apiKey: null, baseUrl: null, model: "offline-demo" });
  }
  if (provider.apiKey !== null && typeof provider.apiKey !== "string") {
    throw new Error(`Agent Profile ${profileId}.provider.apiKey 必须是字符串`);
  }
  for (const key of ["baseUrl", "model"]) {
    if (typeof provider[key] !== "string" || !provider[key].trim()) {
      throw new Error(`Agent Profile ${profileId}.provider.${key} 必须是非空字符串`);
    }
    provider[key] = provider[key].trim();
  }
  return Object.freeze(provider);
}

function normalizeId(value, label) {
  if (typeof value !== "string" || !PROFILE_ID.test(value)) {
    throw new Error(`${label} 只能包含小写字母、数字、下划线和连字符，且最长 64 字符`);
  }
  return value;
}

function normalizeOptionalText(value, fallback, label, maxLength) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} 最长 ${maxLength} 字符`);
  return normalized || fallback;
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} 包含未知字段 ${unknown}`);
}
