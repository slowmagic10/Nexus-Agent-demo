import { SCENARIO_SUITE_VERSION } from "./scenario-suite.js";

export const SCENARIO_SUITE_COMPARISON_VERSION = "scenario-suite-comparison-v1";

const MAX_SCENARIOS = 500;
const STATUS_RANK = new Map([
  ["healthy", 0],
  ["idle", 1],
  ["running", 2],
  ["attention", 3],
  ["cancelled", 4],
  ["failed", 5],
]);

export function compareScenarioSuiteReports(baselineInput, candidateInput, { maxTokenIncreasePercent = 0 } = {}) {
  const baseline = normalizeReport(baselineInput, "Baseline");
  const candidate = normalizeReport(candidateInput, "Candidate");
  if (!Number.isFinite(maxTokenIncreasePercent) || maxTokenIncreasePercent < 0 || maxTokenIncreasePercent > 10_000) {
    throw new Error("Suite Token 容差必须是 0 到 10000 的百分比");
  }

  const suiteRegressions = [];
  const scenarios = [];
  if (!sameValue(baseline.includeTags, candidate.includeTags)) {
    suiteRegressions.push(regression(
      "suite_filter_changed",
      "suite.includeTags",
      baseline.includeTags,
      candidate.includeTags,
    ));
  }
  if (candidate.scorePercent < baseline.scorePercent) {
    suiteRegressions.push(regression(
      "suite_score_decreased",
      "score.percent",
      baseline.scorePercent,
      candidate.scorePercent,
    ));
  }

  const baselineById = new Map(baseline.results.map((item) => [item.id, item]));
  const candidateById = new Map(candidate.results.map((item) => [item.id, item]));
  for (const baselineScenario of baseline.results) {
    const current = candidateById.get(baselineScenario.id);
    if (!current) {
      scenarios.push({
        id: baselineScenario.id,
        classification: "removed",
        regressions: [regression("scenario_removed", "scenario", "present", "missing")],
        changes: [],
      });
      continue;
    }
    scenarios.push(compareScenario(baselineScenario, current, maxTokenIncreasePercent));
  }
  for (const current of candidate.results) {
    if (baselineById.has(current.id)) continue;
    const regressions = [];
    if (!current.passed) regressions.push(regression("added_scenario_failed", "passed", true, false));
    if (!current.deterministic) regressions.push(regression("added_scenario_nondeterministic", "deterministic", true, false));
    scenarios.push({
      id: current.id,
      classification: "added",
      regressions,
      changes: [change("scenario_added", "scenario", "missing", "present")],
    });
  }

  scenarios.sort((left, right) => left.id.localeCompare(right.id));
  const scenarioRegressionCount = scenarios.reduce((total, item) => total + item.regressions.length, 0);
  const changeCount = scenarios.reduce((total, item) => total + item.changes.length, 0);
  const added = scenarios.filter((item) => item.classification === "added").length;
  const removed = scenarios.filter((item) => item.classification === "removed").length;
  const matched = scenarios.filter((item) => item.classification === "matched").length;
  const regressionCount = suiteRegressions.length + scenarioRegressionCount;
  return {
    version: SCENARIO_SUITE_COMPARISON_VERSION,
    passed: regressionCount === 0,
    policy: { maxTokenIncreasePercent, requireContextHashMatch: true },
    summary: {
      baseline: baseline.results.length,
      candidate: candidate.results.length,
      matched,
      added,
      removed,
      regressions: regressionCount,
      changes: changeCount,
    },
    aggregate: {
      scorePercent: delta(baseline.scorePercent, candidate.scorePercent),
      totalTokens: delta(baseline.totalTokens, candidate.totalTokens),
    },
    suiteRegressions,
    scenarios,
  };
}

function compareScenario(baseline, candidate, tolerance) {
  const regressions = [];
  const changes = [];
  if (baseline.passed && !candidate.passed) {
    regressions.push(regression("scenario_passed_to_failed", "passed", true, false));
  }
  if (baseline.deterministic && !candidate.deterministic) {
    regressions.push(regression("scenario_determinism_lost", "deterministic", true, false));
  }
  const baselineRank = statusRank(baseline.status);
  const candidateRank = statusRank(candidate.status);
  if (candidateRank > baselineRank) {
    regressions.push(regression("scenario_status_degraded", "status", baseline.status, candidate.status));
  } else if (candidate.status !== baseline.status) {
    changes.push(change("scenario_status_changed", "status", baseline.status, candidate.status));
  }
  const addedIssues = candidate.issueCodes.filter((code) => !baseline.issueCodes.includes(code));
  if (addedIssues.length) {
    regressions.push(regression("scenario_issues_added", "issueCodes", baseline.issueCodes, candidate.issueCodes));
  }
  if (!sameValue(baseline.contextHashes, candidate.contextHashes)) {
    regressions.push(regression("scenario_context_changed", "contextHashes", baseline.contextHashes, candidate.contextHashes));
  }
  const allowedTokens = baseline.totalTokens === 0
    ? 0
    : Math.ceil(baseline.totalTokens * (1 + tolerance / 100));
  if (candidate.totalTokens > allowedTokens) {
    regressions.push(regression("scenario_token_increased", "metrics.totalTokens", baseline.totalTokens, candidate.totalTokens, {
      allowed: allowedTokens,
    }));
  } else if (candidate.totalTokens !== baseline.totalTokens) {
    changes.push(change("scenario_token_changed", "metrics.totalTokens", baseline.totalTokens, candidate.totalTokens));
  }
  if (baseline.semanticStateHash !== candidate.semanticStateHash) {
    changes.push(change("scenario_state_fingerprint_changed", "semanticStateHash", baseline.semanticStateHash, candidate.semanticStateHash));
  }
  if (baseline.semanticEventHash !== candidate.semanticEventHash) {
    changes.push(change("scenario_event_fingerprint_changed", "semanticEventHash", baseline.semanticEventHash, candidate.semanticEventHash));
  }
  if (!sameValue(baseline.tags, candidate.tags)) {
    changes.push(change("scenario_tags_changed", "tags", baseline.tags, candidate.tags));
  }
  return { id: baseline.id, classification: "matched", regressions, changes };
}

function normalizeReport(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.version !== SCENARIO_SUITE_VERSION) {
    throw new Error(`${label} 必须是 ${SCENARIO_SUITE_VERSION} 报告`);
  }
  if (!input.suite || !Array.isArray(input.suite.includeTags)) throw new Error(`${label} suite metadata 无效`);
  if (!input.score || !Number.isSafeInteger(input.score.percent) || input.score.percent < 0 || input.score.percent > 100) {
    throw new Error(`${label} score 无效`);
  }
  if (!input.totals || !Number.isSafeInteger(input.totals.totalTokens) || input.totals.totalTokens < 0) {
    throw new Error(`${label} totals 无效`);
  }
  if (!Array.isArray(input.results) || input.results.length < 1 || input.results.length > MAX_SCENARIOS) {
    throw new Error(`${label} results 必须包含 1 到 ${MAX_SCENARIOS} 项`);
  }
  const ids = new Set();
  const results = input.results.map((item, index) => normalizeScenarioResult(item, `${label} result ${index + 1}`));
  for (const result of results) {
    if (ids.has(result.id)) throw new Error(`${label} Scenario id 重复：${result.id}`);
    ids.add(result.id);
  }
  const passedCount = results.filter((item) => item.passed).length;
  const deterministicCount = results.filter((item) => item.deterministic).length;
  const totalTokens = results.reduce((total, item) => total + item.totalTokens, 0);
  const expectedPercent = Math.round((passedCount / results.length) * 100);
  const consistent = input.suite.selected === results.length
    && input.score.total === results.length
    && input.score.passed === passedCount
    && input.score.failed === results.length - passedCount
    && input.score.deterministic === deterministicCount
    && input.score.percent === expectedPercent
    && input.totals.totalTokens === totalTokens
    && input.passed === (passedCount === results.length);
  if (!consistent) throw new Error(`${label} 汇总与 results 不一致`);
  return {
    includeTags: normalizeStringArray(input.suite.includeTags, `${label} includeTags`),
    scorePercent: input.score.percent,
    totalTokens: input.totals.totalTokens,
    results,
  };
}

function normalizeScenarioResult(item, label) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} 无效`);
  if (typeof item.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.id) || item.id.length > 120) throw new Error(`${label}.id 无效`);
  if (typeof item.passed !== "boolean" || typeof item.deterministic !== "boolean") throw new Error(`${label} 状态无效`);
  if (typeof item.status !== "string" || !STATUS_RANK.has(item.status)) throw new Error(`${label}.status 无效`);
  if (!item.metrics || !Number.isSafeInteger(item.metrics.totalTokens) || item.metrics.totalTokens < 0) throw new Error(`${label}.metrics 无效`);
  const fingerprints = item.fingerprints;
  if (!fingerprints || !hashValue(fingerprints.semanticStateHash) || !hashValue(fingerprints.semanticEventHash)) {
    throw new Error(`${label}.fingerprints 无效`);
  }
  return {
    id: item.id,
    tags: normalizeStringArray(item.tags, `${label}.tags`),
    passed: item.passed,
    deterministic: item.deterministic,
    status: item.status,
    totalTokens: item.metrics.totalTokens,
    issueCodes: normalizeStringArray(item.issueCodes, `${label}.issueCodes`),
    semanticStateHash: fingerprints.semanticStateHash,
    semanticEventHash: fingerprints.semanticEventHash,
    contextHashes: normalizeHashArray(fingerprints.contextHashes, `${label}.contextHashes`),
  };
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > 160)) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return [...new Set(value)].sort();
}

function normalizeHashArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => !hashValue(item))) throw new Error(`${label} 必须是 SHA-256 数组`);
  return [...value];
}

function hashValue(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function statusRank(value) {
  return STATUS_RANK.get(value) ?? 3;
}

function regression(code, field, baseline, candidate, detail = {}) {
  return { code, field, baseline, candidate, ...detail };
}

function change(code, field, baseline, candidate) {
  return { code, field, baseline, candidate };
}

function delta(baseline, candidate) {
  return { baseline, candidate, delta: candidate - baseline };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
