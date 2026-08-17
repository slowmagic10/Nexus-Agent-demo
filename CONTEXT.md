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
