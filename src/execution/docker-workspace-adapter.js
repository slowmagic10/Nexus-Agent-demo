// FOUNDATION — explicitly enabled local Docker WorkspaceExecution with a fixed security envelope.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createExecutionSpec } from "./interface.js";
import {
  DEFAULT_ENVIRONMENT_ALLOWLIST,
  LocalWorkspaceAdapter,
  resolveWorkspaceDirectory,
  WorkspaceExecutionError,
} from "./local-workspace-adapter.js";
import { normalizeDockerImage } from "./docker-options.js";

const CONTAINER_WORKSPACE = "/workspace";
const CLEANUP_TIMEOUT_MS = 5_000;

export class DockerWorkspaceAdapter {
  constructor({
    workspace,
    image,
    controlExecution = null,
    environment = process.env,
    dockerBinary = "docker",
    cpus = 1,
    memory = "1g",
    pidsLimit = 128,
    containerEnvironmentAllowlist = [],
  }) {
    if (typeof dockerBinary !== "string" || !dockerBinary.trim() || dockerBinary.includes("\0")) {
      throw new Error("dockerBinary 必须是有效字符串");
    }
    if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64) throw new Error("cpus 必须是 0 到 64 之间的数字");
    if (typeof memory !== "string" || !/^[1-9][0-9]*(?:[bkmg])?$/i.test(memory)) {
      throw new Error("memory 必须是 Docker 支持的正整数容量");
    }
    if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 1 || pidsLimit > 32_768) {
      throw new Error("pidsLimit 必须是 1 到 32768 的整数");
    }
    if (!Array.isArray(containerEnvironmentAllowlist) || !containerEnvironmentAllowlist.every(isEnvironmentName)) {
      throw new Error("containerEnvironmentAllowlist 必须是合法环境变量名称数组");
    }

    this.id = "docker-workspace";
    this.image = normalizeDockerImage(image);
    const workspaceBoundary = new LocalWorkspaceAdapter({ workspace, environment: {} });
    this.controlExecution = controlExecution || new LocalWorkspaceAdapter({
      workspace,
      environment,
      environmentAllowlist: DEFAULT_ENVIRONMENT_ALLOWLIST,
    });
    this.workspace = workspaceBoundary.workspace;
    if (this.workspace.includes(",") || this.workspace.includes("\n") || this.workspace.includes("\r")) {
      throw new Error("Docker workspace 路径不能包含逗号或换行符");
    }
    this.dockerBinary = dockerBinary.trim();
    this.cpus = cpus;
    this.memory = memory.toLowerCase();
    this.pidsLimit = pidsLimit;
    this.containerEnvironmentAllowlist = Object.freeze([...new Set(containerEnvironmentAllowlist)].sort());
    const hostUid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const hostGid = typeof process.getgid === "function" ? process.getgid() : 1000;
    this.uid = hostUid === 0 ? 65_534 : hostUid;
    this.gid = hostGid === 0 ? 65_534 : hostGid;
  }

  inspect() {
    return {
      id: this.id,
      workspace: this.workspace,
      isolation: "docker-local",
      image: this.image,
      pull: "never",
      network: "none",
      rootFilesystem: "read-only",
      user: `${this.uid}:${this.gid}`,
      resources: { cpus: this.cpus, memory: this.memory, pidsLimit: this.pidsLimit },
      environmentAllowlist: [...this.containerEnvironmentAllowlist],
    };
  }

  async execute(spec, { signal } = {}) {
    const normalized = createExecutionSpec(spec);
    if (normalized.networkTargets.length) {
      throw new WorkspaceExecutionError("Docker Adapter 尚未实现精确网络目标扩展；不会静默改用 unrestricted 网络。", {
        code: "execution_isolation_unavailable",
      });
    }
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("任务已取消"));
    const hostCwd = resolveWorkspaceDirectory(this.workspace, normalized.cwd);
    const containerCwd = toContainerPath(this.workspace, hostCwd);
    const containerEnvironment = selectContainerEnvironment(normalized.env, this.containerEnvironmentAllowlist);
    const containerName = `nexus-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const args = buildDockerRunArgs({
      containerName,
      workspace: this.workspace,
      containerCwd,
      image: this.image,
      uid: this.uid,
      gid: this.gid,
      cpus: this.cpus,
      memory: this.memory,
      pidsLimit: this.pidsLimit,
      environment: containerEnvironment,
      command: [normalized.program, ...normalized.args],
      filesystemMode: normalized.filesystemMode,
    });

    try {
      const result = await this.controlExecution.execute(createExecutionSpec({
        program: this.dockerBinary,
        args,
        cwd: ".",
        timeoutMs: normalized.timeoutMs,
        maxOutputChars: normalized.maxOutputChars,
      }), { signal });
      const mapped = { ...result, executionId: `docker:${containerName}` };
      if (result.exitCode !== 0) {
        throw new WorkspaceExecutionError(`Docker 容器执行失败（退出码 ${result.exitCode}）`, {
          code: "container_failed",
          result: mapped,
        });
      }
      return mapped;
    } catch (error) {
      await this.cleanupContainer(containerName);
      if (error?.code === "spawn_failed") {
        throw new WorkspaceExecutionError("Docker CLI 不可用；请安装 Docker 并确认 docker 位于 PATH。不会降级到本机执行。", {
          code: "docker_unavailable",
        });
      }
      throw error;
    }
  }

  async cleanupContainer(containerName) {
    try {
      await this.controlExecution.execute(createExecutionSpec({
        program: this.dockerBinary,
        args: ["--context=default", "rm", "-f", containerName],
        cwd: ".",
        timeoutMs: CLEANUP_TIMEOUT_MS,
        maxOutputChars: 2_000,
      }), { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
    } catch {
      // Best effort only: caller retains the original execution failure/unknown semantics.
    }
  }
}

export function buildDockerRunArgs({
  containerName,
  workspace,
  containerCwd,
  image,
  uid,
  gid,
  cpus,
  memory,
  pidsLimit,
  environment,
  command,
  filesystemMode = "workspace-write",
}) {
  return [
    "--context=default",
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--cpus=${cpus}`,
    `--memory=${memory}`,
    `--pids-limit=${pidsLimit}`,
    `--user=${uid}:${gid}`,
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m",
    `--mount=type=bind,src=${workspace},dst=${CONTAINER_WORKSPACE}${filesystemMode === "read-only" ? ",readonly" : ""}`,
    `--workdir=${containerCwd}`,
    `--name=${containerName}`,
    ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    image,
    ...command,
  ];
}

function toContainerPath(workspace, hostCwd) {
  const relative = path.relative(workspace, hostCwd);
  return relative ? path.posix.join(CONTAINER_WORKSPACE, ...relative.split(path.sep)) : CONTAINER_WORKSPACE;
}

function selectContainerEnvironment(environment, allowlist) {
  const allowed = new Set(allowlist);
  const denied = Object.keys(environment).find((key) => !allowed.has(key));
  if (denied) throw new Error(`容器环境变量不在白名单：${denied}`);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key)));
}

function isEnvironmentName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
