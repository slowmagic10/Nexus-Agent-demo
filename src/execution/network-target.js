// FOUNDATION — canonical exact TCP targets shared by config, policy and sandbox execution.
import { isIP } from "node:net";

export function normalizeNetworkTarget(input) {
  let host;
  let port;
  if (typeof input === "string") {
    const match = input.trim().match(/^([^:]+):([0-9]{1,5})$/);
    if (!match) throw new Error(`网络目标必须使用 IPv4:port：${input}`);
    [, host, port] = match;
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    ({ host, port } = input);
  } else {
    throw new Error("网络目标必须是 IPv4:port 字符串或 { host, port }");
  }
  host = String(host || "").trim();
  port = typeof port === "number" ? port : Number(port);
  if (isIP(host) !== 4) throw new Error(`网络目标首版只接受 IPv4 字面量：${host || "未指定"}`);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`网络目标端口无效：${port}`);
  return Object.freeze({ host, port });
}

export function normalizeNetworkTargets(values = []) {
  if (!Array.isArray(values)) throw new Error("network.targets 必须是数组");
  const unique = new Map(values.map((value) => {
    const target = normalizeNetworkTarget(value);
    return [`${target.host}:${target.port}`, target];
  }));
  return Object.freeze([...unique.values()].sort((left, right) => (
    left.host === right.host ? left.port - right.port : left.host < right.host ? -1 : 1
  )));
}

export function formatNetworkTarget(target) {
  const normalized = normalizeNetworkTarget(target);
  return `${normalized.host}:${normalized.port}`;
}

export function resolveShellNetworkTargets(command, allowlist = []) {
  const targets = normalizeNetworkTargets(allowlist);
  const source = String(command || "");
  const sshPort = source.match(/\b(?:ssh|scp|sftp)\b[^;&|\n]*?\s-(?:p|P)\s*([0-9]{1,5})(?:\s|$)/i)?.[1];
  const mentions = [];
  for (const match of source.matchAll(/(?<![0-9.])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?::([0-9]{1,5}))?(?![0-9.])/g)) {
    const host = match[1];
    if (isIP(host) !== 4) {
      mentions.push({ host, port: match[2] ? Number(match[2]) : null, invalid: true });
      continue;
    }
    mentions.push({ host, port: match[2] ? Number(match[2]) : sshPort ? Number(sshPort) : null, invalid: false });
  }

  const allowed = new Map();
  const denied = new Set();
  for (const mention of mentions) {
    const candidates = targets.filter((target) => target.host === mention.host);
    const matched = mention.invalid
      ? null
      : mention.port
        ? candidates.find((target) => target.port === mention.port)
        : candidates.length === 1 ? candidates[0] : null;
    if (matched) allowed.set(formatNetworkTarget(matched), matched);
    else denied.add(`${mention.host}:${mention.port || "*"}`);
  }
  return Object.freeze({
    allowed: Object.freeze([...allowed.values()]),
    denied: Object.freeze([...denied]),
    hasMentions: mentions.length > 0,
  });
}
