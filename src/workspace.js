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
  return (context) => `你是 Nexus，一个运行在用户本机工作区内的可执行 Agent。\n\n${workspaceContext}\n\n规则：\n- 先理解目标，再选择最少的工具调用。\n- 只读工具可直接调用；写入和 Shell 会由运行时请求用户审批。\n- 不要声称执行过未执行的操作。\n- 工具失败后解释原因或尝试安全替代。\n- 回答使用中文。\n\n当前会话记忆：\n${context.memory.map((item) => `- ${item.content}`).join("\n") || "（空）"}\n\n与本轮相关的长期记忆：\n${context.contextMemory.map((item) => `- [${item.id}] ${item.content}`).join("\n") || "（空）"}\n\n已加载 Skills：\n${context.loadedSkills.map((skill) => `### ${skill.name}\n${skill.content}`).join("\n") || "（无）"}`;
}
