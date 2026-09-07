# Nexus Agent 提前结束诊断

诊断日期：2026-09-07。只读检查真实数据库，离线回放捕获回答；未调用真实模型、未修改业务代码或原始会话日志。

## 对象与结论

- 项目：`/Users/nick/Documents/ChatGPT/Nexus Agent`
- 被检查任务：Mini Tower Defense
- 工作区：`/Users/nick/Nexus Projects/test`
- 日志：`/Users/nick/Nexus Projects/test/.nexus/nexus.db`
- 会话：`session-f9abaa04-3a6`
- 模型：`/models/Qwen3.8-27B-FP8`，OpenAI-compatible Adapter。

用户原始要求已明确写入 USER_MESSAGE（Journal seq 2），包括“如果发现问题，请自行修改并重新测试”“不要只生成代码后立即停止”“请直接开始开发，不需要向我确认需求”。问题不在于需求缺少自主执行授权。

直接原因已证实：模型返回普通正文，未发出结构化 tool_calls，finishReason 为 stop；AgentRuntime 将这次模型输出结束直接认作任务完成。异常正文仍声称下一步要写调试脚本或检查 UI，并非完整交付。

## 时间线

以下均为北京时间 2026-09-04；seq 指 session_events 数据表的 Journal seq，不是 patch 中 semantic event 的 seq。

| 时间 | Journal seq | 事实 |
|---|---|---|
| 11:22:08 | 2 | 原始完整开发与验证需求进入日志。 |
| 12:36:19 | 608–609 | npm install 的 Shell 执行超时 180000ms，结果记为 execution_unknown。随后任务继续，不是后述误判完成的直接触发。 |
| 12:46:45 | 748 | CANCELLED，reason 为“用户通过 Gateway 取消了任务”。日志仅证明 Gateway 取消入口被调用，不能独立确定实际操作人。 |
| 12:50:06 | 751 | 用户输入“继续吧”。此前会话恢复、执行环境切到 local-workspace，权限切到 danger-full-access。 |
| 12:53:42 | 862–864 | stop → 无工具 assistant 正文 → COMPLETED；正文说“62/66 通过，但 4 个失败值得深究”“我写个定向调试脚本”，后接文字形式的 write_file，未真正调用。 |
| 12:55:18 | 868 | 用户输入“修复检查看下”。 |
| 12:56:22 | 954–956 | stop → 无工具 assistant 正文 → COMPLETED；正文仅为带压缩标记的 run_shell 文本。 |
| 13:30:37 | 960 | 用户输入“修复好了吗”。 |
| 13:37:19 | 1411–1413 | 同类误判完成；正文说要定位 updateTowerPanel 行号，后接文字形式的 run_shell。 |
| 13:38:02 | 1417 | 用户输入“现在修复好了吗”。 |
| 13:38:12 | 1431–1433 | 同类误判完成；正文仍说“还剩最后一个 UI 细节要核实”，没有真正执行随后写出的命令。 |
| 13:38:41 | 1469–1471 | 回答“我怎么启动游戏”，给出启动说明后结束。 |

## 证据链

四条异常 ASSISTANT_MESSAGE（seq 863、955、1412、1432）都包含：

```text
[历史工具调用；完整参数见 durable journal]
…[历史工具内容已省略中段]…
```

这些正文与所属模型步骤的 MODEL_STREAM_DELTA 拼接结果逐字一致。标记在模型服务返回的输出流里就已存在，之后才写入 ASSISTANT_MESSAGE。当前 Provider 直接转发 delta.content，因此不能把它归因于 UI 将正常工具调用显示成摘要，或 Context 投影事后改写了这些新回答。本地日志不能进一步区分模型本身生成与上游服务端格式化。

四次停止前的 MODEL_CONTEXT_PREPARED 均启用了 historyProjection；历史工具协议在入模前被改写为 assistant 普通正文，格式与异常新输出一致。这支持“模型模仿历史工具摘要格式”的解释，但没有真实模型 A/B 对照，不能声称单靠更改压缩格式就必然消除所有提前结束。

## 对应实现

- `src/core/model-context.js:431`：把历史 assistant tool_calls 改写为 `role: assistant` 的普通摘要正文。
- `src/core/model-context.js:539`：上述中段省略标记的来源。
- `src/providers/openai-compatible.js:65`：读取 delta.content 并直接产出 text_delta。
- `src/core/agent.js:128`：没有 toolCalls 就立即派发 COMPLETED，没有任务验收或未完成工作检查。
- `src/core/state.js:768`、`:1118`：COMPLETED 将 Objective、Plan 整体状态置为 completed，即使 Plan 子步骤仍 pending/in_progress。
- `src/core/state.js:91`：每条 USER_MESSAGE 都新建 Objective，并在第 106 行清空 Plan。因此“继续吧”替换了当前 durable 目标；原始需求仍在消息历史中，但不再作为当前 Objective/Plan 单独跟踪。
- `src/workspace.js:29`：已存在持续执行到完成并验证的系统提示。仅重复加强用户措辞不足以修复运行时缺口。

## 排除与区分

- 初始 Agent Profile 的 maxSteps、maxTokensPerTurn 均 unlimited，没有累计预算或步骤上限触发记录。
- 全会话 76 个成功返回的模型步骤中，71 个 finishReason 为 tool_calls，5 个为 stop；没有 length、max_output_tokens 或 content_filter。
- 四次异常停止前上下文估算分别为 23452、21162、27737、27051，低于当时 32000 目标；omittedMessages 和 omittedTurns 均为 0。未发现 Provider overflow 导致这些停止。
- 当时窗口目标仍为 32000，直到 15:17 恢复时才记录升级为 1000000。扩大窗口本身不改变“无工具调用即完成”的控制流。
- MEMORY_FLUSH_DEGRADED 的 5 秒超时发生在 COMPLETED 之后，是结束后的记忆提取降级，不是触发这些轮次结束的原因。
- 早期确有网络/沙箱相关工具失败，包括 npm 超时、ENOTFOUND、Operation not permitted；它们与 12:46 的取消属于需要单独处理的执行问题。

## 离线复现

使用真实捕获的四条回答与 finishReason，通过当前 AgentRuntime、AgentSession 和 reducer 在内存中回放；预设 Plan 含 in_progress/pending 步骤。工具 Adapter 仅计数，不执行命令，不请求真实模型。

四个用例都得到：

```json
{"phase":"completed","objectiveText":"继续吧","planStatus":"completed","stepStatuses":["in_progress","pending"],"modelCalls":1,"toolExecutions":0}
```

这确定性复现了运行时误判完成；不等价于重新运行整个游戏开发任务，也没有验证真实模型对压缩格式的敏感程度。

## 建议修复顺序

1. 增加完成检查：区分模型这一步输出结束与用户任务完成。对于已知未完成计划、未完成验证、异常工具摘要文本，要求模型纠正并继续；设有限重试与明确阻塞状态，避免无限自动循环。不得直接解析执行普通正文里的命令或截断参数。
2. 调整上下文摘要呈现：明确标注摘要为历史数据，不是新工具调用范例；保留必要的真实工具协议示例，针对当前 Provider/模型做对照测试。保留上下文优化能力。
3. 将任务目标与用户消息轮次区分：继续/状态询问应保留原始目标、计划与验收状态；完成目标应有独立的状态转换。
4. 给这四条真实异常输出建立回归用例，并另测正常完成、真正阻塞、用户取消、输出截断，避免修复后无法正常停止。
