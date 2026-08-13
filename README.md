# Nexus Agent Prototype

> PROTOTYPE — 这是用于验证状态模型的临时代码，不是生产系统。

本原型要回答的问题是：把 Pi 的最小 Agent Core、OpenClaw 的 Workspace/Skills、Hermes 的记忆思路、OpenHands 的 EventStream，以及 Cline/Aider 的逐次审批组合起来后，这套交互与状态模型是否足够自然，值得吸收到正式平台？

## 一条命令运行

在项目根目录执行：

```bash
npm run demo
```

离线演示不需要 API Key。启动后输入 `/help` 查看可尝试任务。

接入任意支持 Chat Completions 工具调用的 OpenAI-compatible 服务：

```bash
OPENAI_API_KEY=你的密钥 \
OPENAI_MODEL=你的模型 \
OPENAI_BASE_URL=https://你的服务/v1 \
npm start
```

通过 `--workspace=/绝对路径` 可切换工作区；默认使用本仓库根目录。

## 首版融合了什么

- 小型 Agent Loop：模型 → 工具 → Observation → 下一轮，最多 8 步。
- 纯状态机与追加式事件：UI 可替换，核心逻辑可移植到 API/Gateway。
- Workspace 上下文：启动时读取 `AGENTS.md` 与 `SOUL.md`。
- 按需 Skills：扫描工作区 `.nexus/skills/*/SKILL.md` 和原型内置 Skills。
- 会话短期记忆：可写入、检索，退出即清空。
- 安全工具层：路径锁定工作区；读取自动执行；写文件和 Shell 每次审批；危险 Shell 命令硬拒绝；15 秒超时。
- 双模型路径：零配置离线演示，以及真实 OpenAI-compatible 模型。

## 当前刻意不做

数据库、长期记忆、MCP、浏览器、消息渠道、Docker 沙箱、并发任务和 Web UI 都不在本轮验证范围内。原型确认后，再把 Agent Core 与事件模型吸收到正式工程，并按 Gateway → MCP → 沙箱的顺序扩展。

## 风险边界

Shell 仍运行在本机，只是受审批、工作目录、危险模式拦截和超时保护；它不是完整沙箱。不要在含敏感数据或高权限凭据的目录中测试不可信模型。
