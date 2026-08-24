import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";
import { ToolHost } from "../tools/host.js";

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
    maxSteps = 8,
    maxTokensPerTurn = 50_000,
    maxInputTokens = 32_000,
    memorySearchTimeoutMs = 2_000,
    memoryReconcileTimeoutMs = 2_000,
  }) {
    if (!session) throw new Error("AgentRuntime 需要 AgentSession");
    if (!toolHost && !tools) throw new Error("AgentRuntime 需要 Tool Host");
    if (maxSteps !== Infinity && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
      throw new Error("AgentRuntime maxSteps 必须是正整数或 Infinity");
    }
    if (!Number.isSafeInteger(memorySearchTimeoutMs) || memorySearchTimeoutMs < 1) {
      throw new Error("AgentRuntime memorySearchTimeoutMs 必须是正整数");
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
    this.systemPrompt = systemPrompt;
    this.retrieveMemory = retrieveMemory;
    this.reconcile = reconcile;
    this.flushMemory = flushMemory;
    this.maxSteps = maxSteps;
    this.maxTokensPerTurn = maxTokensPerTurn;
    this.maxInputTokens = maxInputTokens;
    this.memorySearchTimeoutMs = memorySearchTimeoutMs;
    this.memoryReconcileTimeoutMs = memoryReconcileTimeoutMs;
    this.abortController = null;
  }

  get state() {
    return this.session.state;
  }

  dispatch(action) {
    return this.session.dispatch(action);
  }

  async runTurn(content, requestApproval) {
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
    await this.dispatch({ type: "USER_MESSAGE", content });
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
        const prepared = this.session.prepareModelRequest({
          systemPrompt: this.systemPrompt,
          tools: this.toolHost.schemas(),
          maxInputTokens: this.maxInputTokens,
        });
        const { contextPlan, ...request } = prepared;
        await this.dispatch({ type: "MODEL_CONTEXT_PREPARED", plan: contextPlan });
        await this.dispatch({ type: "MODEL_REQUESTED" });
        const modelStarted = performance.now();
        const response = await this.provider.complete({
          ...request,
          signal: abortController.signal,
        });
        const usage = normalizeUsage(response.usage, request.messages, response.text);
        await this.dispatch({ type: "MODEL_COMPLETED", usage, durationMs: Math.round(performance.now() - modelStarted) });
        if (this.state.metrics.totalTokens - tokenBaseline > this.maxTokensPerTurn) {
          throw new Error(`本轮 token 用量超过预算 ${this.maxTokensPerTurn}`);
        }

        const assistantMessage = {
          role: "assistant",
          content: response.text || "",
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
