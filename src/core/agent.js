import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";
import { ToolHost } from "../tools/host.js";
import { ContextLifecycle } from "./context-lifecycle.js";

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
    memorySearchTimeoutMs = 2_000,
    memoryReconcileTimeoutMs = 2_000,
    contextSummaryTimeoutMs = 15_000,
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
      memorySearchTimeoutMs,
      contextSummaryTimeoutMs,
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

  async runTurn(content, requestApproval, { objective } = {}) {
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
    await this.dispatch({ type: "USER_MESSAGE", content, ...(objective ? { objective } : {}) });
    const turnSourceCursor = this.session.cursor;

    try {
      const contextTurn = await this.contextLifecycle.startTurn({
        query: content,
        signal: abortController.signal,
      });
      for (let index = 0; index < this.maxSteps; index += 1) {
        throwIfAborted(abortController.signal);
        const response = await contextTurn.completeModelStep();

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

        for (const call of response.toolCalls) {
          await this.toolHost.execute(call, {
            session: this.session,
            signal: abortController.signal,
            requestApproval,
          });
        }
      }
      throw new Error(`达到最大步骤数 ${this.maxSteps}，已停止本轮任务。`);
    } catch (error) {
      if (abortController.signal.aborted) {
        await this.dispatch({ type: "CANCELLED", reason: abortController.signal.reason?.message || "用户取消了任务" });
      } else {
        await this.dispatch({ type: "FAILED", error: redactSensitiveText(error.message) });
      }
      return this.state;
    } finally {
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
