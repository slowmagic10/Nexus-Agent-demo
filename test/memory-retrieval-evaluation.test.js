import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SQLiteMemoryAdapter } from "../src/memory/sqlite-adapter.js";
import { runMemoryRetrievalSuite } from "../src/evaluation/memory-retrieval-suite.js";

const scope = { workspace: "/fixture/a", agentId: "default", userId: "local" };
const now = "2026-09-09T00:00:00.000Z";
const smallSuite = () => ({ id: "small", now,
  records: [{ id: "fact", content: "alpha then beta", scope }],
  queries: [{ id: "query", query: "alpha beta", scope, expectedIds: ["fact"] }],
});

test("固定中文/英文标注集比较真实检索策略，报告召回收益及精度代价", async () => {
  const fixture = JSON.parse(await fs.readFile(new URL("../fixtures/memory-suites/retrieval-v1.json", import.meta.url), "utf8"));
  const first = await runMemoryRetrievalSuite(fixture);
  const second = await runMemoryRetrievalSuite(fixture);
  assert.equal(first.passed, true);
  assert.equal(first.strategies.literal.recallAtK, 0.5);
  assert.equal(first.strategies.keywords.recallAtK, 1);
  assert.equal(first.strategies.keywords.precisionAtK, 0.9524);
  assert.equal(first.strategies.keywords.negativeEmptyRate, 1);
  assert.equal(first.strategies.keywords.ineligibleHits, 0);
  assert.equal(first.comparison.recallImprovedQueries, 9);
  assert.equal(first.comparison.precisionAtKDelta, -0.0476);
  assert.deepEqual({ ...first, elapsedMs: 0 }, { ...second, elapsedMs: 0 });
  for (const record of fixture.records) assert.equal(JSON.stringify(first).includes(record.content), false);
  assert.equal(JSON.stringify(first).includes("/fixture/a"), false);
});

test("正例全部找到与精度分开报告，新增无关正例结果不会被隐藏为质量无变化", async () => {
  const fixture = smallSuite();
  fixture.records[0].content = "alpha beta";
  fixture.records.push({ id: "extra", content: "alpha irrelevant beta", scope });
  const report = await runMemoryRetrievalSuite(fixture);
  assert.equal(report.passed, true);
  assert.equal(report.acceptance.precision, "reported-not-gated");
  assert.equal(report.strategies.literal.precisionAtK, 1);
  assert.equal(report.strategies.keywords.precisionAtK, 0.5);
  assert.equal(report.comparison.precisionRegressedQueries, 1);
  assert.equal(report.comparison.recallRegressedQueries, 0);
});

test("全负例和全正例的不存在分母返回null，正例漏召回不会标为通过", async () => {
  const negative = smallSuite();
  negative.queries[0] = { ...negative.queries[0], query: "unrelated phrase", expectedIds: [] };
  const report = await runMemoryRetrievalSuite(negative);
  assert.equal(report.strategies.keywords.recallAtK, null);
  assert.equal(report.strategies.keywords.meanReciprocalRank, null);
  assert.equal(report.strategies.keywords.precisionAtK, null);
  assert.equal(report.strategies.keywords.negativeEmptyRate, 1);
  const missing = smallSuite();
  missing.queries[0].query = "unrelated phrase";
  const miss = await runMemoryRetrievalSuite(missing);
  assert.equal(miss.passed, false);
  assert.equal(miss.strategies.keywords.recallAtK, 0);
  assert.equal(miss.strategies.keywords.negativeEmptyRate, null);
});

test("fixture规范化与Adapter一致，scope空白不误报泄漏，秘密不进入报告", async () => {
  const fixture = smallSuite();
  fixture.records[0].scope = { ...scope, workspace: "/fixture/a " };
  fixture.records[0].content = "  alpha then beta password=private-value  ";
  const report = await runMemoryRetrievalSuite(fixture);
  assert.equal(report.passed, true);
  assert.equal(report.comparison.scopeOrStatusLeaks, 0);
  assert.doesNotMatch(JSON.stringify(report), /private-value|password|\/fixture/);
  const unicode = smallSuite();
  unicode.records = [{ id: "upper", content: "CAFÉ", scope }, { id: "lower", content: "café", scope }];
  unicode.queries = [{ id: "upper-query", query: "CAFÉ", scope, expectedIds: ["upper"] },
    { id: "lower-query", query: "café", scope, expectedIds: ["lower"] }];
  assert.equal((await runMemoryRetrievalSuite(unicode)).passed, true);
});

test("非法标注、重复事实和脱敏后身份合并会拒绝，不产生误导指标", async () => {
  for (const change of [
    (value) => { value.queries[0].expectedIds = ["missing"]; },
    (value) => { value.records[0].scope = { ...scope, userId: "other" }; },
    (value) => { value.records[0].expiresAt = now; },
    (value) => { value.records[0].pinned = true; },
    (value) => { value.records[0].status = "candidate"; },
    (value) => { value.records.push({ ...value.records[0], id: "duplicate", content: "  alpha then beta  " }); },
    (value) => { value.queries[0].query = "a".repeat(4097); },
    (value) => { value.queries[0].rawPrompt = "not permitted"; },
  ]) {
    const fixture = smallSuite(); change(fixture);
    await assert.rejects(runMemoryRetrievalSuite(fixture));
  }
  const redacted = smallSuite();
  redacted.records[0].content = "alpha OPENAI_API_KEY=sk-one1234567890123456";
  redacted.records.push({ id: "second", content: "alpha OPENAI_API_KEY=sk-two1234567890123456", scope });
  await assert.rejects(runMemoryRetrievalSuite(redacted), /身份与标注不一致/);
});

test("取消保留完成的literal/keywords配对，不把半组结果纳入分母", async (t) => {
  const controller = new AbortController();
  const original = SQLiteMemoryAdapter.prototype.search;
  let calls = 0;
  t.mock.method(SQLiteMemoryAdapter.prototype, "search", async function (...args) {
    const result = await original.apply(this, args);
    if (++calls === 2) controller.abort(new Error("cancel after first pair"));
    return result;
  });
  const fixture = smallSuite();
  fixture.queries.push({ ...fixture.queries[0], id: "next" });
  const report = await runMemoryRetrievalSuite(fixture, { signal: controller.signal });
  assert.equal(report.cancelled, true);
  assert.equal(report.passed, false);
  assert.equal(report.completedQueries, 1);
  assert.equal(report.notRun, 1);
  assert.equal(calls, 2);
});

test("预先取消不建评测库，seed阶段取消不声称查询已运行", async () => {
  await assert.rejects(runMemoryRetrievalSuite(smallSuite(), { signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
  const fixture = smallSuite();
  fixture.records.push(...Array.from({ length: 80 }, (_, index) => ({ id: `noise-${index}`, content: `unrelated ${index}`, scope })));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("stop seeding")), 0);
  try {
    const report = await runMemoryRetrievalSuite(fixture, { signal: controller.signal });
    assert.equal(report.cancelled, true);
    assert.equal(report.completedQueries, 0);
  } finally { clearTimeout(timer); }
});

test("CLI记忆评测在模型装配前运行，不读取模型配置或创建业务工作区", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-memory-eval-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixturePath = path.join(directory, "fixture.json");
  await fs.writeFile(fixturePath, JSON.stringify(smallSuite()));
  const workspace = path.join(directory, "unused-workspace");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const stdout = execFileSync(process.execPath, [cli, `--evaluate-memory=${fixturePath}`], {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXUS_WORKSPACE: workspace, NEXUS_EXECUTION: "invalid-execution", NEXUS_PROVIDER_THINKING: "invalid-thinking" },
  });
  assert.equal(JSON.parse(stdout).passed, true);
  await assert.rejects(fs.stat(workspace), { code: "ENOENT" });
});
