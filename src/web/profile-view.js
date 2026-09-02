const FIELD_LABELS = Object.freeze({
  "profile.id": "Profile 身份",
  "provider.name": "Provider",
  "provider.adapter": "Provider Adapter",
  "provider.model": "模型",
  "provider.thinking": "思考模式",
  "provider.endpoint": "模型 Endpoint",
  workspace: "Workspace",
  systemPrompt: "System Prompt",
  toolset: "工具集",
  permission: "权限策略",
  execution: "执行环境",
  memoryScope: "Memory Scope",
  "budgets.maxSteps": "步骤预算",
  "budgets.maxTokensPerTurn": "Token 预算",
});

export function profileDriftViewModel(event) {
  if (event?.type !== "agent.profile_selected" || !Array.isArray(event.changes) || !event.changes.length) return null;
  const labels = [...new Set(event.changes.map((change) => FIELD_LABELS[change.field] || change.field))];
  const highImpact = event.changes.some((change) => change.impact === "high");
  return {
    count: event.changes.length,
    labels,
    highImpact,
    summary: `运行配置已更新：${labels.join("、")}`,
    previousVersion: shortVersion(event.previousProfileVersion),
    currentVersion: shortVersion(event.profileVersion),
  };
}

export function providerThinkingLabel(value) {
  if (value === "enabled") return "思考开";
  if (value === "disabled") return "思考关";
  return "Provider 默认";
}

function shortVersion(value) {
  return typeof value === "string" ? value.slice(0, 12) : "unknown";
}
