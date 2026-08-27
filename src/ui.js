import readline from "node:readline";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const cyan = "\x1b[36m";
const yellow = "\x1b[33m";
const reset = "\x1b[0m";

export class TerminalUI {
  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.closed = false;
    this.rl.once("close", () => {
      this.closed = true;
    });
    this.lastAnswer = "欢迎。输入一个任务，或输入 /help 查看离线演示示例。";
  }

  render(state) {
    console.clear();
    const event = state.events.at(-1);
    console.log(`${bold}${cyan}NEXUS AGENT${reset} ${yellow}FOUNDATION — 本地基础版${reset}`);
    console.log(`${dim}问题：审批、事件流、工具反馈、记忆与 Skills 组成的最小 Agent 状态模型是否顺手？${reset}\n`);
    console.log(`${bold}会话${reset}      ${state.id}`);
    console.log(`${bold}阶段${reset}      ${state.phase}`);
    console.log(`${bold}模型${reset}      ${state.provider}`);
    console.log(`${bold}工作区${reset}    ${state.workspace}`);
    console.log(`${bold}进度${reset}      step ${state.step} · 模型 ${state.metrics.modelCalls} · 工具 ${state.metrics.toolCalls} · 审批 ${state.metrics.approvals}`);
    console.log(`${bold}用量${reset}      ${state.metrics.totalTokens || 0} tokens · 模型 ${state.metrics.modelDurationMs || 0}ms · 工具 ${state.metrics.toolDurationMs || 0}ms`);
    console.log(`${bold}记忆/技能${reset} ${state.memory.length} / ${state.loadedSkills.length}`);
    console.log(`${bold}最新事件${reset}  ${event ? `${event.seq} ${event.type}` : "（无）"}`);
    if (state.lastError) console.log(`${bold}错误${reset}      ${state.lastError}`);
    console.log(`\n${bold}最近回答${reset}\n${this.lastAnswer}`);
    console.log(`\n${dim}/help 帮助  /state 状态  /events 事件  /memory 会话记忆  /long-memory 长期记忆  /memory-issues 异常写入  /sessions 会话  /export 导出  /quit 退出${reset}`);
  }

  question(prompt) {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.rl.off("close", onClose);
        resolve(value);
      };
      const onClose = () => finish(null);
      this.rl.once("close", onClose);
      try {
        this.rl.question(prompt, finish);
      } catch (error) {
        this.rl.off("close", onClose);
        if (error.code === "ERR_USE_AFTER_CLOSE") finish(null);
        else reject(error);
      }
    });
  }

  async approve(call, description, state) {
    this.render(state);
    console.log(`\n${yellow}${bold}需要审批${reset}`);
    console.log(`${description}`);
    console.log(`${bold}${call.name}${reset} ${JSON.stringify(call.arguments, null, 2)}`);
    const answer = await this.question("\n授权范围：[o] 仅本次 / [s] 本会话 / [p] 本项目 / [N] 拒绝：");
    const choice = answer?.trim().toLowerCase() || "";
    if (["o", "once", "y", "yes"].includes(choice)) return { approved: true, scope: "once" };
    if (["s", "session"].includes(choice)) return { approved: true, scope: "session" };
    if (["p", "project"].includes(choice)) return { approved: true, scope: "project" };
    return false;
  }

  answerFrom(state) {
    const message = [...state.messages].reverse().find((item) => item.role === "assistant" && item.content);
    this.lastAnswer = message?.content || (state.phase === "failed" ? `失败：${state.lastError}` : "任务已完成。");
  }

  close() {
    if (!this.closed) this.rl.close();
  }
}

export function helpText() {
  return `离线演示可尝试：\n- 查看工作区有哪些文件\n- 读取 AGENTS.md\n- 搜索：Agent Loop\n- 记住：我偏好本地模型\n- 查看记忆\n- 查看技能\n- 创建 nexus-output.txt 内容：hello nexus（workspace-auto 自动执行）\n- 运行：pwd（Native/Docker 沙箱内自动执行）\n- 运行：npm install（需要审批）\n- 使用 demo:mcp 启动后输入 MCP 回显：hello（需要审批）\n\n会话：/sessions 查看；长期记忆：/long-memory；来源审计：/memory-info=ID；软删除：/forget=ID；异常写入：/memory-issues、/memory-retry=ID、/memory-discard=ID、/memory-resolve=ID,MEMORY_ID；导出：/export。\n退出后用 --resume=latest 或 --resume=会话ID 恢复。\n真实模型：设置 OPENAI_API_KEY、OPENAI_MODEL；可选 OPENAI_BASE_URL。`;
}
