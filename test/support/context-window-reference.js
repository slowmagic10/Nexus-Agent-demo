// Frozen pre-optimization selector; all other request shaping is shared and
// covered by the existing protocol tests. No server or model is invoked.
import { readFile } from "node:fs/promises";
const sourceUrl = new URL("../../src/core/model-context.js", import.meta.url);
const legacySelector = String.raw`function selectCompactedTurns({ systemPrompt, turns, tools, maxInputTokens, prefixMessages, strictLatest }) {
  const latestTurn = turns.at(-1) || [];
  const latestMessages = [...prefixMessages, ...latestTurn];
  const latest = measureRequest(systemPrompt, latestMessages, tools);
  if (latest.estimatedInputTokens > maxInputTokens) {
    if (!strictLatest) return null;
    const firstIncludedTurn = Math.max(0, turns.length - 1);
    return {
      selectedMessages: latestTurn,
      firstIncludedTurn,
      includedMessages: latestTurn.length,
      omittedMessages: turns.flat().length - latestTurn.length,
      includedTurns: latestTurn.length ? 1 : 0,
      omittedTurns: firstIncludedTurn,
    };
  }
  let firstIncludedTurn = Math.max(0, turns.length - 1);
  let selectedTurns = latestTurn.length ? [latestTurn] : [];
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const candidate = [...prefixMessages, turns[index], ...selectedTurns].flat();
    if (measureRequest(systemPrompt, candidate, tools).estimatedInputTokens > maxInputTokens) break;
    selectedTurns = [turns[index], ...selectedTurns];
    firstIncludedTurn = index;
  }
  const selectedMessages = selectedTurns.flat();
  return {
    selectedMessages,
    firstIncludedTurn,
    includedMessages: selectedMessages.length,
    omittedMessages: turns.flat().length - selectedMessages.length,
    includedTurns: selectedTurns.length,
    omittedTurns: Math.max(0, firstIncludedTurn),
  };
}
`;

export async function loadLegacyWindowReference() {
  let source = await readFile(sourceUrl, "utf8");
  const indexCall = "buildTurnBudgetIndex(turns, compactedSystemPrompt, durableTools)";
  if (!source.includes(indexCall) || !source.includes("function selectCompactedTurns(")) {
    throw new Error("Context window reference loader no longer matches the production seam");
  }
  source = source.replace(indexCall, "null")
    .replace("function selectCompactedTurns(", "function selectCompactedTurnsOptimized(");
  source = source.replace(/(from\s+["'])(\.[^"']+)(["'])/g,
    (_, before, specifier, after) => `${before}${new URL(specifier, sourceUrl).href}${after}`);
  source += `\n${legacySelector}\n`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
