import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession, SESSION_SCHEMA_VERSION } from "../src/core/state.js";
import { completionIssues } from "../src/core/completion-guard.js";
import { ToolHost } from "../src/tools/host.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { snapshotVerificationInputs } from "../src/core/verification.js";
import { AgentRuntime } from "../src/core/agent.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { PermissionToolHostRouter } from "../src/tools/permission-router.js";

const criterion = { id: "tests", description: "源文件通过验收测试", command: "node --test verify.test.js", paths: ["source.js", "verify.test.js"] };
const steps = [{ step: "实现并验证", status: "completed" }];

test("验收声明必须使用新durable action，旧PLAN_UPDATED不能静默接受新语义", () => {
  const state = reduceSession(createSession({ provider: "verification-test", workspace: "/tmp" }), { type: "USER_MESSAGE", content: "声明验收" });
  assert.throws(() => reduceSession(state, { type: "PLAN_UPDATED", steps, acceptance: [criterion] }), /PLAN_ACCEPTANCE_UPDATED/);
  const planned = reduceSession(state, { type: "PLAN_ACCEPTANCE_UPDATED", steps, acceptance: [criterion] });
  assert.equal(planned.plan.acceptance[0].status, "pending");
  const updated = reduceSession(planned, { type: "PLAN_UPDATED", steps });
  assert.deepEqual(updated.plan.acceptance, planned.plan.acceptance);
});

test("已声明验收项缺少真实验证时，完成正文及全 completed Plan 均不能冒充通过", async (t) => {
  const { session, host } = await fixture(t);
  await plan(host, session, [criterion]);
  assert.equal(session.state.plan.acceptance[0].status, "pending");
  assert.ok(completionIssues(session.state, "测试全部通过，已经完成").includes("verification_incomplete"));
  assert.throws(() => reduceSession(session.state, { type: "COMPLETED" }), /验收/);
});

test("验收项同Objective不可撤销或换成更弱命令，更新与继续保留，新目标清空", async (t) => {
  const { session, host } = await fixture(t);
  await plan(host, session, [criterion]);
  for (const acceptance of [[], [{ ...criterion, command: "true" }], [{ ...criterion, paths: ["verify.test.js"] }]]) {
    assert.equal((await plan(host, session, acceptance)).ok, false);
  }
  assert.equal((await plan(host, session)).ok, true);
  assert.deepEqual(session.state.plan.acceptance[0].paths, criterion.paths);
  await session.dispatch({ type: "FAILED", error: "暂停", recoverable: true });
  await session.dispatch({ type: "USER_MESSAGE", content: "继续", objectiveMode: "continue" });
  assert.equal(session.state.plan.acceptance[0].id, criterion.id);
  await session.dispatch({ type: "USER_MESSAGE", content: "独立的新任务", objectiveMode: "new" });
  assert.equal(session.state.plan, null);
});

test("run_shell verification_id只接受预声明命令，真实成功结果与occurrence绑定", async (t) => {
  let calls = 0;
  const { session, host } = await fixture(t, { execute: async () => { calls += 1; return { output: "tests passed", exitCode: 0 }; } });
  await plan(host, session, [criterion]);
  const mismatch = await run(host, session, { command: "true" });
  assert.equal(mismatch.ok, false);
  assert.equal(calls, 0);
  const result = await run(host, session);
  assert.equal(result.ok, true, result.result);
  const accepted = session.state.plan.acceptance[0];
  assert.equal(accepted.status, "passed");
  assert.ok(accepted.evidence.sourceCursor > 0);
  assert.equal(accepted.evidence.toolCallId, "same-call");
  const event = session.state.events.findLast((item) => item.type === "tool.completed");
  assert.equal(event.sourceCursor, accepted.evidence.sourceCursor);
  assert.equal(event.verification.id, criterion.id);
  assert.equal(completionIssues(session.state, "完成").includes("verification_incomplete"), false);
});

test("验证后源文件改变、输入失踪或read权限收紧使证据失效", async (t) => {
  const { workspace, session, host } = await fixture(t);
  await plan(host, session, [criterion]);
  await run(host, session);
  assert.equal(session.state.plan.acceptance[0].status, "passed");
  await fs.writeFile(path.join(workspace, "source.js"), "changed source");
  await host.refreshVerification({ session });
  assert.equal(session.state.plan.acceptance[0].status, "stale");
  assert.ok(completionIssues(session.state, "完成").includes("verification_incomplete"));
  await plan(host, session);
  assert.equal(session.state.plan.acceptance[0].status, "stale");
  await run(host, session);
  assert.equal(session.state.plan.acceptance[0].status, "passed");
  await fs.unlink(path.join(workspace, "source.js"));
  await host.refreshVerification({ session });
  assert.equal(session.state.plan.acceptance[0].status, "stale");
});

test("验证期间修改输入及实际退出失败都不能生成passed证据", async (t) => {
  let mode = "mutate";
  const { workspace, session, host } = await fixture(t, { execute: async () => {
    if (mode === "mutate") await fs.writeFile(path.join(workspace, "source.js"), "changed during verification");
    return { output: "assertion output", exitCode: mode === "fail" ? 1 : 0 };
  } });
  await plan(host, session, [criterion]);
  await run(host, session);
  assert.notEqual(session.state.plan.acceptance[0].status, "passed");
  mode = "pass";
  await run(host, session);
  const previousCursor = session.state.plan.acceptance[0].evidence.sourceCursor;
  mode = "fail";
  await run(host, session);
  assert.equal(session.state.plan.acceptance[0].status, "failed");
  assert.ok(session.state.plan.acceptance[0].evidence.sourceCursor > previousCursor);
});

test("验收路径、数量和模型自填 passed 均在声明边界拒绝", async (t) => {
  const { session, host } = await fixture(t);
  for (const acceptance of [
    [{ ...criterion, paths: [] }], [{ ...criterion, paths: ["../outside"] }],
    [{ ...criterion, paths: ["/tmp/outside"] }], [{ ...criterion, paths: ["nested/../source.js"] }],
    [{ ...criterion, status: "passed" }], [{ ...criterion, paths: ["source.js", "source.js"] }],
    Array.from({ length: 21 }, (_, index) => ({ ...criterion, id: `item-${index}` })),
    [{ ...criterion, paths: Array.from({ length: 51 }, (_, index) => `${index}.js`) }],
  ]) assert.equal((await plan(host, session, acceptance)).ok, false);
  assert.equal(session.state.plan, null);
});

test("验收读取遵守Host自定义read deny/approval规则，Shell批准不授予隐式读取", async (t) => {
  for (const decision of ["deny", "approval_required"]) {
    let calls = 0;
    const { host, session } = await fixture(t, {
      execute: async () => { calls += 1; return { exitCode: 0, output: "ok" }; },
      policyRules: { rules: [{ id: "restrict-source", tools: ["read_file"], pathPrefixes: ["source.js"], decision }] },
    });
    await plan(host, session, [criterion]);
    const result = await run(host, session);
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.equal(session.state.plan.acceptance[0].status, "failed");
    assert.deepEqual(session.state.plan.acceptance[0].evidence.inputs, []);
  }
});

test("完成前权限收紧会失效旧证据，Router按当前Host刷新", async (t) => {
  const { host, session, profile } = await fixture(t);
  await plan(host, session, [criterion]);
  await run(host, session);
  host.policy = new WorkspacePolicy({ rules: [{ id: "now-deny", tools: ["read_file"], pathPrefixes: ["source.js"], decision: "deny" }] }, { profile });
  const router = new PermissionToolHostRouter({ hosts: { "workspace-auto": host } });
  await router.refreshVerification({ session });
  assert.equal(session.state.plan.acceptance[0].status, "stale");
  assert.equal(session.state.events.at(-1).type, "verification.invalidated");
});

test("验收不读取受保护凭据、符号链接和超过2MiB的文件", async (t) => {
  const { workspace, host, session } = await fixture(t);
  await fs.mkdir(path.join(workspace, ".aws"));
  await fs.writeFile(path.join(workspace, ".aws/credentials"), "synthetic-secret");
  await fs.symlink("source.js", path.join(workspace, "linked.js"));
  await fs.symlink(".", path.join(workspace, "linked-dir"));
  await fs.writeFile(path.join(workspace, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
  let index = 0;
  for (const file of [".aws/credentials", "linked.js", "linked-dir/source.js", "large.bin"]) {
    const item = { ...criterion, id: `restricted-${index++}`, paths: [file] };
    const earlier = (session.state.plan?.acceptance || []).map(({ id, description, command, paths }) => ({ id, description, command, paths }));
    await plan(host, session, [...earlier, item]);
    assert.equal((await run(host, session, { verification_id: item.id })).ok, false);
    assert.equal(session.state.plan.acceptance.at(-1).status, "failed");
  }
  assert.doesNotMatch(JSON.stringify(session.state), /synthetic-secret/);
});

test("读取期间目录换链或取消会fail closed，不产出文件指纹", async (t) => {
  const { workspace } = await fixture(t);
  await fs.mkdir(path.join(workspace, "nested"));
  await fs.writeFile(path.join(workspace, "nested/input.js"), "allowed");
  await fs.mkdir(path.join(workspace, "alternate"));
  await fs.writeFile(path.join(workspace, "alternate/input.js"), "alternative");
  let reads = 0;
  await assert.rejects(snapshotVerificationInputs({ workspace, paths: ["nested/input.js"], authorizeRead: async () => {
    reads += 1;
    if (reads === 2) {
      await fs.rename(path.join(workspace, "nested"), path.join(workspace, "original"));
      await fs.symlink("alternate", path.join(workspace, "nested"));
    }
    return true;
  } }), /验收/);
  const controller = new AbortController();
  controller.abort(new Error("用户取消"));
  await assert.rejects(snapshotVerificationInputs({ workspace, paths: ["source.js"], authorizeRead: () => true, signal: controller.signal }), /用户取消/);
});

test("验收执行中取消产生实际失败结果，不能保留passed", async (t) => {
  const controller = new AbortController();
  let cancel = false;
  const { host, session } = await fixture(t, { execute: async () => {
    if (cancel) { controller.abort(new Error("用户停止验收")); throw controller.signal.reason; }
    return { exitCode: 0, output: "passed" };
  } });
  await plan(host, session, [criterion]);
  await run(host, session);
  cancel = true;
  await assert.rejects(host.execute({ id: "same-call", name: "run_shell", arguments: { command: criterion.command, verification_id: criterion.id } }, {
    session, signal: controller.signal, requestApproval: async () => true,
  }), /用户停止验收/);
  assert.equal(session.state.plan.acceptance[0].status, "failed");
  assert.equal(session.state.events.findLast((event) => event.type === "tool.completed").ok, false);
});

test("单项验收总输入超过16MiB时拒绝，真实未声明范围不被计为验证通过", async (t) => {
  const { workspace } = await fixture(t);
  const paths = [];
  for (let index = 0; index < 9; index += 1) {
    const file = `input-${index}.bin`;
    await fs.writeFile(path.join(workspace, file), Buffer.alloc(2 * 1024 * 1024));
    paths.push(file);
  }
  await assert.rejects(snapshotVerificationInputs({ workspace, paths, authorizeRead: () => true }), /上限/);
});

test("Adapter忽略取消到Host watchdog结束时，本次unknown结果也会替换旧passed", async (t) => {
  let hang = false;
  const { host, registry, session } = await fixture(t, { execute: async () => hang
    ? new Promise(() => {}) : { exitCode: 0, output: "passed" } });
  // This isolated fixture shortens only the cleanup grace, not production policy.
  registry.get("run_shell").deadline.hostGraceMs = 1;
  await plan(host, session, [criterion]);
  await run(host, session);
  const earlier = session.state.plan.acceptance[0].evidence.sourceCursor;
  hang = true;
  const result = await run(host, session, { timeout_ms: 20 });
  assert.equal(result.status, "execution_unknown");
  assert.equal(session.state.plan.acceptance[0].status, "failed");
  assert.ok(session.state.plan.acceptance[0].evidence.sourceCursor > earlier);
});

test("普通输入在open前换成FIFO不会阻塞验收读取", { skip: process.platform === "win32" }, async (t) => {
  const { workspace } = await fixture(t);
  const target = await fs.realpath(path.join(workspace, "source.js"));
  const originalOpen = fs.open;
  let swapped = false;
  let rescueNeeded = false;
  const rescue = setTimeout(async () => {
    rescueNeeded = true;
    // Release a regressed blocking reader so the failure never hangs the suite.
    const handle = await originalOpen(target, constants.O_RDWR | constants.O_NONBLOCK);
    await handle.close();
  }, 1_000);
  fs.open = async (file, flags, ...args) => {
    if (file === target && !swapped) {
      swapped = true;
      await fs.unlink(target);
      execFileSync("mkfifo", [target]);
    }
    return originalOpen(file, flags, ...args);
  };
  try {
    await assert.rejects(snapshotVerificationInputs({ workspace, paths: ["source.js"], authorizeRead: () => true }), /验收/);
    assert.equal(rescueNeeded, false);
  } finally {
    clearTimeout(rescue);
    fs.open = originalOpen;
  }
});

test("没有真实ToolResult的passed声明在Guard和最终刷新均无效", async (t) => {
  const { host, session } = await fixture(t);
  await plan(host, session, [criterion]);
  await run(host, session);
  const forged = session.state;
  forged.events = forged.events.filter((event) => event.type !== "tool.completed");
  const restored = new AgentSession({ state: forged, reducer: reduceSession });
  assert.ok(completionIssues(restored.state, "完成").includes("verification_incomplete"));
  await host.refreshVerification({ session: restored });
  assert.equal(restored.state.plan.acceptance[0].status, "stale");
});

test("SQLite导出导入与同callId多occurrence仍保留真实证据及失效记录", async (t) => {
  const { workspace, host } = await fixture(t);
  const store = new SessionStore(path.join(workspace, ".nexus/nexus.db"), { workspace });
  t.after(() => store.close());
  const session = new AgentSession({ state: createSession({ provider: "verification-test", workspace }), reducer: reduceSession, journal: store });
  await session.dispatch({ type: "USER_MESSAGE", content: "实现并验收" });
  await plan(host, session, [criterion]);
  await run(host, session);
  const firstCursor = session.state.plan.acceptance[0].evidence.sourceCursor;
  await run(host, session);
  assert.ok(session.state.plan.acceptance[0].evidence.sourceCursor > firstCursor);
  const archive = store.exportJournal(session.id);
  assert.equal(archive.events[0].baseline.schemaVersion, SESSION_SCHEMA_VERSION);
  assert.ok(archive.events.some((event) => event.type === "PLAN_ACCEPTANCE_UPDATED"));
  const imported = store.importJournal(archive, { id: "verification-imported", workspace });
  assert.deepEqual(imported.plan, session.state.plan);
  const restored = new AgentSession({ state: imported, reducer: reduceSession, journal: store });
  await host.refreshVerification({ session: restored });
  assert.equal(restored.state.plan.acceptance[0].status, "passed");
  await fs.writeFile(path.join(workspace, "source.js"), "later change");
  await host.refreshVerification({ session: restored });
  assert.equal(restored.state.plan.acceptance[0].status, "stale");
  assert.deepEqual(store.load(restored.id).plan, restored.state.plan);
});

test("AgentRuntime自动纠正缺证据的提前完成，真实验收后同一用户轮完成", async (t) => {
  const { host, session } = await fixture(t);
  let calls = 0;
  const responses = [
    { text: "先声明", toolCalls: [{ id: "plan", name: "update_plan", arguments: { plan: steps, acceptance: [criterion] } }] },
    { text: "测试已经通过，全部完成", toolCalls: [] },
    { text: "执行验收", toolCalls: [{ id: "verify", name: "run_shell", arguments: { command: criterion.command, verification_id: criterion.id } }] },
    { text: "已完成声明范围的验收", toolCalls: [] },
  ];
  const runtime = new AgentRuntime({ session, toolHost: host, systemPrompt: "完成并验证", maxSteps: 5,
    provider: { name: "offline-verification", complete: async () => { calls += 1; return { ...responses.shift(), usage: { inputTokens: 1, outputTokens: 1 } }; } } });
  await runtime.runTurn("实现并验证", async () => true);
  assert.equal(runtime.state.phase, "completed", runtime.state.lastError);
  assert.equal(calls, 4);
  assert.equal(runtime.state.events.filter((item) => item.type === "session.completion_rejected").length, 1);
  assert.equal(runtime.state.plan.acceptance[0].status, "passed");
});

test("AgentRuntime最终答复前刷新输入版本，验证后写文件不能带旧passed完成", async (t) => {
  const { host, session, workspace } = await fixture(t);
  const responses = [
    { text: "计划", toolCalls: [{ id: "plan", name: "update_plan", arguments: { plan: steps, acceptance: [criterion] } }] },
    { text: "验证", toolCalls: [{ id: "verify", name: "run_shell", arguments: { command: criterion.command, verification_id: criterion.id } }] },
    { text: "完成", toolCalls: [] },
  ];
  const runtime = new AgentRuntime({ session, toolHost: host, systemPrompt: "验证后完成", maxSteps: 3,
    provider: { name: "offline-verification", complete: async () => {
      const response = responses.shift();
      if (responses.length === 0) await fs.writeFile(path.join(workspace, "source.js"), "edited after verification");
      return { ...response, usage: { inputTokens: 1, outputTokens: 1 } };
    } } });
  await runtime.runTurn("完成验证任务", async () => true);
  assert.equal(runtime.state.phase, "failed");
  assert.equal(runtime.state.plan.acceptance[0].status, "stale");
  assert.match(runtime.state.lastError, /任务未通过完成检查/);
});

async function fixture(t, { execute = async () => ({ output: "tests passed", exitCode: 0 }), policyRules = {} } = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-verification-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "source.js"), "initial source");
  await fs.writeFile(path.join(workspace, "verify.test.js"), "initial verification");
  const profile = createPermissionProfile({ name: "workspace-auto", workspace, executionType: "native" });
  const registry = createToolRegistry({ workspace, accessPolicy: profile, workspaceExecution: { id: "native-sandbox", execute } });
  const host = new ToolHost({ registry, policy: new WorkspacePolicy(policyRules, { profile }) });
  const session = new AgentSession({ state: createSession({ provider: "verification-test", workspace }), reducer: reduceSession });
  await session.dispatch({ type: "USER_MESSAGE", content: "实现并验证源文件" });
  return { workspace, profile, registry, host, session };
}

function plan(host, session, acceptance) {
  return host.execute({ id: "plan", name: "update_plan", arguments: { plan: steps, ...(acceptance !== undefined ? { acceptance } : {}) } }, { session, requestApproval: async () => true });
}

function run(host, session, overrides = {}) {
  return host.execute({ id: "same-call", name: "run_shell", arguments: { command: criterion.command, verification_id: criterion.id, ...overrides } }, { session, requestApproval: async () => true });
}
