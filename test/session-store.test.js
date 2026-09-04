import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentSession } from "../src/core/session.js";
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

test("会话列表标题使用 durable 安全投影而不是直接暴露首条消息", () => {
  const fixture = createFixture();
  try {
    let state = createSession({ provider: "demo", workspace: fixture.workspace });
    state = reduceSession(state, { type: "USER_MESSAGE", content: "SSH 到 root@192.168.121.110 部署" });
    fixture.store.save(state);
    assert.equal(fixture.store.list(fixture.workspace)[0].title, "受保护任务");

    state = reduceSession(state, { type: "SESSION_DISPLAY_TITLE_CHANGED", title: "服务器地址: prod.internal" });
    fixture.store.save(state);
    assert.equal(fixture.store.list(fixture.workspace)[0].title, "受保护任务");
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

test("重复 callId 的待审批 occurrence 按实际串行顺序恢复", () => {
  const call = { id: "same", name: "write_file", arguments: { path: "a", content: "x" } };
  let state = createSession({ provider: "demo", workspace: "/workspace" });
  state = reduceSession(state, {
    type: "ASSISTANT_MESSAGE",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "same", name: "write_file", arguments: { path: "a" } },
        { id: "same", name: "write_file", arguments: { path: "b" } },
      ],
    },
  });
  state = reduceSession(state, { type: "APPROVAL_REQUESTED", call });

  const resumed = reduceSession(state, { type: "RESUMED", provider: "demo", workspace: "/workspace" });
  const recoveredResults = resumed.messages.slice(-2);
  assert.match(recoveredResults[0].content, /尚未获得审批.*未执行/);
  assert.match(recoveredResults[1].content, /尚未开始执行.*不会自动重放/);
  assert.equal(resumed.events.some((event) => event.type === "tool.execution_unknown"), false);
  const cancelled = resumed.events.find((event) => event.type === "tool.recovery_cancelled");
  assert.equal(cancelled.callOrdinal, 1);
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

test("恢复多工具调用时只有已启动 occurrence 标记 unknown，后续未启动调用明确取消", () => {
  const first = { id: "same", name: "run_shell", arguments: { command: "one" } };
  let state = createSession({ provider: "demo", workspace: "/workspace" });
  state = reduceSession(state, {
    type: "ASSISTANT_MESSAGE",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "same", name: "run_shell", arguments: { command: "one" } },
        { id: "same", name: "run_shell", arguments: { command: "two" } },
      ],
    },
  });
  state = reduceSession(state, { type: "TOOL_REQUESTED", call: first });
  state = reduceSession(state, {
    type: "TOOL_EXECUTION_STARTED",
    call: first,
    argsHash: "one-hash",
    toolVersion: "version",
    effects: ["execute"],
    idempotency: "unknown",
    adapter: "native",
  });

  const resumed = reduceSession(state, { type: "RESUMED", provider: "demo", workspace: "/workspace" });
  const recovered = resumed.messages.slice(-2);
  const unknown = resumed.events.filter((event) => event.type === "tool.execution_unknown");
  const cancelled = resumed.events.filter((event) => event.type === "tool.recovery_cancelled");

  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].callOrdinal, 0);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].callOrdinal, 1);
  assert.match(recovered[0].content, /执行状态未知/);
  assert.match(recovered[1].content, /尚未开始执行.*已取消/);
});

test("恢复不会为已有 execution_unknown 重复写事件，并保留 occurrence 的终止原因", () => {
  for (const terminationReason of ["timeout", "cancelled"]) {
    const first = { id: "same", name: "run_shell", arguments: { command: "one", timeout_ms: 10 } };
    let state = createSession({ provider: "demo", workspace: "/workspace" });
    state = reduceSession(state, {
      type: "ASSISTANT_MESSAGE",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "same", name: "run_shell", arguments: { command: "one", timeout_ms: 10 } },
          { id: "same", name: "run_shell", arguments: { command: "two" } },
        ],
      },
    });
    state = reduceSession(state, { type: "TOOL_REQUESTED", call: first });
    state = reduceSession(state, {
      type: "TOOL_EXECUTION_STARTED",
      call: first,
      argsHash: "one-hash",
      toolVersion: "version",
      effects: ["execute"],
      idempotency: "unknown",
      adapter: "native",
      effectiveTimeoutMs: 10,
      deadlineAt: "2026-09-03T00:00:00.010Z",
    });
    state = reduceSession(state, {
      type: "TOOL_EXECUTION_UNKNOWN",
      call: first,
      argsHash: "one-hash",
      effects: ["execute"],
      idempotency: "unknown",
      adapter: "native",
      reason: terminationReason,
      durationMs: 10,
      effectiveTimeoutMs: 10,
      terminationReason,
    });

    const resumed = reduceSession(state, { type: "RESUMED", provider: "demo", workspace: "/workspace" });
    const unknown = resumed.events.filter((event) => event.type === "tool.execution_unknown");
    const cancelled = resumed.events.filter((event) => event.type === "tool.recovery_cancelled");

    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].reason, terminationReason);
    assert.equal(unknown[0].terminationReason, terminationReason);
    assert.equal(unknown[0].effectiveTimeoutMs, 10);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].callOrdinal, 1);
    assert.match(resumed.messages.at(-2).content, /此前已记录结果未知.*不会自动重放/);
    assert.match(resumed.messages.at(-1).content, /尚未开始执行.*已取消/);
  }
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
    assert.deepEqual(migrationVersions, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(store.db.prepare("PRAGMA table_info(memories)").all().some((column) => column.name === "pinned"));
    assert.ok(store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_checkpoints'",
    ).get());
    assert.ok(store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'",
    ).get());
    assert.deepEqual(
      store.db.prepare("PRAGMA table_info(artifacts)").all()
        .filter((column) => column.pk)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
      ["session_id", "id"],
    );
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
    assert.equal(restored.schemaVersion, 16);
    assert.equal(restored.agentProfile.id, "legacy-default");
    assert.equal(restored.lineage, null);
    assert.deepEqual(restored.toolGrants, []);
    assert.equal(restored.permissionProfile, "workspace-auto");
    assert.equal(restored.objective, null);
    assert.equal(restored.plan, null);
    assert.deepEqual(restored.delegations, []);
    assert.equal(restored.contextSummary, null);
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

  assert.equal(migrated.schemaVersion, 16);
  assert.equal(migrated.agentProfile.id, "legacy-default");
  assert.equal(migrated.toolGrants[0].usage, "single_use");
  assert.equal(migrated.toolGrants[0].consumedAt, "2026-08-24T00:00:00.000Z");
  assert.equal(migrated.toolGrants[0].consumedByCallId, "call-legacy");
});

test("schema v12 升级时保留 Agent Profile 并初始化 durable summary", () => {
  const state = createSession({ provider: "demo", workspace: "/tmp" });
  const profileVersion = state.agentProfile.version;
  state.schemaVersion = 12;
  delete state.contextSummary;

  const migrated = migrateSessionState(state);

  assert.equal(migrated.schemaVersion, 16);
  assert.equal(migrated.agentProfile.version, profileVersion);
  assert.equal(migrated.contextSummary, null);
  assert.equal(migrated.modelStream, null);
  assert.deepEqual(migrated.modelStreamChunks, []);
  assert.deepEqual(migrated.toolStreams, {});
});

test("schema v14 升级时初始化 Tool Output Stream 投影", () => {
  const state = createSession({ provider: "demo", workspace: "/tmp" });
  state.schemaVersion = 14;
  delete state.toolStreams;

  const migrated = migrateSessionState(state);

  assert.equal(migrated.schemaVersion, 16);
  assert.deepEqual(migrated.toolStreams, {});
});

test("schema v15 升级时从首条用户消息建立安全 Display Title", () => {
  let state = createSession({ provider: "demo", workspace: "/tmp" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "访问 https://internal.example.com" });
  state.schemaVersion = 15;
  delete state.displayTitle;

  const migrated = migrateSessionState(state);

  assert.equal(migrated.schemaVersion, 16);
  assert.equal(migrated.displayTitle, "受保护任务");
});

test("当前 schema 的外部 Display Title 仍会在恢复边界重新安全化", () => {
  const state = createSession({ provider: "demo", workspace: "/tmp" });
  state.displayTitle = "SSH root@10.0.0.8";

  const migrated = migrateSessionState(state);

  assert.equal(migrated.displayTitle, "受保护任务");
});

test("Gateway 恢复时保留模型部分输出并标记为 interrupted", () => {
  let state = createSession({ provider: "demo", workspace: "/workspace" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "生成较长回答" });
  state = reduceSession(state, { type: "MODEL_REQUESTED" });
  state = reduceSession(state, { type: "MODEL_STREAM_STARTED" });
  state = reduceSession(state, { type: "MODEL_STREAM_DELTA", delta: "已经生成的部分\n" });

  const resumed = reduceSession(state, { type: "RESUMED", provider: "demo", workspace: "/workspace" });

  assert.equal(resumed.modelStream.status, "interrupted");
  assert.equal(resumed.modelStreamChunks.join(""), "已经生成的部分\n");
  assert.equal(resumed.phase, "idle");
});

test("模型增量通过 SQLite Journal 重放后仍可恢复", async () => {
  const fixture = createFixture();
  try {
    const initial = createSession({ provider: "demo", workspace: fixture.workspace });
    const session = new AgentSession({ state: initial, reducer: reduceSession, journal: fixture.store });
    await session.dispatch({ type: "USER_MESSAGE", content: "生成回答" });
    await session.dispatch({ type: "MODEL_REQUESTED" });
    await session.dispatch({ type: "MODEL_STREAM_STARTED" });
    await session.dispatch({ type: "MODEL_STREAM_DELTA", delta: "第一段\n" });
    await session.dispatch({ type: "MODEL_STREAM_DELTA", delta: "第二段\n" });

    const restored = new AgentSession({
      state: fixture.store.load(session.id),
      reducer: reduceSession,
      journal: fixture.store,
    });

    assert.equal(restored.state.modelStream.status, "streaming");
    assert.deepEqual(restored.state.modelStreamChunks, ["第一段\n", "第二段\n"]);
    const deltas = restored.events().filter((event) => event.type === "MODEL_STREAM_DELTA");
    assert.deepEqual(deltas.map((event) => event.patch.append.modelStreamChunks), [["第一段\n"], ["第二段\n"]]);
  } finally {
    fixture.close();
  }
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
