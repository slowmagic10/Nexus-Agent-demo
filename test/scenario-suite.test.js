import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadScenarioSuiteDirectory, runScenarioSuite, SCENARIO_SUITE_VERSION } from "../src/evaluation/scenario-suite.js";

test("Scenario Suite 汇总通过率、稳定指标、问题与标签覆盖", async () => {
  const report = await runScenarioSuite({
    id: "core-suite",
    scenarios: [
      completedScenario("healthy-one", ["smoke", "core"], "healthy"),
      toolFailureScenario("tool-failure", ["tools"]),
      completedScenario("mismatch", ["smoke"], "failed"),
    ],
  });

  assert.equal(report.version, SCENARIO_SUITE_VERSION);
  assert.equal(report.passed, false);
  assert.deepEqual(report.score, { percent: 67, passed: 2, failed: 1, deterministic: 3, total: 3 });
  assert.deepEqual(report.statusCounts, { attention: 1, healthy: 2 });
  assert.deepEqual(report.issueCounts, { tool_failed: 1 });
  assert.deepEqual(report.tagCounts, { core: 1, smoke: 2, tools: 1 });
  assert.equal(report.totals.modelCalls, 4);
  assert.equal(report.totals.toolCalls, 1);
  assert.equal(report.results.find((item) => item.id === "mismatch").failedChecks[0].field, "status");
});

test("Scenario Suite 标签使用任一命中语义筛选且不暴露正文", async () => {
  const report = await runScenarioSuite({
    id: "tag-suite",
    scenarios: [
      completedScenario("private-alpha", ["alpha"], "healthy", "绝密正文甲"),
      completedScenario("private-beta", ["beta"], "healthy", "绝密正文乙"),
      completedScenario("private-both", ["alpha", "beta"], "healthy", "绝密正文丙"),
    ],
  }, { includeTags: ["beta"] });

  assert.equal(report.passed, true);
  assert.equal(report.suite.available, 3);
  assert.equal(report.suite.selected, 2);
  assert.deepEqual(report.results.map((item) => item.id), ["private-beta", "private-both"]);
  assert.equal(JSON.stringify(report).includes("绝密正文"), false);
});

test("Scenario Suite 目录 Loader 只加载排序后的普通 JSON fixture", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-scenario-suite-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "b.json"), JSON.stringify(completedScenario("second", ["b"], "healthy")), "utf8");
  await fs.writeFile(path.join(directory, "a.json"), JSON.stringify(completedScenario("first", ["a"], "healthy")), "utf8");
  await fs.writeFile(path.join(directory, "notes.txt"), "ignored", "utf8");
  await fs.symlink(path.join(directory, "a.json"), path.join(directory, "linked.json"));

  const suite = await loadScenarioSuiteDirectory(directory);
  const report = await runScenarioSuite(suite);

  assert.deepEqual(suite.scenarios.map((item) => item.id), ["first", "second"]);
  assert.equal(report.score.total, 2);
  assert.equal(report.passed, true);
});

test("Scenario Suite 拒绝重复 ID、空筛选结果和损坏 fixture", async (t) => {
  await assert.rejects(runScenarioSuite({
    id: "duplicate-suite",
    scenarios: [completedScenario("same", [], "healthy"), completedScenario("same", [], "healthy")],
  }), /id 重复/);
  await assert.rejects(runScenarioSuite({
    id: "empty-filter",
    scenarios: [completedScenario("only-alpha", ["alpha"], "healthy")],
  }, { includeTags: ["beta"] }), /没有可运行场景/);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-scenario-suite-bad-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "broken.json"), "{bad", "utf8");
  await assert.rejects(loadScenarioSuiteDirectory(directory), /解析失败/);
});

function completedScenario(id, tags, expectedStatus, prompt = `prompt-${id}`) {
  return {
    id,
    tags,
    prompt,
    tools: [],
    provider: [{ text: `answer-${id}`, toolCalls: [], usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }],
    expect: { status: expectedStatus, providerCalls: 1, toolCalls: 0 },
  };
}

function toolFailureScenario(id, tags) {
  return {
    id,
    tags,
    prompt: `prompt-${id}`,
    tools: [{ name: "lookup", outcome: { type: "failure", error: "offline" } }],
    provider: [
      { toolCalls: [{ id: `${id}-call`, name: "lookup", arguments: {} }] },
      { text: "handled", toolCalls: [] },
    ],
    expect: { status: "attention", providerCalls: 2, toolFailed: 1 },
  };
}
