import assert from "node:assert/strict";
import test from "node:test";
import { projectDisplayTurns } from "../src/web/turn-view.js";

test("同一用户 Turn 的多次模型步骤投影为一个 Agent 回应", () => {
  const messages = [
    { role: "user", content: "检查并修复" },
    {
      role: "assistant",
      content: "先检查实现。",
      tool_calls: [{ id: "call-1", name: "search_files" }, { id: "call-2", name: "read_file" }],
    },
    { role: "tool", tool_call_id: "call-1", content: "结果一" },
    { role: "tool", tool_call_id: "call-2", content: "结果二" },
    {
      role: "assistant",
      content: "继续验证。",
      tool_calls: [{ id: "call-3", name: "run_shell" }],
    },
    { role: "tool", tool_call_id: "call-3", content: "通过" },
    { role: "assistant", content: "修复完成。" },
  ];

  const turns = projectDisplayTurns(messages);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].user.content, "检查并修复");
  assert.deepEqual(turns[0].activityMessages, [messages[1], messages[4]]);
  assert.equal(turns[0].finalMessage, messages[6]);
  assert.equal(turns[0].toolCallCount, 3);
});

test("新的用户消息才开始新的可见 Turn", () => {
  const messages = [
    { role: "user", content: "第一轮" },
    { role: "assistant", content: "第一轮完成" },
    { role: "user", content: "第二轮" },
    { role: "assistant", tool_calls: [{ id: "call-2", name: "read_file" }] },
    { role: "tool", tool_call_id: "call-2", content: "读取完成" },
  ];

  const turns = projectDisplayTurns(messages);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].finalMessage.content, "第一轮完成");
  assert.equal(turns[1].finalMessage, null);
  assert.equal(turns[1].activityMessages.length, 1);
});

test("旧式无用户前缀的 Assistant 消息保留为独立兼容 Turn", () => {
  const messages = [
    { role: "assistant", content: "恢复后的历史说明" },
    { role: "user", content: "继续" },
  ];

  const turns = projectDisplayTurns(messages);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].user, null);
  assert.equal(turns[0].finalMessage.content, "恢复后的历史说明");
  assert.equal(turns[1].user.content, "继续");
});
