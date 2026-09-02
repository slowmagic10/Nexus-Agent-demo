import { promises as fs } from "node:fs";
import path from "node:path";
import { runScenarioEvaluation } from "./scenario-harness.js";

export const SCENARIO_SUITE_VERSION = "scenario-suite-evaluation-v1";

const MAX_SCENARIOS = 500;
const MAX_FIXTURE_BYTES = 2_000_000;
const MAX_TAGS = 20;

export async function runScenarioSuite(input, { includeTags = [] } = {}) {
  const suite = normalizeSuite(input);
  const filters = normalizeTags(includeTags, "Suite filter tags");
  const selected = suite.scenarios.filter((item) => (
    !filters.length || item.tags.some((tag) => filters.includes(tag))
  ));
  if (!selected.length) throw new Error("Scenario Suite 标签筛选后没有可运行场景");

  const results = [];
  for (const item of selected) {
    let report;
    try {
      report = await runScenarioEvaluation(item.scenario);
    } catch (error) {
      throw new Error(`Scenario ${item.id} 无效：${error.message}`);
    }
    results.push(summarizeScenario(item, report));
  }

  const passedCount = results.filter((item) => item.passed).length;
  const deterministicCount = results.filter((item) => item.deterministic).length;
  return {
    version: SCENARIO_SUITE_VERSION,
    suite: {
      id: suite.id,
      available: suite.scenarios.length,
      selected: results.length,
      includeTags: filters,
    },
    passed: passedCount === results.length,
    score: {
      percent: Math.round((passedCount / results.length) * 100),
      passed: passedCount,
      failed: results.length - passedCount,
      deterministic: deterministicCount,
      total: results.length,
    },
    totals: sumTotals(results),
    statusCounts: countValues(results.map((item) => item.status)),
    issueCounts: countValues(results.flatMap((item) => item.issueCodes)),
    tagCounts: countValues(results.flatMap((item) => item.tags)),
    results,
  };
}

export async function loadScenarioSuiteDirectory(directory) {
  if (typeof directory !== "string" || !directory) throw new Error("Scenario Suite 需要 fixture 目录");
  const requested = path.resolve(directory);
  let root;
  try {
    root = await fs.realpath(requested);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error("目标不是目录");
  } catch (error) {
    throw new Error(`无法读取 Scenario Suite 目录：${error.message}`);
  }
  const entries = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".json")
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!entries.length) throw new Error("Scenario Suite 目录中没有 JSON fixture");
  if (entries.length > MAX_SCENARIOS) throw new Error(`Scenario Suite 最多包含 ${MAX_SCENARIOS} 个 fixture`);

  const scenarios = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    const stat = await fs.stat(file);
    if (stat.size > MAX_FIXTURE_BYTES) throw new Error(`Scenario fixture ${entry.name} 超过 ${MAX_FIXTURE_BYTES} 字节`);
    try {
      scenarios.push(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (error) {
      throw new Error(`Scenario fixture ${entry.name} 解析失败：${error.message}`);
    }
  }
  return { id: path.basename(root).slice(0, 120), scenarios };
}

function normalizeSuite(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Scenario Suite 必须是对象");
  const id = boundedText(input.id, "Scenario Suite id", 120);
  if (!Array.isArray(input.scenarios) || input.scenarios.length < 1 || input.scenarios.length > MAX_SCENARIOS) {
    throw new Error(`Scenario Suite 必须包含 1 到 ${MAX_SCENARIOS} 个场景`);
  }
  const ids = new Set();
  const scenarios = input.scenarios.map((scenario, index) => {
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) throw new Error(`Scenario Suite 第 ${index + 1} 项无效`);
    const scenarioId = boundedText(scenario.id, `Scenario ${index + 1} id`, 120);
    if (ids.has(scenarioId)) throw new Error(`Scenario Suite id 重复：${scenarioId}`);
    ids.add(scenarioId);
    return {
      id: scenarioId,
      tags: normalizeTags(scenario.tags || [], `Scenario ${scenarioId} tags`),
      scenario: structuredClone(scenario),
    };
  });
  return { id, scenarios };
}

function summarizeScenario(item, report) {
  const metrics = report.evaluation.metrics;
  return {
    id: item.id,
    tags: item.tags,
    passed: report.passed,
    deterministic: report.deterministic,
    status: report.evaluation.status,
    fingerprints: {
      semanticStateHash: report.replay.semanticStateHash,
      semanticEventHash: report.replay.semanticEventHash,
      contextHashes: report.replay.contextHashes,
    },
    metrics: {
      modelCalls: metrics.modelCalls,
      toolCalls: metrics.toolCalls,
      approvals: metrics.approvals,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens,
    },
    tools: {
      succeeded: report.evaluation.tools.succeeded,
      failed: report.evaluation.tools.failed,
      executionUnknown: report.evaluation.tools.executionUnknown,
    },
    issueCodes: report.evaluation.issues.map((issue) => issue.code),
    failedChecks: report.checks.filter((item) => !item.match),
    nondeterministicFields: report.determinismChecks.filter((item) => !item.match).map((item) => item.field),
  };
}

function sumTotals(results) {
  return results.reduce((total, item) => ({
    modelCalls: total.modelCalls + item.metrics.modelCalls,
    toolCalls: total.toolCalls + item.metrics.toolCalls,
    approvals: total.approvals + item.metrics.approvals,
    inputTokens: total.inputTokens + item.metrics.inputTokens,
    outputTokens: total.outputTokens + item.metrics.outputTokens,
    totalTokens: total.totalTokens + item.metrics.totalTokens,
    toolSucceeded: total.toolSucceeded + item.tools.succeeded,
    toolFailed: total.toolFailed + item.tools.failed,
    executionUnknown: total.executionUnknown + item.tools.executionUnknown,
  }), {
    modelCalls: 0,
    toolCalls: 0,
    approvals: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolSucceeded: 0,
    toolFailed: 0,
    executionUnknown: 0,
  });
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeTags(value, label) {
  const source = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(source)) throw new Error(`${label} 必须是字符串数组`);
  if (source.some((tag) => typeof tag !== "string")) throw new Error(`${label} 必须只包含字符串`);
  const tags = [...new Set(source.map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length > MAX_TAGS) throw new Error(`${label} 最多包含 ${MAX_TAGS} 项`);
  for (const tag of tags) {
    if (tag.length > 64 || !/^[\p{L}\p{N}._-]+$/u.test(tag)) throw new Error(`${label} 包含无效标签：${tag}`);
  }
  return tags.sort();
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} 必须是 1 到 ${maximum} 个可见字符`);
  }
  return value.trim();
}
