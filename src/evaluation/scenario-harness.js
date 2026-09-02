import { createHash } from "node:crypto";
import path from "node:path";
import { AgentRuntime } from "../core/agent.js";
import { AgentSession } from "../core/session.js";
import { createSession, reduceSession } from "../core/state.js";
import { createPermissionProfile } from "../tools/permission-profile.js";
import { WorkspacePolicy } from "../tools/authorization.js";
import { ToolHost } from "../tools/host.js";
import { evaluateSession } from "./session-evaluation.js";
import { ScriptedProvider, ScriptedToolAdapter } from "./scripted-adapters.js";

export const SCENARIO_EVALUATION_VERSION = "scenario-evaluation-v1";

const FIXED_CREATED_AT = "2000-01-01T00:00:00.000Z";
const EXPECTATION_FIELDS = new Set([
  "status",
  "phase",
  "providerCalls",
  "toolCalls",
  "toolSucceeded",
  "toolFailed",
  "executionUnknown",
  "approvals",
]);
const TOOL_EFFECTS = new Set(["read", "write", "execute", "network", "memory", "credential", "state"]);
const TOOL_RISKS = new Set(["R0", "R1", "R2", "R3"]);
const IDEMPOTENCY_MODES = new Set(["safe", "keyed", "unknown"]);
const VOLATILE_FIELDS = new Set([
  "at",
  "createdAt",
  "updatedAt",
  "turnStartedAt",
  "durationMs",
  "modelDurationMs",
  "toolDurationMs",
  "lastTurnDurationMs",
]);

export async function runScenarioEvaluation(input) {
  const scenario = normalizeScenario(input);
  const first = await executeScenario(scenario);
  const second = await executeScenario(scenario);
  const determinismChecks = [
    check("semanticStateHash", first.semanticStateHash, second.semanticStateHash),
    check("semanticEventHash", first.semanticEventHash, second.semanticEventHash),
    check("contextHashes", first.contextHashes, second.contextHashes),
    check("metrics", stableMetrics(first.evaluation.metrics), stableMetrics(second.evaluation.metrics)),
    check("status", first.evaluation.status, second.evaluation.status),
    check("issues", issueCodes(first.evaluation), issueCodes(second.evaluation)),
    check("toolOutcomes", first.toolOutcomes, second.toolOutcomes),
  ];
  const actual = actualValues(first);
  const checks = Object.entries(scenario.expect).map(([field, expected]) => check(field, expected, actual[field]));
  const deterministic = determinismChecks.every((item) => item.match);

  return {
    version: SCENARIO_EVALUATION_VERSION,
    scenario: { id: scenario.id },
    passed: deterministic && checks.every((item) => item.match),
    deterministic,
    replay: {
      semanticStateHash: first.semanticStateHash,
      semanticEventHash: first.semanticEventHash,
      contextHashes: first.contextHashes,
    },
    execution: {
      providerCalls: first.providerCalls,
      toolCalls: first.toolOutcomes,
    },
    evaluation: safeEvaluation(first.evaluation),
    checks,
    determinismChecks,
  };
}

async function executeScenario(scenario) {
  const provider = new ScriptedProvider(scenario.provider);
  const adapter = new ScriptedToolAdapter(scenario.tools);
  const workspace = path.resolve("/nexus-scenario-workspace");
  const profile = createPermissionProfile({ name: "workspace-auto", workspace, executionType: "local" });
  const session = new AgentSession({
    state: createSession({
      id: `scenario-${scenario.id}`,
      provider: provider.name,
      workspace,
      createdAt: FIXED_CREATED_AT,
    }),
    reducer: reduceSession,
  });
  const runtime = new AgentRuntime({
    session,
    provider,
    toolHost: new ToolHost({
      registry: adapter.registry,
      policy: new WorkspacePolicy({}, { profile, allowElevation: false }),
    }),
    systemPrompt: "Nexus deterministic scenario evaluation",
    retrieveMemory: async () => [],
    reconcile: async () => [],
    flushMemory: async () => [],
    summarizeContext: async () => { throw new Error("Scenario Eval 不启用 Context Summary"); },
    maxSteps: scenario.maxSteps,
    maxTokensPerTurn: scenario.maxTokensPerTurn,
    maxInputTokens: scenario.maxInputTokens,
  });

  const turn = runtime.runTurn(
    scenario.prompt,
    async () => ({ approved: scenario.approval === "approve", scope: "once" }),
  );
  if (scenario.cancel) {
    const started = scenario.cancel.after === "provider_started" ? provider.started.promise : adapter.started.promise;
    await waitForStart(started, scenario.cancel.after);
    runtime.cancel(scenario.cancel.reason);
  }
  const state = await turn;
  const evaluation = evaluateSession(state);
  const toolOutcomes = adapter.inspect().calls;
  return {
    semanticStateHash: digest(stripVolatile(state)),
    semanticEventHash: digest(stripVolatile(state.events)),
    contextHashes: state.events
      .filter((event) => ["model.context_prepared", "model.context_compacted"].includes(event.type) && typeof event.contextHash === "string")
      .map((event) => event.contextHash),
    providerCalls: provider.inspect().calls,
    toolOutcomes,
    evaluation,
  };
}

function normalizeScenario(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Scenario 必须是对象");
  const id = boundedString(input.id, "Scenario id", 120);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Scenario id 只能包含字母、数字、下划线和连字符");
  const prompt = boundedString(input.prompt, "Scenario prompt", 100_000);
  if (!Array.isArray(input.provider) || input.provider.length < 1 || input.provider.length > 100) {
    throw new Error("Scenario provider 必须包含 1 到 100 个脚本响应");
  }
  if (!Array.isArray(input.tools) || input.tools.length > 50) throw new Error("Scenario tools 最多包含 50 个工具");
  const tools = input.tools.map(normalizeTool);
  const names = new Set();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Scenario 工具名重复：${tool.name}`);
    names.add(tool.name);
  }
  const callIds = new Set();
  const provider = input.provider.map((response, index) => normalizeProviderResponse(response, index, names, callIds));
  const expect = normalizeExpect(input.expect || {});
  const approval = input.approval || "approve";
  if (!["approve", "deny"].includes(approval)) throw new Error("Scenario approval 必须是 approve 或 deny");
  const cancel = input.cancel ? normalizeCancel(input.cancel) : null;
  validateCancellationScript({ provider, tools, cancel });
  return {
    id,
    prompt,
    provider,
    tools,
    expect,
    approval,
    cancel,
    maxSteps: positiveInteger(input.maxSteps, "maxSteps", 100, Math.min(100, Math.max(2, provider.length + 1))),
    maxTokensPerTurn: positiveInteger(input.maxTokensPerTurn, "maxTokensPerTurn", 10_000_000, 1_000_000),
    maxInputTokens: positiveInteger(input.maxInputTokens, "maxInputTokens", 1_000_000, 32_000),
  };
}

function normalizeProviderResponse(response, index, toolNames, callIds) {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error(`Provider 响应 ${index + 1} 必须是对象`);
  const type = response.type || "response";
  if (!["response", "error", "wait_for_cancel"].includes(type)) throw new Error(`Provider 响应 ${index + 1} type 无效`);
  if (type === "error") return { type, error: boundedString(response.error, "Provider error", 10_000) };
  if (type === "wait_for_cancel") return { type };
  const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls.map((call, callIndex) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error(`Provider tool call ${index + 1}.${callIndex + 1} 无效`);
    const id = boundedString(call.id, "Tool call id", 160);
    const name = boundedString(call.name, "Tool call name", 120);
    if (callIds.has(id)) throw new Error(`Tool call id 重复：${id}`);
    if (!toolNames.has(name)) throw new Error(`Tool call 引用了未配置工具：${name}`);
    callIds.add(id);
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new Error(`Tool call ${id} arguments 必须是对象`);
    if (JSON.stringify(call.arguments).length > 1_000_000) throw new Error(`Tool call ${id} arguments 过大`);
    return { id, name, arguments: structuredClone(call.arguments) };
  }) : [];
  return {
    type,
    text: typeof response.text === "string" ? response.text.slice(0, 1_000_000) : "",
    toolCalls,
    finishReason: typeof response.finishReason === "string" ? response.finishReason.slice(0, 120) : null,
    usage: normalizeUsage(response.usage),
  };
}

function normalizeTool(tool, index) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error(`Scenario 工具 ${index + 1} 必须是对象`);
  const name = boundedString(tool.name, "Scenario tool name", 120);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Scenario 工具名无效：${name}`);
  const effects = Array.isArray(tool.effects) && tool.effects.length ? [...new Set(tool.effects)] : ["read"];
  if (effects.some((effect) => !TOOL_EFFECTS.has(effect))) throw new Error(`Scenario 工具 ${name} effects 无效`);
  const readOnly = tool.readOnly ?? !effects.some((effect) => ["write", "execute", "network", "credential"].includes(effect));
  if (readOnly && effects.some((effect) => ["write", "execute", "credential"].includes(effect))) {
    throw new Error(`Scenario 工具 ${name} 的只读 capability 不能声明写入、执行或凭据副作用`);
  }
  const risk = tool.risk || (readOnly ? "R0" : "R1");
  if (!TOOL_RISKS.has(risk)) throw new Error(`Scenario 工具 ${name} risk 无效`);
  const idempotency = tool.idempotency || (readOnly ? "safe" : "unknown");
  if (!IDEMPOTENCY_MODES.has(idempotency)) throw new Error(`Scenario 工具 ${name} idempotency 无效`);
  const parameters = tool.parameters || { type: "object", additionalProperties: true };
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || JSON.stringify(parameters).length > 100_000) {
    throw new Error(`Scenario 工具 ${name} parameters 无效或过大`);
  }
  const outcomes = (Array.isArray(tool.outcomes) ? tool.outcomes : [tool.outcome || { type: "success", result: "ok" }])
    .map((outcome, outcomeIndex) => normalizeToolOutcome(outcome, name, outcomeIndex));
  if (!outcomes.length || outcomes.length > 100) throw new Error(`Scenario 工具 ${name} outcomes 必须包含 1 到 100 项`);
  return {
    name,
    description: typeof tool.description === "string" ? tool.description.slice(0, 1_000) : `Scripted evaluation tool ${name}`,
    effects,
    readOnly: Boolean(readOnly),
    risk,
    idempotency,
    parameters,
    outcomes,
  };
}

function normalizeToolOutcome(outcome, name, index) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) throw new Error(`工具 ${name} outcome ${index + 1} 无效`);
  const type = outcome.type || "success";
  if (!["success", "failure", "wait_for_cancel"].includes(type)) throw new Error(`工具 ${name} outcome type 无效`);
  if (type === "failure") return { type, error: boundedString(outcome.error, `工具 ${name} error`, 10_000) };
  if (type === "wait_for_cancel") return { type };
  const result = outcome.result === undefined ? "ok" : String(outcome.result);
  if (result.length > 1_000_000) throw new Error(`工具 ${name} result 过大`);
  return { type, result };
}

function normalizeExpect(expect) {
  if (!expect || typeof expect !== "object" || Array.isArray(expect)) throw new Error("Scenario expect 必须是对象");
  const normalized = {};
  for (const [field, value] of Object.entries(expect)) {
    if (!EXPECTATION_FIELDS.has(field)) throw new Error(`Scenario expect 不支持字段：${field}`);
    if (typeof value !== "string" && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Scenario expect.${field} 无效`);
    normalized[field] = value;
  }
  return normalized;
}

function normalizeCancel(cancel) {
  if (!cancel || typeof cancel !== "object" || Array.isArray(cancel)) throw new Error("Scenario cancel 必须是对象");
  const after = cancel.after || "tool_started";
  if (!["provider_started", "tool_started"].includes(after)) throw new Error("Scenario cancel.after 无效");
  return { after, reason: typeof cancel.reason === "string" && cancel.reason ? cancel.reason.slice(0, 1_000) : "Scenario 取消" };
}

function validateCancellationScript({ provider, tools, cancel }) {
  const waitingProvider = provider.some((response) => response.type === "wait_for_cancel");
  const waitingTools = tools.filter((tool) => tool.outcomes.some((outcome) => outcome.type === "wait_for_cancel"));
  if (!cancel && (waitingProvider || waitingTools.length)) {
    throw new Error("Scenario 包含 wait_for_cancel 时必须配置 cancel");
  }
  if (!cancel) return;
  if (cancel.after === "provider_started" && provider[0]?.type !== "wait_for_cancel") {
    throw new Error("provider_started 取消要求首个 Provider 响应为 wait_for_cancel");
  }
  if (cancel.after === "tool_started") {
    const firstCall = provider.flatMap((response) => response.toolCalls || [])[0];
    const firstTool = firstCall ? tools.find((tool) => tool.name === firstCall.name) : null;
    if (firstTool?.outcomes[0]?.type !== "wait_for_cancel") {
      throw new Error("tool_started 取消要求首个工具 outcome 为 wait_for_cancel");
    }
    if (firstTool.risk === "R3" || firstTool.effects.includes("credential")) {
      throw new Error("tool_started 取消不能等待会被 Permission Profile 硬拒绝的工具");
    }
  }
}

function actualValues(run) {
  return {
    status: run.evaluation.status,
    phase: run.evaluation.phase,
    providerCalls: run.providerCalls,
    toolCalls: run.evaluation.tools.requested,
    toolSucceeded: run.evaluation.tools.succeeded,
    toolFailed: run.evaluation.tools.failed,
    executionUnknown: run.evaluation.tools.executionUnknown,
    approvals: run.evaluation.approvals.requested,
  };
}

function safeEvaluation(evaluation) {
  return { ...structuredClone(evaluation), metrics: stableMetrics(evaluation.metrics) };
}

function stableMetrics(metrics) {
  const { modelDurationMs: _model, toolDurationMs: _tool, lastTurnDurationMs: _turn, ...stable } = metrics;
  return stable;
}

function issueCodes(evaluation) {
  return evaluation.issues.map((issue) => issue.code);
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
    VOLATILE_FIELDS.has(key) || key.endsWith("At") ? [] : [[key, stripVolatile(value[key])]]
  )));
}

function check(field, expected, actual) {
  return { field, match: canonical(expected) === canonical(actual), expected, actual };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function normalizeUsage(value = {}) {
  const inputTokens = nonNegativeInteger(value.inputTokens ?? value.prompt_tokens, "usage.inputTokens", 0);
  const outputTokens = nonNegativeInteger(value.outputTokens ?? value.completion_tokens, "usage.outputTokens", 0);
  const totalTokens = nonNegativeInteger(value.totalTokens ?? value.total_tokens, "usage.totalTokens", inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}

function positiveInteger(value, label, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Scenario ${label} 必须是 1 到 ${maximum} 的整数`);
  return value;
}

function nonNegativeInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Scenario ${label} 必须是非负整数`);
  return value;
}

function boundedString(value, label, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`${label} 必须是 1 到 ${maximum} 个字符`);
  return value;
}

async function waitForStart(promise, label) {
  let timeout;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), 5_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
