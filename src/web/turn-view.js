// UI-only projection: a user message starts a visible turn; Provider tool steps stay inside it.
export function projectDisplayTurns(messages = []) {
  const turns = [];
  let current = null;

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "user") {
      current = { user: message, assistantMessages: [] };
      turns.push(current);
      continue;
    }
    if (message?.role !== "assistant") continue;
    if (!current) {
      current = { user: null, assistantMessages: [] };
      turns.push(current);
    }
    current.assistantMessages.push(message);
  }

  return turns.map(finalizeTurn);
}

function finalizeTurn(turn) {
  const last = turn.assistantMessages.at(-1) || null;
  const finalMessage = last && !hasToolCalls(last) && hasVisibleContent(last)
    ? last
    : null;
  const activityMessages = (finalMessage
    ? turn.assistantMessages.slice(0, -1)
    : turn.assistantMessages.slice())
    .filter((message) => hasToolCalls(message) || hasVisibleContent(message));
  return {
    user: turn.user,
    activityMessages,
    finalMessage,
    assistantMessageCount: turn.assistantMessages.length,
    toolCallCount: activityMessages.reduce(
      (total, message) => total + (Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0),
      0,
    ),
  };
}

function hasToolCalls(message) {
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

function hasVisibleContent(message) {
  return typeof message?.content === "string" && message.content.trim().length > 0;
}
