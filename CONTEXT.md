# Nexus Agent

Nexus Agent 是一个本地优先、可执行、可恢复的 Agent Harness。本文件固定项目内的核心领域语言，避免不同入口和 Module 使用近义词表达同一概念。

## Language

**Agent Session**:
一次可持久化、可重放的 Agent 执行连续体；它拥有 durable event、状态投影和单调事件游标。
_Avoid_: Conversation, chat state

**Durable Session Event**:
已经原子写入 session journal、可用于恢复和审计的事实；只有 durable event 才能推进投影或对外发布。
_Avoid_: Log line, transient callback

**Model Context**:
由 durable session event 投影得到、允许模型看到的消息、短期记忆、相关长期记忆和已加载 Skills。
_Avoid_: Full state, UI state, prompt state

**Context Window Plan**:
一次模型请求对 Model Context 的确定性预算投影；固定计算 system prompt、Skills、工具 schema 和完整 turn 成本，只选择连续的最近完整 turn，并记录包含与省略数量。
_Avoid_: Message slice, token truncation

**Turn Budget**:
一次用户任务内所有模型调用的累计 Token 成本边界，与单次请求的 Context Window Plan 和工具循环 `maxSteps` 分别配置。步骤与累计 Token 默认均为 unlimited；用户显式设置边界后，达到边界的新工具调用必须在 Adapter 启动前停止并闭合模型工具协议，最终模型回答不能因事后预算检查而丢失。
_Avoid_: Hidden cap, context window equals cumulative cost, dropping a paid final response

**Objective**:
当前用户 turn 要完成的 durable 任务目标。`USER_MESSAGE` 创建新的 Objective；完成、失败、取消会同步闭合 Objective，恢复旧 Session 后收到新输入会先暂停旧 Objective。Objective 属于 Agent Session 投影，不是只存在于 system prompt 的提示词。
_Avoid_: Prompt-only goal, workflow definition, untracked task text

**Durable Plan**:
绑定当前 Objective 的可修订步骤投影。内置 `update_plan` 通过 Tool Host 写入 `PLAN_UPDATED` Durable Session Event；每个版本最多一个 `in_progress` 步骤，Objective 终止时 Plan 同步终止。它只表达当前单 Agent turn 的执行意图，不等同于 Workflow graph，也不承担 child delegation。
_Avoid_: Assistant prose checklist, workflow DAG, UI-only todo list

**Client Projection**:
客户端依据 durable event patch 维护的会话展示状态，不是恢复事实来源。
_Avoid_: Source of truth, session snapshot

**Session Checkpoint**:
从某个 durable event cursor 派生并带校验和的恢复加速投影；它可以丢弃或重建，不能替代 session journal 的事实地位。
_Avoid_: New baseline, source of truth

**Session Branch**:
从父 Agent Session 的指定 durable cursor 投影出的独立新 Session；它通过 lineage 引用父身份与 cursor，但拥有自己的 baseline 和后续 journal。
_Avoid_: Journal copy, child chat

**Journal Archive**:
包含连续 durable session event、schema 信息、lineage 和内容校验和的可移植导出；不包含可重建的 Session Checkpoint。
_Avoid_: State dump, snapshot export

**Journal Import**:
先验证 Journal Archive 的内容身份和重放一致性，再在单一事务中把 durable event 重定位到目标 workspace；可显式重映射 Session ID，失败时不产生部分 Session。
_Avoid_: JSON restore, snapshot upload

**Memory Scope**:
由 workspace、agentId、userId 组成并保存在 Agent Session 中的长期记忆授权边界；caller scope 必须参与每一次检索、读取、审计和 mutation，Memory ID 本身不是权限。
_Avoid_: Default global memory, ID-only access

**Memory Provenance**:
长期记忆的来源身份。工具写入必须引用真实存在且 callId 匹配的 Durable Session Event cursor，并且来源 Agent Session 的 Memory Scope 必须与 caller scope 完全一致；外部来源使用 externalRef，不能冒充本地 cursor。
_Avoid_: Projection event seq, unverified sourceEvent

**Memory Mutation Outbox**:
先由 Session Journal 持久化 mutation request，再以绑定规范化请求摘要的稳定 mutationId 写 Memory Adapter，最后持久化 applied event 的恢复协议。是否允许重放由 failure outcome 与 Adapter 明示的 mutationIdempotency 共同决定；恢复不能让单个坏 mutation 阻断新 turn，也不能把不确定副作用当成普通失败重复执行。
_Avoid_: Memory-first write, implicit side-effect replay

**Memory Mutation Issue**:
未能自动闭合的 Memory mutation 终态投影，保存原 mutation、错误、尝试次数、failure outcome 和处理策略；它不参与自动 reconcile。只有 retryable issue 可以 retry，所有 issue 可以 discard 或 resolve，pending 不能直接 resolve。
_Avoid_: Permanent pending, infinite automatic retry

**Memory Mutation Outcome**:
Adapter mutation 失败后的副作用确定性分类：safe_to_retry 表示确认未生效，outcome_unknown 表示可能已生效，non_retryable 表示确定不应重试。未类型化错误和 deadline 默认是 outcome_unknown；只有声明 mutation-key 幂等的 Adapter 才能安全重放这类 issue。
_Avoid_: Every error is retryable, timeout means no side effect

**Memory Flush Policy**:
在 turn 完成后从本轮对话提出长期记忆候选的独立 Policy。它调用模型提取、按 scope 检查重复事实，并通过现有 Memory mutation outbox 保存为 candidate；失败只写 degraded audit，不改变主 turn 的完成状态。SQLite Adapter 只负责存储，不承担会话理解或模型调用。
_Avoid_: Model extraction inside storage Adapter, auto-write active memory

**Candidate Memory**:
尚未进入 active 检索的长期记忆记录。候选保留 auto_extract provenance，必须由用户在 Web UI 中明确保留或忽略；保留使用 outbox 更新为 active，忽略使用带原因的软删除。
_Avoid_: Injecting unreviewed candidate into model context

**Tool Host**:
工具安全执行的 deep Module。AgentRuntime 只通过 schemas 与 execute Interface 使用它；参数校验、effects/idempotency 元数据、Policy decision、Approval、deadline、取消、结果脱敏和 durable audit 都集中在其 Implementation 内，Native 与 MCP 是两个真实 Adapter。
_Avoid_: AgentRuntime reading tool approval or execute implementation

**Tool Authorization Decision**:
Tool Host 在执行前根据 Capability Scope、Permission Profile、Workspace Policy 和 Session Grant 产生的可审计决定，绑定 callId、argsHash、toolVersion、policyVersion、capabilityHash、resources、Adapter、risk、profile、explanation 与命中规则。风险等级、沙箱边界和自动审批是独立维度；旧 never/always 字段不再决定权限。
_Avoid_: Prompt-only permission, approval without args identity

**Permission Profile**:
受信任用户选择的自动化姿态，把 Capability risk、资源访问和当前 WorkspaceExecution 隔离强度组合成 allow、approval_required 或 deny。`read-only` 允许普通读取，但对所有 mutation、网络和非只读 Shell 硬拒绝，Workspace Policy/Grant/Approval 均不能提权；Native/Docker 同时强制 workspace 只读，Local Shell fail closed。`workspace-auto` 面向本地开发易用性：普通工作区读写和 Native/Docker 沙箱内常规 Shell 自动执行；工作区内删除、动态解释器、Git 写入、安装与网络操作进入可复用到当前 Session 的 Approval；`.env*`、SSH/云凭据、宿主路径逃逸、sudo 与系统破坏命令仍硬拒绝。`workspace-confirm` 自动读取，但所有普通写入和 Shell 都确认并支持 Session Grant。Profile 不替代 Capability Scope 或 Sandbox；风险高不等于必须硬拒绝，是否能被沙箱限制与是否需要用户确认是两个独立维度。
_Avoid_: Risk level directly equals approval, auto-allowing unsandboxed shell, project config selecting elevated profiles

**Permission Tool Host Router**:
根据 durable Session `permissionProfile` 把同一个 Tool Host Interface 路由到 `read-only`、`workspace-confirm`、`workspace-untrusted`、`workspace-auto`、兼容档位 `approval-required` 或受限注册的 `danger-full-access` Policy。Web 切换只修改会话状态并清空旧 Grant，Router 在每次 schema/execute 时读取最新状态，因此并发 Session 不共享可变全局档位。危险 Host 只能在 `trusted-local` Gateway 注册，Native/Docker 下不存在；Gateway 创建或切换危险 Session 都要求显式确认标记。
_Avoid_: Global mutable profile, UI-only permission labels, switching during execution, unavailable profile falling back to a stronger host

**Access Policy**:
Permission Profile 对 typed resource 的统一判断 Implementation。Tool Host 在 Adapter 前授权，文件 Tool 在直接 fs 访问前按 Session Profile 复用同一策略，search/list 过滤 `.env*`、`.nexus/config.local.json` 与 SSH/云凭据；Shell command 作为 typed resource 进入授权与 durable explanation。`.nexus/.agents/.codex/.git` 除本机秘密配置外读取允许、直接写入需确认；Native/Docker 的 workspace 写隔离负责限制宿主，Tool Host Approval 负责确认 workspace 内风险。`read-only` 不产生可扩权 Approval，并把 `filesystemMode` 传入 WorkspaceExecution：Native 移除 workspace 写根，Docker 使用 readonly mount，Local 无法强制时 fail closed。Native Seatbelt 继续对 workspace/宿主秘密做第二层强制拒绝；trusted-local 完全访问则显式选择无保护分类，避免授权层和执行层使用不同 Profile。
_Avoid_: Separate sensitive-path regexes per tool, shell-only filesystem protection, authorization that implementation can bypass

**Trusted Network Target**:
只来自可信环境或 CLI 的规范 IPv4:TCP 目标。目标列表进入 Permission Profile version；直接网络命令必须显式命中目标，可签发 once/session Approval，但 Session Grant 仍绑定完全相同的命令资源。批准后的 `ExecutionSpec.networkTargets` 让 Native Seatbelt 为该进程树生成精确 `remote tcp` 出站规则，未声明目标、入站、bind、Local/Docker 假隔离均 fail closed。共享 workspace JSON、Workspace Policy 和 Grant 都不能创建新目标。
_Avoid_: Domain wildcards, project-controlled network enablement, session/project grants for network expansion, approval that silently runs with unrestricted networking

**Capability Scope**:
Tool Definition 对副作用、risk、readOnly 与 typed resources 的声明边界。workspace_path 在 Adapter 启动前解析并校验；Capability 内容进入 capabilityHash 和 toolVersion。
_Avoid_: Inferring permissions only from tool name or description

**Workspace Policy**:
工作区 `.nexus/tool-policy.json` 中的简单三态授权规则。显式 deny 优先；从 workspace 加载的规则只能维持或收紧 Permission Profile，不能把 approval_required/deny 提升为 allow。每个决定必须给出 policyVersion、ruleId、profile、reason 和 explanation。
_Avoid_: Prompt-only policy, workspace allow elevating a trusted profile, grant overriding deny

**Session Grant**:
绑定 sessionId、workspace、tool、capabilityHash、policyVersion 与精确资源范围的 durable 授权。Approval 显式选择 once/session：once 绑定当前 callId/argsHash 并在 Adapter 启动前 durable consume；session 最长 8 小时，只在当前 Session 与 workspace 复用。Grant 可过期或撤销，不能跨 Session/workspace 使用；Shell 资源只保存摘要。
_Avoid_: Global reusable approval, replayable call-bound grant, grant without policy identity

**Project Grant**:
由用户在实时 Approval 中显式签发、存放于用户私有 SQLite Store 的跨 Session 授权。它绑定规范 workspace 身份、tool、capabilityHash、policyVersion 与精确资源，最长 30 天；工作区文件不能创建或提升 Project Grant。移动/复制 workspace 不复用，策略或 Capability 变化后不命中，并提供列出、撤销和审计。Web Grant Manager 只投影未消费、未撤销且未过期的授权，显示脱敏资源与到期时间；撤销时由 Gateway 核对真实 scope，运行中 fail closed。
_Avoid_: Project grants stored in the repository, raw secret-bearing shell commands, path-agnostic global grants

**Tool Execution Unknown**:
有副作用且非 safe 的工具在 timeout、cancel 或进程中断时无法证明是否生效的终态。它写入 durable audit，补全工具协议，并禁止自动重放。
只有 Adapter Implementation 已经启动且结果不可证明时才进入 unknown；启动前取消属于确定未执行，补全 cancelled result。
_Avoid_: Timeout means no side effect, automatic replay after crash

**Config Composition**:
把内置默认值、workspace profile、本机私有配置、环境变量和 CLI 覆盖合成为唯一 RuntimeConfig 的 deep Module。每个 leaf 字段保留最终来源；CLI/Gateway 只消费规范化结果，inspection 永不返回原始 Secret。workspace 内 JSON 配置不能启用 MCP、切换 WorkspaceExecution 或选择 Permission Profile，只有受信任环境或显式 CLI 可以。
_Avoid_: Entrypoint-specific parsing, hidden precedence, printing raw secrets, process launch from workspace config

**Capability Runtime**:
管理运行时能力实现的 owner、registration identity、active index、lease、撤销和 dispose。Capability Scope 描述“能做什么”，Capability Runtime 描述“实现当前是否存在以及由谁拥有”。撤销先隐藏能力并禁止新 lease，再等待在途 lease，最后清理 owner 资源。
_Avoid_: Static global registries, silent replacement, dispose before visibility revocation, executing through stale capability references

**WorkspaceExecution**:
Tool 与实际执行环境之间的稳定接口。Tool 产生显式 ExecutionSpec，Native/Local/Docker/Remote Adapter 负责 cwd、环境、进程和输出；Tool Host 仍负责 Capability、Policy、Approval、deadline、取消与 unknown 副作用。macOS 默认使用 NativeSandboxAdapter/Seatbelt；LocalWorkspaceAdapter 仅为显式 trusted-local；Docker 是显式可选后端。原生沙箱依赖缺失或平台未实现时 fail closed，不允许回退到 unrestricted。
_Avoid_: child_process inside Tool Registry, full process.env inheritance, shell:true, project config selecting execution mode, silent sandbox fallback, treating OS sandbox or Docker as VM isolation
