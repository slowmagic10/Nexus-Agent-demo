# Foundation decisions

> 2026-08-17 起的阶段性开发路线见 [`docs/开发路线.md`](./docs/开发路线.md)。当前方向是先建设可重放 Session、Tool Host、配置组合和最小 Capability Runtime，再进入沙箱、计划与委派。

## 已确认的基础设计

- 状态机保留：`idle → thinking → awaiting_approval/executing → completed/failed/cancelled` 覆盖本地基础闭环。
- EventStream 保留：CLI 可继续订阅完整状态；Web、审计和未来客户端优先按 durable cursor 消费 action 与增量 patch，不侵入 Agent Core。
- Model Context 独立投影：模型只能通过 `AgentSession.prepareModelRequest()` 获得 durable 消息、记忆和 Skills，不能直接读取完整 Session state。
- Context Window Plan 使用保守 token 估算并保留连续的最近完整 turn；工具协议不拆分，当前 turn 或固定上下文本身超限时在模型调用前 fail closed。
- Session Checkpoint 只是恢复加速投影：默认每 100 个 durable event 原子生成并校验；损坏时回退完整 journal，不改变 journal 的事实地位。
- SQLite schema 只通过有序 transaction migration 演进；event payload 自带独立 schema version，未知的未来版本 fail closed。
- Session Branch 使用“父 cursor 投影为新 baseline”语义：lineage 可追踪但 journal 独立，未决工具只闭合、不重放。
- 会话导出使用带稳定校验和的 Journal Archive，而不是 state dump；checkpoint 属于派生缓存，不进入归档。
- Journal Import 在写入前验证内容身份、cursor、schema、patch 和重放结果；workspace/ID 重定位后重新生成 patch，并在单一事务内落库。
- 工具策略独立于实现：当前 `never/always` 后续可扩展为 allowlist、session grant 和 sandbox policy。
- 记忆分层：会话短期记忆进入提示词；长期记忆独立保存、检索、查看和删除。
- Skills 按需加载：初始上下文只暴露目录，加载后再进入提示词，控制上下文体积。
- SQLite 作为本地持久层：追加式 session journal 是恢复事实来源，完整快照只保留为兼容层和查询索引；恢复时回到 `idle`，闭合未完成工具调用且不重放副作用。
- Gateway 保持薄传输层：会话协调器负责单会话串行、跨会话并发、审批、取消和订阅；HTTP/SSE 只映射协议。
- MCP 统一进入工具注册表：stdio 客户端负责协议生命周期，命名空间避免冲突，运行时统一审批。
- Web 控制台保持同源静态客户端：无额外前端构建链，直接复用 Gateway API 和 SSE。
- 中断是一级状态：模型、Shell 和 MCP 请求接收取消信号；关闭 Gateway 会主动取消仍在运行的任务。
- 敏感信息在落盘前脱敏：执行使用原始参数，事件、消息和工具结果保存过滤后的副本。

## 后续决策

- 是否根据 MCP `readOnlyHint` 提供用户可配置的会话级自动审批。
- 增量事件与全量状态快照是否拆成两个 SSE 通道。
- 长对话压缩和上下文预算的具体策略。
- Docker/VM 沙箱、身份认证与多租户隔离模型。
- MCP Streamable HTTP 和消息渠道适配器的优先级。
