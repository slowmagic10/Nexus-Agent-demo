import { createHash } from "node:crypto";
import { assertArtifactStore } from "../artifacts/interface.js";
import { beginFileChangeCapture, finishFileChangeCapture } from "../artifacts/file-change-manifest.js";
import { redactSensitiveText } from "../security/redact.js";
import { createToolOutputStream } from "./output-stream.js";
import {
  consumeSessionGrant,
  createProjectGrant,
  createSessionGrant,
  issueSessionGrant,
  normalizeCapability,
  WorkspacePolicy,
} from "./authorization.js";

const APPROVAL_MODES = new Set(["never", "always"]);
const IDEMPOTENCY_MODES = new Set(["safe", "keyed", "unknown"]);
const EFFECTS = new Set(["read", "write", "execute", "network", "memory", "credential", "state"]);

export class ToolHost {
  constructor({ registry, policy = new WorkspacePolicy(), projectGrantStore = null, artifactStore = null, defaultTimeoutMs = 30_000, maxResultChars = 12_000 }) {
    if (!registry || typeof registry.get !== "function" || typeof registry.schemas !== "function") {
      throw new Error("Tool Host 需要 Tool Registry");
    }
    if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs < 1) {
      throw new Error("Tool Host defaultTimeoutMs 必须是正整数");
    }
    if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 1) {
      throw new Error("Tool Host maxResultChars 必须是正整数");
    }
    this.registry = registry;
    this.policy = policy;
    this.projectGrantStore = projectGrantStore;
    this.artifactStore = artifactStore ? assertArtifactStore(artifactStore) : null;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxResultChars = maxResultChars;
  }

  schemas({ session } = {}) {
    return this.registry.schemas().filter((schema) => {
      const name = schema.function?.name;
      const tool = name ? this.registry.get(name) : null;
      if (!tool) return false;
      const definition = normalizeDefinition(tool, this.defaultTimeoutMs);
      return definitionAvailable(definition, session?.state) && this.policy.canExpose(definition);
    });
  }

  async execute(call, { session, signal, requestApproval } = {}) {
    validateCall(call);
    if (!session || typeof session.dispatch !== "function") throw new Error("Tool Host 需要 Agent Session");
    const finish = (targetCall, result) => complete(session, targetCall, {
      ...result,
      artifactStore: this.artifactStore,
      maxResultChars: this.maxResultChars,
    });
    const registration = resolveRegistryTool(this.registry, call.name);
    const tool = registration?.tool || null;
    const definition = tool ? normalizeDefinition(tool, this.defaultTimeoutMs) : null;
    const recovered = definition ? recoverWrappedArguments(call.arguments, definition.parameters) : null;
    if (recovered) call = { ...call, arguments: recovered };
    const argsHash = hashValue(call.arguments);
    await session.dispatch({
      type: "TOOL_REQUESTED",
      call,
      argsHash,
      argumentsRecovered: Boolean(recovered),
      effects: definition?.effects || [],
      idempotency: definition?.idempotency || "unknown",
      adapter: definition?.adapter || "unknown",
    });
    const sourceCursor = session.cursor;

    if (!definition) {
      return await finish(call, {
        ok: false,
        status: "not_found",
        result: `未知工具：${call.name}`,
        durationMs: 0,
      });
    }

    if (!definitionAvailable(definition, session.state)) {
      return await finish(call, {
        ok: false,
        status: "capability_unavailable",
        result: `工具 ${call.name} 在当前 Session 中不可用。`,
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
      return await finish(call, {
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
      projectGrants: this.projectGrantStore?.list({ workspace: session.state.workspace }) || [],
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
      return await finish(call, {
        ok: false,
        status: "policy_denied",
        result: `权限策略拒绝工具调用：${authorization.reason}`,
        durationMs: 0,
      });
    }

    if (signal?.aborted) await cancelledBeforeStart(finish, call, signal);

    let executionGrantId = authorization.grantId;
    let executionGrantScope = authorization.grantScope;
    if (authorization.decision === "approval_required") {
      if (typeof requestApproval !== "function") throw new Error(`工具 ${call.name} 需要 Approval callback`);
      const approvalScopes = authorization.approvalScopes || ["once", "session", ...(this.projectGrantStore ? ["project"] : [])];
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
        profile: authorization.profile,
        reason: authorization.reason,
        explanation: authorization.explanation,
        approvalScopes,
      });
      const approval = normalizeApprovalDecision(await requestApproval(
        call,
        `${definition.description}\n授权原因：${authorization.reason}`,
        signal,
      ), { projectAvailable: Boolean(this.projectGrantStore) });
      if (approval.approved && !approvalScopes.includes(approval.scope)) {
        throw new Error(`当前工具审批不支持授权范围：${approval.scope}`);
      }
      if (signal?.aborted) await cancelledBeforeStart(finish, call, signal);
      const currentRegistration = resolveRegistryTool(this.registry, call.name);
      const currentTool = currentRegistration?.tool || null;
      const currentDefinition = currentTool ? normalizeDefinition(currentTool, this.defaultTimeoutMs) : null;
      const currentArgsHash = hashValue(call.arguments);
      const currentAuthorization = currentDefinition ? this.policy.authorize({
        definition: currentDefinition,
        call,
        state: session.state,
        argsHash: currentArgsHash,
        projectGrants: this.projectGrantStore?.list({ workspace: session.state.workspace }) || [],
      }) : null;
      const stale = !currentDefinition
        || !definitionAvailable(currentDefinition, session.state)
        || !sameRegistration(registration, currentRegistration)
        || currentArgsHash !== argsHash
        || definitionVersion(currentDefinition) !== toolVersion
        || currentAuthorization.policyVersion !== authorization.policyVersion
        || currentAuthorization.capabilityHash !== authorization.capabilityHash
        || hashValue(currentAuthorization.resources) !== hashValue(authorization.resources);
      await session.dispatch({
        type: "APPROVAL_DECIDED",
        call,
        approved: approval.approved,
        grantScope: approval.approved ? approval.scope : null,
        argsHash,
        toolVersion,
        policyVersion: authorization.policyVersion,
        capabilityHash: authorization.capabilityHash,
      });
      if (!approval.approved) {
        return await finish(call, {
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
        return await finish(call, {
          ok: false,
          status: "approval_stale",
          result: "工具参数或定义在审批后发生变化，本次 Approval 已失效。",
          durationMs: 0,
        });
      }
      const issuedAt = new Date().toISOString();
      const grant = approval.scope === "project"
        ? createProjectGrant({
            workspace: session.state.workspace,
            tool: call.name,
            capabilityHash: authorization.capabilityHash,
            policyVersion: authorization.policyVersion,
            resources: authorization.resources,
            issuedAt,
          })
        : createSessionGrant({
            sessionId: session.id,
            workspace: session.state.workspace,
            tool: call.name,
            capabilityHash: authorization.capabilityHash,
            policyVersion: authorization.policyVersion,
            resources: authorization.resources,
            ...(approval.scope === "once" ? { callId: call.id, argsHash } : {}),
            issuedAt,
            expiresAt: new Date(new Date(issuedAt).getTime() + (approval.scope === "once" ? 5 * 60_000 : 8 * 60 * 60_000)).toISOString(),
          });
      if (approval.scope === "project") {
        this.projectGrantStore.issue(grant);
        await session.dispatch({ type: "TOOL_PROJECT_GRANT_ISSUED", grant });
      } else {
        await issueSessionGrant(session, grant);
      }
      executionGrantId = grant.id;
      executionGrantScope = approval.scope;
    }

    if (signal?.aborted) await cancelledBeforeStart(finish, call, signal);
    if (executionGrantId && executionGrantScope === "once") await consumeSessionGrant(session, executionGrantId, call.id);
    if (signal?.aborted) await cancelledBeforeStart(finish, call, signal);
    const executionLease = acquireRegistryTool(this.registry, call.name, registration);
    if (!executionLease || definitionVersion(normalizeDefinition(executionLease.tool, this.defaultTimeoutMs)) !== toolVersion) {
      return await capabilityUnavailable(session, finish, call, argsHash, registration, "能力已撤销或替换，Adapter 未启动");
    }
    const changeCapture = await beginTrackedChanges(definition, call.arguments, session.state.workspace);
    if (signal?.aborted) {
      executionLease.release();
      await cancelledBeforeStart(finish, call, signal);
    }
    const timeoutSignal = AbortSignal.timeout(definition.timeoutMs);
    const executionSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
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
        grantScope: executionGrantScope,
      });
    } catch (error) {
      executionLease.release();
      throw error;
    }
    let outputStream = createToolOutputStream({
      call,
      dispatch: (action) => session.dispatch(action),
    });
    const closeOutputStream = async () => {
      if (!outputStream) return;
      const current = outputStream;
      outputStream = null;
      await current.close();
    };
    const started = performance.now();
    let implementationStarted = false;
    let finalizedChanges = null;
    const finishExecution = async (result) => {
      finalizedChanges ||= finalizeTrackedChanges(changeCapture, {
        artifactStore: this.artifactStore,
        sessionId: session.id,
        callId: call.id,
      });
      const fileChanges = await finalizedChanges;
      return await finish(call, appendFileChangeSummary(result, fileChanges));
    };
    try {
      const value = await raceWithSignal(() => {
        implementationStarted = true;
        return definition.execute(call.arguments, {
          state: session.state,
          dispatch: (action) => session.dispatch(action),
          signal: executionSignal,
          sourceCursor,
          callId: call.id,
          onOutput: (event) => outputStream?.append(event),
        });
      }, executionSignal);
      await closeOutputStream();
      return await finishExecution({
        ok: true,
        status: "completed",
        result: normalizeResult(value),
        durationMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      await closeOutputStream();
      const durationMs = Math.round(performance.now() - started);
      if (signal?.aborted) {
        if (!implementationStarted) await cancelledBeforeStart(finish, call, signal, durationMs);
        const unknown = outcomeMayBeUnknown(definition);
        if (unknown) await executionUnknown(session, call, definition, argsHash, "cancelled", durationMs);
        await finishExecution({
          ok: false,
          status: unknown ? "execution_unknown" : "cancelled",
          result: unknown
            ? "任务已取消：工具已经启动，副作用结果未知，不会自动重试。"
            : "任务已取消：工具执行已停止等待。",
          durationMs,
        });
        throw error;
      }
      if (timeoutSignal.aborted) {
        if (!implementationStarted) {
          return await finishExecution({
            ok: false,
            status: "timeout",
            result: `工具执行超时（${definition.timeoutMs}ms），实现尚未启动。`,
            durationMs,
          });
        }
        const unknown = outcomeMayBeUnknown(definition);
        if (unknown) await executionUnknown(session, call, definition, argsHash, "timeout", durationMs);
        return await finishExecution({
          ok: false,
          status: unknown ? "execution_unknown" : "timeout",
          result: unknown
            ? `工具执行超时（${definition.timeoutMs}ms），副作用结果未知，不会自动重试。`
            : `工具执行超时（${definition.timeoutMs}ms），已停止等待。`,
          durationMs,
        });
      }
      return await finishExecution({
        ok: false,
        status: "external_failed",
        result: `工具执行失败：${redactSensitiveText(error?.message || "未知错误")}`,
        durationMs,
      });
    } finally {
      executionLease.release();
    }
  }
}

function normalizeApprovalDecision(value, { projectAvailable }) {
  if (typeof value === "boolean") return { approved: value, scope: "once" };
  if (!value || typeof value !== "object" || typeof value.approved !== "boolean") {
    throw new Error("Approval callback 必须返回布尔值或 { approved, scope }");
  }
  if (!value.approved) return { approved: false, scope: "once" };
  const scope = value.scope || "once";
  if (!["once", "session", "project"].includes(scope)) throw new Error(`Approval scope 无效：${scope}`);
  if (scope === "project" && !projectAvailable) throw new Error("当前运行环境未配置 Project Grant Store");
  return { approved: true, scope };
}

async function capabilityUnavailable(session, finish, call, argsHash, registration, reason) {
  await session.dispatch({
    type: "TOOL_CAPABILITY_UNAVAILABLE",
    call,
    argsHash,
    registrationId: serializableRegistrationId(registration?.registrationId),
    reason,
  });
  return await finish(call, {
    ok: false,
    status: "capability_unavailable",
    result: "工具能力已撤销或替换，本次调用不会启动 Adapter。",
    durationMs: 0,
  });
}

async function cancelledBeforeStart(finish, call, signal, durationMs = 0) {
  await finish(call, {
    ok: false,
    status: "cancelled",
    result: "任务已取消：工具尚未启动。",
    durationMs,
  });
  throw signal?.reason || new Error("任务已取消");
}

async function executionUnknown(session, call, definition, argsHash, reason, durationMs = 0) {
  await session.dispatch({
    type: "TOOL_EXECUTION_UNKNOWN",
    call,
    argsHash,
    effects: definition.effects,
    idempotency: definition.idempotency,
    adapter: definition.adapter,
    reason,
    durationMs,
  });
}

async function complete(session, call, result) {
  const {
    artifactStore = null,
    maxResultChars = null,
    ...publicResult
  } = result;
  const fullSafeResult = redactSensitiveText(result.result);
  let safeResult = fullSafeResult;
  let artifact = null;
  if (maxResultChars && fullSafeResult.length > maxResultChars) {
    if (artifactStore) {
      try {
        artifact = await artifactStore.put({
          sessionId: session.id,
          callId: call.id,
          kind: "tool_output",
          content: fullSafeResult,
        });
      } catch {
        artifact = null;
      }
    }
    safeResult = artifact
      ? `${fullSafeResult.slice(0, maxResultChars)}\n…完整输出已保存为 Artifact：${artifact.id}（${artifact.byteSize} 字节）`
      : `${fullSafeResult.slice(0, maxResultChars)}\n…（已截断）`;
  }
  await session.dispatch({
    type: "TOOL_RESULT",
    call,
    ok: result.ok,
    status: result.status,
    result: safeResult,
    durationMs: result.durationMs,
    ...(artifact ? { artifact } : {}),
    ...(result.fileChanges ? { fileChanges: result.fileChanges } : {}),
  });
  return { ...publicResult, result: safeResult, ...(artifact ? { artifact } : {}) };
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
    changeTracking: normalizeChangeTracking(tool.changeTracking),
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
    changeTracking: definition.changeTracking,
  });
}

function normalizeChangeTracking(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("changeTracking 必须是对象");
  if (value.mode === "workspace" && Object.keys(value).every((key) => key === "mode")) {
    return Object.freeze({ mode: "workspace", arguments: Object.freeze([]) });
  }
  if (value.mode === "paths" && Array.isArray(value.arguments) && value.arguments.length
      && value.arguments.every((name) => typeof name === "string" && name)) {
    const unknown = Object.keys(value).find((key) => !["mode", "arguments", "pathField"].includes(key));
    if (unknown) throw new Error(`changeTracking 包含未知字段 ${unknown}`);
    if (value.pathField !== undefined && (typeof value.pathField !== "string" || !value.pathField)) {
      throw new Error("changeTracking.pathField 必须是非空字符串");
    }
    return Object.freeze({
      mode: "paths",
      arguments: Object.freeze([...new Set(value.arguments)]),
      ...(value.pathField ? { pathField: value.pathField } : {}),
    });
  }
  throw new Error("changeTracking 必须声明 workspace 或带 arguments 的 paths 模式");
}

async function beginTrackedChanges(definition, args, workspace) {
  if (!definition.changeTracking) return null;
  try {
    const paths = definition.changeTracking.arguments.flatMap((name) => {
      const value = args[name];
      if (!definition.changeTracking.pathField) return [value];
      return Array.isArray(value) ? value.map((item) => item?.[definition.changeTracking.pathField]) : [];
    });
    return await beginFileChangeCapture({
      workspace,
      mode: definition.changeTracking.mode,
      paths,
    });
  } catch {
    return { unavailable: true };
  }
}

async function finalizeTrackedChanges(capture, { artifactStore, sessionId, callId }) {
  if (!capture) return null;
  if (capture.unavailable) return unavailableFileChanges();
  try {
    const { manifest, diff } = await finishFileChangeCapture(capture);
    let diffArtifact = null;
    if (diff && artifactStore) {
      try {
        diffArtifact = await artifactStore.put({
          sessionId,
          callId,
          kind: "file_diff",
          mediaType: "text/x-diff; charset=utf-8",
          content: redactSensitiveText(diff),
        });
      } catch {
        diffArtifact = null;
      }
    }
    if (!manifest.summary.total && manifest.complete) return null;
    return {
      ...manifest,
      ...(diffArtifact ? { diffArtifact } : {}),
      ...(!diffArtifact && diff ? { diffUnavailable: true } : {}),
    };
  } catch {
    return unavailableFileChanges();
  }
}

function unavailableFileChanges() {
  return {
    version: 1,
    complete: false,
    summary: { created: 0, modified: 0, deleted: 0, total: 0 },
    changes: [],
    diffTruncated: false,
    captureUnavailable: true,
  };
}

function appendFileChangeSummary(result, fileChanges) {
  if (!fileChanges) return result;
  const { created, modified, deleted, total } = fileChanges.summary;
  const summary = total
    ? `文件变更：新增 ${created}、修改 ${modified}、删除 ${deleted}`
    : "文件变更：采集不完整，未观察到可确认的变更";
  const reference = fileChanges.diffArtifact
    ? `；Diff Artifact：${fileChanges.diffArtifact.id}`
    : "";
  return {
    ...result,
    result: `${result.result}\n${summary}${reference}`,
    fileChanges,
  };
}

function definitionAvailable(definition, state) {
  return typeof definition.available !== "function" || definition.available({ state }) === true;
}

function resolveRegistryTool(registry, name) {
  if (typeof registry.resolve === "function") {
    const registration = registry.resolve(name);
    return registration ? { tool: registration.value, registrationId: registration.registrationId } : null;
  }
  const tool = registry.get(name);
  return tool ? { tool, registrationId: tool } : null;
}

function acquireRegistryTool(registry, name, expected) {
  if (typeof registry.acquire === "function") {
    const lease = registry.acquire(name, expected?.registrationId);
    return lease ? { tool: lease.value, release: lease.release } : null;
  }
  const current = resolveRegistryTool(registry, name);
  if (!sameRegistration(expected, current)) return null;
  return { tool: current.tool, release: () => true };
}

function sameRegistration(left, right) {
  return Boolean(left && right && left.registrationId === right.registrationId);
}

function serializableRegistrationId(value) {
  return typeof value === "string" ? value : null;
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
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) return `${path} 至少需要 ${schema.minItems} 项`;
    if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} 最多允许 ${schema.maxItems} 项`;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateArguments(schema.items, value[index], `${path}[${index}]`);
      if (error) return error;
    }
  }
  return null;
}

function recoverWrappedArguments(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!validateArguments(schema, value)) return null;
  if (Object.keys(value).length !== 1 || typeof value.arguments !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(value.arguments);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return validateArguments(schema, parsed) ? null : parsed;
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

function normalizeResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return redactSensitiveText(text ?? "");
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
