import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { compareReplayEvaluations, evaluateJournalArchive, REPLAY_EVALUATION_VERSION } from "../src/evaluation/replay-harness.js";
import { SessionStore } from "../src/persistence/session-store.js";

test("Replay Harness 校验 Archive 并确定性重放健康报告", async (t) => {
  const fixture = await createArchiveFixture("completed");
  t.after(fixture.close);

  const report = evaluateJournalArchive(fixture.archive);
  assert.equal(report.version, REPLAY_EVALUATION_VERSION);
  assert.equal(report.replay.deterministic, true);
  assert.match(report.replay.stateHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.replay.eventHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(report.replay.contextHashes, ["sha256:fixture-context"]);
  assert.equal(report.evaluation.status, "healthy");
  assert.equal(report.evaluation.metrics.totalTokens, 12);
  assert.equal(JSON.stringify(report).includes("私密评测正文"), false);

  const comparison = compareReplayEvaluations(report, evaluateJournalArchive(structuredClone(fixture.archive)));
  assert.equal(comparison.passed, true);
  assert.ok(comparison.checks.every((item) => item.match));
});

test("Replay Harness 拒绝被篡改的 Archive，并解释不同重放结果", async (t) => {
  const completed = await createArchiveFixture("completed");
  const failed = await createArchiveFixture("failed");
  t.after(async () => Promise.all([completed.close(), failed.close()]));

  const tampered = structuredClone(completed.archive);
  tampered.events.at(-1).action.type = "FAILED";
  assert.throws(() => evaluateJournalArchive(tampered), /checksum/);

  const comparison = compareReplayEvaluations(
    evaluateJournalArchive(completed.archive),
    evaluateJournalArchive(failed.archive),
  );
  assert.equal(comparison.passed, false);
  assert.equal(comparison.checks.find((item) => item.field === "status").match, false);
  assert.equal(comparison.checks.find((item) => item.field === "eventHash").match, false);
});

async function createArchiveFixture(outcome) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `nexus-replay-${outcome}-`));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const session = new AgentSession({
    state: createSession({
      provider: "fixture-provider",
      workspace,
      id: `session-replay-${outcome}`,
      createdAt: "2026-08-31T01:00:00.000Z",
    }),
    reducer: reduceSession,
    journal: store,
  });
  await session.dispatch({ type: "USER_MESSAGE", content: "私密评测正文", at: "2026-08-31T01:00:01.000Z" });
  await session.dispatch({
    type: "MODEL_CONTEXT_PREPARED",
    plan: {
      contextHash: "sha256:fixture-context",
      maxInputTokens: 1_000,
      estimatedInputTokens: 100,
      compacted: false,
    },
    at: "2026-08-31T01:00:02.000Z",
  });
  await session.dispatch({ type: "MODEL_REQUESTED", at: "2026-08-31T01:00:03.000Z" });
  await session.dispatch({
    type: "MODEL_COMPLETED",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    durationMs: 20,
    at: "2026-08-31T01:00:04.000Z",
  });
  if (outcome === "completed") {
    await session.dispatch({
      type: "ASSISTANT_MESSAGE",
      message: { role: "assistant", content: "私密评测正文已完成" },
      at: "2026-08-31T01:00:05.000Z",
    });
    await session.dispatch({ type: "COMPLETED", at: "2026-08-31T01:00:06.000Z" });
  } else {
    await session.dispatch({ type: "FAILED", error: "私密评测失败原因", at: "2026-08-31T01:00:05.000Z" });
  }
  return {
    archive: store.exportJournal(session.id, { exportedAt: "2026-08-31T02:00:00.000Z" }),
    close: async () => {
      store.close();
      await fs.rm(workspace, { recursive: true, force: true });
    },
  };
}
