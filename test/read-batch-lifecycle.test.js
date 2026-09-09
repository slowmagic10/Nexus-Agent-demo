import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { revokeSessionGrant, WorkspacePolicy } from "../src/tools/authorization.js";
import { ToolHost } from "../src/tools/host.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { PermissionToolHostRouter } from "../src/tools/permission-router.js";
import { createToolRegistry } from "../src/tools/registry.js";

const options = { timeout: 5000 };
const deferred = () => Promise.withResolvers();
const read = (id) => ({ id, name: "read_file", arguments: { path: `${id}.txt` } });

async function fixture(t) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nexus-read-lifecycle-")));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const profile = createPermissionProfile({ name: "workspace-auto", workspace, executionType: "local" });
  const policy = new WorkspacePolicy({}, { profile });
  const session = new AgentSession({ state: createSession({ id: "lifecycle", provider: "offline", workspace, permissionProfile: profile.name }), reducer: reduceSession, journal: store });
  const registry = createToolRegistry({ workspace, accessPolicy: profile, artifactStore: store.artifacts });
  const host = new ToolHost({ registry, policy, artifactStore: store.artifacts });
  const events = [], cleanup = [], pending = [];
  session.subscribeEvents((event) => events.push(event));
  await Promise.all(["a", "b", "c"].map((id) => fs.writeFile(path.join(workspace, `${id}.txt`), `body-${id}`)));
  t.after(async () => {
    cleanup.forEach((fn) => fn());
    await Promise.allSettled(pending);
    await session.drain(); session.close(); store.close(); await fs.rm(workspace, { recursive: true, force: true });
  });
  return { workspace, store, profile, policy, session, registry, host, events, cleanup, track(promise) { pending.push(promise); return promise; } };
}

function runtimeFor(f, calls) {
  let modelCalls = 0;
  const runtime = new AgentRuntime({ session: f.session, toolHost: f.host, systemPrompt: () => "读取文件。", provider: {
    name: "offline-lifecycle", complete: async () => { modelCalls++; return modelCalls === 1
      ? { text: "", toolCalls: calls, finishReason: "tool_calls" }
      : { text: "任务已完成。", toolCalls: [], finishReason: "stop" }; },
  } });
  return { runtime, get modelCalls() { return modelCalls; } };
}

function assertSources(f) {
  const requests = new Map(f.events.filter((event) => event.type === "TOOL_REQUESTED").map((event) => [event.cursor, event.action.call]));
  for (const event of f.events.filter((event) => event.type === "TOOL_RESULT")) {
    assert.deepEqual(requests.get(event.action.sourceCursor), event.action.call);
    assert.ok(event.action.sourceCursor < event.cursor);
  }
}

test("TOOL_REQUESTED 持久化后 available 变为 false，预检计划不启动实现", options, async (t) => {
  const f = await fixture(t);
  let executions = 0;
  const tool = f.registry.get("read_file");
  tool.available = () => true;
  tool.execute = async () => { executions++; return "unexpected"; };
  const plan = f.host.prepareParallelRead(read("a"), { session: f.session });
  f.session.subscribeEvents((event) => { if (event.type === "TOOL_REQUESTED") tool.available = () => false; });
  const outcome = await plan.run();
  assert.equal(outcome.result.status, "capability_unavailable");
  assert.equal(executions, 0);
  await f.session.dispatch(outcome.action);
  assert.equal(f.events.some((event) => event.type === "TOOL_EXECUTION_STARTED"), false);
  assertSources(f);
});

for (const mutation of ["version", "policy-throws", "definition-throws"]) {
  test(`acquire 后 ${mutation} 异常路径仍归还全部 lease`, options, async (t) => {
    const f = await fixture(t);
    let executions = 0, acquired = 0, released = 0;
    const tool = f.registry.get("read_file");
    tool.execute = async () => { executions++; return "unexpected"; };
    const acquire = f.registry.acquire;
    f.registry.acquire = (...args) => {
      const lease = acquire(...args);
      acquired++;
      if (mutation === "policy-throws") f.policy.authorize = () => { throw new Error("authorization unavailable"); };
      if (mutation === "definition-throws") tool.timeoutMs = -1;
      return { ...lease, release: () => { released++; return lease.release(); } };
    };
    if (mutation === "version") f.session.subscribeEvents((event) => { if (event.type === "TOOL_AUTHORIZATION_DECIDED") tool.parallelRead = false; });
    const plan = f.host.prepareParallelRead(read("a"), { session: f.session });
    const outcome = await plan.run();
    assert.equal(acquired, 1);
    assert.equal(released, 1);
    assert.equal(executions, 0);
    assert.ok(outcome.action);
    assert.notEqual(outcome.result?.status, "completed");
    await f.session.dispatch(outcome.action);
    assertSources(f);
  });
}

for (const position of ["tail", "before-write"]) {
  test(`单项读取组 ${position} 取消仍等待原生 finally，串行写入不越过取消`, options, async (t) => {
    const f = await fixture(t);
    const entered = deferred(), aborted = deferred(), cleanup = deferred();
    f.cleanup.push(() => cleanup.resolve());
    let cleaned = false, settled = false, writes = 0;
    const original = f.registry.get("read_file").execute;
    f.registry.get("read_file").execute = async (args, context) => {
      try {
        await original(args, context);
        entered.resolve();
        await new Promise((resolve, reject) => {
          const cancel = () => { aborted.resolve(); reject(context.signal.reason); };
          if (context.signal.aborted) cancel(); else context.signal.addEventListener("abort", cancel, { once: true });
        });
      } finally { await cleanup.promise; cleaned = true; }
    };
    f.registry.get("write_file").execute = async () => { writes++; return "unexpected"; };
    const calls = [read("a"), ...(position === "before-write" ? [{ id: "write", name: "write_file", arguments: { path: "new.txt", content: "no" } }] : [])];
    const { runtime } = runtimeFor(f, calls);
    const pending = f.track(runtime.runTurn("读取文件", async () => false).then((state) => { settled = true; return state; }));
    await entered.promise;
    runtime.cancel("单项组取消");
    await aborted.promise;
    await immediate();
    assert.equal(settled, false);
    assert.equal(cleaned, false);
    assert.equal(f.events.some((event) => event.type === "CANCELLED"), false);
    cleanup.resolve();
    await pending;
    assert.equal(cleaned, true);
    assert.equal(writes, 0);
    assert.equal(runtime.state.phase, "cancelled");
    assert.equal(f.events.find((event) => event.type === "TOOL_RESULT").action.status, "cancelled");
    assertSources(f);
  });
}

test("Permission Router 在读取组后重新选择权限 Host，后续写入遵守新 read-only 档位", options, async (t) => {
  const f = await fixture(t);
  const readOnly = createPermissionProfile({ name: "read-only", workspace: f.workspace, executionType: "local" });
  const readRegistry = createToolRegistry({ workspace: f.workspace, accessPolicy: readOnly });
  const restricted = new ToolHost({ registry: readRegistry, policy: new WorkspacePolicy({}, { profile: readOnly }) });
  const router = new PermissionToolHostRouter({ hosts: { "workspace-auto": f.host, "read-only": restricted } });
  let writes = 0;
  for (const registry of [f.registry, readRegistry]) registry.get("write_file").execute = async () => { writes++; return "unexpected"; };
  f.session.subscribeEvents((event) => {
    if (event.type === "TOOL_RESULT" && event.action.call.id === "b") {
      f.track(f.session.dispatch({ type: "PERMISSION_PROFILE_DOWNGRADED", profile: "read-only", reason: "offline-test-policy-change" }));
    }
  });
  const result = await router.executeBatch([read("a"), read("b"), { id: "write", name: "write_file", arguments: { path: "new.txt", content: "no" } }], { session: f.session });
  assert.equal(f.session.state.permissionProfile, "read-only");
  assert.equal(result[2].status, "policy_denied");
  assert.equal(writes, 0);
  assertSources(f);
});

for (const cancel of [false, true]) {
  test(`工具结果持久化失败仍 join 其他读取并提交可用结果，${cancel ? "取消" : "暂停"}时不伪称未执行`, options, async (t) => {
    const f = await fixture(t);
    const gates = [deferred(), deferred(), deferred()], entered = [deferred(), deferred(), deferred()], done = [];
    f.cleanup.push(() => gates.forEach((gate) => gate.resolve()));
    let starts = 0, settled = false;
    const original = f.registry.get("read_file").execute;
    f.registry.get("read_file").execute = async (args, context) => {
      const index = starts++;
      try { const result = await original(args, context); entered[index].resolve(); await gates[index].promise; return result; }
      finally { done.push(index); }
    };
    const commit = f.store.commitSessionEvent.bind(f.store);
    const attempted = [];
    f.store.commitSessionEvent = (state, action, patch) => {
      if (action.type === "TOOL_RESULT") {
        attempted.push(action.call.id);
        if (action.call.id === "a") throw new Error("injected result commit failure");
      }
      return commit(state, action, patch);
    };
    const setup = runtimeFor(f, [read("a"), read("b"), read("c")]);
    const pending = f.track(setup.runtime.runTurn("读取三个文件", async () => false).then((state) => { settled = true; return state; }));
    await Promise.all(entered.map((item) => item.promise));
    if (cancel) setup.runtime.cancel("取消同时发生持久化失败");
    gates[0].resolve(); gates[2].resolve();
    await immediate();
    assert.equal(settled, false);
    assert.deepEqual(attempted, []);
    gates[1].resolve();
    await pending;
    assert.deepEqual(done.sort(), [0, 1, 2]);
    assert.deepEqual(attempted, ["a", "b", "c"]);
    assert.deepEqual(f.events.filter((event) => event.type === "TOOL_RESULT").map((event) => event.action.call.id), ["b", "c"]);
    assert.equal(setup.modelCalls, 1);
    const state = setup.runtime.state;
    assert.equal(state.phase, cancel ? "cancelled" : "failed");
    if (!cancel) {
      assert.equal(state.objective.status, "paused");
      assert.ok(state.events.some((event) => event.type === "objective.paused" && event.reason === "tool_batch_failed"));
    }
    const missing = state.messages.find((message) => message.role === "tool" && message.tool_call_id === "a");
    assert.match(missing.content, /结果未能完整记录.*不会自动重放/);
    assert.doesNotMatch(missing.content, /没有执行|尚未启动|未执行|已停止等待/);
    assertSources(f);
    assert.deepEqual(f.store.load(f.session.id), state);
  });
}

for (const mutation of ["none", "revoke", "expire", "policy"]) {
  test(`一次读取 Grant 限定原路径且保持 consumed，${mutation} 变化按当前授权判断`, options, async (t) => {
    const f = await fixture(t);
    if (mutation === "expire") t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    f.policy.replace({ rules: [{ id: "approve-read", tools: ["read_file"], decision: "approval_required" }] });
    const original = f.registry.get("read_file").execute;
    let executions = 0, usedGrant, capturedGuard;
    f.registry.get("read_file").execute = async (args, context) => {
      executions++;
      capturedGuard = context.authorizeRead;
      usedGrant = f.session.state.toolGrants.at(-1);
      assert.ok(usedGrant.consumedAt);
      assert.equal(usedGrant.consumedByCallId, "a");
      assert.equal(context.authorizeRead("a.txt"), true);
      assert.equal(context.authorizeRead("b.txt"), false);
      if (mutation === "revoke") await revokeSessionGrant(f.session, usedGrant.id, "撤销读取");
      if (mutation === "expire") t.mock.timers.tick(301_000);
      if (mutation === "policy") f.policy.replace({ rules: [{ id: "deny-now", tools: ["read_file"], decision: "deny" }] });
      assert.equal(context.authorizeRead("a.txt"), mutation === "none");
      return original(args, context);
    };
    let approvals = 0;
    const first = await f.host.executeBatch([read("a")], { session: f.session, requestApproval: async () => { approvals++; return true; } });
    assert.equal(first[0].status, mutation === "none" ? "completed" : "external_failed");
    assert.equal(capturedGuard("a.txt"), false, "已退出工具的旧授权闭包不可继续读取");
    const stored = f.session.state.toolGrants.find((grant) => grant.id === usedGrant.id);
    assert.equal(stored.consumedAt, usedGrant.consumedAt);
    assert.equal(stored.consumedByCallId, "a");
    const replay = await f.host.executeBatch([read("a")], { session: f.session, requestApproval: async () => { approvals++; return false; } });
    assert.equal(replay[0].ok, false);
    assert.equal(executions, 1);
    assert.equal(approvals, mutation === "policy" ? 1 : 2);
    assertSources(f);
  });
}

test("Gateway 从部分读取请求及启动日志恢复，不自动重放且历史保留真实 sourceCursor", options, async (t) => {
  const f = await fixture(t);
  const calls = [read("a"), read("b"), read("c")];
  await f.session.dispatch({ type: "USER_MESSAGE", content: "读取三个文件" });
  await f.session.dispatch({ type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "", tool_calls: calls.map((call) => ({
    id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  })) } });
  const receipts = await Promise.all(calls.map((call) => f.session.dispatchWithReceipt({ type: "TOOL_REQUESTED", call, effects: ["read"], idempotency: "safe", adapter: "native" })));
  await Promise.all(calls.slice(0, 2).map((call) => f.session.dispatch({ type: "TOOL_EXECUTION_STARTED", call, effects: ["read"], idempotency: "safe", adapter: "native" })));
  const checkpoint = f.store.load(f.session.id);
  assert.equal(checkpoint.phase, "executing");
  await f.session.drain();
  f.session.close();
  let executions = 0, modelCalls = 0;
  f.registry.get("read_file").execute = async () => { executions++; throw new Error("恢复不应执行工具"); };
  const manager = new GatewaySessionManager({ workspace: f.workspace, store: f.store, tools: f.registry, toolHost: f.host,
    defaultPermissionProfile: "workspace-auto", systemPrompt: () => "恢复文件读取任务。",
    provider: { name: "offline", complete: async () => { modelCalls++; throw new Error("恢复不应请求模型"); } },
  });
  try {
    const state = await manager.create({ resume: f.session.id });
    assert.equal(state.phase, "idle");
    assert.equal(state.objective.status, "paused");
    assert.equal(executions, 0);
    assert.equal(modelCalls, 0);
    const tools = state.messages.filter((message) => message.role === "tool");
    assert.equal(tools.length, 3);
    assert.match(tools[0].content, /执行状态未知.*不会自动重放/);
    assert.match(tools[1].content, /执行状态未知.*不会自动重放/);
    assert.match(tools[2].content, /尚未开始执行.*不会自动重放/);
    const entry = await manager.ensureLoaded(state.id);
    const history = entry.session.queryToolHistory({});
    assert.deepEqual(history.occurrences.map((item) => item.sourceCursor), receipts.map((item) => item.cursor));
    for (const [index, item] of history.occurrences.entries()) {
      const detail = entry.session.queryToolHistory({ source_cursor: item.sourceCursor, snapshot_cursor: history.snapshotCursor });
      const record = JSON.parse(detail.page.content);
      assert.deepEqual(record.request.arguments, calls[index].arguments);
      assert.equal(record.result, null, "恢复说明不能伪造实际 TOOL_RESULT 或原文件内容");
    }
    assert.deepEqual(f.store.load(state.id), state);
  } finally { await manager.close(); }
});
