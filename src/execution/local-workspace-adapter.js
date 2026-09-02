// FOUNDATION — trusted-local WorkspaceExecution backed by child_process.spawn.
import { realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createExecutionSpec } from "./interface.js";

export const DEFAULT_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "NO_COLOR",
]);

export class WorkspaceExecutionError extends Error {
  constructor(message, { code, result = null } = {}) {
    super(message);
    this.name = "WorkspaceExecutionError";
    this.code = code || "execution_failed";
    this.result = result;
  }
}

export class LocalWorkspaceAdapter {
  constructor({
    workspace,
    environment = process.env,
    environmentAllowlist = DEFAULT_ENVIRONMENT_ALLOWLIST,
    killGraceMs = 500,
  }) {
    if (!Array.isArray(environmentAllowlist) || !environmentAllowlist.every(isEnvironmentName)) {
      throw new Error("environmentAllowlist 必须是合法环境变量名称数组");
    }
    if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1) throw new Error("killGraceMs 必须是正整数");
    this.id = "local-workspace";
    this.workspace = realpathSync(path.resolve(workspace));
    this.environmentAllowlist = Object.freeze([...new Set(environmentAllowlist)].sort());
    this.environment = pickEnvironment(environment, this.environmentAllowlist);
    this.killGraceMs = killGraceMs;
    this.processGroupTermination = process.platform !== "win32";
  }

  inspect() {
    return {
      id: this.id,
      workspace: this.workspace,
      isolation: "trusted-local",
      shell: false,
      processGroupTermination: this.processGroupTermination,
      environmentAllowlist: [...this.environmentAllowlist],
    };
  }

  async execute(spec, { signal, onOutput } = {}) {
    const normalized = createExecutionSpec(spec);
    if (normalized.filesystemMode === "read-only") {
      throw new WorkspaceExecutionError("trusted-local 无法强制 read-only 文件系统；不会静默执行。", {
        code: "execution_isolation_unavailable",
      });
    }
    if (normalized.networkTargets.length) {
      throw new WorkspaceExecutionError("trusted-local 无法强制精确网络目标；不会静默执行网络扩展。", {
        code: "execution_isolation_unavailable",
      });
    }
    if (onOutput !== undefined && typeof onOutput !== "function") throw new Error("WorkspaceExecution onOutput 必须是函数");
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("任务已取消"));
    const cwd = resolveWorkspaceDirectory(this.workspace, normalized.cwd);
    const env = mergeAllowedEnvironment(this.environment, normalized.env, this.environmentAllowlist);
    return await new Promise((resolve, reject) => {
      const started = performance.now();
      const child = spawn(normalized.program, normalized.args, {
        cwd,
        env,
        shell: false,
        detached: this.processGroupTermination,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = createOutputCollector(normalized.maxOutputChars);
      const notifications = createOutputNotifier(onOutput);
      let settled = false;
      let timedOut = false;
      let forceKillTimer = null;
      const killExecution = (signalName) => {
        if (this.processGroupTermination && child.pid) {
          try {
            process.kill(-child.pid, signalName);
            return;
          } catch {}
        }
        child.kill(signalName);
      };
      const requestTermination = () => {
        killExecution("SIGTERM");
        forceKillTimer ||= setTimeout(() => killExecution("SIGKILL"), this.killGraceMs);
        forceKillTimer.unref?.();
      };
      const onAbort = () => requestTermination();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk) => {
        output.append("stdout", chunk);
        notifications.emit({ channel: "stdout", chunk: chunk.toString() });
      });
      child.stderr.on("data", (chunk) => {
        output.append("stderr", chunk);
        notifications.emit({ channel: "stderr", chunk: chunk.toString() });
      });
      const timer = normalized.timeoutMs === null ? null : setTimeout(() => {
        timedOut = true;
        requestTermination();
      }, normalized.timeoutMs);
      timer?.unref?.();

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new WorkspaceExecutionError(`无法启动本机执行：${error.message}`, { code: "spawn_failed" }));
      });
      child.once("close", async (exitCode, closeSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        await notifications.drain();
        const result = {
          executionId: `local-${child.pid || "unknown"}`,
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
          signal: closeSignal || null,
          ...output.result(),
          durationMs: Math.round(performance.now() - started),
        };
        if (signal?.aborted) {
          reject(signal.reason || new WorkspaceExecutionError("本机执行已取消", { code: "cancelled", result }));
          return;
        }
        if (timedOut) {
          reject(new WorkspaceExecutionError(`本机执行超时（${normalized.timeoutMs}ms）`, { code: "timeout", result }));
          return;
        }
        resolve(result);
      });
    });
  }
}

export function resolveWorkspaceDirectory(root, requested) {
  const target = path.resolve(root, requested || ".");
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("执行路径越过了工作区边界");
  const resolved = realpathSync(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("执行目录的符号链接越过了工作区边界");
  return resolved;
}

function pickEnvironment(environment, allowlist) {
  const allowed = new Set(allowlist);
  return Object.fromEntries(Object.entries(environment || {}).filter(([key, value]) => allowed.has(key) && typeof value === "string"));
}

function mergeAllowedEnvironment(base, additions, allowlist) {
  const allowed = new Set(allowlist);
  const denied = Object.keys(additions).find((key) => !allowed.has(key));
  if (denied) throw new Error(`环境变量不在白名单：${denied}`);
  return { ...base, ...additions };
}

function isEnvironmentName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function createOutputCollector(limit) {
  const values = { stdout: "", stderr: "", output: "" };
  const truncated = { stdout: false, stderr: false, output: false };
  return {
    append(channel, chunk) {
      appendValue(values, truncated, channel, chunk.toString(), limit);
      appendValue(values, truncated, "output", chunk.toString(), limit);
    },
    result() {
      return Object.fromEntries(Object.keys(values).map((key) => [key, truncated[key]
        ? `${values[key]}\n…（已截断）`
        : values[key]]));
    },
  };
}

function createOutputNotifier(callback) {
  let tail = Promise.resolve();
  return {
    emit(event) {
      if (!callback) return;
      tail = tail.then(() => callback(event)).catch(() => {});
    },
    async drain() {
      await tail;
    },
  };
}

function appendValue(values, truncated, key, value, limit) {
  const remaining = limit - values[key].length;
  if (remaining <= 0) {
    truncated[key] = true;
    return;
  }
  values[key] += value.slice(0, remaining);
  if (value.length > remaining) truncated[key] = true;
}
