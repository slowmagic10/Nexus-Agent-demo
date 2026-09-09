export const TURN_DIAGNOSTICS_VERSION = "turn-diagnostics-v1";

const PAUSE_REASONS = ["model_request_failed", "model_retry_exhausted", "model_token_budget",
  "context_replan_exhausted", "completion_validation_exhausted", "completion_token_budget",
  "completion_step_budget", "objective_blocked", "process_interrupted", "recoverable_failure", "tool_batch_failed"];
const COMPLETION_REASONS = ["empty_response", "plan_incomplete", "delegation_incomplete",
  "verification_incomplete", "tool_archive_instead_of_call"];
const OUTCOMES = ["completed", "failed", "cancelled", "paused", "interrupted", "unknown"];
const USAGE_EVENTS = new Set(["model.completed", "model.request_failed", "context.summary_completed", "context.summary_degraded"]);
const OBSERVED_EVENTS = new Set(["model.request_failed", "model.retry_requested", "model.retry_exhausted",
  "session.completion_rejected", "session.progress_intervened", "objective.paused",
  "session.failed", "session.cancelled", "session.turn_completed", ...USAGE_EVENTS]);

// This is an observation of durable projected events, never a re-run or a
// language-based judgement of whether the user's next message was necessary.
export function diagnoseTurns(events = []) {
  if (!Array.isArray(events)) throw new Error("Turn Diagnostics 需要 events 数组");
  const turns = [];
  const totals = counters();
  const objectiveTurns = new Map();
  let current = null;
  let pendingOrigin = null;
  let observedContinuations = 0;
  let continuationEvents = 0;
  let unscopedEvents = 0;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "objective.created" || event.type === "objective.continued") {
      if (event.type === "objective.continued") continuationEvents += 1;
      pendingOrigin = event;
      continue;
    }
    if (event.type === "message.user") {
      const origin = pendingOrigin?.type === "objective.created" ? "new_objective"
        : pendingOrigin?.type === "objective.continued" ? "continued_objective" : "unknown";
      const objectiveId = typeof pendingOrigin?.objectiveId === "string" ? pendingOrigin.objectiveId : null;
      const previous = objectiveId ? objectiveTurns.get(objectiveId) : null;
      current = {
        index: turns.length + 1,
        startEventSeq: sequence(event.seq), endEventSeq: null,
        origin, outcome: "unknown", stopReason: "unknown",
        ...(origin === "continued_objective" ? { continuation: {
          previousStatus: choice(pendingOrigin.previousStatus, ["active", "paused", "failed", "cancelled"]),
          previousOutcome: previous?.outcome || "unknown",
          previousStopReason: previous?.stopReason || "unknown",
          // A continuation can contain new instructions or a status question.
          // Existing events do not record that distinction.
          intent: "unknown", necessity: "not_assessed",
        } } : {}),
        ...counters(),
      };
      if (origin === "continued_objective") observedContinuations += 1;
      if (objectiveId) objectiveTurns.set(objectiveId, current);
      turns.push(current);
      pendingOrigin = null;
      continue;
    }
    if (!OBSERVED_EVENTS.has(event.type)) continue;
    observe(totals, event);
    if (!current) { unscopedEvents += 1; continue; }
    observe(current, event);
    if (event.type === "objective.paused") {
      current.stopReason = choice(event.reason, PAUSE_REASONS);
      if (current.outcome === "unknown") {
        current.outcome = current.stopReason === "process_interrupted" ? "interrupted" : "paused";
        current.endEventSeq = sequence(event.seq);
      }
    } else if (["session.failed", "session.cancelled", "session.turn_completed"].includes(event.type)) {
      // A recoverable FAILED closes this execution turn while keeping the
      // objective paused. terminalEvents still records the failed event.
      if (!(event.type === "session.failed" && event.recoverable === true && current.outcome === "paused")) {
        current.outcome = ({ "session.failed": "failed", "session.cancelled": "cancelled", "session.turn_completed": "completed" })[event.type];
      }
      current.endEventSeq = sequence(event.seq);
      if (event.type === "session.turn_completed") current.stopReason = "completed";
      if (event.type === "session.cancelled") current.stopReason = "cancelled";
    }
  }
  const outcomes = bucket(OUTCOMES);
  const continuationsByPreviousStopReason = bucket([...PAUSE_REASONS, "completed", "cancelled"]);
  for (const turn of turns) {
    outcomes[turn.outcome] += 1;
    if (turn.continuation) continuationsByPreviousStopReason[turn.continuation.previousStopReason] += 1;
  }
  return {
    version: TURN_DIAGNOSTICS_VERSION,
    reliability: {
      observedUserMessages: turns.length,
      newObjectiveTurns: turns.filter((turn) => turn.origin === "new_objective").length,
      unknownOriginTurns: turns.filter((turn) => turn.origin === "unknown").length,
      objectiveContinuationEvents: continuationEvents,
      observedUserContinuations: observedContinuations,
      unpairedObjectiveContinuations: continuationEvents - observedContinuations,
      continuationNecessity: "not_assessed", unnecessaryContinuationRate: null,
      continuationsByPreviousStopReason, outcomes, unscopedEvents,
      ...totals,
    },
    turns,
  };
}

function counters() {
  return {
    model: { requestFailed: 0, retryRequested: 0, retryExhausted: 0,
      failureKinds: bucket(["http_error", "transport_error", "protocol_error", "context_overflow"]),
      retryExhaustionReasons: bucket(["attempt_limit", "token_budget"]) },
    interventions: { completionRejected: 0, completionReasons: bucket(COMPLETION_REASONS),
      progressIntervened: 0, repeatedToolFailure: 0, unknownProgress: 0 },
    pauses: bucket(PAUSE_REASONS),
    terminalEvents: { completed: 0, failed: 0, cancelled: 0 },
    usage: { records: 0, estimated: 0, estimationUnknown: 0, reportedComplete: 0,
      reportedPartial: 0, reportedMissing: 0, reportedCoverageUnknown: 0 },
  };
}

function observe(target, event) {
  if (event.type === "model.request_failed") {
    target.model.requestFailed += 1;
    target.model.failureKinds[choice(event.failure?.kind, Object.keys(target.model.failureKinds))] += 1;
  } else if (event.type === "model.retry_requested") target.model.retryRequested += 1;
  else if (event.type === "model.retry_exhausted") {
    target.model.retryExhausted += 1;
    target.model.retryExhaustionReasons[choice(event.reason, ["attempt_limit", "token_budget"])] += 1;
  } else if (event.type === "session.completion_rejected") {
    target.interventions.completionRejected += 1;
    const reasons = Array.isArray(event.reasons) && event.reasons.length ? event.reasons : [null];
    for (const reason of new Set(reasons.map((value) => choice(value, COMPLETION_REASONS)))) target.interventions.completionReasons[reason] += 1;
  } else if (event.type === "session.progress_intervened") {
    target.interventions.progressIntervened += 1;
    if (["progress-monitor-v1", "progress-monitor-v2"].includes(event.version) && event.reason === "repeated_tool_failure"
      && Number.isSafeInteger(event.attempt) && event.attempt >= 1 && event.attempt <= 2) target.interventions.repeatedToolFailure += 1;
    else target.interventions.unknownProgress += 1;
  } else if (event.type === "objective.paused") target.pauses[choice(event.reason, PAUSE_REASONS)] += 1;
  else if (event.type === "session.failed") target.terminalEvents.failed += 1;
  else if (event.type === "session.cancelled") target.terminalEvents.cancelled += 1;
  else if (event.type === "session.turn_completed") target.terminalEvents.completed += 1;
  if (USAGE_EVENTS.has(event.type)) {
    target.usage.records += 1;
    if (event.usageEstimated === true) target.usage.estimated += 1;
    else if (event.usageEstimated !== false) target.usage.estimationUnknown += 1;
    const fields = event.usageMissingFields;
    if (!Array.isArray(fields) || new Set(fields).size !== fields.length
      || fields.some((value) => !["inputTokens", "outputTokens", "totalTokens"].includes(value))) target.usage.reportedCoverageUnknown += 1;
    else if (fields.length === 3) target.usage.reportedMissing += 1;
    else if (fields.length) target.usage.reportedPartial += 1;
    else target.usage.reportedComplete += 1;
  }
}

function bucket(known) { return Object.fromEntries([...new Set([...known, "unknown"])].map((key) => [key, 0])); }
function choice(value, allowed) { return allowed.includes(value) ? value : "unknown"; }
function sequence(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
