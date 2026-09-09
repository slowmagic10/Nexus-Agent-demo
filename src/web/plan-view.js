const STATUS_LABELS = {
  active: "进行中",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

const STEP_MARKERS = {
  pending: "·",
  in_progress: "→",
  completed: "✓",
};

const DELEGATION_MARKERS = {
  running: "→",
  completed: "✓",
  failed: "×",
  cancelled: "×",
  interrupted: "!",
};

const VERIFICATION_REASONS = {
  inputs_changed: "关联文件已修改，需要重新验证",
  inputs_changed_during_command: "验证期间输入文件发生变化，需要重新验证",
  inputs_changed_or_unavailable: "输入文件已变化或不可读取",
  command_failed: "验收命令未通过",
  command_or_input_failed: "验收命令失败或输入文件不可读取",
  cancelled: "本次验证已取消",
  missing_tool_result: "缺少对应的成功执行记录",
  verification_reader_unavailable: "当前执行环境无法复查验收输入",
};

export function objectivePlanViewModel(objective, plan, delegations = []) {
  if (!objective?.text) return null;
  const status = objective.status || "active";
  return {
    objective: objective.text,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    explanation: plan?.explanation || "",
    revision: plan?.revision || 0,
    steps: Array.isArray(plan?.steps) ? plan.steps.map((step) => ({
      step: step.step,
      status: step.status,
      marker: STEP_MARKERS[step.status] || "·",
    })) : [],
    ...(plan?.acceptance?.length ? { acceptance: plan.acceptance.map((item) => ({
      id: item.id,
      description: item.description,
      command: item.command,
      status: item.status,
      label: { pending: "待验证", passed: "已验证", failed: "验证失败", stale: "需要重新验证" }[item.status] || "待验证",
      reason: VERIFICATION_REASONS[item.reason] || item.reason || "",
      paths: Array.isArray(item.paths) ? [...item.paths] : [],
    })) } : {}),
    delegations: Array.isArray(delegations) ? delegations.map((delegation) => ({
      objective: delegation.objective,
      childSessionId: delegation.childSessionId,
      status: delegation.status,
      statusLabel: STATUS_LABELS[delegation.status] || delegation.status,
      marker: DELEGATION_MARKERS[delegation.status] || "·",
    })) : [],
  };
}
