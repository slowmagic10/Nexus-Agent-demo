const STATUS_LABELS = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const STEP_MARKERS = {
  pending: "·",
  in_progress: "→",
  completed: "✓",
};

export function objectivePlanViewModel(objective, plan) {
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
  };
}
