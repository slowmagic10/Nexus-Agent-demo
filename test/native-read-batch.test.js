import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { createSessionGrant, issueSessionGrant, normalizeCapability, WorkspacePolicy } from "../src/tools/authorization.js";
import { ToolHost } from "../src/tools/host.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { createToolRegistry } from "../src/tools/registry.js";

const options = { timeout: 5000 };
const call = (id, file = `${id}.txt`) => ({ id, name: "read_file", arguments: { path: file } });
const deferred = () => Promise.withResolvers();

async function fixture(t, count = 12) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nexus-native-batch-")));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const profile = createPermissionProfile({ name: "workspace-auto", workspace, executionType: "local" });
  const policy = new WorkspacePolicy({}, { profile });
  const session = new AgentSession({
    state: createSession({ id: "batch", provider: "offline", workspace, permissionProfile: profile.name }),
    reducer: reduceSession, journal: store,
  });
  const events = [];
  session.subscribeEvents((event) => events.push(event));
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts, accessPolicy: profile });
  const host = new ToolHost({ registry, policy, artifactStore: store.artifacts });
  await Promise.all(Array.from({ length: count }, (_, index) => fs.writeFile(path.join(workspace, `${index}.txt`), `file-${index}`)));
  t.after(async () => { await session.drain(); session.close(); store.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  return { workspace, store, profile, policy, session, events, registry, host };
}

function controlledReads(t, registry, count) {
  const original = registry.get("read_file").execute;
  const slots = Array.from({ length: count }, () => ({ entered: deferred(), gate: deferred(), finished: deferred() }));
  const starts = [], finishes = [], contexts = [];
  let active = 0, maxActive = 0;
  registry.get("read_file").execute = async (args, context) => {
    const index = starts.length;
    const slot = slots[index];
    assert.ok(slot, "未预期的额外文件读取");
    starts.push(args.path);
    contexts.push(context);
    active++;
    maxActive = Math.max(maxActive, active);
    slot.entered.resolve();
    try { await slot.gate.promise; return await original(args, context); }
    finally { active--; finishes.push(args.path); slot.finished.resolve(); }
  };
  t.after(() => slots.forEach((slot) => slot.gate.resolve()));
  return { slots, starts, finishes, contexts, get active() { return active; }, get maxActive() { return maxActive; } };
}

function assertSourceCursors(events) {
  const requests = new Map(events.filter((event) => event.type === "TOOL_REQUESTED").map((event) => [event.cursor, event.action.call]));
  for (const event of events.filter((event) => event.type === "TOOL_RESULT")) {
    const request = requests.get(event.action.sourceCursor);
    assert.ok(request, `结果 ${event.action.call.id} 必须指向实际 TOOL_REQUESTED`);
    assert.deepEqual(event.action.call, request);
    assert.ok(event.action.sourceCursor < event.cursor);
  }
}

test("Tool Host 串行和并行请求只取游标回执，仍绑定真实日志位置", options, async (t) => {
  const f = await fixture(t, 3);
  const dispatch = f.session.dispatchWithReceipt.bind(f.session);
  const requests = [];
  f.session.dispatchWithReceipt = async (action, receiptOptions) => {
    const receipt = await dispatch(action, receiptOptions);
    if (action.type === "TOOL_REQUESTED") {
      assert.deepEqual(receiptOptions, { includeState: false });
      assert.deepEqual(Object.keys(receipt), ["cursor"]);
      requests.push(receipt.cursor);
    }
    return receipt;
  };
  assert.equal((await f.host.execute(call("0"), { session: f.session })).ok, true);
  assert.ok((await f.host.executeBatch([call("1"), call("2")], { session: f.session })).every((result) => result.ok));
  assert.equal(requests.length, 3);
  assertSourceCursors(f.events);
  assert.deepEqual(f.store.load(f.session.id), f.session.state);
});

test("原生读取每组三个并发，四组受限且反序完成仍按请求顺序写入结果", options, async (t) => {
  const f = await fixture(t);
  const reads = controlledReads(t, f.registry, 12);
  const calls = Array.from({ length: 12 }, (_, index) => call(String(index)));
  const pending = f.host.executeBatch(calls, { session: f.session });
  for (let base = 0; base < 12; base += 3) {
    await Promise.all(reads.slots.slice(base, base + 3).map((slot) => slot.entered.promise));
    assert.equal(reads.starts.length, base + 3);
    assert.equal(reads.active, 3);
    for (let index = base + 2; index >= base; index--) {
      reads.slots[index].gate.resolve();
      await reads.slots[index].finished.promise;
      if (index > base) {
        await immediate();
        assert.equal(reads.starts.length, base + 3, "下一组不能越过未收束的读取");
        assert.equal(f.events.filter((event) => event.type === "TOOL_RESULT").length, base);
      }
    }
  }
  const results = await pending;
  assert.equal(reads.maxActive, 3);
  assert.deepEqual(reads.finishes.slice(0, 3), ["2.txt", "1.txt", "0.txt"]);
  assert.deepEqual(results.map((result) => result.result), calls.map((_, index) => `file-${index}`));
  assert.deepEqual(f.session.state.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id), calls.map((item) => item.id));
  assertSourceCursors(f.events);
  for (const context of reads.contexts) {
    assert.ok(Object.isFrozen(context));
    for (const key of ["dispatch", "onOutput", "recordVerification", "queryToolHistory"]) assert.equal(key in context, false);
  }
});

test("串行写入等待前一读取组收束，后续读取才能看到新文件", options, async (t) => {
  const f = await fixture(t, 4);
  const reads = controlledReads(t, f.registry, 4);
  const originalWrite = f.registry.get("write_file").execute;
  let writes = 0;
  f.registry.get("write_file").execute = async (args, context) => {
    writes++;
    assert.equal(reads.active, 0);
    assert.equal(reads.finishes.length, 2);
    return originalWrite(args, context);
  };
  const calls = [call("0"), call("1"), { id: "write", name: "write_file", arguments: { path: "2.txt", content: "updated" } }, call("2"), call("3")];
  const pending = f.host.executeBatch(calls, { session: f.session });
  await Promise.all(reads.slots.slice(0, 2).map((slot) => slot.entered.promise));
  reads.slots[1].gate.resolve();
  await reads.slots[1].finished.promise;
  await immediate();
  assert.equal(writes, 0);
  reads.slots[0].gate.resolve();
  await Promise.all(reads.slots.slice(2).map((slot) => slot.entered.promise));
  assert.equal(writes, 1);
  reads.slots.slice(2).forEach((slot) => slot.gate.resolve());
  const results = await pending;
  assert.equal(results[3].result, "updated");
  assert.deepEqual(f.events.filter((event) => event.type === "TOOL_RESULT").map((event) => event.action.call.id), calls.map((item) => item.id));
  assertSourceCursors(f.events);
});

test("一个读取失败不丢弃同组结果，也不阻断下一组", options, async (t) => {
  const f = await fixture(t, 4);
  const results = await f.host.executeBatch([call("0"), call("missing"), call("2"), call("3")], { session: f.session });
  assert.deepEqual(results.map((result) => result.status), ["completed", "external_failed", "completed", "completed"]);
  assert.deepEqual(results.filter((result) => result.ok).map((result) => result.result), ["file-0", "file-2", "file-3"]);
  assertSourceCursors(f.events);
});

test("重复 call ID 跨组串行隔离，历史查询仍绑定每次真实请求", options, async (t) => {
  const f = await fixture(t, 6);
  const reads = controlledReads(t, f.registry, 6);
  const calls = [call("same", "0.txt"), call("other", "1.txt"), call("same", "2.txt"), call("other", "3.txt"), call("same", "4.txt"), call("other", "5.txt")];
  const pending = f.host.executeBatch(calls, { session: f.session });
  for (let base = 0; base < 6; base += 2) {
    await Promise.all(reads.slots.slice(base, base + 2).map((slot) => slot.entered.promise));
    assert.equal(reads.starts.length, base + 2);
    reads.slots[base + 1].gate.resolve();
    await reads.slots[base + 1].finished.promise;
    reads.slots[base].gate.resolve();
  }
  await pending;
  assert.equal(reads.maxActive, 2);
  assertSourceCursors(f.events);
  const history = f.session.queryToolHistory({ call_id: "same" });
  assert.equal(history.occurrences.length, 3);
  for (const [index, occurrence] of history.occurrences.entries()) {
    const record = f.session.queryToolHistory({ source_cursor: occurrence.sourceCursor, snapshot_cursor: history.snapshotCursor });
    assert.equal(JSON.parse(record.page.content).result.content, `file-${index * 2}`);
  }
});

test("相邻重复 call ID 先单独执行首项，再并发后续不同 ID", options, async (t) => {
  const f = await fixture(t, 3);
  const reads = controlledReads(t, f.registry, 3);
  const pending = f.host.executeBatch([call("same", "0.txt"), call("same", "1.txt"), call("last", "2.txt")], { session: f.session });
  await reads.slots[0].entered.promise;
  await immediate();
  assert.equal(reads.starts.length, 1);
  reads.slots[0].gate.resolve();
  await Promise.all(reads.slots.slice(1).map((slot) => slot.entered.promise));
  assert.equal(reads.active, 2);
  reads.slots.slice(1).forEach((slot) => slot.gate.resolve());
  const results = await pending;
  assert.deepEqual(results.map((result) => result.result), ["file-0", "file-1", "file-2"]);
  assertSourceCursors(f.events);
  const history = f.session.queryToolHistory({ call_id: "same" });
  assert.equal(history.occurrences.length, 2);
  for (const [index, occurrence] of history.occurrences.entries()) {
    const record = f.session.queryToolHistory({ source_cursor: occurrence.sourceCursor, snapshot_cursor: history.snapshotCursor });
    assert.equal(JSON.parse(record.page.content).result.content, `file-${index}`);
  }
});

test("真实 AgentRuntime 自动使用读取批次，下一模型请求保持原有工具结果顺序", options, async (t) => {
  const f = await fixture(t, 3);
  const reads = controlledReads(t, f.registry, 3);
  const requests = [];
  const runtime = new AgentRuntime({ session: f.session, toolHost: f.host, systemPrompt: () => "完成读取。", provider: {
    name: "offline-batch", complete: async (request) => {
      requests.push(request);
      return requests.length === 1 ? { text: "", finishReason: "tool_calls", toolCalls: [call("0"), call("1"), call("2")] }
        : { text: "已读取三个文件，任务完成。", finishReason: "stop", toolCalls: [] };
    },
  } });
  const pending = runtime.runTurn("读取三个文件", async () => false);
  await Promise.all(reads.slots.map((slot) => slot.entered.promise));
  assert.equal(reads.active, 3);
  for (const index of [2, 1, 0]) { reads.slots[index].gate.resolve(); await reads.slots[index].finished.promise; }
  await pending;
  assert.equal(runtime.state.phase, "completed", runtime.state.lastError);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.filter((message) => message.role === "tool").map((message) => message.content), ["file-0", "file-1", "file-2"]);
  assertSourceCursors(f.events);
});

test("取消等待所有原生 finally 清理和 lease 释放，随后闭合结果及 Runtime 终态", options, async (t) => {
  const f = await fixture(t, 4);
  const entered = [deferred(), deferred(), deferred()], cleanup = [deferred(), deferred(), deferred()];
  const trace = [];
  let starts = 0, modelCalls = 0;
  const original = f.registry.get("read_file").execute;
  f.registry.get("read_file").execute = async (args, context) => {
    const index = starts++;
    assert.ok(index < 3);
    try {
      await original(args, context);
      entered[index].resolve();
      await new Promise((resolve, reject) => {
        if (context.signal.aborted) reject(context.signal.reason);
        else context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    } finally { await cleanup[index].promise; trace.push(`cleanup-${index}`); }
  };
  t.after(() => cleanup.forEach((item) => item.resolve()));
  const acquire = f.registry.acquire;
  let leaseIndex = 0;
  f.registry.acquire = (...args) => {
    const lease = acquire(...args), index = leaseIndex++;
    return { ...lease, release: () => { assert.ok(trace.includes(`cleanup-${index}`)); trace.push(`release-${index}`); return lease.release(); } };
  };
  f.session.subscribeEvents((event) => { if (["TOOL_RESULT", "CANCELLED"].includes(event.type)) trace.push(event.type); });
  const runtime = new AgentRuntime({ session: f.session, toolHost: f.host, systemPrompt: () => "读取文件。", provider: {
    name: "offline-cancel", complete: async () => { modelCalls++; return { text: "", finishReason: "tool_calls", toolCalls: [call("0"), call("1"), call("2"), call("3")] }; },
  } });
  const pending = runtime.runTurn("读取四个文件", async () => false);
  await Promise.all(entered.map((item) => item.promise));
  runtime.cancel("取消读取测试");
  await immediate();
  assert.equal(trace.includes("CANCELLED"), false);
  assert.equal(trace.includes("TOOL_RESULT"), false);
  cleanup[2].resolve(); cleanup[0].resolve();
  await immediate();
  assert.equal(trace.includes("CANCELLED"), false);
  assert.equal(trace.includes("TOOL_RESULT"), false);
  cleanup[1].resolve();
  await pending;
  assert.equal(starts, 3);
  assert.equal(modelCalls, 1);
  assert.equal(runtime.state.phase, "cancelled");
  assert.equal(trace.at(-1), "CANCELLED");
  assert.ok(trace.indexOf("TOOL_RESULT") > Math.max(...[0, 1, 2].map((index) => trace.indexOf(`release-${index}`))));
  assert.equal(f.events.filter((event) => event.type === "TOOL_RESULT").length, 3);
  assert.equal(runtime.state.messages.filter((message) => message.role === "tool").length, 4, "未启动的第四个调用也需闭合 Provider 协议");
  assertSourceCursors(f.events);
});

test("原生并发读取超时后仍等待 finally 收束，保留每项 timeout 结果", options, async (t) => {
  const f = await fixture(t, 2);
  const aborted = [deferred(), deferred()], cleanup = [deferred(), deferred()];
  const trace = [];
  let starts = 0, completed = false;
  f.registry.get("read_file").timeoutMs = 10;
  const original = f.registry.get("read_file").execute;
  f.registry.get("read_file").execute = async (args, context) => {
    const index = starts++;
    try {
      await original(args, context);
      await new Promise((resolve, reject) => {
        if (context.signal.aborted) reject(context.signal.reason);
        else context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    } finally { aborted[index].resolve(); await cleanup[index].promise; trace.push(index); }
  };
  t.after(() => cleanup.forEach((item) => item.resolve()));
  const pending = f.host.executeBatch([call("0"), call("1")], { session: f.session }).then((value) => { completed = true; return value; });
  await Promise.all(aborted.map((item) => item.promise));
  assert.equal(completed, false);
  assert.equal(f.events.filter((event) => event.type === "TOOL_RESULT").length, 0);
  cleanup[1].resolve();
  await immediate();
  assert.equal(completed, false);
  cleanup[0].resolve();
  const results = await pending;
  assert.deepEqual(trace, [1, 0]);
  assert.deepEqual(results.map((result) => result.status), ["timeout", "timeout"]);
  assertSourceCursors(f.events);
});

test("需要审批或一次 Grant 的读取保留串行授权、消费和上下文", options, async (t) => {
  const f = await fixture(t, 2);
  f.policy.replace({ rules: [{ id: "read-approval", tools: ["read_file"], decision: "approval_required" }] });
  const first = call("0"), second = call("1");
  const raw = f.registry.get("read_file");
  const argsHash = createHash("sha256").update(JSON.stringify(first.arguments)).digest("hex");
  const auth = f.policy.authorize({ definition: { ...raw, capability: normalizeCapability(raw) }, call: first, state: f.session.state, argsHash });
  const grant = createSessionGrant({ sessionId: f.session.id, workspace: f.workspace, tool: first.name,
    capabilityHash: auth.capabilityHash, policyVersion: auth.policyVersion, resources: auth.resources, callId: first.id, argsHash });
  await issueSessionGrant(f.session, grant);
  assert.equal(f.host.prepareParallelRead(first, { session: f.session }), null);
  assert.equal(f.host.prepareParallelRead(second, { session: f.session }), null);
  const reads = controlledReads(t, f.registry, 2);
  let approvals = 0;
  const pending = f.host.executeBatch([first, second], { session: f.session, requestApproval: async () => { approvals++; return true; } });
  await reads.slots[0].entered.promise;
  assert.equal(approvals, 0);
  assert.equal(reads.starts.length, 1);
  reads.slots[0].gate.resolve();
  await reads.slots[1].entered.promise;
  assert.equal(approvals, 1);
  reads.slots[1].gate.resolve();
  const results = await pending;
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  assert.equal(reads.maxActive, 1);
  assert.ok(reads.contexts.every((context) => typeof context.dispatch === "function"));
  assert.equal(f.session.state.toolGrants.find((item) => item.id === grant.id).consumedByCallId, first.id);
  assertSourceCursors(f.events);
});

test("只读批次不接纳其他工具、外部登记、扩展副作用及无原子 receipt 的 Session", options, async (t) => {
  const f = await fixture(t, 1);
  for (const name of ["list_files", "search_files", "read_artifact", "read_tool_history", "memory_search", "write_file", "run_shell", "mcp_read"]) {
    assert.equal(f.host.prepareParallelRead({ id: name, name, arguments: {} }, { session: f.session }), null, name);
  }
  const raw = f.registry.get("read_file");
  for (const change of [{ parallelRead: false }, { adapter: "mcp" }, { approval: "always" }, { idempotency: "unknown" }, { effects: ["read", "state"] }, { changeTracking: { kind: "paths", arguments: ["path"] } }]) {
    const before = { ...raw };
    Object.assign(raw, change);
    assert.equal(f.host.prepareParallelRead(call("0"), { session: f.session }), null, JSON.stringify(change));
    Object.keys(raw).forEach((key) => delete raw[key]); Object.assign(raw, before);
  }
  const resolve = f.registry.resolve;
  f.registry.resolve = (name) => ({ ...resolve(name), owner: "plugin:external" });
  assert.equal(f.host.prepareParallelRead(call("0"), { session: f.session }), null);
  f.registry.resolve = resolve;
  assert.equal(f.host.prepareParallelRead(call("0"), { session: { state: f.session.state, dispatch: f.session.dispatch.bind(f.session) } }), null);
  assert.equal(f.host.prepareParallelRead({ ...call("0"), arguments: { path: 1 } }, { session: f.session }), null);
  assert.equal(f.host.prepareParallelRead(call("secret", ".env"), { session: f.session }), null);
});

test("自定义Artifact写入适配器不被原生读取隐式并行调用", options, async (t) => {
  const f = await fixture(t, 2);
  await Promise.all(["0", "1"].map((id) => fs.writeFile(path.join(f.workspace, `${id}.txt`), id.repeat(14000))));
  const put = f.store.artifacts.put.bind(f.store.artifacts);
  let activePuts = 0, maxPuts = 0;
  f.store.artifacts.put = async (...args) => {
    activePuts++; maxPuts = Math.max(maxPuts, activePuts);
    try { await immediate(); return await put(...args); }
    finally { activePuts--; }
  };
  assert.equal(f.host.prepareParallelRead(call("0"), { session: f.session }), null);
  const reads = controlledReads(t, f.registry, 2);
  const pending = f.host.executeBatch([call("0"), call("1")], { session: f.session });
  await reads.slots[0].entered.promise;
  assert.equal(reads.starts.length, 1);
  reads.slots[0].gate.resolve();
  await reads.slots[1].entered.promise;
  reads.slots[1].gate.resolve();
  const results = await pending;
  assert.ok(results.every((result) => result.ok && result.artifact));
  assert.equal(reads.maxActive, 1);
  assert.equal(maxPuts, 1);
});

test("准入后Artifact适配器发生变化时不进入原生并行执行", options, async (t) => {
  const f = await fixture(t, 1);
  const plan = f.host.prepareParallelRead(call("0"), { session: f.session });
  assert.ok(plan);
  let reads = 0, writes = 0;
  const original = f.registry.get("read_file").execute;
  // Keep the admitted execute identity; the observer only counts actual starts.
  f.session.subscribeEvents((event) => { if (event.type === "TOOL_EXECUTION_STARTED") reads++; });
  f.store.artifacts.put = async () => { writes++; throw new Error("custom adapter must not run"); };
  const outcome = await plan.run();
  assert.equal(outcome.result.ok, false);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(f.registry.get("read_file").execute, original);
});

for (const mutation of ["policy", "registration", "execute", "arguments", "late-execute"]) {
  test(`准入后 ${mutation} 变化不能启动替代写入或改变原请求`, options, async (t) => {
    const f = await fixture(t, 1);
    let writes = 0;
    const replacement = async () => { writes++; await fs.writeFile(path.join(f.workspace, "should-not-exist.txt"), "bad"); return "replacement"; };
    const input = call("0");
    const plan = f.host.prepareParallelRead(input, { session: f.session });
    assert.ok(plan);
    if (mutation === "policy") f.policy.replace({ rules: [{ id: "new-deny", tools: ["read_file"], decision: "deny" }] });
    if (mutation === "registration") {
      const original = f.registry.get("read_file");
      await f.registry.capabilityRuntime.revoke(f.registry.resolve("read_file").registrationId);
      f.registry.capabilityRuntime.register({ kind: "tool", name: "read_file", owner: "nexus:native-tools", value: { ...original, execute: replacement } });
    }
    if (mutation === "execute") f.registry.get("read_file").execute = replacement;
    if (mutation === "arguments") input.arguments.path = "should-not-exist.txt";
    if (mutation === "late-execute") f.session.subscribeEvents((event) => { if (event.type === "TOOL_EXECUTION_STARTED") f.registry.get("read_file").execute = replacement; });
    const outcome = await plan.run();
    if (mutation === "arguments") { assert.equal(outcome.result.status, "completed"); assert.equal(outcome.result.result, "file-0"); }
    else assert.notEqual(outcome.result?.status, "completed");
    if (mutation === "late-execute") assert.equal(outcome.result.status, "capability_unavailable");
    assert.equal(writes, 0);
    assert.ok(outcome.action);
    await f.session.dispatch(outcome.action);
    assertSourceCursors(f.events);
    await assert.rejects(plan.run(), /不能重复/);
    await assert.rejects(fs.stat(path.join(f.workspace, "should-not-exist.txt")), { code: "ENOENT" });
  });
}
