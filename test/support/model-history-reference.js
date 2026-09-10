// Freeze only the stage 18 initial messages snapshot. Prompt preparation,
// history shaping and window planning stay shared to isolate this copy seam.
import { readFile } from "node:fs/promises";
const sourceUrl = new URL("../../src/core/model-context.js", import.meta.url);

export async function loadHistorySnapshotReference() {
  let source = await readFile(sourceUrl, "utf8");
  const seam = "const durableMessages = historyForProjection(context.messages, ownedContext);";
  if (!source.includes(seam)) throw new Error("History snapshot reference no longer matches the production seam");
  source = source.replace(seam, "const durableMessages = structuredClone(context.messages);");
  source = source.replace(/(from\s+["'])(\.[^"']+)(["'])/g,
    (_, before, specifier, after) => `${before}${new URL(specifier, sourceUrl).href}${after}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
