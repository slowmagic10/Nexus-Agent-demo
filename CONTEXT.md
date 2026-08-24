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
Tool Host 在执行前根据 Tool Definition 产生的可审计决定，绑定 callId、argsHash、toolVersion、effects、idempotency、Adapter 和 risk。当前首版从 never/always 兼容字段得到 allowed/approval_required，未来由 Capability Scope 与 Workspace Policy 深化。
_Avoid_: Prompt-only permission, approval without args identity

**Tool Execution Unknown**:
有副作用且非 safe 的工具在 timeout、cancel 或进程中断时无法证明是否生效的终态。它写入 durable audit，补全工具协议，并禁止自动重放。
只有 Adapter Implementation 已经启动且结果不可证明时才进入 unknown；启动前取消属于确定未执行，补全 cancelled result。
_Avoid_: Timeout means no side effect, automatic replay after crash
