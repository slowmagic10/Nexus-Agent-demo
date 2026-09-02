// Deterministic, side-effect-free adapters used only by the Scenario Evaluation Harness.

export class ScriptedProvider {
  constructor(responses) {
    this.name = "scripted-evaluation-provider";
    this.responses = structuredClone(responses);
    this.calls = 0;
    this.started = deferred();
  }

  async complete({ signal } = {}) {
    const index = this.calls;
    this.calls += 1;
    this.started.resolve({ index });
    const response = this.responses[index];
    if (!response) throw new Error(`Scripted Provider 没有第 ${index + 1} 个响应`);
    if (response.type === "wait_for_cancel") return await waitForCancellation(signal, "Provider");
    if (response.type === "error") throw new Error(response.error);
    return structuredClone({
      text: response.text,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason,
      usage: response.usage,
    });
  }

  inspect() {
    return { calls: this.calls };
  }
}

export class ScriptedToolAdapter {
  constructor(tools) {
    this.tools = new Map();
    this.calls = [];
    this.started = deferred();
    for (const configured of structuredClone(tools)) {
      const tool = {
        name: configured.name,
        description: configured.description,
        adapter: "scripted-evaluation",
        approval: configured.readOnly ? "never" : "always",
        effects: configured.effects,
        idempotency: configured.idempotency,
        capability: {
          risk: configured.risk,
          readOnly: configured.readOnly,
          resources: [{ kind: "session", access: configured.readOnly ? "read" : "write" }],
        },
        parameters: configured.parameters,
        execute: (argumentsValue, context) => this.#execute(configured, argumentsValue, context),
      };
      this.tools.set(tool.name, tool);
    }
    this.registry = Object.freeze({
      get: (name) => this.tools.get(name) || null,
      schemas: () => [...this.tools.values()].map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters),
        },
      })),
    });
  }

  inspect() {
    return { calls: structuredClone(this.calls) };
  }

  async #execute(tool, _argumentsValue, context) {
    const callIndex = this.calls.filter((call) => call.name === tool.name).length;
    const outcome = tool.outcomes[Math.min(callIndex, tool.outcomes.length - 1)];
    const call = { name: tool.name, outcome: outcome.type };
    this.calls.push(call);
    this.started.resolve({ name: tool.name, index: this.calls.length - 1 });
    if (outcome.type === "wait_for_cancel") {
      await waitForCancellation(context.signal, `工具 ${tool.name}`);
    }
    if (outcome.type === "failure") throw new Error(outcome.error);
    return outcome.result;
  }
}

function waitForCancellation(signal, label) {
  if (!signal) return Promise.reject(new Error(`${label} 缺少 AbortSignal`));
  if (signal.aborted) return Promise.reject(signal.reason || new Error("任务已取消"));
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason || new Error("任务已取消")), { once: true });
  });
}

function deferred() {
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
  };
}
