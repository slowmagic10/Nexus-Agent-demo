import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";

export class AgentRuntime {
  constructor({ state, reducer, provider, tools, systemPrompt, retrieveMemory = async () => [], maxSteps = 8, maxTokensPerTurn = 50_000, onState = () => {} }) {
    this.state = state;
    this.reducer = reducer;
    this.provider = provider;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.retrieveMemory = retrieveMemory;
    this.maxSteps = maxSteps;
    this.maxTokensPerTurn = maxTokensPerTurn;
    this.onState = onState;
    this.abortController = null;
  }

  dispatch(action) {
    this.state = this.reducer(this.state, action);
    this.onState(this.state);
  }

  async runTurn(content, requestApproval) {
    if (["completed", "failed", "cancelled"].includes(this.state.phase)) this.dispatch({ type: "READY" });
    const abortController = new AbortController();
    this.abortController = abortController;
    const tokenBaseline = this.state.metrics.totalTokens || 0;
    this.dispatch({ type: "USER_MESSAGE", content });

    try {
      const memories = await this.retrieveMemory(content);
      this.dispatch({ type: "MEMORY_CONTEXT_SET", query: content, memories });
      for (let index = 0; index < this.maxSteps; index += 1) {
        throwIfAborted(abortController.signal);
        this.dispatch({ type: "MODEL_REQUESTED" });
        const modelStarted = performance.now();
        const response = await this.provider.complete({
          systemPrompt: this.systemPrompt(this.state),
          messages: this.state.messages,
          tools: this.tools.schemas(),
          signal: abortController.signal,
        });
        const usage = normalizeUsage(response.usage, this.state.messages, response.text);
        this.dispatch({ type: "MODEL_COMPLETED", usage, durationMs: Math.round(performance.now() - modelStarted) });
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
        this.dispatch({ type: "ASSISTANT_MESSAGE", message: assistantMessage });

        if (!response.toolCalls.length) {
          this.dispatch({ type: "COMPLETED" });
          return this.state;
        }

        for (const call of response.toolCalls) {
          this.dispatch({ type: "TOOL_REQUESTED", call });
          const tool = this.tools.get(call.name);
          let result;
          let ok = true;

          if (!tool) {
            ok = false;
            result = `未知工具：${call.name}`;
          } else {
            if (tool.approval === "always") {
              this.dispatch({ type: "APPROVAL_REQUESTED", call });
              const approved = await requestApproval(call, tool.description, abortController.signal);
              throwIfAborted(abortController.signal);
              this.dispatch({ type: "APPROVAL_DECIDED", call, approved });
              if (!approved) {
                this.dispatch({ type: "TOOL_RESULT", call, ok: false, result: "用户拒绝了本次工具调用。" });
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
              this.dispatch({
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
          this.dispatch({ type: "TOOL_RESULT", call, ok, result: redactSensitiveText(result), durationMs: 0 });
        }
      }
      throw new Error(`达到最大步骤数 ${this.maxSteps}，已停止本轮任务。`);
    } catch (error) {
      if (abortController.signal.aborted) {
        this.dispatch({ type: "CANCELLED", reason: abortController.signal.reason?.message || "用户取消了任务" });
      } else {
        this.dispatch({ type: "FAILED", error: redactSensitiveText(error.message) });
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
