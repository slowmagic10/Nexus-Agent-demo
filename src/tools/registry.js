import { promises as fs } from "node:fs";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { CapabilityRuntime } from "../capabilities/runtime.js";
import { assertWorkspaceExecution, createExecutionSpec } from "../execution/interface.js";
import { LocalWorkspaceAdapter } from "../execution/local-workspace-adapter.js";
import { assertMemoryInterface } from "../memory/interface.js";
import { assertArtifactStore } from "../artifacts/interface.js";
import { executeMemoryMutation } from "../memory/outbox.js";
import { createPermissionProfile } from "./permission-profile.js";

const NATIVE_TOOL_OWNER = "nexus:native-tools";
const SAFE_READ_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

export function createToolRegistry({
  workspace,
  bundledSkills,
  memory,
  memoryStore,
  artifactStore = null,
  extraTools = [],
  capabilityRuntime = new CapabilityRuntime(),
  workspaceExecution = null,
  accessPolicy = null,
  accessPolicies = null,
  delegateTask = null,
  shellTimeoutMs = 15_000,
}) {
  const root = realpathSync(path.resolve(workspace));
  if (!Number.isSafeInteger(shellTimeoutMs) || shellTimeoutMs < 1) throw new Error("shellTimeoutMs 必须是正整数");
  const execution = assertWorkspaceExecution(workspaceExecution || new LocalWorkspaceAdapter({ workspace: root }));
  const permissionProfile = accessPolicy || createPermissionProfile({
    name: "workspace-auto",
    workspace: root,
    executionType: executionType(execution),
  });
  const permissionProfiles = normalizeAccessPolicies(accessPolicies, permissionProfile);
  const policyFor = (context) => permissionProfiles.get(context?.state?.permissionProfile) || permissionProfile;
  const configuredMemory = memory || memoryStore?.memory || memoryStore || null;
  const memoryAdapter = configuredMemory ? assertMemoryInterface(configuredMemory) : null;
  const artifactAdapter = artifactStore ? assertArtifactStore(artifactStore) : null;
  const skillRoots = [path.join(root, ".nexus", "skills"), bundledSkills];
  assertCapabilityRuntime(capabilityRuntime);
  const define = (tool, owner = NATIVE_TOOL_OWNER) => {
    const { capabilityOwner: _capabilityOwner, ...definition } = tool;
    return capabilityRuntime.register({
      kind: "tool",
      name: definition.name,
      owner,
      value: { adapter: "native", ...definition },
    });
  };

  define({
    name: "list_files",
    description: "列出工作区内某个目录的文件。只读，自动执行。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: workspacePathCapability("path", "read", "R0", true, "."),
    parameters: objectSchema({ path: { type: "string", description: "相对工作区路径" } }),
    execute: async ({ path: requested = "." }, context) => {
      const currentPolicy = policyFor(context);
      const target = safePath(root, requested);
      assertWorkspaceAccess(currentPolicy, root, target, "read");
      const entries = await fs.readdir(target, { withFileTypes: true });
      return entries
        .filter((entry) => currentPolicy.canAccessPath(path.relative(root, path.join(target, entry.name)) || ".", "read"))
        .slice(0, 120)
        .map((entry) => `${entry.isDirectory() ? "目录" : "文件"}\t${path.join(requested, entry.name)}`)
        .join("\n") || "（空目录）";
    },
  });

  if (memoryAdapter) {
    define({
      name: "memory_save",
      description: "保存一条跨会话长期记忆。属于持久化写入，按 Workspace Policy 与 Session Grant 授权。",
      approval: "always",
      effects: ["memory", "write"],
      idempotency: "keyed",
      capability: scopedCapability("memory_scope", "write", "R1", false),
      parameters: objectSchema({
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      }, ["content"]),
      execute: async ({ content, tags = [] }, context) => {
        const provenance = {
          origin: "tool",
          sessionId: context.state.id,
          sourceCursor: context.sourceCursor,
          toolCallId: context.callId,
          actor: context.state.memoryScope.agentId,
        };
        const record = await executeMemoryMutation({
          memory: memoryAdapter,
          dispatch: context.dispatch,
          signal: context.signal,
          mutation: {
            id: `${context.state.id}:${context.callId}:memory.add`,
            operation: "add",
            reconcilePolicy: "automatic",
            candidate: { content, tags, kind: "fact", confidence: 1 },
            scope: context.state.memoryScope,
            provenance,
          },
        });
        return `已保存长期记忆 ${record.id}：${record.content}`;
      },
    });
    define({
      name: "memory_search",
      description: "搜索跨会话长期记忆。只读，自动执行。",
      approval: "never",
      effects: ["read", "memory"],
      idempotency: "safe",
      capability: scopedCapability("memory_scope", "read", "R0", true),
      parameters: objectSchema({ query: { type: "string" } }),
      execute: async ({ query = "" }, context) => formatMemories(await memoryAdapter.search(query, {
        scope: context.state.memoryScope,
        signal: context.signal,
      }, { limit: 20 })),
    });
    define({
      name: "memory_delete",
      description: "按 ID 删除长期记忆。属于持久化删除，按 Workspace Policy 与 Session Grant 授权。",
      approval: "always",
      effects: ["memory", "write"],
      idempotency: "keyed",
      capability: scopedCapability("memory_scope", "write", "R1", false),
      parameters: objectSchema({
        id: { type: "string" },
        reason: { type: "string", description: "删除原因" },
      }, ["id"]),
      execute: async ({ id, reason = "Agent 应用户要求删除" }, context) => {
        const deleted = await executeMemoryMutation({
          memory: memoryAdapter,
          dispatch: context.dispatch,
          signal: context.signal,
          mutation: {
            id: `${context.state.id}:${context.callId}:memory.delete`,
            operation: "delete",
            reconcilePolicy: "automatic",
            memoryId: id,
            reason,
            scope: context.state.memoryScope,
            provenance: {
              origin: "tool",
              sessionId: context.state.id,
              sourceCursor: context.sourceCursor,
              toolCallId: context.callId,
              actor: context.state.memoryScope.agentId,
            },
          },
        });
        return deleted ? `已删除长期记忆：${id}` : `未找到长期记忆：${id}`;
      },
    });
  }

  define({
    name: "read_file",
    description: "读取工作区内 UTF-8 文本文件。只读，自动执行。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: workspacePathCapability("path", "read", "R0", true),
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    execute: async ({ path: requested }, context) => {
      const target = safePath(root, requested);
      assertWorkspaceAccess(policyFor(context), root, target, "read");
      return truncate(await fs.readFile(target, "utf8"), 1_000_000);
    },
  });

  if (artifactAdapter) {
    define({
      name: "read_artifact",
      description: "分段读取当前 Session 中保存的文本 Artifact。只读，自动执行。",
      approval: "never",
      effects: ["read"],
      idempotency: "safe",
      capability: scopedCapability("session", "read", "R0", true),
      parameters: objectSchema({
        id: { type: "string", description: "Artifact ID" },
        offset: { type: "integer", description: "起始字符位置，默认 0" },
        limit: { type: "integer", description: "读取字符数，默认且最多 10000" },
      }, ["id"]),
      execute: async ({ id, offset = 0, limit = 10_000 }, context) => {
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Artifact offset 必须是非负整数");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Artifact limit 必须是 1 到 10000 的整数");
        const artifact = await artifactAdapter.get(id, { sessionId: context.state.id });
        if (!artifact) throw new Error("Artifact 不存在或不属于当前 Session");
        const end = Math.min(artifact.content.length, offset + limit);
        return `Artifact ${offset}-${end} / ${artifact.content.length} 字符\n${artifact.content.slice(offset, end)}`;
      },
    });
  }

  define({
    name: "search_files",
    description: "在工作区文本文件中搜索字符串。只读，自动执行。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: workspacePathCapability("path", "read", "R0", true, "."),
    parameters: objectSchema({ query: { type: "string" }, path: { type: "string" } }, ["query"]),
    execute: async ({ query, path: requested = "." }, context) => {
      const currentPolicy = policyFor(context);
      const base = safePath(root, requested);
      assertWorkspaceAccess(currentPolicy, root, base, "read");
      const files = await walk(base, 300, root, currentPolicy);
      const hits = [];
      for (const file of files) {
        try {
          const content = await fs.readFile(file, "utf8");
          content.split("\n").forEach((line, index) => {
            if (line.toLowerCase().includes(query.toLowerCase()) && hits.length < 80) {
              hits.push(`${path.relative(root, file)}:${index + 1}: ${line.trim().slice(0, 240)}`);
            }
          });
        } catch {}
      }
      return hits.join("\n") || "没有找到匹配内容。";
    },
  });

  define({
    name: "write_file",
    description: "写入工作区文件。普通路径可由 workspace-auto 自动执行，受保护路径始终拒绝。",
    approval: "always",
    effects: ["write"],
    idempotency: "unknown",
    changeTracking: { mode: "paths", arguments: ["path"] },
    capability: workspacePathCapability("path", "write", "R1", false),
    parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    execute: async ({ path: requested, content }, context) => {
      const target = safePath(root, requested);
      assertWorkspaceAccess(policyFor(context), root, target, "write");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
      return `已写入 ${path.relative(root, target)}（${Buffer.byteLength(content)} 字节）`;
    },
  });

  define({
    name: "edit_file",
    description: "精确编辑工作区内的 UTF-8 文本文件。old_text 必须按 expected_replacements 指定次数完整匹配；缺失或歧义时不写入。",
    approval: "always",
    effects: ["write"],
    idempotency: "unknown",
    changeTracking: { mode: "paths", arguments: ["path"] },
    capability: workspacePathCapability("path", "write", "R1", false),
    parameters: objectSchema({
      path: { type: "string", description: "相对工作区路径" },
      old_text: { type: "string", description: "要替换的完整原文本，必须精确匹配空格与换行" },
      new_text: { type: "string", description: "替换后的文本；可为空字符串以删除原文本" },
      expected_replacements: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "预期匹配并替换的次数，默认 1；实际次数不一致时不写入",
      },
    }, ["path", "old_text", "new_text"]),
    execute: async ({
      path: requested,
      old_text: oldText,
      new_text: newText,
      expected_replacements: expectedReplacements = 1,
    }, context) => {
      if (!oldText) throw new Error("edit_file old_text 不能为空");
      if (!Number.isSafeInteger(expectedReplacements) || expectedReplacements < 1 || expectedReplacements > 1000) {
        throw new Error("edit_file expected_replacements 必须是 1 到 1000 的整数");
      }
      if (oldText === newText) throw new Error("edit_file 的 old_text 与 new_text 相同，无需写入");
      const target = safePath(root, requested);
      assertWorkspaceAccess(policyFor(context), root, target, "write");
      context.signal?.throwIfAborted?.();
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("edit_file 只能编辑普通文件");
      if (stat.size > 4 * 1024 * 1024) throw new Error("edit_file 首版仅支持不超过 4 MiB 的文本文件");
      const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await fs.readFile(target));
      const actualReplacements = countOccurrences(source, oldText);
      if (actualReplacements !== expectedReplacements) {
        throw new Error(`edit_file 预期匹配 ${expectedReplacements} 处，实际匹配 ${actualReplacements} 处；文件未修改`);
      }
      const updated = source.split(oldText).join(newText);
      if (Buffer.byteLength(updated) > 8 * 1024 * 1024) {
        throw new Error("edit_file 替换结果超过 8 MiB，文件未修改");
      }
      context.signal?.throwIfAborted?.();
      await fs.writeFile(target, updated, "utf8");
      return `已精确编辑 ${path.relative(root, target)}（替换 ${actualReplacements} 处）`;
    },
  });

  define({
    name: "run_shell",
    description: "在工作区执行 Shell 命令。read-only 仅允许沙箱内的最小只读检查；workspace-auto 可自动执行常规命令；网络、安装和外部路径需要审批，危险命令拒绝。",
    approval: "always",
    effects: ["execute"],
    idempotency: "unknown",
    changeTracking: { mode: "workspace" },
    timeoutMs: shellTimeoutMs,
    capability: {
      risk: "R2",
      readOnly: false,
      resources: [
        { kind: "workspace", access: "execute" },
        { kind: "shell_command", argument: "command", access: "execute" },
      ],
    },
    parameters: objectSchema({ command: { type: "string" } }, ["command"]),
    execute: async ({ command }, context) => executeShell(execution, policyFor(context), command, context.signal),
  });

  define({
    name: "remember",
    description: "把一条信息加入当前会话记忆。记忆随会话一起保存在本地。",
    approval: "never",
    effects: ["memory", "write"],
    idempotency: "unknown",
    capability: scopedCapability("session", "write", "R1", false),
    parameters: objectSchema({ content: { type: "string" } }, ["content"]),
    execute: async ({ content }, context) => {
      await context.dispatch({ type: "MEMORY_ADDED", content });
      return `已加入短期记忆：${content}`;
    },
  });

  define({
    name: "update_plan",
    description: "创建或更新当前 Objective 的执行计划。用于多步骤任务；计划变化会写入 Session Journal，且不产生工作区外部副作用。",
    approval: "never",
    effects: ["state"],
    idempotency: "safe",
    capability: scopedCapability("session", "write", "R0", false),
    parameters: objectSchema({
      explanation: { type: "string", description: "可选的计划调整原因" },
      plan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    }, ["plan"]),
    execute: async ({ explanation = "", plan }, context) => {
      await context.dispatch({ type: "PLAN_UPDATED", explanation, steps: plan });
      const active = plan.find((item) => item.status === "in_progress");
      return `计划已更新（${plan.length} 步）${active ? `，当前：${active.step}` : ""}`;
    },
  });

  if (delegateTask) {
    if (typeof delegateTask !== "function") throw new Error("delegateTask 必须是函数");
    define({
      name: "delegate_task",
      description: "把一个边界清晰的子任务交给单层 Child Session，等待其结果后回填当前 Session。Child 不能继续委派。",
      approval: "never",
      effects: ["state"],
      idempotency: "keyed",
      timeoutMs: 10 * 60_000,
      capability: scopedCapability("session", "write", "R0", false, "single_child_delegation"),
      available: ({ state }) => state?.lineage?.kind !== "delegation",
      parameters: objectSchema({
        objective: { type: "string", description: "Child 必须完成的独立目标" },
        context: {
          type: "array",
          items: { type: "string" },
          description: "显式传递给 Child 的必要事实，不会复制父会话完整 transcript",
        },
        budget: {
          type: "object",
          properties: {
            maxSteps: { type: "integer" },
            maxTokensPerTurn: { type: "integer" },
          },
          additionalProperties: false,
        },
      }, ["objective"]),
      execute: async ({ objective, context = [], budget = {} }, toolContext) => (
        delegateTask({ objective, context, budget }, toolContext)
      ),
    });
  }

  define({
    name: "recall_memory",
    description: "检索当前会话的短期记忆。",
    approval: "never",
    effects: ["read", "memory"],
    idempotency: "safe",
    capability: scopedCapability("session", "read", "R0", true),
    parameters: objectSchema({ query: { type: "string" } }),
    execute: async ({ query = "" }, context) => {
      const matches = context.state.memory.filter((item) => item.content.toLowerCase().includes(query.toLowerCase()));
      return matches.map((item, index) => `${index + 1}. ${item.content}`).join("\n") || "当前没有匹配记忆。";
    },
  });

  define({
    name: "list_skills",
    description: "列出可以按需加载的 Skills。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: scopedCapability("external", "read", "R0", true, "skill_catalog"),
    parameters: objectSchema({}),
    execute: async () => (await discoverSkills(skillRoots)).map((skill) => `${skill.name}\t${skill.description}`).join("\n") || "没有发现 Skill。",
  });

  define({
    name: "load_skill",
    description: "按名称加载一个 Skill 的 Markdown 指令到当前会话。",
    approval: "never",
    effects: ["read", "memory"],
    idempotency: "safe",
    capability: scopedCapability("session", "read", "R0", true),
    parameters: objectSchema({ name: { type: "string" } }, ["name"]),
    execute: async ({ name }, context) => {
      const skill = (await discoverSkills(skillRoots)).find((item) => item.name === name);
      if (!skill) throw new Error(`未找到 Skill：${name}`);
      const content = await fs.readFile(skill.file, "utf8");
      await context.dispatch({ type: "SKILL_LOADED", skill: { name, content } });
      return `已加载 Skill：${name}\n${truncate(content, 6000)}`;
    },
  });

  for (const tool of extraTools) {
    define(tool, tool.capabilityOwner || `adapter:${tool.adapter || "external"}`);
  }

  return {
    get: (name) => capabilityRuntime.get("tool", name),
    resolve: (name) => capabilityRuntime.resolve("tool", name),
    acquire: (name, registrationId) => capabilityRuntime.acquire("tool", name, registrationId),
    schemas: () => capabilityRuntime.list("tool").map(({ value: tool }) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    capabilityRuntime,
    workspaceExecution: execution,
    accessPolicy: permissionProfile,
    accessPolicies: permissionProfiles,
  };
}

function normalizeAccessPolicies(configured, fallback) {
  const entries = configured instanceof Map ? [...configured.entries()] : Object.entries(configured || {});
  const profiles = new Map(entries);
  if (!profiles.has(fallback.name)) profiles.set(fallback.name, fallback);
  for (const [name, policy] of profiles) {
    if (typeof name !== "string" || !name || typeof policy?.assertPath !== "function" || typeof policy?.classifyShell !== "function") {
      throw new Error("Tool Registry accessPolicies 必须是具名 Permission Profile");
    }
  }
  return profiles;
}

function assertCapabilityRuntime(runtime) {
  const methods = ["register", "get", "resolve", "acquire", "list", "revokeOwner"];
  if (!runtime || methods.some((method) => typeof runtime[method] !== "function")) {
    throw new Error(`Tool Registry 需要 Capability Runtime：${methods.join(", ")}`);
  }
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function workspacePathCapability(argument, access, risk, readOnly, defaultValue) {
  return {
    risk,
    readOnly,
    resources: [{
      kind: "workspace_path",
      argument,
      access,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    }],
  };
}

function scopedCapability(kind, access, risk, readOnly, value) {
  return {
    risk,
    readOnly,
    resources: [{ kind, access, ...(value ? { value } : {}) }],
  };
}

function safePath(root, requested) {
  const target = path.resolve(root, requested || ".");
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("路径越过了工作区边界");
  let existing = target;
  while (!existsSync(existing)) existing = path.dirname(existing);
  const realExisting = realpathSync(existing);
  if (realExisting !== root && !realExisting.startsWith(`${root}${path.sep}`)) {
    throw new Error("符号链接越过了工作区边界");
  }
  return path.join(realExisting, path.relative(existing, target));
}

async function walk(root, limit, workspace, accessPolicy) {
  const results = [];
  const queue = [root];
  while (queue.length && results.length < limit) {
    const current = queue.shift();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const target = path.join(current, entry.name);
      const relative = path.relative(workspace, target) || ".";
      if (!accessPolicy.canAccessPath(relative, "read")) continue;
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && !/^nexus\.db(?:-(?:wal|shm))?$/.test(entry.name) && (await fs.stat(target)).size < 1_000_000) results.push(target);
      if (results.length >= limit) break;
    }
  }
  return results;
}

async function discoverSkills(roots) {
  const found = [];
  for (const root of roots) {
    try {
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root, entry.name, "SKILL.md");
        try {
          const first = await fs.readFile(file, "utf8");
          const description = first.match(/description:\s*(.+)/)?.[1] || first.split("\n").find((line) => line && !line.startsWith("#")) || "无描述";
          found.push({ name: entry.name, description, file });
        } catch {}
      }
    } catch {}
  }
  return found;
}

async function executeShell(execution, accessPolicy, command, signal) {
  const classification = accessPolicy.classifyShell(command);
  if (classification.decision === "deny") throw new Error(classification.reason);
  const result = await execution.execute(createExecutionSpec({
    program: "/bin/zsh",
    args: ["-dfc", command],
    cwd: ".",
    filesystemMode: accessPolicy.name === "read-only" ? "read-only" : "workspace-write",
    networkTargets: accessPolicy.networkTargetsForShell(command),
    ...(["read-only", "workspace-untrusted"].includes(accessPolicy.name) && classification.decision === "allow"
      ? { env: { PATH: SAFE_READ_PATH } }
      : {}),
    maxOutputChars: 1_000_000,
  }), { signal });
  const summary = result.output.trim() || "（无输出）";
  if (result.exitCode === 0) return summary;
  throw new Error(`退出码 ${result.exitCode}\n${summary}`);
}

function assertWorkspaceAccess(accessPolicy, workspace, target, access) {
  return accessPolicy.assertPath(path.relative(workspace, target) || ".", access);
}

function executionType(execution) {
  if (execution.id === "native-sandbox") return "native";
  if (execution.id === "docker-workspace") return "docker";
  return "local";
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length)}\n…（已截断）` : value;
}

function countOccurrences(source, target) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(target, offset)) !== -1) {
    count += 1;
    offset += target.length;
  }
  return count;
}

function formatMemories(memories) {
  return memories.map((item) => `${item.id}\t${item.tags.join(",")}\t${item.content}`).join("\n") || "没有匹配的长期记忆。";
}
