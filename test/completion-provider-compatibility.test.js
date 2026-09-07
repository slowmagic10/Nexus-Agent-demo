import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { prepareModelRequest } from "../src/core/model-context.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createToolRegistry } from "../src/tools/registry.js";

const captured = JSON.parse(await readFile(new URL("./fixtures/completion-system-position.json", import.meta.url), "utf8"));
const finalPlan = [{ step: "输出交付说明", status: "completed" }];

function strictProvider(next) {
  const requests = [];
  const provider = new OpenAICompatibleProvider({
    apiKey: "offline-fixture",
    baseUrl: "http://offline.invalid/v1",
    model: "system-first-model",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (body.messages.slice(1).some((message) => message.role === "system")) {
        return new Response(JSON.stringify({ error: { message: "System message must be at the beginning." } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: next(body, requests.length), finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { provider, requests };
}

for (const mode of ["complete", "stream"]) {
  test(`捕获的 seq5350 纠正在真实 Provider ${mode} wire 中只有首部 system`, async () => {
    const context = {
      messages: [
        { role: "user", content: "跑完了吗" },
        { role: "assistant", content: "全部验证通过，交付说明已输出。" },
        { role: "system", runtime_feedback: "completion", content: captured.feedback },
      ],
    };
    const snapshot = structuredClone(context);
    const request = prepareModelRequest(context, { systemPrompt: "完成用户任务。", tools: [], maxInputTokens: 10000 });
    const { provider, requests } = strictProvider(() => ({ content: "继续更新计划" }));
    if (mode === "complete") await provider.complete(request);
    else for await (const _event of provider.stream(request)) { /* consume */ }
    const wire = requests[0].messages;
    assert.deepEqual(wire.flatMap((message, index) => message.role === "system" ? [index] : []), [0]);
    assert.equal(wire[0].content.split(captured.feedback).length - 1, 1);
    assert.equal(request.contextPlan.includedMessages, context.messages.length);
    assert.deepEqual(context, snapshot);
  });
}

test("完成检查通过真实 Provider 自动继续并更新计划，无需第二条用户消息", async () => {
  const { provider, requests } = strictProvider((_body, attempt) => {
    if (attempt === 1) return {
      content: "安排交付步骤",
      tool_calls: [{ id: "plan", type: "function", function: { name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "输出交付说明", status: "in_progress" }] }) } }],
    };
    if (attempt === 2) return { content: "项目已交付，验证通过。" };
    if (attempt === 3) return {
      content: "更新已完成的交付步骤",
      tool_calls: [{ id: "close-plan", type: "function", function: { name: "update_plan", arguments: JSON.stringify({ plan: finalPlan }) } }],
    };
    assert.equal(attempt, 4);
    return { content: "已完成，计划与验证一致。" };
  });
  const session = new AgentSession({ state: createSession({ provider: provider.name, workspace: "/tmp" }), reducer: reduceSession });
  const runtime = new AgentRuntime({
    session,
    provider,
    tools: createToolRegistry({ workspace: "/tmp" }),
    systemPrompt: "完成原始任务。",
  });
  await runtime.runTurn("直接开发并验证到完成", async () => true);
  assert.equal(session.state.phase, "completed");
  assert.equal(requests.length, 4);
  assert.deepEqual(session.state.plan.steps, finalPlan);
  assert.equal(session.state.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(session.state.messages.filter((message) => message.runtime_feedback === "completion").length, 1);
  assert.equal(session.state.events.filter((event) => event.type === "session.completion_rejected").length, 1);
});
