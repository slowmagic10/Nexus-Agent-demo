// Prompt dependencies belong to exact, explicitly constructed functions. Plain
// callbacks, bound functions and Proxies keep the full-context contract.
const promptFields = new WeakMap();
const allowedFields = new Set([
  "messages", "memory", "contextMemory", "contextSummary", "loadedSkills",
  "objective", "plan", "delegations",
]);
const emptyFields = Object.freeze([]);

export function defineSystemPrompt(fields, render) {
  const selected = Array.isArray(fields) ? [...fields] : null;
  if (!selected || selected.some((field) => !allowedFields.has(field))) {
    throw new Error("System Prompt fields 必须是模型上下文字段数组");
  }
  if (typeof render !== "function") throw new Error("System Prompt render 必须是函数");
  const prompt = (context) => render(context);
  promptFields.set(prompt, Object.freeze([...new Set(selected)]));
  return prompt;
}

export function systemPromptFields(prompt) {
  // String conversion of arbitrary objects can run user code. Only primitive
  // strings are implicitly context-free; all other values retain the old path.
  return typeof prompt === "string" ? emptyFields : promptFields.get(prompt) ?? null;
}
