import { contextOverflowInfo } from "../providers/errors.js";
import { redactSensitiveText } from "../security/redact.js";
import {
  createModelContextSummarizer,
  normalizeSemanticSummary,
  selectContextSummaryBatch,
} from "./context-summary.js";

const DEFAULT_MAX_INPUT_TOKENS = 32_000;
const DEFAULT_MEMORY_SEARCH_TIMEOUT_MS = 2_000;
const DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS = 15_000;

// Deep Module for the complete lifecycle of model-visible context within one turn.
export class ContextLifecycle {
  constructor({
    session,
    provider,
    systemPrompt,
    getTools,
    requestModel,
    retrieveMemory = async () => [],
    summarizeContext,
    maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
    memorySearchTimeoutMs = DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
    contextSummaryTimeoutMs = DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS,
  } = {}) {
    if (!session || typeof session.prepareModelRequest !== "function" || typeof session.dispatch !== "function") {
      throw new Error("Context Lifecycle 需要 Agent Session");
    }
    if (!provider || typeof provider.complete !== "function") {
      throw new Error("Context Lifecycle 需要模型 Provider");
    }
    if (typeof getTools !== "function") throw new Error("Context Lifecycle getTools 必须是函数");
    if (typeof requestModel !== "function") throw new Error("Context Lifecycle requestModel 必须是函数");
    if (typeof retrieveMemory !== "function") throw new Error("Context Lifecycle retrieveMemory 必须是函数");
    validatePositiveInteger(maxInputTokens, "maxInputTokens");
    validatePositiveInteger(memorySearchTimeoutMs, "memorySearchTimeoutMs");
    validatePositiveInteger(contextSummaryTimeoutMs, "contextSummaryTimeoutMs");

    this.session = session;
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.getTools = getTools;
    this.requestModel = requestModel;
    this.retrieveMemory = retrieveMemory;
    this.summarizeContext = summarizeContext || createModelContextSummarizer(provider);
    if (typeof this.summarizeContext !== "function") {
      throw new Error("Context Lifecycle summarizeContext 必须是函数");
    }
    this.maxInputTokens = maxInputTokens;
    this.memorySearchTimeoutMs = memorySearchTimeoutMs;
    this.contextSummaryTimeoutMs = contextSummaryTimeoutMs;
  }

  async startTurn({ query, signal } = {}) {
    const turnSignal = signal || new AbortController().signal;
    await this.#retrieveMemory(String(query || ""), turnSignal);
    let effectiveMaxInputTokens = this.maxInputTokens;

    return Object.freeze({
      completeModelStep: async () => {
        const completion = await this.#completeModelStep(turnSignal, effectiveMaxInputTokens);
        effectiveMaxInputTokens = completion.maxInputTokens;
        return completion.response;
      },
    });
  }

  async #retrieveMemory(query, turnSignal) {
    let memories = [];
    let retrieval = { status: "ok" };
    try {
      const memorySignal = AbortSignal.any([
        turnSignal,
        AbortSignal.timeout(this.memorySearchTimeoutMs),
      ]);
      memories = await raceWithSignal(
        Promise.resolve().then(() => this.retrieveMemory(query, { signal: memorySignal })),
        memorySignal,
      );
      if (!Array.isArray(memories)) throw new Error("Memory Adapter search 必须返回数组");
    } catch (error) {
      retrieval = { status: "degraded", error: redactSensitiveText(error?.message || "Memory retrieval 失败") };
    }
    await this.session.dispatch({ type: "MEMORY_CONTEXT_SET", query, memories, retrieval });
  }

  async #completeModelStep(signal, maxInputTokens) {
    let prepared = this.#prepareRequest(maxInputTokens);
    prepared = await this.#prepareDurableSummary(prepared, signal, maxInputTokens);
    return this.#requestWithContextReplan(prepared, signal);
  }

  #prepareRequest(maxInputTokens) {
    return this.session.prepareModelRequest({
      systemPrompt: this.systemPrompt,
      tools: this.getTools(),
      maxInputTokens,
    });
  }

  async #prepareDurableSummary(prepared, turnSignal, maxInputTokens) {
    let current = prepared;
    for (let attempt = 0; attempt < 2 && current.contextPlan.compacted; attempt += 1) {
      const plan = current.contextPlan.summary;
      const throughMessage = this.session.state.contextSummary?.throughMessage || 0;
      if (!plan || plan.included || plan.requiredThroughMessage <= throughMessage) break;
      const batch = selectContextSummaryBatch(this.session.state.messages, {
        fromMessage: throughMessage,
        throughMessage: plan.requiredThroughMessage,
      });
      const sourceCursor = this.session.cursor;
      await this.session.dispatch({
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
          previousSummary: this.session.state.contextSummary,
          messages: batch.messages,
          fromMessage: batch.fromMessage,
          throughMessage: batch.throughMessage,
          objective: this.session.state.objective,
          plan: this.session.state.plan,
          signal: summarySignal,
        })), summarySignal);
        const summary = normalizeSemanticSummary(response?.summary || response);
        const usage = normalizeUsage(response?.usage, batch.messages, JSON.stringify(summary));
        await this.session.dispatch({
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
        await this.session.dispatch({
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
      current = this.#prepareRequest(maxInputTokens);
    }
    return current;
  }

  async #requestWithContextReplan(prepared, signal) {
    let current = prepared;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { contextPlan, ...request } = current;
      await this.session.dispatch({ type: "MODEL_CONTEXT_PREPARED", plan: contextPlan });
      await this.session.dispatch({ type: "MODEL_REQUESTED" });
      const started = performance.now();
      try {
        const response = await this.requestModel({ ...request, signal });
        const usage = normalizeUsage(response.usage, request.messages, response.text);
        await this.session.dispatch({
          type: "MODEL_COMPLETED",
          usage,
          durationMs: Math.round(performance.now() - started),
          finishReason: response.finishReason || null,
        });
        return { response, maxInputTokens: contextPlan.maxInputTokens };
      } catch (error) {
        if (signal.aborted) throw error;
        const overflow = contextOverflowInfo(error);
        if (!overflow) throw error;
        if (this.session.state.modelStream) {
          await this.session.dispatch({ type: "MODEL_STREAM_DISCARDED", reason: "context_replan" });
        }
        const durationMs = Math.round(performance.now() - started);
        if (attempt > 0) {
          await this.session.dispatch({
            type: "MODEL_CONTEXT_REPLAN_EXHAUSTED",
            contextHash: contextPlan.contextHash,
            maxInputTokens: contextPlan.maxInputTokens,
            durationMs,
            overflow,
          });
          throw new Error("模型上下文在自动缩减并重试一次后仍然超限；请缩短当前消息或提高模型 Context Window");
        }

        const nextMaxInputTokens = nextOverflowBudget(contextPlan, overflow);
        await this.session.dispatch({
          type: "MODEL_CONTEXT_REPLAN_REQUESTED",
          contextHash: contextPlan.contextHash,
          maxInputTokens: contextPlan.maxInputTokens,
          nextMaxInputTokens,
          durationMs,
          overflow,
        });
        const replanned = this.#prepareRequest(nextMaxInputTokens);
        await this.session.dispatch({
          type: "MODEL_CONTEXT_REPLANNED",
          fromContextHash: contextPlan.contextHash,
          toContextHash: replanned.contextPlan.contextHash,
          fromMaxInputTokens: contextPlan.maxInputTokens,
          toMaxInputTokens: replanned.contextPlan.maxInputTokens,
          omittedMessages: replanned.contextPlan.omittedMessages,
          omittedTurns: replanned.contextPlan.omittedTurns,
          strategy: replanned.contextPlan.strategy,
          summaryIncluded: replanned.contextPlan.summary.included,
        });
        current = replanned;
      }
    }
    throw new Error("模型上下文自动重规划未能完成");
  }
}

function validatePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Context Lifecycle ${label} 必须是正整数`);
  }
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

function normalizeUsage(usage, messages, text) {
  const estimatedInputTokens = Math.ceil(JSON.stringify(messages).length / 4);
  const estimatedOutputTokens = Math.ceil(String(text || "").length / 4);
  if (usage) {
    const reportedInput = usage.inputTokens ?? usage.prompt_tokens;
    const reportedOutput = usage.outputTokens ?? usage.completion_tokens;
    if (reportedInput !== undefined || reportedOutput !== undefined) {
      const inputTokens = reportedInput ?? estimatedInputTokens;
      const outputTokens = reportedOutput ?? estimatedOutputTokens;
      assertTokenCount(inputTokens, "inputTokens");
      assertTokenCount(outputTokens, "outputTokens");
      const totalTokens = inputTokens + outputTokens;
      assertTokenCount(totalTokens, "totalTokens");
      return { inputTokens, outputTokens, totalTokens };
    }
  }
  return {
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    totalTokens: estimatedInputTokens + estimatedOutputTokens,
  };
}

function assertTokenCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Provider Token usage ${field} 必须是非负安全整数`);
  }
}

function nextOverflowBudget(contextPlan, overflow) {
  const candidates = [contextPlan.maxInputTokens, contextPlan.estimatedInputTokens, overflow.contextLimit]
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const baseline = Math.min(...candidates);
  const next = Math.min(
    contextPlan.maxInputTokens - 1,
    contextPlan.estimatedInputTokens - 1,
    Math.floor(baseline * 0.7),
  );
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new Error("模型上下文已经无法继续缩减；请缩短当前消息或提高模型 Context Window");
  }
  return next;
}
