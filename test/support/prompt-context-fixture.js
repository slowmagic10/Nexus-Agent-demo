import { createSession } from "../../src/core/state.js";
import { progressFeedback } from "../../src/core/progress-feedback.js";

export function promptContextFixture(turns = 8, { opaque = false } = {}) {
  const state = createSession({ provider: "synthetic-prompt-context", workspace: "/tmp/synthetic-prompt-context",
    id: "synthetic-prompt-context", createdAt: "2026-09-10T02:00:00.000Z" });
  const toolRound = (id) => [
    { role: "assistant", content: "读取相关事实", tool_calls: [{ id, type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: `${id}.txt`, note: "来源说明".repeat(60) }) } }],
      ...(opaque ? { provider_items: [{ encrypted_content: "SYNTHETIC_OPAQUE_STATE|".repeat(40) }] } : {}) },
    { role: "tool", tool_call_id: id, content: "离线工具结果中文ABC".repeat(160) },
  ];
  for (let index = 0; index < turns; index++) {
    state.messages.push({ role: "user", content: `历史请求 ${index} ${"历史事实".repeat(30)}` },
      ...toolRound(`historical-${index}`), { role: "assistant", content: `已完成历史请求 ${index}` });
  }
  state.messages.push({ role: "user", content: "继续当前任务，不启动服务" },
    ...toolRound("active-1"), ...toolRound("active-2"), ...toolRound("active-3"),
    { role: "system", runtime_feedback: "progress", content: progressFeedback(1) });
  state.memory = [{ content: "本项目使用离线验证" }];
  state.contextMemory = [
    { id: "pinned", content: "不要启动服务", pinned: true, scope: { workspace: state.workspace },
      contextBudgetTokens: 1000, contextEstimatedTokens: 8, contextEstimatorVersion: "fixture-v1" },
    { id: "relevant", content: "保留当前修改", pinned: false, scope: { workspace: state.workspace } },
  ];
  state.contextSummary = { revision: 2, objective: "继续当前任务", completed: ["已核对历史事实"],
    active: [], decisions: [], files: [], blockers: [], nextMoves: ["离线验证"],
    sourceComplete: false, throughMessage: turns * 4, sourceCursor: 1 };
  state.objective = { status: "active", text: "改进 Harness" };
  state.plan = { steps: [{ status: "in_progress", step: "完成必要验证" }], blockedReason: "",
    acceptance: [{ id: "offline", status: "pending", description: "离线回归", command: "node --test",
      paths: ["test/example.test.js"] }] };
  state.delegations = [{ status: "completed", objective: "核对旧数据", childSessionId: "synthetic-child" }];
  state.loadedSkills = [{ name: "offline", content: "只在临时目录内验证", metadata: { revision: 1 } }];
  const tools = [{ type: "function", function: { name: "read_file", description: "读取文件",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
  return { state, tools };
}
