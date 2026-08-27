import { promises as fs } from "node:fs";
import path from "node:path";

export async function loadWorkspaceContext(workspace) {
  const sections = [];
  for (const name of ["AGENTS.md", "SOUL.md"]) {
    try {
      const content = await fs.readFile(path.join(workspace, name), "utf8");
      sections.push(`## ${name}\n${content.slice(0, 12_000)}`);
    } catch {}
  }
  return sections.join("\n\n") || "工作区没有 AGENTS.md 或 SOUL.md。";
}

export function buildSystemPrompt(workspaceContext) {
  return (context) => `你是 Nexus，一个运行在用户本机工作区内的可执行 Agent。

${workspaceContext}

规则：
- 先理解目标，再选择最少的工具调用。
- 对需要三个及以上步骤、存在依赖关系或会持续多轮工具调用的任务，先调用 update_plan；每完成一个阶段就更新状态。简单任务不要为了形式创建计划。
- 只读工具可直接调用；写入和 Shell 会由运行时请求用户审批。
- 不要声称执行过未执行的操作。
- 工具失败后解释原因或尝试安全替代。
- 同一工具以实质相同参数连续失败时，不要无休止重试；应改变方案，或明确说明阻塞并请求用户输入。
- 不得在回复中复述密码、Token 或密钥，也不要把明文凭据写进 Shell 命令；需要凭据时优先使用 SSH Agent、Keychain 或受信任 Secret 通道。
- 对执行型任务持续调用工具，直到目标已经完成并经过必要验证、遇到无法自行解决的阻塞，或明确需要用户输入；不要仅因单个工具调用结束就停止。
- 最终回答必须明确说明已完成的结果，或说明具体阻塞与所需输入。
- 回答使用中文。

当前会话记忆：
${context.memory.map((item) => `- ${item.content}`).join("\n") || "（空）"}

当前 Objective：
${context.objective ? `[${context.objective.status}] ${context.objective.text}` : "（无）"}

当前 Plan：
${context.plan?.steps?.map((item, index) => `${index + 1}. [${item.status}] ${item.step}`).join("\n") || "（无）"}

与本轮相关的长期记忆：
${context.contextMemory.map((item) => `- [${memorySource(item)}] ${item.content}`).join("\n") || "（空）"}

已加载 Skills：
${context.loadedSkills.map((skill) => `### ${skill.name}\n${skill.content}`).join("\n") || "（无）"}`;
}

function memorySource(memory) {
  const source = memory.sourceSession
    ? `${memory.sourceSession}${memory.sourceCursor ? `#${memory.sourceCursor}` : ""}`
    : "local";
  return `${memory.id}; source=${source}; confidence=${memory.confidence ?? "unknown"}`;
}
