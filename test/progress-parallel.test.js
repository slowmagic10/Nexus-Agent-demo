import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { AgentRuntime } from "../src/core/agent.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { failureFingerprint, ProgressMonitor } from "../src/core/progress-monitor.js";
import { progressFeedback } from "../src/core/progress-feedback.js";
import { SessionStore, validateAndReplayJournalArchive } from "../src/persistence/session-store.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ToolHost } from "../src/tools/host.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";

const args = { path: "missing.txt" };
const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
const body = "missing file";
const resultHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
const call = (id) => ({ id, name: "read_file", arguments: args });
const requested = (id) => ({ type: "tool.requested", callId: id, tool: "read_file", argsHash, effects: ["read"] });
const completed = (id, extra = {}) => ({ type: "tool.completed", callId: id, tool: "read_file", resultHash,
  ok: false, status: "external_failed", ...extra });
const ids = ["a", "b", "c"];
function observer(monitor) {
  let seq = 0;
  return (...events) => events.forEach((event) => monitor.observe({ ...event, seq: ++seq }));
}
const serial = (feed, id) => feed(requested(id), completed(id));

test("三路请求和顺序结果产生 v2 纠正，单次失败指纹保持 v1", () => {
  const monitor = new ProgressMonitor();
  const feed = observer(monitor);
  feed(...ids.map(requested));
  feed(completed("a"), completed("b"));
  assert.equal(monitor.takeIntervention(), null);
  feed(completed("c"));
  const action = monitor.takeIntervention();
  assert.equal(action.version, "progress-monitor-v2");
  assert.deepEqual(action.occurrences, [{ requestSeq: 1, resultSeq: 4 }, { requestSeq: 2, resultSeq: 5 }, { requestSeq: 3, resultSeq: 6 }]);
  const expectedFingerprint = `sha256:${createHash("sha256").update(JSON.stringify([
    "progress-monitor-v1", "read_file", argsHash, "external_failed", resultHash,
  ])).digest("hex")}`;
  assert.equal(action.fingerprint, expectedFingerprint);
  assert.equal(failureFingerprint({ ...requested("serial"), seq: 1 }, { ...completed("serial"), seq: 2 }), expectedFingerprint);
});

test("成功或不匹配结果清除连续失败但保留其它已知 pending 请求", () => {
  for (const first of [completed("a", { ok: true, status: "completed" }), completed("a", { resultHash: "invalid" })]) {
    const monitor = new ProgressMonitor();
    const feed = observer(monitor);
    feed(...ids.map(requested));
    feed(first, completed("b"), completed("c"));
    assert.equal(monitor.takeIntervention(), null);
    serial(feed, "d");
    const action = monitor.takeIntervention();
    assert.equal(action.version, "progress-monitor-v2");
    assert.deepEqual(action.occurrences.map((item) => item.requestSeq), [2, 3, 7]);
  }
});

test("逆序完成重置 streak，但后续保留的真实配对仍能形成新候选", () => {
  const monitor = new ProgressMonitor();
  const feed = observer(monitor);
  feed(...ids.map(requested));
  feed(completed("c"), completed("a"), completed("b"));
  assert.equal(monitor.takeIntervention(), null);
  serial(feed, "d");
  const action = monitor.takeIntervention();
  assert.deepEqual(action.occurrences, [{ requestSeq: 1, resultSeq: 5 }, { requestSeq: 2, resultSeq: 6 }, { requestSeq: 7, resultSeq: 8 }]);
});

test("重叠复用 ID 保持歧义直到全部闭合，不使用其中任何结果", () => {
  const monitor = new ProgressMonitor();
  const feed = observer(monitor);
  serial(feed, "before1");
  serial(feed, "before2");
  feed(requested("same"), requested("same"), requested("other"));
  feed(completed("same"), completed("other"));
  assert.equal(monitor.takeIntervention(), null);
  feed(completed("same"));
  assert.equal(monitor.takeIntervention(), null);
  for (const id of ids) serial(feed, id);
  const action = monitor.takeIntervention();
  assert.equal(action.version, "progress-monitor-v1");
  assert.equal(action.occurrences[0].requestSeq, 11);
});

test("超出三路上限时有界抑制，结果全部收束后可恢复串行纠正", () => {
  const monitor = new ProgressMonitor();
  const feed = observer(monitor);
  feed(...[...ids, "d"].map(requested));
  feed(...[...ids, "d"].map(completed));
  assert.equal(monitor.takeIntervention(), null);
  for (const id of ids) serial(feed, id);
  const action = monitor.takeIntervention();
  assert.equal(action.version, "progress-monitor-v1");
  assert.equal(action.occurrences[0].requestSeq, 9);
});

function initial(workspace = "/tmp") {
  return reduceSession(createSession({ provider: "test", workspace }), { type: "USER_MESSAGE", content: "完成读取任务" });
}
function batchActions(callIds = ids, completionIds = callIds) {
  return [
    { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "", tool_calls: callIds.map((id) => ({
      id, type: "function", function: { name: "read_file", arguments: JSON.stringify(args) },
    })) } },
    ...callIds.map((id) => ({ type: "TOOL_REQUESTED", call: call(id), argsHash, effects: ["read"], idempotency: "safe", adapter: "native" })),
    ...completionIds.map((id) => ({ type: "TOOL_RESULT", call: call(id), result: body, resultHash, ok: false, status: "external_failed" })),
  ];
}
function intervention(state, attempt = 1) {
  const results = state.events.filter((event) => event.type === "tool.completed").slice(-3);
  const occurrences = results.map((result) => ({
    requestSeq: state.events.findLast((event) => event.type === "tool.requested" && event.callId === result.callId && event.seq < result.seq).seq,
    resultSeq: result.seq,
  }));
  return { type: "PROGRESS_INTERVENTION", version: "progress-monitor-v2", reason: "repeated_tool_failure", attempt,
    fingerprint: failureFingerprint(state.events[occurrences[0].requestSeq - 1], results[0]), occurrences };
}

test("v2 仅接受各自有序且真实配对的最后三次失败，v1 仍拒绝重叠请求", () => {
  const state = batchActions().reduce(reduceSession, initial());
  const action = intervention(state);
  const next = reduceSession(state, action);
  assert.equal(next.events.at(-1).version, "progress-monitor-v2");
  assert.equal(next.messages.at(-1).content, progressFeedback(1));
  assert.throws(() => reduceSession(state, { ...action, version: "progress-monitor-v1" }), /PROGRESS_INTERVENTION/);
  for (const occurrences of [
    [...action.occurrences].reverse(),
    action.occurrences.map((item, index) => ({ ...item, requestSeq: action.occurrences[(index + 1) % 3].requestSeq })),
    action.occurrences.map((item, index) => ({ ...item, resultSeq: action.occurrences[(index + 1) % 3].resultSeq })),
  ]) assert.throws(() => reduceSession(state, { ...action, occurrences }), /PROGRESS_INTERVENTION/);
  const reversed = batchActions(ids, ["c", "a", "b"]).reduce(reduceSession, initial());
  assert.throws(() => reduceSession(reversed, intervention(reversed)), /PROGRESS_INTERVENTION/);
  const overlap = batchActions(["same", "same", "other"]).reduce(reduceSession, initial());
  assert.throws(() => reduceSession(overlap, intervention(overlap)), /PROGRESS_INTERVENTION/);
  for (const changed of [{ ok: true }, { status: "timeout" }, { resultHash: `sha256:${"0".repeat(64)}` }]) {
    const forged = structuredClone(state);
    Object.assign(forged.events[action.occurrences[1].resultSeq - 1], changed);
    assert.throws(() => reduceSession(forged, action), /PROGRESS_INTERVENTION/);
  }
  const later = batchActions(["later"]).reduce(reduceSession, state);
  assert.throws(() => reduceSession(later, action), /PROGRESS_INTERVENTION/);
});

test("v2 第二次纠正的全部证据必须晚于上次纠正，并保持每轮上限", () => {
  let state = batchActions().reduce(reduceSession, initial());
  const first = intervention(state);
  state = reduceSession(state, first);
  assert.throws(() => reduceSession(state, { ...first, attempt: 2 }), /PROGRESS_INTERVENTION/);
  state = batchActions(["d", "e"]).reduce(reduceSession, state);
  assert.throws(() => reduceSession(state, intervention(state, 2)), /PROGRESS_INTERVENTION/);
  state = batchActions(["f"]).reduce(reduceSession, state);
  state = reduceSession(state, intervention(state, 2));
  state = batchActions().reduce(reduceSession, state);
  assert.throws(() => reduceSession(state, intervention(state, 3)), /PROGRESS_INTERVENTION/);
});

test("v2 并发纠正可从 SQLite 严格重放及导出导入", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-parallel-progress-"));
  const store = new SessionStore(path.join(workspace, "nexus.db"), { workspace });
  try {
    const session = new AgentSession({ state: createSession({ provider: "test", workspace }), reducer: reduceSession, journal: store });
    await session.dispatch({ type: "USER_MESSAGE", content: "完成读取任务" });
    for (const action of batchActions()) await session.dispatch(action);
    await session.dispatch(intervention(session.state));
    const archive = store.exportJournal(session.id);
    assert.deepEqual(validateAndReplayJournalArchive(archive).state, session.state);
    assert.deepEqual(store.load(session.id), session.state);
    const restored = store.importJournal(archive, { id: "parallel-restored", workspace });
    assert.deepEqual(restored.messages, session.state.messages);
    assert.deepEqual(restored.events, session.state.events);
  } finally {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("真实原生读批次的三次失败在全部结果落盘后生成 v2，同轮继续请求模型", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-native-progress-"));
  const store = new SessionStore(path.join(workspace, "nexus.db"), { workspace });
  try {
    const registry = createToolRegistry({ workspace });
    const host = new ToolHost({ registry, policy: new WorkspacePolicy({}, { profile: registry.accessPolicy }) });
    const session = new AgentSession({ state: createSession({ provider: "test", workspace }), reducer: reduceSession, journal: store });
    const requests = [];
    const runtime = new AgentRuntime({ session, toolHost: host, systemPrompt: "检查输入文件。", provider: {
      name: "test", complete: async (request) => {
        requests.push(request);
        return requests.length === 1 ? { text: "", toolCalls: ids.map(call), finishReason: "tool_calls" }
          : { text: "已确认文件不存在。", toolCalls: [], finishReason: "stop" };
      },
    } });
    await runtime.runTurn("检查缺失文件", async () => false);
    assert.equal(runtime.state.phase, "completed", runtime.state.lastError);
    assert.equal(requests.length, 2);
    assert.match(requests[1].systemPrompt, /运行时进展检查/);
    assert.equal(requests[1].messages.filter((message) => message.role === "tool").length, 3);
    const events = runtime.state.events;
    const intervention = events.find((event) => event.type === "session.progress_intervened");
    assert.equal(intervention.version, "progress-monitor-v2");
    assert.ok(events.filter((event) => event.type === "tool.requested").at(-1).seq
      < events.find((event) => event.type === "tool.completed").seq);
    assert.ok(events.filter((event) => event.type === "tool.completed").at(-1).seq < intervention.seq);
    assert.deepEqual(store.load(session.id), runtime.state);
  } finally {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CANCELLED 仅在批次记录失败时使用保守补全文案，已记结果不变", () => {
  const before = batchActions(ids, ["a"]).reduce(reduceSession, initial());
  const marked = reduceSession(before, { type: "CANCELLED", reason: "cancelled", toolBatchFailure: true });
  const results = marked.messages.filter((message) => message.role === "tool");
  assert.equal(results[0].content, body);
  assert.ok(results.slice(1).every((message) => message.content === "本批工具结果未能完整记录；已启动调用不会自动重放。"));
  assert.equal(marked.phase, "cancelled");
  for (const extra of [{}, { toolBatchFailure: false }, { toolBatchFailure: "true" }]) {
    const legacy = reduceSession(before, { type: "CANCELLED", reason: "cancelled", ...extra });
    assert.ok(legacy.messages.filter((message) => message.role === "tool").slice(1)
      .every((message) => message.content === "任务已取消：该工具调用不会自动重放，执行状态未知。"));
  }
});
