# Prototype verdict

## 验证问题

审批、事件流、工具反馈、短期记忆与按需 Skills 组成的最小 Agent 状态模型，是否足够自然，值得进入正式平台？

## 初步结论

- 状态机应保留：`idle → thinking → awaiting_approval/executing → completed/failed` 足以覆盖首版闭环。
- EventStream 应保留：UI、审计和未来 Gateway 可以只订阅事件，不侵入 Agent Core。
- 工具策略应独立于工具实现：当前 `never/always` 可自然扩展为 allowlist、session grant 和 sandbox policy。
- 记忆需要分层：会话短期记忆可以进入提示词；长期记忆应异步提取、可查看、可删除，不能直接等同完整聊天记录。
- Skills 应按需加载：首屏只暴露目录，加载后再进入上下文，避免上下文膨胀。

## 等待实际试玩确认

- 审批发生在“工具请求之后、执行之前”的节奏是否合适？
- 完整状态是否缺少任务计划、预算或分支信息？
- 正式版优先做 Web 控制台，还是先做常驻 Gateway？
