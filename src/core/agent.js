import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";
import { ToolHost } from "../tools/host.js";
import {
  createModelContextSummarizer,
  normalizeSemanticSummary,
  selectContextSummaryBatch,
} from "./context-summary.js";

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
    if (!Number.isSafeInteger(memorySearchTimeoutMs) || memorySearchTimeoutMs < 1) {
      throw new Error("AgentRuntime memorySearchTimeoutMs 必须是正整数");
    }
    if (!Number.isSafeInteger(memoryReconcileTimeoutMs) || memoryReconcileTimeoutMs < 1) {
      throw new Error("AgentRuntime memoryReconcileTimeoutMs 必须是正整数");
    }
    if (!Number.isSafeInteger(contextSummaryTimeoutMs) || contextSummaryTimeoutMs < 1) {
      throw new Error("AgentRuntime contextSummaryTimeoutMs 必须是正整数");
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
    this.systemPrompt = systemPrompt;
    this.retrieveMemory = retrieveMemory;
    this.reconcile = reconcile;
    this.flushMemory = flushMemory;
    this.summarizeContext = summarizeContext || createModelContextSummarizer(provider);
    if (typeof this.summarizeContext !== "function") throw new Error("AgentRuntime summarizeContext 必须是函数");
    this.maxSteps = maxSteps;
    this.maxTokensPerTurn = maxTokensPerTurn;
    this.maxInputTokens = maxInputTokens;
    this.memorySearchTimeoutMs = memorySearchTimeoutMs;
    this.memoryReconcileTimeoutMs = memoryReconcileTimeoutMs;
    this.contextSummaryTimeoutMs = contextSummaryTimeoutMs;
    this.abortController = null;
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
      let memories = [];
      let retrieval = { status: "ok" };
      try {
        const memorySignal = AbortSignal.any([
          abortController.signal,
          AbortSignal.timeout(this.memorySearchTimeoutMs),
        ]);
        memories = await this.retrieveMemory(content, { signal: memorySignal });
        if (!Array.isArray(memories)) throw new Error("Memory Adapter search 必须返回数组");
      } catch (error) {
        retrieval = { status: "degraded", error: redactSensitiveText(error.message) };
      }
      await this.dispatch({ type: "MEMORY_CONTEXT_SET", query: content, memories, retrieval });
      for (let index = 0; index < this.maxSteps; index += 1) {
        throwIfAborted(abortController.signal);
        let prepared = this.session.prepareModelRequest({
          systemPrompt: this.systemPrompt,
          tools: this.toolHost.schemas({ session: this.session }),
          maxInputTokens: this.maxInputTokens,
        });
        prepared = await this.#prepareDurableSummary(prepared, abortController.signal);
        const { contextPlan, ...request } = prepared;
        await this.dispatch({ type: "MODEL_CONTEXT_PREPARED", plan: contextPlan });
        await this.dispatch({ type: "MODEL_REQUESTED" });
        const modelStarted = performance.now();
        const response = await this.provider.complete({
          ...request,
          signal: abortController.signal,
        });
        const usage = normalizeUsage(response.usage, request.messages, response.text);
        await this.dispatch({
          type: "MODEL_COMPLETED",
          usage,
          durationMs: Math.round(performance.now() - modelStarted),
          finishReason: response.finishReason || null,
        });

        const assistantMessage = {
          role: "assistant",
          content: redactSensitiveText(response.text || ""),
          ...(response.toolCalls.length ? {
            tool_calls: response.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(redactSensitiveValue(call.arguments)) },
            })),
          } : {}),
        };
        await this.dispatch({ type: "ASSISTANT_MESSAGE", message: assistantMessage });

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

  async #prepareDurableSummary(prepared, turnSignal) {
    let current = prepared;
    for (let attempt = 0; attempt < 2 && current.contextPlan.compacted; attempt += 1) {
      const plan = current.contextPlan.summary;
      const throughMessage = this.state.contextSummary?.throughMessage || 0;
      if (!plan || plan.included || plan.requiredThroughMessage <= throughMessage) break;
      const batch = selectContextSummaryBatch(this.state.messages, {
        fromMessage: throughMessage,
        throughMessage: plan.requiredThroughMessage,
      });
      const sourceCursor = this.session.cursor;
      await this.dispatch({
        type: "CONTEXT_SUMMARY_REQUESTED",
        fromMessage: batch.fromMessage,
        throughMessage: batch.throughMessage,
        sourceCursor,
        modelCall: this.summarizeContext.usesModel !== false,
      });
      const summarySignal = AbortSignal.any([
        turnSignal,
        AbortSignal.timeout(this.contextSummaryTimeoutMs),
      ]);
      const started = performance.now();
      try {
        const response = await raceWithSignal(Promise.resolve().then(() => this.summarizeContext({
          previousSummary: this.state.contextSummary,
          messages: batch.messages,
          fromMessage: batch.fromMessage,
          throughMessage: batch.throughMessage,
          objective: this.state.objective,
          plan: this.state.plan,
          signal: summarySignal,
        })), summarySignal);
        const summary = normalizeSemanticSummary(response?.summary || response);
        const usage = normalizeUsage(response?.usage, batch.messages, JSON.stringify(summary));
        await this.dispatch({
          type: "CONTEXT_SUMMARY_COMPLETED",
          summary,
          fromMessage: batch.fromMessage,
          throughMessage: batch.throughMessage,
          sourceCursor,
          sourceComplete: batch.sourceComplete,
          model: response?.model || this.provider.name || "unknown",
          usage,
          durationMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        if (turnSignal.aborted) throw error;
        await this.dispatch({
          type: "CONTEXT_SUMMARY_DEGRADED",
          fromMessage: batch.fromMessage,
          throughMessage: batch.throughMessage,
          sourceCursor,
          usage: normalizeUsage(error?.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, batch.messages, ""),
          durationMs: Math.round(performance.now() - started),
          error: redactSensitiveText(error?.message || "Context summary 失败"),
        });
        break;
      }
      current = this.session.prepareModelRequest({
        systemPrompt: this.systemPrompt,
        tools: this.toolHost.schemas({ session: this.session }),
        maxInputTokens: this.maxInputTokens,
      });
    }
    return current;
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason || new Error("任务已取消");
}

function raceWithSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error("任务已取消"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("任务已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function normalizeUsage(usage, messages, text) {
  if (usage) {
    const inputTokens = usage.inputTokens ?? usage.prompt_tokens ?? 0;
    const outputTokens = usage.outputTokens ?? usage.completion_tokens ?? 0;
    return { inputTokens, outputTokens, totalTokens: usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens };
  }
  const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
  const outputTokens = Math.ceil(String(text || "").length / 4);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function currentTurnMessages(messages) {
  const start = messages.findLastIndex((message) => message.role === "user");
  return structuredClone(start < 0 ? messages : messages.slice(start));
}
