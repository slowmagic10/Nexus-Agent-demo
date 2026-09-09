import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";

const at = "2026-09-09T01:00:00.000Z";
const call = (id) => ({ id, name: "read_file", arguments: { path: `${id}.txt` } });
const request = (id) => ({ type: "TOOL_REQUESTED", call: call(id), effects: ["read"], at });
const result = (id, extra = {}) => ({ type: "TOOL_RESULT", call: call(id), ok: true,
  status: "completed", result: `result ${id}`, durationMs: 1, at, ...extra });
const initial = (workspace = "/tmp") => createSession({ provider: "demo", workspace, createdAt: at });

for (const durable of [false, true]) {
  test(`并发 dispatch receipt 绑定各自提交，订阅者追加事件不会串 cursor（${durable ? "SQLite" : "内存"}）`, async () => {
    const workspace = durable ? mkdtempSync(path.join(os.tmpdir(), "nexus-receipt-")) : "/tmp";
    const store = durable ? new SessionStore(path.join(workspace, "receipt.db"), { workspace }) : null;
    try {
      const session = new AgentSession({ state: initial(workspace), reducer: reduceSession, journal: store });
      const baseCursor = session.cursor;
      let observerDispatch;
      let notifications = 0;
      session.subscribeEvents((event) => {
        if (event.type === "TOOL_REQUESTED" && event.action.call.id === "a") {
          observerDispatch = session.dispatchWithReceipt({ type: "MEMORY_ADDED", content: "observer event", at });
          event.action.call.id = "mutated observer clone";
        }
      }, { after: baseCursor });
      session.subscribe(() => { notifications += 1; });
      const receipts = await Promise.all(["a", "b", "c"].map((id) => session.dispatchWithReceipt(request(id))));
      await session.drain();
      const observerReceipt = await observerDispatch;

      assert.deepEqual(receipts.map(({ cursor }) => cursor), [1, 2, 3].map((cursor) => baseCursor + cursor));
      assert.deepEqual(receipts.map(({ state }) => state.metrics.toolCalls), [1, 2, 3]);
      assert.deepEqual(receipts.map(({ state }) => state.events.at(-1).callId), ["a", "b", "c"]);
      assert.ok(receipts.every(({ state }) => state.memory.length === 0));
      assert.equal(observerReceipt.cursor, baseCursor + 4);
      assert.equal(session.cursor, observerReceipt.cursor);
      assert.equal(notifications, 4);
      receipts[0].state.events.length = 0;
      assert.equal(session.state.events.filter((event) => event.type === "tool.requested").length, 3);
      if (store) {
        assert.deepEqual(store.load(session.id), session.state);
        for (const receipt of receipts) {
          const event = session.events({ after: receipt.cursor - 1, limit: 1 })[0];
          assert.equal(event.cursor, receipt.cursor);
          assert.equal(event.type, "TOOL_REQUESTED");
        }
      }
    } finally {
      store?.close();
      if (durable) rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("receipt 使用 Journal 实际返回的 cursor，旧 dispatch 仍只返回 state", async () => {
  const cursors = [31, 47];
  const session = new AgentSession({ state: initial(), reducer: reduceSession, journal: {
    ensureJournal: (state) => structuredClone(state),
    latestSessionCursor: () => 17,
    commitSessionEvent: (state, action, patch) => ({ cursor: cursors.shift(), sessionId: state.id,
      type: action.type, at: action.at, action, patch }),
  } });
  const receipt = await session.dispatchWithReceipt(request("receipt"));
  const state = await session.dispatch(request("legacy"));
  assert.equal(receipt.cursor, 31);
  assert.equal(receipt.state.metrics.toolCalls, 1);
  assert.equal(state.metrics.toolCalls, 2);
  assert.equal(Object.hasOwn(state, "cursor"), false);
  assert.equal(Object.hasOwn(state, "state"), false);
  assert.equal(session.cursor, 47);
});

test("仅游标 receipt 保持提交顺序与独立订阅快照，不影响默认状态返回", async () => {
  const session = new AgentSession({ state: initial(), reducer: reduceSession });
  const observed = [];
  session.subscribe((state) => {
    observed.push(state.metrics.toolCalls);
    state.messages.length = 0;
    state.metrics.toolCalls = -1;
  });
  let queued;
  session.subscribeEvents((event) => {
    if (event.action.call?.id === "first") queued = session.dispatchWithReceipt(request("observer"), { includeState: false });
  });
  const [first, second] = await Promise.all([
    session.dispatchWithReceipt(request("first"), { includeState: false }),
    session.dispatchWithReceipt(request("second")),
  ]);
  await session.drain();
  assert.deepEqual(first, { cursor: 1 });
  assert.deepEqual(await queued, { cursor: 3 });
  assert.equal(second.cursor, 2);
  assert.equal(second.state.metrics.toolCalls, 2);
  assert.deepEqual(observed, [1, 2, 3]);
  second.state.metrics.toolCalls = -2;
  assert.equal(session.state.metrics.toolCalls, 3);
  assert.equal((await session.dispatch(request("legacy"))).metrics.toolCalls, 4);
});

test("仅游标提交失败不发布，后续重试继续使用最后成功的 expectedCursor", async () => {
  const expected = [];
  let fail = true;
  let notifications = 0;
  const session = new AgentSession({ state: initial(), reducer: reduceSession, journal: {
    ensureJournal: (state) => structuredClone(state),
    latestSessionCursor: () => 12,
    commitSessionEvent: (state, action, patch, { expectedCursor }) => {
      expected.push(expectedCursor);
      if (fail) { fail = false; throw new Error("write failed"); }
      return { cursor: expectedCursor + 1, sessionId: state.id, type: action.type, at: action.at, action, patch };
    },
  } });
  session.subscribe(() => { notifications += 1; });
  await assert.rejects(session.dispatchWithReceipt(request("failed"), { includeState: false }), /write failed/);
  assert.equal(session.cursor, 12);
  assert.equal(notifications, 0);
  assert.deepEqual(await session.dispatchWithReceipt(request("retry"), { includeState: false }), { cursor: 13 });
  assert.deepEqual(await session.dispatchWithReceipt(request("next"), { includeState: false }), { cursor: 14 });
  assert.deepEqual(expected, [12, 12, 13]);
  assert.equal(notifications, 2);
  session.close();
  await assert.rejects(session.dispatchWithReceipt(request("closed"), { includeState: false }), /已删除或关闭/);
});

test("receipt 保持 observer 异常隔离，提交失败不推进状态也不阻断后续队列", async () => {
  let fail = true;
  let cursor = 0;
  let notifications = 0;
  const session = new AgentSession({ state: initial(), reducer: reduceSession, journal: {
    ensureJournal: (state) => structuredClone(state),
    commitSessionEvent: (state, action, patch) => {
      if (fail) { fail = false; throw new Error("commit unavailable"); }
      return { cursor: ++cursor, sessionId: state.id, type: action.type, at: action.at, action, patch };
    },
  } });
  session.subscribeEvents(() => { throw new Error("event observer failed"); });
  session.subscribe(() => { throw new Error("state observer failed"); });
  session.subscribe(() => { notifications += 1; });
  const failed = session.dispatchWithReceipt(request("failed"));
  const succeeding = session.dispatchWithReceipt(request("success"));
  await assert.rejects(failed, /commit unavailable/);
  const receipt = await succeeding;
  assert.equal(receipt.cursor, 1);
  assert.equal(receipt.state.metrics.toolCalls, 1);
  assert.equal(receipt.state.events.at(-1).callId, "success");
  assert.equal(notifications, 1);
  await session.drain();
});

test("close 后已排队和新增的 receipt 均拒绝提交", async () => {
  const session = new AgentSession({ state: initial(), reducer: reduceSession });
  const queued = session.dispatchWithReceipt(request("queued"));
  session.close();
  await assert.rejects(queued, /已删除或关闭/);
  await assert.rejects(session.dispatchWithReceipt(request("new")), /已删除或关闭/);
  await assert.rejects(session.dispatch(request("legacy")), /已删除或关闭/);
  await session.drain();
  assert.equal(session.cursor, 0);
  assert.equal(session.state.metrics.toolCalls, 0);
});

test("普通工具结果投影保留显式 sourceCursor，旧结果形状不变", () => {
  const legacy = reduceSession(initial(), result("legacy"));
  const linked = reduceSession(initial(), result("linked", { sourceCursor: 73 }));
  assert.equal(Object.hasOwn(legacy.events.at(-1), "sourceCursor"), false);
  assert.equal(linked.events.at(-1).sourceCursor, 73);
  assert.equal(Object.hasOwn(linked.events.at(-1), "verification"), false);
  assert.deepEqual(linked.messages.at(-1), { role: "tool", tool_call_id: "linked", content: "result linked" });
  for (const sourceCursor of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "73"]) {
    assert.throws(() => reduceSession(initial(), result("bad", { sourceCursor })), /sourceCursor 必须是正安全整数/);
  }
});

function stateWithPendingBatch() {
  let state = reduceSession(initial(), { type: "USER_MESSAGE", content: "完成本批读取", at });
  state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "",
    tool_calls: ["done", "reused", "reused"].map((id) => ({ id, type: "function",
      function: { name: "read_file", arguments: JSON.stringify(call(id).arguments) } })) }, at });
  state = reduceSession(state, request("done"));
  state = reduceSession(state, result("done", { sourceCursor: 3 }));
  state = reduceSession(state, request("reused"));
  return reduceSession(state, { type: "TOOL_EXECUTION_STARTED", call: call("reused"), at });
}

test("批次记录失败只补未闭合结果，不误报已启动工具未执行，Objective 保持可继续", () => {
  const before = stateWithPendingBatch();
  const failed = reduceSession(before, { type: "FAILED", error: "batch commit failed", recoverable: true,
    reason: "tool_batch_failed", toolBatchFailure: true, at });
  const results = failed.messages.filter((message) => message.role === "tool");
  assert.deepEqual(results.map((message) => message.tool_call_id), ["done", "reused", "reused"]);
  assert.equal(results[0].content, "result done");
  assert.ok(results.slice(1).every((message) => message.content === "本批工具结果未能完整记录；已启动调用不会自动重放。"));
  assert.equal(failed.phase, "failed");
  assert.equal(failed.objective.status, "paused");
  assert.deepEqual(failed.toolStreams, {});
  assert.equal(failed.events.findLast((event) => event.type === "objective.paused").reason, "tool_batch_failed");
  const resumed = reduceSession(failed, { type: "RESUMED", provider: "demo", workspace: "/tmp", at });
  assert.deepEqual(resumed.messages, failed.messages);
});

test("旧 FAILED 和非布尔批次标志保持原有补结果行为", () => {
  for (const extra of [{}, { toolBatchFailure: false }, { toolBatchFailure: "true" }]) {
    const failed = reduceSession(stateWithPendingBatch(), { type: "FAILED", error: "legacy failure", at, ...extra });
    assert.ok(failed.messages.filter((message) => message.role === "tool").slice(1)
      .every((message) => message.content === "任务在工具启动前停止：该工具调用没有执行。"));
    assert.equal(failed.objective.status, "failed");
    assert.equal(Object.hasOwn(failed.events.at(-1), "recoverable"), false);
  }
});
