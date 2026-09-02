// FOUNDATION — stable contract between tools and workspace execution adapters.
import { normalizeNetworkTargets } from "./network-target.js";

const EXECUTION_SPEC_KEYS = new Set(["program", "args", "cwd", "env", "timeoutMs", "maxOutputChars", "filesystemMode", "networkTargets"]);
const FILESYSTEM_MODES = new Set(["workspace-write", "read-only"]);

/**
 * @typedef {object} ExecutionSpec
 * @property {string} program
 * @property {readonly string[]} args
 * @property {string} cwd
 * @property {Readonly<Record<string, string>>} env
 * @property {number|null} timeoutMs
 * @property {number} maxOutputChars
 * @property {"workspace-write"|"read-only"} filesystemMode
 * @property {readonly {host: string, port: number}[]} networkTargets
 */

/**
 * WorkspaceExecution context 可选提供 onOutput({channel, chunk})，Adapter 必须按观察顺序发布 stdout/stderr，
 * 并在 execute settle 前等待已发布通知闭合；通知失败不能改变子进程执行结果。
 */

export function createExecutionSpec(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("ExecutionSpec 必须是对象");
  const unknown = Object.keys(input).find((key) => !EXECUTION_SPEC_KEYS.has(key));
  if (unknown) throw new Error(`ExecutionSpec 包含未知字段 ${unknown}`);
  if (typeof input.program !== "string" || !input.program.trim() || input.program.includes("\0")) {
    throw new Error("ExecutionSpec.program 必须是非空且不含 NUL 的字符串");
  }
  const args = input.args || [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
    throw new Error("ExecutionSpec.args 必须是不含 NUL 的字符串数组");
  }
  const cwd = input.cwd ?? ".";
  if (typeof cwd !== "string" || !cwd.trim() || cwd.includes("\0")) throw new Error("ExecutionSpec.cwd 必须是有效字符串");
  const env = input.env || {};
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("ExecutionSpec.env 必须是对象");
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error(`ExecutionSpec.env 包含无效环境变量 ${key}`);
    }
  }
  const timeoutMs = input.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new Error("ExecutionSpec.timeoutMs 必须是正整数或 null");
  }
  const maxOutputChars = input.maxOutputChars ?? 12_000;
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > 1_000_000) {
    throw new Error("ExecutionSpec.maxOutputChars 必须是 1 到 1000000 的整数");
  }
  const filesystemMode = input.filesystemMode ?? "workspace-write";
  if (!FILESYSTEM_MODES.has(filesystemMode)) throw new Error(`ExecutionSpec.filesystemMode 无效：${filesystemMode}`);
  const networkTargets = normalizeNetworkTargets(input.networkTargets || []);
  return Object.freeze({
    program: input.program,
    args: Object.freeze([...args]),
    cwd,
    env: Object.freeze({ ...env }),
    timeoutMs,
    maxOutputChars,
    filesystemMode,
    networkTargets,
  });
}

export function assertWorkspaceExecution(adapter) {
  if (!adapter || typeof adapter.id !== "string" || !adapter.id || typeof adapter.execute !== "function") {
    throw new Error("WorkspaceExecution 必须提供非空 id 和 execute(spec, context)");
  }
  return adapter;
}
