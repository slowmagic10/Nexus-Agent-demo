import { setTimeout as delay } from "node:timers/promises";
import { contextOverflowInfo, providerRequestFailureInfo } from "../providers/errors.js";
import { assertContextBudget } from "../providers/request-policy.js";
import { redactSensitiveText } from "../security/redact.js";
import { RecoverableTaskError } from "./completion-guard.js";
import { noModelUsage, normalizeModelUsage } from "./model-usage.js";
import { readSessionState } from "./session-state-view.js";
import { dispatchSessionAction } from "./session-action.js";
import { prepareSessionContextSummary } from "./session-summary.js";
import {
  createModelContextSummarizer,
  ContextSummaryRequestBudgetError,
  normalizeSemanticSummary,
} from "./context-summary.js";

const DEFAULT_MAX_INPUT_TOKENS = 32_000;
const DEFAULT_MEMORY_SEARCH_TIMEOUT_MS = 2_000;
const DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL_RETRY_DELAYS_MS = Object.freeze([250, 1_000]);

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
    summaryMaxInputTokens,
    contextBudget = null,
    memorySearchTimeoutMs = DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
    contextSummaryTimeoutMs = DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS,
    modelRetryDelaysMs = DEFAULT_MODEL_RETRY_DELAYS_MS,
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
    if (!Array.isArray(modelRetryDelaysMs) || modelRetryDelaysMs.length !== 2
      || modelRetryDelaysMs.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 30_000)) {
      throw new Error("Context Lifecycle modelRetryDelaysMs 必须包含两个 0 到 30000 的整数");
    }

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
    this.contextBudget = contextBudget === null ? null : assertContextBudget(contextBudget);
    this.maxInputTokens = Math.min(maxInputTokens, this.contextBudget?.maxInputTokens ?? maxInputTokens);
    const summaryCapacity = this.contextBudget
      ? this.contextBudget.contextWindowTokens - this.contextBudget.reservedOutputTokens : null;
    if (summaryMaxInputTokens !== undefined) validatePositiveInteger(summaryMaxInputTokens, "summaryMaxInputTokens");
    this.summaryMaxInputTokens = Math.min(summaryMaxInputTokens ?? summaryCapacity ?? DEFAULT_MAX_INPUT_TOKENS,
      summaryCapacity ?? Number.MAX_SAFE_INTEGER);
    this.memorySearchTimeoutMs = memorySearchTimeoutMs;
    this.contextSummaryTimeoutMs = contextSummaryTimeoutMs;
    this.modelRetryDelaysMs = [...modelRetryDelaysMs];
  }

  async startTurn({ query, signal, assertCanRequest = () => {} } = {}) {
    if (typeof assertCanRequest !== "function") throw new Error("Context Lifecycle assertCanRequest 必须是函数");
    const turnSignal = signal || new AbortController().signal;
    await this.#retrieveMemory(String(query || ""), turnSignal);
    let effectiveMaxInputTokens = this.maxInputTokens;

    return Object.freeze({
      completeModelStep: async () => {
        const completion = await this.#completeModelStep(turnSignal, effectiveMaxInputTokens, assertCanRequest);
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
    await dispatchSessionAction(this.session, { type: "MEMORY_CONTEXT_SET", query, memories, retrieval });
  }

  async #completeModelStep(signal, maxInputTokens, assertCanRequest) {
    let prepared = this.#prepareRequest(maxInputTokens);
    prepared = await this.#prepareDurableSummary(prepared, signal, maxInputTokens, assertCanRequest);
    return this.#requestWithContextReplan(prepared, signal, assertCanRequest);
  }

  #prepareRequest(maxInputTokens) {
    const request = this.session.prepareModelRequest({
      systemPrompt: this.systemPrompt,
      tools: this.getTools(),
      maxInputTokens,
    });
    if (this.contextBudget) request.contextPlan.contextBudget = { ...this.contextBudget };
    return request;
  }

  async #prepareDurableSummary(prepared, turnSignal, maxInputTokens, assertCanRequest) {
    let current = prepared;
    const usesModel = this.summarizeContext.usesModel !== false;
    for (let attempt = 0; attempt < 2 && current.contextPlan.compacted; attempt += 1) {
      const plan = current.contextPlan.summary;
      const throughMessage = readSessionState(this.session, ["contextSummary"]).contextSummary?.throughMessage || 0;
      if (!plan || plan.included || plan.requiredThroughMessage <= throughMessage) break;
      turnSignal.throwIfAborted();
      if (usesModel) assertCanRequest();
      let source;
      try {
        source = prepareSessionContextSummary(this.session, {
          fromMessage: throughMessage, throughMessage: plan.requiredThroughMessage,
          usesModel, maxInputTokens: this.summaryMaxInputTokens,
        });
      } catch (error) {
        if (!(error instanceof ContextSummaryRequestBudgetError) || !Object.hasOwn(error, "sourceCursor")) throw error;
        turnSignal.throwIfAborted();
        assertCanRequest();
        await dispatchSessionAction(this.session, {
          type: "CONTEXT_SUMMARY_DEGRADED", fromMessage: throughMessage,
          throughMessage: plan.requiredThroughMessage, sourceCursor: error.sourceCursor, modelCall: false,
          ...noModelUsage(), durationMs: 0, error: error.message,
        });
        break;
      }
      const { batch, sourceCursor, sourceComplete } = source;
      turnSignal.throwIfAborted();
      if (usesModel) assertCanRequest();
      await dispatchSessionAction(this.session, {
        type: "CONTEXT_SUMMARY_REQUESTED",
        fromMessage: batch.fromMessage,
        throughMessage: batch.throughMessage,
        sourceCursor,
        modelCall: usesModel,
      });
      const summarySignal = AbortSignal.any([
        turnSignal,
        AbortSignal.timeout(this.contextSummaryTimeoutMs),
      ]);
      const started = performance.now();
      const summaryState = readSessionState(this.session, ["objective", "plan"]);
      const summaryInput = {
        // Source history and previous summary belong to the same pre-admission
        // snapshot. Observer updates to objective/plan remain visible below.
        previousSummary: source.previousSummary,
        messages: batch.messages,
        sourceComplete,
        fromMessage: batch.fromMessage,
        throughMessage: batch.throughMessage,
        objective: summaryState.objective,
        plan: summaryState.plan,
        signal: summarySignal,
      };
      const summaryRequest = usesModel ? { ...source.request, signal: summarySignal } : null;
      let admitted = false;
      let response;
      try {
        response = await raceWithSignal(Promise.resolve().then(() => {
          summarySignal.throwIfAborted();
          if (usesModel) assertCanRequest();
          admitted = true;
          return this.summarizeContext(summaryInput);
        }), summarySignal);
        const summary = normalizeSemanticSummary(response?.summary || response);
        const accounting = usesModel
          ? normalizeModelUsage(response?.usage, summaryRequest, response?.usageOutput || { text: JSON.stringify(summary) })
          : noModelUsage();
        await dispatchSessionAction(this.session, {
          type: "CONTEXT_SUMMARY_COMPLETED",
          summary,
          fromMessage: batch.fromMessage,
          throughMessage: batch.throughMessage,
          sourceCursor,
          sourceComplete,
          model: response?.model || this.provider.name || "unknown",
          modelCall: usesModel,
          ...accounting,
          durationMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        // Denied admission is a turn boundary, never a recoverable summary error.
        if (!admitted) throw error;
        let accounting = noModelUsage();
        if (usesModel) {
          const output = error?.usageOutput || response?.usageOutput || (response ? { text: JSON.stringify(response.summary || response) } : {});
          try {
            accounting = normalizeModelUsage(error?.usage ?? response?.usage, summaryRequest, output);
          } catch {
            // Malformed usage cannot turn an attempted model call into free work.
            accounting = normalizeModelUsage(null, summaryRequest, output);
          }
        }
        await dispatchSessionAction(this.session, {
          type: "CONTEXT_SUMMARY_DEGRADED",
          fromMessage: batch.fromMessage,
          throughMessage: batch.throughMessage,
          sourceCursor,
          modelCall: usesModel,
          ...accounting,
          durationMs: Math.round(performance.now() - started),
          error: redactSensitiveText(error?.message || "Context summary 失败"),
        });
        if (turnSignal.aborted) throw error;
        break;
      }
      current = this.#prepareRequest(maxInputTokens);
    }
    return current;
  }

  async #requestWithContextReplan(prepared, signal, assertCanRequest) {
    let current = prepared;
    let replanAttempts = 0;
    let retries = 0;
    // Two transport retries and one context replan share this model step. Neither
    // counter resets when the other recovery path runs (at most four requests).
    while (true) {
      signal.throwIfAborted();
      assertCanRequest();
      const { contextPlan, ...request } = current;
      await dispatchSessionAction(this.session, { type: "MODEL_CONTEXT_PREPARED", plan: contextPlan });
      await dispatchSessionAction(this.session, { type: "MODEL_REQUESTED" });
      signal.throwIfAborted();
      assertCanRequest();
      const started = performance.now();
      try {
        const response = await this.requestModel({ ...request, signal });
        const accounting = normalizeModelUsage(response.usage, request, response);
        await dispatchSessionAction(this.session, {
          type: "MODEL_COMPLETED",
          ...accounting,
          durationMs: Math.round(performance.now() - started),
          finishReason: response.finishReason || null,
        });
        return { response, maxInputTokens: contextPlan.maxInputTokens };
      } catch (error) {
        if (signal.aborted) throw error;
        const overflow = contextOverflowInfo(error);
        if (!overflow) {
          let failure = providerRequestFailureInfo(error);
          if (!failure) throw error;
          let failedUsage;
          try {
            failedUsage = failedRequestUsage(error, contextPlan, readSessionState(this.session, ["modelStreamChunks"]), failure.retryable);
          } catch {
            failure = { kind: "protocol_error", status: failure.status, code: "invalid_token_usage", retryable: false };
            failedUsage = { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, usageEstimated: true };
          }
          await dispatchSessionAction(this.session, {
            type: "MODEL_REQUEST_FAILED",
            contextHash: contextPlan.contextHash,
            failure,
            ...failedUsage,
            durationMs: Math.round(performance.now() - started),
          });
          if (readSessionState(this.session, ["modelStream"]).modelStream) {
            await dispatchSessionAction(this.session, { type: "MODEL_STREAM_DISCARDED", reason: failure.retryable ? "model_retry" : "model_failure" });
          }
          if (!failure.retryable) {
            throw new RecoverableTaskError(`模型请求失败（${describeFailure(failure)}）；已保留目标与计划，请修正接口配置或响应问题后继续。`, "model_request_failed");
          }
          if (retries >= this.modelRetryDelaysMs.length) {
            await dispatchSessionAction(this.session, { type: "MODEL_RETRY_EXHAUSTED", retries, failure, reason: "attempt_limit" });
            throw new RecoverableTaskError(`模型请求因暂时性故障失败（${describeFailure(failure)}），自动重试 ${retries} 次后仍失败；已保留目标与计划，可稍后继续。`, "model_retry_exhausted");
          }
          try {
            assertCanRequest();
          } catch (budgetError) {
            await dispatchSessionAction(this.session, { type: "MODEL_RETRY_EXHAUSTED", retries, failure, reason: "token_budget" });
            throw budgetError;
          }
          const delayMs = this.modelRetryDelaysMs[retries];
          retries += 1;
          await dispatchSessionAction(this.session, { type: "MODEL_RETRY_REQUESTED", attempt: retries, maxRetries: this.modelRetryDelaysMs.length, delayMs, failure });
          signal.throwIfAborted();
          await delay(delayMs, undefined, { signal });
          continue;
        }
        if (readSessionState(this.session, ["modelStream"]).modelStream) {
          await dispatchSessionAction(this.session, { type: "MODEL_STREAM_DISCARDED", reason: "context_replan" });
        }
        const durationMs = Math.round(performance.now() - started);
        const outputCannotFit = Number.isSafeInteger(overflow.contextLimit)
          && (this.contextBudget?.reservedOutputTokens || 0) >= overflow.contextLimit;
        if (replanAttempts > 0 || outputCannotFit) {
          await dispatchSessionAction(this.session, {
            type: "MODEL_CONTEXT_REPLAN_EXHAUSTED",
            contextHash: contextPlan.contextHash,
            maxInputTokens: contextPlan.maxInputTokens,
            durationMs,
            overflow,
          });
          throw new RecoverableTaskError(outputCannotFit
            ? "配置的模型输出额度已占满服务端声明的上下文容量；请调整输出上限或模型窗口后继续。"
            : "模型上下文在自动缩减并重试一次后仍然超限；请缩短当前消息或提高模型 Context Window", "context_replan_exhausted");
        }

        replanAttempts += 1;
        const nextMaxInputTokens = nextOverflowBudget(contextPlan, overflow, this.contextBudget?.reservedOutputTokens || 0);
        await dispatchSessionAction(this.session, {
          type: "MODEL_CONTEXT_REPLAN_REQUESTED",
          contextHash: contextPlan.contextHash,
          maxInputTokens: contextPlan.maxInputTokens,
          nextMaxInputTokens,
          durationMs,
          overflow,
        });
        const replanned = this.#prepareRequest(nextMaxInputTokens);
        await dispatchSessionAction(this.session, {
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
  }
}

function describeFailure(failure) {
  const detail = failure.code === "system_message_position" ? "system_message_position：system 消息必须位于对话开头" : failure.code;
  return `${failure.status ? `HTTP ${failure.status}，` : ""}${detail}`;
}

function failedRequestUsage(error, contextPlan, state, estimateInput) {
  const partialText = (state.modelStreamChunks || []).join("");
  const supplied = error.usage;
  if (supplied != null) {
    if (typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("Provider Token usage 必须是对象");
    for (const field of ["inputTokens", "prompt_tokens", "outputTokens", "completion_tokens", "totalTokens", "total_tokens"]) {
      if (supplied[field] !== undefined) assertTokenCount(supplied[field], field);
    }
  }
  const reportedTotal = supplied?.totalTokens ?? supplied?.total_tokens;
  if (reportedTotal !== undefined) {
    const reportedInput = supplied.inputTokens ?? supplied.prompt_tokens;
    const reportedOutput = supplied.outputTokens ?? supplied.completion_tokens;
    if ((reportedInput !== undefined && reportedInput > reportedTotal)
      || (reportedOutput !== undefined && reportedOutput > reportedTotal)
      || (reportedInput !== undefined && reportedOutput !== undefined && reportedInput + reportedOutput !== reportedTotal)) {
      throw new Error("Provider Token usage 分项与总量不一致");
    }
    const outputTokens = reportedOutput ?? (reportedInput !== undefined
      ? reportedTotal - reportedInput
      : Math.min(reportedTotal, Math.ceil(partialText.length / 4)));
    return {
      usage: { inputTokens: reportedTotal - outputTokens, outputTokens, totalTokens: reportedTotal },
      // A reported total plus either component determines the other exactly.
      usageEstimated: reportedInput === undefined && reportedOutput === undefined,
    };
  }
  if (supplied && (supplied.inputTokens !== undefined || supplied.prompt_tokens !== undefined
    || supplied.outputTokens !== undefined || supplied.completion_tokens !== undefined)) {
    const usage = normalizeFailedPartialUsage(supplied, [], partialText);
    const hasInput = supplied.inputTokens !== undefined || supplied.prompt_tokens !== undefined;
    const hasOutput = supplied.outputTokens !== undefined || supplied.completion_tokens !== undefined;
    if (!hasInput) usage.inputTokens = estimateInput ? contextPlan.estimatedInputTokens : 0;
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
    assertTokenCount(usage.totalTokens, "totalTokens");
    return { usage, usageEstimated: !hasInput || !hasOutput };
  }
  const inputTokens = estimateInput ? contextPlan.estimatedInputTokens : 0;
  const outputTokens = Math.ceil(partialText.length / 4);
  assertTokenCount(inputTokens, "inputTokens");
  return { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, usageEstimated: true };
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

// Retain the existing failure policy: a known rejected request may have zero
// input cost, while retryable requests account for possibly consumed input.
function normalizeFailedPartialUsage(usage, messages, text) {
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

function nextOverflowBudget(contextPlan, overflow, reservedOutputTokens = 0) {
  const providerInputLimit = Number.isSafeInteger(overflow.contextLimit)
    ? overflow.contextLimit - reservedOutputTokens : null;
  const candidates = [contextPlan.maxInputTokens, contextPlan.estimatedInputTokens, providerInputLimit]
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
