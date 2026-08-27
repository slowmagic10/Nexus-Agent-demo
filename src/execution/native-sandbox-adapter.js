// FOUNDATION — OS-native WorkspaceExecution; macOS uses inherited Seatbelt restrictions.
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExecutionSpec } from "./interface.js";
import { normalizeNetworkTargets } from "./network-target.js";
import {
  DEFAULT_ENVIRONMENT_ALLOWLIST,
  LocalWorkspaceAdapter,
  WorkspaceExecutionError,
} from "./local-workspace-adapter.js";

const MACOS_SANDBOX_BINARY = "/usr/bin/sandbox-exec";

export class NativeSandboxAdapter {
  constructor({
    workspace,
    environment = process.env,
    controlExecution = null,
    platform = process.platform,
    sandboxBinary = MACOS_SANDBOX_BINARY,
    temporaryDirectories = defaultTemporaryDirectories(),
    homeDirectory = os.homedir(),
  }) {
    if (platform !== "darwin") {
      throw new WorkspaceExecutionError(`当前平台 ${platform} 尚未实现 Native Sandbox；不会降级到本机执行。`, {
        code: "native_sandbox_unavailable",
      });
    }
    if (typeof sandboxBinary !== "string" || !sandboxBinary.trim() || sandboxBinary.includes("\0")) {
      throw new Error("sandboxBinary 必须是有效字符串");
    }
    if (!controlExecution && !existsSync(sandboxBinary)) {
      throw new WorkspaceExecutionError("macOS sandbox-exec 不可用；不会降级到本机执行。", {
        code: "native_sandbox_unavailable",
      });
    }
    if (!Array.isArray(temporaryDirectories) || !temporaryDirectories.every((value) => typeof value === "string" && value)) {
      throw new Error("temporaryDirectories 必须是非空路径数组");
    }
    if (typeof homeDirectory !== "string" || !path.isAbsolute(homeDirectory) || homeDirectory.includes("\0")) {
      throw new Error("homeDirectory 必须是有效绝对路径");
    }
    const workspaceBoundary = new LocalWorkspaceAdapter({ workspace, environment: {} });
    this.id = "native-sandbox";
    this.platform = platform;
    this.workspace = workspaceBoundary.workspace;
    this.sandboxBinary = sandboxBinary.trim();
    this.temporaryDirectories = Object.freeze(uniqueCanonicalPaths(temporaryDirectories));
    this.homeDirectory = canonicalPath(homeDirectory);
    this.protectedPaths = macOsProtectedPaths(this.workspace, this.homeDirectory);
    this.profile = createMacOsSeatbeltProfile({
      workspace: this.workspace,
      temporaryDirectories: this.temporaryDirectories,
      homeDirectory: this.homeDirectory,
    });
    this.controlExecution = controlExecution || new LocalWorkspaceAdapter({
      workspace: this.workspace,
      environment,
      environmentAllowlist: DEFAULT_ENVIRONMENT_ALLOWLIST,
    });
  }

  inspect() {
    return {
      id: this.id,
      platform: this.platform,
      isolation: "macos-seatbelt",
      workspace: this.workspace,
      filesystem: {
        read: "host-readable-minus-protected",
        write: [this.workspace, ...this.temporaryDirectories],
        readDenied: [...this.protectedPaths.read],
        writeDenied: [...this.protectedPaths.write],
        deniedPatterns: ["**/.env*"],
        modes: ["workspace-write", "read-only"],
      },
      network: "deny",
      networkExpansion: "exact-ip-tcp-per-execution",
      unixSockets: "deny",
      processTreeInheritance: true,
      environmentAllowlist: [...(this.controlExecution.inspect?.().environmentAllowlist || [])],
    };
  }

  async execute(spec, { signal } = {}) {
    const normalized = createExecutionSpec(spec);
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("任务已取消"));
    let result;
    try {
      const profile = normalized.filesystemMode === "read-only"
        ? createMacOsSeatbeltProfile({
            workspace: this.workspace,
            temporaryDirectories: this.temporaryDirectories,
            homeDirectory: this.homeDirectory,
            filesystemMode: "read-only",
            networkTargets: normalized.networkTargets,
          })
        : normalized.networkTargets.length
          ? createMacOsSeatbeltProfile({
              workspace: this.workspace,
              temporaryDirectories: this.temporaryDirectories,
              homeDirectory: this.homeDirectory,
              networkTargets: normalized.networkTargets,
            })
          : this.profile;
      result = await this.controlExecution.execute(createExecutionSpec({
        program: this.sandboxBinary,
        args: ["-p", profile, "--", normalized.program, ...normalized.args],
        cwd: normalized.cwd,
        env: normalized.env,
        timeoutMs: normalized.timeoutMs,
        maxOutputChars: normalized.maxOutputChars,
      }), { signal });
    } catch (error) {
      if (error?.code === "spawn_failed") {
        throw new WorkspaceExecutionError("macOS sandbox-exec 不可用；不会降级到本机执行。", {
          code: "native_sandbox_unavailable",
        });
      }
      throw error;
    }
    if (/(^|\n)sandbox-exec:|sandbox_apply:/i.test(`${result.stderr || ""}\n${result.stdout || ""}`)) {
      throw new WorkspaceExecutionError("macOS Seatbelt 无法应用安全策略；不会降级到本机执行。", {
        code: "native_sandbox_unavailable",
        result: { ...result, executionId: `native:${result.executionId}` },
      });
    }
    return { ...result, executionId: `native:${result.executionId}` };
  }
}

export function createMacOsSeatbeltProfile({ workspace, temporaryDirectories = [], homeDirectory = os.homedir(), filesystemMode = "workspace-write", networkTargets = [] }) {
  if (!["workspace-write", "read-only"].includes(filesystemMode)) throw new Error(`Seatbelt filesystemMode 无效：${filesystemMode}`);
  networkTargets = normalizeNetworkTargets(networkTargets);
  const writablePaths = uniqueCanonicalPaths(filesystemMode === "read-only" ? temporaryDirectories : [workspace, ...temporaryDirectories]);
  const writeRules = writablePaths.map((value) => `(subpath ${JSON.stringify(value)})`).join(" ");
  const protectedPaths = macOsProtectedPaths(workspace, canonicalPath(homeDirectory));
  const environmentFilePattern = `(regex #"/\\.env([^/]*)$")`;
  const protectedReadRules = [
    ...protectedPaths.credentialDirectories.map((value) => `(subpath ${JSON.stringify(value)})`),
    ...protectedPaths.credentialFiles.map((value) => `(literal ${JSON.stringify(value)})`),
    ...protectedPaths.environmentFiles.map((value) => `(literal ${JSON.stringify(value)})`),
    environmentFilePattern,
  ];
  const protectedWriteRules = [
    ...protectedPaths.credentialDirectories.map((value) => `(subpath ${JSON.stringify(value)})`),
    ...protectedPaths.credentialFiles.map((value) => `(literal ${JSON.stringify(value)})`),
    ...protectedPaths.environmentFiles.map((value) => `(literal ${JSON.stringify(value)})`),
    environmentFilePattern,
  ];
  const networkRules = networkTargets.map((target) => (
    `(allow network-outbound (remote tcp ${JSON.stringify(`${target.host}:${target.port}`)}))`
  ));
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow user-preference-read)",
    "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\") (global-name \"com.apple.PowerManagement.control\"))",
    "(allow ipc-posix-sem)",
    "(allow file-read*)",
    "(allow file-write-data (literal \"/dev/null\"))",
    ...(writeRules ? [`(allow file-write* ${writeRules})`] : []),
    `(deny file-read* ${protectedReadRules.join(" ")})`,
    `(deny file-write* ${protectedWriteRules.join(" ")})`,
    ...(networkRules.length ? ["(deny network-inbound)", "(deny network-bind)", ...networkRules] : ["(deny network*)"]),
  ].join(" ");
}

function macOsProtectedPaths(workspace, homeDirectory) {
  const environmentFiles = [
    path.join(workspace, ".env"),
    path.join(workspace, ".env.local"),
    path.join(workspace, ".env.deepseek.local"),
  ];
  const credentialDirectoryNames = [
    ".ssh",
    ".aws",
    ".azure",
    ".kube",
    ".gnupg",
    ".password-store",
    ".docker",
    ".codex",
    ".claude",
    ".gemini",
    ".nexus",
    path.join(".config", "gcloud"),
    path.join(".config", "gh"),
    path.join(".config", "glab-cli"),
    path.join(".config", "op"),
    path.join("Library", "Keychains"),
  ];
  const workspaceCredentialDirectoryNames = [".ssh", ".aws", ".azure", ".kube", ".gnupg", ".password-store", ".docker"];
  const credentialDirectories = [
    ...credentialDirectoryNames.map((value) => path.join(homeDirectory, value)),
    ...workspaceCredentialDirectoryNames.map((value) => path.join(workspace, value)),
  ];
  const credentialFileNames = [
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    path.join(".cargo", "credentials"),
    path.join(".cargo", "credentials.toml"),
    path.join(".terraform.d", "credentials.tfrc.json"),
  ];
  const workspaceCredentialFileNames = [".npmrc", ".pypirc", ".netrc", ".git-credentials", path.join(".nexus", "config.local.json")];
  const credentialFiles = [
    ...credentialFileNames.map((value) => path.join(homeDirectory, value)),
    ...workspaceCredentialFileNames.map((value) => path.join(workspace, value)),
  ];
  const read = [...environmentFiles, ...credentialDirectories, ...credentialFiles];
  return Object.freeze({
    read: Object.freeze(read),
    write: Object.freeze([...read]),
    environmentFiles: Object.freeze(environmentFiles),
    credentialDirectories: Object.freeze(credentialDirectories),
    credentialFiles: Object.freeze(credentialFiles),
  });
}

function defaultTemporaryDirectories() {
  return [os.tmpdir(), "/private/tmp", "/private/var/tmp"];
}

function uniqueCanonicalPaths(values) {
  return [...new Set(values.map(canonicalPath))].sort();
}

function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
