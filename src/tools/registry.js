import { promises as fs } from "node:fs";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertMemoryInterface } from "../memory/interface.js";
import { executeMemoryMutation } from "../memory/outbox.js";

export function createToolRegistry({ workspace, bundledSkills, memory, memoryStore, extraTools = [] }) {
  const root = realpathSync(path.resolve(workspace));
  const configuredMemory = memory || memoryStore?.memory || memoryStore || null;
  const memoryAdapter = configuredMemory ? assertMemoryInterface(configuredMemory) : null;
  const skillRoots = [path.join(root, ".nexus", "skills"), bundledSkills];
  const tools = new Map();
  const define = (tool) => tools.set(tool.name, { adapter: "native", ...tool });

  define({
    name: "list_files",
    description: "列出工作区内某个目录的文件。只读，自动执行。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: workspacePathCapability("path", "read", "R0", true, "."),
    parameters: objectSchema({ path: { type: "string", description: "相对工作区路径" } }),
    execute: async ({ path: requested = "." }) => {
      const target = safePath(root, requested);
      const entries = await fs.readdir(target, { withFileTypes: true });
      return entries.slice(0, 120).map((entry) => `${entry.isDirectory() ? "目录" : "文件"}\t${path.join(requested, entry.name)}`).join("\n") || "（空目录）";
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
    execute: async ({ path: requested }) => truncate(await fs.readFile(safePath(root, requested), "utf8"), 12_000),
  });

  define({
    name: "search_files",
    description: "在工作区文本文件中搜索字符串。只读，自动执行。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: workspacePathCapability("path", "read", "R0", true, "."),
    parameters: objectSchema({ query: { type: "string" }, path: { type: "string" } }, ["query"]),
    execute: async ({ query, path: requested = "." }) => {
      const base = safePath(root, requested);
      const files = await walk(base, 300);
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
    description: "写入工作区文件。属于有副作用操作，未获 Session Grant 时要求审批。",
    approval: "always",
    effects: ["write"],
    idempotency: "unknown",
    capability: workspacePathCapability("path", "write", "R1", false),
    parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    execute: async ({ path: requested, content }) => {
      const target = safePath(root, requested);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
      return `已写入 ${path.relative(root, target)}（${Buffer.byteLength(content)} 字节）`;
    },
  });

  define({
    name: "run_shell",
    description: "在工作区执行 Shell 命令。高风险，必须通过 Workspace Policy 与 Session Grant/审批，危险命令会被策略层拒绝。",
    approval: "always",
    effects: ["execute"],
    idempotency: "unknown",
    timeoutMs: 15_000,
    capability: scopedCapability("workspace", "execute", "R2", false),
    parameters: objectSchema({ command: { type: "string" } }, ["command"]),
    execute: async ({ command }, context) => runShell(root, command, context.signal),
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
    if (tools.has(tool.name)) throw new Error(`工具名称冲突：${tool.name}`);
    define(tool);
  }

  return {
    get: (name) => tools.get(name),
    schemas: () => [...tools.values()].map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
  };
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

async function walk(root, limit) {
  const results = [];
  const queue = [root];
  while (queue.length && results.length < limit) {
    const current = queue.shift();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const target = path.join(current, entry.name);
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

function runShell(cwd, command, signal) {
  const denied = /(^|\s)(rm\s+-rf|sudo|shutdown|reboot|mkfs|dd\s+if=|git\s+reset\s+--hard)(\s|$)/i;
  if (denied.test(command)) throw new Error("安全策略拒绝了危险命令");
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-lc", command], { cwd, env: process.env });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("命令执行超过 15 秒，已终止"));
    }, 15_000);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(signal.reason || new Error("任务已取消"));
        return;
      }
      const summary = truncate(output.trim(), 12_000) || "（无输出）";
      if (code === 0) resolve(summary);
      else reject(new Error(`退出码 ${code}\n${summary}`));
    });
  });
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length)}\n…（已截断）` : value;
}

function formatMemories(memories) {
  return memories.map((item) => `${item.id}\t${item.tags.join(",")}\t${item.content}`).join("\n") || "没有匹配的长期记忆。";
}
