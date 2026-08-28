import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";

test("Portable Journal 携带 Artifact 并在重映射 Session 后保持可读", async (t) => {
  const source = await fixture(t, "nexus-artifact-export-");
  const destination = await fixture(t, "nexus-artifact-import-");
  const session = await createArtifactSession(source.store, source.workspace, "session-artifact-export");
  const artifact = await attachArtifact(source.store, session, {
    callId: "call-portable",
    content: `${"portable\n".repeat(2_000)}PORTABLE-TAIL`,
  });

  const archive = source.store.exportJournal(session.id, { exportedAt: "2026-08-28T10:00:00.000Z" });
  assert.equal(archive.artifacts.length, 1);
  assert.equal(archive.artifacts[0].id, artifact.id);
  assert.match(archive.artifacts[0].content, /PORTABLE-TAIL$/);
  assert.equal(archive.artifacts[0].sessionId, undefined);

  const imported = destination.store.importJournal(archive, {
    id: "session-artifact-imported",
    workspace: destination.workspace,
  });
  const restored = await destination.store.artifacts.get(artifact.id, { sessionId: imported.id });
  assert.match(restored.content, /PORTABLE-TAIL$/);
  const toolResult = destination.store.listSessionEvents(imported.id).find((event) => event.type === "TOOL_RESULT");
  assert.equal(toolResult.artifact.sessionId, imported.id);
  assert.equal(toolResult.artifact.id, artifact.id);

  const second = destination.store.importJournal(archive, {
    id: "session-artifact-imported-again",
    workspace: destination.workspace,
  });
  assert.equal((await destination.store.artifacts.get(artifact.id, { sessionId: second.id })).sha256, artifact.sha256);
});

test("Artifact 被篡改的 Archive 原子拒绝且不留下 Session", async (t) => {
  const source = await fixture(t, "nexus-artifact-tamper-source-");
  const destination = await fixture(t, "nexus-artifact-tamper-target-");
  const session = await createArtifactSession(source.store, source.workspace, "session-artifact-tamper");
  await attachArtifact(source.store, session, { callId: "call-tamper", content: "完整内容" });
  const archive = source.store.exportJournal(session.id);
  archive.artifacts[0].content = "篡改内容";

  assert.throws(
    () => destination.store.importJournal(archive, {
      id: "session-artifact-rejected",
      workspace: destination.workspace,
    }),
    /checksum|Artifact/,
  );
  assert.equal(destination.store.load("session-artifact-rejected"), null);
  assert.equal(await destination.store.artifacts.get(archive.artifacts[0].id, {
    sessionId: "session-artifact-rejected",
  }), null);
});

test("Session Branch 只复制指定 cursor 已可见的 Artifact", async (t) => {
  const current = await fixture(t, "nexus-artifact-branch-");
  const session = await createArtifactSession(current.store, current.workspace, "session-artifact-parent");
  const visible = await attachArtifact(current.store, session, { callId: "call-visible", content: "visible-content" });
  const cursor = session.cursor;
  const future = await attachArtifact(current.store, session, { callId: "call-future", content: "future-content" });

  const branch = current.store.branchSession(session.id, {
    id: "session-artifact-branch",
    cursor,
    provider: session.state.provider,
    workspace: current.workspace,
  });

  assert.equal((await current.store.artifacts.get(visible.id, { sessionId: branch.id })).content, "visible-content");
  assert.equal(await current.store.artifacts.get(future.id, { sessionId: branch.id }), null);
  assert.deepEqual((await current.store.artifacts.list({ sessionId: branch.id })).map((item) => item.id), [visible.id]);
});

test("Session Branch 缺少被引用 Artifact 时不留下半创建基线", async (t) => {
  const current = await fixture(t, "nexus-artifact-branch-atomic-");
  const session = await createArtifactSession(current.store, current.workspace, "session-artifact-broken-parent");
  const artifact = await attachArtifact(current.store, session, { callId: "call-missing", content: "missing-content" });
  current.store.db.prepare("DELETE FROM artifacts WHERE session_id = ? AND id = ?").run(session.id, artifact.id);

  assert.throws(() => current.store.branchSession(session.id, {
    id: "session-artifact-broken-branch",
    cursor: session.cursor,
    provider: session.state.provider,
    workspace: current.workspace,
  }), /Artifact 不存在/);
  assert.equal(current.store.load("session-artifact-broken-branch"), null);
  assert.equal(current.store.latestSessionCursor("session-artifact-broken-branch"), 0);
});

test("无 Artifact 的旧式 Archive 继续保持原有可导入结构", async (t) => {
  const source = await fixture(t, "nexus-artifact-legacy-source-");
  const destination = await fixture(t, "nexus-artifact-legacy-target-");
  const state = createSession({ id: "session-no-artifact", provider: "test", workspace: source.workspace });
  source.store.ensureJournal(state);
  const archive = source.store.exportJournal(state.id);

  assert.equal("artifacts" in archive, false);
  assert.equal(destination.store.importJournal(archive, {
    id: "session-no-artifact-imported",
    workspace: destination.workspace,
  }).id, "session-no-artifact-imported");
});

test("migration v7 保留 v6 Artifact 并升级为 Session 复合主键", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-artifact-migration-"));
  const file = path.join(workspace, ".nexus", "nexus.db");
  const initial = new SessionStore(file, { workspace });
  const state = createSession({ id: "session-artifact-v6", provider: "test", workspace });
  initial.ensureJournal(state);
  const artifact = await initial.artifacts.put({ sessionId: state.id, content: "v6-preserved" });
  initial.close();

  const legacy = new DatabaseSync(file);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX artifacts_session_created;
    ALTER TABLE artifacts RENAME TO artifacts_v7;
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      call_id TEXT,
      kind TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      content BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    INSERT INTO artifacts SELECT * FROM artifacts_v7;
    DROP TABLE artifacts_v7;
    CREATE INDEX artifacts_session_created ON artifacts(session_id, created_at, id);
    DELETE FROM schema_migrations WHERE version = 7;
  `);
  legacy.close();

  const migrated = new SessionStore(file, { workspace });
  t.after(async () => {
    migrated.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  assert.equal((await migrated.artifacts.get(artifact.id, { sessionId: state.id })).content, "v6-preserved");
  assert.deepEqual(
    migrated.db.prepare("PRAGMA table_info(artifacts)").all()
      .filter((column) => column.pk)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name),
    ["session_id", "id"],
  );
});

async function createArtifactSession(store, workspace, id) {
  const initial = createSession({ id, provider: "test", workspace });
  store.ensureJournal(initial);
  return new AgentSession({ state: initial, reducer: reduceSession, journal: store });
}

async function attachArtifact(store, session, { callId, content }) {
  const artifact = await store.artifacts.put({ sessionId: session.id, callId, content });
  await session.dispatch({
    type: "TOOL_RESULT",
    call: { id: callId, name: "portable_output", arguments: {} },
    ok: true,
    status: "completed",
    result: `预览\n…完整输出已保存为 Artifact：${artifact.id}（${artifact.byteSize} 字节）`,
    artifact,
    durationMs: 1,
  });
  return artifact;
}

async function fixture(t, prefix) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  return { workspace, store };
}
