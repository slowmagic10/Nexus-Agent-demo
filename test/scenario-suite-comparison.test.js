import assert from "node:assert/strict";
import test from "node:test";
import { compareScenarioSuiteReports, SCENARIO_SUITE_COMPARISON_VERSION } from "../src/evaluation/scenario-suite-comparison.js";
import { runScenarioSuite } from "../src/evaluation/scenario-suite.js";

test("Suite Baseline 对相同报告通过，并允许新增且通过的场景", async () => {
  const baseline = await suite([scenario("stable", { tags: ["smoke"] })]);
  const same = compareScenarioSuiteReports(baseline, structuredClone(baseline));
  assert.equal(same.version, SCENARIO_SUITE_COMPARISON_VERSION);
  assert.equal(same.passed, true);
  assert.equal(same.summary.regressions, 0);

  const candidate = await suite([
    scenario("stable", { tags: ["smoke"] }),
    scenario("new-case", { tags: ["new"] }),
  ]);
  const added = compareScenarioSuiteReports(baseline, candidate);
  assert.equal(added.passed, true);
  assert.equal(added.summary.added, 1);
  assert.deepEqual(added.scenarios.find((item) => item.id === "new-case").changes.map((item) => item.code), ["scenario_added"]);
});

test("Suite Baseline 检测场景缺失、Context 漂移和通过变失败", async () => {
  const baseline = await suite([scenario("keep"), scenario("removed")]);
  const candidate = await suite([scenario("keep", { prompt: "changed prompt", expectedStatus: "failed" })]);
  const comparison = compareScenarioSuiteReports(baseline, candidate);

  assert.equal(comparison.passed, false);
  assert.equal(comparison.summary.removed, 1);
  const keepCodes = comparison.scenarios.find((item) => item.id === "keep").regressions.map((item) => item.code);
  assert.ok(keepCodes.includes("scenario_passed_to_failed"));
  assert.ok(keepCodes.includes("scenario_context_changed"));
  assert.deepEqual(comparison.scenarios.find((item) => item.id === "removed").regressions.map((item) => item.code), ["scenario_removed"]);
});

test("Suite Baseline 按百分比容差判断 Token 增长，并记录指纹变化", async () => {
  const baseline = await suite([scenario("tokens", { totalTokens: 10 })]);
  const candidate = await suite([scenario("tokens", { totalTokens: 11 })]);

  const strict = compareScenarioSuiteReports(baseline, candidate);
  assert.equal(strict.passed, false);
  assert.ok(strict.scenarios[0].regressions.some((item) => item.code === "scenario_token_increased"));

  const tolerant = compareScenarioSuiteReports(baseline, candidate, { maxTokenIncreasePercent: 10 });
  assert.equal(tolerant.passed, true);
  assert.ok(tolerant.scenarios[0].changes.some((item) => item.code === "scenario_event_fingerprint_changed"));
});

test("Suite Baseline 拒绝错误报告和非法 Token 容差", async () => {
  const report = await suite([scenario("valid")]);
  assert.throws(() => compareScenarioSuiteReports({}, report), /scenario-suite-evaluation-v1/);
  assert.throws(() => compareScenarioSuiteReports(report, report, { maxTokenIncreasePercent: -1 }), /Token 容差/);
  const tampered = structuredClone(report);
  tampered.totals.totalTokens += 1;
  assert.throws(() => compareScenarioSuiteReports(tampered, report), /汇总与 results 不一致/);
});

function suite(scenarios) {
  return runScenarioSuite({ id: "baseline-suite", scenarios });
}

function scenario(id, { prompt = `prompt-${id}`, expectedStatus = "healthy", totalTokens = 3, tags = [] } = {}) {
  return {
    id,
    tags,
    prompt,
    tools: [],
    provider: [{
      text: `answer-${id}`,
      toolCalls: [],
      usage: { inputTokens: Math.max(0, totalTokens - 1), outputTokens: totalTokens ? 1 : 0, totalTokens },
    }],
    expect: { status: expectedStatus },
  };
}
