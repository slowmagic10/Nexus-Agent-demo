import assert from "node:assert/strict";
import test from "node:test";
import { prepareModelRequest } from "../src/core/model-context.js";

test("预算充足时 Model Context 保持完整且不添加压缩标记", () => {
  const context = createContext([
    { role: "user", content: "第一轮" },
    { role: "assistant", content: "第一轮回答" },
    { role: "user", content: "第二轮" },
  ]);

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 1_000,
  });

  assert.deepEqual(request.messages, context.messages);
  assert.equal(request.systemPrompt, "系统提示");
  assert.equal(request.contextPlan.compacted, false);
  assert.equal(request.contextPlan.omittedMessages, 0);
  assert.ok(request.contextPlan.estimatedInputTokens <= request.contextPlan.maxInputTokens);
});

test("超预算时只保留连续的最近完整 turn，不拆散工具协议", () => {
  const toolCall = {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
  };
  const toolResult = { role: "tool", tool_call_id: "call-1", content: "结果" };
  const context = createContext([
    { role: "user", content: "A".repeat(1_200) },
    { role: "assistant", content: "旧回答" },
    { role: "user", content: "当前任务" },
    toolCall,
    toolResult,
  ]);

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 180,
  });

  assert.deepEqual(request.messages, [context.messages[2], toolCall, toolResult]);
  assert.match(request.systemPrompt, /Model Context 已压缩/);
  assert.deepEqual(request.contextPlan, {
    maxInputTokens: 180,
    estimatedInputTokens: request.contextPlan.estimatedInputTokens,
    fixedTokens: request.contextPlan.fixedTokens,
    messageTokens: request.contextPlan.messageTokens,
    includedMessages: 3,
    omittedMessages: 2,
    includedTurns: 1,
    omittedTurns: 1,
    compacted: true,
    strategy: "recent-complete-turns-v1",
    memoryHits: [],
    summary: {
      available: false,
      included: false,
      revision: null,
      throughMessage: 0,
      requiredThroughMessage: 2,
      sourceCursor: null,
      sourceComplete: null,
      omittedReason: null,
    },
  });
  assert.ok(request.contextPlan.estimatedInputTokens <= 180);
});

test("当前 turn 自身超过预算时明确失败而不是截断协议", () => {
  const context = createContext([{ role: "user", content: "B".repeat(2_000) }]);

  assert.throws(
    () => prepareModelRequest(context, {
      systemPrompt: () => "系统提示",
      tools: [],
      maxInputTokens: 100,
    }),
    /当前 turn.*超过 Model Context 预算 100/,
  );
});

test("system prompt 与工具 schema 固定成本超过预算时明确失败", () => {
  const context = createContext([{ role: "user", content: "任务" }]);

  assert.throws(
    () => prepareModelRequest(context, {
      systemPrompt: () => "S".repeat(2_000),
      tools: [{ type: "function", function: { name: "tool", description: "T".repeat(2_000) } }],
      maxInputTokens: 100,
    }),
    /固定上下文.*超过 Model Context 预算 100/,
  );
});

test("Context Window Plan 记录长期记忆命中来源但不复制正文", () => {
  const context = createContext([{ role: "user", content: "继续本地模型工作" }]);
  context.contextMemory = [{
    id: "memory-1",
    content: "用户偏好本地模型",
    adapter: "sqlite-lexical",
    score: 0.8,
    confidence: 0.95,
    scope: { workspace: "/repo", agentId: "default", userId: "local" },
    sourceSession: "session-source",
    sourceCursor: 12,
    sourceToolCall: "call-memory",
    version: 2,
  }];

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 1_000,
  });

  assert.deepEqual(request.contextPlan.memoryHits, [{
    id: "memory-1",
    adapter: "sqlite-lexical",
    score: 0.8,
    confidence: 0.95,
    scope: { workspace: "/repo", agentId: "default", userId: "local" },
    sourceSession: "session-source",
    sourceCursor: 12,
    sourceToolCall: "call-memory",
    version: 2,
  }]);
  assert.equal("content" in request.contextPlan.memoryHits[0], false);
});

test("覆盖范围完整的 durable semantic summary 与最近 turn 一起进入请求", () => {
  const context = createContext([
    { role: "user", content: "A".repeat(1_200) },
    { role: "assistant", content: "已经完成旧模块" },
    { role: "user", content: "继续当前任务" },
  ]);
  context.contextSummary = {
    summaryVersion: "semantic-summary-v1",
    revision: 1,
    objective: "继续开发 Nexus",
    completed: ["旧模块已经完成"],
    active: ["实现上下文摘要"],
    decisions: [],
    files: ["src/core/model-context.js"],
    blockers: [],
    nextMoves: ["运行测试"],
    throughMessage: 2,
    sourceCursor: 8,
    sourceComplete: true,
    model: "test",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 260,
  });

  assert.equal(request.messages[0].role, "assistant");
  assert.match(request.messages[0].content, /历史会话语义摘要/);
  assert.match(request.messages[0].content, /继续开发 Nexus/);
  assert.deepEqual(request.messages.at(-1), { role: "user", content: "继续当前任务" });
  assert.equal(request.contextPlan.strategy, "semantic-summary+recent-complete-turns-v1");
  assert.deepEqual(request.contextPlan.summary, {
    available: true,
    included: true,
    revision: 1,
    throughMessage: 2,
    requiredThroughMessage: 2,
    sourceCursor: 8,
    sourceComplete: true,
    omittedReason: null,
  });
});

function createContext(messages) {
  return {
    messages: structuredClone(messages),
    memory: [],
    contextMemory: [],
    contextSummary: null,
    loadedSkills: [],
  };
}
