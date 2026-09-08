import assert from "node:assert/strict";
import test from "node:test";
import { createSession, reduceSession } from "../src/core/state.js";
import { createTaskRuntimeTimer, formatRuntimeDuration, projectTurnTiming } from "../src/web/task-runtime-timer.js";

const START = Date.parse("2026-09-08T01:00:00.000Z");
const at = (seconds) => new Date(START + seconds * 1000).toISOString();

test("发送后的准备、非流模型、工具、审批、流输出及重试都沿用同一轮起点", () => {
  let session = createSession({ provider: "demo", workspace: "/tmp", id: "timer", createdAt: at(-1) });
  const actions = [
    { type: "USER_MESSAGE", content: "完成任务", at: at(0) },
    { type: "MODEL_REQUESTED", at: at(2) },
    { type: "MODEL_COMPLETED", durationMs: 3000, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, at: at(5) },
    { type: "TOOL_REQUESTED", call: { id: "call", name: "run_shell", arguments: {} }, at: at(6) },
    { type: "APPROVAL_REQUESTED", call: { id: "call", name: "run_shell", arguments: {} }, at: at(7) },
    { type: "APPROVAL_DECIDED", call: { id: "call", name: "run_shell" }, approved: true, at: at(20) },
    { type: "TOOL_EXECUTION_STARTED", call: { id: "call", name: "run_shell" }, at: at(21) },
    { type: "TOOL_RESULT", call: { id: "call", name: "run_shell" }, result: "完成", ok: true, durationMs: 4000, at: at(25) },
    { type: "MODEL_REQUESTED", at: at(26) },
    { type: "MODEL_STREAM_STARTED", at: at(27) },
    { type: "MODEL_STREAM_DELTA", delta: "正在处理。", at: at(28) },
    { type: "MODEL_RETRY_REQUESTED", attempt: 1, maxRetries: 2, delayMs: 1000, failure: {}, at: at(30) },
  ];
  let key;
  for (const action of actions) {
    session = reduceSession(session, action);
    const timing = projectTurnTiming(session);
    assert.equal(timing.startedAt, START, action.type);
    assert.equal(timing.running, true, action.type);
    key ||= timing.key;
    assert.equal(timing.key, key, action.type);
  }
});

test("没有新的 SSE 时每秒刷新；相同轮快照不会重启时钟；重新打开使用历史起点", () => {
  const fixture = createFixture();
  const session = runningSession();
  fixture.advance(7000);
  fixture.timer.update(session);
  assert.equal(fixture.root.textContent, "本轮已运行 00:07");
  fixture.advance(151_000);
  fixture.tick();
  assert.equal(fixture.root.textContent, "本轮已运行 02:31");
  fixture.timer.update({ ...session, updatedAt: at(151), step: 5 });
  assert.equal(fixture.scheduled.length, 1);
  assert.equal(fixture.cancelled.length, 0);
  fixture.timer.destroy();

  const reopened = createFixture();
  reopened.advance(160_000);
  reopened.timer.update(session);
  assert.equal(reopened.root.textContent, "本轮已运行 02:40");
  reopened.timer.destroy();
});

for (const [phase, type] of [["completed", "session.turn_completed"], ["failed", "session.failed"], ["cancelled", "session.cancelled"]]) {
  test(`${phase} 按当前轮终态冻结，后续写记忆或改标题不改变耗时`, () => {
    const fixture = createFixture();
    const running = runningSession();
    fixture.timer.update(running);
    const lateTick = fixture.scheduled[0].callback;
    const session = {
      ...running,
      phase,
      turnStartedAt: null,
      updatedAt: at(600),
      events: [...running.events, { type, at: at(151), durationMs: 150_765 }, { type: "memory.flush_completed", at: at(600) }],
    };
    fixture.timer.update(session);
    assert.equal(fixture.root.textContent, "本轮耗时 02:30");
    assert.equal(fixture.root.attributes["data-running"], "false");
    fixture.advance(900_000);
    lateTick();
    fixture.timer.update({ ...session, displayTitle: "新标题", updatedAt: at(900) });
    assert.equal(fixture.root.textContent, "本轮耗时 02:30");
    assert.deepEqual(fixture.cancelled, [1]);
    fixture.timer.destroy();
  });
}

test("终态旧数据缺 durationMs 时只从本轮明确开始与结束事件推算", () => {
  const session = runningSession();
  session.phase = "completed";
  session.turnStartedAt = null;
  session.events.push({ type: "session.turn_completed", at: at(12) });
  assert.equal(projectTurnTiming(session).durationMs, 12_000);
  session.events[0].at = "invalid";
  assert.equal(projectTurnTiming(session), null);
  session.events[1].durationMs = 12_000;
  assert.equal(projectTurnTiming(session).durationMs, 12_000);
});

test("继续或新消息只计算新轮，不带入上一轮耗时和完成事件", () => {
  const fixture = createFixture();
  const session = runningSession();
  fixture.timer.update(session);
  const oldTick = fixture.scheduled[0].callback;
  const next = {
    ...session,
    turnStartedAt: at(100),
    metrics: { lastTurnDurationMs: 60_000 },
    events: [...session.events,
      { type: "session.failed", at: at(60), durationMs: 60_000 },
      { type: "objective.continued", at: at(100) },
      { type: "message.user", seq: 9, at: at(100) },
    ],
  };
  fixture.advance(107_000);
  fixture.timer.update(next);
  assert.equal(fixture.root.textContent, "本轮已运行 00:07");
  fixture.advance(108_000);
  oldTick();
  assert.equal(fixture.root.textContent, "本轮已运行 00:07");
  fixture.tick();
  assert.equal(fixture.root.textContent, "本轮已运行 00:08");
  assert.deepEqual(fixture.cancelled, [1]);
  fixture.timer.destroy();
});

test("任务切换、清空和销毁清除时钟，并忽略已经排队的旧回调", () => {
  const fixture = createFixture();
  fixture.timer.update(runningSession("a"));
  const oldTick = fixture.scheduled[0].callback;
  fixture.advance(7000);
  fixture.timer.update(runningSession("b", 5));
  assert.equal(fixture.root.textContent, "本轮已运行 00:02");
  fixture.advance(9000);
  oldTick();
  assert.equal(fixture.root.textContent, "本轮已运行 00:02");
  const nextTick = fixture.scheduled[1].callback;
  fixture.timer.update(null);
  nextTick();
  assert.equal(fixture.root.hidden, true);
  assert.equal(fixture.root.textContent, "");
  fixture.timer.update(runningSession("c"));
  const finalTick = fixture.scheduled[2].callback;
  fixture.timer.destroy();
  finalTick();
  fixture.timer.update(runningSession("d"));
  assert.equal(fixture.root.hidden, true);
  assert.equal(fixture.root.textContent, "");
  assert.deepEqual(fixture.cancelled, [1, 2, 3]);
});

test("Gateway 恢复时不把离线时间或前一轮指标当作本轮最终耗时", () => {
  const session = runningSession();
  session.turnStartedAt = null;
  session.phase = "idle";
  session.metrics = { lastTurnDurationMs: 99_000 };
  session.events.push({ type: "session.resumed", previousPhase: "thinking", at: at(3600) });
  assert.equal(projectTurnTiming(session), null);
  session.phase = "thinking";
  assert.equal(projectTurnTiming(session), null);
  session.phase = "failed";
  assert.equal(projectTurnTiming(session), null);
});

test("重新打开已完成任务时即使恢复为 idle，仍保留其真实终态耗时", () => {
  const session = runningSession();
  session.turnStartedAt = null;
  session.phase = "idle";
  session.events.push(
    { type: "session.turn_completed", at: at(65), durationMs: 65_000 },
    { type: "session.resumed", previousPhase: "completed", at: at(3600) },
  );
  assert.equal(projectTurnTiming(session).running, false);
  assert.equal(projectTurnTiming(session).durationMs, 65_000);
});

test("新任务、继承历史和缺少可信时间戳的轮次隐藏计时", () => {
  assert.equal(projectTurnTiming(null), null);
  assert.equal(projectTurnTiming({ id: "a", phase: "idle" }), null);
  assert.equal(projectTurnTiming({ id: "a", phase: "thinking", events: [] }), null);
  assert.equal(projectTurnTiming({ id: "a", phase: "completed", metrics: { lastTurnDurationMs: 123 } }), null);
  assert.equal(projectTurnTiming({ id: "a", phase: "thinking", events: [{ type: "message.user", at: at(0), inherited: true }] }), null);
  assert.equal(projectTurnTiming({ ...runningSession(), turnStartedAt: "invalid", events: [{ type: "message.user", at: "invalid" }] }), null);
});

test("旧活动快照可从本轮事件恢复起点，或仅从明确 turnStartedAt 恢复", () => {
  assert.equal(projectTurnTiming({ ...runningSession(), turnStartedAt: null }).startedAt, START);
  assert.equal(projectTurnTiming({ ...runningSession(), events: [] }).startedAt, START);
});

test("浏览器时钟早于起点或无效时不会显示负值与 NaN", () => {
  const fixture = createFixture();
  fixture.timer.update(runningSession("future", 10));
  assert.equal(fixture.root.textContent, "本轮已运行 00:00");
  fixture.advance(Number.NaN);
  fixture.tick();
  assert.equal(fixture.root.textContent, "本轮已运行 00:00");
  fixture.timer.destroy();
});

test("计时为非打扰的 timer，秒、分钟、小时格式稳定", () => {
  const fixture = createFixture();
  assert.equal(fixture.root.hidden, true);
  assert.equal(fixture.root.attributes.role, "timer");
  assert.equal(fixture.root.attributes["aria-live"], "off");
  assert.equal(fixture.root.attributes["aria-atomic"], "true");
  assert.equal(formatRuntimeDuration(7000), "00:07");
  assert.equal(formatRuntimeDuration(151_000), "02:31");
  assert.equal(formatRuntimeDuration(3_723_000), "1:02:03");
  assert.equal(formatRuntimeDuration(-10), "00:00");
  assert.equal(formatRuntimeDuration(Infinity), "00:00");
  assert.equal(formatRuntimeDuration(Number.NaN), "00:00");
  fixture.timer.destroy();
});

function runningSession(id = "task", startSeconds = 0) {
  return {
    id,
    phase: "thinking",
    turnStartedAt: at(startSeconds),
    events: [{ type: "message.user", seq: 1, at: at(startSeconds) }],
  };
}

function createFixture() {
  const root = { hidden: false, textContent: "", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  let clock = START;
  const scheduled = [];
  const cancelled = [];
  const timer = createTaskRuntimeTimer({
    root,
    now: () => clock,
    scheduleTick: (callback, delay) => {
      assert.equal(delay, 1000);
      scheduled.push({ callback });
      return scheduled.length;
    },
    cancelTick: (id) => cancelled.push(id),
  });
  return {
    root, timer, scheduled, cancelled,
    advance: (milliseconds) => { clock = START + milliseconds; },
    tick: () => scheduled.at(-1)?.callback(),
  };
}
