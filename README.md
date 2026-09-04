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
- Objective 与计划：每个用户任务建立 durable Objective；复杂任务可通过内置 `update_plan` 维护有版本的步骤状态，Journal 恢复和 Web Client Projection 会保留同一计划。
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
```

Scenario JSON 声明固定的 `prompt`、Provider 响应序列、无副作用工具结果、可选取消点和期望指标。Harness 会通过真实 `AgentRuntime + ToolHost` 独立运行两次，比较去除时间波动后的 State/Event 指纹、Context Hash、Token/调用计数、问题 code 与工具结果分类；断言不匹配时 CLI 以退出码 `2` 结束。脚本只接受结构化响应和 `success/failure/wait_for_cancel` 工具结果，不解释代码、不启动 Shell，也不读写业务 Session。

Suite 目录只读取第一层普通 `.json` 文件，按文件名排序，忽略子目录、符号链接和非 JSON 文件；每个 Scenario 可声明 `tags`。汇总报告包含通过率、确定性计数、Token/工具总量、状态/问题/标签分布和失败断言，不返回 prompt、响应或工具参数。Suite 全部通过返回退出码 `0`，任一断言或确定性检查失败返回 `2`，目录或 fixture 无效返回 `1`。

Baseline 必须是一次未带 `--suite-baseline` 的原始 `scenario-suite-evaluation-v1` JSON 报告。比较会阻止：旧场景缺失、通过变失败、确定性下降、状态恶化、新增问题代码、Context Hash 改变及超出容差的逐场景 Token 增长；新增且自身通过的场景允许加入。State/Event 指纹变化会记录为 change，但不会单独阻断，方便区分内部实现调整与模型可见上下文回归。旧报告的 score、results 和 Token 汇总不一致时会被拒绝。

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

## 安全边界与后续扩展

这是面向本地开发易用性的基础版，不是多租户生产服务。macOS Native 模式通过 Seatbelt 把写入限定到 workspace/临时目录并默认禁网，但仍与宿主共享内核，而且默认可读取非敏感宿主文件；所有 `.env*`、workspace/宿主 SSH 与云凭据目录和文件会额外拒绝读写。`.git/.agents/.codex/.nexus` 位于 workspace 内，读取允许、风险写入由 Approval 控制。审批、路径限制和原生沙箱仍不等同于 VM 级隔离。MCP stdio 目前也尚未统一进入 WorkspaceExecution。不要把 Gateway 通过反向代理暴露到公网，也不要在多租户或高敏感环境中直接运行。

Linux bubblewrap/socat/seccomp、网络域名代理白名单、VM/远程执行、浏览器自动化、Slack/Discord 等消息渠道、MCP Streamable HTTP、身份认证、细粒度策略与分布式任务队列属于后续扩展层，不影响当前本地基础闭环。
