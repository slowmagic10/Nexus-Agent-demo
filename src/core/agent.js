import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";
import { ToolHost } from "../tools/host.js";
import { ContextLifecycle } from "./context-lifecycle.js";
import { completionIssues, completionFeedback, MAX_COMPLETION_CORRECTIONS, RecoverableTaskError } from "./completion-guard.js";
import { resolveObjectiveMode, isObjectiveStatusQuestion } from "./objective-continuation.js";
import { refreshVerification } from "./verification.js";
import { ProgressMonitor } from "./progress-monitor.js";
import { ToolBatchError } from "../tools/batch.js";

export class AgentRuntime {
  constructor({
    session,
    provider,
    tools,
    toolHost,
    systemPrompt,
    retrieveMemory = async () => [],
    reconcile = async () => [],
    flushMemory = async () => [],
    summarizeContext,
    contextLifecycle,
    maxSteps = Infinity,
    maxTokensPerTurn = Infinity,
    maxInputTokens = 32_000,
    contextBudget = null,
    memorySearchTimeoutMs = 2_000,
    memoryReconcileTimeoutMs = 2_000,
    contextSummaryTimeoutMs = 15_000,
    modelRetryDelaysMs,
  }) {
    if (!session) throw new Error("AgentRuntime 需要 AgentSession");
    if (!toolHost && !tools) throw new Error("AgentRuntime 需要 Tool Host");
    if (maxSteps !== Infinity && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
      throw new Error("AgentRuntime maxSteps 必须是正整数或 Infinity");
    }
    if (maxTokensPerTurn !== Infinity && (!Number.isSafeInteger(maxTokensPerTurn) || maxTokensPerTurn < 1)) {
      throw new Error("AgentRuntime maxTokensPerTurn 必须是正整数或 Infinity");
    }
    if (!Number.isSafeInteger(memoryReconcileTimeoutMs) || memoryReconcileTimeoutMs < 1) {
      throw new Error("AgentRuntime memoryReconcileTimeoutMs 必须是正整数");
    }
    this.session = session;
    this.provider = provider;
    this.toolHost = toolHost || new ToolHost({
      registry: {
        schemas: () => tools.schemas(),
        get: (name) => tools.get?.(name) || null,
        ...(typeof tools.resolve === "function" ? { resolve: (name) => tools.resolve(name) } : {}),
        ...(typeof tools.acquire === "function" ? { acquire: (name, id) => tools.acquire(name, id) } : {}),
        ...(typeof tools.refreshVerification === "function" ? { refreshVerification: (context) => tools.refreshVerification(context) } : {}),
        ...(tools.accessPolicy ? { accessPolicy: tools.accessPolicy } : {}),
        ...(tools.accessPolicies ? { accessPolicies: tools.accessPolicies } : {}),
      },
    });
    if (typeof this.toolHost.schemas !== "function" || typeof this.toolHost.execute !== "function") {
      throw new Error("AgentRuntime Tool Host Interface 无效");
    }
    this.reconcile = reconcile;
    this.flushMemory = flushMemory;
    this.maxSteps = maxSteps;
    this.maxTokensPerTurn = maxTokensPerTurn;
    this.memoryReconcileTimeoutMs = memoryReconcileTimeoutMs;
    this.abortController = null;
    this.contextLifecycle = contextLifecycle || new ContextLifecycle({
      session,
      provider,
      systemPrompt,
      getTools: () => this.toolHost.schemas({ session: this.session }),
      requestModel: (request) => this.#completeProvider(request),
      retrieveMemory,
      summarizeContext,
      maxInputTokens,
      contextBudget,
      memorySearchTimeoutMs,
      contextSummaryTimeoutMs,
      modelRetryDelaysMs,
    });
    if (typeof this.contextLifecycle.startTurn !== "function") {
      throw new Error("AgentRuntime Context Lifecycle Interface 无效");
    }
  }

  get state() {
    return this.session.state;
  }

  dispatch(action) {
    return this.session.dispatch(action);
  }

  async runTurn(content, requestApproval, { objective, objectiveMode } = {}) {
    const resolvedObjectiveMode = resolveObjectiveMode(this.state, content, { objective, objectiveMode });
    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      const reconcileSignal = AbortSignal.any([
        abortController.signal,
        AbortSignal.timeout(this.memoryReconcileTimeoutMs),
      ]);
      await raceWithSignal(this.reconcile({ signal: reconcileSignal }), reconcileSignal);
    } catch (error) {
      if (abortController.signal.aborted) {
        await this.dispatch({ type: "CANCELLED", reason: abortController.signal.reason?.message || "用户取消了任务" });
        if (this.abortController === abortController) this.abortController = null;
        return this.state;
      }
      await this.dispatch({
        type: "MEMORY_RECONCILIATION_DEGRADED",
        error: redactSensitiveText(error.message),
      });
    }
    if (["completed", "failed", "cancelled"].includes(this.state.phase)) await this.dispatch({ type: "READY" });
    const tokenBaseline = this.state.metrics.totalTokens || 0;
    await this.dispatch({
      type: "USER_MESSAGE",
      content,
      objectiveMode: resolvedObjectiveMode,
      ...(resolvedObjectiveMode === "continue" && isObjectiveStatusQuestion(content) ? { preserveBlockedReason: true } : {}),
      ...(objective ? { objective } : {}),
    });
    const turnSourceCursor = this.session.cursor;
    let completionCorrections = 0;
    const progressMonitor = new ProgressMonitor();
    const stopObservingProgress = this.session.subscribeEvents((event) => {
      for (const projected of event.patch?.append?.events || []) progressMonitor.observe(projected);
    }, { after: turnSourceCursor });

    try {
      const contextTurn = await this.contextLifecycle.startTurn({
        query: content,
        signal: abortController.signal,
        assertCanRequest: () => {
          if (this.state.metrics.totalTokens - tokenBaseline >= this.maxTokensPerTurn) {
            throw new RecoverableTaskError(`本轮累计 Token 用量已达到预算 ${this.maxTokensPerTurn}；不能追加模型请求，已保留目标与计划。`, "model_token_budget");
          }
        },
      });
      for (let index = 0; index < this.maxSteps; index += 1) {
        throwIfAborted(abortController.signal);
        const response = await contextTurn.completeModelStep();
        throwIfAborted(abortController.signal);

        const assistantMessage = {
          role: "assistant",
          content: redactSensitiveText(response.text || ""),
          ...(response.providerItems?.length ? {
            provider_items: redactSensitiveValue(response.providerItems),
          } : {}),
          ...(response.toolCalls.length ? {
            tool_calls: response.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(redactSensitiveValue(call.arguments)) },
            })),
          } : {}),
        };
        await this.dispatch({ type: "ASSISTANT_MESSAGE", message: assistantMessage });
        assertNormalModelFinish(response);

        if (!response.toolCalls.length) {
          throwIfAborted(abortController.signal);
          if (this.state.plan?.blockedReason) {
            throw new RecoverableTaskError(`任务存在阻塞：${this.state.plan.blockedReason}`, "objective_blocked");
          }
          if (this.state.plan?.acceptance?.length) {
            const context = { session: this.session, signal: abortController.signal };
            if (typeof this.toolHost.refreshVerification === "function") await this.toolHost.refreshVerification(context);
            else await refreshVerification(context);
            throwIfAborted(abortController.signal);
          }
          const reasons = completionIssues(this.state, response.text);
          if (reasons.length) {
            if (completionCorrections >= MAX_COMPLETION_CORRECTIONS) {
              throw new RecoverableTaskError(`模型提前结束，自动纠正 ${MAX_COMPLETION_CORRECTIONS} 次后仍未满足完成条件；已保留目标与计划，可继续任务。`, "completion_validation_exhausted");
            }
            if (this.state.metrics.totalTokens - tokenBaseline >= this.maxTokensPerTurn) {
              throw new RecoverableTaskError(`本轮累计 Token 用量已达到预算 ${this.maxTokensPerTurn}；无法追加完成纠正请求，任务尚未完成。`, "completion_token_budget");
            }
            if (index + 1 >= this.maxSteps) {
              throw new RecoverableTaskError(`达到最大步骤数 ${this.maxSteps}；任务未通过完成检查，已保留目标与计划。`, "completion_step_budget");
            }
            completionCorrections += 1;
            await this.dispatch({
              type: "COMPLETION_REJECTED",
              attempt: completionCorrections,
              reasons,
              message: completionFeedback(reasons, completionCorrections),
            });
            continue;
          }
          await this.dispatch({ type: "COMPLETED" });
          try {
            await this.flushMemory({
              session: this.session,
              messages: currentTurnMessages(this.state.messages),
              sourceCursor: turnSourceCursor,
              signal: abortController.signal,
            });
          } catch (error) {
            await this.dispatch({
              type: "MEMORY_FLUSH_DEGRADED",
              sourceCursor: turnSourceCursor,
              error: redactSensitiveText(error.message),
            });
          }
          return this.state;
        }

        if (this.state.metrics.totalTokens - tokenBaseline > this.maxTokensPerTurn) {
          throw new Error(`本轮累计 Token 用量超过预算 ${this.maxTokensPerTurn}；尚未执行最新工具调用。可通过 NEXUS_MAX_TOKENS_PER_TURN 或 --max-tokens-per-turn 调整`);
        }

        const toolContext = { session: this.session, signal: abortController.signal, requestApproval };
        if (typeof this.toolHost.executeBatch === "function") await this.toolHost.executeBatch(response.toolCalls, toolContext);
        else for (const call of response.toolCalls) await this.toolHost.execute(call, toolContext);
        throwIfAborted(abortController.signal);
        // Finish the entire assistant tool batch before adding any feedback;
        // never split the Provider's assistant/tool protocol with a system message.
        const intervention = progressMonitor.takeIntervention();
        if (intervention) await this.dispatch(intervention);
      }
      throw new Error(`达到最大步骤数 ${this.maxSteps}，已停止本轮任务。`);
    } catch (error) {
      if (abortController.signal.aborted) {
        await this.dispatch({ type: "CANCELLED", reason: abortController.signal.reason?.message || "用户取消了任务",
          ...(error instanceof ToolBatchError ? { toolBatchFailure: true } : {}) });
      } else {
        await this.dispatch({
          type: "FAILED",
          error: redactSensitiveText(error.message),
          ...(error instanceof RecoverableTaskError ? { recoverable: true, reason: error.reason } : {}),
          ...(error instanceof ToolBatchError ? { recoverable: true, reason: "tool_batch_failed", toolBatchFailure: true } : {}),
        });
      }
      return this.state;
    } finally {
      stopObservingProgress();
      if (this.abortController === abortController) this.abortController = null;
    }
  }

  cancel(reason = "用户取消了任务") {
    this.abortController?.abort(new Error(reason));
  }

  async #completeProvider(request) {
    if (typeof this.provider.stream !== "function") return this.provider.complete(request);

    await this.dispatch({ type: "MODEL_STREAM_STARTED" });
    const buffer = new DurableModelStreamBuffer();
    let completed = null;
    try {
      for await (const event of this.provider.stream(request)) {
        if (event?.type === "text_delta") {
          const delta = buffer.push(event.delta);
          if (delta) await this.dispatch({ type: "MODEL_STREAM_DELTA", delta });
          continue;
        }
        if (event?.type === "completed") {
          completed = event.response;
          break;
        }
        throw new Error(`模型 Provider 返回未知流事件：${event?.type || "unknown"}`);
      }
    } catch (error) {
      const tail = buffer.flush();
      if (tail) await this.dispatch({ type: "MODEL_STREAM_DELTA", delta: tail });
      throw error;
    }

    const tail = buffer.flush();
    if (tail) await this.dispatch({ type: "MODEL_STREAM_DELTA", delta: tail });
    if (!completed || typeof completed !== "object") throw new Error("模型输出流没有返回 completed 事件");
    completed = {
      ...completed,
      text: String(completed.text || ""),
      toolCalls: Array.isArray(completed.toolCalls) ? completed.toolCalls : [],
    };
    await this.dispatch({ type: "MODEL_STREAM_COMPLETED" });
    return completed;
  }
}

class DurableModelStreamBuffer {
  constructor() {
    this.pending = "";
  }

  push(value) {
    this.pending += String(value || "");
    let boundary = -1;
    for (const match of this.pending.matchAll(/[\n。！？；]/g)) boundary = match.index;
    if (boundary < 0) return "";
    const stable = this.pending.slice(0, boundary + 1);
    this.pending = this.pending.slice(boundary + 1);
    return redactSensitiveText(stable);
  }

  flush() {
    if (!this.pending) return "";
    const value = redactSensitiveText(this.pending);
    this.pending = "";
    return value;
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason || new Error("任务已取消");
}

function raceWithSignal(operation, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("任务已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function currentTurnMessages(messages) {
  const start = messages.findLastIndex((message) => message.role === "user");
  return structuredClone(start < 0 ? messages : messages.slice(start));
}

function assertNormalModelFinish(response) {
  const finishReason = response?.finishReason;
  if (finishReason == null || finishReason === "stop") return;
  if (finishReason === "tool_calls" && response.toolCalls?.length) return;
  const normalized = String(finishReason).slice(0, 120);
  throw new Error(`模型输出未正常完成（finishReason=${normalized}）；已保留部分回答，但任务未标记为完成。`);
}
