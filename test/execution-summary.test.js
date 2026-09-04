import assert from "node:assert/strict";
import test from "node:test";
import { createSession, createSessionBranch, reduceSession } from "../src/core/state.js";
import { projectExecutionTurns } from "../src/web/execution-summary.js";

test("Execution Summary 将多次模型步骤和工具运行聚合到同一用户 Turn", () => {
  const messages = [
    { role: "user", content: "检查并修复" },
    { role: "assistant", content: "先检查", tool_calls: [{ id: "a", name: "read_file", arguments: { path: "a.js" } }] },
    { role: "tool", tool_call_id: "a", content: "0 errors" },
    { role: "assistant", content: "再修改", tool_calls: [{ id: "b", name: "write_file", arguments: { path: "b.js" } }] },
    { role: "tool", tool_call_id: "b", content: "完成" },
    { role: "assistant", content: "已完成。" },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "model.requested" },
    { seq: 3, type: "model.completed", durationMs: 20 },
    { seq: 4, type: "tool.requested", callId: "a", tool: "read_file" },
    { seq: 5, type: "tool.execution_started", callId: "a", tool: "read_file" },
    { seq: 6, type: "tool.completed", callId: "a", tool: "read_file", ok: true, status: "completed", durationMs: 5 },
    { seq: 7, type: "model.requested" },
    { seq: 8, type: "model.completed", durationMs: 30 },
    { seq: 9, type: "tool.requested", callId: "b", tool: "write_file" },
    { seq: 10, type: "tool.execution_started", callId: "b", tool: "write_file" },
    { seq: 11, type: "tool.completed", callId: "b", tool: "write_file", ok: true, status: "completed", durationMs: 8, fileChanges: {
      complete: true,
      changes: [{ path: "b.js", operation: "created" }, { path: "a.js", operation: "modified" }],
    } },
    { seq: 12, type: "session.turn_completed", durationMs: 80 },
  ];

  const { turns } = projectExecutionTurns({ messages, events, phase: "completed" });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].execution.counts.total, 2);
  assert.equal(turns[0].execution.counts.succeeded, 2);
  assert.equal(turns[0].execution.model.requests, 2);
  assert.equal(turns[0].execution.model.durationMs, 50);
  assert.equal(turns[0].execution.toolDurationMs, 13);
  assert.equal(turns[0].execution.durationMs, 80);
  assert.deepEqual(turns[0].execution.fileChanges.summary, { created: 1, modified: 1, deleted: 0, total: 2 });
  assert.equal(turns[0].execution.fileChanges.uniquePaths, 2);
  assert.equal(turns[0].execution.fileChanges.entries[0].runKey, turns[0].execution.runs[1].runKey);
  assert.equal(turns[0].execution.fileChanges.entries[0].tool, "write_file");
});

test("重复 callId 只在当前 Turn 和当前 occurrence 内配对", () => {
  const messages = [
    { role: "user", content: "第一次" },
    { role: "assistant", tool_calls: [{ id: "same", name: "read_file", arguments: {} }] },
    { role: "tool", tool_call_id: "same", content: "first" },
    { role: "assistant", content: "完成" },
    { role: "user", content: "第二次" },
    { role: "assistant", tool_calls: [{ id: "same", name: "read_file", arguments: {} }] },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "same", tool: "read_file" },
    { seq: 3, type: "tool.completed", callId: "same", tool: "read_file", ok: true, status: "completed", durationMs: 4, fileChanges: { complete: true, changes: [{ path: "old", operation: "modified" }] } },
    { seq: 4, type: "session.turn_completed", durationMs: 10 },
    { seq: 5, type: "message.user" },
    { seq: 6, type: "tool.requested", callId: "same", tool: "read_file" },
    { seq: 7, type: "tool.execution_started", callId: "same", tool: "read_file" },
  ];
  const toolStreams = { same: { callId: "same", status: "streaming", preview: "new" } };

  const { turns } = projectExecutionTurns({ messages, events, phase: "executing", toolStreams });
  assert.equal(turns[0].execution.runs[0].status, "succeeded");
  assert.equal(turns[0].execution.runs[0].result.content, "first");
  assert.equal(turns[1].execution.runs[0].status, "running");
  assert.equal(turns[1].execution.runs[0].result, null);
  assert.equal(turns[1].execution.runs[0].fileChanges, null);
  assert.equal(turns[1].execution.runs[0].liveOutput.preview, "new");
});

test("Execution Summary 使用 durable 终态，不从输出文案猜测成败", () => {
  const messages = [
    { role: "user", content: "执行" },
    { role: "assistant", tool_calls: [
      { id: "ok", name: "one", arguments: {} },
      { id: "bad", name: "two", arguments: {} },
    ] },
    { role: "tool", tool_call_id: "ok", content: "发现 error 和失败字样，但退出码为 0" },
    { role: "tool", tool_call_id: "bad", content: "看起来一切正常" },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "ok", tool: "one" },
    { seq: 3, type: "tool.completed", callId: "ok", tool: "one", ok: true, status: "completed" },
    { seq: 4, type: "tool.requested", callId: "bad", tool: "two" },
    { seq: 5, type: "tool.completed", callId: "bad", tool: "two", ok: false, status: "external_failed" },
    { seq: 6, type: "session.turn_completed", durationMs: 12 },
  ];
  const [turn] = projectExecutionTurns({ messages, events, phase: "completed" }).turns;
  assert.deepEqual(turn.execution.runs.map((run) => run.status), ["succeeded", "failed"]);
  assert.equal(turn.execution.status, "attention");
});

test("Execution Summary 投影实际期限和白名单终止原因并兼容旧 Journal", () => {
  const calls = [
    { id: "timeout", name: "run_shell", arguments: {} },
    { id: "cancelled", name: "run_shell", arguments: {} },
    { id: "failed", name: "run_shell", arguments: {} },
    { id: "legacy", name: "run_shell", arguments: {} },
    { id: "running", name: "run_shell", arguments: {} },
  ];
  const messages = [
    { role: "user", content: "执行多个命令" },
    { role: "assistant", tool_calls: calls },
    ...calls.slice(0, 4).map((call) => ({ role: "tool", tool_call_id: call.id, content: "结果" })),
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "timeout", tool: "run_shell" },
    { seq: 3, type: "tool.execution_started", callId: "timeout", tool: "run_shell", effectiveTimeoutMs: 1_500 },
    { seq: 4, type: "tool.completed", callId: "timeout", tool: "run_shell", ok: false, status: "timeout", effectiveTimeoutMs: 1_500, terminationReason: "timeout" },
    { seq: 5, type: "tool.requested", callId: "cancelled", tool: "run_shell" },
    { seq: 6, type: "tool.execution_started", callId: "cancelled", tool: "run_shell", effectiveTimeoutMs: null },
    { seq: 7, type: "tool.completed", callId: "cancelled", tool: "run_shell", ok: false, status: "cancelled", effectiveTimeoutMs: null, terminationReason: "cancelled" },
    { seq: 8, type: "tool.requested", callId: "failed", tool: "run_shell" },
    { seq: 9, type: "tool.completed", callId: "failed", tool: "run_shell", ok: false, status: "external_failed", terminationReason: "external_failed" },
    { seq: 10, type: "tool.requested", callId: "legacy", tool: "run_shell" },
    { seq: 11, type: "tool.completed", callId: "legacy", tool: "run_shell", ok: false, status: "external_failed", effectiveTimeoutMs: -1, terminationReason: "untrusted detail" },
    { seq: 12, type: "tool.requested", callId: "running", tool: "run_shell" },
    { seq: 13, type: "tool.execution_started", callId: "running", tool: "run_shell", effectiveTimeoutMs: 90_000 },
  ];

  const runs = projectExecutionTurns({ messages, events, phase: "executing" }).turns[0].execution.runs;
  assert.deepEqual(runs.map((run) => run.status), ["failed", "cancelled", "failed", "failed", "running"]);
  assert.deepEqual(runs.map((run) => run.effectiveTimeoutMs), [1_500, null, undefined, undefined, 90_000]);
  assert.deepEqual(runs.map((run) => run.terminationReason), ["timeout", "cancelled", "external_failed", null, null]);
});

test("execution_unknown 与 tool.completed 只计一次运行和一次耗时", () => {
  const messages = [
    { role: "user", content: "运行" },
    { role: "assistant", tool_calls: [{ id: "x", name: "run_shell", arguments: {} }] },
    { role: "tool", tool_call_id: "x", content: "执行状态未知" },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "x", tool: "run_shell" },
    { seq: 3, type: "tool.execution_started", callId: "x", tool: "run_shell" },
    { seq: 4, type: "tool.execution_unknown", callId: "x", tool: "run_shell", reason: "process_interrupted", durationMs: 18 },
    { seq: 5, type: "tool.completed", callId: "x", tool: "run_shell", ok: false, status: "execution_unknown", durationMs: 19 },
    { seq: 6, type: "session.cancelled", durationMs: 24 },
  ];
  const [turn] = projectExecutionTurns({ messages, events, phase: "cancelled" }).turns;
  assert.equal(turn.execution.counts.total, 1);
  assert.equal(turn.execution.counts.unknown, 1);
  assert.equal(turn.execution.toolDurationMs, 19);
  assert.equal(turn.execution.status, "unknown");
  assert.equal(turn.execution.outcome.status, "unknown");
  assert.equal(turn.execution.outcome.terminalStatus, "cancelled");
  assert.equal(turn.execution.outcome.sideEffectCertainty, "unknown");
  assert.equal(turn.execution.outcome.requiresManualInspection, true);
  assert.deepEqual(turn.execution.outcome.unknownRunKeys, [turn.execution.runs[0].runKey]);
});

test("旧 Turn 的失败原因来自 durable 终态，不会在 Session 恢复或新 Turn 后消失", () => {
  const messages = [
    { role: "user", content: "第一次" },
    { role: "assistant", content: "执行失败" },
    { role: "user", content: "继续" },
    { role: "assistant", content: "已恢复" },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "model.requested" },
    { seq: 3, type: "session.failed", error: "Provider 临时不可用", durationMs: 31 },
    { seq: 4, type: "message.user" },
    { seq: 5, type: "model.requested" },
    { seq: 6, type: "model.completed", durationMs: 7 },
    { seq: 7, type: "session.turn_completed", durationMs: 11 },
  ];

  const { turns } = projectExecutionTurns({ messages, events, phase: "completed" });
  assert.equal(turns[0].execution.outcome.status, "failed");
  assert.equal(turns[0].execution.outcome.reason, "Provider 临时不可用");
  assert.equal(turns[0].execution.outcome.durationMs, 31);
  assert.equal(turns[1].execution.outcome.status, "completed");
  assert.equal(turns[1].execution.outcome.reason, null);
});

test("取消原因和恢复中断说明保留在各自 Turn outcome", () => {
  const cancelled = projectExecutionTurns({
    messages: [{ role: "user", content: "停止" }],
    events: [
      { seq: 1, type: "message.user" },
      { seq: 2, type: "session.cancelled", reason: "用户中途停止", durationMs: 9 },
    ],
    phase: "idle",
  }).turns[0].execution.outcome;
  assert.deepEqual(cancelled, {
    status: "cancelled",
    terminalStatus: "cancelled",
    reason: "用户中途停止",
    durationMs: 9,
    recovered: false,
    interruptedFromPhase: null,
    sideEffectCertainty: "not_applicable",
    unknownRunKeys: [],
    requiresManualInspection: false,
  });

  const interrupted = projectExecutionTurns({
    messages: [{ role: "user", content: "分析" }],
    events: [
      { seq: 1, type: "message.user" },
      { seq: 2, type: "model.requested" },
      { seq: 3, type: "session.resumed", previousPhase: "thinking" },
    ],
    phase: "idle",
  }).turns[0].execution.outcome;
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.recovered, true);
  assert.equal(interrupted.interruptedFromPhase, "thinking");
  assert.match(interrupted.reason, /未完成的运行已中断/);
});

test("Adapter 已启动但 Turn 先失败或取消时保守标记结果未知", () => {
  for (const terminal of [
    { seq: 4, type: "session.failed", error: "Provider 失败" },
    { seq: 4, type: "session.cancelled", reason: "用户取消" },
  ]) {
    const [turn] = projectExecutionTurns({
      messages: [
        { role: "user", content: "执行副作用" },
        { role: "assistant", tool_calls: [{ id: "started", name: "run_shell", arguments: {} }] },
      ],
      events: [
        { seq: 1, type: "message.user" },
        { seq: 2, type: "tool.requested", callId: "started", tool: "run_shell" },
        { seq: 3, type: "tool.execution_started", callId: "started", tool: "run_shell" },
        terminal,
      ],
      phase: terminal.type === "session.failed" ? "failed" : "cancelled",
    }).turns;

    assert.equal(turn.execution.status, "unknown");
    assert.equal(turn.execution.runs[0].status, "unknown");
    assert.equal(turn.execution.runs[0].recovery.reason, "turn_closed_after_tool_start");
    assert.equal(turn.execution.outcome.status, "unknown");
    assert.equal(turn.execution.outcome.terminalStatus, terminal.type === "session.failed" ? "failed" : "cancelled");
    assert.equal(turn.execution.outcome.requiresManualInspection, true);
    assert.equal(turn.execution.integrity.complete, false);
    assert.match(turn.execution.integrity.issues[0], /missing_tool_terminal_event/);
  }
});

test("当前审批和输出流只覆盖最后一个未闭合的同 callId 运行", () => {
  const messages = [
    { role: "user", content: "两次调用" },
    { role: "assistant", tool_calls: [
      { id: "repeat", name: "run_shell", arguments: { command: "one" } },
      { id: "repeat", name: "run_shell", arguments: { command: "two" } },
    ] },
    { role: "tool", tool_call_id: "repeat", content: "one done" },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "repeat", tool: "run_shell" },
    { seq: 3, type: "tool.completed", callId: "repeat", tool: "run_shell", ok: true, status: "completed" },
    { seq: 4, type: "tool.requested", callId: "repeat", tool: "run_shell" },
    { seq: 5, type: "approval.requested", callId: "repeat", tool: "run_shell", reason: "需要确认" },
  ];
  const [turn] = projectExecutionTurns({
    messages,
    events,
    phase: "awaiting_approval",
    pendingApproval: { id: "repeat", name: "run_shell", reason: "需要确认" },
  }).turns;
  assert.equal(turn.execution.runs[0].status, "succeeded");
  assert.equal(turn.execution.runs[0].pendingApproval, null);
  assert.equal(turn.execution.runs[1].status, "awaiting_approval");
  assert.equal(turn.execution.runs[1].pendingApproval.id, "repeat");
});

test("重复 callId 的首个 occurrence 待审批时按钮不会贴到尚未请求的后一个运行", () => {
  const messages = [
    { role: "user", content: "顺序执行两条命令" },
    { role: "assistant", tool_calls: [
      { id: "repeat", name: "run_shell", arguments: { command: "one" } },
      { id: "repeat", name: "run_shell", arguments: { command: "two" } },
    ] },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "repeat", tool: "run_shell", argsHash: "one-hash" },
    { seq: 3, type: "approval.requested", callId: "repeat", tool: "run_shell", argsHash: "one-hash", reason: "需要确认" },
  ];
  const [turn] = projectExecutionTurns({
    messages,
    events,
    phase: "awaiting_approval",
    pendingApproval: {
      id: "repeat",
      name: "run_shell",
      argsHash: "one-hash",
      reason: "需要确认",
    },
  }).turns;

  assert.equal(turn.execution.runs[0].call.arguments.command, "one");
  assert.equal(turn.execution.runs[0].status, "awaiting_approval");
  assert.equal(turn.execution.runs[0].pendingApproval.argsHash, "one-hash");
  assert.equal(turn.execution.runs[1].call.arguments.command, "two");
  assert.equal(turn.execution.runs[1].pendingApproval, null);
  assert.equal(turn.execution.runs[1].status, "pending");
});

test("重复 callId 的首个 occurrence 执行中时输出不会贴到尚未请求的后一个运行", () => {
  const messages = [
    { role: "user", content: "顺序执行两条命令" },
    { role: "assistant", tool_calls: [
      { id: "repeat", name: "run_shell", arguments: { command: "one" } },
      { id: "repeat", name: "run_shell", arguments: { command: "two" } },
    ] },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "repeat", tool: "run_shell", argsHash: "one-hash" },
    { seq: 3, type: "tool.execution_started", callId: "repeat", tool: "run_shell", argsHash: "one-hash" },
  ];
  const stream = { callId: "repeat", status: "streaming", preview: "one output" };
  const [turn] = projectExecutionTurns({
    messages,
    events,
    phase: "executing",
    toolStreams: { repeat: stream },
  }).turns;

  assert.equal(turn.execution.runs[0].status, "running");
  assert.equal(turn.execution.runs[0].liveOutput, stream);
  assert.equal(turn.execution.runs[1].status, "pending");
  assert.equal(turn.execution.runs[1].liveOutput, null);
});

test("缺少部分旧事件时仍按消息 occurrence 排列工具，不把结果套错", () => {
  const messages = [
    { role: "user", content: "旧记录" },
    { role: "assistant", tool_calls: [
      { id: "missing", function: { name: "read_file", arguments: "{}" } },
      { id: "present", function: { name: "run_shell", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "missing", content: "legacy" },
    { role: "tool", tool_call_id: "present", content: "durable" },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "present", tool: "run_shell" },
    { seq: 3, type: "tool.completed", callId: "present", tool: "run_shell", ok: true, status: "completed" },
  ];
  const [turn] = projectExecutionTurns({ messages, events, phase: "completed" }).turns;
  assert.deepEqual(turn.execution.runs.map((run) => run.callId), ["missing", "present"]);
  assert.equal(turn.execution.runs[0].result.content, "legacy");
  assert.equal(turn.execution.runs[0].status, "unknown");
  assert.equal(turn.execution.runs[1].result.content, "durable");
  assert.equal(turn.execution.runs[1].status, "succeeded");
  assert.equal(turn.execution.integrity.complete, false);
});

test("Gateway 恢复会关闭未启动的审批，不把旧卡片继续显示为待批准", () => {
  const messages = [
    { role: "user", content: "写文件" },
    { role: "assistant", tool_calls: [{ id: "approval", name: "write_file", arguments: {} }] },
    { role: "tool", tool_call_id: "approval", content: "会话恢复：该工具调用尚未获得审批，已取消且未执行。" },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "approval", tool: "write_file" },
    { seq: 3, type: "approval.requested", callId: "approval", tool: "write_file" },
    { seq: 4, type: "session.resumed", previousPhase: "awaiting_approval", discardedApproval: "write_file" },
  ];
  const [turn] = projectExecutionTurns({ messages, events, phase: "idle" }).turns;
  assert.equal(turn.execution.runs[0].status, "cancelled");
  assert.equal(turn.execution.counts.awaitingApproval, 0);
  assert.equal(turn.execution.counts.cancelled, 1);
  assert.equal(turn.execution.status, "cancelled");
});

test("工具成功但最终回答前恢复时 Turn 不会误报为完成", () => {
  const messages = [
    { role: "user", content: "检查项目" },
    { role: "assistant", tool_calls: [{ id: "done", name: "read_file", arguments: {} }] },
    { role: "tool", tool_call_id: "done", content: "已读取" },
  ];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "tool.requested", callId: "done", tool: "read_file" },
    { seq: 3, type: "tool.completed", callId: "done", tool: "read_file", ok: true, status: "completed" },
    { seq: 4, type: "model.requested" },
    { seq: 5, type: "session.resumed", previousPhase: "thinking" },
  ];
  const [turn] = projectExecutionTurns({ messages, events, phase: "idle" }).turns;
  assert.equal(turn.execution.counts.succeeded, 1);
  assert.equal(turn.execution.status, "interrupted");
  assert.equal(turn.execution.recovery.interrupted, true);
  assert.equal(turn.execution.recovery.toolExecutionUnknown, false);
});

test("纯模型请求在生成中恢复时显示为中断而不是空闲", () => {
  const messages = [{ role: "user", content: "分析项目" }];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "model.requested" },
    { seq: 3, type: "session.resumed", previousPhase: "thinking" },
  ];
  const [turn] = projectExecutionTurns({ messages, events, phase: "idle" }).turns;
  assert.equal(turn.execution.model.requests, 1);
  assert.equal(turn.execution.model.completed, 0);
  assert.equal(turn.execution.status, "interrupted");
  assert.equal(turn.execution.recovery.interrupted, true);
});

test("未完成 Turn 连续恢复时保留第一次运行中断状态", () => {
  const messages = [{ role: "user", content: "分析项目" }];
  const events = [
    { seq: 1, type: "message.user" },
    { seq: 2, type: "model.requested" },
    { seq: 3, type: "session.resumed", previousPhase: "thinking" },
    { seq: 4, type: "session.resumed", previousPhase: "idle" },
  ];
  const [turn] = projectExecutionTurns({ messages, events, phase: "idle" }).turns;
  assert.equal(turn.execution.status, "interrupted");
  assert.equal(turn.execution.recovery.previousPhase, "idle");
  assert.equal(turn.execution.recovery.interruptedFromPhase, "thinking");
});

test("分支继承的文件变化单独投影且不猜测原始 Turn", () => {
  const messages = [
    { role: "user", content: "修改文件" },
    { role: "assistant", tool_calls: [{ id: "same", name: "write_file", arguments: {} }] },
    { role: "tool", tool_call_id: "same", content: "已完成" },
  ];
  const manifest = {
    complete: true,
    summary: { created: 0, modified: 1, deleted: 0, total: 1 },
    changes: [{ path: "src/app.js", operation: "modified" }],
    diffArtifact: { id: "artifact-branch", sessionId: "branch", kind: "file_diff" },
  };
  const events = [
    { seq: 1, type: "session.branched", parentSessionId: "parent", parentCursor: 20 },
    { seq: 2, type: "tool.file_changes_inherited", callId: "same", tool: "write_file", parentSessionId: "parent", parentCursor: 20, fileChanges: manifest },
  ];
  const projection = projectExecutionTurns({ id: "branch", messages, events, phase: "idle" });
  assert.equal(projection.inheritedFileChanges.length, 1);
  assert.equal(projection.inheritedFileChanges[0].status, "inherited");
  assert.equal(projection.inheritedFileChanges[0].parentSessionId, "parent");
  assert.equal(projection.inheritedFileChanges[0].manifest, manifest);
  assert.equal(projection.turns[0].execution.fileChanges.entries.length, 0);
  assert.equal(projection.turns[0].execution.inherited, true);
  assert.equal(projection.turns[0].execution.runs[0].status, "inherited");
  assert.equal(projection.turns[0].execution.counts.unknown, 0);
});

test("Branch 新事件窗口向右对齐，不把新工具运行挂到继承 Turn", () => {
  const messages = [
    { role: "user", content: "父任务一" },
    { role: "assistant", tool_calls: [{ id: "old", name: "read_file", arguments: { path: "old" } }] },
    { role: "tool", tool_call_id: "old", content: "父结果" },
    { role: "assistant", content: "父回答一" },
    { role: "user", content: "父任务二" },
    { role: "assistant", content: "父回答二" },
    { role: "user", content: "分支任务" },
    { role: "assistant", tool_calls: [{ id: "new", name: "read_file", arguments: { path: "new" } }] },
    { role: "tool", tool_call_id: "new", content: "分支结果" },
    { role: "assistant", content: "分支回答" },
  ];
  const events = [
    { seq: 1, type: "session.branched", parentSessionId: "parent", parentCursor: 50 },
    { seq: 2, type: "message.user" },
    { seq: 3, type: "tool.requested", callId: "new", tool: "read_file" },
    { seq: 4, type: "tool.completed", callId: "new", tool: "read_file", ok: true, status: "completed" },
    { seq: 5, type: "session.turn_completed", durationMs: 12 },
  ];

  const { turns } = projectExecutionTurns({ id: "branch", messages, events, phase: "completed" });
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((turn) => turn.execution.inherited), [true, true, false]);
  assert.equal(turns[0].execution.runs[0].callId, "old");
  assert.equal(turns[0].execution.runs[0].status, "inherited");
  assert.equal(turns[0].execution.runs[0].result.content, "父结果");
  assert.equal(turns[0].execution.counts.unknown, 0);
  assert.equal(turns[2].execution.runs.length, 1);
  assert.equal(turns[2].execution.runs[0].callId, "new");
  assert.equal(turns[2].execution.runs[0].status, "succeeded");
  assert.equal(turns[2].execution.integrity.complete, true);
});

test("Branch 连续两个新 Turn 都按末尾事件窗口逐一配对", () => {
  const messages = [
    { role: "user", content: "父任务" },
    { role: "assistant", content: "父回答" },
    { role: "user", content: "分支一" },
    { role: "assistant", tool_calls: [{ id: "one", name: "read_file", arguments: {} }] },
    { role: "tool", tool_call_id: "one", content: "one" },
    { role: "assistant", content: "一完成" },
    { role: "user", content: "分支二" },
    { role: "assistant", tool_calls: [{ id: "two", name: "search_files", arguments: {} }] },
  ];
  const events = [
    { seq: 1, type: "session.branched", parentSessionId: "parent", parentCursor: 10 },
    { seq: 2, type: "message.user" },
    { seq: 3, type: "tool.requested", callId: "one", tool: "read_file" },
    { seq: 4, type: "tool.completed", callId: "one", tool: "read_file", ok: true, status: "completed" },
    { seq: 5, type: "session.turn_completed" },
    { seq: 6, type: "message.user" },
    { seq: 7, type: "tool.requested", callId: "two", tool: "search_files" },
    { seq: 8, type: "tool.execution_started", callId: "two", tool: "search_files" },
  ];

  const { turns } = projectExecutionTurns({ id: "branch", messages, events, phase: "executing" });
  assert.deepEqual(turns.map((turn) => turn.execution.inherited), [true, false, false]);
  assert.equal(turns[1].execution.runs[0].callId, "one");
  assert.equal(turns[1].execution.runs[0].status, "succeeded");
  assert.equal(turns[2].execution.runs[0].callId, "two");
  assert.equal(turns[2].execution.runs[0].status, "running");
});

test("从运行中工具建立 Branch 会保留 occurrence 级结果未知事实", () => {
  const workspace = "/private/tmp/nexus-branch-projection";
  const call = { id: "same", name: "run_shell", arguments: { command: "echo test" } };
  let parent = createSession({ id: "parent", provider: "demo", workspace });
  parent = reduceSession(parent, { type: "USER_MESSAGE", content: "第一次", at: "2026-09-03T00:00:01.000Z" });
  parent = reduceSession(parent, {
    type: "ASSISTANT_MESSAGE",
    message: { role: "assistant", tool_calls: [{ id: "same", name: "run_shell", arguments: {} }] },
    at: "2026-09-03T00:00:02.000Z",
  });
  parent = reduceSession(parent, { type: "TOOL_REQUESTED", call, at: "2026-09-03T00:00:03.000Z" });
  parent = reduceSession(parent, { type: "TOOL_EXECUTION_STARTED", call, at: "2026-09-03T00:00:04.000Z" });
  parent = reduceSession(parent, {
    type: "TOOL_RESULT",
    call,
    result: "第一次完成",
    ok: true,
    durationMs: 3,
    at: "2026-09-03T00:00:05.000Z",
  });
  parent = reduceSession(parent, { type: "COMPLETED", at: "2026-09-03T00:00:06.000Z" });
  parent = reduceSession(parent, { type: "USER_MESSAGE", content: "第二次", at: "2026-09-03T00:00:07.000Z" });
  parent = reduceSession(parent, {
    type: "ASSISTANT_MESSAGE",
    message: { role: "assistant", tool_calls: [{ id: "same", name: "run_shell", arguments: {} }] },
    at: "2026-09-03T00:00:08.000Z",
  });
  parent = reduceSession(parent, { type: "TOOL_REQUESTED", call, at: "2026-09-03T00:00:09.000Z" });
  parent = reduceSession(parent, { type: "TOOL_EXECUTION_STARTED", call, at: "2026-09-03T00:00:10.000Z" });

  const branch = createSessionBranch(parent, {
    id: "branch",
    parentCursor: 10,
    provider: "demo",
    workspace,
    branchedAt: "2026-09-03T00:00:11.000Z",
  });
  const inheritedUnknown = branch.events.filter((event) => event.type === "tool.execution_unknown");
  assert.equal(inheritedUnknown.length, 1);
  assert.equal(inheritedUnknown[0].inherited, true);
  assert.equal(inheritedUnknown[0].messageIndex, 4);
  assert.equal(inheritedUnknown[0].callOrdinal, 0);

  const { turns } = projectExecutionTurns(branch);
  assert.equal(turns[0].execution.runs[0].status, "inherited");
  assert.equal(turns[1].execution.runs[0].status, "unknown");
  assert.equal(turns[1].execution.outcome.status, "unknown");
  assert.equal(turns[1].execution.outcome.requiresManualInspection, true);
  assert.equal(turns[1].execution.integrity.complete, true);
});

test("Branch 继承崩溃窗口中已持久化的 unknown，且不被重复 callId 串线", () => {
  const workspace = "/private/tmp/nexus-branch-persisted-unknown";
  const first = { id: "same", name: "run_shell", arguments: { command: "one", timeout_ms: 25 } };
  let parent = createSession({ id: "parent", provider: "demo", workspace });
  parent = reduceSession(parent, { type: "USER_MESSAGE", content: "并列执行", at: "2026-09-03T00:00:01.000Z" });
  parent = reduceSession(parent, {
    type: "ASSISTANT_MESSAGE",
    message: { role: "assistant", tool_calls: [
      { id: "same", name: "run_shell", arguments: { command: "one", timeout_ms: 25 } },
      { id: "same", name: "run_shell", arguments: { command: "two" } },
    ] },
    at: "2026-09-03T00:00:02.000Z",
  });
  parent = reduceSession(parent, { type: "TOOL_REQUESTED", call: first, at: "2026-09-03T00:00:03.000Z" });
  parent = reduceSession(parent, {
    type: "TOOL_EXECUTION_STARTED",
    call: first,
    adapter: "native",
    effectiveTimeoutMs: 25,
    deadlineAt: "2026-09-03T00:00:04.025Z",
    at: "2026-09-03T00:00:04.000Z",
  });
  parent = reduceSession(parent, {
    type: "TOOL_EXECUTION_UNKNOWN",
    call: first,
    adapter: "native",
    reason: "timeout",
    terminationReason: "timeout",
    effectiveTimeoutMs: 25,
    durationMs: 25,
    at: "2026-09-03T00:00:04.025Z",
  });

  const branch = createSessionBranch(parent, {
    id: "branch",
    parentCursor: parent.cursor,
    provider: "demo",
    workspace,
    branchedAt: "2026-09-03T00:00:05.000Z",
  });
  const unknown = branch.events.filter((event) => event.type === "tool.execution_unknown");
  const cancelled = branch.events.filter((event) => event.type === "tool.recovery_cancelled");

  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].messageIndex, 1);
  assert.equal(unknown[0].callOrdinal, 0);
  assert.equal(unknown[0].terminationReason, "timeout");
  assert.equal(unknown[0].effectiveTimeoutMs, 25);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].messageIndex, 1);
  assert.equal(cancelled[0].callOrdinal, 1);

  const [turn] = projectExecutionTurns(branch).turns;
  assert.deepEqual(turn.execution.runs.map((run) => run.status), ["unknown", "cancelled"]);
  assert.equal(turn.execution.runs[0].terminationReason, "timeout");
  assert.equal(turn.execution.outcome.status, "unknown");
  assert.equal(turn.execution.outcome.requiresManualInspection, true);
});

test("Branch 不会把已由 Tool Result 闭合的历史 unknown 再标成 inherited unknown", () => {
  const workspace = "/private/tmp/nexus-branch-closed-unknown";
  const call = { id: "closed", name: "run_shell", arguments: { command: "one", timeout_ms: 25 } };
  let parent = createSession({ id: "parent", provider: "demo", workspace });
  parent = reduceSession(parent, { type: "USER_MESSAGE", content: "执行并记录结果", at: "2026-09-03T00:00:01.000Z" });
  parent = reduceSession(parent, {
    type: "ASSISTANT_MESSAGE",
    message: { role: "assistant", tool_calls: [{ id: "closed", name: "run_shell", arguments: call.arguments }] },
    at: "2026-09-03T00:00:02.000Z",
  });
  parent = reduceSession(parent, { type: "TOOL_REQUESTED", call, at: "2026-09-03T00:00:03.000Z" });
  parent = reduceSession(parent, {
    type: "TOOL_EXECUTION_STARTED",
    call,
    adapter: "native",
    effectiveTimeoutMs: 25,
    deadlineAt: "2026-09-03T00:00:04.025Z",
    at: "2026-09-03T00:00:04.000Z",
  });
  parent = reduceSession(parent, {
    type: "TOOL_EXECUTION_UNKNOWN",
    call,
    adapter: "native",
    reason: "timeout",
    terminationReason: "timeout",
    effectiveTimeoutMs: 25,
    durationMs: 25,
    at: "2026-09-03T00:00:04.025Z",
  });
  parent = reduceSession(parent, {
    type: "TOOL_RESULT",
    call,
    result: "执行结果未知，需人工检查",
    ok: false,
    status: "execution_unknown",
    terminationReason: "timeout",
    effectiveTimeoutMs: 25,
    durationMs: 25,
    at: "2026-09-03T00:00:04.026Z",
  });

  const branch = createSessionBranch(parent, {
    id: "branch",
    parentCursor: parent.cursor,
    provider: "demo",
    workspace,
    branchedAt: "2026-09-03T00:00:05.000Z",
  });

  assert.equal(branch.events.some((event) => event.type === "tool.execution_unknown"), false);
  const [turn] = projectExecutionTurns(branch).turns;
  assert.equal(turn.execution.runs[0].status, "inherited");
  assert.equal(turn.execution.outcome, null);
});

test("Branch 中重复 callId 的 inherited unknown 按 positional occurrence 分别保留", () => {
  const messages = [
    { role: "user", content: "并列调用" },
    { role: "assistant", tool_calls: [
      { id: "same", name: "run_shell", arguments: { command: "one" } },
      { id: "same", name: "run_shell", arguments: { command: "two" } },
    ] },
    { role: "tool", tool_call_id: "same", content: "状态未知" },
    { role: "tool", tool_call_id: "same", content: "状态未知" },
  ];
  const events = [
    { seq: 1, type: "session.branched", parentSessionId: "parent", parentCursor: 4 },
    { seq: 2, type: "tool.execution_unknown", callId: "same", tool: "run_shell", reason: "process_interrupted", messageIndex: 1, callOrdinal: 0, inherited: true },
    { seq: 3, type: "tool.execution_unknown", callId: "same", tool: "run_shell", reason: "process_interrupted", messageIndex: 1, callOrdinal: 1, inherited: true },
  ];

  const [turn] = projectExecutionTurns({
    id: "branch",
    lineage: { parentSessionId: "parent", parentCursor: 4 },
    messages,
    events,
    phase: "idle",
  }).turns;

  assert.deepEqual(turn.execution.runs.map((run) => run.call.arguments.command), ["one", "two"]);
  assert.deepEqual(turn.execution.runs.map((run) => run.status), ["unknown", "unknown"]);
  assert.deepEqual(turn.execution.runs.map((run) => run.callOrdinal), [0, 1]);
  assert.equal(turn.execution.counts.unknown, 2);
  assert.equal(turn.execution.outcome.unknownRunKeys.length, 2);
  assert.equal(turn.execution.integrity.complete, true);
});
