export class AgentRuntime {
  constructor({ state, reducer, provider, tools, systemPrompt, maxSteps = 8, onState = () => {} }) {
    this.state = state;
    this.reducer = reducer;
    this.provider = provider;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.maxSteps = maxSteps;
    this.onState = onState;
  }

  dispatch(action) {
    this.state = this.reducer(this.state, action);
    this.onState(this.state);
  }

  async runTurn(content, requestApproval) {
    if (["completed", "failed"].includes(this.state.phase)) this.dispatch({ type: "READY" });
    this.dispatch({ type: "USER_MESSAGE", content });

    try {
      for (let index = 0; index < this.maxSteps; index += 1) {
        this.dispatch({ type: "MODEL_REQUESTED" });
        const response = await this.provider.complete({
          systemPrompt: this.systemPrompt(this.state),
          messages: this.state.messages,
          tools: this.tools.schemas(),
        });

        const assistantMessage = {
          role: "assistant",
          content: response.text || "",
          ...(response.toolCalls.length ? {
            tool_calls: response.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
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
              const approved = await requestApproval(call, tool.description);
              this.dispatch({ type: "APPROVAL_DECIDED", call, approved });
              if (!approved) {
                this.dispatch({ type: "TOOL_RESULT", call, ok: false, result: "用户拒绝了本次工具调用。" });
                continue;
              }
            }

            try {
              result = await tool.execute(call.arguments, {
                state: this.state,
                dispatch: (action) => this.dispatch(action),
              });
            } catch (error) {
              ok = false;
              result = `工具执行失败：${error.message}`;
            }
          }
          this.dispatch({ type: "TOOL_RESULT", call, ok, result: String(result) });
        }
      }
      throw new Error(`达到最大步骤数 ${this.maxSteps}，已停止本轮任务。`);
    } catch (error) {
      this.dispatch({ type: "FAILED", error: error.message });
      return this.state;
    }
  }
}
