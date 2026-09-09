import { createHash } from "node:crypto";

export const PROGRESS_MONITOR_VERSION = "progress-monitor-v1";
export const PARALLEL_PROGRESS_MONITOR_VERSION = "progress-monitor-v2";
export const MAX_PROGRESS_INTERVENTIONS = 2;
export const REPEATED_FAILURE_THRESHOLD = 3;
const HASH = /^sha256:[a-f0-9]{64}$/;
const ARGUMENT_HASH = /^[a-f0-9]{64}$/;
const FAILURE_STATUSES = new Set(["not_found", "validation_failed", "external_failed"]);

// Compare full redacted output hashes, never the 160-character display preview.
// This reports repeated failures, not proof that the whole task made no progress.
export function failureFingerprint(request, result) {
  if (request?.type !== "tool.requested" || result?.type !== "tool.completed"
      || !positiveInteger(request.seq) || !positiveInteger(result.seq) || request.seq >= result.seq
      || typeof request.callId !== "string" || !request.callId
      || typeof request.tool !== "string" || !request.tool
      || request.callId !== result.callId || request.tool !== result.tool
      || !ARGUMENT_HASH.test(request.argsHash) || !HASH.test(result.resultHash)
      || result.ok !== false || !FAILURE_STATUSES.has(result.status)) return null;
  if (!Array.isArray(request.effects)
      || request.effects.some((effect) => effect === "memory" || effect === "credential")) return null;
  // A failed write may still have produced useful changes. Incomplete observation
  // cannot establish otherwise. Unknown external outcomes are excluded by status.
  if (result.fileChanges != null && (result.fileChanges.complete !== true
      || result.fileChanges.summary?.total !== 0
      || !Array.isArray(result.fileChanges.changes) || result.fileChanges.changes.length)) return null;
  return `sha256:${createHash("sha256").update(JSON.stringify([
    PROGRESS_MONITOR_VERSION, request.tool, request.argsHash, result.status, result.resultHash,
  ])).digest("hex")}`;
}

// One instance belongs to one user turn. Only committed projection events enter;
// the Runtime asks for feedback after every complete model tool-call batch.
// Retain at most three distinct pending IDs and three completed pairs. Parallel
// batches keep request identity until every result arrives; no tool bodies persist.
export class ProgressMonitor {
  #pending = new Map();
  #untracked = 0;
  #fingerprint = null;
  #occurrences = [];
  #attempt = 0;
  #lastSeq = 0;

  observe(event) {
    if (!positiveInteger(event?.seq) || event.seq <= this.#lastSeq) return;
    if (this.#lastSeq && event.seq !== this.#lastSeq + 1) this.#resetAll();
    this.#lastSeq = event.seq;
    if (this.#attempt >= MAX_PROGRESS_INTERVENTIONS) return;
    if (["message.user", "session.failed", "session.cancelled", "session.turn_completed"].includes(event.type)) {
      this.#resetAll();
      return;
    }
    if (event.type === "tool.requested") {
      if (this.#untracked) {
        this.#untracked += 1;
        return;
      }
      const pending = this.#pending.get(event.callId);
      if (pending) {
        this.#resetStreak();
        pending.request = null;
        pending.count += 1;
        return;
      }
      if (this.#pending.size >= 3) {
        // Outside the native batch bound, discard ambiguous identities and
        // suppress feedback until all outstanding results have drained.
        this.#untracked = 1 + [...this.#pending.values()].reduce((total, item) => total + item.count, 0);
        this.#pending.clear();
        this.#resetStreak();
        return;
      }
      // Retain only the identity needed by the fingerprint, never arguments/body.
      this.#pending.set(event.callId, { count: 1, request: { type: event.type, seq: event.seq, callId: event.callId,
        tool: event.tool, argsHash: event.argsHash, effects: event.effects } });
      return;
    }
    if (event.type !== "tool.completed") return;
    if (this.#untracked) {
      this.#untracked -= 1;
      this.#resetStreak();
      return;
    }
    const pending = this.#pending.get(event.callId);
    const request = pending?.request;
    if (pending && --pending.count === 0) this.#pending.delete(event.callId);
    const fingerprint = failureFingerprint(request, event);
    if (!fingerprint) {
      this.#resetStreak();
      return;
    }
    if (this.#occurrences.at(-1)?.requestSeq >= request.seq) this.#resetStreak();
    if (this.#fingerprint !== fingerprint) this.#occurrences = [];
    this.#fingerprint = fingerprint;
    this.#occurrences.push({ requestSeq: request.seq, resultSeq: event.seq });
    if (this.#occurrences.length > REPEATED_FAILURE_THRESHOLD) this.#occurrences.shift();
  }

  takeIntervention() {
    if (this.#pending.size || this.#untracked || this.#occurrences.length < REPEATED_FAILURE_THRESHOLD
        || this.#attempt >= MAX_PROGRESS_INTERVENTIONS) return null;
    const action = {
      type: "PROGRESS_INTERVENTION",
      version: this.#occurrences.some((item, index) => index > 0 && item.requestSeq <= this.#occurrences[index - 1].resultSeq)
        ? PARALLEL_PROGRESS_MONITOR_VERSION : PROGRESS_MONITOR_VERSION,
      reason: "repeated_tool_failure",
      attempt: ++this.#attempt,
      fingerprint: this.#fingerprint,
      occurrences: this.#occurrences.map((item) => ({ ...item })),
    };
    this.#resetStreak();
    return action;
  }

  #resetStreak() {
    this.#fingerprint = null;
    this.#occurrences = [];
  }

  #resetAll() {
    this.#pending.clear();
    this.#untracked = 0;
    this.#resetStreak();
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
