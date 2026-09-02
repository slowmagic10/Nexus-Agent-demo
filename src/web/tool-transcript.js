// Tool cards consume results by call occurrence, because Provider call IDs are not globally unique.
export function createToolTranscriptCursor(messages = [], events = []) {
  const results = queueBy(
    messages.filter((message) => message?.role === "tool" && message.tool_call_id),
    (message) => message.tool_call_id,
  );
  const completions = queueBy(
    events.filter((event) => event?.type === "tool.completed" && event.callId),
    (event) => event.callId,
  );

  return {
    next(callId) {
      if (typeof callId !== "string" || !callId) return { result: null, fileChanges: null };
      const result = shift(results, callId);
      const completion = shift(completions, callId);
      return {
        result: result || null,
        fileChanges: completion?.fileChanges || null,
      };
    },
  };
}

function queueBy(values, keyOf) {
  const queues = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(value);
  }
  return queues;
}

function shift(queues, key) {
  const queue = queues.get(key);
  return queue?.length ? queue.shift() : null;
}
