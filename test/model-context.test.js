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
  assert.match(request.contextPlan.contextHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(request.contextPlan.contextHashVersion, "model-request-sha256-v1");
  assert.equal(request.contextPlan.estimatorVersion, "utf8-bytes-div3-v1");
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
    contextHash: request.contextPlan.contextHash,
    contextHashVersion: "model-request-sha256-v1",
    estimatorVersion: "utf8-bytes-div3-v1",
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
    historyProjection: {
      version: "historical-tool-transcript-v1",
      applied: false,
      eligibleTurns: 0,
      compactedToolCalls: 0,
      compactedToolResults: 0,
      originalChars: 0,
      projectedChars: 0,
      savedChars: 0,
      originalTokens: 0,
      projectedTokens: 0,
      savedTokens: 0,
    },
    activeToolProjection: {
      version: "active-tool-transcript-v1",
      applied: false,
      eligibleRounds: 0,
      preservedRounds: 1,
      compactedRounds: 0,
      compactedToolCalls: 0,
      compactedToolResults: 0,
      originalChars: 0,
      projectedChars: 0,
      savedChars: 0,
      originalTokens: 0,
      projectedTokens: 0,
      savedTokens: 0,
    },
    memoryHits: [],
    pinnedMemoryHits: [],
    memoryBudget: {
      estimatorVersion: null,
      pinned: { maxTokens: null, estimatedTokens: 0, included: 0, truncated: 0 },
      relevant: { maxTokens: null, estimatedTokens: 0, included: 0, truncated: 0 },
    },
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

test("Context Hash 对等价请求保持稳定并随模型可见内容变化", () => {
  const context = createContext([{ role: "user", content: "检查上下文身份" }]);
  const options = {
    systemPrompt: () => "系统提示",
    tools: [{ function: { description: "读取文件", name: "read_file" }, type: "function" }],
    maxInputTokens: 1_000,
  };

  const first = prepareModelRequest(context, options);
  const equivalent = prepareModelRequest(structuredClone(context), {
    ...options,
    tools: [{ type: "function", function: { name: "read_file", description: "读取文件" } }],
  });
  const changedMessage = prepareModelRequest(
    createContext([{ role: "user", content: "检查另一个上下文身份" }]),
    options,
  );
  const changedPrompt = prepareModelRequest(context, { ...options, systemPrompt: () => "新的系统提示" });

  assert.equal(first.contextPlan.contextHash, equivalent.contextPlan.contextHash);
  assert.notEqual(first.contextPlan.contextHash, changedMessage.contextPlan.contextHash);
  assert.notEqual(first.contextPlan.contextHash, changedPrompt.contextPlan.contextHash);
});

test("已完成历史轮次的大型工具参数和结果使用有界投影，durable 消息保持完整", () => {
  const argumentsText = JSON.stringify({ path: "src/large.js", content: "A".repeat(4_000) });
  const resultText = `文件内容：${"R".repeat(6_000)}`;
  const historicalCall = {
    role: "assistant",
    content: "准备写入",
    tool_calls: [{
      id: "call-history",
      type: "function",
      function: { name: "write_file", arguments: argumentsText },
    }],
  };
  const historicalResult = { role: "tool", tool_call_id: "call-history", content: resultText };
  const context = createContext([
    { role: "user", content: "旧任务" },
    historicalCall,
    historicalResult,
    { role: "assistant", content: "旧任务已完成" },
    { role: "user", content: "继续新任务" },
  ]);
  const durableSnapshot = structuredClone(context.messages);

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 10_000,
  });

  assert.deepEqual(context.messages, durableSnapshot);
  assert.equal(request.messages.length, durableSnapshot.length);
  assert.equal(request.messages[1].role, "assistant");
  assert.equal("tool_calls" in request.messages[1], false);
  assert.match(request.messages[1].content, /write_file:/);
  assert.match(request.messages[1].content, /完整参数见 durable journal/);
  assert.equal(request.messages[2].role, "assistant");
  assert.equal("tool_call_id" in request.messages[2], false);
  assert.match(request.messages[2].content, /历史 write_file 结果/);
  assert.match(request.messages[2].content, /完整内容见 durable journal/);
  assert.deepEqual(request.messages.at(-1), durableSnapshot.at(-1));
  const originalChars = JSON.stringify(durableSnapshot.slice(0, 4)).length;
  const projectedChars = JSON.stringify(request.messages.slice(0, 4)).length;
  const originalTokens = estimateMessages(durableSnapshot.slice(0, 4));
  const projectedTokens = estimateMessages(request.messages.slice(0, 4));
  assert.deepEqual(request.contextPlan.historyProjection, {
    version: "historical-tool-transcript-v1",
    applied: true,
    eligibleTurns: 1,
    compactedToolCalls: 1,
    compactedToolResults: 1,
    originalChars,
    projectedChars,
    savedChars: originalChars - projectedChars,
    originalTokens,
    projectedTokens,
    savedTokens: originalTokens - projectedTokens,
  });
});

test("历史 turn 含不透明 Provider 状态时同样保持完整工具协议", () => {
  const context = createContext([
    { role: "user", content: "旧思考任务" },
    {
      role: "assistant",
      content: "读取旧文件",
      provider_items: [{ type: "reasoning_content", content: "先检查历史文件" }],
      tool_calls: [{
        id: "opaque-history",
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"old.js\"}" },
      }],
    },
    { role: "tool", tool_call_id: "opaque-history", content: "旧结果".repeat(2_000) },
    { role: "assistant", content: "旧任务完成" },
    { role: "user", content: "开始新任务" },
  ]);
  const durableSnapshot = structuredClone(context.messages);

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 10_000,
  });

  assert.deepEqual(request.messages, durableSnapshot);
  assert.equal(request.contextPlan.historyProjection.applied, false);
  assert.equal(request.contextPlan.historyProjection.eligibleTurns, 1);
  assert.equal(request.contextPlan.historyProjection.compactedToolCalls, 0);
});

test("当前轮次保持逐字完整，旧工具协议只有实际省 Token 时才投影", () => {
  const currentArguments = JSON.stringify({ command: "X".repeat(3_000) });
  const context = createContext([
    { role: "user", content: "旧任务" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "old-call", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } }],
    },
    { role: "tool", tool_call_id: "old-call", content: "短结果" },
    { role: "assistant", content: "旧任务完成" },
    { role: "user", content: "当前任务" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "current-call", type: "function", function: { name: "run_shell", arguments: currentArguments } }],
    },
    { role: "tool", tool_call_id: "current-call", content: "Y".repeat(5_000) },
  ]);

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 10_000,
  });

  assert.deepEqual(request.messages.slice(4), context.messages.slice(4));
  assert.deepEqual(request.messages.slice(0, 4), context.messages.slice(0, 4));
  assert.equal(request.contextPlan.historyProjection.applied, false);
  assert.equal(request.contextPlan.historyProjection.eligibleTurns, 1);
});

test("活动 turn 只精简较早工具轮并逐字保留最近两个完整工具轮", () => {
  const toolRound = (id, fill) => [
    {
      role: "assistant",
      content: `执行 ${id}`,
      tool_calls: [{
        id,
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: `${id}.js`, note: fill.repeat(2_000) }) },
      }],
    },
    { role: "tool", tool_call_id: id, content: fill.repeat(4_000) },
  ];
  const context = createContext([
    { role: "user", content: "完成一个长任务" },
    ...toolRound("call-one", "A"),
    ...toolRound("call-two", "B"),
    ...toolRound("call-three", "C"),
    ...toolRound("call-four", "D"),
  ]);
  const durableSnapshot = structuredClone(context.messages);

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 20_000,
  });

  assert.deepEqual(context.messages, durableSnapshot);
  for (const index of [1, 2, 3, 4]) {
    assert.equal(request.messages[index].role, "assistant");
    assert.equal("tool_calls" in request.messages[index], false);
    assert.equal("tool_call_id" in request.messages[index], false);
  }
  assert.deepEqual(request.messages.slice(5), durableSnapshot.slice(5));
  assert.equal(request.contextPlan.activeToolProjection.applied, true);
  assert.equal(request.contextPlan.activeToolProjection.eligibleRounds, 2);
  assert.equal(request.contextPlan.activeToolProjection.preservedRounds, 2);
  assert.equal(request.contextPlan.activeToolProjection.compactedRounds, 2);
  assert.equal(request.contextPlan.activeToolProjection.compactedToolCalls, 2);
  assert.equal(request.contextPlan.activeToolProjection.compactedToolResults, 2);
  assert.ok(request.contextPlan.activeToolProjection.savedTokens > 0);
});

test("活动 turn 含不透明 Provider 状态时保持完整工具协议而不做转录投影", () => {
  const toolRound = (id, withProviderState = false) => [
    {
      role: "assistant",
      content: `执行 ${id}`,
      ...(withProviderState ? {
        provider_items: [{ type: "reasoning_content", content: `思考 ${id}` }],
      } : {}),
      tool_calls: [{
        id,
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: `${id}.js` }) },
      }],
    },
    { role: "tool", tool_call_id: id, content: "结果".repeat(2_000) },
  ];
  const context = createContext([
    { role: "user", content: "完成思考模式的长任务" },
    ...toolRound("call-one", true),
    ...toolRound("call-two"),
    ...toolRound("call-three", true),
  ]);
  const durableSnapshot = structuredClone(context.messages);

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 20_000,
  });

  assert.deepEqual(request.messages, durableSnapshot);
  assert.equal(request.contextPlan.activeToolProjection.applied, false);
  assert.equal(request.contextPlan.activeToolProjection.eligibleRounds, 1);
  assert.equal(request.contextPlan.activeToolProjection.preservedRounds, 2);
  assert.equal(request.contextPlan.activeToolProjection.compactedRounds, 0);
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

test("Context Window Plan 分开记录 Pinned 与 Relevant Memory 预算来源", () => {
  const context = createContext([{ role: "user", content: "继续任务" }]);
  context.contextMemory = [
    {
      id: "pinned-1",
      content: "固定项目约束",
      pinned: true,
      contextRetrievalClass: "pinned",
      contextEstimatedTokens: 40,
      contextBudgetTokens: 1_200,
      contextEstimatorVersion: "utf8-bytes-div3-v1",
      contextTruncated: false,
    },
    {
      id: "relevant-1",
      content: "本轮相关事实",
      pinned: false,
      contextRetrievalClass: "relevant",
      contextEstimatedTokens: 35,
      contextBudgetTokens: 2_000,
      contextEstimatorVersion: "utf8-bytes-div3-v1",
      contextTruncated: true,
    },
  ];

  const request = prepareModelRequest(context, {
    systemPrompt: () => "系统提示",
    tools: [],
    maxInputTokens: 1_000,
  });

  assert.deepEqual(request.contextPlan.pinnedMemoryHits.map((item) => item.id), ["pinned-1"]);
  assert.deepEqual(request.contextPlan.memoryHits.map((item) => item.id), ["relevant-1"]);
  assert.equal("content" in request.contextPlan.pinnedMemoryHits[0], false);
  assert.deepEqual(request.contextPlan.memoryBudget, {
    estimatorVersion: "utf8-bytes-div3-v1",
    pinned: { maxTokens: 1_200, estimatedTokens: 40, included: 1, truncated: 0 },
    relevant: { maxTokens: 2_000, estimatedTokens: 35, included: 1, truncated: 1 },
  });
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

function estimateMessages(messages) {
  return messages.reduce((total, message) => (
    total + Math.max(1, Math.ceil(new TextEncoder().encode(JSON.stringify(message)).length / 3)) + 4
  ), 0);
}
