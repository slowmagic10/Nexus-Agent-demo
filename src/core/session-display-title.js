import { redactSensitiveText } from "../security/redact.js";

export const DEFAULT_SESSION_DISPLAY_TITLE = "新任务";
export const PROTECTED_SESSION_DISPLAY_TITLE = "受保护任务";
export const SESSION_DISPLAY_TITLE_MAX_LENGTH = 48;

const NETWORK_ENDPOINT_PATTERN = /(?:\b(?:https?|wss?|ssh|sftp):\/\/[^\s]+|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[\w.-]+@[\w.-]+\b)/iu;
const LABELED_SECRET_PATTERN = /(?:账号|账户|用户名|登录名|密码|口令|服务器|主机|地址|username|user|account|password|passphrase|host|hostname|server|token|api[_ -]?key|secret)\s*(?:是|为|[:=])\s*["']?[^\s"']+/iu;
const ENV_SECRET_PATTERN = /\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|HOME)\s*=\s*\S+/u;

export function normalizeSessionDisplayTitle(value) {
  const compact = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!compact) return null;
  const redacted = redactSensitiveText(compact);
  if (redacted !== compact || redacted.includes("[REDACTED]") || containsSensitiveLocator(compact)) {
    return PROTECTED_SESSION_DISPLAY_TITLE;
  }
  return truncateTitle(redacted);
}

export function deriveSessionDisplayTitle(messages) {
  const firstRequest = Array.isArray(messages)
    ? messages.find((message) => message?.role === "user")?.content
    : null;
  return normalizeSessionDisplayTitle(firstRequest);
}

export function resolveSessionDisplayTitle(state) {
  return normalizeSessionDisplayTitle(state?.displayTitle)
    || deriveSessionDisplayTitle(state?.messages)
    || DEFAULT_SESSION_DISPLAY_TITLE;
}

function containsSensitiveLocator(value) {
  return NETWORK_ENDPOINT_PATTERN.test(value)
    || LABELED_SECRET_PATTERN.test(value)
    || ENV_SECRET_PATTERN.test(value);
}

function truncateTitle(value) {
  if (value.length <= SESSION_DISPLAY_TITLE_MAX_LENGTH) return value;
  return `${value.slice(0, SESSION_DISPLAY_TITLE_MAX_LENGTH).trimEnd()}…`;
}
