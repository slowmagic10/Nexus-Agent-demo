// Offline synthetic measurements only. No application configuration, existing
// database, service, model, or ToolHost is loaded or executed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginFileChangeCapture, finishFileChangeCapture } from "../src/artifacts/file-change-manifest.js";
import { UNIFIED_DIFF_FORMAT } from "../src/artifacts/unified-diff.js";
import { createSession, reduceSession, SESSION_SCHEMA_VERSION } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { createStatePatch } from "../src/state-patch.js";

const CHECKPOINT_INPUT = Object.freeze({ checkpointCount: 96, paddingChars: 16_000, trailingEvents: 3,
  sessionId: "synthetic-checkpoint-cost", createdAt: "2026-09-09T00:00:00.000Z" });
const DIFF_INPUT = Object.freeze({ file: "document.txt", lineCount: 10_000,
  cases: [{ name: "one-change", changedLines: [5000] }, { name: "two-distant-changes", changedLines: [1201, 8801] }] });

async function measure() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-harness-cost-"));
  try {
    const checkpoint = await measureCheckpoint(path.join(root, "checkpoint"));
    const diff = [];
    for (const sample of DIFF_INPUT.cases) diff.push(await measureDiff(path.join(root, sample.name), sample));
    return {
      metadata: {
        version: 1,
        benchmark: "nexus.synthetic-harness-boundary-costs",
        nodeVersion: process.version,
        platform: process.platform,
        sessionSchemaVersion: SESSION_SCHEMA_VERSION,
        harness: {
          checkpoint: "descending-lazy-reader-until-first-valid-checkpoint",
          diff: UNIFIED_DIFF_FORMAT,
          diffContextLines: 3,
          captureAuthorization: "unchanged-default-workspace-auto",
        },
        inputsSha256: sha256(JSON.stringify({ checkpoint: CHECKPOINT_INPUT, diff: DIFF_INPUT })),
        syntheticOnly: true,
        boundaries: ["SQLite checkpoint stateJson payloads materialized in JavaScript", "rendered text Diff UTF-8 bytes and line structure"],
        notMeasured: ["RSS or peak heap", "whole SessionStore.load latency", "SQLite internal I/O or query execution time", "real-model task quality"],
      },
      checkpoint,
      diff,
      checksPassed: allTrue(checkpoint.checks) && diff.every((sample) => allTrue(sample.checks)),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function measureCheckpoint(workspace) {
  await fs.mkdir(workspace, { recursive: true });
  const store = new SessionStore(path.join(workspace, "synthetic.sqlite"), { workspace, checkpointInterval: 1 });
  try {
    const expected = seedCheckpointHistory(store);
    const aggregate = store.db.prepare(`SELECT COUNT(*) AS count, SUM(length(CAST(state_json AS BLOB))) AS bytes
      FROM session_checkpoints WHERE session_id = ?`).get(expected.id);
    const eager = measureProjection(store, expected.id, "historical-all");
    const current = measureProjection(store, expected.id, "current-iterator");
    assert.deepEqual(current.events, eager.events);
    assert.deepEqual(replay(current.events), expected);
    assert.deepEqual(replay(eager.events), expected);
    assert.equal(aggregate.count, CHECKPOINT_INPUT.checkpointCount);
    assert.equal(eager.metrics.payloadCount, aggregate.count);
    assert.equal(eager.metrics.payloadUtf8Bytes, aggregate.bytes);
    assert.equal(current.metrics.payloadCount, 1);
    assert.equal(current.metrics.selectedCursor, CHECKPOINT_INPUT.checkpointCount + 1);
    assert.equal(current.metrics.trailingJournalEvents, CHECKPOINT_INPUT.trailingEvents);
    assert.equal(eager.metrics.activeIterators, 0);
    assert.equal(current.metrics.activeIterators, 0);
    return {
      input: { ...CHECKPOINT_INPUT, inputSha256: sha256(JSON.stringify(CHECKPOINT_INPUT)) },
      candidateCount: aggregate.count,
      baseline: {
        strategy: "same recovery validator; checkpoint iterate supplied by historical statement.all(...params)[Symbol.iterator]()",
        ...eager.metrics,
      },
      current: { strategy: "actual SessionStore.readProjectionEvents with native iterator or one-row get fallback", ...current.metrics },
      payloadUtf8BytesSaved: eager.metrics.payloadUtf8Bytes - current.metrics.payloadUtf8Bytes,
      payloadReductionPercent: percentageSaved(eager.metrics.payloadUtf8Bytes, current.metrics.payloadUtf8Bytes),
      checks: {
        selectedCheckpointEqual: eager.metrics.selectedCursor === current.metrics.selectedCursor,
        recoveredProjectionEqual: true,
        recoveredProjectionMatchesSeed: true,
        allBaselineCandidatesMaterialized: true,
        onlyOneCurrentPayloadMaterialized: true,
        journalTailReplayed: true,
        iteratorsClosed: true,
      },
    };
  } finally {
    store.close();
  }
}

function seedCheckpointHistory(store) {
  const { sessionId: id, createdAt, checkpointCount, paddingChars, trailingEvents } = CHECKPOINT_INPUT;
  let state = createSession({ id, provider: "synthetic-offline", workspace: store.workspace, createdAt });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "a".repeat(paddingChars), at: createdAt });
  store.ensureJournal(state);
  for (let index = 0; index < checkpointCount + trailingEvents; index += 1) {
    // Keep a real Journal tail after the 96th checkpoint so equivalence also
    // covers reducer recovery, rather than only comparing snapshot objects.
    if (index === checkpointCount) store.checkpointInterval = 1000;
    const action = { type: "MEMORY_ADDED", content: `合成记忆 ${index}`,
      at: new Date(Date.UTC(2026, 8, 9, 0, 0, index + 1)).toISOString() };
    const next = reduceSession(state, action);
    store.commitSessionEvent(next, action, createStatePatch(state, next));
    state = next;
  }
  return state;
}

function measureProjection(store, id, strategy) {
  const database = store.db;
  const metrics = { payloadCount: 0, payloadUtf8Bytes: 0, checkpointQueries: 0, activeIterators: 0, iteratorReturns: 0 };
  const observe = (row) => {
    if (typeof row?.stateJson !== "string") return;
    metrics.payloadCount += 1;
    metrics.payloadUtf8Bytes += Buffer.byteLength(row.stateJson, "utf8");
  };
  store.db = new Proxy(database, {
    get(target, property) {
      if (property !== "prepare") return boundMember(target, property);
      return (sql) => {
        const statement = target.prepare(sql);
        if (!/FROM\s+session_checkpoints\b/i.test(sql) || !/state_json\s+AS\s+stateJson/i.test(sql)) return statement;
        return new Proxy(statement, {
          get(targetStatement, method) {
            if (method === "iterate" && strategy === "current-iterator" && typeof targetStatement.iterate !== "function") return undefined;
            if (method === "iterate") return (...args) => {
              metrics.checkpointQueries += 1;
              let iterator;
              if (strategy === "historical-all") {
                // Reproduce the former eager SQLite -> JS materialization while
                // retaining exactly the current checksum/schema/cursor checks.
                const rows = targetStatement.all(...args);
                rows.forEach(observe);
                iterator = rows[Symbol.iterator]();
              } else iterator = targetStatement.iterate(...args);
              let active = true;
              metrics.activeIterators += 1;
              const close = () => { if (active) { active = false; metrics.activeIterators -= 1; } };
              return {
                [Symbol.iterator]() { return this; },
                next() {
                  const result = iterator.next();
                  if (result.done) close();
                  else if (strategy === "current-iterator") observe(result.value);
                  return result;
                },
                return() { metrics.iteratorReturns += 1; close(); return iterator.return?.() || { done: true }; },
              };
            };
            if (method === "all") return (...args) => {
              metrics.checkpointQueries += 1;
              const rows = targetStatement.all(...args);
              rows.forEach(observe);
              return rows;
            };
            if (method === "get") return (...args) => {
              metrics.checkpointQueries += 1;
              const row = targetStatement.get(...args);
              observe(row);
              return row;
            };
            return boundMember(targetStatement, method);
          },
        });
      };
    },
  });
  try {
    const events = store.readProjectionEvents(id);
    assert.equal(events[0]?.type, "SESSION_CHECKPOINT");
    return { events, metrics: { ...metrics, selectedCursor: events[0].cursor, trailingJournalEvents: events.length - 1 } };
  } finally {
    store.db = database;
  }
}

async function measureDiff(workspace, sample) {
  await fs.mkdir(workspace, { recursive: true });
  const originalLines = Array.from({ length: DIFF_INPUT.lineCount }, (_, index) => `line ${String(index + 1).padStart(5, "0")} original\n`);
  const updatedLines = [...originalLines];
  for (const line of sample.changedLines) updatedLines[line - 1] = `line ${String(line).padStart(5, "0")} modified\n`;
  const before = originalLines.join("");
  const after = updatedLines.join("");
  assert.ok(Buffer.byteLength(before) <= 256_000);
  assert.ok(Buffer.byteLength(after) <= 256_000);
  await fs.writeFile(path.join(workspace, DIFF_INPUT.file), before);
  const capture = await beginFileChangeCapture({ workspace, mode: "paths", paths: [DIFF_INPUT.file] });
  await fs.writeFile(path.join(workspace, DIFF_INPUT.file), after);
  const { manifest, diff } = await finishFileChangeCapture(capture);
  const oldDiff = renderHistoricalReplacement(before, after, DIFF_INPUT.file, capture.options.maxDiffChars);
  const baseline = diffMetrics(oldDiff.content, oldDiff.truncated);
  const current = diffMetrics(diff, manifest.diffTruncated);
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.summary, { created: 0, modified: 1, deleted: 0, total: 1 });
  assert.deepEqual(manifest.issues, []);
  assert.equal(manifest.diffFormat, UNIFIED_DIFF_FORMAT);
  assert.equal(manifest.diffStats.hunks, current.hunks);
  assert.equal(manifest.diffStats.workLimited, false);
  assert.equal(current.diffTruncated, false);
  assert.equal(baseline.diffTruncated, false);
  assert.equal(baseline.removedLines, DIFF_INPUT.lineCount);
  assert.equal(baseline.addedLines, DIFF_INPUT.lineCount);
  assert.equal(current.hunks, sample.changedLines.length);
  assert.equal(current.removedLines, sample.changedLines.length);
  assert.equal(current.addedLines, sample.changedLines.length);
  for (const line of sample.changedLines) {
    assert.ok(diff.includes(`-${originalLines[line - 1]}`));
    assert.ok(diff.includes(`+${updatedLines[line - 1]}`));
  }
  assert.equal(applySyntheticLfPatch(before, diff), after);
  return {
    name: sample.name,
    input: { lineCount: DIFF_INPUT.lineCount, changedLines: sample.changedLines,
      beforeUtf8Bytes: Buffer.byteLength(before), afterUtf8Bytes: Buffer.byteLength(after),
      beforeSha256: sha256(before), afterSha256: sha256(after),
      inputSha256: sha256(JSON.stringify({ file: DIFF_INPUT.file, beforeSha256: sha256(before), afterSha256: sha256(after) })) },
    captureLimits: { maxFiles: capture.options.maxFiles, maxFileBytes: capture.options.maxFileBytes,
      maxTotalBytes: capture.options.maxTotalBytes, maxDiffChars: capture.options.maxDiffChars },
    baseline: { strategy: "historical-full-file-replacement-renderer", ...baseline },
    current: { strategy: "actual-begin-and-finish-file-change-capture", ...current, format: manifest.diffFormat, stats: manifest.diffStats },
    manifestSummary: manifest.summary,
    diffUtf8BytesSaved: baseline.utf8Bytes - current.utf8Bytes,
    diffReductionPercent: percentageSaved(baseline.utf8Bytes, current.utf8Bytes),
    checks: { captureComplete: true, exactlyOneModifiedFile: true, noCaptureIssues: true,
      changedLinesPresent: true, hunkCoordinatesReconstructAfter: true,
      currentLineCountsMatchEdits: true, bothRenderersComplete: true, defaultCaptureLimitsPreserved: true },
  };
}

// Exact former renderer formula for one ordinary LF text file. The benchmark
// samples contain no secrets, special paths, binary bytes, or incomplete lines.
function renderHistoricalReplacement(before, after, file, maxChars) {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  if (oldLines.at(-1) === "") oldLines.pop();
  if (newLines.at(-1) === "") newLines.pop();
  const chunk = [`--- a/${file}`, `+++ b/${file}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`), ""].join("\n");
  return chunk.length <= maxChars ? { content: chunk, truncated: false }
    : { content: chunk.slice(0, maxChars) + "\n…Diff 已达到采集上限…\n", truncated: true };
}

function diffMetrics(diff, diffTruncated) {
  const rows = diff.split("\n");
  return { utf8Bytes: Buffer.byteLength(diff, "utf8"), hunks: rows.filter((line) => line.startsWith("@@ ")).length,
    addedLines: rows.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length,
    removedLines: rows.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length,
    contextLines: rows.filter((line) => line.startsWith(" ")).length, diffTruncated };
}

// Independent consumer for these LF-terminated synthetic samples. Validate both
// old/new offsets and counts before accepting each hunk; do not invoke git.
function applySyntheticLfPatch(before, diff) {
  const original = before.match(/[^\n]*\n/g) || [];
  const patch = diff.split("\n");
  const output = [];
  let consumed = 0;
  for (let index = 0; index < patch.length; index += 1) {
    if (!patch[index].startsWith("@@ ")) continue;
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(patch[index]);
    assert.ok(header);
    const [oldStart, oldCount, newStart, newCount] = header.slice(1).map(Number);
    assert.ok(oldStart - 1 >= consumed);
    output.push(...original.slice(consumed, oldStart - 1));
    consumed = oldStart - 1;
    assert.equal(output.length, newStart - 1);
    const oldBody = [];
    const newBody = [];
    while (oldBody.length < oldCount || newBody.length < newCount) {
      const line = patch[++index];
      assert.ok(line && [" ", "+", "-"].includes(line[0]));
      if (line[0] !== "+") oldBody.push(line.slice(1) + "\n");
      if (line[0] !== "-") newBody.push(line.slice(1) + "\n");
    }
    assert.equal(oldBody.length, oldCount);
    assert.equal(newBody.length, newCount);
    assert.deepEqual(original.slice(consumed, consumed + oldCount), oldBody);
    consumed += oldCount;
    output.push(...newBody);
  }
  output.push(...original.slice(consumed));
  return output.join("");
}

function replay(events) { return events.slice(1).reduce((state, event) => reduceSession(state, event.action), events[0].baseline); }
function boundMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function percentageSaved(before, after) { return Number(((1 - after / before) * 100).toFixed(4)); }
function allTrue(checks) { return Object.values(checks).every((value) => value === true); }

try {
  const report = await measure();
  assert.equal(report.checksPassed, true);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  // Never include raw SQLite records, event text, or temporary/user paths in a
  // report, even when a future source change breaks a benchmark assertion.
  process.stderr.write(JSON.stringify({ metadata: { version: 1, syntheticOnly: true }, checksPassed: false,
    error: error instanceof assert.AssertionError ? "measurement_assertion_failed" : "measurement_failed" }) + "\n");
  process.exitCode = 1;
}
