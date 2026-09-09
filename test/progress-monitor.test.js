import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { failureFingerprint, ProgressMonitor } from "../src/core/progress-monitor.js";

const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function pair(start, { body = "not found", status = "external_failed", args = "a", ok = false, ...extra } = {}) {
  return [
    { seq: start, type: "tool.requested", tool: "read_file", callId: "reused", argsHash: hash(args).slice(7), effects: ["read"] },
    { seq: start + 1, type: "tool.completed", tool: "read_file", callId: "reused", resultHash: hash(body), status, ok, ...extra },
  ];
}
const feed = (monitor, events) => events.forEach((event) => monitor.observe(event));

test("重复失败必须完整输出、参数、工具与已闭合调用均相同，callId可复用", () => {
  const monitor = new ProgressMonitor();
  for (let i = 0; i < 2; i++) {
    feed(monitor, pair(i * 2 + 1));
    assert.equal(monitor.takeIntervention(), null);
  }
  feed(monitor, pair(5, { durationMs: 999999999 }));
  const action = monitor.takeIntervention();
  assert.equal(action.reason, "repeated_tool_failure");
  assert.equal(action.attempt, 1);
  assert.deepEqual(action.occurrences, [{ requestSeq: 1, resultSeq: 2 }, { requestSeq: 3, resultSeq: 4 }, { requestSeq: 5, resultSeq: 6 }]);
  assert.equal(action.fingerprint, failureFingerprint(...pair(1)));
  assert.equal(monitor.takeIntervention(), null);
});

test("相同160字错误前缀之后的不同正文不会碰撞", () => {
  const monitor = new ProgressMonitor();
  for (let i = 0; i < 6; i++) feed(monitor, pair(i * 2 + 1, { body: "X".repeat(200) + i }));
  assert.equal(monitor.takeIntervention(), null);
});

test("每轮仅两次提示，各次需要三个新的失败，不积累全量日志", () => {
  const monitor = new ProgressMonitor();
  const actions = [];
  for (let i = 0; i < 300; i++) {
    feed(monitor, pair(i * 2 + 1));
    const action = monitor.takeIntervention();
    if (action) actions.push(action);
  }
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((item) => item.attempt), [1, 2]);
  assert.equal(actions[1].occurrences[0].requestSeq, 7);
});

test("批次后续成功、不同参数或不同错误消除已有候选", () => {
  for (const change of [{ ok: true, status: "completed" }, { args: "b" }, { body: "different" }]) {
    const monitor = new ProgressMonitor();
    for (let i = 0; i < 3; i++) feed(monitor, pair(i * 2 + 1));
    feed(monitor, pair(7, change));
    assert.equal(monitor.takeIntervention(), null);
  }
});

test("不把超时、取消、执行未知、审批或权限拒绝当可自行重试失败", () => {
  for (const status of ["timeout", "cancelled", "execution_unknown", "policy_denied", "denied", "approval_denied", "approval_stale", "capability_unavailable"]) {
    const monitor = new ProgressMonitor();
    for (let i = 0; i < 9; i++) feed(monitor, pair(i * 2 + 1, { status }));
    assert.equal(monitor.takeIntervention(), null, status);
  }
});

test("已知文件变化、不完整扫描与私密工具结果不判定重复失败", () => {
  for (const fileChanges of [{ complete: false, summary: { total: 0 }, changes: [] },
    { complete: true, summary: { total: 1 }, changes: [{ path: "edited.txt" }] },
    { complete: true }]) {
    assert.equal(failureFingerprint(...pair(1, { fileChanges })), null);
  }
  assert.ok(failureFingerprint(...pair(1, { fileChanges: { complete: true, summary: { total: 0 }, changes: [] } })));
  for (const effect of ["memory", "credential"]) {
    const events = pair(1);
    events[0].effects = [effect];
    assert.equal(failureFingerprint(...events), null);
  }
});

test("旧日志缺完整结果hash、不合法配对和身份均保守跳过", () => {
  for (const update of [
    ([, result]) => { delete result.resultHash; },
    ([request]) => { delete request.argsHash; },
    ([, result]) => { result.callId = "other"; },
    ([, result]) => { result.tool = "other"; },
    ([, result]) => { result.seq = 1; },
    ([, result]) => { result.resultHash = "sha256:invalid"; },
  ]) {
    const events = pair(1);
    update(events);
    assert.equal(failureFingerprint(...events), null);
  }
});

test("事件缺口或未闭合调用不能接上此前失败计数", () => {
  const monitor = new ProgressMonitor();
  feed(monitor, pair(1));
  feed(monitor, pair(3));
  feed(monitor, pair(6));
  assert.equal(monitor.takeIntervention(), null);
  feed(monitor, pair(8));
  monitor.observe(pair(10)[0]);
  assert.equal(monitor.takeIntervention(), null);
  feed(monitor, pair(11));
  assert.equal(monitor.takeIntervention(), null);
});

test("重复与迟到的事件不重复计数，耗时和输出增量不触发提示", () => {
  const monitor = new ProgressMonitor();
  feed(monitor, pair(1));
  for (let i = 0; i < 10; i++) feed(monitor, pair(1));
  monitor.observe({ seq: 3, type: "tool.output_updated", capturedChars: 1000000, at: "2099-01-01" });
  assert.equal(monitor.takeIntervention(), null);
});
