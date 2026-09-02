import assert from "node:assert/strict";
import test from "node:test";
import { runScenarioEvaluation, SCENARIO_EVALUATION_VERSION } from "../src/evaluation/scenario-harness.js";

test("Scenario Harness 通过真实 Runtime 与 Tool Host 确定性重跑成功场景", async () => {
  const report = await runScenarioEvaluation({
    id: "tool-success",
    prompt: "私密场景输入",
    tools: [{ name: "lookup", outcome: { type: "success", result: "私密工具输出" } }],
    provider: [
      {
        text: "",
        toolCalls: [{ id: "call-success", name: "lookup", arguments: { query: "私密参数" } }],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
      { text: "私密最终答案", toolCalls: [], usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
    ],
    expect: { status: "healthy", phase: "completed", providerCalls: 2, toolCalls: 1, toolSucceeded: 1, toolFailed: 0 },
  });

  assert.equal(report.version, SCENARIO_EVALUATION_VERSION);
  assert.equal(report.passed, true);
  assert.equal(report.deterministic, true);
  assert.ok(report.determinismChecks.every((item) => item.match));
  assert.match(report.replay.semanticStateHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(report.execution.toolCalls, [{ name: "lookup", outcome: "success" }]);
  assert.equal(JSON.stringify(report).includes("私密"), false);
});

test("Scenario Harness 稳定识别工具失败", async () => {
  const report = await runScenarioEvaluation({
    id: "tool-failure",
    prompt: "触发失败工具",
    tools: [{ name: "unstable_lookup", outcome: { type: "failure", error: "adapter unavailable" } }],
    provider: [
      { toolCalls: [{ id: "call-failure", name: "unstable_lookup", arguments: {} }] },
      { text: "已处理失败", toolCalls: [] },
    ],
    expect: { status: "attention", phase: "completed", providerCalls: 2, toolCalls: 1, toolSucceeded: 0, toolFailed: 1 },
  });

  assert.equal(report.passed, true);
  assert.deepEqual(report.evaluation.issues.map((issue) => issue.code), ["tool_failed"]);
  assert.equal(report.execution.toolCalls[0].outcome, "failure");
});

test("Scenario Harness 可在工具启动后取消并重复得到相同语义结果", async () => {
  const report = await runScenarioEvaluation({
    id: "tool-cancel",
    prompt: "等待后取消",
    tools: [{ name: "waiter", outcome: { type: "wait_for_cancel" } }],
    provider: [{ toolCalls: [{ id: "call-cancel", name: "waiter", arguments: {} }] }],
    cancel: { after: "tool_started", reason: "固定取消原因" },
    expect: { status: "cancelled", phase: "cancelled", providerCalls: 1, toolCalls: 1, toolSucceeded: 0, toolFailed: 1 },
  });

  assert.equal(report.passed, true);
  assert.equal(report.deterministic, true);
  assert.equal(report.evaluation.status, "cancelled");
  assert.equal(report.evaluation.tools.executionUnknown, 0);
});

test("Scenario Harness 对错误期望返回失败报告，并拒绝未声明工具", async () => {
  const mismatch = await runScenarioEvaluation({
    id: "expectation-mismatch",
    prompt: "完成",
    tools: [],
    provider: [{ text: "完成", toolCalls: [] }],
    expect: { status: "failed" },
  });
  assert.equal(mismatch.deterministic, true);
  assert.equal(mismatch.passed, false);
  assert.equal(mismatch.checks[0].match, false);

  await assert.rejects(runScenarioEvaluation({
    id: "unknown-tool",
    prompt: "调用不存在工具",
    tools: [],
    provider: [{ toolCalls: [{ id: "unknown-1", name: "missing", arguments: {} }] }],
  }), /未配置工具/);

  await assert.rejects(runScenarioEvaluation({
    id: "unbounded-wait",
    prompt: "不能无限等待",
    tools: [],
    provider: [{ type: "wait_for_cancel" }],
  }), /必须配置 cancel/);
});
