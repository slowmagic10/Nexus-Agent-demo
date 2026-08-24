export function createMemoryScope({ workspace, agentId = "default", userId = "local" } = {}) {
  return Object.freeze({
    workspace: requiredIdentity(workspace, "workspace"),
    agentId: requiredIdentity(agentId, "agentId"),
    userId: requiredIdentity(userId, "userId"),
  });
}

export function createLocalMemoryScope(workspace, env = process.env) {
  return createMemoryScope({
    workspace,
    agentId: env.NEXUS_AGENT_ID || "default",
    userId: env.NEXUS_USER_ID || "local",
  });
}

function requiredIdentity(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Memory scope ${label} 必须是非空字符串`);
  return value.trim();
}
