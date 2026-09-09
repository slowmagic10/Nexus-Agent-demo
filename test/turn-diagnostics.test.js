import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseTurns, TURN_DIAGNOSTICS_VERSION } from "../src/evaluation/turn-diagnostics.js";
import { createSession, reduceSession } from "../src/core/state.js";

const events = (...values) => values.map((event, index) => ({ seq: index + 1, ...event }));
const start = (id = "objective-1") => [{ type: "objective.created", objectiveId: id }, { type: "message.user", preview: "private prompt" }];

test("诊断只读且确定性：模型重试耗尽、用户继续、随后完成按同一目标关联", () => {
  const source = events(...start(),
    { type: "model.request_failed", failure: { kind: "transport_error", message: "private error" }, usageEstimated: true },
    { type: "model.retry_requested", attempt: 1, failure: { message: "private error" } },
    { type: "model.request_failed", failure: { kind: "http_error" }, usageEstimated: false },
    { type: "model.retry_requested", attempt: 2 },
    { type: "model.request_failed", failure: { kind: "http_error" } },
    { type: "model.retry_exhausted", reason: "attempt_limit" },
    { type: "objective.paused", reason: "model_retry_exhausted", objectiveId: "objective-1" },
    { type: "session.failed", error: "private error" },
    { type: "objective.continued", previousStatus: "paused", objectiveId: "objective-1" },
    { type: "message.user", preview: "现在什么状态？private prompt" },
    { type: "session.turn_completed" });
  const original = structuredClone(source);
  const result = diagnoseTurns(source);
  assert.deepEqual(source, original);
  assert.deepEqual(result, diagnoseTurns(structuredClone(source)));
  assert.equal(result.version, TURN_DIAGNOSTICS_VERSION);
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].outcome, "failed");
  assert.equal(result.turns[0].stopReason, "model_retry_exhausted");
  assert.equal(result.turns[0].model.requestFailed, 3);
  assert.equal(result.turns[0].model.retryRequested, 2);
  assert.equal(result.turns[1].outcome, "completed");
  assert.deepEqual(result.turns[1].continuation, {
    previousStatus: "paused", previousOutcome: "failed", previousStopReason: "model_retry_exhausted",
    intent: "unknown", necessity: "not_assessed",
  });
  assert.equal(result.reliability.observedUserContinuations, 1);
  assert.equal(result.reliability.continuationsByPreviousStopReason.model_retry_exhausted, 1);
  assert.equal(result.reliability.unnecessaryContinuationRate, null);
  assert.doesNotMatch(JSON.stringify(result), /private|现在什么|objective-1/);
});

test("新目标和状态询问不从正文推断为无谓继续，声明阻塞只报告已观察原因", () => {
  const result = diagnoseTurns(events(...start(),
    { type: "objective.paused", reason: "objective_blocked", objectiveId: "objective-1" },
    { type: "session.failed", recoverable: true },
    { type: "objective.continued", previousStatus: "paused", objectiveId: "objective-1", preserveBlockedReason: true },
    { type: "message.user", preview: "状态如何？" },
    { type: "session.failed", error: "模型回复误称 context 超限" },
    ...start("objective-2"),
    { type: "session.turn_completed" },
    { type: "message.user", preview: "继续开发" }));
  assert.equal(result.reliability.observedUserMessages, 4);
  assert.equal(result.reliability.newObjectiveTurns, 2);
  assert.equal(result.reliability.observedUserContinuations, 1);
  assert.equal(result.reliability.unknownOriginTurns, 1);
  assert.equal(result.turns[1].continuation.previousStopReason, "objective_blocked");
  assert.equal(result.turns[1].continuation.necessity, "not_assessed");
  assert.equal(result.turns[1].stopReason, "unknown");
  assert.equal(result.turns[3].origin, "unknown");
});

test("恢复中断、用户取消和已完成轮次分别保留，不以失败正文解释原因", () => {
  const result = diagnoseTurns(events(...start(),
    { type: "objective.paused", reason: "process_interrupted", objectiveId: "objective-1" },
    { type: "session.resumed" },
    { type: "objective.continued", previousStatus: "paused", objectiveId: "objective-1" },
    { type: "message.user" },
    { type: "session.cancelled", reason: "private cancel" },
    { type: "objective.continued", previousStatus: "cancelled", objectiveId: "objective-1" },
    { type: "message.user" },
    { type: "session.turn_completed" }));
  assert.deepEqual(result.turns.map((turn) => turn.outcome), ["interrupted", "cancelled", "completed"]);
  assert.equal(result.turns[1].continuation.previousStopReason, "process_interrupted");
  assert.equal(result.turns[2].continuation.previousStopReason, "cancelled");
  assert.equal(result.reliability.terminalEvents.failed, 0);
  assert.equal(result.reliability.terminalEvents.cancelled, 1);
  assert.doesNotMatch(JSON.stringify(result), /private cancel/);
});

test("纠正和进度干预仅统计固定枚举，未知版本及自由文本不进入报告", () => {
  const result = diagnoseTurns(events(...start(),
    { type: "session.completion_rejected", reasons: ["plan_incomplete", "private reason"], message: "private feedback" },
    { type: "session.completion_rejected" },
    { type: "session.progress_intervened", version: "progress-monitor-v1", reason: "repeated_tool_failure", attempt: 1, tool: "private tool", args: { content: "private args" } },
    { type: "session.progress_intervened", version: "private version", reason: "repeated_tool_failure", attempt: 2 },
    { type: "session.progress_intervened", version: "progress-monitor-v1", reason: "private reason", attempt: 2 },
    { type: "session.progress_intervened", version: "progress-monitor-v1", reason: "repeated_tool_failure", attempt: 3 },
    { type: "model.request_failed", failure: { kind: "private failure", code: "private code" } },
    { type: "model.retry_exhausted", reason: "private reason" },
    { type: "objective.paused", reason: "private reason" },
    { type: "session.failed", error: "model_retry_exhausted private error" }));
  const { interventions, model } = result.reliability;
  assert.equal(interventions.completionRejected, 2);
  assert.equal(interventions.completionReasons.plan_incomplete, 1);
  assert.equal(interventions.completionReasons.unknown, 2);
  assert.equal(interventions.progressIntervened, 4);
  assert.equal(interventions.repeatedToolFailure, 1);
  assert.equal(interventions.unknownProgress, 3);
  assert.equal(model.failureKinds.unknown, 1);
  assert.equal(model.retryExhaustionReasons.unknown, 1);
  assert.equal(result.turns[0].stopReason, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("usage 缺失、部分和估算只使用显式元数据，旧版本数值不能证明完整上报", () => {
  const result = diagnoseTurns(events(...start(),
    { type: "model.completed", usage: { totalTokens: 8 } },
    { type: "model.completed", usageEstimated: true, usageMissingFields: ["inputTokens", "outputTokens", "totalTokens"] },
    { type: "model.completed", usageEstimated: true, usageMissingFields: ["inputTokens"] },
    { type: "context.summary_completed", usageEstimated: false, usageMissingFields: [] },
    { type: "model.request_failed", usageEstimated: true },
    { type: "context.summary_degraded", usageEstimated: false, usageMissingFields: ["private token field"] },
    { type: "model.completed", usageEstimated: false, usageMissingFields: ["inputTokens", "inputTokens"] }));
  assert.deepEqual(result.reliability.usage, {
    records: 7, estimated: 3, estimationUnknown: 1, reportedComplete: 1,
    reportedPartial: 1, reportedMissing: 1, reportedCoverageUnknown: 4,
  });
  assert.doesNotMatch(JSON.stringify(result), /private token field/);
});

test("旧记录缺少用户轮次或字段时只做未归属聚合，不制造继续次数", () => {
  const result = diagnoseTurns([
    { type: "model.request_failed" },
    { type: "session.failed", error: "continue please" },
    { type: "objective.continued" },
  ]);
  assert.deepEqual(result.turns, []);
  assert.equal(result.reliability.unscopedEvents, 2);
  assert.equal(result.reliability.objectiveContinuationEvents, 1);
  assert.equal(result.reliability.unpairedObjectiveContinuations, 1);
  assert.equal(result.reliability.observedUserContinuations, 0);
  assert.equal(result.reliability.model.requestFailed, 1);
  assert.equal(result.reliability.terminalEvents.failed, 1);
  assert.equal(result.reliability.unnecessaryContinuationRate, null);
});

test("真实 reducer 的可恢复失败保留暂停 outcome 与失败事件，不当成不可恢复失败", () => {
  let state = createSession({ workspace: "/tmp/diagnostics-fixture", provider: "fixture" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "private original goal" });
  state = reduceSession(state, { type: "FAILED", recoverable: true,
    reason: "completion_validation_exhausted", error: "private completion failure" });
  state = reduceSession(state, { type: "USER_MESSAGE", objectiveMode: "continue", content: "private continuation" });
  const result = diagnoseTurns(state.events);
  assert.equal(result.turns[0].outcome, "paused");
  assert.equal(result.turns[0].terminalEvents.failed, 1);
  assert.equal(result.reliability.outcomes.paused, 1);
  assert.equal(result.reliability.outcomes.failed, 0);
  assert.equal(result.turns[1].continuation.previousOutcome, "paused");
  assert.equal(result.turns[1].continuation.previousStopReason, "completion_validation_exhausted");
  assert.equal(result.reliability.observedUserContinuations, 1);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
