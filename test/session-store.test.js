import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSession, migrateSessionState, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";

test("会话状态可保存、列出并按 ID 恢复", () => {
  const fixture = createFixture();
  try {
    let state = createSession({ provider: "demo", workspace: fixture.workspace });
    state = reduceSession(state, { type: "USER_MESSAGE", content: "记住我的偏好" });
    state = reduceSession(state, { type: "MEMORY_ADDED", content: "偏好本地模型" });
    fixture.store.save(state);

    assert.deepEqual(fixture.store.load(state.id), state);
    assert.equal(fixture.store.latest(fixture.workspace).id, state.id);
    const [summary] = fixture.store.list(fixture.workspace);
    assert.equal(summary.id, state.id);
    assert.equal(summary.title, "记住我的偏好");
  } finally {
    fixture.close();
  }
});

test("恢复会话会丢弃未决审批并留下审计事件", () => {
  const call = { id: "call-1", name: "write_file", arguments: { path: "x", content: "y" } };
  let state = createSession({ provider: "old", workspace: "/old" });
  state = reduceSession(state, {
    type: "ASSISTANT_MESSAGE",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: "{}" } }],
    },
  });
  state = reduceSession(state, { type: "APPROVAL_REQUESTED", call });
  state = reduceSession(state, { type: "RESUMED", provider: "new", workspace: "/new" });

  assert.equal(state.phase, "idle");
  assert.equal(state.pendingApproval, null);
  assert.equal(state.provider, "new");
  assert.equal(state.workspace, "/new");
  assert.deepEqual(state.messages.at(-1), {
    role: "tool",
    tool_call_id: "call-1",
    content: "会话恢复：该工具调用尚未获得审批，已取消且未执行。",
  });
  const event = state.events.at(-1);
  assert.equal(event.type, "session.resumed");
  assert.equal(event.previousPhase, "awaiting_approval");
  assert.equal(event.discardedApproval, "write_file");
  assert.deepEqual(event.reconciledToolCalls, ["write_file"]);
});

test("恢复会话不会重复补全已有工具结果", () => {
  let state = createSession({ provider: "demo", workspace: "/workspace" });
  state.messages.push(
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "done-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "done-1", content: "完成" },
  );

  const resumed = reduceSession(state, { type: "RESUMED", provider: "demo", workspace: "/workspace" });
  assert.equal(resumed.messages.length, state.messages.length);
  assert.deepEqual(resumed.events.at(-1).reconciledToolCalls, []);
});

test("恢复执行中的工具会记录 execution_unknown 且不自动重放", () => {
  const call = { id: "call-interrupted", name: "run_shell", arguments: { command: "echo ok" } };
  let state = createSession({ provider: "demo", workspace: "/workspace" });
  state = reduceSession(state, {
    type: "ASSISTANT_MESSAGE",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: "{}" } }],
    },
  });
  state = reduceSession(state, { type: "TOOL_REQUESTED", call });
  state = reduceSession(state, {
    type: "TOOL_EXECUTION_STARTED",
    call,
    argsHash: "hash",
    toolVersion: "version",
    effects: ["execute"],
    idempotency: "unknown",
    adapter: "native",
  });

  const resumed = reduceSession(state, { type: "RESUMED", provider: "demo", workspace: "/workspace" });

  assert.match(resumed.messages.at(-1).content, /执行状态未知.*不会自动重放/);
  assert.ok(resumed.events.some((event) => (
    event.type === "tool.execution_unknown" && event.callId === call.id && event.reason === "process_interrupted"
  )));
});

test("长期记忆支持保存、搜索和删除", async () => {
  const fixture = createFixture();
  try {
    const memory = await fixture.store.addMemory("偏好本地模型", { tags: ["preference", "local"] });
    assert.equal((await fixture.store.searchMemories("本地"))[0].id, memory.id);
    assert.equal((await fixture.store.searchMemories("preference"))[0].content, "偏好本地模型");
    assert.equal(await fixture.store.deleteMemory(memory.id), true);
    assert.deepEqual(await fixture.store.searchMemories("本地"), []);
  } finally {
    fixture.close();
  }
});

test("旧数据库会按顺序执行显式 schema migration", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-migration-test-"));
  const file = path.join(workspace, "nexus.db");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      workspace TEXT NOT NULL,
      phase TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      state_json TEXT NOT NULL
    );
    CREATE TABLE session_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY(session_id, seq)
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      source_session TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO memories (id, content, tags_json, source_session, created_at, updated_at)
    VALUES ('memory-legacy', '旧版长期记忆', '["legacy"]', 'session-old',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = new SessionStore(file, { workspace });
  try {
    const eventColumns = store.db.prepare("PRAGMA table_info(session_events)").all().map((column) => column.name);
    const memoryEventColumns = store.db.prepare("PRAGMA table_info(memory_events)").all().map((column) => column.name);
    const mutationColumns = store.db.prepare("PRAGMA table_info(memory_mutations)").all().map((column) => column.name);
    const migrationVersions = store.db.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all().map((row) => row.version);
    assert.ok(eventColumns.includes("schema_version"));
    assert.ok(memoryEventColumns.includes("schema_version"));
    assert.ok(mutationColumns.includes("request_hash"));
    assert.deepEqual(migrationVersions, [1, 2, 3, 4, 5]);
    assert.ok(store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_checkpoints'",
    ).get());
    const [migratedMemory] = await store.searchMemories("旧版");
    assert.equal(migratedMemory.id, "memory-legacy");
    assert.equal(migratedMemory.scope.workspace, workspace);
    const [migrationEvent] = (await store.verifyMemory(migratedMemory.id)).events;
    assert.equal(migrationEvent.type, "memory.migrated");
    assert.equal(migrationEvent.schemaVersion, 1);
  } finally {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("schema v2 会话状态加载时迁移到当前版本", () => {
  const fixture = createFixture();
  try {
    const state = createSession({ provider: "demo", workspace: fixture.workspace });
    const legacy = { ...state, schemaVersion: 2 };
    delete legacy.lineage;
    fixture.store.save(legacy);

    const restored = fixture.store.load(state.id);
    assert.equal(restored.schemaVersion, 8);
    assert.equal(restored.lineage, null);
    assert.deepEqual(restored.toolGrants, []);
  } finally {
    fixture.close();
  }
});

test("schema v7 的 call-bound Grant 迁移后默认视为已消费", () => {
  const state = createSession({ provider: "demo", workspace: "/tmp" });
  state.schemaVersion = 7;
  state.toolGrants = [{
    id: "grant-legacy-call",
    sessionId: state.id,
    workspace: state.workspace,
    tool: "write_file",
    capabilityHash: "capability",
    policyVersion: "policy",
    resources: [],
    callId: "call-legacy",
    argsHash: "args",
    issuedAt: "2026-08-24T00:00:00.000Z",
    expiresAt: "2026-08-24T00:05:00.000Z",
    revokedAt: null,
  }];

  const migrated = migrateSessionState(state);

  assert.equal(migrated.schemaVersion, 8);
  assert.equal(migrated.toolGrants[0].usage, "single_use");
  assert.equal(migrated.toolGrants[0].consumedAt, "2026-08-24T00:00:00.000Z");
  assert.equal(migrated.toolGrants[0].consumedByCallId, "call-legacy");
});

test("SessionStore 不再从数据库路径猜测 workspace", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-explicit-workspace-test-"));
  try {
    assert.throws(
      () => new SessionStore(path.join(workspace, "nexus.db")),
      /必须显式提供 workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function createFixture() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-session-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  return {
    workspace,
    store,
    close() {
      store.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
