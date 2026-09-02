import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CLI --sessions 可在空工作区启动", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cli-smoke-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    "--demo",
    `--workspace=${workspace}`,
    "--sessions",
  ], {
    cwd: root,
    env: { ...process.env, NEXUS_USER_DATA_DIR: path.join(workspace, "user-data") },
    timeout: 5_000,
  });

  assert.match(stdout, /暂无已保存会话/);
  assert.doesNotMatch(stderr, /ReferenceError|before initialization/);
});

test("普通 CLI 可使用显式 Agent Profile 启动并退出", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cli-profile-smoke-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    agents: { profiles: { review: { label: "审查", permissionProfile: "read-only" } } },
  }), "utf8");

  const result = await runCli([
    "--demo",
    `--workspace=${workspace}`,
    "--agent-profile=review",
  ], workspace, "/quit\n");

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ReferenceError|before initialization/);
});

test("CLI Journal Import 可在新工作区完成", async (t) => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cli-import-source-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cli-import-target-"));
  t.after(() => Promise.all([
    fs.rm(source, { recursive: true, force: true }),
    fs.rm(target, { recursive: true, force: true }),
  ]));
  const sourceStore = new SessionStore(path.join(source, ".nexus", "nexus.db"), { workspace: source });
  const state = createSession({ provider: "offline-demo", workspace: source, id: "session-cli-import-source" });
  sourceStore.ensureJournal(state);
  const archive = sourceStore.exportJournal(state.id);
  sourceStore.close();
  const archiveFile = path.join(source, "session.journal.json");
  await fs.writeFile(archiveFile, JSON.stringify(archive), "utf8");

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    "--demo",
    `--workspace=${target}`,
    `--import=${archiveFile}`,
  ], {
    cwd: root,
    env: { ...process.env, NEXUS_USER_DATA_DIR: path.join(target, "user-data") },
    timeout: 5_000,
  });

  assert.match(stdout, /已导入会话/);
  assert.doesNotMatch(stderr, /ReferenceError|before initialization/);
});

test("CLI 可在不启动 Runtime 的情况下离线评测 Journal Archive", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cli-evaluation-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const state = createSession({ provider: "offline-demo", workspace, id: "session-cli-evaluation" });
  store.ensureJournal(state);
  const archiveFile = path.join(workspace, "session.journal.json");
  await fs.writeFile(archiveFile, JSON.stringify(store.exportJournal(state.id)), "utf8");
  store.close();

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    `--evaluate-archive=${archiveFile}`,
  ], { cwd: root, timeout: 5_000 });
  const report = JSON.parse(stdout);

  assert.equal(report.version, "journal-replay-evaluation-v1");
  assert.equal(report.replay.deterministic, true);
  assert.equal(report.archive.sessionId, state.id);
  assert.equal(report.evaluation.status, "idle");
  assert.doesNotMatch(stderr, /离线评测失败|ReferenceError/);

  const compared = await execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    `--evaluate-archive=${archiveFile}`,
    `--compare-archive=${archiveFile}`,
  ], { cwd: root, timeout: 5_000 });
  const comparison = JSON.parse(compared.stdout);
  assert.equal(comparison.primary.archive.sessionId, state.id);
  assert.equal(comparison.comparison.passed, true);
  assert.ok(comparison.comparison.checks.every((item) => item.match));
});

test("CLI 可离线运行确定性 Scenario Evaluation", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cli-scenario-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const scenarioFile = path.join(workspace, "scenario.json");
  await fs.writeFile(scenarioFile, JSON.stringify({
    id: "cli-success",
    prompt: "CLI scenario",
    tools: [{ name: "lookup", outcome: { type: "success", result: "ok" } }],
    provider: [
      { toolCalls: [{ id: "cli-call-1", name: "lookup", arguments: {} }] },
      { text: "done", toolCalls: [] },
    ],
    expect: { status: "healthy", providerCalls: 2, toolSucceeded: 1 },
  }), "utf8");

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    `--evaluate-scenario=${scenarioFile}`,
  ], { cwd: root, timeout: 5_000 });
  const report = JSON.parse(stdout);

  assert.equal(report.version, "scenario-evaluation-v1");
  assert.equal(report.passed, true);
  assert.equal(report.deterministic, true);
  assert.doesNotMatch(stderr, /场景评测失败|ReferenceError/);
});

test("CLI 可按标签运行 Scenario Suite，并以退出码 2 表示断言失败", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cli-suite-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "pass.json"), JSON.stringify({
    id: "suite-pass",
    tags: ["smoke"],
    prompt: "pass",
    tools: [],
    provider: [{ text: "done", toolCalls: [] }],
    expect: { status: "healthy" },
  }), "utf8");
  await fs.writeFile(path.join(directory, "fail.json"), JSON.stringify({
    id: "suite-fail",
    tags: ["regression"],
    prompt: "fail expectation",
    tools: [],
    provider: [{ text: "done", toolCalls: [] }],
    expect: { status: "failed" },
  }), "utf8");

  const selected = await execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    `--evaluate-suite=${directory}`,
    "--suite-tags=smoke",
  ], { cwd: root, timeout: 5_000 });
  const selectedReport = JSON.parse(selected.stdout);
  assert.equal(selectedReport.passed, true);
  assert.equal(selectedReport.suite.selected, 1);
  assert.deepEqual(selectedReport.suite.includeTags, ["smoke"]);

  await assert.rejects(execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    `--evaluate-suite=${directory}`,
  ], { cwd: root, timeout: 5_000 }), (error) => {
    assert.equal(error.code, 2);
    const report = JSON.parse(error.stdout);
    assert.equal(report.passed, false);
    assert.equal(report.score.failed, 1);
    return true;
  });
});

test("CLI 可使用 Suite Baseline 检测 Token 回归并应用容差", async (t) => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cli-suite-baseline-"));
  const fixtures = path.join(rootDirectory, "fixtures");
  const baselineFile = path.join(rootDirectory, "baseline.json");
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  await fs.mkdir(fixtures);
  const fixtureFile = path.join(fixtures, "tokens.json");
  const fixture = (totalTokens) => ({
    id: "token-case",
    tags: ["cost"],
    prompt: "stable prompt",
    tools: [],
    provider: [{ text: "done", toolCalls: [], usage: { inputTokens: totalTokens - 1, outputTokens: 1, totalTokens } }],
    expect: { status: "healthy" },
  });
  await fs.writeFile(fixtureFile, JSON.stringify(fixture(10)), "utf8");
  const baselineRun = await execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    `--evaluate-suite=${fixtures}`,
  ], { cwd: root, timeout: 5_000 });
  await fs.writeFile(baselineFile, baselineRun.stdout, "utf8");
  await fs.writeFile(fixtureFile, JSON.stringify(fixture(11)), "utf8");

  await assert.rejects(execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    `--evaluate-suite=${fixtures}`,
    `--suite-baseline=${baselineFile}`,
  ], { cwd: root, timeout: 5_000 }), (error) => {
    assert.equal(error.code, 2);
    const output = JSON.parse(error.stdout);
    assert.ok(output.comparison.scenarios[0].regressions.some((item) => item.code === "scenario_token_increased"));
    return true;
  });

  const tolerant = await execFileAsync(process.execPath, [
    path.join(root, "src", "cli.js"),
    `--evaluate-suite=${fixtures}`,
    `--suite-baseline=${baselineFile}`,
    "--suite-token-tolerance=10",
  ], { cwd: root, timeout: 5_000 });
  assert.equal(JSON.parse(tolerant.stdout).comparison.passed, true);
});

function runCli(args, workspace, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "src", "cli.js"), ...args], {
      cwd: root,
      env: { ...process.env, NEXUS_USER_DATA_DIR: path.join(workspace, "user-data") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("CLI smoke test 超时"));
    }, 5_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
