// FOUNDATION — separates risk, sandbox containment and automatic approval decisions.
import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeNetworkTargets, resolveShellNetworkTargets } from "../execution/network-target.js";

const PROFILE_NAMES = new Set(["read-only", "workspace-auto", "workspace-confirm", "workspace-untrusted", "approval-required", "danger-full-access"]);
const SANDBOXED_EXECUTIONS = new Set(["native", "docker"]);
const USER_CONFIRM_SCOPES = Object.freeze(["once", "session"]);
const AUTO_WORKSPACE_EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);

export class PermissionProfile {
  constructor({ name = "approval-required", workspace, executionType = "local", networkTargets = [] } = {}) {
    if (!PROFILE_NAMES.has(name)) throw new Error(`Permission Profile 不支持：${name}`);
    if (typeof workspace !== "string" || !workspace) throw new Error("Permission Profile 需要 workspace");
    if (!new Set(["native", "local", "docker"]).has(executionType)) throw new Error(`Permission Profile executionType 无效：${executionType}`);
    if (name === "danger-full-access" && executionType !== "local") {
      throw new Error("danger-full-access 只能与显式 trusted-local 执行环境一起使用");
    }
    this.name = name;
    this.workspace = path.resolve(workspace);
    this.executionType = executionType;
    this.networkTargets = normalizeNetworkTargets(networkTargets);
    this.version = hashValue({ schemaVersion: 7, name, workspace: this.workspace, executionType, networkTargets: this.networkTargets });
  }

  inspect() {
    return {
      name: this.name,
      version: this.version,
      executionType: this.executionType,
      workspace: this.workspace,
      networkTargets: [...this.networkTargets],
      protectedPaths: this.name === "danger-full-access" ? { read: [], write: [], approvalWrite: [], shell: [] } : {
          read: ["**/.env*"],
          write: ["**/.env*"],
          approvalWrite: [".git/**", ".agents/**", ".codex/**", ".nexus/**"],
          shell: ["~/**", "$HOME/**", "${HOME}/**"],
        },
    };
  }

  authorize({ definition, call, resources }) {
    if (this.name === "danger-full-access") {
      return profileDecision(this, "allow", "trusted_local_full_access", "用户已明确启用 trusted-local 完全访问", "danger_full_access", {
        action: definition.name,
        resource: call?.arguments?.command ? summarizeCommand(call.arguments.command) : definition.name,
      });
    }
    const pathDecisions = resources
      .filter((resource) => resource.kind === "workspace_path")
      .map((resource) => this.pathDecision(resource.value, resource.access || (definition.capability.readOnly ? "read" : "write")));
    const deniedPath = pathDecisions.find((result) => result.decision === "deny");
    if (deniedPath) return deniedPath;
    const approvalPath = pathDecisions.find((result) => result.decision === "approval_required");
    if (approvalPath) return approvalPath;

    const capability = definition.capability;
    if (capability.risk === "R3" || capability.effects.includes("credential")) {
      return profileDecision(this, "deny", "credential_deny", "Permission Profile 拒绝凭据或 R3 能力", "credential");
    }
    if (isInternalStateCapability(capability)) {
      return profileDecision(this, "allow", "internal_state", "Objective/Plan 等 Session 内部状态更新不触发外部副作用", "internal_state");
    }
    if (definition.name === "run_shell") return this.classifyShell(call.arguments.command);
    if (this.name === "read-only") return this.#readOnly(definition, call);
    if (this.name === "workspace-auto") return this.#workspaceAuto(definition, call, resources);
    if (this.name === "workspace-untrusted") return this.#workspaceUntrusted(definition, call, resources);
    if (this.name === "workspace-confirm") return this.#workspaceConfirm(definition);
    if (capability.readOnly && !capability.effects.some(isElevatedEffect)) {
      return profileDecision(this, "allow", "safe_read", "Permission Profile 允许安全只读能力", "read");
    }
    return profileDecision(this, "approval_required", "elevated_approval", "Permission Profile 要求审批非只读能力", "elevated");
  }

  canExpose(definition) {
    if (this.name === "danger-full-access") return true;
    if (this.name === "read-only") {
      if (definition.name === "run_shell") return SANDBOXED_EXECUTIONS.has(this.executionType);
      return isInternalStateCapability(definition.capability)
        || (definition.capability.readOnly && !definition.capability.effects.some(isElevatedEffect));
    }
    return definition.capability.risk !== "R3" && !definition.capability.effects.includes("credential");
  }

  pathDecision(relativePath, access) {
    const normalized = normalizeRelativePath(relativePath);
    if (this.name === "danger-full-access") {
      return profileDecision(this, "allow", "trusted_local_path", `完全访问允许 ${normalized}`, "danger_full_access", {
        action: access,
        resource: normalized,
      });
    }
    if (this.name === "read-only" && access !== "read") {
      return profileDecision(this, "deny", "mutation_deny", `read-only 拒绝写入工作区路径 ${normalized}`, "read_only_mutation", {
        action: access,
        resource: normalized,
      });
    }
    const segments = normalized === "." ? [] : normalized.split(path.sep);
    const hasEnvironmentFile = segments.some(isEnvironmentFilename);
    const hasCredentialPath = segments.some(isCredentialPathSegment) || isLocalSecretConfig(segments);
    const root = segments[0] || null;
    const readDenied = hasEnvironmentFile || hasCredentialPath;
    const writeDenied = hasEnvironmentFile || hasCredentialPath;
    if ((access === "read" && readDenied) || (access !== "read" && writeDenied)) {
      return profileDecision(
        this,
        "deny",
        `protected_${access === "read" ? "read" : "write"}`,
        `Permission Profile 拒绝${access === "read" ? "读取" : "写入"}受保护路径 ${normalized}`,
        "protected_path",
        { action: access, resource: normalized },
      );
    }
    if (access !== "read" && [".git", ".agents", ".codex", ".nexus"].includes(root)) {
      return profileDecision(
        this,
        "approval_required",
        "workspace_metadata_write_approval",
        `写入工作区控制目录 ${normalized} 需要用户确认`,
        "workspace_metadata_write",
        { action: access, resource: normalized, approvalScopes: USER_CONFIRM_SCOPES },
      );
    }
    return profileDecision(this, "allow", `workspace_${access}`, `路径 ${normalized} 位于允许的工作区范围`, "workspace_path", {
      action: access,
      resource: normalized,
    });
  }

  assertPath(relativePath, access) {
    const result = this.pathDecision(relativePath, access);
    if (result.decision === "deny") {
      const error = new Error(result.reason);
      error.code = "permission_profile_denied";
      error.authorization = result;
      throw error;
    }
    return result;
  }

  canAccessPath(relativePath, access = "read") {
    return this.pathDecision(relativePath, access).decision !== "deny";
  }

  classifyShell(command) {
    if (this.name === "danger-full-access") {
      if (typeof command !== "string" || !command.trim()) throw new Error("Shell command 必须是非空字符串");
      return profileDecision(this, "allow", "trusted_local_shell", "用户已明确允许 trusted-local Shell 完全访问", "danger_full_access", {
        action: "shell",
        resource: summarizeCommand(command.trim()),
      });
    }
    return classifyShellCommand(command, { profile: this, executionType: this.executionType, networkTargets: this.networkTargets });
  }

  networkTargetsForShell(command) {
    const decision = this.classifyShell(command);
    return decision.explanation?.category === "trusted_network_target"
      ? decision.explanation.networkTargets || []
      : [];
  }

  #workspaceAuto(definition, call, resources) {
    const capability = definition.capability;
    if (capability.readOnly && !capability.effects.some(isElevatedEffect)) {
      return profileDecision(this, "allow", "safe_read", "workspace-auto 允许普通工作区只读能力", "read");
    }
    if (AUTO_WORKSPACE_EDIT_TOOLS.has(definition.name) && resources.some((resource) => resource.kind === "workspace_path" && resource.access === "write")) {
      return profileDecision(this, "allow", "workspace_write", "workspace-auto 自动允许普通工作区文件编辑", "workspace_write");
    }
    if (definition.name === "run_shell") return this.classifyShell(call.arguments.command);
    if (capability.effects.includes("network")) {
      return profileDecision(this, "approval_required", "network_approval", "workspace-auto 的网络能力需要审批，且不会自动扩展沙箱网络", "network");
    }
    return profileDecision(this, "approval_required", "elevated_approval", "workspace-auto 仍要求审批记忆、MCP 或其他非只读能力", "elevated");
  }

  #readOnly(definition, call) {
    const capability = definition.capability;
    if (definition.name === "run_shell") return this.classifyShell(call.arguments.command);
    if (capability.readOnly && !capability.effects.some(isElevatedEffect)) {
      return profileDecision(this, "allow", "safe_read", "read-only 允许工作区与会话只读能力", "read");
    }
    return profileDecision(this, "deny", "mutation_deny", "read-only 拒绝写入、执行、网络或其他非只读能力", "read_only_mutation");
  }

  #workspaceUntrusted(definition, call, resources) {
    const capability = definition.capability;
    if (capability.readOnly && !capability.effects.some(isElevatedEffect)) {
      return profileDecision(this, "allow", "safe_read", "workspace-untrusted 允许普通工作区只读能力", "read");
    }
    if (AUTO_WORKSPACE_EDIT_TOOLS.has(definition.name) && resources.some((resource) => resource.kind === "workspace_path" && resource.access === "write")) {
      return profileDecision(this, "allow", "workspace_write", "workspace-untrusted 自动允许普通工作区文件编辑", "workspace_write");
    }
    if (definition.name === "run_shell") return this.classifyShell(call.arguments.command);
    if (capability.effects.includes("network")) {
      return profileDecision(this, "approval_required", "network_approval", "workspace-untrusted 的网络能力需要审批，且不会自动扩展沙箱网络", "network");
    }
    return profileDecision(this, "approval_required", "untrusted_elevated_approval", "workspace-untrusted 要求审批脚本、构建、记忆、MCP 或其他非只读能力", "elevated");
  }

  #workspaceConfirm(definition) {
    const capability = definition.capability;
    if (capability.readOnly && !capability.effects.some(isElevatedEffect)) {
      return profileDecision(this, "allow", "safe_read", "workspace-confirm 允许普通工作区只读能力", "read");
    }
    return profileDecision(this, "approval_required", "workspace_confirm", "workspace-confirm 要求用户确认写入、Shell 和其他副作用", "workspace_confirm", {
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
}

export function createPermissionProfile(options) {
  return new PermissionProfile(options);
}

export function classifyShellCommand(command, { profile, executionType = "local", networkTargets = [] } = {}) {
  if (typeof command !== "string" || !command.trim()) throw new Error("Shell command 必须是非空字符串");
  const source = command.trim();
  if (PROTECTED_SHELL_PATH.test(source) || HOME_PATH_SHELL.test(source)) {
    return profileDecision(profile, "deny", "protected_shell_path", "Permission Profile 拒绝 Shell 访问秘密路径或宿主凭据", "protected_path", {
      action: "shell",
      resource: summarizeCommand(source),
    });
  }
  if (EXTERNAL_PATH_SHELL.test(source)) {
    return profileDecision(profile, "deny", "external_path_deny", "Permission Profile 拒绝 Shell 访问工作区外路径", "external_path", {
      action: "shell",
      resource: summarizeCommand(source),
    });
  }
  if (isSystemDestructiveShellCommand(source)) {
    return profileDecision(profile, "deny", "system_destructive_shell_deny", "Permission Profile 拒绝宿主提权或系统级破坏命令", "system_destructive", {
      action: "shell",
      resource: summarizeCommand(source),
    });
  }
  if (profile?.name === "read-only") {
    if (SANDBOXED_EXECUTIONS.has(executionType) && isReadOnlySafeShell(source)) {
      return profileDecision(profile, "allow", "safe_shell_read", `命令属于 ${executionType} 下的最小只读 Shell 集合`, "read_only_shell", {
        action: "shell",
        resource: summarizeCommand(source),
      });
    }
    return profileDecision(profile, "deny", "shell_deny", "read-only 只允许 Native/Docker 中固定 PATH 下的 pwd、ls 和 rg 只读检查", "read_only_shell", {
      action: "shell",
      resource: summarizeCommand(source),
    });
  }
  if (isWorkspaceDestructiveShellCommand(source)) {
    return profileDecision(profile, "approval_required", "workspace_destructive_approval", "命令可能删除或覆盖工作区内容，需要用户确认", "workspace_destructive", {
      action: "shell",
      resource: summarizeCommand(source),
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  if (DYNAMIC_INTERPRETER_SHELL.some((pattern) => pattern.test(source))) {
    return profileDecision(profile, "approval_required", "dynamic_interpreter_approval", "动态解释器可以隐藏任意文件或进程副作用，必须审批", "dynamic_interpreter", {
      action: "shell",
      resource: summarizeCommand(source),
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  const protectedWorkspaceRoots = referencedProtectedWorkspaceRoots(source);
  if (protectedWorkspaceRoots.length && !isClearlyReadOnlyShell(source)) {
    return profileDecision(profile, "approval_required", "workspace_metadata_shell_approval", "命令可能写入工作区控制目录，需要用户确认", "workspace_metadata_write", {
      action: "shell",
      resource: summarizeCommand(source),
      protectedWorkspaceRoots,
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  const networkCommand = DIRECT_NETWORK_SHELL.some((pattern) => pattern.test(source));
  if (networkCommand && networkTargets.length) {
    const resolved = resolveShellNetworkTargets(source, networkTargets);
    if (resolved.denied.length || !resolved.allowed.length) {
      const detail = resolved.denied.length ? resolved.denied.join(", ") : "未显式使用 IPv4 目标";
      return profileDecision(profile, "deny", "network_target_deny", `网络命令目标不在可信网络目标白名单：${detail}`, "network_target", {
        action: "network",
        resource: summarizeCommand(source),
        deniedTargets: [...resolved.denied],
      });
    }
    return profileDecision(profile, "approval_required", "trusted_network_target_approval", "命令只请求访问受信任配置声明的精确网络目标，需要用户确认", "trusted_network_target", {
      action: "network",
      resource: summarizeCommand(source),
      networkTargets: [...resolved.allowed],
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  if (networkCommand) {
    return profileDecision(profile, "approval_required", "network_or_install_approval", "网络、依赖安装或远程发布命令需要审批", "network_or_install", {
      action: "shell",
      resource: summarizeCommand(source),
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  if (INSTALL_OR_GIT_NETWORK_SHELL.some((pattern) => pattern.test(source))) {
    return profileDecision(profile, "approval_required", "network_or_install_approval", "网络、依赖安装或远程发布命令需要用户确认", "network_or_install", {
      action: "shell",
      resource: summarizeCommand(source),
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  if (GIT_WRITE_SHELL.some((pattern) => pattern.test(source))) {
    return profileDecision(profile, "approval_required", "git_write_approval", "修改 Git 元数据或远程仓库需要审批", "git_write", {
      action: "shell",
      resource: summarizeCommand(source),
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  if (["workspace-confirm", "approval-required"].includes(profile?.name)) {
    return profileDecision(profile, "approval_required", "shell_confirm", "当前档位要求确认所有 Shell 命令", "workspace_confirm", {
      action: "shell",
      resource: summarizeCommand(source),
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  if (!SANDBOXED_EXECUTIONS.has(executionType)) {
    return profileDecision(profile, "approval_required", "unsandboxed_shell_approval", "Shell 未处于 Native/Docker 沙箱，必须审批", "unsandboxed_shell", {
      action: "shell",
      resource: summarizeCommand(source),
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  if (profile?.name === "workspace-untrusted") {
    if (isUntrustedSafeReadShell(source)) {
      return profileDecision(profile, "allow", "untrusted_safe_read", `命令属于 ${executionType} 沙箱内明确的只读检查集合`, "untrusted_safe_read", {
        action: "shell",
        resource: summarizeCommand(source),
      });
    }
    return profileDecision(profile, "approval_required", "untrusted_shell_approval", "workspace-untrusted 只自动执行明确的只读检查命令，脚本、测试、构建和其他 Shell 必须审批", "untrusted_shell", {
      action: "shell",
      resource: summarizeCommand(source),
      approvalScopes: USER_CONFIRM_SCOPES,
    });
  }
  return profileDecision(profile, "allow", "sandboxed_shell", `命令将在 ${executionType} 沙箱内执行，workspace-auto 自动允许`, "sandboxed_shell", {
    action: "shell",
    resource: summarizeCommand(source),
  });
}

const SYSTEM_DESTRUCTIVE_SHELL = [
  /(^|[;&|]\s*)(sudo|shutdown|reboot|mkfs|mount|umount)\b/i,
  /\bdd\s+.*\b(?:of|if)=/i,
];
const WORKSPACE_DESTRUCTIVE_SHELL = [
  /(^|[\s;&|'"(])(?:command\s+)?(?:\/(?:usr\/)?bin\/)?(?:rm|rmdir|unlink)(?=\s|$)/i,
  /\bfind\b[^;&|\n]*\s-delete(?:\s|$)/i,
  /\bfind\b[^;&|\n]*\s-exec\s+(?:\/(?:usr\/)?bin\/)?rm\b/i,
  /\bxargs\b[^;&|\n]*\s(?:\/(?:usr\/)?bin\/)?rm\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
];
const PROTECTED_SHELL_PATH = /(^|[\s'"/])(?:\.env[^\s'"/]*|\.(?:ssh|aws|azure|kube|gnupg|password-store|docker)(?:\/|[\s'"$]|$)|\.(?:npmrc|pypirc|netrc|git-credentials)(?:[\s'"$]|$)|\.nexus\/config\.local\.json(?:[\s'"$]|$))/i;
const HOME_PATH_SHELL = /(^|[\s'"=])~(?:\/|[\s'"$]|$)|\$(?:HOME\b|\{HOME\})/i;
const DYNAMIC_INTERPRETER_SHELL = [
  /(^|[\s;&|'"(])(?:\/[^\s;&|]+\/)?(?:(?:ba|z|da|k)?sh|fish)\b[^;&|\n]*\s(?:-c|--command)(?:\s|=|['"]|$)/i,
  /(^|[\s;&|'"(])(?:\/[^\s;&|]+\/)?(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)\b[^;&|\n]*\s-c(?:\s|['"]|$)/i,
  /(^|[\s;&|'"(])(?:\/[^\s;&|]+\/)?node\b[^;&|\n]*\s(?:-e|--eval|-p|--print)(?:\s|=|['"]|$)/i,
  /(^|[\s;&|'"(])(?:\/[^\s;&|]+\/)?(?:ruby|perl|lua|rscript)\b[^;&|\n]*\s-e(?:\s|['"]|$)/i,
  /(^|[\s;&|'"(])(?:\/[^\s;&|]+\/)?php\b[^;&|\n]*\s-r(?:\s|['"]|$)/i,
  /(^|[\s;&|'"(])(?:\/[^\s;&|]+\/)?(?:deno\s+eval|bun\s+(?:-e|--eval)|osascript\s+-e)\b/i,
  /(^|[\s;&|'"(])(?:pwsh|powershell)(?:\.exe)?\b[^;&|\n]*\s(?:-c|-command)(?:\s|$)/i,
  /(^|[\s;&|])eval(?:\s|$)/i,
  /`|\$\(/,
];
const DIRECT_NETWORK_SHELL = [
  /(^|[;&|]\s*)(curl|wget|ssh|scp|sftp|nc|ncat|telnet|expect)\b/i,
];
const INSTALL_OR_GIT_NETWORK_SHELL = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|update|publish)\b/i,
  /\b(?:pip|pip3|uv)\s+install\b/i,
  /\bgit\s+(?:push|pull|fetch|clone)\b/i,
];
const GIT_WRITE_SHELL = [
  /\bgit\s+(?:add|commit|checkout|switch|merge|rebase|cherry-pick|tag|stash|config|reset|restore|clean)\b/i,
];
const EXTERNAL_PATH_SHELL = /(^|[\s'"=])\.\.(?:\/|[\s'"$])|(^|[\s'"=])\/(?:Users|home|etc|opt|private|var)(?:\/|[\s'"$])/i;
const UNTRUSTED_SHELL_META = /[;&|<>`$\\\r\n]/;

function profileDecision(profile, decision, rule, reason, category, details = {}) {
  const name = profile?.name || "approval-required";
  const { approvalScopes, ...explanation } = details;
  return {
    decision,
    ruleId: `profile.${name}.${rule}`,
    reason,
    profile: name,
    ...(approvalScopes ? { approvalScopes } : {}),
    explanation: { layer: "permission_profile", category, ...explanation },
  };
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value) throw new Error("Permission Profile 路径必须是非空字符串");
  const normalized = path.normalize(value).replace(/^\.\//, "");
  if (path.isAbsolute(value) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Permission Profile 路径必须位于 workspace 内");
  }
  return normalized || ".";
}

function isEnvironmentFilename(segment) {
  return typeof segment === "string" && segment.startsWith(".env");
}

function isCredentialPathSegment(segment) {
  return [
    ".ssh", ".aws", ".azure", ".kube", ".gnupg", ".password-store", ".docker",
    ".npmrc", ".pypirc", ".netrc", ".git-credentials",
  ].includes(segment);
}

function isLocalSecretConfig(segments) {
  return segments[0] === ".nexus" && segments[1] === "config.local.json";
}

function isSystemDestructiveShellCommand(source) {
  return SYSTEM_DESTRUCTIVE_SHELL.some((pattern) => pattern.test(source));
}

function isWorkspaceDestructiveShellCommand(source) {
  return WORKSPACE_DESTRUCTIVE_SHELL.some((pattern) => pattern.test(source));
}

function referencedProtectedWorkspaceRoots(source) {
  return [".git", ".agents", ".codex", ".nexus"].filter((root) => (
    new RegExp(`(^|[\\s'\"/])\\${root}(?:/|[\\s'\"$]|$)`, "i").test(source)
  ));
}

function isClearlyReadOnlyShell(source) {
  if (UNTRUSTED_SHELL_META.test(source)) return false;
  const program = path.basename(source.trim().split(/\s+/)[0] || "");
  if (["cat", "head", "tail", "less", "wc", "file", "stat", "ls", "rg", "grep"].includes(program)) return true;
  if (program === "find") return !/\s(?:-delete|-exec|-execdir|-ok|-okdir)(?:\s|$)/i.test(source);
  return /^git\s+(?:status|diff|log|show|rev-parse|ls-files)\b/i.test(source);
}

function isUntrustedSafeReadShell(source) {
  if (UNTRUSTED_SHELL_META.test(source)) return false;
  const tokens = source.trim().split(/\s+/);
  const program = path.basename(tokens[0] || "");
  if (tokens[0] !== program) return false;
  const args = tokens.slice(1);
  if (program === "pwd") return args.length === 0;
  if (program === "ls") {
    return !args.some((arg) => arg === "--dereference" || (/^-[^-]*[HL]/.test(arg)));
  }
  if (program === "rg") {
    return !args.some((arg) => ["-L", "--follow", "--pre", "--pre-glob"].some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  }
  if (program !== "git" || !args.length) return false;
  const subcommand = args[0];
  if (!["status", "diff", "rev-parse", "ls-files", "log", "show"].includes(subcommand)) return false;
  return !args.some((arg) => ["--output", "--ext-diff", "--textconv", "--exec"].some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

function isReadOnlySafeShell(source) {
  if (UNTRUSTED_SHELL_META.test(source)) return false;
  const tokens = source.trim().split(/\s+/);
  const program = path.basename(tokens[0] || "");
  if (tokens[0] !== program) return false;
  const args = tokens.slice(1);
  if (program === "pwd") return args.length === 0;
  if (program === "ls") {
    return args.every((arg) => arg.startsWith("-") && arg !== "--dereference" && !/^-[^-]*[HL]/.test(arg));
  }
  if (program === "rg") {
    const safeFlags = new Set([
      "--files", "-n", "--line-number", "-i", "--ignore-case", "-S", "--smart-case",
      "-w", "--word-regexp", "-F", "--fixed-strings", "-l", "--files-with-matches",
      "-c", "--count", "--json", "--stats", "--no-heading", "--heading", "--color=never",
    ]);
    let patterns = 0;
    for (const arg of args) {
      if (arg.startsWith("-")) {
        if (!safeFlags.has(arg)) return false;
      } else {
        patterns += 1;
        if (patterns > 1 || outsideWorkspaceToken(arg)) return false;
      }
    }
    return args.includes("--files") ? patterns === 0 : patterns === 1;
  }
  return false;
}

function outsideWorkspaceToken(value) {
  return path.isAbsolute(value)
    || value === ".."
    || value.startsWith("../")
    || value.includes("/../")
    || value.endsWith("/..");
}

function isElevatedEffect(effect) {
  return ["write", "execute", "network", "credential"].includes(effect);
}

function isInternalStateCapability(capability) {
  return capability.risk === "R0"
    && capability.effects.length > 0
    && capability.effects.every((effect) => effect === "state");
}

function summarizeCommand(value) {
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
