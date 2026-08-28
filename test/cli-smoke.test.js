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
