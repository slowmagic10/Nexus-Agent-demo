import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSession, SESSION_EVALUATION_VERSION } from "../src/evaluation/session-evaluation.js";

test("Session Evaluation 从 durable 状态生成确定性健康报告", () => {
  const state = fixtureState({
    phase: "completed",
    objective: { status: "completed" },
    plan: { revision: 2, steps: [{ status: "completed" }, { status: "completed" }] },
    metrics: { modelCalls: 2, toolCalls: 1, totalTokens: 120, lastTurnDurationMs: 500 },
    events: [
      {
        seq: 1,
        type: "model.context_prepared",
        estimatedInputTokens: 800,
        maxInputTokens: 1_000,
        contextHash: "sha256:abc",
        historyProjection: { applied: true, savedTokens: 320 },
        activeToolProjection: { applied: true, savedTokens: 640 },
      },
      { seq: 2, type: "tool.requested", tool: "read_file", args: { token: "不应进入报告" } },
      { seq: 3, type: "tool.completed", tool: "read_file", ok: true },
      { seq: 4, type: "memory.context_loaded", status: "ok", pinnedCount: 1, relevantCount: 2 },
      { seq: 5, type: "session.turn_completed" },
    ],
  });

  const first = evaluateSession(state);
  const second = evaluateSession(structuredClone(state));
  assert.deepEqual(first, second);
  assert.equal(first.version, SESSION_EVALUATION_VERSION);
  assert.equal(first.status, "healthy");
  assert.deepEqual(first.tools, {
    requested: 1,
    completed: 1,
    succeeded: 1,
    failed: 0,
    executionUnknown: 0,
    validationFailed: 0,
    capabilityUnavailable: 0,
    successRate: 100,
  });
  assert.equal(first.context.maxUtilizationPercent, 80);
  assert.equal(first.context.historyProjected, 1);
  assert.equal(first.context.historySavedTokens, 320);
  assert.equal(first.context.latestHistorySavedTokens, 320);
  assert.equal(first.context.activeToolProjected, 1);
  assert.equal(first.context.activeToolSavedTokens, 640);
  assert.equal(first.context.latestActiveToolSavedTokens, 640);
  assert.deepEqual(first.memory, {
    retrievals: 1,
    retrievalDegraded: 0,
    pinnedHits: 1,
    relevantHits: 2,
    flushCompleted: 0,
    flushDegraded: 0,
    mutationIssues: 0,
  });
  assert.deepEqual(first.issues, []);
  assert.equal(JSON.stringify(first).includes("不应进入报告"), false);
});

test("Session Evaluation 将未知执行和 Context 耗尽提升为高优先级问题", () => {
  const report = evaluateSession(fixtureState({
    phase: "failed",
    objective: { status: "failed" },
    lastError: "私密 Provider 错误不应进入报告",
    events: [
      { seq: 1, type: "tool.requested", tool: "run_shell" },
      { seq: 2, type: "tool.execution_unknown", tool: "run_shell", reason: "敏感原因" },
      { seq: 3, type: "context.replan_exhausted", overflow: { message: "敏感响应" } },
      { seq: 4, type: "context.summary_degraded", error: "敏感摘要错误" },
      { seq: 5, type: "session.failed", error: "敏感失败" },
    ],
  }));

  assert.equal(report.status, "failed");
  assert.deepEqual(report.issues.map((issue) => [issue.code, issue.severity]), [
    ["context_replan_exhausted", "high"],
    ["execution_unknown", "high"],
    ["session_failed", "high"],
    ["summary_degraded", "low"],
  ]);
  assert.equal(JSON.stringify(report).includes("敏感"), false);
});

test("Session Evaluation 对未闭合 Objective 和无工具会话给出可解释状态", () => {
  const report = evaluateSession(fixtureState({
    phase: "idle",
    objective: { status: "paused" },
    events: [{ seq: 1, type: "session.resumed" }],
  }));
  assert.equal(report.status, "attention");
  assert.equal(report.tools.successRate, null);
  assert.deepEqual(report.issues.map((issue) => issue.code), ["objective_incomplete"]);
});

test("Gateway 恢复到 idle 后仍按 durable Objective 保留任务终态", () => {
  assert.equal(evaluateSession(fixtureState({
    phase: "idle",
    objective: { status: "completed" },
    events: [{ seq: 1, type: "session.resumed" }],
  })).status, "healthy");
  assert.equal(evaluateSession(fixtureState({
    phase: "idle",
    objective: { status: "cancelled" },
    events: [{ seq: 1, type: "session.resumed" }],
  })).status, "cancelled");
  const failed = evaluateSession(fixtureState({
    phase: "idle",
    objective: { status: "failed" },
    events: [{ seq: 1, type: "objective.failed" }, { seq: 2, type: "session.resumed" }],
  }));
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.issues, [{
    code: "session_failed",
    severity: "high",
    label: "任务以失败状态结束",
    count: 1,
    eventSeq: 1,
  }]);
});

function fixtureState(overrides = {}) {
  return {
    id: "session-evaluation",
    phase: "idle",
    events: [],
    objective: null,
    plan: null,
    delegations: [],
    memoryMutationIssues: [],
    metrics: {},
    ...overrides,
  };
}
