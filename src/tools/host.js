import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
const DEADLINE_ENFORCEMENTS = new Set(["host", "adapter"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
      return definitionAvailable(definition, session?.state)
        && this.policy.canExpose(definition)
        && !validateSchemaSupport(definition.parameters, `工具 ${name} parameters`);
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

    const effectiveTimeoutMs = resolveEffectiveTimeoutMs(definition, call.arguments);

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

    if (signal?.aborted) await cancelledBeforeStart(finish, call, signal, 0, effectiveTimeoutMs);

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
      if (signal?.aborted) await cancelledBeforeStart(finish, call, signal, 0, effectiveTimeoutMs);
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

    if (signal?.aborted) await cancelledBeforeStart(finish, call, signal, 0, effectiveTimeoutMs);
    if (executionGrantId && executionGrantScope === "once") await consumeSessionGrant(session, executionGrantId, call.id);
    if (signal?.aborted) await cancelledBeforeStart(finish, call, signal, 0, effectiveTimeoutMs);
    const executionLease = acquireRegistryTool(this.registry, call.name, registration);
    if (!executionLease || definitionVersion(normalizeDefinition(executionLease.tool, this.defaultTimeoutMs)) !== toolVersion) {
      return await capabilityUnavailable(session, finish, call, argsHash, registration, "能力已撤销或替换，Adapter 未启动");
    }
    const changeCapture = await beginTrackedChanges(definition, call.arguments, session.state.workspace);
    if (signal?.aborted) {
      executionLease.release();
      await cancelledBeforeStart(finish, call, signal, 0, effectiveTimeoutMs);
    }
    const timeoutSignal = effectiveTimeoutMs === null ? null : AbortSignal.timeout(effectiveTimeoutMs);
    const termination = trackFirstTermination(signal, timeoutSignal);
    const executionSignal = combineAbortSignals(signal, timeoutSignal);
    const settleAfterAbortMs = definition.deadline.enforcement === "adapter"
      ? definition.deadline.hostGraceMs
      : 0;
    const executionStartedAt = new Date();
    const deadlineAt = effectiveTimeoutMs === null
      ? null
      : new Date(executionStartedAt.getTime() + effectiveTimeoutMs).toISOString();
    try {
      await session.dispatch({
        type: "TOOL_EXECUTION_STARTED",
        at: executionStartedAt.toISOString(),
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
        effectiveTimeoutMs,
        deadlineAt,
      });
    } catch (error) {
      termination.dispose();
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
          effectiveTimeoutMs,
          deadlineAt,
        });
      }, executionSignal, { settleAfterAbortMs });
      await closeOutputStream();
      return await finishExecution({
        ok: true,
        status: "completed",
        result: normalizeResult(value),
        durationMs: Math.round(performance.now() - started),
        effectiveTimeoutMs,
        terminationReason: "completed",
      });
    } catch (error) {
      await closeOutputStream();
      const durationMs = Math.round(performance.now() - started);
      if (termination.cause === "cancelled" || (!termination.cause && signal?.aborted)) {
        if (!implementationStarted) await cancelledBeforeStart(finish, call, signal, durationMs, effectiveTimeoutMs);
        const unknown = outcomeMayBeUnknown(definition);
        if (unknown) await executionUnknown(session, call, definition, argsHash, "cancelled", durationMs, effectiveTimeoutMs);
        await finishExecution({
          ok: false,
          status: unknown ? "execution_unknown" : "cancelled",
          result: appendExecutionErrorOutput(unknown
            ? "任务已取消：工具已经启动，副作用结果未知，不会自动重试。"
            : "任务已取消：工具执行已停止等待。", error),
          durationMs,
          effectiveTimeoutMs,
          terminationReason: "cancelled",
        });
        throw error;
      }
      if (termination.cause === "timeout"
          || (!termination.cause && effectiveTimeoutMs !== null && (timeoutSignal?.aborted || error?.code === "timeout"))) {
        if (!implementationStarted) {
          return await finishExecution({
            ok: false,
            status: "timeout",
            result: `工具执行超时（${effectiveTimeoutMs}ms），实现尚未启动。`,
            durationMs,
            effectiveTimeoutMs,
            terminationReason: "timeout",
          });
        }
        const unknown = outcomeMayBeUnknown(definition);
        if (unknown) await executionUnknown(session, call, definition, argsHash, "timeout", durationMs, effectiveTimeoutMs);
        return await finishExecution({
          ok: false,
          status: unknown ? "execution_unknown" : "timeout",
          result: appendExecutionErrorOutput(unknown
            ? `工具执行超时（${effectiveTimeoutMs}ms），副作用结果未知，不会自动重试。`
            : `工具执行超时（${effectiveTimeoutMs}ms），已停止等待。`, error),
          durationMs,
          effectiveTimeoutMs,
          terminationReason: "timeout",
        });
      }
      return await finishExecution({
        ok: false,
        status: "external_failed",
        result: appendExecutionErrorOutput(
          `工具执行失败：${redactSensitiveText(error?.message || "未知错误")}`,
          error,
        ),
        durationMs,
        effectiveTimeoutMs,
        terminationReason: "external_failed",
      });
    } finally {
      termination.dispose();
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

async function cancelledBeforeStart(finish, call, signal, durationMs = 0, effectiveTimeoutMs = undefined) {
  await finish(call, {
    ok: false,
    status: "cancelled",
    result: "任务已取消：工具尚未启动。",
    durationMs,
    ...(effectiveTimeoutMs !== undefined ? { effectiveTimeoutMs } : {}),
    terminationReason: "cancelled",
  });
  throw signal?.reason || new Error("任务已取消");
}

async function executionUnknown(session, call, definition, argsHash, reason, durationMs = 0, effectiveTimeoutMs = undefined) {
  await session.dispatch({
    type: "TOOL_EXECUTION_UNKNOWN",
    call,
    argsHash,
    effects: definition.effects,
    idempotency: definition.idempotency,
    adapter: definition.adapter,
    reason,
    durationMs,
    ...(effectiveTimeoutMs !== undefined ? { effectiveTimeoutMs } : {}),
    terminationReason: reason,
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
    ...(Object.hasOwn(result, "effectiveTimeoutMs") ? { effectiveTimeoutMs: result.effectiveTimeoutMs } : {}),
    ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
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
  const parameters = tool.parameters || { type: "object" };
  const deadline = normalizeDeadline(tool, defaultTimeoutMs, parameters);
  const definition = {
    ...tool,
    adapter: tool.adapter || "native",
    parameters,
    approval,
    effects,
    idempotency,
    timeoutMs: deadline.defaultMs,
    deadline,
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
    deadline: definition.deadline,
    capability: definition.capability,
    changeTracking: definition.changeTracking,
  });
}

function normalizeDeadline(tool, defaultTimeoutMs, parameters) {
  if (tool.deadline === undefined) {
    const defaultMs = Object.hasOwn(tool, "timeoutMs") ? tool.timeoutMs : defaultTimeoutMs;
    assertTimeoutMs(defaultMs, `工具 ${tool.name} timeoutMs`);
    return Object.freeze({
      defaultMs,
      argument: null,
      maximumMs: defaultMs,
      enforcement: "host",
      hostGraceMs: 0,
    });
  }
  if (Object.hasOwn(tool, "timeoutMs")) {
    throw new Error(`工具 ${tool.name} 不能同时声明 timeoutMs 和 deadline`);
  }
  const value = tool.deadline;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`工具 ${tool.name} deadline 必须是对象`);
  }
  const unknown = Object.keys(value).find((key) => ![
    "defaultMs", "argument", "maximumMs", "enforcement", "hostGraceMs",
  ].includes(key));
  if (unknown) throw new Error(`工具 ${tool.name} deadline 包含未知字段 ${unknown}`);
  const defaultMs = Object.hasOwn(value, "defaultMs") ? value.defaultMs : defaultTimeoutMs;
  assertTimeoutMs(defaultMs, `工具 ${tool.name} deadline.defaultMs`);
  const argument = value.argument ?? null;
  if (argument !== null && (typeof argument !== "string" || !argument)) {
    throw new Error(`工具 ${tool.name} deadline.argument 必须是非空字符串或 null`);
  }
  if (argument && !Object.hasOwn(parameters?.properties || {}, argument)) {
    throw new Error(`工具 ${tool.name} deadline.argument 未在 parameters 中声明：${argument}`);
  }
  const maximumMs = value.maximumMs ?? MAX_TIMER_DELAY_MS;
  if (!Number.isSafeInteger(maximumMs) || maximumMs < 1 || maximumMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`工具 ${tool.name} deadline.maximumMs 必须是 1 到 ${MAX_TIMER_DELAY_MS} 的整数`);
  }
  if (defaultMs !== null && defaultMs > maximumMs) {
    throw new Error(`工具 ${tool.name} deadline.defaultMs 不能超过 maximumMs`);
  }
  const enforcement = value.enforcement || "host";
  if (!DEADLINE_ENFORCEMENTS.has(enforcement)) {
    throw new Error(`工具 ${tool.name} deadline.enforcement 无效`);
  }
  const hostGraceMs = value.hostGraceMs ?? 0;
  if (!Number.isSafeInteger(hostGraceMs) || hostGraceMs < 0 || hostGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`工具 ${tool.name} deadline.hostGraceMs 必须是非负整数`);
  }
  return Object.freeze({ defaultMs, argument, maximumMs, enforcement, hostGraceMs });
}

function assertTimeoutMs(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)) {
    throw new Error(`${label} 必须是 1 到 ${MAX_TIMER_DELAY_MS} 的整数或 null`);
  }
}

function resolveEffectiveTimeoutMs(definition, args) {
  const { argument, defaultMs, maximumMs } = definition.deadline;
  const value = argument && Object.hasOwn(args, argument) ? args[argument] : defaultMs;
  assertTimeoutMs(value, `工具 ${definition.name} effectiveTimeoutMs`);
  if (value !== null && value > maximumMs) {
    throw new Error(`工具 ${definition.name} effectiveTimeoutMs 不能超过 ${maximumMs}`);
  }
  return value;
}

function combineAbortSignals(signal, timeoutSignal) {
  if (signal && timeoutSignal) return AbortSignal.any([signal, timeoutSignal]);
  return signal || timeoutSignal || null;
}

function trackFirstTermination(signal, timeoutSignal) {
  let cause = null;
  const recordCancelled = () => { cause ||= "cancelled"; };
  const recordTimeout = () => { cause ||= "timeout"; };
  signal?.addEventListener("abort", recordCancelled, { once: true });
  timeoutSignal?.addEventListener("abort", recordTimeout, { once: true });
  if (signal?.aborted) recordCancelled();
  if (timeoutSignal?.aborted) recordTimeout();
  return {
    get cause() {
      return cause;
    },
    dispose() {
      signal?.removeEventListener("abort", recordCancelled);
      timeoutSignal?.removeEventListener("abort", recordTimeout);
    },
  };
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
  const supportError = validateSchemaSupport(schema, path);
  if (supportError) return supportError;
  return validateSchemaValue(schema, value, path);
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  "type", "enum", "const", "anyOf", "oneOf", "allOf", "not", "properties", "required",
  "additionalProperties", "items", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern",
]);

function validateSchemaSupport(schema, path) {
  if (schema === true || schema === false) return null;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${path} 的 JSON Schema 必须是对象或布尔值`;
  const unsupported = Object.keys(schema).find((key) => !SUPPORTED_SCHEMA_KEYWORDS.has(key));
  if (unsupported) return `${path} 使用了未支持的 JSON Schema 关键字 ${unsupported}`;

  const allowedTypes = new Set(["null", "array", "object", "integer", "number", "string", "boolean"]);
  const declaredTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type !== undefined && (!declaredTypes.length || declaredTypes.some((type) => !allowedTypes.has(type)))) {
    return `${path}.type 包含无效类型`;
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    return `${path}.enum 必须是非空数组`;
  }
  if (schema.required !== undefined
      && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string")
        || new Set(schema.required).size !== schema.required.length)) {
    return `${path}.required 必须是不重复的字符串数组`;
  }
  for (const keyword of ["minItems", "maxItems", "minProperties", "maxProperties", "minLength", "maxLength"]) {
    if (schema[keyword] !== undefined && (!Number.isSafeInteger(schema[keyword]) || schema[keyword] < 0)) {
      return `${path}.${keyword} 必须是非负安全整数`;
    }
  }
  for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[keyword] !== undefined && (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword]))) {
      return `${path}.${keyword} 必须是有限数字`;
    }
  }
  if (schema.multipleOf !== undefined
      && (typeof schema.multipleOf !== "number" || !Number.isFinite(schema.multipleOf) || schema.multipleOf <= 0)) {
    return `${path}.multipleOf 必须是正有限数字`;
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    return `${path}.uniqueItems 必须是布尔值`;
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (schema[keyword] !== undefined) {
      if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) return `${path}.${keyword} 必须是非空数组`;
      for (const [index, child] of schema[keyword].entries()) {
        const error = validateSchemaSupport(child, `${path}.${keyword}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (schema.not !== undefined) {
    const error = validateSchemaSupport(schema.not, `${path}.not`);
    if (error) return error;
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      return `${path}.properties 必须是对象`;
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      const error = validateSchemaSupport(child, `${path}.properties.${key}`);
      if (error) return error;
    }
  }
  if (schema.items !== undefined) {
    const error = validateSchemaSupport(schema.items, `${path}.items`);
    if (error) return error;
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    const error = validateSchemaSupport(schema.additionalProperties, `${path}.additionalProperties`);
    if (error) return error;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") return `${path}.pattern 必须是字符串`;
    try {
      new RegExp(schema.pattern);
    } catch {
      return `${path}.pattern 不是有效正则表达式`;
    }
  }
  return null;
}

function validateSchemaValue(schema, value, path) {
  if (schema === true) return null;
  if (schema === false) return `${path} 被 JSON Schema 禁止`;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => isDeepStrictEqual(item, value))) {
    return `${path} 不在允许值中`;
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(schema.const, value)) {
    return `${path} 必须等于声明的常量`;
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((item) => !validateSchemaValue(item, value, path))) return `${path} 不匹配任何允许结构`;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((item) => !validateSchemaValue(item, value, path)).length;
    if (matches !== 1) return `${path} 必须且只能匹配一个允许结构`;
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      const error = validateSchemaValue(child, value, path);
      if (error) return error;
    }
  }
  if (schema.not && !validateSchemaValue(schema.not, value, path)) {
    return `${path} 匹配了禁止结构`;
  }
  const type = schema.type;
  if (type && !matchesType(value, type)) return `${path} 必须是 ${typeLabel(type)}`;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} 不能小于 ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} 不能大于 ${schema.maximum}`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${path} 必须大于 ${schema.exclusiveMinimum}`;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return `${path} 必须小于 ${schema.exclusiveMaximum}`;
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient))) {
        return `${path} 必须是 ${schema.multipleOf} 的倍数`;
      }
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (Number.isSafeInteger(schema.minLength) && length < schema.minLength) return `${path} 长度不能小于 ${schema.minLength}`;
    if (Number.isSafeInteger(schema.maxLength) && length > schema.maxLength) return `${path} 长度不能大于 ${schema.maxLength}`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${path} 不匹配要求的格式`;
  }

  if (matchesType(value, "object")) {
    const size = Object.keys(value).length;
    if (Number.isSafeInteger(schema.minProperties) && size < schema.minProperties) return `${path} 字段数量不能小于 ${schema.minProperties}`;
    if (Number.isSafeInteger(schema.maxProperties) && size > schema.maxProperties) return `${path} 字段数量不能大于 ${schema.maxProperties}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} 必须是对象`;
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) return `${path} 缺少必填字段 ${key}`;
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(schema.properties || {}, key));
      if (unknown) return `${path} 包含未知字段 ${unknown}`;
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(value).filter((name) => !Object.hasOwn(schema.properties || {}, name))) {
        const error = validateSchemaValue(schema.additionalProperties, value[key], `${path}.${key}`);
        if (error) return error;
      }
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateSchemaValue(child, value[key], `${path}.${key}`);
      if (error) return error;
    }
  }

  if (Array.isArray(value)) {
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) return `${path} 至少需要 ${schema.minItems} 项`;
    if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} 最多允许 ${schema.maxItems} 项`;
    if (schema.uniqueItems === true) {
      if (value.some((item, index) => value.slice(0, index).some((seen) => isDeepStrictEqual(seen, item)))) {
        return `${path} 不允许重复项`;
      }
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateSchemaValue(schema.items, value[index], `${path}[${index}]`);
        if (error) return error;
      }
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

function appendExecutionErrorOutput(message, error) {
  const output = error?.result?.output;
  if (typeof output !== "string" || !output) return message;
  return `${message}\n\n执行输出：\n${output}`;
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function raceWithSignal(start, signal, { settleAfterAbortMs = 0 } = {}) {
  if (!signal) return Promise.resolve().then(start);
  if (signal.aborted) return Promise.reject(signal.reason || new Error("工具执行已取消"));
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortTimer = null;
    const cleanup = () => {
      if (abortTimer) clearTimeout(abortTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const abortReason = () => signal.reason || new Error("工具执行已取消");
    const onAbort = () => {
      if (settleAfterAbortMs <= 0) {
        settle(reject, abortReason());
        return;
      }
      abortTimer ||= setTimeout(() => settle(reject, abortReason()), settleAfterAbortMs);
      abortTimer.unref?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      settle(reject, abortReason());
      return;
    }
    let operation;
    try {
      operation = start();
    } catch (error) {
      settle(reject, error);
      return;
    }
    Promise.resolve(operation).then(
      (value) => signal.aborted ? settle(reject, abortReason()) : settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}
