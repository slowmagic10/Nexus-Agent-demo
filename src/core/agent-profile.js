// FOUNDATION — immutable, secret-free runtime identity captured in each Session journal.
import { createHash } from "node:crypto";
import path from "node:path";
import { createMemoryScope } from "../memory/scope.js";

export const AGENT_PROFILE_SCHEMA_VERSION = 1;

export function createAgentProfileSnapshot({
  id = "default",
  provider,
  workspace,
  systemPrompt = "",
  toolSchemas = [],
  permission = {},
  execution = null,
  memoryScope,
  budgets = {},
} = {}) {
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const schemas = normalizeToolSchemas(toolSchemas);
  const core = {
    schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
    id: normalizeText(id, "Agent Profile id"),
    provider: normalizeProvider(provider),
    workspace: normalizedWorkspace,
    systemPromptHash: hashValue(renderPrompt(systemPrompt)),
    toolset: {
      names: schemas.map((schema) => schema.function.name),
      schemaHash: hashValue(schemas),
    },
    skills: {
      mode: "journal-loaded",
      initial: [],
    },
    permission: normalizePermission(permission),
    execution: normalizeExecution(execution),
    memoryScope: createMemoryScope(memoryScope || { workspace: normalizedWorkspace }),
    budgets: normalizeBudgets(budgets),
  };
  return { ...core, version: hashValue(core) };
}

export function createLegacyAgentProfileSnapshot(state) {
  return createAgentProfileSnapshot({
    id: "legacy-default",
    provider: { name: state.provider, adapter: "legacy", model: state.provider },
    workspace: state.workspace,
    permission: {
      defaultProfile: state.permissionProfile || "workspace-auto",
      profiles: [{ name: state.permissionProfile || "workspace-auto", policyVersion: null }],
    },
    memoryScope: state.memoryScope || { workspace: state.workspace },
  });
}

export function deriveAgentProfileSnapshot(profile, {
  provider,
  workspace,
  memoryScope,
  budgets,
} = {}) {
  const current = assertAgentProfileSnapshot(profile);
  const normalizedWorkspace = workspace === undefined ? current.workspace : normalizeWorkspace(workspace);
  const core = {
    ...withoutVersion(current),
    ...(provider === undefined ? {} : { provider: normalizeProvider(provider) }),
    workspace: normalizedWorkspace,
    memoryScope: createMemoryScope(memoryScope || {
      ...current.memoryScope,
      workspace: normalizedWorkspace,
    }),
    ...(budgets === undefined ? {} : { budgets: normalizeBudgets(budgets) }),
  };
  return { ...core, version: hashValue(core) };
}

export function assertAgentProfileSnapshot(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Session 缺少 Agent Profile snapshot");
  }
  if (profile.schemaVersion !== AGENT_PROFILE_SCHEMA_VERSION) {
    throw new Error(`不支持的 Agent Profile schema version：${profile.schemaVersion}`);
  }
  const expected = hashValue(withoutVersion(profile));
  if (profile.version !== expected) throw new Error("Agent Profile snapshot version 与内容不匹配");
  return structuredClone(profile);
}

export function compareAgentProfileSnapshots(previousProfile, currentProfile) {
  const previous = assertAgentProfileSnapshot(previousProfile);
  const current = assertAgentProfileSnapshot(currentProfile);
  const changes = [];
  compareScalar(changes, "profile.id", "identity", "medium", previous.id, current.id);
  compareScalar(changes, "provider.name", "provider", "high", previous.provider.name, current.provider.name);
  compareScalar(changes, "provider.adapter", "provider", "high", previous.provider.adapter, current.provider.adapter);
  compareScalar(changes, "provider.model", "provider", "high", previous.provider.model, current.provider.model);
  compareScalar(changes, "provider.endpoint", "provider", "high", previous.provider.endpointHash, current.provider.endpointHash);
  compareScalar(changes, "workspace", "scope", "high", previous.workspace, current.workspace);
  compareScalar(changes, "systemPrompt", "context", "medium", previous.systemPromptHash, current.systemPromptHash);
  if (previous.toolset.schemaHash !== current.toolset.schemaHash) {
    const before = new Set(previous.toolset.names);
    const after = new Set(current.toolset.names);
    changes.push({
      field: "toolset",
      category: "capability",
      impact: "medium",
      previous: previous.toolset.schemaHash,
      current: current.toolset.schemaHash,
      added: current.toolset.names.filter((name) => !before.has(name)),
      removed: previous.toolset.names.filter((name) => !after.has(name)),
    });
  }
  compareValue(changes, "permission", "policy", "medium", previous.permission, current.permission);
  compareValue(changes, "execution", "execution", "high", previous.execution, current.execution);
  compareValue(changes, "memoryScope", "scope", "high", previous.memoryScope, current.memoryScope);
  compareScalar(changes, "budgets.maxSteps", "budget", "low", previous.budgets.maxSteps, current.budgets.maxSteps);
  compareScalar(changes, "budgets.maxTokensPerTurn", "budget", "low", previous.budgets.maxTokensPerTurn, current.budgets.maxTokensPerTurn);
  return changes;
}

function normalizeProvider(provider) {
  const source = typeof provider === "string" ? { name: provider } : provider || {};
  const name = normalizeText(source.name || source.model || source.id, "Agent Profile provider.name");
  return {
    name,
    adapter: normalizeText(source.adapter || source.type || "unknown", "Agent Profile provider.adapter"),
    model: normalizeText(source.model || name, "Agent Profile provider.model"),
    endpointHash: source.endpointHash == null && source.baseUrl == null
      ? null
      : normalizeEndpointHash(source.endpointHash || hashValue(String(source.baseUrl))),
  };
}

function compareScalar(changes, field, category, impact, previous, current) {
  if (previous === current) return;
  changes.push({ field, category, impact, previous: previous ?? null, current: current ?? null });
}

function compareValue(changes, field, category, impact, previous, current) {
  if (stableStringify(previous) === stableStringify(current)) return;
  changes.push({ field, category, impact, previous, current });
}

function normalizeEndpointHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Agent Profile provider.endpointHash 必须是 SHA-256");
  }
  return value;
}

function normalizePermission(permission) {
  const sourceProfiles = Array.isArray(permission.profiles) ? permission.profiles : [];
  const profiles = sourceProfiles.map((item) => (
    typeof item === "string"
      ? { name: normalizeText(item, "Permission Profile name"), policyVersion: null }
      : {
          name: normalizeText(item?.name, "Permission Profile name"),
          policyVersion: item?.policyVersion == null ? null : normalizeText(item.policyVersion, "Policy version"),
        }
  )).sort((left, right) => left.name.localeCompare(right.name));
  const defaultProfile = normalizeText(permission.defaultProfile || profiles[0]?.name || "workspace-auto", "默认 Permission Profile");
  if (!profiles.some((item) => item.name === defaultProfile)) profiles.push({ name: defaultProfile, policyVersion: null });
  profiles.sort((left, right) => left.name.localeCompare(right.name));
  return { defaultProfile, profiles };
}

function normalizeExecution(execution) {
  if (!execution) return { id: "unknown", isolation: "unknown" };
  return {
    id: normalizeText(execution.id || execution.type || "unknown", "Execution id"),
    isolation: normalizeText(execution.isolation || execution.type || "unknown", "Execution isolation"),
  };
}

function normalizeBudgets(budgets) {
  return {
    maxSteps: normalizeBudget(budgets.maxSteps, "maxSteps"),
    maxTokensPerTurn: normalizeBudget(budgets.maxTokensPerTurn, "maxTokensPerTurn"),
  };
}

function normalizeBudget(value, label) {
  if (value === undefined || value === Infinity || value === "unlimited") return "unlimited";
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Agent Profile ${label} 必须是正整数或 unlimited`);
  return value;
}

function normalizeToolSchemas(value) {
  if (!Array.isArray(value)) throw new Error("Agent Profile toolSchemas 必须是数组");
  const schemas = value.map((schema) => {
    if (schema?.type !== "function" || typeof schema.function?.name !== "string" || !schema.function.name.trim()) {
      throw new Error("Agent Profile tool schema 无效");
    }
    return structuredClone(schema);
  }).sort((left, right) => left.function.name.localeCompare(right.function.name));
  const names = schemas.map((schema) => schema.function.name);
  if (new Set(names).size !== names.length) throw new Error("Agent Profile tool schema 名称重复");
  return schemas;
}

function renderPrompt(systemPrompt) {
  if (typeof systemPrompt !== "function") return String(systemPrompt || "");
  return String(systemPrompt({
    memory: [],
    objective: null,
    plan: null,
    delegations: [],
    contextMemory: [],
    contextSummary: null,
    loadedSkills: [],
  }) || "");
}

function normalizeWorkspace(value) {
  return path.resolve(normalizeText(value, "Agent Profile workspace"));
}

function normalizeText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function withoutVersion(profile) {
  const { version: _version, ...core } = structuredClone(profile);
  return core;
}

function hashValue(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(",")}}`;
}
