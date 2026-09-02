import { createHash } from "node:crypto";
import { validateAndReplayJournalArchive } from "../persistence/session-store.js";
import { evaluateSession } from "./session-evaluation.js";

export const REPLAY_EVALUATION_VERSION = "journal-replay-evaluation-v1";

export function evaluateJournalArchive(archive) {
  const first = validateAndReplayJournalArchive(archive);
  const second = validateAndReplayJournalArchive(structuredClone(archive));
  const stateHash = digest(first.state);
  const eventHash = digest(first.events);
  const repeatedStateHash = digest(second.state);
  const repeatedEventHash = digest(second.events);
  const evaluation = evaluateSession(first.state);

  return {
    version: REPLAY_EVALUATION_VERSION,
    archive: {
      format: archive.format,
      formatVersion: archive.formatVersion,
      checksum: archive.checksum,
      sessionId: archive.session.id,
      cursor: archive.session.cursor,
      artifactCount: first.artifactCount,
    },
    replay: {
      deterministic: stateHash === repeatedStateHash && eventHash === repeatedEventHash,
      stateHash,
      eventHash,
      contextHashes: first.state.events
        .filter((event) => ["model.context_prepared", "model.context_compacted"].includes(event.type) && typeof event.contextHash === "string")
        .map((event) => event.contextHash),
    },
    evaluation,
  };
}

export function compareReplayEvaluations(left, right) {
  assertReplayEvaluation(left, "left");
  assertReplayEvaluation(right, "right");
  const checks = [
    check("cursor", left.archive.cursor, right.archive.cursor),
    check("stateHash", left.replay.stateHash, right.replay.stateHash),
    check("eventHash", left.replay.eventHash, right.replay.eventHash),
    check("contextHashes", left.replay.contextHashes, right.replay.contextHashes),
    check("status", left.evaluation.status, right.evaluation.status),
    check("metrics", left.evaluation.metrics, right.evaluation.metrics),
    check("issues", left.evaluation.issues.map((issue) => issue.code), right.evaluation.issues.map((issue) => issue.code)),
  ];
  return {
    passed: checks.every((item) => item.match),
    checks,
  };
}

function assertReplayEvaluation(value, label) {
  if (!value || value.version !== REPLAY_EVALUATION_VERSION || !value.archive || !value.replay || !value.evaluation) {
    throw new Error(`${label} 必须是 ${REPLAY_EVALUATION_VERSION} 报告`);
  }
}

function check(field, left, right) {
  return {
    field,
    match: canonical(left) === canonical(right),
    left,
    right,
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
