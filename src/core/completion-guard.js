// A model response ending is not evidence that the user's objective is complete.
import { verificationIssues } from "./verification.js";
export const MAX_COMPLETION_CORRECTIONS = 2;

export function completionIssues(state, text) {
  const issues = [];
  if (!String(text || "").trim()) issues.push("empty_response");
  if (state.plan?.objectiveId === state.objective?.id
      && state.plan.steps.some((step) => step.status !== "completed")) {
    issues.push("plan_incomplete");
  }
  if (state.delegations?.some((delegation) => delegation.status === "running")) {
    issues.push("delegation_incomplete");
  }
  const prose = withoutQuotedExamples(String(text || ""));
  const legacyArchive = /^\s*\[(?:历史|本轮较早)工具调用；完整参数见 durable journal\]/m.test(prose)
    && /^\s*-\s*[\w.-]+\s*:\s*\{/m.test(prose);
  const archive = /^\s*\{\s*"archiveType"\s*:\s*"nexus-tool-history"/m.test(prose);
  if (legacyArchive || archive) issues.push("tool_archive_instead_of_call");
  return [...issues, ...verificationIssues(state)];
}

export function completionFeedback(reasons, attempt) {
  const labels = {
    empty_response: "没有提供有效的最终答复或工具调用",
    plan_incomplete: "当前 Plan 仍有 pending/in_progress 步骤",
    delegation_incomplete: "还有未结束的 Child 委派",
    verification_incomplete: "当前 Plan 已声明的验收项缺少与现有文件版本匹配的真实成功结果；请按原 command 运行 run_shell 并提供 verification_id，修正失败后重新验证；不得删改验收项或自报 passed",
    tool_archive_instead_of_call: "正文输出了历史工具档案，但没有发出可执行的工具调用",
  };
  return `[Nexus 运行时完成检查：第 ${attempt}/${MAX_COMPLETION_CORRECTIONS} 次纠正；仅适用于本条检查所在的用户轮次，后续用户消息开始新轮次后失效；不是新的用户任务]\n`
    + reasons.map((reason) => `- ${labels[reason] || reason}`).join("\n")
    + "\n请继续当前 Objective。需要执行操作时必须发出结构化工具调用，不要复制历史档案或把截断参数当成调用。"
    + "使用真实工具完成剩余工作与必要验证后，再通过 update_plan 更新已完成步骤，并给出最终结果；不得为了结束而虚报验证或完成状态。"
    + "如果存在无法自行解决的真实阻塞或必须由用户提供的信息，通过 update_plan 的 blocked_reason 写明具体原因，保留未完成步骤，然后在最终答复说明阻塞。";
}

export class RecoverableTaskError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "RecoverableTaskError";
    this.reason = reason;
  }
}

function withoutQuotedExamples(text) {
  let fence = null;
  return text.split("\n").filter((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return false;
    }
    return !fence && !/^\s*>/.test(line);
  }).join("\n");
}
