// FOUNDATION — capability, workspace policy and durable session-grant decisions.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { createPermissionProfile } from "./permission-profile.js";
import { projectIdentity } from "./project-grant-store.js";

const DECISIONS = new Set(["allow", "approval_required", "deny"]);
const RISKS = new Set(["R0", "R1", "R2", "R3"]);
const RESOURCE_KINDS = new Set(["workspace_path", "workspace", "shell_command", "memory_scope", "mcp_server", "session", "external"]);
const POLICY_FILE = path.join(".nexus", "tool-policy.json");

export class WorkspacePolicy {
  constructor(config = {}, {
    profile = createPermissionProfile({ name: "approval-required", workspace: process.cwd(), executionType: "local" }),
    allowElevation = true,
  } = {}) {
    if (!profile || typeof profile.authorize !== "function" || typeof profile.canExpose !== "function") {
      throw new Error("Workspace Policy 需要 Permission Profile");
    }
    this.profile = profile;
    this.allowElevation = Boolean(allowElevation);
    this.replace(config);
  }

  replace(config = {}) {
    this.config = normalizePolicyConfig(config);
    this.version = hashValue({ schemaVersion: 2, profileVersion: this.profile.version, allowElevation: this.allowElevation, ...this.config });
    return this;
  }

  authorize({ definition, call, state, argsHash, projectGrants = [], now = new Date().toISOString() }) {
    const capability = definition.capability;
    const capabilityHash = capabilityVersion(capability);
    let resources;
    try {
      resources = resolveCapabilityResources(capability, call.arguments, state);
    } catch (error) {
      if (!(error instanceof WorkspaceBoundaryError)) throw error;
      return decisionResult({
        decision: "deny",
        policyVersion: this.version,
        ruleId: "builtin.workspace_boundary",
        reason: error.message,
        capability,
        capabilityHash,
        resources: [],
      });
    }

    const policy = this.#policyDecision(definition, call, resources);
    if (policy.decision !== "approval_required") {
      return decisionResult({ ...policy, policyVersion: this.version, capability, capabilityHash, resources });
    }

    const grant = (state.toolGrants || []).find((candidate) => grantMatches(candidate, {
      state,
      definition,
      capabilityHash,
      resources,
      policyVersion: this.version,
      argsHash,
      callId: call.id,
      now,
    })) || projectGrants.find((candidate) => grantMatches(candidate, {
      state,
      definition,
      capabilityHash,
      resources,
      policyVersion: this.version,
      argsHash,
      callId: call.id,
      now,
    }));
    if (grant) {
      const grantScope = grant.scope || (grantUsage(grant) === "single_use" ? "once" : "session");
      return decisionResult({
        decision: "allow",
        policyVersion: this.version,
        ruleId: policy.ruleId,
        reason: `命中 ${grantScope === "project" ? "Project" : "Session"} Grant ${grant.id}`,
        capability,
        capabilityHash,
        resources,
        grantId: grant.id,
        grantScope,
        baseDecision: "approval_required",
        profile: policy.profile,
        explanation: { ...policy.explanation, layer: `${grantScope}_grant`, grantId: grant.id, grantScope },
      });
    }
    return decisionResult({ ...policy, policyVersion: this.version, capability, capabilityHash, resources });
  }

  canExpose(definition) {
    const matched = this.config.rules.filter((rule) => (
      !rule.pathPrefixes && ruleMatchesDefinition(rule, definition)
    ));
    if (matched.some((rule) => rule.decision === "deny")) return false;
    return this.profile.canExpose(definition);
  }

  #policyDecision(definition, call, resources) {
    const profile = this.profile.authorize({ definition, call, resources });
    const matched = this.config.rules.filter((rule) => ruleMatches(rule, definition, resources));
    const deny = matched.find((rule) => rule.decision === "deny");
    const rule = deny || matched[0];
    if (!rule) return profile;
    const workspace = {
      decision: rule.decision,
      ruleId: rule.id,
      reason: rule.reason || `命中 Workspace Policy 规则 ${rule.id}`,
      profile: this.profile.name,
      explanation: { layer: "workspace_policy", category: "workspace_rule", workspaceRuleId: rule.id },
    };
    if (profile.decision === "deny") return profile;
    if (this.allowElevation || decisionRank(workspace.decision) >= decisionRank(profile.decision)) {
      return { ...workspace, ...(profile.approvalScopes ? { approvalScopes: profile.approvalScopes } : {}) };
    }
    return {
      ...profile,
      reason: `${profile.reason}；Workspace Policy 规则 ${rule.id} 无权提升 Permission Profile`,
      explanation: { ...profile.explanation, workspaceRuleId: rule.id, elevationBlocked: true },
    };
  }
}

export async function loadWorkspacePolicy(workspace, { profile } = {}) {
  const file = path.join(path.resolve(workspace), POLICY_FILE);
  try {
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    return new WorkspacePolicy(config, { profile, allowElevation: false });
  } catch (error) {
    if (error?.code === "ENOENT") return new WorkspacePolicy({}, { profile, allowElevation: false });
    throw new Error(`Workspace Policy 加载失败 ${file}：${error.message}`);
  }
}

export function normalizeCapability(definition) {
  const effects = [...definition.effects];
  const configured = definition.capability || {};
  const resources = configured.resources?.length
    ? configured.resources.map(normalizeResourceDescriptor)
    : [{ kind: definition.adapter === "mcp" ? "external" : "session", value: definition.adapter || "native" }];
  const readOnly = configured.readOnly ?? !effects.some((effect) => (
    ["write", "execute", "network", "credential"].includes(effect)
  ));
  const risk = configured.risk || riskLevel(effects);
  if (!RISKS.has(risk)) throw new Error(`工具 ${definition.name} capability.risk 无效`);
  if (readOnly && effects.some((effect) => ["write", "execute", "credential"].includes(effect))) {
    throw new Error(`工具 ${definition.name} 的只读 capability 不能声明写入或执行副作用`);
  }
  return { effects, resources, risk, readOnly };
}

export function createSessionGrant({
  id,
  sessionId,
  workspace,
  tool,
  capabilityHash,
  policyVersion,
  resources,
  callId = null,
  argsHash = null,
  issuedAt = new Date().toISOString(),
  expiresAt,
}) {
  for (const [label, value] of Object.entries({ sessionId, workspace, tool, capabilityHash, policyVersion })) {
    if (typeof value !== "string" || !value) throw new Error(`Session Grant ${label} 无效`);
  }
  if (!Array.isArray(resources)) throw new Error("Session Grant resources 必须是数组");
  const expiry = expiresAt || new Date(new Date(issuedAt).getTime() + 15 * 60_000).toISOString();
  if (!Number.isFinite(new Date(issuedAt).getTime()) || !Number.isFinite(new Date(expiry).getTime())) {
    throw new Error("Session Grant 时间无效");
  }
  return {
    id: id || `grant-${randomUUID()}`,
    sessionId,
    workspace: path.resolve(workspace),
    tool,
    capabilityHash,
    policyVersion,
    resources: resources.map(grantResource),
    callId,
    argsHash,
    issuedAt,
    expiresAt: expiry,
    usage: callId || argsHash ? "single_use" : "session",
    scope: callId || argsHash ? "once" : "session",
    consumedAt: null,
    consumedByCallId: null,
    revokedAt: null,
  };
}

export function createProjectGrant({
  id,
  workspace,
  tool,
  capabilityHash,
  policyVersion,
  resources,
  issuedAt = new Date().toISOString(),
  expiresAt,
}) {
  for (const [label, value] of Object.entries({ workspace, tool, capabilityHash, policyVersion })) {
    if (typeof value !== "string" || !value) throw new Error(`Project Grant ${label} 无效`);
  }
  if (!Array.isArray(resources)) throw new Error("Project Grant resources 必须是数组");
  const expiry = expiresAt || new Date(new Date(issuedAt).getTime() + 30 * 24 * 60 * 60_000).toISOString();
  if (!Number.isFinite(new Date(issuedAt).getTime()) || !Number.isFinite(new Date(expiry).getTime())) {
    throw new Error("Project Grant 时间无效");
  }
  const resolvedWorkspace = path.resolve(workspace);
  return {
    id: id || `project-grant-${randomUUID()}`,
    scope: "project",
    usage: "project",
    projectId: projectIdentity(resolvedWorkspace),
    workspace: resolvedWorkspace,
    tool,
    capabilityHash,
    policyVersion,
    resources: resources.map(grantResource),
    issuedAt,
    expiresAt: expiry,
    revokedAt: null,
    revokedReason: null,
  };
}

export async function issueSessionGrant(session, grant) {
  if (grant.sessionId !== session.id || path.resolve(grant.workspace) !== path.resolve(session.state.workspace)) {
    throw new Error("Session Grant 不能跨 Session 或 workspace 签发");
  }
  await session.dispatch({ type: "TOOL_GRANT_ISSUED", grant });
  return grant;
}

export async function revokeSessionGrant(session, grantId, reason = "用户撤销授权") {
  if (typeof grantId !== "string" || !grantId) throw new Error("Session Grant ID 无效");
  await session.dispatch({ type: "TOOL_GRANT_REVOKED", grantId, reason });
}

export async function consumeSessionGrant(session, grantId, callId) {
  const grant = session.state.toolGrants?.find((candidate) => candidate.id === grantId);
  if (!grant) throw new Error(`未找到 Session Grant：${grantId}`);
  if (grantUsage(grant) !== "single_use") return false;
  if (grant.consumedAt) throw new Error(`Session Grant 已消费：${grantId}`);
  if (grant.callId && grant.callId !== callId) throw new Error(`Session Grant 与 Tool Call 不匹配：${grantId}`);
  await session.dispatch({ type: "TOOL_GRANT_CONSUMED", grantId, callId });
  return true;
}

export function capabilityVersion(capability) {
  return hashValue(capability);
}

function normalizePolicyConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Workspace Policy 必须是 JSON 对象");
  const rules = config.rules || [];
  if (!Array.isArray(rules)) throw new Error("Workspace Policy rules 必须是数组");
  const ids = new Set();
  return {
    rules: rules.map((rule, index) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`Workspace Policy rules[${index}] 无效`);
      if (typeof rule.id !== "string" || !rule.id || ids.has(rule.id)) throw new Error(`Workspace Policy rules[${index}].id 无效或重复`);
      ids.add(rule.id);
      if (!DECISIONS.has(rule.decision)) throw new Error(`Workspace Policy 规则 ${rule.id} decision 无效`);
      return {
        id: rule.id,
        decision: rule.decision,
        ...(rule.tools ? { tools: stringArray(rule.tools, `${rule.id}.tools`) } : {}),
        ...(rule.effects ? { effects: stringArray(rule.effects, `${rule.id}.effects`) } : {}),
        ...(rule.adapters ? { adapters: stringArray(rule.adapters, `${rule.id}.adapters`) } : {}),
        ...(rule.pathPrefixes ? { pathPrefixes: stringArray(rule.pathPrefixes, `${rule.id}.pathPrefixes`).map(normalizePathPrefix) } : {}),
        ...(rule.reason ? { reason: String(rule.reason) } : {}),
      };
    }),
  };
}

function normalizeResourceDescriptor(resource) {
  if (!resource || typeof resource !== "object" || !RESOURCE_KINDS.has(resource.kind)) {
    throw new Error("Tool capability resource.kind 无效");
  }
  if (resource.kind === "workspace_path" && (typeof resource.argument !== "string" || !resource.argument)) {
    throw new Error("workspace_path capability 必须声明 argument");
  }
  if (resource.kind === "shell_command" && (typeof resource.argument !== "string" || !resource.argument)) {
    throw new Error("shell_command capability 必须声明 argument");
  }
  return {
    kind: resource.kind,
    ...(resource.argument ? { argument: resource.argument } : {}),
    ...(resource.value ? { value: String(resource.value) } : {}),
    ...(resource.default !== undefined ? { default: resource.default } : {}),
    ...(resource.access ? { access: String(resource.access) } : {}),
  };
}

function resolveCapabilityResources(capability, args, state) {
  return capability.resources.map((resource) => {
    if (resource.kind === "workspace_path") {
      const requested = args[resource.argument] ?? resource.default ?? ".";
      if (typeof requested !== "string") throw new Error(`资源参数 ${resource.argument} 必须是字符串`);
      return {
        kind: resource.kind,
        value: resolveWorkspaceResource(state.workspace, requested),
        access: resource.access || (capability.readOnly ? "read" : "write"),
      };
    }
    if (resource.kind === "workspace") return { kind: resource.kind, value: ".", access: resource.access || "execute" };
    if (resource.kind === "shell_command") {
      const command = args[resource.argument || "command"];
      if (typeof command !== "string" || !command.trim()) throw new Error("shell_command capability 必须引用非空命令参数");
      return { kind: resource.kind, value: command.trim(), access: resource.access || "execute" };
    }
    if (resource.kind === "memory_scope") return { kind: resource.kind, value: hashValue(state.memoryScope || {}) };
    if (resource.kind === "session") return { kind: resource.kind, value: state.id };
    return {
      kind: resource.kind,
      value: resource.value || "unknown",
      ...(resource.access ? { access: resource.access } : {}),
    };
  });
}

function resolveWorkspaceResource(workspace, requested) {
  const root = realpathSync(path.resolve(workspace));
  const target = path.resolve(root, requested || ".");
  if (!within(root, target)) throw new WorkspaceBoundaryError("Workspace Policy 拒绝工作区外路径");
  let existing = target;
  while (!existsSync(existing) && existing !== root) existing = path.dirname(existing);
  const realExisting = realpathSync(existing);
  if (!within(root, realExisting)) throw new WorkspaceBoundaryError("Workspace Policy 拒绝越过工作区的符号链接");
  const resolved = path.join(realExisting, path.relative(existing, target));
  if (!within(root, resolved)) throw new WorkspaceBoundaryError("Workspace Policy 拒绝工作区外路径");
  return path.relative(root, resolved) || ".";
}

function within(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function ruleMatches(rule, definition, resources) {
  if (!ruleMatchesDefinition(rule, definition)) return false;
  if (!rule.pathPrefixes) return true;
  const paths = resources.filter((resource) => resource.kind === "workspace_path");
  return paths.length > 0 && paths.every((resource) => (
    rule.pathPrefixes.some((prefix) => pathWithinPrefix(resource.value, prefix))
  ));
}

function ruleMatchesDefinition(rule, definition) {
  if (rule.tools && !rule.tools.includes("*") && !rule.tools.includes(definition.name)) return false;
  if (rule.effects) {
    const matchesEffects = rule.decision === "deny"
      ? rule.effects.every((effect) => definition.capability.effects.includes(effect))
      : definition.capability.effects.every((effect) => rule.effects.includes(effect));
    if (!matchesEffects) return false;
  }
  if (rule.adapters && !rule.adapters.includes(definition.adapter)) return false;
  return true;
}

function grantMatches(grant, context) {
  if (!grant || grant.revokedAt) return false;
  if (grantUsage(grant) === "single_use" && grant.consumedAt) return false;
  if (grantUsage(grant) === "project") {
    if (grant.projectId !== projectIdentity(context.state.workspace)) return false;
  } else if (grant.sessionId !== context.state.id || path.resolve(grant.workspace) !== path.resolve(context.state.workspace)) {
    return false;
  }
  if (grant.tool !== context.definition.name || grant.capabilityHash !== context.capabilityHash) return false;
  if (grant.policyVersion !== context.policyVersion) return false;
  if (grant.callId && grant.callId !== context.callId) return false;
  if (grant.argsHash && grant.argsHash !== context.argsHash) return false;
  if (!Number.isFinite(new Date(grant.expiresAt).getTime()) || new Date(grant.expiresAt).getTime() <= new Date(context.now).getTime()) return false;
  return context.resources.every((resource) => grant.resources.some((scope) => resourceMatches(scope, resource)));
}

function grantUsage(grant) {
  return grant.usage || (grant.scope === "project" ? "project" : grant.callId || grant.argsHash ? "single_use" : "session");
}

function resourceMatches(scope, resource) {
  if (scope.kind !== resource.kind) return false;
  if (scope.valueHash) {
    return scope.valueHash === resourceGrantHash(resource) && (!scope.access || scope.access === resource.access);
  }
  if (scope.match === "prefix" && resource.kind === "workspace_path") {
    return pathWithinPrefix(resource.value, scope.value) && (!scope.access || scope.access === resource.access);
  }
  return scope.value === resource.value && (!scope.access || scope.access === resource.access);
}

function grantResource(resource) {
  const normalized = { ...resource, match: resource.match || "exact" };
  if (resource.kind !== "shell_command") return normalized;
  delete normalized.value;
  return { ...normalized, valueHash: resourceGrantHash(resource) };
}

function resourceGrantHash(resource) {
  return hashValue({ kind: resource.kind, value: resource.value, access: resource.access || null });
}

function pathWithinPrefix(value, prefix) {
  return prefix === "." || value === prefix || value.startsWith(`${prefix}${path.sep}`);
}

function normalizePathPrefix(value) {
  if (typeof value !== "string" || !value) throw new Error("Workspace Policy pathPrefixes 必须是非空字符串");
  const normalized = path.normalize(value).replace(/^\.\//, "");
  if (path.isAbsolute(value) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Workspace Policy pathPrefixes 必须位于工作区内");
  }
  return normalized || ".";
}

function decisionResult({ decision, policyVersion, ruleId, reason, profile = null, explanation = null, capability, capabilityHash, resources, grantId = null, grantScope = null, baseDecision = null, approvalScopes = null }) {
  return {
    decision,
    policyVersion,
    ruleId,
    reason,
    profile,
    explanation,
    capabilityHash,
    effects: capability.effects,
    risk: capability.risk,
    readOnly: capability.readOnly,
    resources,
    grantId,
    grantScope,
    baseDecision,
    ...(approvalScopes ? { approvalScopes } : {}),
  };
}

function decisionRank(decision) {
  return ({ allow: 0, approval_required: 1, deny: 2 })[decision];
}

function riskLevel(effects) {
  if (effects.includes("credential")) return "R3";
  if (effects.some((effect) => ["execute", "network"].includes(effect))) return "R2";
  if (effects.some((effect) => ["write", "memory"].includes(effect))) return "R1";
  return "R0";
}

function stringArray(value, label) {
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === "string" && item)) {
    throw new Error(`Workspace Policy ${label} 必须是非空字符串数组`);
  }
  return [...new Set(value)];
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

class WorkspaceBoundaryError extends Error {}
