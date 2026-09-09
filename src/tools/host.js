import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertArtifactStore } from "../artifacts/interface.js";
import { SQLiteArtifactAdapter } from "../artifacts/sqlite-adapter.js";
import { beginFileChangeCapture, finishFileChangeCapture } from "../artifacts/file-change-manifest.js";
import { redactSensitiveText } from "../security/redact.js";
import { createToolOutputStream } from "./output-stream.js";
import { runToolBatch } from "./batch.js";
import { refreshVerification as refreshSessionVerification } from "../core/verification.js";
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

  async refreshVerification({ session, signal } = {}) {
    if (!session?.state.plan?.acceptance?.length) return;
    if (typeof this.registry.refreshVerification !== "function") {
      return refreshSessionVerification({ session, signal });
    }
    return this.registry.refreshVerification({ session, signal,
      authorizeRead: createInternalReadGuard({ registry: this.registry, policy: this.policy, session }) });
  }

  execute(call, context = {}) {
    return this.#executeCall(call, context);
  }

  executeBatch(calls, context = {}) {
    return runToolBatch(calls, context, {
      prepareRead: (call) => this.prepareParallelRead(call, context),
      executeSerial: (call) => this.execute(call, context),
    });
  }

  prepareParallelRead(input, context = {}) {
    const { session } = context;
    if (typeof session?.dispatchWithReceipt !== "function" || input?.name !== "read_file") return null;
    // Large read results may write an internal Artifact. Only the known
    // synchronous SQLite put implementation is safe to use across read lanes.
    if (this.artifactStore && (!(this.artifactStore instanceof SQLiteArtifactAdapter)
      || this.artifactStore.put !== SQLiteArtifactAdapter.prototype.put)) return null;
    try {
      const call = structuredClone(input);
      validateCall(call);
      const registration = resolveRegistryTool(this.registry, call.name);
      const definition = registration ? normalizeDefinition(registration.tool, this.defaultTimeoutMs) : null;
      if (!isParallelReadDefinition(registration, definition)) return null;
      const args = recoverWrappedArguments(call.arguments, definition.parameters) || call.arguments;
      if (validateArguments(definition.parameters, args)) return null;
      const state = session.state;
      if (!definitionAvailable(definition, state)) return null;
      if (this.policy.profile?.name && this.policy.profile.name !== state.permissionProfile) return null;
      const argsHash = hashValue(args);
      const authorization = this.policy.authorize({ definition, call: { ...call, arguments: args }, state, argsHash,
        projectGrants: this.projectGrantStore?.list({ workspace: state.workspace }) || [] });
      if (!parallelAuthorization(authorization)) return null;
      const admission = { registration, execute: definition.execute, toolVersion: definitionVersion(definition),
        argsHash, permissionProfile: state.permissionProfile, authorization: authorizationIdentity(authorization),
        artifactStore: this.artifactStore, artifactPut: this.artifactStore?.put ?? null,
        artifactSink: this.artifactStore ? { put: this.artifactStore.put.bind(this.artifactStore) } : null };
      let used = false;
      return Object.freeze({ run: async () => {
        if (used) throw new Error("只读批次执行计划不能重复使用");
        used = true;
        let action = null;
        let sourceCursor = null;
        const settings = { admission,
          onRequested: (cursor) => { sourceCursor = cursor; },
          resultSink: (value) => {
            if (action) throw new Error("只读批次工具出现重复终态");
            action = value;
          },
        };
        try { return { result: await this.#executeCall(call, context, settings), action, error: null }; }
        catch (error) {
          if (!action && sourceCursor !== null) {
            await complete(session, call, { ok: false, status: context.signal?.aborted ? "cancelled" : "internal_failed",
              result: context.signal?.aborted ? "读取已取消，原生操作已收束。" : "读取批次发生内部错误，未能取得结果。",
              durationMs: 0, sourceCursor, resultSink: settings.resultSink });
          }
          return { result: null, action, error };
        }
      } });
    } catch { return null; }
  }

  #parallelAdmissionValid(call, session, definition, admission) {
    const current = resolveRegistryTool(this.registry, call.name);
    const currentDefinition = current ? normalizeDefinition(current.tool, this.defaultTimeoutMs) : null;
    const state = session.state;
    if (!isParallelReadDefinition(current, currentDefinition) || !sameRegistration(current, admission.registration)
      || this.artifactStore !== admission.artifactStore || (this.artifactStore?.put ?? null) !== admission.artifactPut
      || current.tool.execute !== admission.execute || definition.execute !== admission.execute
      || definitionVersion(currentDefinition) !== admission.toolVersion
      || definitionVersion(definition) !== admission.toolVersion || hashValue(call.arguments) !== admission.argsHash
      || state.permissionProfile !== admission.permissionProfile || !definitionAvailable(definition, state)
      || !definitionAvailable(currentDefinition, state)) return false;
    const authorization = this.policy.authorize({ definition, call, state, argsHash: admission.argsHash,
      projectGrants: this.projectGrantStore?.list({ workspace: state.workspace }) || [] });
    return parallelAuthorization(authorization)
      && isDeepStrictEqual(authorizationIdentity(authorization), admission.authorization);
  }

  async #executeCall(call, { session, signal, requestApproval } = {}, settings = {}) {
    validateCall(call);
    if (!session || typeof session.dispatch !== "function") throw new Error("Tool Host 需要 Agent Session");
    let sourceCursor;
    let verificationRecord = null;
    const finish = (targetCall, result) => complete(session, targetCall, {
      ...result,
      ...(sourceCursor !== undefined ? { sourceCursor } : {}),
      ...(verificationRecord ? { verification: verificationRecord } : {}),
      ...(settings.resultSink ? { resultSink: settings.resultSink } : {}),
      artifactStore: settings.admission ? settings.admission.artifactSink : this.artifactStore,
      maxResultChars: this.maxResultChars,
    });
    const registration = resolveRegistryTool(this.registry, call.name);
    const tool = registration?.tool || null;
    const definition = tool ? normalizeDefinition(tool, this.defaultTimeoutMs) : null;
    const recovered = definition ? recoverWrappedArguments(call.arguments, definition.parameters) : null;
    if (recovered) call = { ...call, arguments: recovered };
    const argsHash = hashValue(call.arguments);
    const requestedAction = {
      type: "TOOL_REQUESTED",
      call,
      argsHash,
      argumentsRecovered: Boolean(recovered),
      effects: definition?.effects || [],
      idempotency: definition?.idempotency || "unknown",
      adapter: definition?.adapter || "unknown",
    };
    if (typeof session.dispatchWithReceipt === "function") {
      sourceCursor = (await session.dispatchWithReceipt(requestedAction, { includeState: false })).cursor;
      if (!Number.isSafeInteger(sourceCursor) || sourceCursor < 1) throw new Error("Tool Host 收到无效的 durable dispatch receipt");
    } else {
      await session.dispatch(requestedAction);
      sourceCursor = session.cursor;
    }
    settings.onRequested?.(sourceCursor);

    if (settings.admission && (!definition || !this.#parallelAdmissionValid(call, session, definition, settings.admission))) {
      return await finish(call, { ok: false, status: "capability_unavailable",
        result: "读取条件或工具登记已变化，本次调用未启动；请按当前权限重新请求。", durationMs: 0 });
    }

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
    let authorizationProfile;
    const authorization = (() => {
      const state = session.state;
      authorizationProfile = state.permissionProfile;
      return this.policy.authorize({ definition, call, state, argsHash,
        projectGrants: this.projectGrantStore?.list({ workspace: state.workspace }) || [] });
    })();
    if (settings.admission && (!parallelAuthorization(authorization)
      || !isDeepStrictEqual(authorizationIdentity(authorization), settings.admission.authorization))) {
      return await finish(call, { ok: false, status: "capability_unavailable",
        result: "读取授权已变化，本次调用未启动；请按当前权限重新请求。", durationMs: 0 });
    }
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
    if (!executionLease) {
      return await capabilityUnavailable(session, finish, call, argsHash, registration, "能力已撤销或替换，Adapter 未启动");
    }
    try {
      if (definitionVersion(normalizeDefinition(executionLease.tool, this.defaultTimeoutMs)) !== toolVersion) {
        return await capabilityUnavailable(session, finish, call, argsHash, registration, "能力定义已变化，Adapter 未启动");
      }
      if (settings.admission && !this.#parallelAdmissionValid(call, session, definition, settings.admission)) {
        return await finish(call, { ok: false, status: "capability_unavailable",
          result: "读取启动前权限或工具已变化，本次调用未启动。", durationMs: 0 });
      }
      const changeCapture = await beginTrackedChanges(definition, call.arguments, this, session);
      if (signal?.aborted) {
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
      let executionActive = false;
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
        if (settings.admission && !this.#parallelAdmissionValid(call, session, definition, settings.admission)) {
          throw new ReadAdmissionChangedError();
          }
          implementationStarted = true;
          executionActive = true;
          const executionContext = {
            state: session.state,
            signal: executionSignal,
            sourceCursor,
            callId: call.id,
            authorizeRead: executionGrantId && registration.owner === "nexus:native-tools" && definition.name === "read_file"
              ? createGrantedToolReadGuard({ host: this, session, definition, call, argsHash, authorization,
                  permissionProfile: authorizationProfile, grantId: executionGrantId, grantScope: executionGrantScope,
                  isActive: () => executionActive })
              : createInternalReadGuard({ registry: this.registry, policy: this.policy, session }),
            effectiveTimeoutMs,
            deadlineAt,
          };
          if (settings.admission) return definition.execute(call.arguments, Object.freeze(executionContext));
          return definition.execute(call.arguments, {
            ...executionContext,
            dispatch: (action) => session.dispatch(action),
            queryToolHistory: (options) => {
              executionSignal.throwIfAborted();
              return session.queryToolHistory(options);
            },
            recordVerification: (record) => { verificationRecord = structuredClone(record); },
            onOutput: (event) => outputStream?.append(event),
            effectiveTimeoutMs,
            deadlineAt,
          });
        }, executionSignal, { settleAfterAbortMs, waitForSettlement: Boolean(settings.admission) });
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
        if (error instanceof ReadAdmissionChangedError) {
          return await finishExecution({ ok: false, status: "capability_unavailable", result: error.message,
            durationMs, effectiveTimeoutMs, terminationReason: "capability_unavailable" });
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
        executionActive = false;
        termination.dispose();
      }
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
    resultSink = null,
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
  const action = {
    type: "TOOL_RESULT",
    call,
    ok: result.ok,
    status: result.status,
    result: safeResult,
    resultHash: `sha256:${createHash("sha256").update(fullSafeResult).digest("hex")}`,
    durationMs: result.durationMs,
    ...(Object.hasOwn(result, "effectiveTimeoutMs") ? { effectiveTimeoutMs: result.effectiveTimeoutMs } : {}),
    ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
    ...(artifact ? { artifact } : {}),
    ...(result.fileChanges ? { fileChanges: result.fileChanges } : {}),
    ...(result.sourceCursor !== undefined ? { sourceCursor: result.sourceCursor } : {}),
    ...(result.verification ? { verification: result.verification } : {}),
  };
  if (resultSink) await resultSink(action);
  else await session.dispatch(action);
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
    ...(definition.parallelRead === true ? { parallelRead: true } : {}),
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

async function beginTrackedChanges(definition, args, host, session) {
  if (!definition.changeTracking) return null;
  try {
    const paths = definition.changeTracking.arguments.flatMap((name) => {
      const value = args[name];
      if (!definition.changeTracking.pathField) return [value];
      return Array.isArray(value) ? value.map((item) => item?.[definition.changeTracking.pathField]) : [];
    });
    return await beginFileChangeCapture({
      workspace: session.state.workspace,
      mode: definition.changeTracking.mode,
      paths,
      authorizeRead: createInternalReadGuard({ registry: host.registry, policy: host.policy, session }),
    });
  } catch {
    return { unavailable: true };
  }
}

// Shared read boundary for harness-owned capture and verification. A write or
// Shell approval does not authorize extra reads, and this guard issues no grants.
export function createInternalReadGuard({ registry, policy, session }) {
  let readState = null;
  let readCursor = null;
  const readDefinition = {
    name: "read_file", adapter: "native", effects: ["read"], approval: "never", idempotency: "safe",
    capability: {
      readOnly: true, risk: "R0", effects: ["read"],
      resources: [{ kind: "workspace_path", argument: "path", access: "read" }],
    },
  };
  return (relativePath) => {
    // Resolve on every read, exactly as native path tools do. Avoid cloning a
    // long conversation for every file; a new durable cursor refreshes inputs.
    if (!readState || readCursor !== session.cursor || session.cursor === undefined) {
      const state = session.state;
      readCursor = session.cursor;
      readState = { id: state.id, workspace: state.workspace, permissionProfile: state.permissionProfile, toolGrants: [] };
    }
    const accessPolicy = registry.accessPolicies?.get(readState.permissionProfile)
      || registry.accessPolicy || policy.profile;
    if (typeof accessPolicy?.assertPath !== "function") return false;
    const pathDecision = accessPolicy.assertPath(relativePath, "read");
    if (pathDecision?.decision !== "allow") return false;
    const call = { id: "harness-internal-read", name: "read_file", arguments: { path: relativePath } };
    return policy.authorize({ definition: readDefinition, call, state: readState, argsHash: hashValue(call.arguments) }).decision === "allow";
  };
}

// Only the actual approved read_file invocation may use its consumed once grant.
// Capture/verification keep the grant-free internal guard above. This closure
// never restores a grant in Session state and cannot authorize another resource.
function createGrantedToolReadGuard({ host, session, definition, call, argsHash, authorization,
  permissionProfile, grantId, grantScope, isActive }) {
  const expectedResources = hashValue(authorization.resources);
  return (relativePath) => {
    if (!isActive()) return false;
    const state = session.state;
    if (state.permissionProfile !== permissionProfile || host.policy.version !== authorization.policyVersion) return false;
    const accessPolicy = host.registry.accessPolicies?.get(state.permissionProfile) || host.registry.accessPolicy || host.policy.profile;
    if (accessPolicy?.assertPath(relativePath, "read")?.decision !== "allow") return false;
    const grants = grantScope === "project"
      ? host.projectGrantStore?.list({ workspace: state.workspace }) || [] : state.toolGrants || [];
    const original = grants.find((grant) => grant.id === grantId);
    if (!original) return false;
    const grant = structuredClone(original);
    if (grantScope === "once") {
      if (!grant.consumedAt || grant.consumedByCallId !== call.id) return false;
      delete grant.consumedAt;
      delete grant.consumedByCallId;
    }
    const checkingCall = { ...call, arguments: { ...call.arguments, path: relativePath } };
    const checkingState = { ...state, toolGrants: grantScope === "project" ? [] : [grant] };
    const current = host.policy.authorize({ definition, call: checkingCall, state: checkingState, argsHash,
      projectGrants: grantScope === "project" ? [grant] : [] });
    return current.decision === "allow" && current.policyVersion === authorization.policyVersion
      && current.capabilityHash === authorization.capabilityHash && hashValue(current.resources) === expectedResources;
  };
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
          // The renderer redacts full file bodies and paths before composing
          // hunks. Re-redacting the mixed +/- transcript could corrupt counts.
          content: diff,
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
    return registration ? { tool: registration.value, registrationId: registration.registrationId, owner: registration.owner } : null;
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

function raceWithSignal(start, signal, { settleAfterAbortMs = 0, waitForSettlement = false } = {}) {
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
      if (waitForSettlement) return;
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

function isParallelReadDefinition(registration, definition) {
  return registration?.owner === "nexus:native-tools" && definition?.name === "read_file"
    && definition.parallelRead === true && definition.adapter === "native" && definition.approval === "never"
    && definition.idempotency === "safe" && definition.effects.length === 1 && definition.effects[0] === "read"
    && definition.capability.readOnly === true && !definition.changeTracking && definition.deadline.enforcement === "host";
}

class ReadAdmissionChangedError extends Error {
  constructor() {
    super("读取启动前权限或工具已变化，Adapter未启动。");
    this.name = "ReadAdmissionChangedError";
  }
}

function parallelAuthorization(value) {
  return value?.decision === "allow" && value.readOnly === true && !value.grantId && !value.grantScope;
}

function authorizationIdentity(value) {
  return { decision: value.decision, policyVersion: value.policyVersion ?? null,
    capabilityHash: value.capabilityHash ?? null, resources: structuredClone(value.resources || []),
    ruleId: value.ruleId ?? null, profile: value.profile ?? null, readOnly: value.readOnly };
}
