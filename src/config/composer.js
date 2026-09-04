// FOUNDATION — one normalized, inspectable configuration for every Nexus entrypoint.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DemoProvider } from "../providers/demo.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { OpenAIResponsesProvider } from "../providers/openai-responses.js";
import {
  formatMaxSteps,
  formatMaxTokensPerTurn,
  parseContextWindowTokens,
  parseMaxSteps,
  parseMaxTokensPerTurn,
} from "../runtime-options.js";
import { normalizeDockerImage } from "../execution/docker-options.js";
import { normalizeNetworkTargets } from "../execution/network-target.js";
import {
  inspectNamedAgentProfiles,
  normalizeNamedAgentProfiles,
} from "../core/named-agent-profiles.js";

const PROFILE_FILE = "nexus.config.json";
const LOCAL_FILE = path.join(".nexus", "config.local.json");
const PROVIDER_TYPES = new Set(["auto", "demo", "openai-compatible", "openai-responses"]);
const PROVIDER_THINKING_MODES = new Set(["provider-default", "enabled", "disabled"]);
const EXECUTION_TYPES = new Set(["native", "local", "docker"]);
const SAFE_PERMISSION_PROFILES = new Set(["read-only", "approval-required", "workspace-confirm", "workspace-untrusted", "workspace-auto"]);

export async function composeRuntimeConfig({
  args = [],
  env = process.env,
  root = process.cwd(),
  localEnvironment = { file: null, appliedKeys: [] },
  useProjectsDefault = false,
} = {}) {
  const projectsRootArg = valueArg(args, "projects-root");
  const projectsRoot = path.resolve(projectsRootArg || env.NEXUS_PROJECTS_ROOT || path.join(os.homedir(), "Nexus Projects"));
  const projectsRootSource = projectsRootArg
    ? "cli"
    : env.NEXUS_PROJECTS_ROOT
      ? environmentSource("NEXUS_PROJECTS_ROOT", localEnvironment)
      : "default";
  const workspaceArg = valueArg(args, "workspace");
  const workspace = path.resolve(
    workspaceArg
      || env.NEXUS_WORKSPACE
      || (useProjectsDefault ? path.join(projectsRoot, "Default") : root),
  );
  const workspaceSource = workspaceArg ? "cli" : env.NEXUS_WORKSPACE ? environmentSource("NEXUS_WORKSPACE", localEnvironment) : "default";
  const profileFile = path.join(workspace, PROFILE_FILE);
  const localConfigArg = valueArg(args, "local-config");
  const localFile = path.resolve(localConfigArg || env.NEXUS_LOCAL_CONFIG || path.join(path.resolve(root), LOCAL_FILE));
  const profile = await readConfigFile(profileFile, {
    label: "workspace profile",
    allowApiKey: false,
    allowProviderEndpoint: false,
  });
  const local = await readConfigFile(localFile, {
    label: "local private config",
    allowApiKey: true,
    allowProviderEndpoint: true,
  });
  const values = {
    "provider.type": "auto",
    "provider.apiKey": null,
    "provider.baseUrl": "https://api.openai.com/v1",
    "provider.model": "gpt-4.1-mini",
    "provider.thinking": "provider-default",
    "provider.contextWindowTokens": 32_000,
    "runtime.maxSteps": Infinity,
    "runtime.maxTokensPerTurn": Infinity,
    "execution.type": "native",
    "execution.dockerImage": null,
    "permission.profile": "workspace-auto",
    "agents.default": "default",
    "network.targets": [],
    "mcp.file": null,
    "gateway.port": 4317,
  };
  const sources = Object.fromEntries(Object.keys(values).map((key) => [key, "default"]));

  applyLayer(values, sources, profile?.values, "workspace_profile");
  applyLayer(values, sources, local?.values, "local_private");
  applyEnvironment(values, sources, env, localEnvironment);
  applyCli(values, sources, args);
  validateValues(values);

  if (values["provider.type"] === "auto") {
    values["provider.type"] = values["provider.apiKey"] ? "openai-compatible" : "demo";
    sources["provider.type"] = `derived:${sources["provider.apiKey"]}`;
  }
  validateProviderFeatures(values);

  const agents = normalizeNamedAgentProfiles(
    args.includes("--demo") ? withoutProviderOverrides(local?.agentProfiles) : local?.agentProfiles,
    {
      defaultId: values["agents.default"],
      defaultPermissionProfile: values["permission.profile"],
      maxSteps: values["runtime.maxSteps"],
      maxTokensPerTurn: values["runtime.maxTokensPerTurn"],
      defaultProvider: {
        type: values["provider.type"],
        apiKey: values["provider.apiKey"],
        baseUrl: values["provider.baseUrl"],
        model: values["provider.model"],
        thinking: values["provider.thinking"],
        contextWindowTokens: values["provider.contextWindowTokens"],
      },
    },
  );

  return {
    workspace,
    projects: {
      root: projectsRoot,
      defaultWorkspace: workspace,
    },
    provider: {
      type: values["provider.type"],
      apiKey: values["provider.apiKey"],
      baseUrl: values["provider.baseUrl"],
      model: values["provider.model"],
      thinking: values["provider.thinking"],
      contextWindowTokens: values["provider.contextWindowTokens"],
    },
    runtime: {
      maxSteps: values["runtime.maxSteps"],
      maxTokensPerTurn: values["runtime.maxTokensPerTurn"],
      maxInputTokens: values["provider.contextWindowTokens"],
    },
    execution: {
      type: values["execution.type"],
      dockerImage: values["execution.dockerImage"],
    },
    permission: { profile: values["permission.profile"] },
    agents,
    network: { targets: values["network.targets"] },
    mcp: { file: values["mcp.file"] },
    gateway: { port: values["gateway.port"] },
    printConfig: args.includes("--print-config"),
    sources: { workspace: workspaceSource, projectsRoot: projectsRootSource, ...sources },
    files: {
      profile: profile?.file || null,
      local: local?.file || null,
      localEnvironment: localEnvironment.file || null,
    },
  };
}

export function createConfiguredProvider(config) {
  return createProvider(config.provider);
}

export function createConfiguredAgentProviders(config) {
  return new Map(config.agents.profiles.map((profile) => [profile.id, {
    provider: createProvider(profile.provider),
    descriptor: providerDescriptor(profile.provider),
  }]));
}

function createProvider(provider) {
  if (provider.type === "demo") return new DemoProvider();
  if (provider.type === "openai-responses") {
    return new OpenAIResponsesProvider({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
    });
  }
  return new OpenAICompatibleProvider({
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: provider.model,
    thinking: provider.thinking,
  });
}

function providerDescriptor(provider) {
  if (provider.type === "demo") {
    return {
      name: "offline-demo",
      adapter: "demo",
      model: "offline-demo",
      baseUrl: null,
      contextWindowTokens: provider.contextWindowTokens,
    };
  }
  return {
    name: `${provider.type}/${provider.model}`,
    adapter: provider.type,
    model: provider.model,
    baseUrl: provider.baseUrl,
    thinking: provider.thinking,
    contextWindowTokens: provider.contextWindowTokens,
  };
}

export function inspectRuntimeConfig(config) {
  return {
    workspace: config.workspace,
    projects: { ...config.projects },
    provider: {
      type: config.provider.type,
      apiKey: config.provider.apiKey ? "[REDACTED]" : null,
      baseUrl: config.provider.baseUrl,
      model: config.provider.model,
      thinking: config.provider.thinking,
      contextWindowTokens: config.provider.contextWindowTokens,
    },
    runtime: {
      maxSteps: formatMaxSteps(config.runtime.maxSteps),
      maxTokensPerTurn: formatMaxTokensPerTurn(config.runtime.maxTokensPerTurn),
      maxInputTokens: config.runtime.maxInputTokens,
    },
    execution: { ...config.execution },
    permission: { ...config.permission },
    agents: inspectNamedAgentProfiles(config.agents),
    network: { targets: [...config.network.targets] },
    mcp: { file: config.mcp.file },
    gateway: { port: config.gateway.port },
    sources: config.sources,
    files: config.files,
  };
}

async function readConfigFile(file, { label, allowApiKey, allowProviderEndpoint }) {
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`无法读取 ${label} ${file}：${error.message}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`${label} 必须是 JSON 对象`);
  assertKnownKeys(payload, new Set(["provider", "runtime", "mcp", "gateway", ...(allowApiKey ? ["agents"] : [])]), label);
  const values = {};
  if (payload.provider !== undefined) {
    assertObject(payload.provider, `${label}.provider`);
    assertKnownKeys(payload.provider, new Set(["type", "apiKey", "baseUrl", "model", "thinking", "contextWindowTokens"]), `${label}.provider`);
    if (payload.provider.apiKey !== undefined && !allowApiKey) {
      throw new Error(`${label} 不允许保存 provider.apiKey；请使用 .env.local 或 Nexus 应用目录的 .nexus/config.local.json`);
    }
    if (!allowProviderEndpoint && (payload.provider.type !== undefined || payload.provider.baseUrl !== undefined)) {
      throw new Error(`${label} 不允许选择 provider.type/baseUrl；请使用受信任的环境、CLI 或 Nexus 应用级私有配置`);
    }
    copyDefined(values, "provider.type", payload.provider.type);
    copyDefined(values, "provider.apiKey", payload.provider.apiKey);
    copyDefined(values, "provider.baseUrl", payload.provider.baseUrl);
    copyDefined(values, "provider.model", payload.provider.model);
    copyDefined(values, "provider.thinking", payload.provider.thinking);
    copyDefined(values, "provider.contextWindowTokens", payload.provider.contextWindowTokens);
  }
  if (payload.runtime !== undefined) {
    assertObject(payload.runtime, `${label}.runtime`);
    assertKnownKeys(payload.runtime, new Set(["maxSteps", "maxTokensPerTurn"]), `${label}.runtime`);
    copyDefined(values, "runtime.maxSteps", payload.runtime.maxSteps);
    copyDefined(values, "runtime.maxTokensPerTurn", payload.runtime.maxTokensPerTurn);
  }
  if (payload.mcp !== undefined) {
    assertObject(payload.mcp, `${label}.mcp`);
    assertKnownKeys(payload.mcp, new Set(["file"]), `${label}.mcp`);
    if (payload.mcp.file !== undefined && payload.mcp.file !== null) {
      throw new Error(`${label} 不允许启用 MCP；请使用 NEXUS_MCP_CONFIG 或显式 --mcp`);
    }
    copyDefined(values, "mcp.file", payload.mcp.file);
  }
  if (payload.gateway !== undefined) {
    assertObject(payload.gateway, `${label}.gateway`);
    assertKnownKeys(payload.gateway, new Set(["port"]), `${label}.gateway`);
    copyDefined(values, "gateway.port", payload.gateway.port);
  }
  let agentProfiles;
  if (payload.agents !== undefined) {
    assertObject(payload.agents, `${label}.agents`);
    assertKnownKeys(payload.agents, new Set(["default", "profiles"]), `${label}.agents`);
    copyDefined(values, "agents.default", payload.agents.default);
    agentProfiles = payload.agents.profiles;
  }
  return { file, values, agentProfiles };
}

function applyEnvironment(values, sources, env, localEnvironment) {
  const mappings = {
    NEXUS_PROVIDER: "provider.type",
    OPENAI_API_KEY: "provider.apiKey",
    OPENAI_BASE_URL: "provider.baseUrl",
    OPENAI_MODEL: "provider.model",
    NEXUS_PROVIDER_THINKING: "provider.thinking",
    NEXUS_CONTEXT_WINDOW_TOKENS: "provider.contextWindowTokens",
    NEXUS_MAX_STEPS: "runtime.maxSteps",
    NEXUS_MAX_TOKENS_PER_TURN: "runtime.maxTokensPerTurn",
    NEXUS_EXECUTION: "execution.type",
    NEXUS_DOCKER_IMAGE: "execution.dockerImage",
    NEXUS_PERMISSION_PROFILE: "permission.profile",
    NEXUS_AGENT_PROFILE: "agents.default",
    NEXUS_NETWORK_TARGETS: "network.targets",
    NEXUS_MCP_CONFIG: "mcp.file",
    NEXUS_GATEWAY_PORT: "gateway.port",
  };
  for (const [environmentKey, configKey] of Object.entries(mappings)) {
    if (env[environmentKey] === undefined || env[environmentKey] === "") continue;
    values[configKey] = env[environmentKey];
    sources[configKey] = environmentSource(environmentKey, localEnvironment);
  }
  if (typeof values["network.targets"] === "string") {
    values["network.targets"] = values["network.targets"].split(",").map((value) => value.trim()).filter(Boolean);
  }
}

function applyCli(values, sources, args) {
  if (args.includes("--demo") && valueArg(args, "provider")) throw new Error("--demo 不能与 --provider 同时使用");
  if (args.includes("--demo") && valueArg(args, "provider-thinking")) {
    throw new Error("--demo 不能与 --provider-thinking 同时使用");
  }
  const mappings = {
    provider: "provider.type",
    model: "provider.model",
    "provider-thinking": "provider.thinking",
    "context-window-tokens": "provider.contextWindowTokens",
    "base-url": "provider.baseUrl",
    "max-steps": "runtime.maxSteps",
    "max-tokens-per-turn": "runtime.maxTokensPerTurn",
    execution: "execution.type",
    "docker-image": "execution.dockerImage",
    "permission-profile": "permission.profile",
    "agent-profile": "agents.default",
    mcp: "mcp.file",
    port: "gateway.port",
  };
  for (const [argument, configKey] of Object.entries(mappings)) {
    const value = valueArg(args, argument);
    if (value === undefined) continue;
    values[configKey] = value;
    sources[configKey] = "cli";
  }
  const networkTargets = args.filter((value) => value.startsWith("--network-target=")).map((value) => value.slice("--network-target=".length));
  if (networkTargets.length) {
    values["network.targets"] = networkTargets;
    sources["network.targets"] = "cli";
  }
  if (args.includes("--demo")) {
    values["provider.type"] = "demo";
    sources["provider.type"] = "cli";
    values["provider.thinking"] = "provider-default";
    sources["provider.thinking"] = "cli";
  }
}

function withoutProviderOverrides(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return profiles;
  return Object.fromEntries(Object.entries(profiles).map(([id, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [id, value];
    const { provider: _provider, ...profile } = value;
    return [id, profile];
  }));
}

function validateValues(values) {
  if (!PROVIDER_TYPES.has(values["provider.type"])) {
    throw new Error("provider.type 必须是 auto、demo、openai-compatible 或 openai-responses");
  }
  for (const key of ["provider.baseUrl", "provider.model"]) {
    if (typeof values[key] !== "string" || !values[key].trim()) throw new Error(`${key} 必须是非空字符串`);
    values[key] = values[key].trim();
  }
  if (values["provider.apiKey"] !== null && typeof values["provider.apiKey"] !== "string") {
    throw new Error("provider.apiKey 必须是字符串");
  }
  if (!PROVIDER_THINKING_MODES.has(values["provider.thinking"])) {
    throw new Error("provider.thinking 必须是 provider-default、enabled 或 disabled");
  }
  values["provider.contextWindowTokens"] = parseContextWindowTokens(values["provider.contextWindowTokens"]);
  values["runtime.maxSteps"] = parseMaxSteps(values["runtime.maxSteps"]);
  values["runtime.maxTokensPerTurn"] = parseMaxTokensPerTurn(values["runtime.maxTokensPerTurn"]);
  if (!EXECUTION_TYPES.has(values["execution.type"])) throw new Error("execution.type 必须是 native、local 或 docker");
  if (values["execution.type"] === "docker") {
    if (values["execution.dockerImage"] === null) throw new Error("Docker 执行需要显式配置 execution.dockerImage");
    values["execution.dockerImage"] = normalizeDockerImage(values["execution.dockerImage"]);
  } else if (values["execution.dockerImage"] !== null) {
    throw new Error("execution.dockerImage 只能与 execution.type=docker 一起使用");
  }
  if (!SAFE_PERMISSION_PROFILES.has(values["permission.profile"])) {
    throw new Error("permission.profile 必须是安全档位 read-only、workspace-confirm、workspace-auto、workspace-untrusted 或兼容档位 approval-required");
  }
  values["network.targets"] = normalizeNetworkTargets(values["network.targets"]);
  if (values["network.targets"].length && values["execution.type"] !== "native") {
    throw new Error("network.targets 首版只支持 execution.type=native");
  }
  if (values["mcp.file"] !== null && (typeof values["mcp.file"] !== "string" || !values["mcp.file"].trim())) {
    throw new Error("mcp.file 必须是非空字符串或 null");
  }
  if (typeof values["mcp.file"] === "string") values["mcp.file"] = values["mcp.file"].trim();
  const port = typeof values["gateway.port"] === "number" ? values["gateway.port"] : Number(values["gateway.port"]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("gateway.port 必须是 0 到 65535 的整数");
  values["gateway.port"] = port;
}

function validateProviderFeatures(values) {
  if (values["provider.thinking"] !== "provider-default" && values["provider.type"] !== "openai-compatible") {
    throw new Error("provider.thinking 的 enabled/disabled 首版只支持 openai-compatible Adapter");
  }
}

function applyLayer(values, sources, layer, source) {
  for (const [key, value] of Object.entries(layer || {})) {
    values[key] = value;
    sources[key] = source;
  }
}

function environmentSource(key, localEnvironment) {
  return localEnvironment.appliedKeys?.includes(key) ? "local_environment" : "environment";
}

function valueArg(args, name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function copyDefined(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} 包含未知字段 ${unknown}`);
}
