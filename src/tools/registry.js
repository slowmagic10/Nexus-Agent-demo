import { promises as fs } from "node:fs";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { CapabilityRuntime } from "../capabilities/runtime.js";
import { assertWorkspaceExecution, createExecutionSpec } from "../execution/interface.js";
import { LocalWorkspaceAdapter } from "../execution/local-workspace-adapter.js";
import { assertMemoryInterface } from "../memory/interface.js";
import { assertArtifactStore } from "../artifacts/interface.js";
import { executeMemoryMutation } from "../memory/outbox.js";
import { applyWorkspacePatch } from "./apply-patch.js";
import { createPermissionProfile } from "./permission-profile.js";
import { readContainedTextFile, resolveContainedDirectory } from "../security/contained-text-file.js";
import { executeVerification, refreshVerification } from "../core/verification.js";
import { createWorkspaceSearch } from "./workspace-search.js";
import { toolHistoryDefinition } from "./journal-read.js";
import { readWorkspaceFile } from "./workspace-read.js";
import { redactSensitiveValue } from "../security/redact.js";
import { serializeRedactedToolJson } from "../security/tool-json.js";

const NATIVE_TOOL_OWNER = "nexus:native-tools";
const SAFE_READ_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
const MAX_SHELL_TIMEOUT_MS = 2_147_483_647;
// 覆盖 Local 进程树强杀与 Docker 最长 5 秒的显式容器清理窗口。
const SHELL_TIMEOUT_HOST_GRACE_MS = 6_500;

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
  shellTimeoutMs = null,
}) {
  const root = realpathSync(path.resolve(workspace));
  if (shellTimeoutMs !== null
      && (!Number.isSafeInteger(shellTimeoutMs) || shellTimeoutMs < 1 || shellTimeoutMs > MAX_SHELL_TIMEOUT_MS)) {
    throw new Error(`shellTimeoutMs 必须是 1 到 ${MAX_SHELL_TIMEOUT_MS} 的整数或 null`);
  }
  const execution = assertWorkspaceExecution(workspaceExecution || new LocalWorkspaceAdapter({ workspace: root }));
  const permissionProfile = accessPolicy || createPermissionProfile({
    name: "workspace-auto",
    workspace: root,
    executionType: executionType(execution),
  });
  const permissionProfiles = normalizeAccessPolicies(accessPolicies, permissionProfile);
  const policyFor = (context) => permissionProfiles.get(context?.state?.permissionProfile) || permissionProfile;
  const workspaceSearch = createWorkspaceSearch({ workspace: root, policyFor });
  const configuredMemory = memory || memoryStore?.memory || memoryStore || null;
  const memoryAdapter = configuredMemory ? assertMemoryInterface(configuredMemory) : null;
  const artifactAdapter = artifactStore ? assertArtifactStore(artifactStore) : null;
  const skillRoots = [
    { boundary: root, relative: path.join(".nexus", "skills") },
    ...(bundledSkills ? [{ boundary: path.resolve(bundledSkills), relative: "." }] : []),
  ];
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

  define(toolHistoryDefinition());

  define({
    name: "list_files",
    description: "按名称排序分页列出工作区目录。返回 JSON：entries、complete、has_more、next_cursor 与跳过计数；有 next_cursor 时用相同参数续查。符号链接和受限路径排除；目录快照最多 20000 项，游标最多保留 15 分钟且目录/权限变化时失效。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: workspacePathCapability("path", "read", "R0", true, "."),
    parameters: objectSchema({
      path: { type: "string", description: "相对工作区目录，默认 ." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "返回条数，默认 120；也受响应字符预算约束" },
      scan_limit: { type: "integer", minimum: 1, maximum: 1000, description: "本页最多检查的目录项，默认 1000" },
      cursor: { type: "string", description: "上页 next_cursor，须保持其他参数一致" },
    }),
    execute: workspaceSearch.list,
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
            id: toolMemoryMutationId(context, "add"),
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
      description: "按中英文关键词搜索当前范围的跨会话长期记忆。只读，自动执行；弱匹配可能省略，未命中时可改用具体主题词查询，不支持纯语义推断。",
      approval: "never",
      effects: ["read", "memory"],
      idempotency: "safe",
      capability: scopedCapability("memory_scope", "read", "R0", true),
      parameters: objectSchema({ query: { type: "string", ...(Number.isSafeInteger(memoryAdapter.capabilities?.maxSearchQueryChars)
        && memoryAdapter.capabilities.maxSearchQueryChars > 0 ? { maxLength: memoryAdapter.capabilities.maxSearchQueryChars } : {}) } }),
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
            id: toolMemoryMutationId(context, "delete"),
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
    parallelRead: true,
    description: "读取工作区 UTF-8 文本。小文件保持完整正文；大文件或显式分页返回范围、文件 version、complete 与 next_offset。行号从 1 开始；超长行、响应或扫描预算耗尽时用 offset=next_offset 继续，传 version 防止拼接不同版本。只读，自动执行。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: workspacePathCapability("path", "read", "R0", true),
    parameters: objectSchema({
      path: { type: "string" },
      start_line: { type: "integer", description: "起始行号，从 1 开始；默认 1" },
      line_count: { type: "integer", description: "行数，默认 200，最多 2000；返回 partial_line=true 时改用 next_offset 继续" },
      offset: { type: "integer", description: "字节位置，从 0 开始；不可与行参数混用，可使用上一页 next_offset" },
      limit: { type: "integer", description: "字节模式读取预算，默认 16384，最多 65536；实际正文还受响应预算约束" },
      version: { type: "string", description: "上一页返回的 version；文件变化时拒绝继续" },
    }, ["path"]),
    execute: async (args, context) => {
      const result = await readWorkspaceFile({
        ...args, workspace: root, accessPolicy: policyFor(context),
        authorizeRead: context?.authorizeRead, signal: context?.signal,
      });
      return typeof result === "string" ? result : serializeRedactedToolJson(redactSensitiveValue(result));
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
    description: "分页递归搜索工作区 UTF-8 文件中的字面字符串（不区分大小写）。返回 JSON：matches、扫描文件/字节数、跳过计数、complete、has_more、next_cursor；本页无匹配且 has_more 不代表全范围无匹配。忽略 .git/node_modules/dist/build、数据库、符号链接、受限路径、二进制和超过 1MB 文件。每页最多读取 4MB；游标按参数和快照绑定。",
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: workspacePathCapability("path", "read", "R0", true, "."),
    parameters: objectSchema({
      query: { type: "string", minLength: 1, maxLength: 1024, description: "按行匹配的非空字面字符串，不支持换行" },
      path: { type: "string", description: "搜索目录，相对工作区，默认 ." },
      file_pattern: { type: "string", description: "相对搜索目录的文件名模式，默认 **/*；仅支持单段 *、? 和独占目录段的 **/，不支持集合、花括号、取反和转义" },
      limit: { type: "integer", minimum: 1, maximum: 80, description: "最多返回匹配行数，默认 80；也受响应字符预算约束" },
      scan_limit: { type: "integer", minimum: 1, maximum: 1000, description: "最多检查的文件或目录项数，默认 300" },
      cursor: { type: "string", description: "上页 next_cursor，须保持 query/path/file_pattern/limit/scan_limit 一致" },
    }, ["query"]),
    execute: workspaceSearch.search,
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
    name: "apply_patch",
    description: "以一个原子预检批次新增、精确更新或删除多个工作区 UTF-8 文本文件。同一路径可按顺序声明多个 update；任一操作校验失败时所有文件保持不变。",
    approval: "always",
    effects: ["write"],
    idempotency: "unknown",
    changeTracking: { mode: "paths", arguments: ["operations"], pathField: "path" },
    capability: workspacePathArrayCapability("operations", "path", "write", "R1", false),
    parameters: objectSchema({
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          anyOf: [
            objectSchema({
              operation: { type: "string", enum: ["add"] },
              path: { type: "string", description: "相对工作区路径" },
              content: { type: "string", description: "新文件的完整 UTF-8 内容" },
            }, ["operation", "path", "content"]),
            objectSchema({
              operation: { type: "string", enum: ["update"] },
              path: { type: "string", description: "相对工作区路径" },
              old_text: { type: "string", description: "必须精确匹配的旧文本" },
              new_text: { type: "string", description: "替换后的文本，可为空" },
              expected_replacements: { type: "integer", minimum: 1, maximum: 1000 },
            }, ["operation", "path", "old_text", "new_text"]),
            objectSchema({
              operation: { type: "string", enum: ["delete"] },
              path: { type: "string", description: "相对工作区路径" },
              expected_sha256: { type: "string", description: "通常省略；仅当用户或工具结果提供准确值时填写，禁止猜测删除前 SHA-256" },
            }, ["operation", "path"]),
          ],
        },
      },
    }, ["operations"]),
    execute: async ({ operations }, context) => {
      const result = await applyWorkspacePatch({
        workspace: root,
        operations,
        accessPolicy: policyFor(context),
        signal: context.signal,
      });
      return `已应用多文件 Patch：新增 ${result.added}、更新 ${result.updated}、删除 ${result.deleted}\n${result.paths.join("\n")}`;
    },
  });

  define({
    name: "run_shell",
    description: "在工作区以前台方式执行 Shell 命令。默认不自动超时，可用 timeout_ms 显式设置毫秒上限；用户仍可随时停止。read-only 仅允许沙箱内的最小只读检查；workspace-auto 可自动执行常规命令；网络、安装和外部路径需要审批，危险命令拒绝。",
    approval: "always",
    effects: ["execute"],
    idempotency: "unknown",
    changeTracking: { mode: "workspace" },
    deadline: {
      defaultMs: shellTimeoutMs,
      argument: "timeout_ms",
      maximumMs: MAX_SHELL_TIMEOUT_MS,
      enforcement: "adapter",
      hostGraceMs: SHELL_TIMEOUT_HOST_GRACE_MS,
    },
    capability: {
      risk: "R2",
      readOnly: false,
      resources: [
        { kind: "workspace", access: "execute" },
        { kind: "shell_command", argument: "command", access: "execute" },
      ],
    },
    parameters: objectSchema({
      command: { type: "string" },
      verification_id: { type: "string", description: "可选：当前 Plan 已声明的验收项 id；command 必须与该项完全一致，结果由运行时绑定文件版本记录。" },
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SHELL_TIMEOUT_MS,
        description: "可选的执行期限（毫秒）；省略表示不设置自动 deadline，命令会以前台方式等待直至退出或被用户停止。",
      },
    }, ["command"]),
    execute: async ({ command, verification_id }, context) => {
      const execute = () => executeShell(execution, policyFor(context), command,
        context.signal, context.onOutput, context.effectiveTimeoutMs);
      return verification_id === undefined ? execute()
        : executeVerification({ id: verification_id, command, context, workspace: root, execute });
    },
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
      blocked_reason: { type: "string", description: "仅当存在无法自行解决的真实阻塞或必须由用户提供的信息时填写具体原因（1–1000 字符）；保留未完成步骤，最终说明阻塞。后续正常更新不填写此字段会清除阻塞。" },
      acceptance: {
        type: "array", maxItems: 20,
        description: "可选：执行型任务的必要验收项。同一目标内已声明项不能删除或修改，可追加。省略会保留原项。paths 必须列出命令依赖的源码、测试和配置文件（最多 50 个不同文件）；运行时只验证所声明范围。",
        items: objectSchema({
          id: { type: "string", minLength: 1, maxLength: 64 },
          description: { type: "string", minLength: 1, maxLength: 500 },
          command: { type: "string", minLength: 1, maxLength: 8000 },
          paths: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 512 } },
        }, ["id", "description", "command", "paths"]),
      },
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
    execute: async ({ explanation = "", plan, blocked_reason, acceptance }, context) => {
      await context.dispatch({ type: acceptance !== undefined ? "PLAN_ACCEPTANCE_UPDATED" : "PLAN_UPDATED", explanation, steps: plan,
        ...(acceptance !== undefined ? { acceptance } : {}),
        ...(blocked_reason !== undefined ? { blockedReason: blocked_reason } : {}) });
      const active = plan.find((item) => item.status === "in_progress");
      if (blocked_reason) return `计划已保留，已记录阻塞：${blocked_reason}。请在最终答复说明阻塞与需要的输入，不要把未完成步骤标为 completed。`;
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
      const content = await readContainedTextFile(skill.boundary, skill.relativeFile, { maxBytes: 256_000 });
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
    refreshVerification: (context) => refreshVerification({ ...context, workspace: root }),
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

function workspacePathArrayCapability(argument, pathField, access, risk, readOnly) {
  return {
    risk,
    readOnly,
    resources: [{ kind: "workspace_path", argument, pathField, access }],
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

async function discoverSkills(roots) {
  const found = [];
  for (const source of roots) {
    try {
      const directory = await resolveContainedDirectory(source.boundary, source.relative);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const relativeFile = path.join(source.relative, entry.name, "SKILL.md");
        try {
          const first = await readContainedTextFile(source.boundary, relativeFile, { maxBytes: 64_000 });
          const description = first.match(/description:\s*(.+)/)?.[1] || first.split("\n").find((line) => line && !line.startsWith("#")) || "无描述";
          found.push({ name: entry.name, description, boundary: source.boundary, relativeFile });
        } catch {}
      }
    } catch {}
  }
  return found;
}

async function executeShell(execution, accessPolicy, command, signal, onOutput, timeoutMs) {
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
    timeoutMs,
  }), { signal, onOutput });
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

function toolMemoryMutationId(context, operation) {
  if (!Number.isSafeInteger(context.sourceCursor) || context.sourceCursor < 1) {
    throw new Error("Memory 工具写入需要 TOOL_REQUESTED durable cursor");
  }
  // Provider callId 可能被后续调用复用；游标才标识本次实际执行。
  // 只在首次请求构造 key，outbox retry/reconcile 原样使用已持久化的 ID。
  return `${context.state.id}:tool:${context.sourceCursor}:memory.${operation}`;
}
