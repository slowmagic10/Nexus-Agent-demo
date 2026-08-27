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
    delegations: Array.isArray(delegations) ? delegations.map((delegation) => ({
      objective: delegation.objective,
      childSessionId: delegation.childSessionId,
      status: delegation.status,
      statusLabel: STATUS_LABELS[delegation.status] || delegation.status,
      marker: DELEGATION_MARKERS[delegation.status] || "·",
    })) : [],
  };
}
