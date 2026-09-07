import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ToolHost } from "../src/tools/host.js";
import { buildSystemPrompt } from "../src/workspace.js";

const captured = JSON.parse(await fs.readFile(new URL("./fixtures/premature-completions.json", import.meta.url), "utf8"));
const pendingPlan = [{ step: "实现游戏", status: "completed" }, { step: "实际验证并修复", status: "in_progress" }];
const finishedPlan = pendingPlan.map((step) => ({ ...step, status: "completed" }));
const call = (id, name, args) => ({ id, name, arguments: args });
const response = (text, toolCalls = []) => ({ text, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop" });
const planResponse = (id, plan, extra = {}) => response("更新执行计划", [call(id, "update_plan", { plan, ...extra })]);

async function setup(t, complete, options = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-completion-guard-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "verification.txt"), "verification passed");
  const registry = createToolRegistry({ workspace });
  const session = new AgentSession({ state: createSession({ provider: "captured-offline", workspace }), reducer: reduceSession });
  const requests = [];
  const provider = { name: "captured-offline", complete: async (request) => {
    requests.push(request);
    return complete(request, requests.length, session);
  } };
  const runtime = new AgentRuntime({ session, provider, toolHost: new ToolHost({ registry }), systemPrompt: buildSystemPrompt(""), ...options });
  return { runtime, session, requests };
}

for (const sample of captured) {
  test(`真实提前结束回答 ${sample.journalSeq} 在同一用户轮纠正并继续实际验证`, async (t) => {
    const sequence = [
      planResponse("initial-plan", pendingPlan),
      sample,
      response("继续实际验证", [call("verify", "read_file", { path: "verification.txt" }), call("finish-plan", "update_plan", { plan: finishedPlan })]),
      response("实现与验证均已完成。"),
    ];
    const { runtime, session, requests } = await setup(t, (_, n) => {
      assert.ok(sequence[n - 1], "不应额外请求模型");
      return sequence[n - 1];
    });
    await runtime.runTurn("从零完成小游戏，实际验证通过后交付，不需要中途确认。", async () => true);
    assert.equal(requests.length, 4);
    assert.equal(runtime.state.phase, "completed");
    assert.ok(runtime.state.plan.steps.every((step) => step.status === "completed"));
    assert.equal(runtime.state.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(runtime.state.events.filter((event) => event.type === "session.completion_rejected").length, 1);
    assert.match(requests[2].systemPrompt, /结构化/);
    assert.equal(requests[2].messages.some((message) => message.runtime_feedback === "completion"), false);
    assert.ok(runtime.state.events.some((event) => event.type === "tool.completed" && event.callId === "verify" && event.ok));
    assert.equal(runtime.state.events.filter((event) => event.type === "tool.requested" && event.tool === "run_shell").length, 0);
    assert.equal(session.state.messages.at(-1).content, "实现与验证均已完成。");
  });
}

test("没有伪工具文字但计划未完成时也不能直接完成", async (t) => {
  const sequence = [planResponse("plan", pendingPlan), response("代码已经写好了。"), planResponse("verified", finishedPlan), response("验证通过，交付完成。")];
  const { runtime, requests } = await setup(t, (_, n) => sequence[n - 1]);
  await runtime.runTurn("实现并验证", async () => true);
  assert.equal(requests.length, 4);
  assert.equal(runtime.state.phase, "completed");
  assert.deepEqual(runtime.state.events.find((event) => event.type === "session.completion_rejected").reasons, ["plan_incomplete"]);
});

test("没有计划的真实伪工具输出也会纠正，而不会执行正文中的命令", async (t) => {
  const { runtime, requests } = await setup(t, (_, n) => n === 1 ? captured[1] : response("已通过实际验证，无剩余操作。"));
  await runtime.runTurn("继续检查修复", async () => true);
  assert.equal(requests.length, 2);
  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.metrics.toolCalls, 0);
});

test("持续返回不完整结果最多纠正两次，保留目标与计划供用户继续", async (t) => {
  const { runtime, requests } = await setup(t, (_, n) => n === 1 ? planResponse("plan", pendingPlan) : captured[0]);
  await runtime.runTurn("开发并验证完整游戏", async () => true);
  assert.equal(requests.length, 4);
  assert.equal(runtime.state.phase, "failed");
  assert.equal(runtime.state.objective.status, "paused");
  assert.equal(runtime.state.plan.status, "paused");
  assert.equal(runtime.state.plan.steps[1].status, "in_progress");
  assert.match(runtime.state.lastError, /自动纠正.*2/);
  assert.equal(runtime.state.events.filter((event) => event.type === "session.completion_rejected").length, 2);
});

test("真实阻塞通过 update_plan 明确上报，结束时保留计划且不谎报完成", async (t) => {
  const { runtime, requests } = await setup(t, (_, n) => n === 1
    ? planResponse("blocked", pendingPlan, { blocked_reason: "缺少运行所需的数据文件，需要用户提供路径。" })
    : response("已完成代码，但缺少验证数据，请提供数据文件路径。"));
  await runtime.runTurn("实现并用指定数据验证", async () => true);
  assert.equal(requests.length, 2);
  assert.equal(runtime.state.phase, "failed");
  assert.equal(runtime.state.objective.status, "paused");
  assert.match(runtime.state.lastError, /缺少运行所需的数据文件/);
  assert.equal(runtime.state.events.filter((event) => event.type === "session.completion_rejected").length, 0);
  assert.equal(runtime.state.messages.at(-1).content, "已完成代码，但缺少验证数据，请提供数据文件路径。");
});

test("纠正的额外模型调用遵守累计 Token 预算", async (t) => {
  const { runtime, requests } = await setup(t, () => ({ ...captured[1], usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }), { maxTokensPerTurn: 10 });
  await runtime.runTurn("检查并修复", async () => true);
  assert.equal(requests.length, 1);
  assert.equal(runtime.state.phase, "failed");
  assert.match(runtime.state.lastError, /预算/);
});

test("最后一个允许步骤不能因纠正而越过 maxSteps", async (t) => {
  const { runtime, requests } = await setup(t, () => captured[1], { maxSteps: 1 });
  await runtime.runTurn("检查并修复", async () => true);
  assert.equal(requests.length, 1);
  assert.equal(runtime.state.phase, "failed");
  assert.match(runtime.state.lastError, /最大步骤数/);
});

test("用户在纠正中取消后不再请求模型，也不自动复活任务", async (t) => {
  const { runtime, session, requests } = await setup(t, () => captured[0]);
  const unsubscribe = session.subscribe((state) => {
    if (state.events.at(-1)?.type === "session.completion_rejected") runtime.cancel("用户明确停止");
  });
  t.after(unsubscribe);
  await runtime.runTurn("开发完整游戏", async () => true);
  assert.equal(requests.length, 1);
  assert.equal(runtime.state.phase, "cancelled");
  assert.equal(runtime.state.objective.status, "cancelled");
  assert.equal(runtime.state.lastError, "用户明确停止");
});

test("正常简短回答无需额外调用模型，解释旧日志格式的代码块不会当成新调用", async (t) => {
  const text = "下面是旧日志的格式示例：\n```text\n[历史工具调用；完整参数见 durable journal]\n- run_shell: {}\n```\n这是历史记录，不会执行。";
  const { runtime, requests } = await setup(t, () => response(text));
  await runtime.runTurn("解释这段历史日志的格式", async () => false);
  assert.equal(requests.length, 1);
  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.messages.at(-1).content, text);
});

test("模型没有提供正文或工具时不能显示为成功完成", async (t) => {
  const { runtime, requests } = await setup(t, (_, n) => response(n === 1 ? "  " : "你好。"));
  await runtime.runTurn("你好", async () => false);
  assert.equal(requests.length, 2);
  assert.equal(runtime.state.phase, "completed");
});

test("新格式历史档案被直接复制为答复时仍会纠正", async (t) => {
  const archive = JSON.stringify({ archiveType: "nexus-tool-history", source: "durable journal", recordType: "tool_call", calls: [{ toolName: "run_shell", argumentsExcerpt: "不完整命令" }] });
  const { runtime, requests } = await setup(t, (_, n) => response(n === 1 ? archive : "已完成检查。"));
  await runtime.runTurn("检查当前项目", async () => true);
  assert.equal(requests.length, 2);
  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.metrics.toolCalls, 0);
});

test("纠正失败后的状态追问继续原始目标和计划，成功后新问题不复活旧任务", async (t) => {
  let resumed = false;
  const { runtime, requests } = await setup(t, (request, n) => {
    if (!resumed) return n === 1 ? planResponse("original-plan", pendingPlan) : captured[0];
    assert.match(request.systemPrompt, /原始任务：开发并验证完整小游戏/);
    return n === 5 ? planResponse("resumed-plan", finishedPlan) : response("实现和验证全部完成。");
  });
  await runtime.runTurn("原始任务：开发并验证完整小游戏", async () => true);
  const originalId = runtime.state.objective.id;
  assert.equal(runtime.state.objective.status, "paused");
  resumed = true;
  await runtime.runTurn("现在修复好了吗？", async () => true);
  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.objective.id, originalId);
  assert.equal(runtime.state.objective.text, "原始任务：开发并验证完整小游戏");
  assert.equal(runtime.state.plan.revision, 2);
  assert.equal(requests.length, 6);
  assert.equal(runtime.state.messages.filter((message) => message.role === "user").length, 2);
  assert.ok(runtime.state.events.some((event) => event.type === "objective.continued"));
  runtime.provider.complete = async () => response("你好。");
  await runtime.runTurn("你好", async () => false);
  assert.notEqual(runtime.state.objective.id, originalId);
  assert.equal(runtime.state.objective.text, "你好");
  assert.equal(runtime.state.plan, null);
  assert.equal(runtime.state.phase, "completed");
});

test("用户明确继续真实阻塞时保留原始计划并清除旧阻塞标记", async (t) => {
  const sequence = [
    planResponse("blocked", pendingPlan, { blocked_reason: "需要用户先提供验证文件。" }),
    response("需要提供验证文件。"),
    planResponse("completed", finishedPlan),
    response("文件已提供，验证完成。"),
  ];
  const { runtime, session } = await setup(t, (_, n) => {
    if (n === 3) assert.equal(session.state.plan.blockedReason, undefined);
    return sequence[n - 1];
  });
  await runtime.runTurn("实现并验证项目", async () => true);
  const objectiveId = runtime.state.objective.id;
  assert.equal(runtime.state.phase, "failed");
  await runtime.runTurn("继续吧", async () => true);
  assert.equal(runtime.state.phase, "completed");
  assert.equal(runtime.state.objective.id, objectiveId);
  assert.equal(runtime.state.objective.text, "实现并验证项目");
});

test("仅询问进度不能清掉已知阻塞或触发无效自动纠正", async (t) => {
  const sequence = [
    planResponse("blocked", pendingPlan, { blocked_reason: "验证数据尚未提供。" }),
    response("缺少验证数据，需要先提供。"),
    response("仍在等待验证数据。"),
  ];
  const { runtime, requests } = await setup(t, (_, n) => sequence[n - 1]);
  await runtime.runTurn("实现并使用我的数据验证", async () => true);
  const objectiveId = runtime.state.objective.id;
  await runtime.runTurn("修复好了吗？", async () => true);
  assert.equal(requests.length, 3);
  assert.equal(runtime.state.objective.id, objectiveId);
  assert.equal(runtime.state.plan.blockedReason, "验证数据尚未提供。");
  assert.equal(runtime.state.phase, "failed");
  assert.equal(runtime.state.events.filter((event) => event.type === "session.completion_rejected").length, 0);
});
