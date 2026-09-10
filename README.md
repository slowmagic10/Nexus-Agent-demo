# Nexus Agent

Nexus Agent 是一个可本地运行的 Agent 基础版：同一套核心同时服务命令行和 Web 控制台，支持工具调用、本次/会话审批、会话恢复、长期记忆、durable Objective/计划、MCP 扩展与运行指标。

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

CLI 与 Web Gateway 默认使用 `~/Nexus Projects/Default`，不再把 Nexus 源码仓库当作 Agent 的工作区。Web 点击“新建任务”会先选择项目，也可以直接输入名称创建一个独立目录；每个项目拥有自己的文件、Session Journal、Artifact 和 Memory scope，任务创建后不能在中途切换工作区。源码仓库原有会话仍可从“`Nexus Agent（旧工作区）`”项目打开，不做隐式搬迁。

可用 `NEXUS_PROJECTS_ROOT=/绝对路径` 或 `--projects-root=/绝对路径` 修改受管项目根目录；`--workspace=/绝对路径` 继续用于 CLI 显式工作区或把一个已有目录设为 Gateway 默认项目。受管新项目只允许创建为 Projects Root 的直接子目录，项目列表本身不会启动 MCP 或执行环境，真正创建/恢复任务时才懒加载该项目 Runtime。

项目中的 `AGENTS.md`、`SOUL.md` 和 `.nexus/skills/*/SKILL.md` 会影响模型行为，因此只读取 Workspace 边界内的普通文件；指向宿主其他位置的符号链接会被忽略。快速连续选择项目或任务时，旧请求的迟到结果也不会覆盖最后一次选择。

## 本地模型 API 配置

Nexus 不绑定特定模型厂商。仓库提供通用的 `.env.local.example`，本机实际配置使用 `.env.local`；该文件已被 Git 忽略，API Key 不会进入提交。

当前只有 DeepSeek Key 时，可以使用下面的配置；以后切换其他 OpenAI-compatible 服务，只需替换接口和模型，不需要修改 Nexus 代码：

```dotenv
OPENAI_API_KEY=你的API密钥
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-flash
NEXUS_CONTEXT_WINDOW_TOKENS=32000
NEXUS_PROVIDER_THINKING=disabled
NEXUS_MAX_STEPS=unlimited
```

`NEXUS_PROVIDER_THINKING` 支持 `provider-default / enabled / disabled`。`provider-default` 不向服务端发送思考开关，保持 Provider 自身默认行为；[DeepSeek 当前文档](https://api-docs.deepseek.com/guides/thinking_mode/)说明思考默认启用且默认 effort 为 high，因此本地连续工具任务优先使用 `disabled`，复杂分析 Profile 可显式使用 `enabled`。该开关只对 OpenAI-compatible Adapter 生效；原生 Responses Adapter 若收到显式开关会在启动时拒绝配置，而不会静默忽略。CLI 也可使用 `--provider-thinking=disabled`。

`NEXUS_CONTEXT_WINDOW_TOKENS` 声明当前模型真实支持的 Context Window，默认值为 `32000`，CLI 可用 `--context-window-tokens=1000000` 临时覆盖。该值不是累计任务 Token 限制：Nexus 仍会持续精简已闭合的旧工具记录、使用 Artifact 引用，并在接近窗口时组合语义摘要与最近完整轮次。当前本地 vLLM 若在 `/v1/models` 中报告 `max_model_len=1000000`，应将这里设置为 `1000000`，避免仍按历史默认值提前规划上下文。

可选的请求策略把真实容量、常用输入目标和输出上限分开，未配置时保持现有行为：

| 配置字段 | 环境变量 / CLI | 行为 |
| --- | --- | --- |
| `provider.contextTargetTokens` | `NEXUS_CONTEXT_TARGET_TOKENS` / `--context-target-tokens` | 主任务的常用输入目标，不发送给模型接口 |
| `provider.maxOutputTokens` | `NEXUS_MAX_OUTPUT_TOKENS` / `--max-output-tokens` | 显式发送的输出上限，也用于输入规划的容量预留 |
| `provider.outputTokenParameter` | `NEXUS_OUTPUT_TOKEN_PARAMETER` / `--output-token-parameter` | Compatible 服务使用 `max_tokens` 或 `max_completion_tokens`，必须按实际支持显式选择 |
| `provider.streamUsage` | `NEXUS_STREAM_USAGE` / `--stream-usage` | 仅 Compatible 流式请求发送 `stream_options.include_usage=true`；默认不发送 |

例如窗口为1,000,000、输入目标64,000、输出上限16,000时，有效输入目标为64,000；窗口32,000、目标31,000、输出上限8,000时，有效输入目标为24,000。公式为 `min(contextTargetTokens ?? contextWindowTokens, contextWindowTokens - (maxOutputTokens ?? 0))`。这些是配置示例，没有作为默认值启用，也不代表已测得最佳参数。目标不能超过容量，输出上限必须小于容量。

Compatible 设置输出上限时必须同时选择参数名；Responses 只使用 `max_output_tokens`，不接受 Compatible 专用字段。前面三个可选配置可通过 JSON `null` 或环境变量/CLI 的 `provider-default` 重置，`streamUsage` 使用严格的 `true/false`。具名 Profile 可独立覆盖；切换 Adapter 不继承不兼容的接口选项，`--demo` 清除真实请求选项但保留输入规划目标。

输入目标仍是规划目标：完整当前轮或固定上下文超出本地估算时不会仅因此被截断或结束，真实 overflow 仍走有限重规划。主调用、摘要和记忆提取共用 Provider 的输出上限；辅助调用的输入仍使用各自已有的有界批次。上限过小可能产生不完整回答，需要按真实任务验证。Web 上下文面板显示容量、目标和预留；Profile Drift 与任务评测的独立合同 Hash 记录请求参数变化。详见 [第四轮实施记录](docs/16-Harness模型请求契约与上下文预算实施记录-2026-09-08.md)。

`--demo` 是强制离线模式：它会把 Thinking 重置为 `provider-default`，并忽略所有具名 Profile 的真实 Provider 覆盖，但保留 Profile 的指令、权限和预算。`--demo` 不能与显式 `--provider` 或 `--provider-thinking` 同时使用；环境文件中的真实 Provider 配置不会妨碍 Demo 启动。

如果要使用 OpenAI 原生 Responses API，需要显式选择对应 Adapter；`auto` 仍保持 OpenAI-compatible 行为，不会改变现有 DeepSeek 配置：

```dotenv
NEXUS_PROVIDER=openai-responses
OPENAI_API_KEY=你的OpenAI密钥
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=你的OpenAI模型ID
```

也可以在 Nexus 应用目录的 `.nexus/config.local.json` 中，通过全局 `provider` 或具名 Agent Profile 设置 `"type": "openai-responses"`。该可信配置固定在应用目录，不会随所选 Project Workspace 改变；项目内部的同名文件不参与配置合成。原生 Adapter 使用 Responses 的 `instructions/input/function_call/function_call_output` 结构，主 turn 支持流式正文、工具调用和用量统计；工具往返需要的加密 reasoning item 会进入 durable Session，但不会作为可见思维文本展示。Context Summary 与 Memory Flush 继续调用同一个 Adapter 的非流式入口。

启动本地模型 CLI：

```bash
npm run local
```

启动本地模型 Web 控制台：

```bash
npm run gateway:local
```

然后打开 `http://127.0.0.1:4317`。旧的 `.env.deepseek.local` 和 `deepseek` 启动命令会继续作为兼容入口工作，因此现有私密 Key 不需要重新填写；新配置统一使用 `.env.local`。

单次任务的模型/工具循环次数与累计 Token 默认都不限制，Agent 会持续运行到模型确认完成、遇到阻塞、需要审批/用户输入或用户主动取消。会话中的用户消息轮次本身也没有总数限制。

如果需要主动设置成本边界，可通过 `NEXUS_MAX_STEPS=20` / `--max-steps=20` 限制循环次数，通过 `NEXUS_MAX_TOKENS_PER_TURN=500000` / `--max-tokens-per-turn=500000` 限制累计 Token；`unlimited` 或 `0` 恢复为不限制。这两项与 `NEXUS_CONTEXT_WINDOW_TOKENS` 相互独立：前者控制一次任务的累计成本，后者描述单次模型请求的窗口能力。审批、取消和沙箱边界仍然生效。`run_shell` 默认不设置自动 deadline；需要上限时由模型或调用方显式传入 `timeout_ms`，其他工具自己的 deadline 不受影响。

`run_shell` 是前台工具调用：省略 `timeout_ms` 时会持续等待命令退出，并通过现有 durable output stream 展示进度；例如 `{ "command": "npm test", "timeout_ms": 1800000 }` 可设置 30 分钟上限。无自动 deadline 不等于后台任务，用户仍可随时点击停止或按 `Esc`，取消会终止整个执行进程树并留下可恢复的终态记录。

配置按以下顺序覆盖：内置默认值、Project Workspace 的 `nexus.config.json`、Nexus 应用目录的 `.nexus/config.local.json`、环境变量/`.env.local`、命令行参数。共享的 `nexus.config.json` 不允许保存 API Key，也不能选择 `provider.type/baseUrl`，避免项目内容把本机密钥重定向到其他 Endpoint；项目内部的 `.nexus/config.local.json` 默认不会被读取。Provider Endpoint 只能来自应用级私有配置、受信任环境变量或 CLI。私有 JSON 和 `.env.local` 均由 Git 忽略。确需使用另一份本机配置时，可显式传 `--local-config=/绝对路径` 或设置 `NEXUS_LOCAL_CONFIG`；这代表用户信任该文件。为防止不可信 workspace 在启动时拉起任意子进程或降低权限边界，Workspace 配置不能启用 MCP、选择执行环境或全局 Permission Profile；这些能力只能由受信任环境变量或显式 CLI 参数启用。应用级具名 Agent Profile 可以选择预先支持的安全权限档位，但不能配置 `danger-full-access`。

Nexus 应用目录的 `.nexus/config.local.json` 还可以定义具名 Agent Profile。它们复用当前 Provider，但可分别设置附加指令、默认权限和预算；非默认 Profile 使用自己的 Memory `agentId`，不会与其他 Agent 的长期记忆混用：

```json
{
  "provider": {
    "type": "openai-compatible",
    "apiKey": "你的本机密钥",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "thinking": "disabled",
    "contextWindowTokens": 32000
  },
  "agents": {
    "default": "coding",
    "profiles": {
      "coding": {
        "label": "开发 Agent",
        "description": "连续实现与验证",
        "instructions": "优先交付可运行实现",
        "permissionProfile": "workspace-auto",
        "provider": { "model": "deepseek-v4-flash" }
      },
      "review": {
        "label": "审查 Agent",
        "description": "只读检查与问题报告",
        "instructions": "只报告问题，不修改文件",
        "permissionProfile": "read-only",
        "maxSteps": 20,
        "maxTokensPerTurn": 50000,
        "provider": { "model": "deepseek-reasoner", "thinking": "enabled", "contextWindowTokens": 65536 }
      }
    }
  }
}
```

Web 左侧的“新任务 Agent”用于显式选择；CLI 可使用 `--agent-profile=review` 或 `NEXUS_AGENT_PROFILE=review`。每个 Profile 的 `provider` 可覆盖 `type/apiKey/baseUrl/model/thinking/contextWindowTokens`，未填写字段继承最终全局 Provider 配置，因此同一个 DeepSeek Key 通常只需配置一次。Profile 选择只在创建新 Session 时生效，恢复会话继续使用其 durable Profile；如果配置中已删除该 Profile，恢复会明确失败而不会静默换 Agent。`thinking` 与 `contextWindowTokens` 都会进入 durable Agent Profile Snapshot，恢复时的变化可在 Web 配置漂移中看到。`--print-config` 会脱敏所有 API Key，也不会打印指令正文。当前不根据任务内容自动选模型，不做 active turn 热切换、Provider fallback 或模型名/Endpoint 猜测。

可用下面的命令查看最终生效配置及每个字段的来源；API Key 只会显示为 `[REDACTED]`：

```bash
npm start -- --print-config
npm run gateway:local -- --print-config
```

macOS 默认使用系统 Seatbelt 原生沙箱，不需要 Docker。`local` 是显式 trusted-local 开发模式；Docker 是可选后端，且只使用本机已有镜像，不自动拉取、失败也不会回退到宿主执行：

```bash
# 默认：macOS Seatbelt workspace-write，宿主工具链可读、凭据受保护、仅 workspace/临时目录可写、禁网
npm start

# 仅在明确接受宿主机直接执行时使用
npm start -- --execution=local

# 可选 Docker：需要 Docker CLI 和预先存在的本机镜像
npm start -- --execution=docker --docker-image=node:22-alpine

# Native Sandbox：只开放精确 IPv4:TCP 目标，可选择本次或本会话审批
npm start -- --network-target=192.168.121.110:22
```

可用 `NEXUS_EXECUTION=native|local|docker` 选择环境；Docker 还需 `NEXUS_DOCKER_IMAGE`。当前 Native Adapter 先支持 macOS；在嵌套沙箱、缺少 Seatbelt 或尚未支持的平台上会 fail closed，不会静默切换到 trusted-local。

默认权限档位是 `workspace-auto`。风险等级、沙箱和审批分别判断：

- 普通工作区文件写入，以及 Native/Docker 沙箱内的测试、构建、查看状态等常规命令自动执行；
- 工作区内删除、`find -delete`、Git 元数据修改、依赖安装、网络访问，以及 `sh -c`、`python -c`、`node -e`、命令替换等动态执行请求确认，可选择“本次”或“本会话”；
- 所有 `.env*` 变体、workspace/宿主 SSH 与云凭据、home shorthand、工作区外路径、`sudo/shutdown/mkfs` 等系统级破坏命令继续直接拒绝；
- `.git/.agents/.codex/.nexus` 除 `.nexus/config.local.json` 等明确秘密外允许读取，直接写入请求确认；Native/Docker 负责把写入限制在 workspace，审批只决定是否允许这次工作区内风险操作；
- Memory 修改和 MCP 非只读操作仍要求审批；
- 显式 `--execution=local` 时 Shell 不受 OS 沙箱保护，因此普通命令也继续要求审批。

希望所有修改都先确认时，可通过 `NEXUS_PERMISSION_PROFILE=workspace-confirm` 或 `--permission-profile=workspace-confirm` 启用“每次确认”：普通读取自动执行，文件写入和 Shell 请求确认，并可记住到当前 Session。打开不完全信任的仓库时仍可选 `workspace-untrusted`：普通文件编辑自动执行，但 Shell 只自动允许沙箱内明确的只读检查命令。`approval-required` 作为旧配置兼容档位继续支持；共享 workspace JSON 不能选择这些档位。

只做分析、审查或 Plan 工作时，可通过 `NEXUS_PERMISSION_PROFILE=read-only` 或 `--permission-profile=read-only` 启用“只读模式”。普通工作区读取可执行；写文件、Memory mutation、MCP 写操作、网络和非只读 Shell 直接拒绝，Workspace Policy、Session/Project Grant 与单次审批都不能把它提升为可写。Native Adapter 会移除 workspace 写根，Docker Adapter 使用只读挂载；trusted-local 无法提供 OS 级只读保证，因此 `read-only` 下的 Shell fail closed。只读 Shell 仅在 Native/Docker 中开放固定 PATH 的 `pwd`、无路径 `ls` 和无显式搜索根的 `rg` 最小集合。

每次决定都会在 durable event 和 Web 审批卡中记录命中的 Profile、规则、风险和拦截原因。Web 输入框提供会话级权限菜单：`只读模式` 对应 `read-only`，`每次确认` 对应 `workspace-confirm`，`谨慎工作区` 对应 `workspace-untrusted`，`帮我批准` 对应默认的 `workspace-auto`；切换会持久化并清空旧 Grant，运行中的会话不能改变权限。`完全访问` 只在 Gateway 由用户显式以 `--execution=local` 启动时可用，必须经过红色二次确认；Native/Docker 下保持不可用，workspace 配置也不能启用。

需要审批时可以选择：`仅本次`、`本会话允许`、`本项目允许`。仅本次授权使用后立即消费；本会话授权只复用完全相同的工具与资源，最长 8 小时；本项目授权可跨同一规范 workspace 的 Session 复用，最长 30 天。项目授权保存在用户私有 SQLite Store：macOS 默认为 `~/Library/Application Support/Nexus Agent/project-grants.db`，Linux 默认为 `$XDG_DATA_HOME/nexus-agent/project-grants.db`，可用可信环境变量 `NEXUS_USER_DATA_DIR` 改变目录。共享 workspace 配置不能签发项目授权；Shell 授权只保存命令摘要，不持久化原始命令。Gateway 可通过 `GET /sessions/:id/grants` 查看有效授权，通过 `POST /sessions/:id/grants/:grantId/revoke` 撤销。

Web 任务详情中的“授权”页签会显示当前尚未消费、撤销或过期的 Session/Project Grant，包括授权范围、工具、脱敏后的精确资源和到期时间。撤销采用二段式确认，成功后立即从列表移除并写入 durable audit；任务运行期间禁止撤销。已经消费的 `once` Grant 不会继续显示，撤销 API 也会核对客户端 scope 与 Grant 真实 scope。

`danger-full-access` 的历史 Session 状态不是新的授权凭证：Gateway 重启后只有再次携带显式确认才能按完全访问恢复，否则会 durable 降级为 `workspace-auto`。Journal 导入永远先降级危险档位，并记录 `permission.profile_downgraded`；用户之后仍可通过红色确认重新启用。

启用 `完全访问` 后，当前会话的本机 Shell 默认不再请求审批，并可在当前系统账户权限范围内读取宿主文件、访问互联网或执行破坏性命令；显式 Workspace Policy deny 仍然优先。这不是沙箱模式，不应用于不可信仓库或多租户环境。

Native Sandbox 默认完全断网。需要连接固定服务器时，可重复传入 `--network-target=IPv4:port`，或通过可信环境/本机 `.env.local` 设置逗号分隔的 `NEXUS_NETWORK_TARGETS`。首版只接受 IPv4 字面量和 TCP 端口，只支持 `execution.type=native`；共享 `nexus.config.json` 与 `.nexus/config.local.json` 不能开启网络，通配符、域名和未声明目标均拒绝。

当 `ssh/curl/expect` 等直接网络命令显式包含唯一匹配的可信 IP 时，权限层提供“仅本次/本会话”审批；Session Grant 仅复用完全相同的命令资源。批准后 `ExecutionSpec` 携带精确目标，macOS Seatbelt 只生成对应 `(remote tcp "IP:port")` 出站规则，入站、bind、其他地址和端口继续拒绝，限制沿进程树继承。命令、Profile 或目标列表变化都会让旧 Approval/Grant 失效。`npm install`、隐式 Git remote、域名目标等无法确定完整地址的操作可以确认执行，但当前不会获得网络扩展；Docker 仍保持 `--network=none`，Local Adapter 不伪装成精确网络沙箱。

这一切片只解决最小网络连通，不自动开放 `.ssh`、Keychain、SSH agent 或其他凭据路径。需要认证的远程任务仍必须使用当前环境可安全完成的非交互认证。M6 已冻结，SSH Credential Broker、域名代理和更复杂的权限体系暂不开发，只在本地使用出现明确阻塞时小范围调整。

## 基础能力

- Agent Loop：模型、工具、Observation 循环默认不限制步骤数和累计 Token；可按需显式设置边界。模型被要求持续执行到完成并验证、明确阻塞或需要用户输入。
- 模型流式输出：OpenAI-compatible/DeepSeek 与原生 OpenAI Responses 两个真实 Adapter 都把各自的 SSE 方言规范化为 `text_delta/completed`；Runtime 合并并脱敏正文片段后写入 durable Session Event，Web 可实时显示，刷新或 Gateway 重启后仍能恢复已生成部分。取消会直接中止模型请求并保留部分输出；Context overflow 重试前不会复用旧增量。普通 JSON 兼容端会安全降级，Context Summary 与 Memory Flush 继续使用非流式调用。
- 状态与事件：追加式事件流、明确执行阶段、错误与取消状态，可供 CLI、Web 或其他客户端复用。
- 安全任务标题：任务列表和页头使用 durable `Session Display Title`；首条输入及用户自定义名称都会先统一脱敏和泛化，服务器地址、账号、凭据或网络端点不会直接出现在侧栏。页头“重命名”可设置自定义名称，清空后回到安全派生标题。
- 本轮计时：任务标题下显示从本轮用户消息开始的总耗时，包含模型响应、工具执行、审批等待和请求重试；每秒更新，刷新后按原起点续计，完成、失败或取消后固定显示最终耗时。新消息开启新轮计时，切换任务不会混用计时；重启中断且没有可靠结束记录的轮次不虚构最终时长。
- 删除任务：任务列表与页头提供删除入口，确认后删除该任务及委派子任务的聊天、执行日志、Checkpoint 和附件。运行中的任务会先停止；项目文件、长期记忆和独立分支保留。删除当前任务回到欢迎页，其他打开该任务的页面同步退出；已删除 ID 无法被迟到写入或恢复操作重新创建。
- Objective 与计划：每个新任务建立 durable Objective；复杂任务通过 `update_plan` 维护有版本的步骤状态。未完成任务收到“继续吧”“修复好了吗”等明确短句时保留原目标和计划；已取消任务需要用户明确说“继续”才能恢复，已完成任务不自动复活。一般新任务仍创建新目标。
- 完成检查：模型无工具调用时，Runtime 会检查剩余计划、未结束委派、空回答和误输出的历史工具档案；不合格则在同一轮最多自动纠正两次，仍受 Token/步骤预算与取消控制。真实阻塞通过 `update_plan.blocked_reason` 上报；纠正耗尽或存在阻塞时明确显示停止原因，保留原目标和计划供后续继续，避免把未完成工作标成成功。
- 重复失败纠正：连续三个工具调用具有相同工具、参数和完整脱敏错误结果时，Runtime 在整批工具结束后给出固定纠正提示，帮助模型检查输入并换一种定位/修复方式；每个用户轮最多两次，仅追加提示，不自动重放工具或结束任务。成功、不同错误、已观察文件变化会打断计数，审批拒绝、超时和结果未知不进入该检测；不会因执行耗时长而触发。
- 验收证据：执行型任务可通过 `update_plan.acceptance` 声明验收命令与输入文件；`run_shell.verification_id` 将真实工具结果绑定到对应验收项。完成前复查输入文件的 SHA-256 与版本，变化、失败或证据缺失都会要求重新验证。Web 计划卡与 CLI 显示验收状态。验收项在同一目标内只能追加，普通问答和未声明验收项的小修改不额外要求测试；它验证已声明命令，不承诺自动证明需求覆盖完整。
- 请求恢复：当轮完成纠正放入请求首部系统指令，兼容只允许首部 system 的模型服务；历史日志和消息游标保持不变。模型请求遇到暂态连接故障或 HTTP 408/429/500/502/503/504 时，默认等待 250ms、1000ms，最多额外重试两次；不重放已执行工具，取消立即生效，失败请求用量计入预算（未知用量明确标为估算）。鉴权、配额、协议格式等永久错误不重试；持续失败会显示安全错误码并保留目标和计划。明确状态询问如“跑完了吗”会继续原目标。
- 工具历史档案：压缩后的工具参数和结果以带来源的 JSON 数据档案进入请求，不再充当 assistant 的调用示例。系统说明明确其为不可信历史数据，说明成本计入上下文预算；最近两个真实工具轮和 opaque Provider 状态继续保留，原始日志不变。
- 单层委派：Gateway Agent 可用 `delegate_task` 创建独立 Child Session，只传显式上下文和受限子预算；结果回填 Parent，Child 审批显示在 Parent，取消会级联传播。Child 重启恢复时预算只能保持或继续收紧，不能被具名 Profile 默认值扩大。首版不支持 Child 再委派、并行 fan-out 或跨进程 worker。
- Agent Profile：每个 Session baseline 保存不含密钥的 Provider/model、提示词与工具 schema hash、Policy、Execution、Memory scope 和预算版本；恢复配置变化会留下带字段分类和影响等级的 durable diff。可在本地私有配置中定义具名 Profile，并在 Web/CLI 创建新任务时显式选择；Child 继承身份并单独收紧预算。
- Artifact：长 Shell、MCP、文件读取等成功或失败工具输出在 Tool Host 统一脱敏后保存到 Session 专属 SQLite Artifact Store，消息只保留预览和引用；模型可用 `read_artifact` 分段读取，Web 工具卡可加载完整输出。Portable Journal 可携带 Artifact，Import 与 Branch 会复制到目标 Session scope，运行时仍禁止直接跨 Session 访问。
- 精确编辑：`edit_file` 通过唯一旧文本完成单文件局部替换；`apply_patch` 用一个结构化批次新增、精确更新或删除多个文件，同一路径可按顺序执行多个 update。批次先校验全部目标、权限、匹配次数和大小，再开始写入；符号链接别名造成的重复真实目标会拒绝，预检失败不修改文件，提交失败会回滚已经尝试的文件。它是进程内文件级补偿回滚，不承诺主机崩溃时的事务原子性。
- 文件变更：`write_file`、`edit_file`、`apply_patch` 与 `run_shell` 执行后生成有界 File Change Manifest；Journal 保存新增/修改/删除摘要和哈希，脱敏文本 Diff 保存为 Artifact，Web 工具卡可按需查看。工作区内符号链接写入会追踪真实目标，Shell 创建、改指向或删除链接会记录链接变化。`.git/.nexus/node_modules/.env*` 不参与内容采集，超限会明确显示为不完整。
- 模型上下文：Context Lifecycle deep Module 从 durable event 投影消息、记忆与 Skills，并在每个用户 turn 内统一管理历史/活动工具投影、Memory retrieval、窗口规划、语义摘要、模型审计与 overflow replan；Agent Loop 不再编排这些细节。Context Window 默认兼容值为 32,000，并可按 Provider 或具名 Profile 通过 `contextWindowTokens` 配置；当前本地 vLLM 配置为 1,000,000。窗口变大不等于停止优化：已完成旧 turn 的工具协议仍会成对改写为有界历史记录，长任务当前 turn 始终逐字保留最近两个完整工具轮，只在确实节省 Token 时精简更早、已经闭合的工具轮；完整内容继续保存在 Journal/Artifact，用户目标、普通正文和最近 Observation 不变。需要省略完整旧轮次时，Lifecycle 优先生成带覆盖位置的滚动结构化语义摘要，并与连续的最近完整 turn 一起进入模型；当前 turn 或固定上下文即使本地估算超过目标也会继续发送，不会被估算值直接截停。摘要失败会降级为 recent-turn 策略，原始 Journal 永不删除。每个最终 Provider 请求都计算确定性的 SHA-256 `contextHash`，durable audit 分开记录历史与活动工具投影节省和规划元数据，不复制 System Prompt、消息或工具正文。若 Provider 明确返回 Context overflow，Lifecycle 会进一步缩减完整旧 turn 并自动重试一次，且在本 turn 后续工具轮继续沿用收紧后的目标；认证、限流、网络和普通模型错误不会进入该重试路径。
- 长期记忆：Pinned 与 Relevant Memory 按 Session scope 独立检索和预算，固定记忆优先进入 Context；两类都按不可信事实数据处理，不会提升为策略指令。Web 记忆面板的列表、新增、删除、固定、候选列表与候选处理全部绑定当前 Session/Profile 的 Memory Scope，不会落入默认 Agent 的全局 scope；固定状态经 durable outbox 修改并保留 Session 审计。
- 工具安全：`read-only` 提供不可被 Policy/Grant/Approval 提升的只读闭环；`workspace-auto` 自动执行普通工作区写入与沙箱内常规 Shell；工作区删除、动态解释器、网络/安装/Git 写入审批并支持 Session Grant；秘密、宿主逃逸和系统破坏硬拒绝；工具支持可选 deadline 与取消信号，`run_shell` 默认无自动 deadline，可用 `timeout_ms` 显式限制。
- Workspace 与 Skills：读取 `AGENTS.md`、`SOUL.md`，按需加载 `.nexus/skills/*/SKILL.md`。
- 持久化：SQLite 保存会话、消息、事件、文本 Artifact、短期记忆、已加载 Skills 和跨会话长期记忆；自动执行事务化 schema migration，并用带校验和的 checkpoint 加速长会话恢复。
- 恢复与迁移：按 ID 恢复会话，安全闭合中断的工具调用，并导入、导出可重放 Journal Archive。
- 可观测性：记录模型/工具调用数、审批数、Token 用量以及模型、工具和单轮耗时；Web “上下文”面板解释 Token 估算与软压缩目标、历史省略、Memory 命中、摘要 revision 与 Context overflow 自动缩减，详情“概览”从 Session Journal 确定性派生任务健康、工具可靠性、审批和委派信号，不展示消息、工具参数或原始错误正文。离线 Replay Harness 可验证 Journal Archive、重复 reducer 重放并比较 state/event 指纹、Context Hash、指标与问题分类，全程不调用 Provider 或工具 Adapter。
- 本地 Gateway：HTTP API、带游标的增量 SSE、远程审批、取消、记忆管理和同源 Web 控制台。
- Task Workbench：同一 user Turn 的多次模型/工具步骤聚合为一个 Agent 回应；每轮只显示一张可折叠 Execution Summary，以 durable Tool 终态汇总工具数、耗时、文件变化、审批、恢复和本轮结果，不再从输出文案猜测成败。主线程以稳定 Turn 身份增量协调：模型或工具流只更新活动 Turn，已完成历史、手动展开状态、焦点和阅读位置不会被整页重建；接近底部时自动跟随，主动上滚后不抢回底部。失败、取消和结果未知保留各自 durable 原因：只有 Adapter 已启动且没有终态时才标记未知并要求人工检查，尚未启动的后续调用明确取消，两者都不会自动重试；Branch 继承历史显示为中性记录，新事件只配对新的 Turn。宽屏使用“任务列表 / 任务线程 / 任务详情”真实三栏工作台，右侧详情常驻且不遮挡正文；中小屏才退化为可关闭抽屉。详情收拢为“概览 / 文件 / 上下文 / 更多”；“文件”按 Turn 和 Tool occurrence 展示 File Change Manifest，并按需加载 durable Diff，同一路径的多次变化与分支继承都保留独立来源。Memory、Grant 与最近 100 条 Journal Event 默认折叠且按需加载。Composer 统一管理输入法、发送、停止和 Session-scoped 异步状态，快速切换任务时旧请求不会污染当前草稿或按钮；真正的浮层和移动任务抽屉会优先消费 `Esc`，常驻详情栏不会阻断任务中止。正文使用 15px 基线，状态和次要信息不低于 12px；小于 760px 时通过“任务”按钮打开可键盘关闭的 Sidebar 抽屉，不再丢失任务导航。
- MCP stdio：支持 Tools、Resources、Resource Templates 和 Prompts；能力名称隔离并统一审批。
- Capability Runtime：Native/MCP 工具有明确 owner；MCP 关闭或能力撤销后 schema 立即消失，旧调用不会启动 Adapter。
- WorkspaceExecution：macOS 默认通过 Seatbelt 原生沙箱执行 Shell，限制沿进程树继承；环境变量白名单、zsh no-rc、workspace/symlink 边界和完整进程组终止统一生效。`run_shell` 无 deadline 时仍是前台调用；取消或显式超时继续回收完整进程树，并记录实际耗时与终止原因。Local 为显式 trusted-local，Docker 为显式可选后端。
- 凭据脱敏：Assistant 正文、工具参数、输出和错误在持久化前过滤常见 API Key、Token、Authorization、敏感字段、高熵引号凭据，以及 `sshpass`/位置型 `expect` 登录参数。

## 会话、记忆与导出

运行状态默认保存在工作区的 `.nexus/nexus.db`，数据库与导出目录都被 Git 忽略。

```bash
# 查看保存的会话
npm run demo -- --sessions

# 恢复最近一次或指定会话
npm run demo -- --resume=latest
npm run demo -- --resume=session-xxxxxxxxxxxx

# 导入归档到当前工作区；可选映射为新 ID
npm run demo -- --import=/绝对路径/session.journal.json
npm run demo -- --import=/绝对路径/session.journal.json --import-as=session-new-id

# 离线校验和评测归档；可选与另一份归档比较
npm run demo -- --evaluate-archive=/绝对路径/session.journal.json
npm run demo -- --evaluate-archive=/绝对路径/baseline.json --compare-archive=/绝对路径/candidate.json

# 使用脚本化 Provider/Tool Adapter 重跑固定场景，不访问真实模型或外部工具
npm run demo -- --evaluate-scenario=/绝对路径/scenario.json

# 运行目录中的全部 Scenario；可选按任一标签筛选
npm run demo -- --evaluate-suite=/绝对路径/scenarios
npm run demo -- --evaluate-suite=/绝对路径/scenarios --suite-tags=smoke,tools

# 保存一份原始 Suite 报告作为基线
npm run --silent demo -- --evaluate-suite=/绝对路径/scenarios > /绝对路径/baseline.json

# 与基线比较；可选允许每个场景最多 10% Token 增长
npm run demo -- --evaluate-suite=/绝对路径/scenarios --suite-baseline=/绝对路径/baseline.json
npm run demo -- --evaluate-suite=/绝对路径/scenarios --suite-baseline=/绝对路径/baseline.json --suite-token-tolerance=10

# 策略实验：允许 Context Hash 改变，仍检查通过率、问题与 Token 预算退化
npm run demo -- --evaluate-suite=/绝对路径/scenarios --suite-baseline=/绝对路径/baseline.json --suite-mode=experiment
```

`--suite-mode` 默认 `regression`，保留 Context Hash 强一致要求；`experiment` 把预期的上下文改变记录为 change，而非仅因 Hash 不同判退化。两种模式都保留输入身份、原有质量检查与成本容差。

Scenario JSON 声明固定的 `prompt`、Provider 响应序列、无副作用工具结果、可选取消点和期望指标。Harness 会通过真实 `AgentRuntime + ToolHost` 独立运行两次，比较去除时间波动后的 State/Event 指纹、Context Hash、Token/调用计数、问题 code 与工具结果分类；断言不匹配时 CLI 以退出码 `2` 结束。脚本只接受结构化响应和 `success/failure/wait_for_cancel` 工具结果，不解释代码、不启动 Shell，也不读写业务 Session。

Suite 目录只读取第一层普通 `.json` 文件，按文件名排序，忽略子目录、符号链接和非 JSON 文件；每个 Scenario 可声明 `tags`。汇总报告包含通过率、确定性计数、Token/工具总量、状态/问题/标签分布和失败断言，不返回 prompt、响应或工具参数。Suite 全部通过返回退出码 `0`，任一断言或确定性检查失败返回 `2`，目录或 fixture 无效返回 `1`。

回归模式的 Baseline 必须是一次未带 `--suite-baseline` 的原始 `scenario-suite-evaluation-v1` JSON 报告。比较会阻止：旧场景缺失、通过变失败、确定性下降、状态恶化、新增问题代码、Context Hash 改变及超出容差的逐场景 Token 增长；新增且自身通过的场景允许加入。State/Event 指纹变化会记录为 change，但不会单独阻断，方便区分内部实现调整与模型可见上下文回归。旧报告的 score、results 和 Token 汇总不一致时会被拒绝。

### 长期记忆关键词检索

长期记忆默认使用中英文关键词召回：例如已有“项目使用 TypeScript，测试使用 Vitest”，自然提问“我们项目使用什么语言和测试框架？”可以找到该记录。完整内容精确匹配、全文片段和标签片段优先，其余结果按词项覆盖排序。仅共享一个弱片段或只有“项目/使用”等泛词时可能省略；找不到时可用具体主题词重查。这是词法基线，不具备纯语义改述能力。

SQLite migration v10 自动建立 trigram FTS 派生索引并回填旧记录，后续通过事务触发器维护。检索仍按 workspace/agent/user、状态、有效期和 pinned 过滤，再排序取 limit；固定记忆继续独立检索、独立预算。来源验证、软删除和幂等写入契约不变。

直接查询上限为4096个UTF-16字符，最多选24个词项，模型工具schema同步公布长度限制。自动任务Context检索遇长消息时仅取查询首尾，保留原始用户消息和固定记忆，相关命中标记 `contextQueryTruncated`。Adapter API可显式传 `{strategy:"literal"}` 使用旧整句子串策略；`rebuildSearchIndex()` 是本地维护方法，不是模型工具，也不在搜索时自动全量重建。

运行纯离线的标注对照评测：

```bash
node src/cli.js --evaluate-memory=fixtures/memory-suites/retrieval-v1.json
```

评测仅创建内存数据库，不加载模型配置或业务Session。报告区分正例召回、检索精度、MRR、负例空结果率和范围/状态违规；`passed` 代表找到所有标注目标且负例为空，精度另外报告。固定25查询样本中，召回从50%提高到100%，精度由100%变为95.24%，7个负例均无返回；这些合成样本结果不代表真实模型质量。详见 [第五轮实施记录](docs/17-Harness记忆检索与FTS实施记录-2026-09-09.md)。

### 运行纠正与中断诊断

Web 的任务健康报告、CLI `/evaluation` 和工作区任务评测共用 `turn-diagnostics-v1`：统计模型重试、完成检查纠正、重复失败纠正、按原因暂停和用户继续。可恢复失败的 Session phase 仍是 `failed`，诊断中的该轮 outcome 为 `paused`，失败终态事件另行计数。旧日志没有结构化原因时显示 `unknown`，不通过错误正文猜原因。

`observedUserContinuations` 只表示观察到同一目标后续又收到用户消息；它可能是继续命令、状态询问或追加要求，不能直接当成系统出错次数。`unnecessaryContinuationRate` 暂为 `null`，后续需标注样本才能评价“无谓继续率”。任务产物验收与运行诊断分开，纠正提示出现不代表任务已经成功。

重复失败反馈来自固定运行时规则，完整错误正文不提升为系统指令。新工具结果保存截断前完整脱敏输出的 SHA-256，不用 160 字预览比较；缺少该字段的旧结果不推断相同。Session schema v18 与新 action 支持恢复审计，v17 及此前已有迁移路径保留。实施范围见 [第三轮实施记录](docs/15-Harness进展纠正与中断诊断实施记录-2026-09-08.md)。

### 验收项与实际工具证据

例如，为构建声明验收项（模型通过已有 `update_plan` 工具提交）：

```json
{
  "plan": [{ "step": "实现与验证", "status": "in_progress" }],
  "acceptance": [{
    "id": "build",
    "description": "生产构建成功",
    "command": "npm run build",
    "paths": ["package.json", "src/main.ts"]
  }]
}
```

之后执行 `run_shell` 时携带 `{"command":"npm run build","verification_id":"build"}`。命令必须与声明一致，仍经过相同权限、审批和取消路径。输入在命令前后及最终完成前均会受权限约束地检查；通过状态只能由真实成功 Tool Result 产生，不能在计划中填入 `passed`。同一目标不能删改已有验收声明来绕过失败；新目标重新声明。输入文件应覆盖这条验收依赖的代码和配置，未声明文件不在本次证据有效性保证范围内。

### 在实际产物上做任务效果评测

新增 `fixtures/task-suites/local-coding-v1.json`，包含文档编辑、JSON 配置、小代码修复与 CSV 转换四个起步任务。每次试验使用独立临时工作区和 Session，真正经过 Runtime、Tool Host 与文件工具，然后从磁盘检查产物；`phase=completed` 与验收通过分别统计。报告包含 `falseCompletions`、检查结果 Hash、模型/工具用量、耗时和试次身份，不输出任务或文件正文。

以下命令只有在你明确运行时才调用当前配置模型；不会启动 Gateway，也不会改动业务项目工作区：

```bash
npm run --silent local -- --evaluate-tasks=fixtures/task-suites/local-coding-v1.json > /tmp/nexus-task-results.json
```

默认仅启用文件工具，Shell 不可发现也不可执行。需要 Shell 的自定义评测必须显式增加 `--task-eval-shell`，使用当前配置的 WorkspaceExecution Adapter，审批在已授权的临时评测内处理；该开关不是启动服务的命令。`--demo` 可验证离线路径，但 Demo 的通过率不代表真实模型能力。全部通过返回 0，产物/运行失败或取消返回 2，配置无效返回 1。

Suite 使用 `{id,tasks:[{id,prompt,files:[{path,content}],checks:[{id,type,path,expected}],trials,maxSteps,maxTokensPerTurn,maxInputTokens}]}`。验收支持 `file_equals`、`file_contains`、`json_equals`；相对路径、文件大小、任务和试次数均有界，不接受任意评测脚本。默认每任务一轮、最多 20 步、100000 tokens、32000 输入窗口；可按 fixture 显式调整。四个样例只是效果基线起点，尚不是大规模模型质量结论。

### 长任务归档边界

恢复时按需读取最新有效检查点，不再先把全部历史快照正文装入内存。坏检查点继续按序回退，找不到有效项时从原Journal恢复，校验规则及历史数据保持不变；旧Node缺少SQLite iterator时使用逐条查询兼容路径。

新导出会先检查完整重放、被引用 Artifact 与可导入大小：最多 256 个 Artifact、内容总量 64 MB，HTTP 导入外壳最多 10 MB；新导出为目标 ID/项目参数预留 64 KB。超限会明确失败并建议 SQLite 一致性备份，不会静默省略附件或生成无法恢复的新备份。旧版本大归档仍可使用直接/CLI 导入的既有恢复路径；HTTP 入口仍受 10 MB 限制。不要在服务运行时只复制数据库主文件而漏掉 WAL。

### 有界原生文件读取批次

同一模型回复中的原生 `read_file` 可按原顺序分组，每组最多3个、调用ID互不重复；即使尾组只有1个，也走相同的清理路径。组内可以并发读取，结果仍按原调用顺序提交；整组收束后才进入后续操作，整个模型工具批次结束后才继续请求模型。

仅显式标记、当前可用、纯read/safe、无需审批或Grant的内置读取可进入该路径；默认SQLite Artifact写入或未配置Artifact时支持并发，自定义Artifact写入保持串行。写入、Shell、MCP、Memory、历史回查、目录/搜索游标和Artifact读取均保留串行边界。并行准入不扩大权限，启动前会复查登记、实现、可用性、策略和资源。

取消或超时后等待已准入的原生读取真正结束并关闭资源，再释放执行引用和提交结果；底层文件系统I/O不一定可即时抢占。普通读取失败仍回填结果并继续本轮；内部执行或记录失败保留明确的可恢复原因，不自动重放已开始调用。并发读取本身不提供跨文件事务快照，也不隔离其他Session对同一项目的写入。

详见 [第七轮实施记录](docs/19-Harness有界文件读取并行实施记录-2026-09-09.md)。

### 文件差异与开销对照

Gateway 在原生提交后按需生成完整缓存快照：只消费增量事件时不再逐次复制整个会话，实际读取时生成一次，同版本复用；完整订阅及自定义钩子保持原行为。`node scripts/measure-gateway-state-cache-copies.js` 的960轮合成历史、80次流式提交中，Gateway缓存快照80→0次，每10次读取时80→8次；状态、事件和恢复一致，reducer仍逐次复制。详见 [第二十轮实施记录](docs/32-Harness网关状态按需快照实施记录-2026-09-10.md)。

原生主请求现在从通过检查的私有普通历史直接构造独立的各轮结果，省去投影前的全量messages副本；特殊数据和公开纯函数保持兼容路径。`node scripts/measure-model-history-copies.js` 的960轮普通工具历史中，20次请求准备的克隆入参JSON字节120,321,100→9,235,240，完整请求和Hash一致；不透明Provider协议仍完整保留。该指标不代表整体任务加速比例。详见 [第十九轮实施记录](docs/31-Harness主请求历史复制优化实施记录-2026-09-10.md)。

原生主请求的内置系统提示现在按实际依赖字段取独立快照，具名Profile沿用该声明，自定义回调保持完整上下文。`node scripts/measure-prompt-context-copies.js` 的960轮合成历史中，20次准备不再为提示参数复制全历史，克隆入参JSON字节231,407,200→120,321,100，完整请求和Hash一致；该指标不代表整体任务时延。详见 [第十八轮实施记录](docs/30-Harness系统提示按需快照实施记录-2026-09-10.md)。

摘要来源现在直接在Session内部选择，省去选择前复制整份消息历史，只返回独立的选中数据及原游标。旧适配器和读取钩子保留兼容路径。`node scripts/measure-summary-source-copies.js` 的960轮合成历史上，20次摘要准备的完整消息快照复制20→0次，请求和覆盖一致；该结果不代表整个运行时已消除历史复制。详见 [第十七轮实施记录](docs/29-Harness摘要来源按需投影实施记录-2026-09-10.md)。

摘要调用前现在检查完整请求的估算输入，包含旧摘要、提示词和JSON外壳，按Provider窗口减输出预留缩小历史批次。旧摘要本身无法容纳时零调用降级，保留原覆盖并继续主任务；主输入软目标独立。`node scripts/measure-summary-request-budgets.js` 的中文合成请求从45,105降到22,849估算Tokens，普通请求保持一致。详见 [第十六轮实施记录](docs/28-Harness完整摘要请求预算实施记录-2026-09-09.md)。

滚动摘要的新增历史来源现在严格限制在48,000个序列化JSON字符内；超长首轮保留脱敏首尾摘录和省略区间，后续摘要持续保留“不完整”标记。`node scripts/measure-summary-source-bounds.js` 的1200次短工具调用样本中，来源344,999→47,996字符，普通小批次保持一致。旧摘要与提示词仍计入完整请求，48,000不是整个请求或Token上限。详见 [第十五轮实施记录](docs/27-Harness摘要来源边界实施记录-2026-09-09.md)。

高频工具输出现在合并为“一条在途＋一条最新待提交预览”；Shell在通知变慢时暂停读取施加背压，取消/超时恢复管道以保留清理输出。中间预览事件会减少，最终结果继续按原限额采集。`node scripts/measure-output-backpressure-costs.js` 的万次突发合成场景中，预览提交10,001→2次，最终预览一致；没有据此推算真实任务提速。详见 [第十四轮实施记录](docs/26-Harness工具输出背压与预览合并实施记录-2026-09-09.md)。

上下文压缩规划现在累计各完整轮的消息成本，减少反复重新计算已选历史；工具档案说明、摘要覆盖和当前轮保留规则保持。`node scripts/measure-context-window-costs.js` 可离线复现对照：960轮合成历史的估算编码次数336,580→4,230，最终请求完全一致；计时只覆盖本地请求准备。详见 [第十三轮实施记录](docs/25-Harness上下文预算规划优化实施记录-2026-09-09.md)。

模型流、工具生命周期和批次结果等内部提交现在只等待完成，省去调用方不会使用的完整状态回执。自定义提交钩子、公开dispatch和工具回调的返回值保持。`node scripts/measure-action-receipt-costs.js` 的80次合成内存提交中，完整状态克隆160→80次，事件和请求一致；该窗口不含SQLite、模型或真实工具耗时。详见 [第十二轮实施记录](docs/24-Harness内部提交回执优化实施记录-2026-09-09.md)。

预算、摘要准备和权限路由等内部判断现在按字段读取Session快照，减少只取一个指标时复制整份聊天与日志的开销。每个决策仍读最新状态，自定义工具的完整状态接口保留。`node scripts/measure-state-view-costs.js` 的500次合成查询中，完整状态克隆500→0次，每次仍复制所选字段；这不是整个任务的提速比例。详见 [第十一轮实施记录](docs/23-Harness按字段状态快照实施记录-2026-09-09.md)。

状态补丁生成现在可在Node中直接比较普通JSON值，减少未变化长文本的重复序列化；特殊值和不支持的环境沿用原算法，补丁格式与独立快照保持。`node scripts/measure-state-patch-costs.js` 的80事件合成对照中，序列化文本量减少约96.21%，完整patch和Journal JSON一致；局部时延不代表完整任务提速。详见 [第十轮实施记录](docs/22-Harness状态补丁比较优化实施记录-2026-09-09.md)。

会话内部的模型上下文现在按 durable patch 更新；流式进度等未改变模型字段的事件不再复制整份历史。发送给模型的请求仍保留独立快照，历史压缩、预算和哈希规则保持。`node scripts/measure-model-projection-costs.js` 可离线对照：80次合成事件的完整模型上下文克隆80→0次；这只衡量投影模块，不代表整个任务提速。详见 [第九轮实施记录](docs/21-Harness模型上下文增量投影实施记录-2026-09-09.md)。

长任务状态缓存现在可复用已提交事件的增量 patch；旧缓存或不支持的补丁自动完整保存，检查点与恢复校验保持。状态和游标在同一事务恢复，提交时检查旧游标冲突；任务列表使用安全小标题，工具请求可只取得提交游标回执。

`node scripts/measure-session-commit-costs.js` 可离线复现本轮对照：40次合成提交的SQLite文本参数量约34.1 MB→6.2 MB，减少约81.72%，两路径缓存、Journal及checkpoint一致。此指标不是磁盘写入量或任务速度；SQLite仍更新完整JSON。实现、旧数据库兼容与限制见 [第八轮实施记录](docs/20-Harness增量状态缓存与提交开销实施记录-2026-09-09.md)。

文件审阅的Diff现在只展示修改附近三行上下文，分离较远的修改；保留准确行号、CRLF和文件末尾换行状态。正文与路径在生成片段前完整脱敏，路径控制字符会转义；超过输出预算时仅保留完整片段并显示截断状态。高度重复区域或匹配工作预算耗尽时显示较大的替换区段，保证变化不被虚构为已省略的相同行。二进制与超限文件仍按原规则提供元数据。

可运行纯离线合成对照：

```bash
node scripts/measure-harness-costs.js
```

固定样本中，检查点payload由96份降为1份（4,051,647→49,566字节）；万行文件一处/两处分散修改的Diff分别由420,062字节降为228/418字节，恢复及独立文本重建均一致。这些数字是SQLite→JavaScript状态正文和Diff输出量，未测整体恢复耗时、峰值内存或真实模型质量。详见 [第六轮实施记录](docs/18-Harness恢复与文件审计实施记录-2026-09-09.md)。

### 文件分页与历史工具回查

`read_file` 的旧 `{path}` 调用对不超过 64 KiB 的小文件继续返回正文；大文件或显式分页返回结构化 JSON，包含范围、文件版本、`complete`、`stop_reason` 和下一页位置。行号从 1 开始，例如 `{"path":"src/main.ts","start_line":201,"line_count":200}`；字节偏移从 0 开始，例如 `{"path":"large.log","offset":1048576,"limit":16384}`。后续页携带返回的 `version` 防止拼接不同版本；它是文件身份/元数据版本，不是完整文件内容的 SHA-256。`partial_line=true` 时使用 `next_offset`，避免反复读取长行开头。读取到 EOF 不意味着之前未请求的内容也已返回。

分页会在最多 2 MiB 的完整行及邻行上下文内应用现有脱敏规则，总读取仍限制为 8 MiB；从敏感值中间读取或遇到跨行凭据时也不直接透出片段。若无法取得足够上下文，会返回 `content_omitted=true` 和 `redaction_context_limit`，需要换范围或读取已有脱敏 Artifact。偏移始终属于原文件，不能按脱敏后正文长度计算。

`list_files` / `search_files` 现在返回有界 JSON 分页：`entries` 或 `matches`、`complete`、`has_more`、`next_cursor`、扫描数量和跳过原因。下一页重复原查询参数并附加 `cursor`；游标绑定当前 Session、查询和已观察目录/文件/权限，最多保留 15 分钟，重启、变化或缓存驱逐后需要重新查询。搜索仍是大小写不敏感的字面匹配，`file_pattern` 支持单目录段的 `*`、`?` 和独占目录段的 `**/`，不接受任意正则。

默认每页搜索预算为 300 个目录项、最多 80 条命中和 4 MB 文件读取；单文件 1 MB 上限，符号链接、受限路径、二进制或超大文件有明确计数。目录/文件快照本身有 20,000 项和 8 MB 上限。`has_more=false` 但 `complete=false` 表示已没有继续页、仍有未覆盖部分，不能据此断言全仓库不存在匹配。每页返回前复核已观察的对象，但不宣称整个目录树处于一个文件系统事务快照。

`read_tool_history` 只查询当前 Session 的 durable 工具记录：

```json
{"call_id":"某次工具调用ID"}
```

从返回的 `occurrences` 选择正确 `sourceCursor`，再用 `{"source_cursor":123,"snapshot_cursor":456}` 精读。结果字符页给出 `sha256`、`nextOffset`，后续携带 `offset`、同一 `snapshot_cursor` 和 `expected_sha256`。这些 cursor 是真实 Journal cursor，不是界面事件 seq；同一 callId 的多次调用会分别列出，不会盲取最后一次。它不执行历史工具、不读取其他 Session，也不返回 baseline、用户/系统消息或私密记忆/凭据工具正文；没有 durable journal 或分支只继承了消息时，会明确不支持或找不到记录。

三类分页回复都控制在 10,000 字符以内，并使用共同安全 JSON 编码，防止后续重复脱敏破坏分页结构。工具历史单条请求与结果合计超过 4,000,000 字节时，只返回省略原因及可用 Artifact 引用；完整 Artifact 用 `read_artifact` 分段读取。SQL 查询仍可能扫描历史，不承诺查询 CPU 恒定有界。

新增 `fixtures/task-suites/retrieval-v1.json`，覆盖第 320 个文件的定位和长文件尾部提取。任务效果套件现允许最多 512 个种子文件，仍受单文件和每任务总字节限制，并已接通 `read_tool_history` / `read_artifact`。这些起步场景本轮仅通过离线 Provider 验证工具链，未自动调用真实模型。

CLI 中可用：

- `/help`：查看命令与演示任务。
- `/long-memory`：查看长期记忆。
- `/pin=ID`、`/unpin=ID`：固定或取消固定 active 长期记忆。
- `/evaluation`：查看当前 Session 的确定性健康报告，不调用模型、不修改任务。
- `/export`：导出当前会话到 `.nexus/exports/`。
- `/quit`：保存并退出。

如果进程在审批或工具执行期间中断，恢复时会为未闭合调用补充“执行状态未知”的安全结果，不会自动重放可能有副作用的操作。长时间 `run_shell` 也不作为可重连后台 Job；Gateway 中断后的已启动执行继续按 `execution_unknown` 闭合。

Model Context 不会按单条消息硬截断。assistant tool call 与对应 tool result 属于同一个完整 turn；配置的 Context 数值只用于压缩旧历史，不是本地执行上限。当前 turn 或 system prompt、Skills、工具 schema 的固定成本即使估算超过目标，也会保留完整协议并继续调用 Provider，同时在计划中记录 `estimatedOverTarget`。每次窗口规划都会产生 `model.context_prepared` 或 `model.context_compacted` durable audit event，其中 `contextHash` 对实际发送的 System Prompt、消息和 Tool Schema 做规范化摘要，可用于识别两次请求的模型可见内容是否完全一致。只有 Provider 明确返回真实 Context overflow 才会自动缩减并写入 `context.replan_requested/replanned`；重试仍被 Provider 拒绝时写入 `context.replan_exhausted` 并结束任务，不会形成无界重试。

## Web 控制台与 Gateway API

Gateway 只允许绑定本机回环地址，并拒绝非本机网页来源。Web 控制台提供会话列表、消息发送、实时状态、运行指标、Context 可观测性、Journal 派生的任务诊断、会话级权限菜单、审批、取消、长期记忆和会话导出。只有 user message 才创建新的可见 Turn；同一任务里的多次模型步骤和 Tool Run 共用一个 Nexus 头像，并收进带工具数、耗时、文件变化与异常状态的“执行摘要”，完成后默认折叠，最终回答保留在 Turn 主体。顶部“审查”入口及 Turn/概览中的文件入口会选择 Inspector“文件”视图；宽屏 Inspector 常驻第三栏，中小屏以 dialog 抽屉打开。该视图只使用 durable File Change Manifest 和 Diff Artifact 展示对应执行现场，不以当前工作区内容改写历史。运行期间 Composer 的发送按钮会切换成红色停止按钮，点击或按 `Esc` 都会中断模型请求、审批等待和工具进程组；权限菜单、危险确认、移动任务抽屉或中小屏 Inspector 打开时，`Esc` 只关闭当前浮层，宽屏常驻 Inspector 不属于浮层。发送和取消状态按 Session 隔离，切换任务后迟到请求不会改写当前草稿或控制按钮。Runtime 失败时会在消息流底部直接显示停止原因，不再表现为无声结束。消息输入框支持中日韩输入法组合态：确认候选时的 Enter 不会发送，普通 Enter 发送，Shift+Enter 换行。

常用 API：

```text
GET    /health
GET    /runtime
GET    /projects
POST   /projects
GET    /projects/:id/runtime
GET    /sessions
POST   /sessions
POST   /sessions/imports
GET    /sessions/:id
DELETE /sessions/:id
GET    /sessions/:id/evaluation
GET    /sessions/:id/memories
POST   /sessions/:id/memories
DELETE /sessions/:id/memories/:memoryId
GET    /sessions/:id/memory-candidates
POST   /sessions/:id/messages
POST   /sessions/:id/permission-profile
GET    /sessions/:id/events
POST   /sessions/:id/branches
POST   /sessions/:id/approvals/:callId
POST   /sessions/:id/cancel
GET    /sessions/:id/export
GET    /memories?query=关键词
POST   /memories
DELETE /memories/:id
GET    /sessions/:id/memories?query=关键词
POST   /sessions/:id/memories/:memoryId/pin
```

`DELETE /sessions/:id` 成功返回 `{ "deleted": true, "sessionId": "...", "deletedSessionIds": ["..."] }`，不存在返回 404；仍被父任务等待的子任务不能单独删除，返回 409，应从父任务入口删除。删除不支持撤销；需要备份时应先导出，之后可用新 Session ID 导入。

示例：

```bash
# 查看项目并在指定项目中创建会话
curl http://127.0.0.1:4317/projects
curl -X POST http://127.0.0.1:4317/sessions \
  -H 'content-type: application/json' \
  -d '{"projectId":"PROJECT_ID","permissionProfile":"workspace-auto"}'

# 完全访问只适用于以 --execution=local 启动的 Gateway，并要求显式确认字段
curl -X POST http://127.0.0.1:4317/sessions/SESSION_ID/permission-profile \
  -H 'content-type: application/json' \
  -d '{"profile":"danger-full-access","confirmation":"danger-full-access"}'

# 发送消息
curl -X POST http://127.0.0.1:4317/sessions/会话ID/messages \
  -H 'content-type: application/json' -d '{"content":"查看工作区文件"}'

# 从头订阅 durable session event；SSE id 即事件游标
curl -N 'http://127.0.0.1:4317/sessions/会话ID/events?after=0'

# 从游标 42 之后继续，避免重复接收
curl -N 'http://127.0.0.1:4317/sessions/会话ID/events?after=42'
```

事件流使用 `session_event` 类型，数据包含 `cursor`、`type`、durable `action` 和客户端 `patch`。浏览器自动重连时，Gateway 也接受标准 `Last-Event-ID` 并从较新的游标继续推送。

`GET /sessions/:id/export` 返回带 SHA-256 校验和的 `nexus.session-journal` 归档，而不是单一 state 快照。归档保留完整 durable event 与 lineage，不包含可重建的 checkpoint。

导入时会先验证 format version、稳定 SHA-256 校验和、连续 cursor、事件 schema、patch 与 reducer 重放结果；任何校验失败都不会留下半导入 Session。默认保留原 ID，`id` 可显式重映射，workspace 固定重定位到当前 Gateway；归档即使记录了 `danger-full-access` 也会在导入后立即 durable 降级，不继承来源环境的风险确认：

```bash
jq '{archive: ., id: "session-new-id"}' session.journal.json | \
  curl -X POST http://127.0.0.1:4317/sessions/imports \
    -H 'content-type: application/json' --data-binary @-
```

从指定 cursor 创建独立 Session Branch：

```bash
curl -X POST http://127.0.0.1:4317/sessions/父会话ID/branches \
  -H 'content-type: application/json' -d '{"cursor":42}'
```

省略 `cursor` 时从父会话最新 durable event 创建。分支会安全闭合当时未决的工具调用，不会执行或重放副作用。

## MCP 扩展

MCP 只在显式传入 `--mcp=配置文件`，或由受信任的进程/本机环境设置 `NEXUS_MCP_CONFIG` 时启用；workspace 内的 JSON 配置不能启用 MCP。仓库包含零依赖 Echo 样例：

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

测试覆盖会话保存与恢复、事件游标、客户端与模型上下文投影、中断调用修复、长期记忆、指标、取消、敏感信息脱敏，以及 MCP Tools/Resources/Prompts。

2026-09-10全量验证：`npm test -- --test-concurrency=4` 无排除运行，1,204项声明测试及8个support文件条目全部通过，失败/跳过均为0；14个开销对照脚本、25条Memory查询及251个JS语法检查通过。未启动项目服务或调用真实模型，具体范围与原始日志见 [全量验证报告](docs/33-Harness全量验证报告-2026-09-10.md)。

## 安全边界与后续扩展

这是面向本地开发易用性的基础版，不是多租户生产服务。macOS Native 模式通过 Seatbelt 把写入限定到 workspace/临时目录并默认禁网，但仍与宿主共享内核，而且默认可读取非敏感宿主文件；所有 `.env*`、workspace/宿主 SSH 与云凭据目录和文件会额外拒绝读写。`.git/.agents/.codex/.nexus` 位于 workspace 内，读取允许、风险写入由 Approval 控制。审批、路径限制和原生沙箱仍不等同于 VM 级隔离。MCP stdio 目前也尚未统一进入 WorkspaceExecution。不要把 Gateway 通过反向代理暴露到公网，也不要在多租户或高敏感环境中直接运行。

Linux bubblewrap/socat/seccomp、网络域名代理白名单、VM/远程执行、浏览器自动化、Slack/Discord 等消息渠道、MCP Streamable HTTP、身份认证、细粒度策略与分布式任务队列属于后续扩展层，不影响当前本地基础闭环。
