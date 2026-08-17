import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSession, reduceSession } from "../src/core/state.js";
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
    assert.deepEqual(fixture.store.list(fixture.workspace).map((item) => item.id), [state.id]);
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

test("长期记忆支持保存、搜索和删除", () => {
  const fixture = createFixture();
  try {
    const memory = fixture.store.addMemory("偏好本地模型", { tags: ["preference", "local"] });
    assert.equal(fixture.store.searchMemories("本地")[0].id, memory.id);
    assert.equal(fixture.store.searchMemories("preference")[0].content, "偏好本地模型");
    assert.equal(fixture.store.deleteMemory(memory.id), true);
    assert.deepEqual(fixture.store.searchMemories("本地"), []);
  } finally {
    fixture.close();
  }
});

test("旧数据库会按顺序执行显式 schema migration", () => {
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
  `);
  legacy.close();

  const store = new SessionStore(file);
  try {
    const eventColumns = store.db.prepare("PRAGMA table_info(session_events)").all().map((column) => column.name);
    const migrationVersions = store.db.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all().map((row) => row.version);
    assert.ok(eventColumns.includes("schema_version"));
    assert.deepEqual(migrationVersions, [1, 2]);
    assert.ok(store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_checkpoints'",
    ).get());
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
    assert.equal(restored.schemaVersion, 3);
    assert.equal(restored.lineage, null);
  } finally {
    fixture.close();
  }
});

function createFixture() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-session-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"));
  return {
    workspace,
    store,
    close() {
      store.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
