import { projectDisplayTurns } from "./turn-view.js";

export const EXECUTION_SUMMARY_VERSION = "execution-summary-v1";

const BLOCKED_STATUSES = new Set(["denied", "policy_denied", "approval_stale"]);
const INTERRUPTED_PHASES = new Set(["thinking", "executing", "awaiting_approval"]);
const TERMINATION_REASONS = new Set(["completed", "timeout", "cancelled", "external_failed"]);

// UI-only projection. Durable messages and events remain the source of truth.
export function projectExecutionTurns(session = {}) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const events = Array.isArray(session.events) ? session.events : [];
  const displayTurns = projectDisplayTurns(messages);
  const messageTurns = collectMessageTurns(messages);
  const eventWindows = splitEventWindows(events);
  const branchHistory = Boolean(
    session?.lineage?.parentSessionId
    || events.some((event) => event?.type === "session.branched"),
  );
  const branchTurnOffset = branchHistory
    ? Math.max(0, displayTurns.filter((turn) => turn.user).length - eventWindows.turns.length)
    : 0;
  let userWindow = 0;

  const turns = displayTurns.map((turn, index) => {
    const calls = messageTurns[index]?.calls || [];
    const userTurnIndex = turn.user ? userWindow++ : null;
    const inheritedHistory = branchHistory
      && userTurnIndex !== null
      && userTurnIndex < branchTurnOffset;
    const window = turn.user
      ? (inheritedHistory
        ? inheritedLifecycleEvents(eventWindows.legacy, calls)
        : (eventWindows.turns[userTurnIndex - branchTurnOffset] || []))
      : eventWindows.legacy;
    const execution = projectTurnExecution({
      calls,
      events: window,
      isCurrent: index === displayTurns.length - 1,
      pendingApproval: session.pendingApproval,
      toolStreams: session.toolStreams,
      modelStream: session.modelStream,
      phase: session.phase,
      turnOrdinal: index + 1,
      inheritedHistory,
    });
    return { ...turn, execution };
  });

  return {
    version: EXECUTION_SUMMARY_VERSION,
    turns,
    inheritedFileChanges: projectInheritedFileChanges(events),
  };
}

function collectMessageTurns(messages) {
  const turns = [];
  let current = null;

  const ensureTurn = () => {
    if (!current) {
      current = { calls: [] };
      turns.push(current);
    }
    return current;
  };

  for (const [messageIndex, message] of messages.entries()) {
    if (message?.role === "user") {
      current = { calls: [] };
      turns.push(current);
      continue;
    }
    if (message?.role === "assistant") {
      const turn = ensureTurn();
      for (const [callOrdinal, call] of (message.tool_calls || []).entries()) {
        turn.calls.push({
          call,
          result: null,
          bound: false,
          ordinal: turn.calls.length,
          messageIndex,
          callOrdinal,
        });
      }
      continue;
    }
    if (message?.role === "tool" && message.tool_call_id) {
      const turn = ensureTurn();
      const target = turn.calls.find((candidate) => (
        !candidate.result && candidate.call?.id === message.tool_call_id
      ));
      if (target) target.result = message;
    }
  }
  return turns;
}

function inheritedLifecycleEvents(events, calls) {
  return events.filter((event) => (
    event?.inherited === true
    && isToolLifecycleEvent(event.type)
    && calls.some((candidate) => positionedCallMatches(candidate, event))
  ));
}

function splitEventWindows(events) {
  const legacy = [];
  const turns = [];
  let current = null;
  for (const event of events) {
    if (event?.type === "message.user") {
      current = [];
      turns.push(current);
    }
    (current || legacy).push(event);
  }
  return { legacy, turns };
}

function projectTurnExecution({
  calls,
  events,
  isCurrent,
  pendingApproval,
  toolStreams,
  modelStream,
  phase,
  turnOrdinal,
  inheritedHistory,
}) {
  const issues = [];
  const runs = [];

  for (const event of events) {
    if (event?.type === "tool.requested") {
      const messageCall = bindMessageCall(calls, event);
      runs.push(createRun(event, messageCall, turnOrdinal, runs.length));
      continue;
    }
    if (!event?.callId || !isToolLifecycleEvent(event.type)) continue;
    let run = findLifecycleRun(runs, event);
    if (!run) {
      const messageCall = bindMessageCall(calls, event);
      run = createRun(null, messageCall, turnOrdinal, runs.length, event);
      runs.push(run);
      if ((inheritedHistory && event.inherited === true && messageCall)
        || (event.type === "tool.recovery_cancelled" && messageCall)) {
        run.integrity = { complete: true, issues: [] };
      } else {
        issues.push(`orphan_event:${event.type}:${event.callId}`);
      }
    }
    applyLifecycleEvent(run, event);
  }

  for (const messageCall of calls.filter((candidate) => !candidate.bound)) {
    const run = createRun(null, messageCall, turnOrdinal, runs.length);
    if (inheritedHistory) {
      run.inherited = true;
      run.closed = true;
      run.integrity = { complete: true, issues: [] };
    } else {
      run.integrity.complete = false;
      run.integrity.issues.push("missing_tool_requested_event");
      issues.push(`missing_tool_requested_event:${run.callId || run.runKey}`);
    }
    runs.push(run);
  }

  const terminalIndex = events.findLastIndex((event) => [
    "session.turn_completed",
    "session.failed",
    "session.cancelled",
  ].includes(event?.type));
  const recoveryIndex = events.findLastIndex((event) => event?.type === "session.resumed");
  const interruptedRecoveryIndex = events.findLastIndex((event, index) => (
    index > terminalIndex
    && event?.type === "session.resumed"
    && INTERRUPTED_PHASES.has(event.previousPhase)
  ));
  const terminal = terminalIndex >= 0 ? events[terminalIndex] : null;
  const recoveryEvent = recoveryIndex >= 0 ? events[recoveryIndex] : null;
  const interruptedRecoveryEvent = interruptedRecoveryIndex >= 0 ? events[interruptedRecoveryIndex] : null;
  const recoveryInterrupted = Boolean(interruptedRecoveryEvent);
  reconcileUnclosedRuns(runs, { recoveryEvent, terminal, issues });
  if (isCurrent && !terminal && !recoveryEvent) applyLiveState(runs, { pendingApproval, toolStreams });
  for (const run of runs) finalizeRun(run);
  runs.sort((left, right) => (
    (left.messageOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.messageOrdinal ?? Number.MAX_SAFE_INTEGER)
    || left.eventOrdinal - right.eventOrdinal
  ));

  const modelEvents = events.filter((event) => event?.type === "model.requested");
  const modelCompletions = events.filter((event) => event?.type === "model.completed");
  const fileChanges = aggregateFileChanges(runs);
  const counts = countRunStatuses(runs);
  const modelRunning = isCurrent
    && Boolean(modelStream?.status === "streaming" || (modelEvents.length > modelCompletions.length && phase === "thinking"));
  const outcome = projectTurnOutcome({
    terminal,
    recoveryEvent,
    interruptedRecoveryEvent,
    runs,
  });

  return {
    turnKey: `turn:${turnOrdinal}`,
    status: turnStatus({ counts, terminal, modelRunning, phase, isCurrent, recoveryInterrupted, inheritedHistory }),
    inherited: inheritedHistory,
    counts,
    model: {
      requests: modelEvents.length,
      completed: modelCompletions.length,
      durationMs: sumDuration(modelCompletions),
      durationComplete: modelCompletions.length >= modelEvents.length,
      streaming: modelRunning,
    },
    durationMs: finiteDuration(terminal?.durationMs),
    toolDurationMs: runs.reduce((total, run) => total + (run.durationMs || 0), 0),
    fileChanges,
    outcome,
    recovery: recoveryEvent ? {
      resumed: true,
      previousPhase: recoveryEvent.previousPhase || null,
      interrupted: recoveryInterrupted,
      interruptedFromPhase: interruptedRecoveryEvent?.previousPhase || null,
      toolExecutionUnknown: runs.some((run) => run.recovery?.reason === "process_interrupted"),
    } : null,
    runs,
    integrity: { complete: issues.length === 0, issues },
  };
}

function projectTurnOutcome({ terminal, recoveryEvent, interruptedRecoveryEvent, runs }) {
  const unknownRunKeys = runs
    .filter((run) => run.status === "unknown")
    .map((run) => run.runKey);
  const interrupted = Boolean(interruptedRecoveryEvent);
  const terminalStatus = ({
    "session.turn_completed": "completed",
    "session.failed": "failed",
    "session.cancelled": "cancelled",
  })[terminal?.type] || null;
  const status = unknownRunKeys.length
    ? "unknown"
    : (terminalStatus || (interrupted ? "interrupted" : null));

  if (!status && !unknownRunKeys.length) return null;

  return {
    status,
    terminalStatus,
    reason: outcomeReason({ terminal, recoveryEvent, interruptedRecoveryEvent }),
    durationMs: finiteDuration(terminal?.durationMs),
    recovered: Boolean(recoveryEvent),
    interruptedFromPhase: interruptedRecoveryEvent?.previousPhase || null,
    sideEffectCertainty: unknownRunKeys.length
      ? "unknown"
      : (runs.length ? "known" : "not_applicable"),
    unknownRunKeys,
    requiresManualInspection: unknownRunKeys.length > 0,
  };
}

function outcomeReason({ terminal, recoveryEvent, interruptedRecoveryEvent }) {
  if (terminal?.type === "session.failed") {
    return safeOutcomeText(terminal.error) || "本轮执行失败，未记录具体原因。";
  }
  if (terminal?.type === "session.cancelled") {
    return safeOutcomeText(terminal.reason) || "本轮已取消。";
  }
  if (interruptedRecoveryEvent) {
    const phase = interruptedRecoveryEvent.previousPhase || "running";
    return `Gateway 恢复时检测到本轮仍处于 ${phase}，未完成的运行已中断。`;
  }
  if (recoveryEvent && !terminal) return "Gateway 恢复了本轮状态。";
  return null;
}

function safeOutcomeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function reconcileUnclosedRuns(runs, { recoveryEvent, terminal, issues }) {
  for (const run of runs.filter((candidate) => !candidate.closed && !candidate.unknown)) {
    if (recoveryEvent && run.approval?.status === "requested" && !run.adapterStarted) {
      run.approval = { ...run.approval, status: "cancelled" };
      run.recovery = { reason: "process_interrupted_before_start" };
      continue;
    }
    if (["session.failed", "session.cancelled"].includes(terminal?.type)) {
      if (run.adapterStarted) {
        run.unknown = { reason: "turn_closed_after_tool_start" };
        run.recovery = { reason: "turn_closed_after_tool_start" };
        run.integrity.complete = false;
        run.integrity.issues.push("missing_tool_terminal_event");
        issues.push(`missing_tool_terminal_event:${run.callId || run.runKey}`);
      } else if (!run.validationFailed
        && !run.capabilityUnavailable
        && run.authorizationDecision !== "deny"
        && run.approval?.status !== "denied") {
        run.recovery = { reason: "turn_closed_before_tool_result" };
      }
    }
  }
}

function bindMessageCall(calls, event) {
  const positioned = calls.find((candidate) => (
    !candidate.bound && positionedCallMatches(candidate, event)
  ));
  if (positioned) {
    positioned.bound = true;
    return positioned;
  }
  const exact = calls.find((candidate) => (
    !candidate.bound
    && candidate.call?.id === event.callId
    && (!event.tool || toolName(candidate.call) === event.tool)
  ));
  const fallback = exact || calls.find((candidate) => !candidate.bound && candidate.call?.id === event.callId);
  if (fallback) fallback.bound = true;
  return fallback || null;
}

function positionedCallMatches(candidate, event) {
  return Number.isSafeInteger(event?.messageIndex)
    && Number.isSafeInteger(event?.callOrdinal)
    && candidate.messageIndex === event.messageIndex
    && candidate.callOrdinal === event.callOrdinal
    && candidate.call?.id === event.callId;
}

function createRun(requested, messageCall, turnOrdinal, runOrdinal, fallbackEvent = null) {
  const source = requested || fallbackEvent || {};
  const call = messageCall?.call || {
    id: source.callId || `unknown-${turnOrdinal}-${runOrdinal + 1}`,
    name: source.tool || "unknown_tool",
    arguments: source.args || {},
  };
  return {
    runKey: requested?.seq ? `tool:${requested.seq}` : `legacy:${turnOrdinal}:${runOrdinal + 1}`,
    callId: call.id || source.callId || null,
    tool: toolName(call) || source.tool || "unknown_tool",
    argsHash: source.argsHash || null,
    messageIndex: messageCall?.messageIndex ?? source.messageIndex ?? null,
    callOrdinal: messageCall?.callOrdinal ?? source.callOrdinal ?? null,
    call,
    messageOrdinal: messageCall?.ordinal ?? null,
    eventOrdinal: runOrdinal,
    result: messageCall?.result || null,
    status: "pending",
    adapterStarted: false,
    effectiveTimeoutMs: undefined,
    terminationReason: null,
    durationMs: 0,
    fileChanges: null,
    artifact: null,
    liveOutput: null,
    pendingApproval: null,
    approval: null,
    recovery: null,
    completion: null,
    unknown: null,
    validationFailed: false,
    capabilityUnavailable: false,
    authorizationDecision: null,
    inherited: false,
    closed: false,
    integrity: { complete: Boolean(requested), issues: requested ? [] : ["missing_tool_requested_event"] },
  };
}

function applyLifecycleEvent(run, event) {
  if (!run.argsHash && event.argsHash) run.argsHash = event.argsHash;
  applyExecutionMetadata(run, event);
  switch (event.type) {
    case "tool.authorization_decided":
      run.authorizationDecision = event.decision || null;
      break;
    case "tool.execution_started":
      run.adapterStarted = true;
      break;
    case "tool.validation_failed":
      run.validationFailed = true;
      break;
    case "tool.capability_unavailable":
      run.capabilityUnavailable = true;
      break;
    case "approval.requested":
      run.approval = { status: "requested", scope: null, reason: event.reason || null };
      break;
    case "approval.granted":
      run.approval = { status: "granted", scope: event.grantScope || "once", reason: run.approval?.reason || null };
      break;
    case "approval.denied":
      run.approval = { status: "denied", scope: null, reason: run.approval?.reason || null };
      break;
    case "tool.execution_unknown":
      run.unknown = event;
      run.recovery = { reason: event.reason || "execution_unknown" };
      break;
    case "tool.recovery_cancelled":
      run.recovery = { reason: event.reason || "process_interrupted_before_start" };
      run.closed = true;
      break;
    case "tool.completed":
      run.completion = event;
      run.durationMs = finiteDuration(event.durationMs) || 0;
      run.fileChanges = event.fileChanges || null;
      run.artifact = event.artifact || null;
      run.closed = true;
      break;
    default:
      break;
  }
}

function applyExecutionMetadata(run, event) {
  if (Object.hasOwn(event, "effectiveTimeoutMs")) {
    const timeoutMs = event.effectiveTimeoutMs;
    if (timeoutMs === null || (Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
      run.effectiveTimeoutMs = timeoutMs;
    }
  }
  if (typeof event.terminationReason === "string" && TERMINATION_REASONS.has(event.terminationReason)) {
    run.terminationReason = event.terminationReason;
  }
}

function applyLiveState(runs, { pendingApproval, toolStreams }) {
  if (pendingApproval?.id) {
    const candidates = runs.filter((candidate) => liveCallMatches(candidate, pendingApproval));
    const run = candidates.find((candidate) => candidate.approval?.status === "requested")
      || candidates.at(-1);
    if (run) {
      run.pendingApproval = pendingApproval;
      run.approval = {
        status: "requested",
        scope: null,
        reason: pendingApproval.reason || run.approval?.reason || null,
      };
    }
  }
  for (const [callId, stream] of Object.entries(toolStreams || {})) {
    const candidates = runs.filter((candidate) => !candidate.closed && candidate.callId === callId);
    const run = [...candidates].reverse().find((candidate) => candidate.adapterStarted)
      || candidates.at(-1);
    if (run) run.liveOutput = stream;
  }
}

function liveCallMatches(run, pendingApproval) {
  if (run.closed || run.callId !== pendingApproval.id) return false;
  if (pendingApproval.name && run.tool !== pendingApproval.name) return false;
  return !pendingApproval.argsHash || !run.argsHash || run.argsHash === pendingApproval.argsHash;
}

function findLifecycleRun(runs, event) {
  const openRuns = [...runs].reverse().filter((candidate) => !candidate.closed);
  if (Number.isSafeInteger(event.messageIndex) && Number.isSafeInteger(event.callOrdinal)) {
    return openRuns.find((candidate) => (
      candidate.callId === event.callId
      && candidate.messageIndex === event.messageIndex
      && candidate.callOrdinal === event.callOrdinal
    )) || null;
  }
  return openRuns.find((candidate) => candidate.callId === event.callId) || null;
}

function finalizeRun(run) {
  if (run.inherited) {
    run.status = "inherited";
    run.liveOutput = null;
    return;
  }
  const completionStatus = run.completion?.status || null;
  if (run.unknown || completionStatus === "execution_unknown") {
    run.status = "unknown";
    if (!run.durationMs) run.durationMs = finiteDuration(run.unknown?.durationMs) || 0;
  } else if (run.completion?.ok === true) {
    run.status = "succeeded";
  } else if (completionStatus === "cancelled") {
    run.status = "cancelled";
  } else if (run.completion && BLOCKED_STATUSES.has(completionStatus)) {
    run.status = "blocked";
  } else if (run.completion) {
    run.status = "failed";
  } else if (["process_interrupted_before_start", "turn_closed_before_tool_result"].includes(run.recovery?.reason)) {
    run.status = "cancelled";
  } else if (run.pendingApproval || run.approval?.status === "requested") {
    run.status = "awaiting_approval";
  } else if (run.approval?.status === "denied" || run.authorizationDecision === "deny") {
    run.status = "blocked";
  } else if (run.validationFailed || run.capabilityUnavailable) {
    run.status = "failed";
  } else if (!run.integrity.complete && run.result) {
    run.status = "unknown";
  } else if (run.adapterStarted || run.liveOutput) {
    run.status = "running";
  }

  if (run.closed) run.liveOutput = null;
}

function countRunStatuses(runs) {
  const counts = {
    total: runs.length,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    unknown: 0,
    running: 0,
    awaitingApproval: 0,
    inherited: 0,
    pending: 0,
  };
  for (const run of runs) {
    if (run.status === "awaiting_approval") counts.awaitingApproval += 1;
    else if (Object.hasOwn(counts, run.status)) counts[run.status] += 1;
  }
  return counts;
}

function aggregateFileChanges(runs) {
  const entries = runs.filter((run) => run.fileChanges).map((run) => ({
    entryKey: run.runKey,
    runKey: run.runKey,
    callId: run.callId,
    tool: run.tool,
    status: run.status,
    manifest: run.fileChanges,
  }));
  const manifests = entries.map((entry) => entry.manifest);
  const paths = new Set();
  const summary = { created: 0, modified: 0, deleted: 0, total: 0 };
  let operations = 0;
  let complete = true;
  for (const manifest of manifests) {
    const changes = Array.isArray(manifest.changes) ? manifest.changes : [];
    operations += changes.length;
    if (manifest.complete === false) complete = false;
    for (const change of changes) {
      if (change?.path) paths.add(change.path);
      if (["created", "modified", "deleted"].includes(change?.operation)) summary[change.operation] += 1;
    }
  }
  summary.total = operations;
  return { operations, uniquePaths: paths.size, complete, summary, manifests, entries };
}

function projectInheritedFileChanges(events) {
  const inherited = [];
  for (const [index, event] of events.entries()) {
    if (event?.type !== "tool.file_changes_inherited" || !event.fileChanges) continue;
    inherited.push({
      entryKey: `inherited:${event.seq ?? index + 1}:${inherited.length + 1}`,
      runKey: null,
      callId: event.callId || null,
      tool: event.tool || null,
      status: "inherited",
      parentSessionId: event.parentSessionId || null,
      parentCursor: Number.isSafeInteger(event.parentCursor) ? event.parentCursor : null,
      manifest: event.fileChanges,
    });
  }
  return inherited;
}

function turnStatus({ counts, terminal, modelRunning, phase, isCurrent, recoveryInterrupted, inheritedHistory }) {
  if (counts.unknown) return "unknown";
  if (terminal?.type === "session.failed") return "failed";
  if (counts.awaitingApproval || (isCurrent && phase === "awaiting_approval")) return "awaiting_approval";
  if (counts.running || counts.pending || modelRunning || (isCurrent && ["thinking", "executing"].includes(phase))) return "running";
  if (terminal?.type === "session.cancelled" || counts.cancelled) return "cancelled";
  if (recoveryInterrupted) return "interrupted";
  if (counts.failed || counts.blocked) return "attention";
  if (terminal?.type === "session.turn_completed") return "completed";
  if (inheritedHistory) return "inherited";
  return "idle";
}

function isToolLifecycleEvent(type) {
  return [
    "tool.authorization_decided",
    "tool.execution_started",
    "tool.validation_failed",
    "tool.capability_unavailable",
    "tool.execution_unknown",
    "tool.recovery_cancelled",
    "tool.completed",
    "approval.requested",
    "approval.granted",
    "approval.denied",
  ].includes(type);
}

function sumDuration(events) {
  return events.reduce((total, event) => total + (finiteDuration(event.durationMs) || 0), 0);
}

function finiteDuration(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function toolName(call) {
  return call?.name || call?.function?.name || null;
}
