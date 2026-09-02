import assert from "node:assert/strict";
import test from "node:test";
import { retrieveContextMemories } from "../src/memory/context-retrieval.js";

test("Pinned 与 Relevant Memory 使用独立预算且固定记忆优先", async () => {
  const calls = [];
  const pinned = { id: "pinned-1", content: "固定事实".repeat(100), pinned: true };
  const relevant = { id: "relevant-1", content: "相关事实".repeat(100), pinned: false };
  const memory = {
    search: async (query, access, options) => {
      calls.push({ query, access, options });
      return options.pinned ? [pinned] : [pinned, relevant];
    },
  };

  const result = await retrieveContextMemories(memory, "当前任务", {
    scope: { workspace: "/repo", agentId: "default", userId: "local" },
    pinnedTokenBudget: 80,
    relevantTokenBudget: 90,
  });

  assert.deepEqual(calls.map((call) => ({ query: call.query, pinned: call.options.pinned })), [
    { query: "", pinned: true },
    { query: "当前任务", pinned: false },
  ]);
  assert.deepEqual(result.map((item) => item.id), ["pinned-1", "relevant-1"]);
  assert.equal(result[0].contextRetrievalClass, "pinned");
  assert.equal(result[1].contextRetrievalClass, "relevant");
  assert.equal(result[0].contextTruncated, true);
  assert.equal(result[1].contextTruncated, true);
  assert.ok(result[0].contextEstimatedTokens <= 80);
  assert.ok(result[1].contextEstimatedTokens <= 90);
  assert.equal(result[0].contextBudgetTokens, 80);
  assert.equal(result[1].contextBudgetTokens, 90);
});
