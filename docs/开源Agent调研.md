# Hermes / OpenClaw / Pi 同类开源 Agent 调研

> 调研日期：2026-08-13
>
> 本次筛选口径：寻找可以直接运行、能够操作终端/文件/浏览器或外部服务、支持多模型和工具扩展、并且适合长期使用或二次开发的 Agent 产品/Agent Harness。通用编排框架（LangGraph、CrewAI、LlamaIndex 等）不放在主榜单，它们属于“用来构建 Agent 的底层框架”，不是本次要找的同类产品。

## 结论先说

最接近你想做的方向的，不是普通聊天机器人，而是下面这类“可执行 Agent”：

- 有一个持续运行的 Agent Loop；
- 能调用 shell、文件、浏览器、代码执行或外部 API；
- 有 workspace、上下文文件、Skills/Extensions 或 MCP；
- 有会话、记忆、日志、权限确认和模型切换；
- 可以通过 CLI/TUI、桌面端、IDE、Web 或消息平台使用。

建议重点研究这 10 款：

| 项目 | 最接近的方向 | 运行入口 | 关键能力 | 适合借鉴的部分 |
|---|---|---|---|---|
| Hermes Agent | 常驻个人 Agent | CLI/TUI、Telegram、Discord、Slack、WhatsApp | 持久记忆、自我改进 Skills、多模型、MCP、定时任务 | 记忆、技能学习、消息网关、远程部署 |
| OpenClaw | 常驻个人助手 / Agent Gateway | Gateway、消息平台、Canvas | 多渠道、Workspace、Skills、常驻服务、设备端操作 | Gateway、渠道适配、工作区上下文、权限策略 |
| Pi | 终端 Coding Agent / Agent SDK | CLI/TUI、SDK、RPC | 文件和 bash 工具、会话分支、上下文压缩、Extensions、Skills | 最小 Agent Core、扩展系统、SDK/RPC |
| Goose | 通用本机 Agent | 桌面端、CLI、API | 代码、研究、写作、自动化、MCP 扩展、多模型 | Rust Agent Runtime、MCP、桌面/CLI/API 三端 |
| OpenCode | 开源终端 Coding Agent | TUI、桌面端、IDE、Server/Client | 文件编辑、命令、LSP、会话、SQLite、子 Agent、多模型 | TUI、Server/Client、代码上下文和 LSP |
| Cline | Coding Agent SDK / IDE / CLI | VS Code、CLI、SDK、Telegram | 文件、shell、浏览器、API、MCP、SQLite 会话、定时任务 | 分层 SDK、权限确认、可编程 Agent 服务 |
| Open Interpreter | 通用计算机 Agent | CLI、Python、桌面端 | 执行 Python/JavaScript/Shell、浏览器、文件、数据和媒体处理 | `exec()` 工具、确认机制、本机操作抽象 |
| gptme | 通用终端个人 Agent | CLI、Web、SSH、tmux、CI | shell、Python、网页、视觉、MCP/ACP、Plugins、Lessons、Guardrails | 轻量通用 Agent、工具反馈、自纠错、长期经验 |
| OpenHands | 软件工程 Agent 平台 | Web、CLI、Agent Server | 编辑代码、运行命令、浏览器、事件流、会话、Docker 沙箱 | EventStream、Controller/State、运行时隔离 |
| Aider | 终端结对编程 Agent | CLI、IDE 终端 | 代码库地图、增量编辑、Git 提交、测试/lint、多模型 | 代码上下文、diff/Git 工作流、低复杂度产品化 |

其中 Hermes、OpenClaw、Goose、gptme 更偏“通用个人助手”；Pi、OpenCode、Cline、Aider 更偏“终端 Coding Agent”；Open Interpreter 是“可以操作计算机的通用 Agent”；OpenHands 是“完整软件工程 Agent 平台”。

## 逐项调研

### 1. Hermes Agent

官方仓库：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)

Hermes Agent 是 Nous Research 的自托管个人 Agent。它的显著特点是跨会话持久记忆和学习循环：Agent 可以从使用经验中创建或改进 Skills，把知识写入长期记忆，并搜索过去的对话。它支持 Nous Portal、OpenRouter、OpenAI、Ollama 或自定义 OpenAI-compatible endpoint，并提供 CLI/TUI、MCP、定时任务和 Telegram、Discord、Slack、WhatsApp 等消息网关。

构建方式可以拆成：

```text
模型路由
  ↓
Agent Loop（观察 → 决策 → 工具调用 → 结果反馈）
  ↓
工具/Toolset + MCP + Skills
  ↓
会话上下文 + 持久记忆 + 用户画像
  ↓
CLI/TUI 或 Messaging Gateway
```

最值得借鉴的是“Agent OS”思路：模型只是其中一层，真正让 Agent 变得可长期使用的是记忆、技能、上下文文件、渠道和权限系统。自主权限较大，必须先配置命令审批、DM 配对、容器隔离、网络权限和密钥范围。

### 2. OpenClaw

官方仓库：[openclaw/openclaw](https://github.com/openclaw/openclaw)

OpenClaw 是运行在用户设备上的常驻个人 AI 助手。它的 Gateway 是控制平面，连接 Agent 会话、消息渠道、工作区、Skills 和 Canvas。支持 WhatsApp、Telegram、Slack、Discord、Signal、iMessage、Teams、飞书、LINE、微信、QQ 等渠道。

典型结构是：

```text
消息渠道 / Web / Canvas
          ↓
       Gateway
          ↓
 Agent Session + Workspace
          ↓
 Skills / MCP / 文件 / Shell / 浏览器
```

它特别适合参考“消息入口 + 常驻 Gateway + 本地工作区”的架构。workspace 中的 `AGENTS.md`、`SOUL.md` 等文件用于定义行为和上下文。接入真实消息账号后，Agent 可能读写文件、执行命令和向外发消息，因此必须设置 `allowFrom`、专用账号、心跳开关和工具策略。

### 3. Pi

官方仓库：[badlogic/pi-mono](https://github.com/badlogic/pi-mono)，[Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

Pi 是 Mario Zechner 的终端 Coding Agent 和 TypeScript Agent 工具链。它不是一个庞大的平台，而是把核心保持得很小，再通过包和扩展组合能力：

- `pi-ai`：统一 Anthropic、OpenAI、Google 等模型 API；
- `pi-agent-core`：Agent 状态、消息、工具调用和事件；
- `pi-coding-agent`：交互式 CLI/TUI、文件和 bash 工具；
- 其他包：TUI、Web UI、Slack bot、vLLM pod 管理。

Pi 支持会话管理、分支、上下文压缩、模型切换、Skills、Hooks、自定义命令、Extensions 和 RPC。除了运行 CLI，还可以用 `createAgentSession`、`defineTool` 直接嵌入 Node.js 应用。它非常适合用来研究“一个可扩展 Agent Harness 的最小内核应该是什么”。

### 4. Goose

官方仓库：[aaif-goose/goose](https://github.com/aaif-goose/goose)，[官方文档](https://block-goose.mintlify.app/)

Goose 是 Block 发起、后来迁移到 Linux Foundation Agentic AI Foundation 的开源通用 Agent。它提供桌面端、CLI 和 API，目标不只是代码补全，也包括研究、写作、数据分析和自动化。项目用 Rust 构建，支持 15+ 模型供应商，并通过 MCP 连接扩展；官方仓库标注 Apache-2.0。

构建方式偏“Runtime + Extensions”：Agent Loop 负责计划和工具调用，Developer 等扩展负责 shell、文件和代码操作，MCP 负责接入外部工具。Goose 的桌面端/CLI/API 三种入口值得借鉴，适合做一个跨端 Agent 产品。

### 5. OpenCode

官方仓库：[anomalyco/opencode](https://github.com/anomalyco/opencode)，[官方文档](https://opencode.ai/docs)

OpenCode 是开源终端 Coding Agent，也提供桌面端和 IDE 入口。它支持多模型供应商、本地模型、文件搜索和修改、命令执行、LSP、会话管理、SQLite 持久化、文件变更跟踪和子 Agent。其重要架构取舍是 Client/Server：Agent 可以在一台机器上运行，TUI、桌面或移动客户端作为控制端连接。

它适合借鉴 Coding Agent 的工程化细节：代码上下文如何加载、LSP 如何提供语义信息、会话如何存 SQLite、工具变更如何可视化、远程控制如何和 Agent Runtime 解耦。

### 6. Cline

官方仓库：[cline/cline](https://github.com/cline/cline)，[Cline SDK](https://github.com/cline/cline/tree/main/sdk)

Cline 现在不仅是 VS Code Agent，也提供 CLI 和 SDK。SDK 分层包括 `@cline/core`（会话、持久化、工具和 RPC）、`@cline/agents`（Agent Loop）、`@cline/llms`（模型供应商）和 `@cline/shared`。内置能力包含 bash、文件读写、补丁、搜索、网页抓取、自定义工具、MCP、SQLite 会话和定时任务，CLI 还支持连接 Telegram。

它是很好的“把一个 IDE Agent 拆成可复用平台”的参考。若你想做自己的 Agent，Cline SDK 的分层方式比直接复制整个 IDE 插件更值得研究。

### 7. Open Interpreter

官方仓库：[openinterpreter/open-interpreter](https://github.com/OpenInterpreter/open-interpreter)，[官方文档](https://www.openinterpreter.com/docs/terminal)

Open Interpreter 是通用计算机 Agent：模型通过 `exec()` 执行 Python、JavaScript 或 Shell，可以处理文件、浏览器、媒体、PDF 和数据分析，也可以作为 Python 库嵌入。它支持 OpenAI-compatible endpoint、Ollama、LM Studio 等本地模型。

最小构建闭环很清晰：

```text
用户目标 → 模型生成代码 → exec() 执行 → 捕获输出/错误 → 回传模型 → 继续或结束
```

这个方案非常适合作为第一版原型，但安全风险也最直接。官方默认要求用户确认执行；如果关闭确认，必须使用沙箱、白名单、资源限制和文件系统隔离。

### 8. gptme

官方仓库：[gptme/gptme](https://github.com/gptme/gptme)

gptme 是一个通用终端个人 Agent，可以运行在笔记本、SSH、tmux、无头服务器、CI 中。它支持 shell、Python、网页、视觉、MCP、ACP、Plugins、Skills、Lessons 和 Guardrails，模型可以使用 Anthropic、OpenAI、Google、DeepSeek、OpenRouter 或本地 `llama.cpp`。

它的一个重要设计是把工具输出持续反馈给模型，使 Agent 能自我纠错；Lessons 系统则用于沉淀可复用经验。相比 OpenClaw，gptme 更轻量、更终端化，适合从小规模代码开始搭建通用 Agent。

### 9. OpenHands

官方仓库：[OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)，[Runtime 文档](https://docs.openhands.dev/openhands/usage/architecture/runtime)

OpenHands 是面向软件开发的完整 Agent 平台。核心抽象包括 LLM、Agent、AgentController、State 和 EventStream：Agent 根据当前 State 产生 Action，Controller 推进循环，EventStream 记录 Action/Observation。命令执行和代码运行通常放在 Docker Runtime 中，以隔离宿主机。

它适合学习复杂 Agent 产品如何组织会话、终端、浏览器、文件、Agent Server、前端和自动化任务。若你只想做一个小型个人 Agent，不需要一开始复制 OpenHands 的全部服务，但 EventStream、Controller/State 和 Runtime 沙箱值得保留。

### 10. Aider

官方仓库：[Aider-AI/aider](https://github.com/Aider-AI/aider)

Aider 是终端 AI 结对编程工具，支持云端和本地模型、整个代码库的 repo map、增量编辑、Git 自动提交、diff/撤销、lint/test 和图像/网页上下文。它比 Pi、OpenCode 更偏“开发者和 Agent 协作”，自主性相对低，但产品结构简单、代码上下文和 Git 工作流成熟。

如果你的目标是做 Coding Agent，Aider 很适合学习如何把 Agent 的修改变成可审查的 patch，如何让模型理解大型代码库，以及如何用测试和 Git 把 Agent 行为纳入工程流程。

## 横向对比

| 项目 | 通用个人助理 | Coding Agent | 本机执行 | 多渠道消息 | 持久记忆 | Skills/Extensions | MCP | 适合直接改造 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Hermes | ★★★ | ★★ | ★★★ | ★★★ | ★★★ | ★★★ | ★★★ | ★★★ |
| OpenClaw | ★★★ | ★★ | ★★★ | ★★★ | ★★ | ★★★ | ★★ | ★★★ |
| Pi | ★ | ★★★ | ★★★ | ★ | ★★ | ★★★ | ★★ | ★★★ |
| Goose | ★★ | ★★★ | ★★★ | ★ | ★★ | ★★★ | ★★★ | ★★★ |
| OpenCode | ★ | ★★★ | ★★★ | ★ | ★★ | ★★ | ★★ | ★★★ |
| Cline | ★ | ★★★ | ★★★ | ★★ | ★★ | ★★★ | ★★★ | ★★★ |
| Open Interpreter | ★★★ | ★★ | ★★★ | ★ | ★ | ★★ | ★★ | ★★ |
| gptme | ★★★ | ★★★ | ★★★ | ★ | ★★ | ★★★ | ★★ | ★★★ |
| OpenHands | ★ | ★★★ | ★★★（沙箱） | ★ | ★★ | ★★ | ★★ | ★★ |
| Aider | ★ | ★★★ | ★★ | ★ | ★ | ★ | ★ | ★★ |

星级是针对本次“构建类似 Hermes/OpenClaw/Pi 的 Agent”目标的相对评价，不是总体质量排名。

## 最值得拆解的共性架构

```text
交互层：CLI/TUI / Web / Desktop / IDE / Telegram 等
                         ↓
会话层：Session、History、Branch、Compaction、任务恢复
                         ↓
Agent Core：模型请求 → 工具选择 → 执行 → Observation → 下一轮
                         ↓
工具层：read/write/edit、shell、browser、computer-use、MCP、API
                         ↓
上下文层：AGENTS.md / SOUL.md、Skills、项目文件、记忆、用户偏好
                         ↓
安全层：审批、权限、沙箱、allowlist、超时、预算、审计
                         ↓
运行层：本机、Docker、VPS、远程 Agent Server、CI
```

## 建议你自己的第一版怎么做

如果目标是做一个类似这三款的 Agent，建议不要从 LangGraph 或 CrewAI 开始，而是先实现一个自己的最小 Harness：

1. **Agent Loop**：模型 → 工具调用 → 工具结果 → 模型，限制最大轮数。
2. **四个基础工具**：读文件、写文件、搜索文件、执行受限 shell。
3. **Workspace**：支持 `AGENTS.md` 或 `SOUL.md`，启动时加载项目规则和人格配置。
4. **Session**：JSONL 保存消息、工具调用、错误和结果，支持恢复和导出。
5. **模型适配**：先支持一个 OpenAI-compatible API，再做 Anthropic/Ollama 等适配。
6. **Skills**：每个 Skill 一个目录和 Markdown 指令，按需加载，不要一次塞进系统提示词。
7. **安全控制**：危险命令确认、工作区路径限制、超时、步骤数/token 预算、敏感信息过滤。
8. **可观测性**：记录每次模型调用、工具参数、执行耗时、token、成本和失败原因。

一个合理的技术路线是：

```text
第一阶段：参考 Pi / gptme，做 CLI + Agent Loop + 文件/终端工具
第二阶段：参考 OpenClaw / Hermes，加入 Workspace、Skills、Memory、Gateway
第三阶段：参考 Goose / Cline，加入 MCP、SDK、RPC、桌面/Web/消息入口
第四阶段：参考 OpenHands，加入沙箱、远程运行时、事件流和并发任务
```

## 选择建议

- 想做“个人常驻助理”：优先研究 **OpenClaw + Hermes + gptme**。
- 想做“终端 Coding Agent”：优先研究 **Pi + OpenCode + Cline + Aider**。
- 想做“通用本机操作 Agent”：优先研究 **Goose + Open Interpreter**。
- 想做“可远程部署的软件工程 Agent”：优先研究 **OpenHands**。
- 想快速做第一版：建议组合 **Pi 的最小 Agent Core + OpenClaw 的 Workspace/Skills 思路 + Hermes 的 Memory/Gateway 思路**。

## 额外候选

如果后续需要专门做 SWE-bench/自动修复 GitHub Issue，可以再看 [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent)；它只有约百行核心 Agent 逻辑，适合研究最小化 Coding Agent，但不属于个人常驻助手。

## 许可证和安全提醒

本列表只代表“代码开源/可自托管”的项目，不代表模型、插件、消息平台或第三方数据源都可以自由商用。部署前要分别核对项目 LICENSE、模型许可证、插件条款和 API 条款。凡是能执行 shell、写文件、浏览网页或发送消息的 Agent，都应默认按高权限软件处理：使用专用账号、受限 workspace、最小权限、沙箱、审批、超时和审计。

