import { createHash } from "node:crypto";
import { redactSensitiveText } from "../security/redact.js";
import {
  consumeSessionGrant,
  createSessionGrant,
  issueSessionGrant,
  normalizeCapability,
  WorkspacePolicy,
} from "./authorization.js";

const APPROVAL_MODES = new Set(["never", "always"]);
const IDEMPOTENCY_MODES = new Set(["safe", "keyed", "unknown"]);
const EFFECTS = new Set(["read", "write", "execute", "network", "memory", "credential"]);

export class ToolHost {
  constructor({ registry, policy = new WorkspacePolicy(), defaultTimeoutMs = 30_000, maxResultChars = 12_000 }) {
    if (!registry || typeof registry.get !== "function" || typeof registry.schemas !== "function") {
      throw new Error("Tool Host 需要 Tool Registry");
    }
    if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs < 1) {
      throw new Error("Tool Host defaultTimeoutMs 必须是正整数");
    }
    this.registry = registry;
    this.policy = policy;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxResultChars = maxResultChars;
  }

  schemas() {
    return this.registry.schemas().filter((schema) => {
      const name = schema.function?.name;
      const tool = name ? this.registry.get(name) : null;
      if (!tool) return false;
      return this.policy.canExpose(normalizeDefinition(tool, this.defaultTimeoutMs));
    });
  }

  async execute(call, { session, signal, requestApproval } = {}) {
    validateCall(call);
    if (!session || typeof session.dispatch !== "function") throw new Error("Tool Host 需要 Agent Session");
    const tool = this.registry.get(call.name);
    const argsHash = hashValue(call.arguments);
    const definition = tool ? normalizeDefinition(tool, this.defaultTimeoutMs) : null;
    await session.dispatch({
      type: "TOOL_REQUESTED",
      call,
      argsHash,
      effects: definition?.effects || [],
      idempotency: definition?.idempotency || "unknown",
      adapter: definition?.adapter || "unknown",
    });
    const sourceCursor = session.cursor;

    if (!definition) {
      return await complete(session, call, {
        ok: false,
        status: "not_found",
        result: `未知工具：${call.name}`,
        durationMs: 0,
      });
    }

    const validationError = validateArguments(definition.parameters, call.arguments);
    if (validationError) {
      await session.dispatch({
        type: "TOOL_VALIDATION_FAILED",
        call,
        argsHash,
        error: validationError,
      });
      return await complete(session, call, {
        ok: false,
        status: "validation_failed",
        result: `工具参数无效：${validationError}`,
        durationMs: 0,
      });
    }

    const toolVersion = definitionVersion(definition);
    const authorization = this.policy.authorize({
      definition,
      call,
      state: session.state,
      argsHash,
    });
    await session.dispatch({
      type: "TOOL_AUTHORIZATION_DECIDED",
      call,
      argsHash,
      toolVersion,
      effects: definition.effects,
      idempotency: definition.idempotency,
      adapter: definition.adapter,
      ...authorization,
    });

    if (authorization.decision === "deny") {
      return await complete(session, call, {
        ok: false,
        status: "policy_denied",
        result: `Workspace Policy 拒绝工具调用：${authorization.reason}`,
        durationMs: 0,
      });
    }

    if (signal?.aborted) await cancelledBeforeStart(session, call, signal);

    let executionGrantId = authorization.grantId;
    if (authorization.decision === "approval_required") {
      if (typeof requestApproval !== "function") throw new Error(`工具 ${call.name} 需要 Approval callback`);
      await session.dispatch({
        type: "APPROVAL_REQUESTED",
        call,
        argsHash,
        toolVersion,
        risk: authorization.risk,
        policyVersion: authorization.policyVersion,
        capabilityHash: authorization.capabilityHash,
        resources: authorization.resources,
        ruleId: authorization.ruleId,
      });
      const approved = await requestApproval(call, definition.description, signal);
      if (signal?.aborted) await cancelledBeforeStart(session, call, signal);
      const currentTool = this.registry.get(call.name);
      const currentDefinition = currentTool ? normalizeDefinition(currentTool, this.defaultTimeoutMs) : null;
      const currentArgsHash = hashValue(call.arguments);
      const currentAuthorization = currentDefinition ? this.policy.authorize({
        definition: currentDefinition,
        call,
        state: session.state,
        argsHash: currentArgsHash,
      }) : null;
      const stale = !currentDefinition
        || currentArgsHash !== argsHash
        || definitionVersion(currentDefinition) !== toolVersion
        || currentAuthorization.policyVersion !== authorization.policyVersion
        || currentAuthorization.capabilityHash !== authorization.capabilityHash
        || hashValue(currentAuthorization.resources) !== hashValue(authorization.resources);
      await session.dispatch({
        type: "APPROVAL_DECIDED",
        call,
        approved,
        argsHash,
        toolVersion,
        policyVersion: authorization.policyVersion,
        capabilityHash: authorization.capabilityHash,
      });
      if (!approved) {
        return await complete(session, call, {
          ok: false,
          status: "denied",
          result: "用户拒绝了本次工具调用。",
          durationMs: 0,
        });
      }
      if (stale) {
        await session.dispatch({
          type: "TOOL_APPROVAL_STALE",
          call,
          argsHash,
          currentArgsHash,
          toolVersion,
          policyVersion: authorization.policyVersion,
          currentPolicyVersion: currentAuthorization?.policyVersion || null,
        });
        return await complete(session, call, {
          ok: false,
          status: "approval_stale",
          result: "工具参数或定义在审批后发生变化，本次 Approval 已失效。",
          durationMs: 0,
        });
      }
      const issuedAt = new Date().toISOString();
      const grant = createSessionGrant({
        sessionId: session.id,
        workspace: session.state.workspace,
        tool: call.name,
        capabilityHash: authorization.capabilityHash,
        policyVersion: authorization.policyVersion,
        resources: authorization.resources,
        callId: call.id,
        argsHash,
        issuedAt,
        expiresAt: new Date(new Date(issuedAt).getTime() + 5 * 60_000).toISOString(),
      });
      await issueSessionGrant(session, grant);
      executionGrantId = grant.id;
    }

    if (signal?.aborted) await cancelledBeforeStart(session, call, signal);
    if (executionGrantId) await consumeSessionGrant(session, executionGrantId, call.id);
    if (signal?.aborted) await cancelledBeforeStart(session, call, signal);
    const timeoutSignal = AbortSignal.timeout(definition.timeoutMs);
    const executionSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    await session.dispatch({
      type: "TOOL_EXECUTION_STARTED",
      call,
      argsHash,
      toolVersion,
      effects: definition.effects,
      idempotency: definition.idempotency,
      adapter: definition.adapter,
      policyVersion: authorization.policyVersion,
      capabilityHash: authorization.capabilityHash,
      grantId: executionGrantId,
    });
    const started = performance.now();
    let implementationStarted = false;
    try {
      const value = await raceWithSignal(() => {
        implementationStarted = true;
        return definition.execute(call.arguments, {
          state: session.state,
          dispatch: (action) => session.dispatch(action),
          signal: executionSignal,
          sourceCursor,
          callId: call.id,
        });
      }, executionSignal);
      return await complete(session, call, {
        ok: true,
        status: "completed",
        result: normalizeResult(value, this.maxResultChars),
        durationMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      if (signal?.aborted) {
        if (!implementationStarted) await cancelledBeforeStart(session, call, signal, durationMs);
        if (outcomeMayBeUnknown(definition)) {
          await executionUnknown(session, call, definition, argsHash, "cancelled");
        }
        throw error;
      }
      if (timeoutSignal.aborted) {
        if (!implementationStarted) {
          return await complete(session, call, {
            ok: false,
            status: "timeout",
            result: `工具执行超时（${definition.timeoutMs}ms），实现尚未启动。`,
            durationMs,
          });
        }
        const unknown = outcomeMayBeUnknown(definition);
        if (unknown) await executionUnknown(session, call, definition, argsHash, "timeout");
        return await complete(session, call, {
          ok: false,
          status: unknown ? "execution_unknown" : "timeout",
          result: unknown
            ? `工具执行超时（${definition.timeoutMs}ms），副作用结果未知，不会自动重试。`
            : `工具执行超时（${definition.timeoutMs}ms），已停止等待。`,
          durationMs,
        });
      }
      return await complete(session, call, {
        ok: false,
        status: "external_failed",
        result: `工具执行失败：${redactSensitiveText(error?.message || "未知错误")}`,
        durationMs,
      });
    }
  }
}

async function cancelledBeforeStart(session, call, signal, durationMs = 0) {
  await complete(session, call, {
    ok: false,
    status: "cancelled",
    result: "任务已取消：工具尚未启动。",
    durationMs,
  });
  throw signal?.reason || new Error("任务已取消");
}

async function executionUnknown(session, call, definition, argsHash, reason) {
  await session.dispatch({
    type: "TOOL_EXECUTION_UNKNOWN",
    call,
    argsHash,
    effects: definition.effects,
    idempotency: definition.idempotency,
    adapter: definition.adapter,
    reason,
  });
}

async function complete(session, call, result) {
  const safeResult = redactSensitiveText(result.result);
  await session.dispatch({
    type: "TOOL_RESULT",
    call,
    ok: result.ok,
    status: result.status,
    result: safeResult,
    durationMs: result.durationMs,
  });
  return { ...result, result: safeResult };
}

function normalizeDefinition(tool, defaultTimeoutMs) {
  if (typeof tool.execute !== "function") throw new Error(`工具 ${tool.name} 缺少 execute implementation`);
  const approval = tool.approval || "always";
  if (!APPROVAL_MODES.has(approval)) throw new Error(`工具 ${tool.name} approval 无效`);
  if (!Array.isArray(tool.effects) || !tool.effects.length) throw new Error(`工具 ${tool.name} 必须声明 effects`);
  const effects = [...new Set(tool.effects)];
  if (effects.some((effect) => !EFFECTS.has(effect))) throw new Error(`工具 ${tool.name} effects 无效`);
  const idempotency = tool.idempotency || "unknown";
  if (!IDEMPOTENCY_MODES.has(idempotency)) throw new Error(`工具 ${tool.name} idempotency 无效`);
  const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error(`工具 ${tool.name} timeoutMs 无效`);
  const definition = {
    ...tool,
    adapter: tool.adapter || "native",
    parameters: tool.parameters || { type: "object" },
    approval,
    effects,
    idempotency,
    timeoutMs,
  };
  definition.capability = normalizeCapability(definition);
  return definition;
}

function definitionVersion(definition) {
  return hashValue({
    name: definition.name,
    parameters: definition.parameters,
    effects: definition.effects,
    idempotency: definition.idempotency,
    adapter: definition.adapter,
    timeoutMs: definition.timeoutMs,
    capability: definition.capability,
  });
}

function validateCall(call) {
  if (!call || typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name) {
    throw new Error("Tool Call 必须包含 id 和 name");
  }
  if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
    throw new Error("Tool Call arguments 必须是对象");
  }
}

function validateArguments(schema, value, path = "arguments") {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    return `${path} 不在允许值中`;
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((item) => !validateArguments(item, value, path))) return `${path} 不匹配任何允许结构`;
    return null;
  }
  const type = schema.type;
  if (type && !matchesType(value, type)) return `${path} 必须是 ${typeLabel(type)}`;
  if (type === "object" || schema.properties || schema.required) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} 必须是对象`;
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) return `${path} 缺少必填字段 ${key}`;
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(schema.properties || {}, key));
      if (unknown) return `${path} 包含未知字段 ${unknown}`;
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateArguments(child, value[key], `${path}.${key}`);
      if (error) return error;
    }
  }
  if (type === "array" && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateArguments(schema.items, value[index], `${path}[${index}]`);
      if (error) return error;
    }
  }
  return null;
}

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some((item) => matchesType(value, item));
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function typeLabel(type) {
  if (Array.isArray(type)) return type.join(" 或 ");
  return ({ object: "对象", array: "数组", string: "字符串", number: "数字", integer: "整数", boolean: "布尔值", null: "null" })[type] || type;
}

function outcomeMayBeUnknown(definition) {
  if (definition.idempotency === "safe") return false;
  return definition.effects.some((effect) => ["write", "execute", "network", "credential"].includes(effect));
}

function normalizeResult(value, limit) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const safe = redactSensitiveText(text ?? "");
  return safe.length > limit ? `${safe.slice(0, limit)}\n…（已截断）` : safe;
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function raceWithSignal(start, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error("工具执行已取消"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("工具执行已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      signal.removeEventListener("abort", onAbort);
      return;
    }
    let operation;
    try {
      operation = start();
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
      return;
    }
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
