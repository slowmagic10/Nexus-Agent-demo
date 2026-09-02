import assert from "node:assert/strict";
import test from "node:test";
import { createToolTranscriptCursor } from "../src/web/tool-transcript.js";

test("Tool Transcript 按出现顺序配对重复 callId，不把旧结果套到运行中调用", () => {
  const messages = [
    { role: "assistant", tool_calls: [{ id: "reused" }] },
    { role: "tool", tool_call_id: "reused", content: "old result" },
    { role: "assistant", content: "first done" },
    { role: "user", content: "again" },
    { role: "assistant", tool_calls: [{ id: "reused" }] },
  ];
  const events = [{
    type: "tool.completed",
    callId: "reused",
    fileChanges: { complete: true, changes: [{ path: "old.txt" }] },
  }];
  const cursor = createToolTranscriptCursor(messages, events);

  assert.deepEqual(cursor.next("reused"), {
    result: messages[1],
    fileChanges: events[0].fileChanges,
  });
  assert.deepEqual(cursor.next("reused"), { result: null, fileChanges: null });
});

test("Tool Transcript 为同一 callId 的多个已完成调用逐个消费结果", () => {
  const messages = [
    { role: "tool", tool_call_id: "reused", content: "first" },
    { role: "tool", tool_call_id: "reused", content: "second" },
  ];
  const events = [
    { type: "tool.completed", callId: "reused" },
    { type: "tool.completed", callId: "reused", fileChanges: { complete: false, changes: [] } },
  ];
  const cursor = createToolTranscriptCursor(messages, events);

  assert.equal(cursor.next("reused").result.content, "first");
  assert.deepEqual(cursor.next("reused"), {
    result: messages[1],
    fileChanges: events[1].fileChanges,
  });
});
