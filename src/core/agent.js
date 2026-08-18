import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";

export class AgentRuntime {
  constructor({
    session,
    provider,
    tools,
    systemPrompt,
    retrieveMemory = async () => [],
    maxSteps = 8,
    maxTokensPerTurn = 50_000,
    maxInputTokens = 32_000,
  }) {
    if (!session) throw new Error("AgentRuntime 需要 AgentSession");
    if (maxSteps !== Infinity && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
      throw new Error("AgentRuntime maxSteps 必须是正整数或 Infinity");
    }
    this.session = session;
    this.provider = provider;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.retrieveMemory = retrieveMemory;
    this.maxSteps = maxSteps;
    this.maxTokensPerTurn = maxTokensPerTurn;
    this.maxInputTokens = maxInputTokens;
    this.abortController = null;
  }

  get state() {
    return this.session.state;
  }

  dispatch(action) {
    return this.session.dispatch(action);
  }

  async runTurn(content, requestApproval) {
    if (["completed", "failed", "cancelled"].includes(this.state.phase)) await this.dispatch({ type: "READY" });
    const abortController = new AbortController();
    this.abortController = abortController;
    const tokenBaseline = this.state.metrics.totalTokens || 0;
    await this.dispatch({ type: "USER_MESSAGE", content });

    try {
      const memories = await this.retrieveMemory(content);
      await this.dispatch({ type: "MEMORY_CONTEXT_SET", query: content, memories });
      for (let index = 0; index < this.maxSteps; index += 1) {
        throwIfAborted(abortController.signal);
        const prepared = this.session.prepareModelRequest({
          systemPrompt: this.systemPrompt,
          tools: this.tools.schemas(),
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
          return this.state;
        }

        for (const call of response.toolCalls) {
          await this.dispatch({ type: "TOOL_REQUESTED", call });
          const tool = this.tools.get(call.name);
          let result;
          let ok = true;

          if (!tool) {
            ok = false;
            result = `未知工具：${call.name}`;
          } else {
            if (tool.approval === "always") {
              await this.dispatch({ type: "APPROVAL_REQUESTED", call });
              const approved = await requestApproval(call, tool.description, abortController.signal);
              throwIfAborted(abortController.signal);
              await this.dispatch({ type: "APPROVAL_DECIDED", call, approved });
              if (!approved) {
                await this.dispatch({ type: "TOOL_RESULT", call, ok: false, result: "用户拒绝了本次工具调用。" });
                continue;
              }
            }

            try {
              const toolStarted = performance.now();
              result = await tool.execute(call.arguments, {
                state: this.state,
                dispatch: (action) => this.dispatch(action),
                signal: abortController.signal,
              });
              await this.dispatch({
                type: "TOOL_RESULT",
                call,
                ok,
                result: redactSensitiveText(result),
                durationMs: Math.round(performance.now() - toolStarted),
              });
              continue;
            } catch (error) {
              if (abortController.signal.aborted) throw error;
              ok = false;
              result = `工具执行失败：${error.message}`;
            }
          }
          await this.dispatch({ type: "TOOL_RESULT", call, ok, result: redactSensitiveText(result), durationMs: 0 });
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
