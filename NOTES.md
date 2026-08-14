# Foundation decisions

## 已确认的基础设计

- 状态机保留：`idle → thinking → awaiting_approval/executing → completed/failed/cancelled` 覆盖本地基础闭环。
- EventStream 保留：CLI、Web、审计和未来客户端只订阅状态，不侵入 Agent Core。
- 工具策略独立于实现：当前 `never/always` 后续可扩展为 allowlist、session grant 和 sandbox policy。
- 记忆分层：会话短期记忆进入提示词；长期记忆独立保存、检索、查看和删除。
- Skills 按需加载：初始上下文只暴露目录，加载后再进入提示词，控制上下文体积。
- SQLite 作为本地持久层：每次状态迁移保存快照；恢复时回到 `idle`，闭合未完成工具调用且不重放副作用。
- Gateway 保持薄传输层：会话协调器负责单会话串行、跨会话并发、审批、取消和订阅；HTTP/SSE 只映射协议。
- MCP 统一进入工具注册表：stdio 客户端负责协议生命周期，命名空间避免冲突，运行时统一审批。
- Web 控制台保持同源静态客户端：无额外前端构建链，直接复用 Gateway API 和 SSE。
- 中断是一级状态：模型、Shell 和 MCP 请求接收取消信号；关闭 Gateway 会主动取消仍在运行的任务。
- 敏感信息在落盘前脱敏：执行使用原始参数，事件、消息和工具结果保存过滤后的副本。

## 后续决策

- 是否根据 MCP `readOnlyHint` 提供用户可配置的会话级自动审批。
- 增量事件与全量状态快照是否拆成两个 SSE 通道。
- 长对话压缩、任务分支和上下文预算的具体策略。
- Docker/VM 沙箱、身份认证与多租户隔离模型。
- MCP Streamable HTTP 和消息渠道适配器的优先级。
