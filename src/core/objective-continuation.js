const CONTINUE_COMMANDS = new Set([
  "继续", "继续吧", "继续执行", "继续执行吧", "继续做", "继续做吧", "接着做", "接着做吧",
  "继续完成", "继续完成吧", "继续修复", "继续检查", "继续开发", "继续上一个任务",
  "continue", "please continue", "go on", "resume",
]);
const STATUS_QUESTIONS = new Set([
  "修复好了吗", "现在修复好了吗", "做完了吗", "现在做完了吗", "完成了吗", "现在完成了吗",
  "跑完了吗", "现在跑完了吗", "运行完了吗", "现在运行完了吗", "执行完了吗", "现在执行完了吗",
  "现在进度如何", "进度如何", "进展如何", "进度怎么样",
  "is it done", "are you done", "what is the progress",
]);

// Resolve before USER_MESSAGE is journaled: replay must not reclassify old messages.
export function resolveObjectiveMode(state, content, { objective, objectiveMode } = {}) {
  if (objectiveMode !== undefined && !["new", "continue"].includes(objectiveMode)) {
    throw new Error("objectiveMode 必须是 new 或 continue");
  }
  if ((typeof objective === "string" && objective.trim()) || objectiveMode === "new") return "new";
  const status = state?.objective?.status;
  if (!["active", "paused", "failed", "cancelled"].includes(status)) return "new";
  if (objectiveMode === "continue") return "continue";
  const text = normalizeFollowUp(content);
  const command = text.startsWith("请") ? text.slice(1) : text;
  if (CONTINUE_COMMANDS.has(command)) return "continue";
  if (status !== "cancelled" && (isObjectiveStatusQuestion(content) || text === "修复检查看下")) return "continue";
  return "new";
}

export function isObjectiveStatusQuestion(content) {
  return STATUS_QUESTIONS.has(normalizeFollowUp(content));
}

function normalizeFollowUp(content) {
  return String(content || "").trim().toLowerCase().replace(/[。.!！?？]+$/u, "").trim();
}
