const SCOPE_LABELS = Object.freeze({
  once: "仅本次",
  session: "本会话",
  project: "本项目",
});

const ACCESS_LABELS = Object.freeze({
  read: "读取",
  write: "写入",
  execute: "执行",
  network: "联网",
});

export function grantScopeLabel(scope) {
  return SCOPE_LABELS[scope] || "未知范围";
}

export function grantExpiryLabel(expiresAt, now = Date.now()) {
  const remaining = new Date(expiresAt).getTime() - Number(now);
  if (!Number.isFinite(remaining)) return "到期时间未知";
  if (remaining <= 0) return "已过期";
  if (remaining < 60_000) return "不到 1 分钟到期";
  if (remaining < 3_600_000) return `${Math.ceil(remaining / 60_000)} 分钟后到期`;
  if (remaining < 86_400_000) return `${Math.ceil(remaining / 3_600_000)} 小时后到期`;
  return `${Math.ceil(remaining / 86_400_000)} 天后到期`;
}

export function grantResourceLabel(resource = {}) {
  const access = ACCESS_LABELS[resource.access] || resource.access || "访问";
  switch (resource.kind) {
    case "workspace_path":
      return `${access} ${resource.value || "工作区路径"}`;
    case "workspace":
      return `当前工作区 · ${access}`;
    case "shell_command":
      return resource.valueHash
        ? `Shell 命令 · 摘要 ${String(resource.valueHash).slice(0, 12)}`
        : "Shell 命令";
    case "memory_scope":
      return `长期记忆范围 · ${access}`;
    case "mcp_server":
      return `MCP ${resource.value || "服务"} · ${access}`;
    case "session":
      return `当前会话 · ${access}`;
    case "external":
      return `外部资源${resource.value ? ` ${resource.value}` : ""} · ${access}`;
    default:
      return `${resource.kind || "资源"} · ${access}`;
  }
}

export function grantViewModel(grant, { scope = grant?.scope, now = Date.now() } = {}) {
  return {
    id: String(grant?.id || ""),
    scope,
    scopeLabel: grantScopeLabel(scope),
    tool: String(grant?.tool || "unknown"),
    resources: Array.isArray(grant?.resources) ? grant.resources.map(grantResourceLabel) : [],
    issuedAt: grant?.issuedAt || null,
    expiresAt: grant?.expiresAt || null,
    expiryLabel: grantExpiryLabel(grant?.expiresAt, now),
  };
}
