import assert from "node:assert/strict";
import test from "node:test";
import { createTaskThread, TASK_THREAD_VERSION } from "../src/web/task-thread.js";

test("无 Session 首屏 welcome 由 Task Thread 接管并可触发 starter", async () => {
  const fixture = createFixture();
  const starters = [];
  const thread = createTaskThread({
    root: fixture.root,
    requestApproval: async () => {},
    loadArtifact: async () => ({}),
    openReview: () => {},
    useStarter: async (request) => { starters.push(request); },
    scheduleFrame: fixture.frames.schedule,
    cancelFrame: fixture.frames.cancel,
  });

  assert.deepEqual(thread.snapshot().renderedTurnKeys, ["welcome"]);
  const button = findOne(fixture.root, "starters").children[0];
  button.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(starters.length, 1);
  assert.equal(starters[0].sessionId, null);
  assert.match(starters[0].prompt, /分析这个项目/);
  thread.destroy();
});

test("100 次 active SSE 更新不重建已完成 Turn，也不夺走其中焦点", () => {
  const fixture = createFixture();
  const thread = createThread(fixture);
  let session = twoTurnStreamingSession();
  thread.update({ session, cursor: 1 });
  fixture.frames.flush();
  const completedTurn = fixture.root.children[0];
  const completedSummary = findAll(completedTurn, "turn-activity")[0].children[0];
  completedSummary.focus();

  for (let index = 0; index < 100; index += 1) {
    session = { ...session, modelStreamChunks: [`增量 ${index}`] };
    thread.update({ session, cursor: index + 2 });
    assert.equal(fixture.root.children[0], completedTurn);
    assert.equal(fixture.document.activeElement, completedSummary);
  }
  assert.equal(thread.snapshot().version, TASK_THREAD_VERSION);
  assert.equal(thread.snapshot().turnCount, 2);
  thread.destroy();
});

test("active Turn 重建时保留 Execution Summary 与 Tool disclosure 展开态", () => {
  const fixture = createFixture();
  const thread = createThread(fixture);
  const session = runningToolSession({ preview: "first" });
  thread.update({ session });
  const activity = findOne(fixture.root, "turn-activity");
  const tool = findOne(fixture.root, "tool-card");
  activity.open = false;
  activity.dispatchEvent(new Event("toggle"));
  tool.open = false;
  tool.dispatchEvent(new Event("toggle"));

  thread.update({ session: runningToolSession({ preview: "second" }) });
  assert.equal(findOne(fixture.root, "turn-activity").open, false);
  assert.equal(findOne(fixture.root, "tool-card").open, false);
  thread.destroy();
});

test("仅在接近底部或新增 User Turn 时 follow tail，用户上滚后不抢回", () => {
  const fixture = createFixture();
  fixture.root.clientHeight = 200;
  fixture.root.scrollHeight = 1000;
  fixture.root.scrollTop = 800;
  const thread = createThread(fixture);
  thread.update({ session: twoTurnStreamingSession() });
  fixture.root.scrollHeight = 1200;
  fixture.frames.flush();
  assert.equal(fixture.root.scrollTop, 1200);

  fixture.root.scrollHeight = 1400;
  fixture.root.scrollTop = 100;
  fixture.root.dispatchEvent(new Event("scroll"));
  thread.update({ session: { ...twoTurnStreamingSession(), modelStreamChunks: ["far update"] } });
  fixture.frames.flush();
  assert.equal(fixture.root.scrollTop, 100);

  const withNewTurn = completedSession("follow", "第三轮");
  withNewTurn.messages = [...twoTurnStreamingSession().messages, { role: "user", content: "新增任务" }];
  withNewTurn.events = [
    ...twoTurnStreamingSession().events,
    { seq: 20, type: "session.turn_completed", durationMs: 8 },
    { seq: 21, type: "message.user" },
  ];
  withNewTurn.phase = "thinking";
  fixture.root.scrollHeight = 1600;
  thread.update({ session: withNewTurn });
  fixture.frames.flush();
  assert.equal(fixture.root.scrollTop, 1600);
  thread.destroy();
});

test("用户在已排队 follow tail 前上滚会取消该次自动滚动", () => {
  const fixture = createFixture();
  fixture.root.clientHeight = 200;
  fixture.root.scrollHeight = 1000;
  fixture.root.scrollTop = 800;
  const thread = createThread(fixture);
  thread.update({ session: twoTurnStreamingSession() });
  fixture.root.scrollTop = 120;
  fixture.root.dispatchEvent(new Event("scroll"));
  fixture.frames.flush();
  assert.equal(fixture.root.scrollTop, 120);
  thread.destroy();
});

test("Session 切换取消旧 RAF、Artifact 和 Approval 身份", async () => {
  const fixture = createFixture();
  const approvalCalls = [];
  const artifactCalls = [];
  const thread = createTaskThread({
    root: fixture.root,
    requestApproval: (request) => { approvalCalls.push(request); },
    loadArtifact: (request) => { artifactCalls.push(request); return never(); },
    openReview: () => {},
    useStarter: () => {},
    scheduleFrame: fixture.frames.schedule,
    cancelFrame: fixture.frames.cancel,
  });

  thread.update({ session: approvalAndArtifactSession("old") });
  const oldApproval = findOne(fixture.root, "approve-button");
  const oldArtifact = findOne(fixture.root, "artifact-button");
  oldApproval.dispatchEvent(new Event("click"));
  oldArtifact.dispatchEvent(new Event("click"));
  thread.update({ session: emptySession("new") });
  await settle();
  fixture.frames.flush({ includeCancelled: true });

  assert.equal(approvalCalls.length, 0);
  assert.equal(artifactCalls.length, 0);
  oldApproval.dispatchEvent(new Event("click"));
  oldArtifact.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(approvalCalls.length, 0);
  assert.equal(artifactCalls.length, 0);
  assert.equal(thread.snapshot().sessionId, "new");
  assert.deepEqual(thread.snapshot().artifactKeys, []);
  thread.destroy();
});

test("streamed partial 被 durable final 替换且不重复显示", () => {
  const fixture = createFixture();
  const thread = createThread(fixture);
  const session = emptySession("stream-final");
  session.phase = "thinking";
  session.messages = [{ role: "user", content: "回答" }];
  session.events = [{ seq: 1, type: "message.user" }, { seq: 2, type: "model.requested" }];
  session.modelStream = { status: "streaming" };
  session.modelStreamChunks = ["最终答案"];
  thread.update({ session });
  assert.equal(findAll(fixture.root, "model-stream").length, 1);

  session.phase = "completed";
  session.messages.push({ role: "assistant", content: "最终答案" });
  session.events.push(
    { seq: 3, type: "model.completed", durationMs: 3 },
    { seq: 4, type: "session.turn_completed", durationMs: 4 },
  );
  session.modelStream = { status: "completed" };
  thread.update({ session });
  assert.equal(findAll(fixture.root, "model-stream").length, 0);
  assert.equal(countText(fixture.root, "最终答案"), 1);
  thread.destroy();
});

test("重复 callId 仍按 runKey 渲染独立 Tool Card", () => {
  const fixture = createFixture();
  const thread = createThread(fixture);
  thread.update({ session: repeatedCallSession() });
  const cards = findAll(fixture.root, "tool-card");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].getAttribute("data-call-id"), "same");
  assert.equal(cards[1].getAttribute("data-call-id"), "same");
  assert.notEqual(cards[0].getAttribute("data-run-key"), cards[1].getAttribute("data-run-key"));
  thread.destroy();
});

test("运行中的 Tool Card 显示实际期限并为旧 Journal 保留兼容文案", () => {
  const cases = [
    { timeout: null, expected: "运行中 · 不限时" },
    { timeout: 90_000, expected: "运行中 · 最长 1m 30s" },
    { timeout: undefined, expected: "运行中" },
  ];
  for (const [index, example] of cases.entries()) {
    const fixture = createFixture();
    const thread = createThread(fixture);
    const session = runningToolSession({ preview: "" });
    session.id = `deadline-${index}`;
    if (example.timeout !== undefined) session.events[2].effectiveTimeoutMs = example.timeout;
    thread.update({ session });
    assert.equal(findOne(fixture.root, "tool-status").textContent, example.expected);
    thread.destroy();
  }
});

test("Tool Card 依据 durable terminationReason 区分超时、用户取消和普通失败", () => {
  const fixture = createFixture();
  const thread = createThread(fixture);
  thread.update({ session: terminatedToolsSession() });
  assert.deepEqual(findAll(fixture.root, "tool-status").map((node) => node.textContent), [
    "已超时 · 1.5s",
    "用户取消 · 1.5s",
    "执行失败 · 1.5s",
    "失败 · 1.5s",
  ]);
  thread.destroy();
});

test("结果未知优先保留不确定性，同时说明由超时或取消触发", () => {
  const fixture = createFixture();
  const thread = createThread(fixture);
  const session = terminatedToolsSession();
  session.id = "unknown-terminations";
  session.events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "timeout", tool: "run_shell" },
    { seq: 3, type: "tool.execution_started", callId: "timeout", tool: "run_shell", effectiveTimeoutMs: 1_500 },
    { seq: 4, type: "tool.execution_unknown", callId: "timeout", tool: "run_shell", reason: "timeout", terminationReason: "timeout", durationMs: 1_500 },
    { seq: 5, type: "tool.completed", callId: "timeout", tool: "run_shell", ok: false, status: "execution_unknown", terminationReason: "timeout", durationMs: 1_500 },
    { seq: 6, type: "tool.requested", callId: "cancelled", tool: "run_shell" },
    { seq: 7, type: "tool.execution_started", callId: "cancelled", tool: "run_shell", effectiveTimeoutMs: null },
    { seq: 8, type: "tool.execution_unknown", callId: "cancelled", tool: "run_shell", reason: "cancelled", terminationReason: "cancelled", durationMs: 900 },
    { seq: 9, type: "tool.completed", callId: "cancelled", tool: "run_shell", ok: false, status: "execution_unknown", terminationReason: "cancelled", durationMs: 900 },
    { seq: 10, type: "session.cancelled", reason: "用户取消", durationMs: 2_400 },
  ];
  session.messages = [
    { role: "user", content: "运行" },
    { role: "assistant", tool_calls: [
      { id: "timeout", name: "run_shell", arguments: { command: "timeout" } },
      { id: "cancelled", name: "run_shell", arguments: { command: "cancelled" } },
    ] },
    { role: "tool", tool_call_id: "timeout", content: "状态未知" },
    { role: "tool", tool_call_id: "cancelled", content: "状态未知" },
  ];
  thread.update({ session });
  assert.deepEqual(findAll(fixture.root, "tool-status").map((node) => node.textContent), [
    "结果未知 · 超时后 · 1.5s",
    "结果未知 · 用户取消后 · 900ms",
  ]);
  thread.destroy();
});

test("Approval 提交后在 SSE 更新重建中保持禁用，失败后才恢复", async () => {
  const fixture = createFixture();
  let rejectApproval;
  const calls = [];
  const thread = createTaskThread({
    root: fixture.root,
    requestApproval: (request) => {
      calls.push(request);
      return new Promise((_resolve, reject) => { rejectApproval = reject; });
    },
    loadArtifact: async () => null,
    openReview: () => {},
    useStarter: () => {},
    scheduleFrame: fixture.frames.schedule,
    cancelFrame: fixture.frames.cancel,
  });
  const session = pendingApprovalSession("approval");
  thread.update({ session });
  const oldApprovalButton = findOne(fixture.root, "approve-button");
  oldApprovalButton.dispatchEvent(new Event("click"));
  await settle(1);
  assert.equal(calls.length, 1);

  thread.update({ session: { ...session, modelStreamChunks: ["状态更新"] } });
  assert.notEqual(findOne(fixture.root, "approve-button"), oldApprovalButton);
  assert.equal(findAll(fixture.root, "approve-button").every((button) => button.disabled), true);
  assert.equal(findOne(fixture.root, "deny-button").disabled, true);

  rejectApproval(new Error("network"));
  await settle();
  assert.equal(findAll(fixture.root, "approve-button").every((button) => !button.disabled), true);
  assert.equal(findOne(fixture.root, "deny-button").disabled, false);
  thread.destroy();
});

test("Artifact 加载期间 active Turn 重建后会更新当前可见节点", async () => {
  const fixture = createFixture();
  let resolveArtifact;
  const calls = [];
  const thread = createTaskThread({
    root: fixture.root,
    requestApproval: async () => {},
    loadArtifact: (request) => {
      calls.push(request);
      return new Promise((resolve) => { resolveArtifact = resolve; });
    },
    openReview: () => {},
    useStarter: () => {},
    scheduleFrame: fixture.frames.schedule,
    cancelFrame: fixture.frames.cancel,
  });
  const session = approvalAndArtifactSession("artifact-rebuild");
  thread.update({ session });
  const oldButton = findAll(fixture.root, "artifact-button")
    .find((button) => button.textContent === "加载完整输出");
  oldButton.dispatchEvent(new Event("click"));
  await settle(1);
  assert.equal(calls.length, 1);

  thread.update({ session: { ...session, modelStreamChunks: ["状态更新"] } });
  const currentButton = findAll(fixture.root, "artifact-button")
    .find((button) => button.textContent === "加载中…");
  assert.ok(currentButton);
  assert.notEqual(currentButton, oldButton);
  assert.equal(currentButton.disabled, true);

  const content = "完整结果";
  resolveArtifact({
    artifact: {
      id: "artifact-full",
      sessionId: "artifact-rebuild",
      content,
      byteSize: new TextEncoder().encode(content).byteLength,
    },
  });
  await settle();
  assert.match(currentButton.textContent, /已加载完整输出/);
  assert.equal(countText(fixture.root, content), 1);
  thread.destroy();
});

test("历史 Turn 保留失败、取消、恢复与未知结果，并将继承记录显示为中性", () => {
  const fixture = createFixture();
  const thread = createThread(fixture);
  const session = outcomeSession();
  thread.update({ session });
  const outcomes = findAll(fixture.root, "turn-outcome");
  assert.equal(outcomes.length, 2);
  assert.match(outcomes[0].textContent, /之前失败/);
  assert.match(outcomes[1].textContent, /不会自动重试/);

  const inherited = findAll(fixture.root, "tool-status").find((node) => node.textContent === "继承记录");
  assert.ok(inherited);
  thread.update({ session: {
    ...session,
    phase: "thinking",
    messages: [...session.messages, { role: "user", content: "继续" }],
    events: [...session.events, { seq: 9, type: "message.user" }],
  } });
  assert.match(findAll(fixture.root, "turn-outcome")[0].textContent, /之前失败/);
  thread.destroy();
});

test("Artifact 与 Review 回调携带创建节点时捕获的 sessionId", async () => {
  const fixture = createFixture();
  const loads = [];
  const reviews = [];
  const thread = createTaskThread({
    root: fixture.root,
    requestApproval: async () => {},
    loadArtifact: async (request) => {
      loads.push(request);
      return { artifact: { id: request.artifactId, sessionId: request.sessionId, content: "完整", byteSize: 6 } };
    },
    openReview: (request) => reviews.push(request),
    useStarter: () => {},
    scheduleFrame: fixture.frames.schedule,
    cancelFrame: fixture.frames.cancel,
  });
  thread.update({ session: approvalAndArtifactSession("captured") });
  const artifactButton = findAll(fixture.root, "artifact-button")[0];
  artifactButton.dispatchEvent(new Event("click"));
  findOne(fixture.root, "file-change-panel").children.at(-1).dispatchEvent(new Event("click"));
  await settle();
  assert.equal(loads[0].sessionId, "captured");
  assert.equal(loads[0].artifactId, "artifact-full");
  assert.equal(loads[0].signal instanceof AbortSignal, true);
  assert.equal(reviews[0].sessionId, "captured");
  assert.equal(reviews[0].turnKey, "turn:1");
  thread.destroy();
});

function createThread(fixture) {
  return createTaskThread({
    root: fixture.root,
    requestApproval: async () => {},
    loadArtifact: async ({ sessionId, artifactId }) => ({
      artifact: { sessionId, id: artifactId, content: "full", byteSize: 4 },
    }),
    openReview: () => {},
    useStarter: () => {},
    scheduleFrame: fixture.frames.schedule,
    cancelFrame: fixture.frames.cancel,
  });
}

function emptySession(id) {
  return { id, phase: "idle", messages: [], events: [], pendingApproval: null };
}

function completedSession(id, content = "完成") {
  return {
    id,
    phase: "completed",
    messages: [{ role: "user", content: "任务" }, { role: "assistant", content }],
    events: [
      { seq: 1, type: "message.user" },
      { seq: 2, type: "model.requested" },
      { seq: 3, type: "model.completed", durationMs: 2 },
      { seq: 4, type: "session.turn_completed", durationMs: 3 },
    ],
  };
}

function twoTurnStreamingSession() {
  return {
    id: "streaming",
    phase: "thinking",
    messages: [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "先读取", tool_calls: [{ id: "read", name: "read_file", arguments: { path: "a" } }] },
      { role: "tool", tool_call_id: "read", content: "a" },
      { role: "assistant", content: "第一轮完成" },
      { role: "user", content: "第二轮" },
    ],
    events: [
      { seq: 1, type: "message.user" },
      { seq: 2, type: "tool.requested", callId: "read", tool: "read_file" },
      { seq: 3, type: "tool.execution_started", callId: "read", tool: "read_file" },
      { seq: 4, type: "tool.completed", callId: "read", tool: "read_file", ok: true, status: "completed" },
      { seq: 5, type: "session.turn_completed", durationMs: 7 },
      { seq: 6, type: "message.user" },
      { seq: 7, type: "model.requested" },
    ],
    modelStream: { status: "streaming" },
    modelStreamChunks: ["增量"],
  };
}

function runningToolSession({ preview }) {
  return {
    id: "tool-stream",
    phase: "executing",
    messages: [
      { role: "user", content: "运行" },
      { role: "assistant", content: "执行", tool_calls: [{ id: "run", name: "run_shell", arguments: { command: "sleep" } }] },
    ],
    events: [
      { seq: 1, type: "message.user" },
      { seq: 2, type: "tool.requested", callId: "run", tool: "run_shell" },
      { seq: 3, type: "tool.execution_started", callId: "run", tool: "run_shell" },
    ],
    toolStreams: { run: { preview, capturedChars: preview.length } },
  };
}

function pendingApprovalSession(id) {
  const pendingApproval = {
    id: "approval-call",
    name: "run_shell",
    arguments: { command: "rm file" },
    reason: "需要确认",
    approvalScopes: ["once", "session"],
  };
  return {
    id,
    phase: "awaiting_approval",
    messages: [
      { role: "user", content: "删除" },
      { role: "assistant", tool_calls: [{ id: "approval-call", name: "run_shell", arguments: { command: "rm file" } }] },
    ],
    events: [
      { seq: 1, type: "message.user" },
      { seq: 2, type: "tool.requested", callId: "approval-call", tool: "run_shell" },
      { seq: 3, type: "approval.requested", callId: "approval-call", tool: "run_shell" },
    ],
    pendingApproval,
  };
}

function approvalAndArtifactSession(id) {
  const session = pendingApprovalSession(id);
  session.messages = [
    { role: "user", content: "运行" },
    { role: "assistant", tool_calls: [
      { id: "artifact", name: "run_shell", arguments: { command: "seq" } },
      { id: "approval-call", name: "write_file", arguments: { path: "a" } },
    ] },
    { role: "tool", tool_call_id: "artifact", content: "预览\n完整输出已保存为 Artifact：artifact-full" },
  ];
  session.events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "artifact", tool: "run_shell" },
    { seq: 3, type: "tool.completed", callId: "artifact", tool: "run_shell", ok: true, status: "completed", fileChanges: {
      complete: true,
      summary: { created: 0, modified: 1, deleted: 0, total: 1 },
      changes: [{ path: "a", operation: "modified" }],
    } },
    { seq: 4, type: "tool.requested", callId: "approval-call", tool: "write_file" },
    { seq: 5, type: "approval.requested", callId: "approval-call", tool: "write_file" },
  ];
  return session;
}

function repeatedCallSession() {
  return {
    id: "repeat",
    phase: "completed",
    messages: [
      { role: "user", content: "两次" },
      { role: "assistant", tool_calls: [
        { id: "same", name: "read_file", arguments: { path: "a" } },
        { id: "same", name: "read_file", arguments: { path: "b" } },
      ] },
      { role: "tool", tool_call_id: "same", content: "a" },
      { role: "tool", tool_call_id: "same", content: "b" },
    ],
    events: [
      { seq: 1, type: "message.user" },
      { seq: 2, type: "tool.requested", callId: "same", tool: "read_file" },
      { seq: 3, type: "tool.completed", callId: "same", tool: "read_file", ok: true, status: "completed" },
      { seq: 4, type: "tool.requested", callId: "same", tool: "read_file" },
      { seq: 5, type: "tool.completed", callId: "same", tool: "read_file", ok: true, status: "completed" },
      { seq: 6, type: "session.turn_completed", durationMs: 5 },
    ],
  };
}

function terminatedToolsSession() {
  const calls = ["timeout", "cancelled", "failed", "legacy"].map((id) => ({
    id,
    name: "run_shell",
    arguments: { command: id },
  }));
  return {
    id: "terminated-tools",
    phase: "completed",
    messages: [
      { role: "user", content: "运行" },
      { role: "assistant", tool_calls: calls },
      ...calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: "已结束" })),
    ],
    events: [
      { seq: 1, type: "message.user" },
      { seq: 2, type: "tool.requested", callId: "timeout", tool: "run_shell" },
      { seq: 3, type: "tool.execution_started", callId: "timeout", tool: "run_shell", effectiveTimeoutMs: 1_500 },
      { seq: 4, type: "tool.completed", callId: "timeout", tool: "run_shell", ok: false, status: "timeout", terminationReason: "timeout", durationMs: 1_500 },
      { seq: 5, type: "tool.requested", callId: "cancelled", tool: "run_shell" },
      { seq: 6, type: "tool.execution_started", callId: "cancelled", tool: "run_shell", effectiveTimeoutMs: null },
      { seq: 7, type: "tool.completed", callId: "cancelled", tool: "run_shell", ok: false, status: "cancelled", terminationReason: "cancelled", durationMs: 1_500 },
      { seq: 8, type: "tool.requested", callId: "failed", tool: "run_shell" },
      { seq: 9, type: "tool.completed", callId: "failed", tool: "run_shell", ok: false, status: "external_failed", terminationReason: "external_failed", durationMs: 1_500 },
      { seq: 10, type: "tool.requested", callId: "legacy", tool: "run_shell" },
      { seq: 11, type: "tool.completed", callId: "legacy", tool: "run_shell", ok: false, status: "external_failed", durationMs: 1_500 },
      { seq: 12, type: "session.turn_completed", durationMs: 6_000 },
    ],
  };
}

function outcomeSession() {
  const session = {
    id: "outcomes",
    phase: "idle",
    lineage: { parentSessionId: "parent" },
    messages: [
      { role: "user", content: "继承任务" },
      { role: "assistant", tool_calls: [{ id: "inherited", name: "read_file", arguments: {} }] },
      { role: "tool", tool_call_id: "inherited", content: "继承内容" },
      { role: "user", content: "失败任务" },
      { role: "user", content: "未知任务" },
      { role: "assistant", tool_calls: [{ id: "unknown", name: "run_shell", arguments: {} }] },
      { role: "tool", tool_call_id: "unknown", content: "未知" },
    ],
    events: [
      { seq: 1, type: "session.branched", parentSessionId: "parent" },
      { seq: 2, type: "message.user" },
      { seq: 3, type: "session.failed", error: "之前失败", durationMs: 3 },
      { seq: 4, type: "message.user" },
      { seq: 5, type: "tool.requested", callId: "unknown", tool: "run_shell" },
      { seq: 6, type: "tool.execution_unknown", callId: "unknown", tool: "run_shell", reason: "process_interrupted" },
      { seq: 7, type: "tool.completed", callId: "unknown", tool: "run_shell", status: "execution_unknown", ok: false },
      { seq: 8, type: "session.cancelled", reason: "用户取消", durationMs: 5 },
    ],
  };
  return session;
}

function createFixture() {
  const document = new FakeDocument();
  const root = document.createElement("div");
  root.clientHeight = 200;
  root.scrollHeight = 600;
  root.scrollTop = 400;
  return { document, root, frames: frameScheduler() };
}

function frameScheduler() {
  let nextId = 1;
  const tasks = new Map();
  const schedule = (callback) => {
    const id = nextId++;
    tasks.set(id, { callback, cancelled: false });
    return id;
  };
  const cancel = (id) => {
    const task = tasks.get(id);
    if (task) task.cancelled = true;
  };
  const flush = ({ includeCancelled = false } = {}) => {
    const queued = [...tasks.values()];
    tasks.clear();
    for (const task of queued) if (!task.cancelled || includeCancelled) task.callback();
  };
  return { schedule, cancel, flush };
}

function findOne(root, className) {
  const matches = findAll(root, className);
  assert.equal(matches.length > 0, true, `找不到 .${className}`);
  return matches[0];
}

function findAll(root, className) {
  const matches = [];
  const visit = (node) => {
    if (node.classList?.contains(className)) matches.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return matches;
}

function countText(root, needle) {
  let count = 0;
  const visit = (node) => {
    if (!node.children?.length && node.textContent.includes(needle)) count += 1;
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return count;
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function never() {
  return new Promise(() => {});
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.defaultView = { location: { href: "http://localhost/" } };
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  createTextNode(value) {
    return new FakeText(this, value);
  }
}

class FakeText {
  constructor(ownerDocument, value) {
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.textContent = String(value);
  }
}

class FakeElement extends EventTarget {
  constructor(ownerDocument, tagName) {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.classes = new Set();
    this.dataset = {};
    this._textContent = "";
    this.disabled = false;
    this.open = false;
    this.type = "";
    this.title = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classes].join(" ");
  }

  set textContent(value) {
    this._textContent = String(value);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  get childElementCount() {
    return this.children.filter((child) => child instanceof FakeElement).length;
  }

  append(...children) {
    for (const child of children) this.#insert(child, this.children.length);
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._textContent = "";
    this.append(...children);
  }

  insertBefore(child, reference) {
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    if (reference && index < 0) throw new Error("reference 不属于当前节点");
    this.#insert(child, index);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("child 不属于当前节点");
    this.children.splice(index, 1);
    child.parentNode = null;
    if (this.ownerDocument.activeElement && child.contains(this.ownerDocument.activeElement)) {
      this.ownerDocument.activeElement = null;
    }
    return child;
  }

  contains(target) {
    return this === target || this.children.some((child) => child === target || child.contains?.(target));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  #insert(child, index) {
    if (child.parentNode) {
      const previousIndex = child.parentNode.children.indexOf(child);
      if (previousIndex >= 0) child.parentNode.children.splice(previousIndex, 1);
      if (child.parentNode === this && previousIndex < index) index -= 1;
    }
    child.parentNode = this;
    this.children.splice(index, 0, child);
  }
}
