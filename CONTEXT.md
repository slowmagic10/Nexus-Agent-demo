# Nexus Agent

Nexus Agent 是一个本地优先、可执行、可恢复的 Agent Harness。本文件固定项目内的核心领域语言，避免不同入口和 Module 使用近义词表达同一概念。

## Language

**Agent Session**:
一次可持久化、可重放的 Agent 执行连续体；它拥有 durable event、状态投影和单调事件游标。
_Avoid_: Conversation, chat state

**Agent Profile Snapshot**:
Session 当前绑定的无密钥运行身份，包含 Provider/model/thinking、System Prompt 与工具 schema hash、Permission/Policy、Execution、Memory Scope 和预算，并以内容 SHA-256 版本进入 Journal。恢复时运行身份变化必须写 `agent.profile_selected`；snapshot 用于审计和漂移检测，不是假装可以复活已删除 Adapter 的冻结执行包。
_Avoid_: Profile ID only, raw secret config, implicit runtime overwrite, serialized adapter instance

**Profile Drift**:
旧 Agent Profile Snapshot 与当前 runtime snapshot 的结构化安全差异；按 provider、context、capability、policy、execution、scope 和 budget 分类并标注影响等级。Drift 是解释与未来路由输入，本地模式下不自动升级为阻塞审批。
_Avoid_: Version mismatch without explanation, raw prompt diff, implicit permission decision

**Named Agent Profile**:
由本机私有配置定义、由用户在新 Session 创建时显式选择的 Agent 预设；覆盖 Provider/model、附加指令、默认 Permission Profile、Turn Budget 和隔离的 Memory `agentId`。Session 保存完整 Profile Snapshot，恢复时不能用另一个具名 Profile 覆盖。
_Avoid_: UI-only persona, implicit routing, switching an active Session

**Explicit Agent Router**:
根据用户在创建 Session 时选择的 Named Agent Profile，解析并绑定对应 Provider Adapter 的确定性入口。路由决定进入 baseline，Branch 与 Child 继承，恢复按同一 Profile 重新构造 Provider 并记录 Drift。它不根据任务文本自动选模，也不在 active turn 中切换或故障转移。
_Avoid_: Auto router, model fallback, mid-turn switch, provider hidden behind global singleton

**Provider Thinking Mode**:
Config Composition 与 Named Agent Profile 共同拥有的显式三态 Provider 行为：`provider-default` 不发送开关，`enabled/disabled` 只允许由声明支持它的 OpenAI-compatible Adapter 翻译成线协议。它进入 Agent Profile Snapshot、Profile Drift、配置 inspection 和 Web 标识，但不根据模型名或 Endpoint 推断，也不允许 active turn 热切换。思考模式工具轮所需的 `reasoning_content` 仍作为 opaque `provider_items` durable 保存并原样续传；关闭开关不会授权 Context Lifecycle 猜测或改写既有 Provider 状态。
_Avoid_: Vendor heuristics, arbitrary extra request body, silently ignoring unsupported options, UI-only toggle, mid-turn thinking switch

**Durable Session Event**:
已经原子写入 session journal、可用于恢复和审计的事实；只有 durable event 才能推进投影或对外发布。
_Avoid_: Log line, transient callback

**Artifact**:
不适合直接放进 Model Context 或 Journal event 主体的大型结果对象。首版只保存不超过 4 MB 的脱敏 UTF-8 文本，以 Session ID 作为读取边界，并记录 media type、byte size 和 SHA-256；成功、失败、取消、超时等 Tool 终态共享同一 Artifact policy，Adapter 不得在 Tool Host 前提前截断。Tool Result 只携带预览与引用，模型通过 `read_artifact` 分段读取。Portable Journal 可携带完整内容并在 Import 时重绑定目标 Session；Branch 只复制指定 cursor 已引用的内容到自己的 scope。Child 不隐式继承 Parent Artifact。
_Avoid_: Truncated-away output, unscoped blob URL, raw secret payload, inline large event body

**File Change Manifest**:
有副作用工具执行前后的有界工作区快照差异。durable event 只保存 created/modified/deleted、相对路径、文件类型、大小、SHA-256 和 Diff Artifact 引用；秘密与内部目录不参与内容采集，超过边界时必须标记不完整。路径工具通过工作区内符号链接写入时审计 canonical 真实目标；Shell 扫描把链接目标本身作为 `symlink` 记录。它描述观察到的变化，不等同于 Git commit，也不保证并发外部写入一定来自当前工具。
_Avoid_: Full workspace snapshot in Journal, implicit Git staging, secret file diff, claiming atomic provenance under concurrent writes

**Multi-file Patch**:
一次 Tool Call 中由 `add/update/delete` 结构化操作组成的有界文件批次。同一字面路径可以声明多个按顺序作用于内存快照的 `update`，但不同路径或符号链接别名指向同一 canonical 文件时仍作为歧义拒绝。所有目标先经过 schema、canonical workspace boundary、Access Policy、现有内容、精确匹配和大小预检，之后才开始写入；提交中失败会按预检快照回滚所有已经尝试的文件。Capability 与 Grant 绑定批次内每一个去重后的精确路径，Tool Host 统一生成 File Change Manifest 和 Diff Artifact。它提供进程内的文件级预检与补偿回滚，不宣称跨崩溃事务，也不接受模糊匹配或任意 unified diff。
_Avoid_: Hidden patch paths, partial preflight writes, fuzzy replacement, claiming filesystem crash atomicity

**Model Context**:
由 durable session event 投影得到、允许模型看到的消息、短期记忆、相关长期记忆和已加载 Skills。
_Avoid_: Full state, UI state, prompt state

**Context Window Plan**:
一次模型请求对 Model Context 的确定性预算投影；固定计算 system prompt、Skills、工具 schema 和完整 turn 成本，只选择连续的最近完整 turn，并记录包含与省略数量。
_Avoid_: Message slice, token truncation

**Historical Tool Transcript Projection**:
Context Lifecycle 在 Context Window Plan 之前对已完成历史 turn 生成的确定性有界投影。旧 turn 只有在整个投影确实更省 Token 时，才把完整 assistant tool call 与对应 tool result 一起改写为带工具名、参数/结果短预览的普通 assistant 历史记录，避免留下孤立 tool message。用户消息、最终回答和消息位置不变，完整参数与结果仍只存在于 Durable Session Event；每次 Model Context 计划记录版本、投影调用/结果数量及实际估算 Token 节省。它不调用模型、不修改 Journal，也不替代语义摘要或 Artifact。
_Avoid_: Mutating durable messages, orphan tool results, claiming character count equals token savings

**Active Tool Transcript Projection**:
Context Lifecycle 对当前用户 turn 内已经闭合的较早工具轮生成的确定性有界投影。最近两个 assistant tool call + 对应 tool result 轮始终逐字保留；更早轮次只有在各自完整成对投影确实更省 Token 时，才改写为带工具名和短预览的普通 assistant 记录。一个 turn 只要包含任意 opaque `provider_items`，该 turn 的全部工具协议就保持逐字不变，避免改写 Provider 私有状态的配对上下文。用户目标、普通 assistant 正文和 Durable Session Event 均不修改；Context Window Plan 独立记录 eligible/preserved/compacted rounds 与估算节省。它减少长任务每次模型调用重复携带旧工具正文的成本，但不是语义摘要，也不允许拆散或截断最近工具协议。
_Avoid_: Keeping only the last message, orphan tool results, compacting the latest two tool rounds, mutating Session state, model-generated active summary

**Context Lifecycle**:
管理一个用户 turn 内模型可见上下文完整生命周期的 deep Module。`startTurn` 在 Durable User Message 之后执行有界 Memory retrieval，并返回只公开 `completeModelStep` 的 turn Interface；该 Interface 在内部维护收紧后的 Context 预算，集中完成 Historical/Active Tool Transcript Projection、Context Window Plan、durable semantic summary、模型请求审计、usage 计量、Provider overflow 单次 replan 和 degraded audit。AgentRuntime 只协调 turn、工具循环和最终状态；`model-context` 纯投影与 Memory retrieval Adapter 是 Context Lifecycle 的内部 Implementation，不扩散给调用者。
_Avoid_: Agent loop coordinating summary batches, caller-owned overflow retries, resetting tightened budget between tool rounds, pass-through context wrapper

**Turn Budget**:
一次用户任务内所有模型调用的累计 Token 成本边界，与单次请求的 Context Window Plan 和工具循环 `maxSteps` 分别配置。步骤与累计 Token 默认均为 unlimited；用户显式设置边界后，达到边界的新工具调用必须在 Adapter 启动前停止并闭合模型工具协议，最终模型回答不能因事后预算检查而丢失。
_Avoid_: Hidden cap, context window equals cumulative cost, dropping a paid final response

**Objective**:
当前用户 turn 要完成的 durable 任务目标。`USER_MESSAGE` 创建新的 Objective；完成、失败、取消会同步闭合 Objective，恢复旧 Session 后收到新输入会先暂停旧 Objective。Objective 属于 Agent Session 投影，不是只存在于 system prompt 的提示词。
_Avoid_: Prompt-only goal, workflow definition, untracked task text

**Durable Plan**:
绑定当前 Objective 的可修订步骤投影。内置 `update_plan` 通过 Tool Host 写入 `PLAN_UPDATED` Durable Session Event；每个版本最多一个 `in_progress` 步骤，Objective 终止时 Plan 同步终止。它只表达当前单 Agent turn 的执行意图，不等同于 Workflow graph，也不承担 child delegation。
_Avoid_: Assistant prose checklist, workflow DAG, UI-only todo list

**Single-level Delegation**:
Parent Session 通过内置 `delegate_task` 创建一个拥有独立 Journal 的 Child Session，并只传显式 context subset、受 Parent 上限约束的子预算和单一 Objective。Parent 等待 Child 终态并通过工具结果归并；Child 的 Approval 代理到 Parent，Parent 取消会级联取消 Child。Child 不暴露 `delegate_task`，恢复时未闭合委派标记为 interrupted 且不自动重放。Child 的 durable Profile 预算也是恢复上限；有效预算取 durable Child 与当前同名 Profile 的更严格值，重启只能保持或收紧，不能扩张。
_Avoid_: Copying parent transcript, nested delegation, hidden child approval, automatic replay after interruption

**Client Session Projection**:
浏览器对一个已选 Agent Session 的只读 durable 投影。它公开 `select / refresh / close / query` 与当前 snapshot；内部原子读取 baseline 和 cursor、按 cursor 连接 SSE、只应用连续 patch、忽略重复或过期选择/事件源，并在游标缺口或无效 patch 时重新读取 baseline。Session-scoped feature query 绑定当前 Session 与 Projection revision，同一 query key 只保留最新请求，选择、刷新或关闭会取消全部旧请求。它复用共享 State Patch Module，不拥有 DOM、Memory/Grant 等 feature data，也不是恢复事实来源。
_Avoid_: UI-owned EventSource, browser reducer, patch without cursor, stale selection overwriting the current view, all-Web global store, source of truth

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
工具安全执行的 deep Module。AgentRuntime 只通过 schemas 与 execute Interface 使用它；参数校验、effects/idempotency 元数据、Policy decision、Approval、deadline、取消、结果脱敏和 durable audit 都集中在其 Implementation 内，Native 与 MCP 是两个真实 Adapter。兼容 Provider 偶尔会把函数参数再次包进唯一的字符串 `arguments` 字段；Host 只在外层 schema 明确失败、内层 JSON 是对象且完整通过目标工具 schema 时恢复一层，之后的 argsHash、资源授权、执行与审计全部绑定恢复后的参数，并记录 `argumentsRecovered`。
_Avoid_: AgentRuntime reading tool approval or execute implementation

**Tool Authorization Decision**:
Tool Host 在执行前根据 Capability Scope、Permission Profile、Workspace Policy 和 Session Grant 产生的可审计决定，绑定 callId、argsHash、toolVersion、policyVersion、capabilityHash、resources、Adapter、risk、profile、explanation 与命中规则。风险等级、沙箱边界和自动审批是独立维度；旧 never/always 字段不再决定权限。
_Avoid_: Prompt-only permission, approval without args identity

**Permission Profile**:
受信任用户选择的自动化姿态，把 Capability risk、资源访问和当前 WorkspaceExecution 隔离强度组合成 allow、approval_required 或 deny。`read-only` 允许普通读取，但对所有 mutation、网络和非只读 Shell 硬拒绝，Workspace Policy/Grant/Approval 均不能提权；Native/Docker 同时强制 workspace 只读，Local Shell fail closed。`workspace-auto` 面向本地开发易用性：普通工作区读写和 Native/Docker 沙箱内常规 Shell 自动执行；工作区内删除、动态解释器、Git 写入、安装与网络操作进入可复用到当前 Session 的 Approval；`.env*`、SSH/云凭据、宿主路径逃逸、sudo 与系统破坏命令仍硬拒绝。`workspace-confirm` 自动读取，但所有普通写入和 Shell 都确认并支持 Session Grant。Profile 不替代 Capability Scope 或 Sandbox；风险高不等于必须硬拒绝，是否能被沙箱限制与是否需要用户确认是两个独立维度。
_Avoid_: Risk level directly equals approval, auto-allowing unsandboxed shell, project config selecting elevated profiles

**Permission Tool Host Router**:
根据 durable Session `permissionProfile` 把同一个 Tool Host Interface 路由到 `read-only`、`workspace-confirm`、`workspace-untrusted`、`workspace-auto`、兼容档位 `approval-required` 或受限注册的 `danger-full-access` Policy。Web 切换只修改会话状态并清空旧 Grant，Router 在每次 schema/execute 时读取最新状态，因此并发 Session 不共享可变全局档位。危险 Host 只能在 `trusted-local` Gateway 注册，Native/Docker 下不存在；Gateway 创建或切换危险 Session 都要求显式确认标记。
_Avoid_: Global mutable profile, UI-only permission labels, switching during execution, unavailable profile falling back to a stronger host

**Access Policy**:
Permission Profile 对 typed resource 的统一判断 Implementation。Tool Host 在 Adapter 前授权，文件 Tool 在直接 fs 访问前按 Session Profile 复用同一策略，search/list 过滤 `.env*`、`.nexus/config.local.json` 与 SSH/云凭据；Shell command 作为 typed resource 进入授权与 durable explanation。`.nexus/.agents/.codex/.git` 除本机秘密配置外读取允许、直接写入需确认；Native/Docker 的 workspace 写隔离负责限制宿主，Tool Host Approval 负责确认 workspace 内风险。`read-only` 不产生可扩权 Approval，并把 `filesystemMode` 传入 WorkspaceExecution：Native 移除 workspace 写根，Docker 使用 readonly mount，Local 无法强制时 fail closed。Native Seatbelt 继续对 workspace/宿主秘密做第二层强制拒绝；trusted-local 完全访问则显式选择无保护分类，避免授权层和执行层使用不同 Profile。
_Avoid_: Separate sensitive-path regexes per tool, shell-only filesystem protection, authorization that implementation can bypass

**Trusted Network Target**:
只来自可信环境或 CLI 的规范 IPv4:TCP 目标。目标列表进入 Permission Profile version；直接网络命令必须显式命中目标，可签发 once/session Approval，但 Session Grant 仍绑定完全相同的命令资源。批准后的 `ExecutionSpec.networkTargets` 让 Native Seatbelt 为该进程树生成精确 `remote tcp` 出站规则，未声明目标、入站、bind、Local/Docker 假隔离均 fail closed。共享 workspace JSON、Workspace Policy 和 Grant 都不能创建新目标。
_Avoid_: Domain wildcards, project-controlled network enablement, session/project grants for network expansion, approval that silently runs with unrestricted networking

**Capability Scope**:
Tool Definition 对副作用、risk、readOnly 与 typed resources 的声明边界。workspace_path 在 Adapter 启动前解析并校验；Capability 内容进入 capabilityHash 和 toolVersion。
_Avoid_: Inferring permissions only from tool name or description

**Workspace Policy**:
工作区 `.nexus/tool-policy.json` 中的简单三态授权规则。显式 deny 优先；从 workspace 加载的规则只能维持或收紧 Permission Profile，不能把 approval_required/deny 提升为 allow。每个决定必须给出 policyVersion、ruleId、profile、reason 和 explanation。
_Avoid_: Prompt-only policy, workspace allow elevating a trusted profile, grant overriding deny

**Session Grant**:
绑定 sessionId、workspace、tool、capabilityHash、policyVersion 与精确资源范围的 durable 授权。Approval 显式选择 once/session：once 绑定当前 callId/argsHash 并在 Adapter 启动前 durable consume；session 最长 8 小时，只在当前 Session 与 workspace 复用。Grant 可过期或撤销，不能跨 Session/workspace 使用；Shell 资源只保存摘要。
_Avoid_: Global reusable approval, replayable call-bound grant, grant without policy identity

**Project Grant**:
由用户在实时 Approval 中显式签发、存放于用户私有 SQLite Store 的跨 Session 授权。它绑定规范 workspace 身份、tool、capabilityHash、policyVersion 与精确资源，最长 30 天；工作区文件不能创建或提升 Project Grant。移动/复制 workspace 不复用，策略或 Capability 变化后不命中，并提供列出、撤销和审计。Web Grant Manager 只投影未消费、未撤销且未过期的授权，显示脱敏资源与到期时间；撤销时由 Gateway 核对真实 scope，运行中 fail closed。
_Avoid_: Project grants stored in the repository, raw secret-bearing shell commands, path-agnostic global grants

**Tool Execution Unknown**:
有副作用且非 safe 的工具在 timeout、cancel 或进程中断时无法证明是否生效的终态。它写入 durable audit，补全工具协议，并禁止自动重放。
只有 Adapter Implementation 已经启动且结果不可证明时才进入 unknown；启动前取消属于确定未执行，补全 cancelled result。
_Avoid_: Timeout means no side effect, automatic replay after crash

**Tool Output Stream**:
WorkspaceExecution 在运行期间发布有序的 stdout/stderr observation，Tool Host 把它收敛为有界、整行发布且先脱敏再持久化的 durable preview。Session 的 `toolStreams` 只是尚未闭合 Tool Call 的实时投影，最终 Tool Result/Artifact 仍拥有完整结果并在闭合时取代该投影；取消、超时和 `execution_unknown` 继续使用同一条工具终态链路。浏览器只消费 Session State Patch，不直接读取子进程，也不把原始 chunk 保存到客户端私有状态。
_Avoid_: Browser-only terminal output, raw chunk per journal event, persisting incomplete credential-bearing lines, replacing final Tool Result with a live preview

**Config Composition**:
把内置默认值、workspace profile、本机私有配置、环境变量和 CLI 覆盖合成为唯一 RuntimeConfig 的 deep Module。每个 leaf 字段保留最终来源；CLI/Gateway 只消费规范化结果，inspection 永不返回原始 Secret。workspace 内 JSON 配置不能启用 MCP、切换 WorkspaceExecution 或选择 Permission Profile，只有受信任环境或显式 CLI 可以。显式 `--demo` 是最高优先级的强制离线选择：所有 Named Agent Profile 保留行为配置但删除 Provider override，Thinking 归一为 `provider-default`；同层 `--provider`/`--provider-thinking` 冲突必须拒绝。
_Avoid_: Entrypoint-specific parsing, hidden precedence, printing raw secrets, process launch from workspace config

**Runtime Assembly**:
从规范化 RuntimeConfig 构造并拥有 Store、Provider bindings、Capability Runtime、WorkspaceExecution、Permission Profiles、Tool Registry、MCP、Tool Hosts 与 Project Grant Store 的 deep Module。基础阶段只打开 Session Store，使 CLI 的列表、Import 和离线流程不会隐式启动 Execution 或 MCP；显式 activate 后才创建可执行对象图。CLI 与 Gateway 是入口 Adapter，不重复知道对象创建顺序；所有 owner-scoped capability、MCP、私有 Grant Store 和 Session Store 由同一个幂等 close 生命周期逆序收敛。Gateway 的每个 AgentRuntime 也由该 Module 的 factory 创建，但 Session 路由、HTTP/SSE 和终端交互仍属于入口 Adapter。
_Avoid_: Entrypoint-owned object graphs, MCP during session listing, duplicated shutdown order, Runtime Assembly absorbing CLI commands or Gateway routing

**Provider Output Stream**:
真实 Provider Adapter 可选提供的增量输出能力。OpenAI-compatible Chat Completions 与原生 OpenAI Responses 两个 Adapter 都只向 Agent Runtime 暴露规范化 `text_delta` 和带完整 `text/toolCalls/usage/finishReason` 的 `completed`；共享代码只负责 SSE framing，原始事件语义、chunk 边界和工具参数碎片留在各 Adapter 内。Responses 的 encrypted reasoning item 和 OpenAI-compatible 的 `reasoning_content` 都规范化为 opaque `provider_items`，随 Assistant Message durable 保存并在对应 Adapter 的工具往返时原样续传，不解释、不展示，也不把可见推理文本加入状态。Runtime 把正文按完整行/句末合并、整段脱敏后写入 `modelStreamChunks` durable projection，Gateway 继续通过 Session Event SSE 发布。取消、失败、进程中断以及 `max_output_tokens/length/content_filter` 等非正常 Provider 终态都保留已持久化部分输出；非正常终态不得标记 Objective 完成，也不得启动其携带的 Tool Call。成功后由最终 Assistant Message 原子取代流投影。Provider 不返回 usage 时允许使用现有估算。
_Avoid_: Token-per-event journal writes, raw Provider SSE in session state, browser-only deltas, persisting unredacted token fragments, treating partial tool arguments as executable calls

**Capability Runtime**:
管理运行时能力实现的 owner、registration identity、active index、lease、撤销和 dispose。Capability Scope 描述“能做什么”，Capability Runtime 描述“实现当前是否存在以及由谁拥有”。撤销先隐藏能力并禁止新 lease，再等待在途 lease，最后清理 owner 资源。
_Avoid_: Static global registries, silent replacement, dispose before visibility revocation, executing through stale capability references

**WorkspaceExecution**:
Tool 与实际执行环境之间的稳定接口。Tool 产生显式 ExecutionSpec，Native/Local/Docker/Remote Adapter 负责 cwd、环境、进程和输出；Tool Host 仍负责 Capability、Policy、Approval、deadline、取消与 unknown 副作用。macOS 默认使用 NativeSandboxAdapter/Seatbelt；LocalWorkspaceAdapter 仅为显式 trusted-local；Docker 是显式可选后端。原生沙箱依赖缺失或平台未实现时 fail closed，不允许回退到 unrestricted。
_Avoid_: child_process inside Tool Registry, full process.env inheritance, shell:true, project config selecting execution mode, silent sandbox fallback, treating OS sandbox or Docker as VM isolation
