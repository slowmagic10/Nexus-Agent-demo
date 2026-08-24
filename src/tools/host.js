import { createHash } from "node:crypto";
import { redactSensitiveText } from "../security/redact.js";

const APPROVAL_MODES = new Set(["never", "always"]);
const IDEMPOTENCY_MODES = new Set(["safe", "keyed", "unknown"]);
const EFFECTS = new Set(["read", "write", "execute", "network", "memory", "credential"]);

export class ToolHost {
  constructor({ registry, defaultTimeoutMs = 30_000, maxResultChars = 12_000 }) {
    if (!registry || typeof registry.get !== "function" || typeof registry.schemas !== "function") {
      throw new Error("Tool Host 需要 Tool Registry");
    }
    if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs < 1) {
      throw new Error("Tool Host defaultTimeoutMs 必须是正整数");
    }
    this.registry = registry;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxResultChars = maxResultChars;
  }

  schemas() {
    return this.registry.schemas();
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
    const risk = riskLevel(definition.effects);
    await session.dispatch({
      type: "TOOL_AUTHORIZATION_DECIDED",
      call,
      argsHash,
      toolVersion,
      effects: definition.effects,
      idempotency: definition.idempotency,
      adapter: definition.adapter,
      risk,
      decision: definition.approval === "always" ? "approval_required" : "allowed",
    });

    if (signal?.aborted) await cancelledBeforeStart(session, call, signal);

    if (definition.approval === "always") {
      if (typeof requestApproval !== "function") throw new Error(`工具 ${call.name} 需要 Approval callback`);
      await session.dispatch({ type: "APPROVAL_REQUESTED", call, argsHash, toolVersion, risk });
      const approved = await requestApproval(call, definition.description, signal);
      if (signal?.aborted) await cancelledBeforeStart(session, call, signal);
      await session.dispatch({ type: "APPROVAL_DECIDED", call, approved, argsHash, toolVersion });
      if (!approved) {
        return await complete(session, call, {
          ok: false,
          status: "denied",
          result: "用户拒绝了本次工具调用。",
          durationMs: 0,
        });
      }
      const currentTool = this.registry.get(call.name);
      const currentDefinition = currentTool ? normalizeDefinition(currentTool, this.defaultTimeoutMs) : null;
      const currentArgsHash = hashValue(call.arguments);
      if (!currentDefinition || currentArgsHash !== argsHash || definitionVersion(currentDefinition) !== toolVersion) {
        await session.dispatch({
          type: "TOOL_APPROVAL_STALE",
          call,
          argsHash,
          currentArgsHash,
          toolVersion,
        });
        return await complete(session, call, {
          ok: false,
          status: "approval_stale",
          result: "工具参数或定义在审批后发生变化，本次 Approval 已失效。",
          durationMs: 0,
        });
      }
    }

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
  const effects = tool.effects?.length ? [...new Set(tool.effects)] : (approval === "always" ? ["write"] : ["read"]);
  if (effects.some((effect) => !EFFECTS.has(effect))) throw new Error(`工具 ${tool.name} effects 无效`);
  const idempotency = tool.idempotency || "unknown";
  if (!IDEMPOTENCY_MODES.has(idempotency)) throw new Error(`工具 ${tool.name} idempotency 无效`);
  const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error(`工具 ${tool.name} timeoutMs 无效`);
  return {
    ...tool,
    adapter: tool.adapter || "native",
    parameters: tool.parameters || { type: "object" },
    approval,
    effects,
    idempotency,
    timeoutMs,
  };
}

function definitionVersion(definition) {
  return hashValue({
    name: definition.name,
    parameters: definition.parameters,
    effects: definition.effects,
    idempotency: definition.idempotency,
    approval: definition.approval,
    adapter: definition.adapter,
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

function riskLevel(effects) {
  if (effects.includes("credential")) return "R3";
  if (effects.some((effect) => ["execute", "network"].includes(effect))) return "R2";
  if (effects.some((effect) => ["write", "memory"].includes(effect))) return "R1";
  return "R0";
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
