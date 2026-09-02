// Shared framing only; Provider-specific event semantics stay inside each Adapter.
export async function* readSseData(body) {
  if (!body || typeof body.getReader !== "function") throw new Error("SSE 响应正文不可读");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const separator = buffer.match(/\r?\n\r?\n/);
        if (!separator) break;
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = parseSseBlock(block);
        if (data != null) yield data;
      }
    }
    buffer += decoder.decode();
    const data = parseSseBlock(buffer);
    if (data != null) yield data;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block) {
  const data = String(block || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return data.length ? data.join("\n") : null;
}
