import assert from "node:assert/strict";
import test from "node:test";
import { contextObservabilityViewModel } from "../src/web/context-view.js";

test("Context 可观测性投影只返回预算、来源数量和摘要元数据", () => {
  const view = contextObservabilityViewModel({
    contextSummary: { revision: 3, throughMessage: 12, sourceComplete: true, objective: "不应进入 ViewModel" },
    events: [{
      seq: 20,
      at: "2026-08-31T10:00:00.000Z",
      type: "model.context_compacted",
      contextHash: `sha256:${"a".repeat(64)}`,
      contextHashVersion: "model-request-sha256-v1",
      estimatorVersion: "utf8-bytes-div3-v1",
      maxInputTokens: 1_000,
      estimatedInputTokens: 820,
      fixedTokens: 200,
      messageTokens: 620,
      includedMessages: 8,
      omittedMessages: 4,
      includedTurns: 3,
      omittedTurns: 2,
      compacted: true,
      strategy: "semantic-summary+recent-complete-turns-v1",
      historyProjection: {
        version: "historical-tool-transcript-v1",
        applied: true,
        eligibleTurns: 3,
        compactedToolCalls: 2,
        compactedToolResults: 4,
        savedChars: 12_000,
        savedTokens: 3_750,
      },
      activeToolProjection: {
        version: "active-tool-transcript-v1",
        applied: true,
        eligibleRounds: 3,
        preservedRounds: 2,
        compactedRounds: 3,
        compactedToolCalls: 5,
        compactedToolResults: 5,
        savedChars: 6_000,
        savedTokens: 2_000,
      },
      pinnedMemoryHits: [{ id: "pinned-1", content: "不应复制正文" }],
      memoryHits: [{ id: "relevant-1" }, { id: "relevant-2" }],
      memoryBudget: {
        estimatorVersion: "utf8-bytes-div3-v1",
        pinned: { maxTokens: 1_200, estimatedTokens: 90, included: 1, truncated: 0 },
        relevant: { maxTokens: 2_000, estimatedTokens: 170, included: 2, truncated: 1 },
      },
      summary: {
        available: true,
        included: true,
        revision: 3,
        throughMessage: 12,
        requiredThroughMessage: 12,
        sourceComplete: true,
        omittedReason: null,
      },
    }],
  });

  assert.equal(view.plan.statusLabel, "已压缩");
  assert.equal(view.plan.strategyLabel, "语义摘要 + 最近轮次");
  assert.deepEqual(view.usage, {
    estimatedTokens: 820,
    maxTokens: 1_000,
    overTarget: false,
    percent: 82,
    meterPercent: 82,
    level: "warning",
    fixedTokens: 200,
    messageTokens: 620,
  });
  assert.deepEqual(view.memory.pinned, { included: 1, estimatedTokens: 90, maxTokens: 1_200, truncated: 0 });
  assert.deepEqual(view.memory.relevant, { included: 2, estimatedTokens: 170, maxTokens: 2_000, truncated: 1 });
  assert.deepEqual(view.history.toolProjection, {
    version: "historical-tool-transcript-v1",
    applied: true,
    eligibleTurns: 3,
    compactedToolCalls: 2,
    compactedToolResults: 4,
    savedChars: 12_000,
    savedTokens: 3_750,
  });
  assert.deepEqual(view.history.activeToolProjection, {
    version: "active-tool-transcript-v1",
    applied: true,
    eligibleRounds: 3,
    preservedRounds: 2,
    compactedRounds: 3,
    compactedToolCalls: 5,
    compactedToolResults: 5,
    savedChars: 6_000,
    savedTokens: 2_000,
  });
  assert.equal(view.summary.statusLabel, "已纳入本次请求");
  assert.equal(view.identity.contextHashShort, "aaaaaaaaaaaa");
  assert.equal(JSON.stringify(view).includes("不应"), false);
});

test("超过本地估算目标时提示继续交由 Provider，而不是任务停止", () => {
  const view = contextObservabilityViewModel({
    events: [{
      seq: 1,
      type: "model.context_prepared",
      compacted: false,
      maxInputTokens: 32_000,
      estimatedInputTokens: 33_500,
      estimatedOverTarget: true,
    }],
  });

  assert.equal(view.plan.statusLabel, "超过估算目标，已继续");
  assert.equal(view.usage.overTarget, true);
  assert.equal(view.usage.percent, 105);
  assert.equal(view.usage.meterPercent, 100);
});

test("Context 可观测性解释重规划耗尽和摘要降级", () => {
  const view = contextObservabilityViewModel({
    events: [
      { seq: 1, type: "context.summary_degraded", error: "敏感错误正文不应投影" },
      {
        seq: 2,
        type: "model.context_compacted",
        contextHash: "sha256:current",
        maxInputTokens: 800,
        estimatedInputTokens: 790,
        compacted: true,
        summary: { available: false, included: false },
      },
      {
        seq: 3,
        type: "context.replan_exhausted",
        contextHash: "sha256:current",
        maxInputTokens: 800,
        overflow: { contextLimit: 768 },
      },
    ],
  });

  assert.equal(view.summary.statusLabel, "生成降级");
  assert.deepEqual(view.replan, {
    status: "exhausted",
    statusLabel: "自动缩减后仍超限",
    level: "danger",
    maxInputTokens: 800,
    contextLimit: 768,
  });
  assert.equal(JSON.stringify(view).includes("敏感错误正文"), false);
});

test("没有 Context 规划或摘要时不显示空观察卡", () => {
  assert.equal(contextObservabilityViewModel({ events: [] }), null);
});

test("未触发窗口裁剪时单独解释历史工具投影", () => {
  const view = contextObservabilityViewModel({
    events: [{
      seq: 1,
      type: "model.context_prepared",
      compacted: false,
      maxInputTokens: 32_000,
      estimatedInputTokens: 4_000,
      historyProjection: {
        version: "historical-tool-transcript-v1",
        applied: true,
        eligibleTurns: 2,
        compactedToolCalls: 1,
        compactedToolResults: 1,
        savedChars: 9_001,
      },
    }],
  });

  assert.equal(view.plan.statusLabel, "工具历史已精简");
  assert.equal(view.plan.compacted, false);
  assert.equal(view.history.toolProjection.savedTokens, 3_001);
});

test("未触发窗口裁剪时单独解释活动工具轮投影", () => {
  const view = contextObservabilityViewModel({
    events: [{
      seq: 1,
      type: "model.context_prepared",
      compacted: false,
      maxInputTokens: 32_000,
      estimatedInputTokens: 8_000,
      activeToolProjection: {
        version: "active-tool-transcript-v1",
        applied: true,
        eligibleRounds: 4,
        preservedRounds: 2,
        compactedRounds: 4,
        compactedToolCalls: 7,
        compactedToolResults: 7,
        savedChars: 12_003,
      },
    }],
  });

  assert.equal(view.plan.statusLabel, "活动工具轮已精简");
  assert.equal(view.history.activeToolProjection.savedTokens, 4_001);
});

test("旧计划缺少 Context Hash 时不会关联更早的重规划事件", () => {
  const view = contextObservabilityViewModel({
    events: [
      { seq: 1, type: "context.replan_exhausted", maxInputTokens: 100 },
      { seq: 2, type: "model.context_prepared", maxInputTokens: 200, estimatedInputTokens: 20 },
    ],
  });
  assert.equal(view.replan, null);
});

test("旧轮次摘要降级不会污染最新正常 Context Plan", () => {
  const view = contextObservabilityViewModel({
    contextSummary: { revision: 2, throughMessage: 8, sourceComplete: true },
    events: [
      { seq: 1, type: "context.summary_degraded", fromMessage: 8, throughMessage: 10 },
      {
        seq: 2,
        type: "model.context_compacted",
        summary: { available: true, included: true, revision: 2, throughMessage: 8 },
      },
      {
        seq: 3,
        type: "model.context_prepared",
        maxInputTokens: 1_000,
        estimatedInputTokens: 200,
        summary: { available: true, included: false, revision: 2, throughMessage: 8 },
      },
    ],
  });

  assert.equal(view.summary.degraded, false);
  assert.equal(view.summary.statusLabel, "已保存，本次未纳入");
});
