# Nexus Agent

Nexus Agent 是一个可本地运行的 Agent 基础版：同一套核心同时服务命令行和 Web 控制台，支持工具调用、逐次审批、会话恢复、长期记忆、MCP 扩展与运行指标。

## 快速开始

需要 Node.js 22.5 或更高版本。离线演示不需要 API Key：

```bash
npm run demo
```

启动带 Web 控制台的本地 Gateway：

```bash
npm run gateway
```

然后打开 `http://127.0.0.1:4317`。可用 `npm run gateway -- --port=8080` 改端口。

接入支持 Chat Completions 工具调用的 OpenAI-compatible 服务：

```bash
OPENAI_API_KEY=你的密钥 \
OPENAI_MODEL=你的模型 \
OPENAI_BASE_URL=https://你的服务/v1 \
npm start
```

通过 `--workspace=/绝对路径` 可切换工作区；默认使用本仓库根目录。

## 基础能力

- Agent Loop：模型、工具、Observation 循环，默认最多 8 步，并有单轮 Token 预算。
- 状态与事件：追加式事件流、明确执行阶段、错误与取消状态，可供 CLI、Web 或其他客户端复用。
- 工具安全：路径锁定工作区；读操作自动执行；写文件、Shell、长期记忆修改及 MCP 操作逐次审批；危险 Shell 模式硬拒绝；工具有超时与取消信号。
- Workspace 与 Skills：读取 `AGENTS.md`、`SOUL.md`，按需加载 `.nexus/skills/*/SKILL.md`。
- 持久化：SQLite 保存会话、消息、事件、短期记忆、已加载 Skills 和跨会话长期记忆。
- 恢复与导出：按 ID 恢复会话，安全闭合中断的工具调用，并导出完整 JSON 快照。
- 可观测性：记录模型/工具调用数、审批数、Token 用量以及模型、工具和单轮耗时。
- 本地 Gateway：HTTP API、SSE 状态流、远程审批、取消、记忆管理和同源 Web 控制台。
- MCP stdio：支持 Tools、Resources、Resource Templates 和 Prompts；能力名称隔离并统一审批。
- 凭据脱敏：持久化工具参数、输出和错误前过滤常见 API Key、Token 与 Authorization 值。

## 会话、记忆与导出

运行状态默认保存在工作区的 `.nexus/nexus.db`，数据库与导出目录都被 Git 忽略。

```bash
# 查看保存的会话
npm run demo -- --sessions

# 恢复最近一次或指定会话
npm run demo -- --resume=latest
npm run demo -- --resume=session-xxxxxxxxxxxx
```

CLI 中可用：

- `/help`：查看命令与演示任务。
- `/long-memory`：查看长期记忆。
- `/export`：导出当前会话到 `.nexus/exports/`。
- `/quit`：保存并退出。

如果进程在审批或工具执行期间中断，恢复时会为未闭合调用补充“执行状态未知”的安全结果，不会自动重放可能有副作用的操作。

## Web 控制台与 Gateway API

Gateway 只允许绑定本机回环地址，并拒绝非本机网页来源。Web 控制台提供会话列表、消息发送、实时状态、运行指标、审批、取消、长期记忆和会话导出。

常用 API：

```text
GET    /health
GET    /sessions
POST   /sessions
GET    /sessions/:id
POST   /sessions/:id/messages
GET    /sessions/:id/events
POST   /sessions/:id/approvals/:callId
POST   /sessions/:id/cancel
GET    /sessions/:id/export
GET    /memories?query=关键词
POST   /memories
DELETE /memories/:id
```

示例：

```bash
# 创建会话
curl -X POST http://127.0.0.1:4317/sessions \
  -H 'content-type: application/json' -d '{}'

# 发送消息
curl -X POST http://127.0.0.1:4317/sessions/会话ID/messages \
  -H 'content-type: application/json' -d '{"content":"查看工作区文件"}'

# 订阅状态
curl -N http://127.0.0.1:4317/sessions/会话ID/events
```

## MCP 扩展

MCP 只在显式传入 `--mcp=配置文件` 时启用。仓库包含零依赖 Echo 样例：

```bash
npm run demo:mcp
npm run gateway:mcp
```

自定义配置：

```json
{
  "servers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "EXAMPLE_KEY": "value" }
    }
  }
}
```

然后运行 `npm run demo -- --mcp=你的配置.json`。命令使用 `command` 和 `args` 数组直接启动，不经过 Shell；环境变量会与 Nexus 进程环境合并。不要提交含密钥的 MCP 配置。

## 验证

```bash
npm test
```

测试覆盖会话保存与恢复、中断调用修复、长期记忆、指标、取消、敏感信息脱敏，以及 MCP Tools/Resources/Prompts。

## 安全边界与后续扩展

这是可用的本地基础版，不是多租户生产服务。Shell 仍在宿主机运行；审批、工作目录限制、危险模式拦截和超时不等同于完整沙箱。不要把 Gateway 通过反向代理暴露到公网，也不要在含高权限凭据的目录中运行不可信模型。

浏览器自动化、Slack/Discord 等消息渠道、MCP Streamable HTTP、Docker/VM 隔离、身份认证、细粒度策略与分布式任务队列属于后续扩展层，不影响当前本地基础闭环。
