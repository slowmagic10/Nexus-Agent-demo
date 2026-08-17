import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { applyStatePatch } from "../src/state-patch.js";

test("会话可从事件日志重放，快照不是事实来源", async () => {
  const fixture = createFixture();
  try {
    const session = new AgentSession({
      state: createSession({ provider: "demo", workspace: fixture.workspace }),
      reducer: reduceSession,
      journal: fixture.store,
    });

    await session.dispatch({ type: "USER_MESSAGE", content: "记住我的偏好", at: "2026-08-17T01:00:00.000Z" });
    await session.dispatch({ type: "MEMORY_ADDED", content: "偏好本地模型", at: "2026-08-17T01:00:01.000Z" });
    const expected = structuredClone(session.state);

    fixture.store.save({ ...expected, messages: [], memory: [], events: [] });

    assert.deepEqual(fixture.store.load(session.id), expected);
    assert.deepEqual(
      fixture.store.listSessionEvents(session.id).map((event) => event.type),
      ["SESSION_BASELINE", "USER_MESSAGE", "MEMORY_ADDED"],
    );
  } finally {
    fixture.close();
  }
});

test("订阅者只会看到已经持久化的状态", async () => {
  const fixture = createFixture();
  try {
    const observed = [];
    const session = new AgentSession({
      state: createSession({ provider: "demo", workspace: fixture.workspace }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    session.subscribe((state) => {
      observed.push(state);
      assert.deepEqual(fixture.store.load(state.id), state);
    });

    await session.dispatch({ type: "USER_MESSAGE", content: "持久化后通知", at: "2026-08-17T01:00:00.000Z" });

    assert.equal(observed.length, 1);
    assert.equal(observed[0].messages.at(-1).content, "持久化后通知");
  } finally {
    fixture.close();
  }
});

test("持久化失败时不推进内存状态，也不通知订阅者", async () => {
  const initial = createSession({
    provider: "demo",
    workspace: "/tmp",
    id: "session-atomicity",
    createdAt: "2026-08-17T01:00:00.000Z",
  });
  const session = new AgentSession({
    state: initial,
    reducer: reduceSession,
    journal: {
      ensureJournal: (state) => structuredClone(state),
      commitSessionEvent: () => { throw new Error("磁盘写入失败"); },
    },
  });
  let notifications = 0;
  session.subscribe(() => { notifications += 1; });

  await assert.rejects(
    session.dispatch({ type: "USER_MESSAGE", content: "不能泄漏", at: "2026-08-17T01:00:01.000Z" }),
    /磁盘写入失败/,
  );

  assert.deepEqual(session.state, initial);
  assert.equal(notifications, 0);
});

test("事件游标支持增量读取、断点订阅和客户端投影", async () => {
  const fixture = createFixture();
  try {
    const session = new AgentSession({
      state: createSession({
        provider: "demo",
        workspace: fixture.workspace,
        id: "session-cursor",
        createdAt: "2026-08-17T01:00:00.000Z",
      }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    await session.dispatch({ type: "USER_MESSAGE", content: "第一条", at: "2026-08-17T01:00:01.000Z" });
    await session.dispatch({ type: "MEMORY_ADDED", content: "偏好增量事件", at: "2026-08-17T01:00:02.000Z" });

    assert.equal(session.cursor, 3);
    assert.deepEqual(
      session.events({ after: 1 }).map(({ cursor, type }) => ({ cursor, type })),
      [
        { cursor: 2, type: "USER_MESSAGE" },
        { cursor: 3, type: "MEMORY_ADDED" },
      ],
    );

    const received = [];
    const unsubscribe = session.subscribeEvents((event) => received.push(event), { after: 2 });
    await session.dispatch({ type: "READY", at: "2026-08-17T01:00:03.000Z" });
    const stateAtCursor4 = structuredClone(session.state);
    unsubscribe();
    await session.dispatch({ type: "MEMORY_ADDED", content: "不应收到", at: "2026-08-17T01:00:04.000Z" });
    assert.deepEqual(received.map((event) => event.cursor), [3, 4]);

    const durableEvents = session.events({ after: 0 });
    let projected = durableEvents[0].baseline;
    for (const event of durableEvents.slice(1, 4)) projected = applyStatePatch(projected, event.patch);
    assert.deepEqual(projected, stateAtCursor4);
  } finally {
    fixture.close();
  }
});

test("模型请求只暴露 durable context，并与展示状态隔离", async () => {
  const fixture = createFixture();
  try {
    const session = new AgentSession({
      state: createSession({
        provider: "demo",
        workspace: fixture.workspace,
        id: "session-model-context",
        createdAt: "2026-08-17T01:00:00.000Z",
      }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    await session.dispatch({ type: "USER_MESSAGE", content: "真实消息", at: "2026-08-17T01:00:01.000Z" });
    await session.dispatch({ type: "MEMORY_ADDED", content: "短期记忆", at: "2026-08-17T01:00:02.000Z" });
    await session.dispatch({
      type: "MEMORY_CONTEXT_SET",
      query: "真实消息",
      memories: [{ id: "memory-1", content: "长期记忆" }],
      at: "2026-08-17T01:00:03.000Z",
    });
    await session.dispatch({
      type: "SKILL_LOADED",
      skill: { name: "review", content: "检查事实" },
      at: "2026-08-17T01:00:04.000Z",
    });

    const leakedState = session.state;
    leakedState.messages.push({ role: "user", content: "未持久化污染" });
    leakedState.metrics.totalTokens = 999999;
    let promptContext;
    const request = session.prepareModelRequest({
      systemPrompt: (context) => {
        promptContext = context;
        return `记忆 ${context.memory.length}，技能 ${context.loadedSkills.length}`;
      },
      tools: [{ type: "function", function: { name: "read_file" } }],
    });

    assert.deepEqual(Object.keys(promptContext).sort(), ["contextMemory", "loadedSkills", "memory", "messages"]);
    assert.deepEqual(request.messages.map((message) => message.content), ["真实消息"]);
    assert.equal(request.systemPrompt, "记忆 1，技能 1");
    assert.equal(request.tools[0].function.name, "read_file");
    assert.equal("metrics" in promptContext, false);
    assert.equal("events" in promptContext, false);

    request.messages.push({ role: "user", content: "Provider 污染" });
    assert.deepEqual(session.state.messages.map((message) => message.content), ["真实消息"]);

    const restored = new AgentSession({
      state: { ...session.state, messages: [], memory: [], contextMemory: [], loadedSkills: [] },
      reducer: reduceSession,
      journal: fixture.store,
    });
    const restoredRequest = restored.prepareModelRequest({ systemPrompt: () => "恢复", tools: [] });
    assert.deepEqual(restoredRequest.messages.map((message) => message.content), ["真实消息"]);
    assert.equal(restoredRequest.systemPrompt, "恢复");
  } finally {
    fixture.close();
  }
});

test("恢复从最新 checkpoint 开始，只重放之后的 durable event", async () => {
  const fixture = createFixture({ checkpointInterval: 3 });
  try {
    const session = new AgentSession({
      state: createSession({
        provider: "demo",
        workspace: fixture.workspace,
        id: "session-checkpoint",
        createdAt: "2026-08-17T01:00:00.000Z",
      }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    await session.dispatch({ type: "USER_MESSAGE", content: "第一条", at: "2026-08-17T01:00:01.000Z" });
    await session.dispatch({ type: "MEMORY_ADDED", content: "checkpoint 内", at: "2026-08-17T01:00:02.000Z" });
    await session.dispatch({ type: "MEMORY_ADDED", content: "checkpoint 后", at: "2026-08-17T01:00:03.000Z" });
    const expected = session.state;
    assert.deepEqual(
      fixture.store.readProjectionEvents(session.id).map(({ cursor, type }) => ({ cursor, type })),
      [
        { cursor: 3, type: "SESSION_CHECKPOINT" },
        { cursor: 4, type: "MEMORY_ADDED" },
      ],
    );

    fixture.store.save({ ...expected, messages: [], memory: [], events: [] });
    fixture.store.db.prepare(
      "UPDATE session_events SET event_json = ? WHERE session_id = ? AND seq = 1",
    ).run("{损坏的旧基线", session.id);

    assert.deepEqual(fixture.store.load(session.id), expected);
    const restored = new AgentSession({ state: expected, reducer: reduceSession, journal: fixture.store });
    assert.deepEqual(
      restored.prepareModelRequest({ systemPrompt: () => "恢复", tools: [] }).messages,
      [{ role: "user", content: "第一条" }],
    );
  } finally {
    fixture.close();
  }
});

test("checkpoint 损坏时自动退回完整 journal 重放", async () => {
  const fixture = createFixture({ checkpointInterval: 3 });
  try {
    const session = new AgentSession({
      state: createSession({ provider: "demo", workspace: fixture.workspace }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    await session.dispatch({ type: "USER_MESSAGE", content: "完整重放", at: "2026-08-17T01:00:01.000Z" });
    await session.dispatch({ type: "MEMORY_ADDED", content: "校验 checkpoint", at: "2026-08-17T01:00:02.000Z" });
    const expected = session.state;

    fixture.store.db.prepare(
      "UPDATE session_checkpoints SET checksum = ? WHERE session_id = ?",
    ).run("invalid-checksum", session.id);

    assert.deepEqual(fixture.store.load(session.id), expected);
  } finally {
    fixture.close();
  }
});

test("portable journal export 包含连续事实但不包含派生 checkpoint", async () => {
  const fixture = createFixture({ checkpointInterval: 3 });
  try {
    const session = new AgentSession({
      state: createSession({
        provider: "demo",
        workspace: fixture.workspace,
        id: "session-export",
        createdAt: "2026-08-17T01:00:00.000Z",
      }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    await session.dispatch({ type: "USER_MESSAGE", content: "导出事实", at: "2026-08-17T01:00:01.000Z" });
    await session.dispatch({ type: "MEMORY_ADDED", content: "触发 checkpoint", at: "2026-08-17T01:00:02.000Z" });

    const first = fixture.store.exportJournal(session.id, { exportedAt: "2026-08-17T02:00:00.000Z" });
    const second = fixture.store.exportJournal(session.id, { exportedAt: "2026-08-17T03:00:00.000Z" });

    assert.equal(first.format, "nexus.session-journal");
    assert.equal(first.formatVersion, 1);
    assert.equal(first.session.cursor, 3);
    assert.deepEqual(first.events.map((event) => event.cursor), [1, 2, 3]);
    assert.equal("checkpoints" in first, false);
    assert.match(first.checksum, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.checksum, second.checksum);
  } finally {
    fixture.close();
  }
});

test("portable journal 可重定位 workspace、重映射 ID 并完整重放", async () => {
  const source = createFixture();
  const destination = createFixture();
  try {
    const session = new AgentSession({
      state: createSession({
        provider: "demo",
        workspace: source.workspace,
        id: "session-import-source",
        createdAt: "2026-08-17T01:00:00.000Z",
      }),
      reducer: reduceSession,
      journal: source.store,
    });
    await session.dispatch({ type: "USER_MESSAGE", content: "迁移这段对话", at: "2026-08-17T01:00:01.000Z" });
    await session.dispatch({ type: "MEMORY_ADDED", content: "portable import", at: "2026-08-17T01:00:02.000Z" });
    const archive = source.store.exportJournal(session.id, { exportedAt: "2026-08-17T02:00:00.000Z" });
    const reorderedArchive = {
      events: archive.events,
      session: {
        cursor: archive.session.cursor,
        workspace: archive.session.workspace,
        id: archive.session.id,
        lineage: archive.session.lineage,
        provider: archive.session.provider,
        updatedAt: archive.session.updatedAt,
        stateSchemaVersion: archive.session.stateSchemaVersion,
        createdAt: archive.session.createdAt,
      },
      formatVersion: archive.formatVersion,
      format: archive.format,
      checksum: archive.checksum,
      exportedAt: archive.exportedAt,
    };

    const imported = destination.store.importJournal(reorderedArchive, {
      id: "session-imported",
      workspace: destination.workspace,
    });

    assert.equal(imported.id, "session-imported");
    assert.equal(imported.workspace, destination.workspace);
    assert.deepEqual(imported.messages, session.state.messages);
    assert.deepEqual(imported.memory, session.state.memory);
    assert.deepEqual(destination.store.load(imported.id), imported);
    assert.deepEqual(
      destination.store.readSessionEvents(imported.id).map(({ cursor, sessionId }) => ({ cursor, sessionId })),
      [1, 2, 3].map((cursor) => ({ cursor, sessionId: imported.id })),
    );
    assert.equal(archive.events[0].baseline.id, "session-import-source");
    assert.equal(archive.events[0].baseline.workspace, source.workspace);
    assert.match(destination.store.exportJournal(imported.id).checksum, /^sha256:[a-f0-9]{64}$/);

    const legacyCore = {
      format: archive.format,
      formatVersion: archive.formatVersion,
      session: archive.session,
      events: archive.events,
    };
    const legacyArchive = {
      ...archive,
      checksum: `sha256:${createHash("sha256").update(JSON.stringify(legacyCore)).digest("hex")}`,
    };
    assert.equal(destination.store.importJournal(legacyArchive, {
      id: "session-imported-legacy-checksum",
      workspace: destination.workspace,
    }).id, "session-imported-legacy-checksum");
  } finally {
    source.close();
    destination.close();
  }
});

test("portable journal 校验失败时不会留下半导入会话", async () => {
  const source = createFixture();
  const destination = createFixture();
  try {
    const session = new AgentSession({
      state: createSession({ provider: "demo", workspace: source.workspace, id: "session-tampered" }),
      reducer: reduceSession,
      journal: source.store,
    });
    await session.dispatch({ type: "USER_MESSAGE", content: "原始事实", at: "2026-08-17T01:00:01.000Z" });
    const archive = source.store.exportJournal(session.id);
    archive.events[1].action.content = "篡改事实";

    assert.throws(
      () => destination.store.importJournal(archive, { id: "session-rejected", workspace: destination.workspace }),
      /checksum/,
    );
    assert.equal(destination.store.load("session-rejected"), null);
    assert.equal(destination.store.latestSessionCursor("session-rejected"), 0);
  } finally {
    source.close();
    destination.close();
  }
});

test("portable journal ID 冲突时保持已有会话与事件不变", async () => {
  const source = createFixture();
  const destination = createFixture();
  try {
    const session = new AgentSession({
      state: createSession({ provider: "demo", workspace: source.workspace, id: "session-collision-source" }),
      reducer: reduceSession,
      journal: source.store,
    });
    await session.dispatch({ type: "USER_MESSAGE", content: "只导入一次", at: "2026-08-17T01:00:01.000Z" });
    const archive = source.store.exportJournal(session.id);
    const first = destination.store.importJournal(archive, {
      id: "session-collision",
      workspace: destination.workspace,
    });
    const events = destination.store.readSessionEvents(first.id);

    assert.throws(
      () => destination.store.importJournal(archive, { id: first.id, workspace: destination.workspace }),
      /会话已存在/,
    );
    assert.deepEqual(destination.store.load(first.id), first);
    assert.deepEqual(destination.store.readSessionEvents(first.id), events);
  } finally {
    source.close();
    destination.close();
  }
});

test("Session Branch 从指定 cursor 建立独立 lineage 并闭合未决工具", async () => {
  const fixture = createFixture();
  try {
    const source = new AgentSession({
      state: createSession({
        provider: "demo",
        workspace: fixture.workspace,
        id: "session-parent",
        createdAt: "2026-08-17T01:00:00.000Z",
      }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    await source.dispatch({ type: "USER_MESSAGE", content: "创建分支", at: "2026-08-17T01:00:01.000Z" });
    const call = { id: "call-branch", name: "write_file", arguments: { path: "x", content: "y" } };
    await source.dispatch({
      type: "ASSISTANT_MESSAGE",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: "{}" } }],
      },
      at: "2026-08-17T01:00:02.000Z",
    });
    await source.dispatch({ type: "APPROVAL_REQUESTED", call, at: "2026-08-17T01:00:03.000Z" });
    await source.dispatch({ type: "MEMORY_ADDED", content: "父会话后续", at: "2026-08-17T01:00:04.000Z" });

    const branch = fixture.store.branchSession(source.id, {
      cursor: 4,
      id: "session-child",
      provider: "demo",
      workspace: fixture.workspace,
      branchedAt: "2026-08-17T02:00:00.000Z",
    });

    assert.equal(branch.id, "session-child");
    assert.equal(branch.phase, "idle");
    assert.equal(branch.pendingApproval, null);
    assert.deepEqual(branch.lineage, {
      parentSessionId: source.id,
      parentCursor: 4,
      branchedAt: "2026-08-17T02:00:00.000Z",
    });
    assert.match(branch.messages.at(-1).content, /尚未获得审批/);
    assert.deepEqual(branch.memory, []);
    assert.equal(branch.events[0].type, "session.branched");
    assert.deepEqual(fixture.store.listSessionEvents(branch.id).map((event) => event.type), ["SESSION_BASELINE"]);
    assert.deepEqual(fixture.store.load(branch.id), branch);
    assert.equal(source.state.pendingApproval.name, "write_file");
    assert.deepEqual(source.state.memory.map((item) => item.content), ["父会话后续"]);
  } finally {
    fixture.close();
  }
});

function createFixture(options) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-agent-session-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), options);
  return {
    workspace,
    store,
    close() {
      store.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
