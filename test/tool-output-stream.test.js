import assert from "node:assert/strict";
import test from "node:test";
import { createSession, reduceSession } from "../src/core/state.js";
import { createToolOutputStream } from "../src/tools/output-stream.js";

test("Tool Output Stream 只发布完整行并在 durable snapshot 前统一脱敏", async () => {
  const actions = [];
  const stream = createToolOutputStream({
    call: { id: "call-stream", name: "run_shell" },
    dispatch: async (action) => actions.push(action),
    minUpdateChars: 1,
  });

  await stream.append({ channel: "stdout", chunk: "Authorization: Bear" });
  assert.equal(actions.length, 0);
  await stream.append({ channel: "stdout", chunk: "er secret-token\nstep 1\n" });
  assert.equal(actions.length, 1);
  assert.match(actions[0].preview, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(actions[0].preview, /secret-token/);
  assert.match(actions[0].preview, /step 1/);

  await stream.append({ channel: "stderr", chunk: "partial" });
  assert.equal(actions.length, 1);
  await stream.close();
  assert.equal(actions.length, 2);
  assert.match(actions[1].preview, /partial/);
});

test("Tool Output Stream 的第一条短完整行立即发布，后续更新再节流", async () => {
  const actions = [];
  const stream = createToolOutputStream({
    call: { id: "call-first-line", name: "run_shell" },
    dispatch: async (action) => actions.push(action),
    minUpdateChars: 256,
  });

  await stream.append({ channel: "stdout", chunk: "ready\n" });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].preview, "ready\n");

  await stream.append({ channel: "stdout", chunk: "small update\n" });
  assert.equal(actions.length, 1);
  await stream.close();
  assert.equal(actions.length, 2);
  assert.match(actions[1].preview, /small update/);
});

test("Tool Output Stream 截断时不发布不完整首行", async () => {
  const actions = [];
  const stream = createToolOutputStream({
    call: { id: "call-truncated", name: "run_shell" },
    dispatch: async (action) => actions.push(action),
    maxPreviewChars: 12,
    minUpdateChars: 1,
  });

  await stream.append({ channel: "stdout", chunk: "secret-without-newline" });
  await stream.close();

  assert.equal(actions.length, 1);
  assert.equal(actions[0].truncated, true);
  assert.doesNotMatch(actions[0].preview, /secret/);
  assert.match(actions[0].preview, /预览上限/);
});

test("Tool Output Stream 进入 Session 投影并在最终 Tool Result 后清除", () => {
  const call = { id: "call-state", name: "run_shell", arguments: { command: "echo ok" } };
  let state = createSession({ provider: "demo", workspace: "/tmp" });
  state = reduceSession(state, {
    type: "TOOL_EXECUTION_STARTED",
    call,
    argsHash: "hash",
    toolVersion: "version",
    effects: ["execute"],
    idempotency: "unknown",
    adapter: "native",
  });
  state = reduceSession(state, {
    type: "TOOL_OUTPUT_UPDATED",
    callId: call.id,
    tool: call.name,
    preview: "running\n",
    capturedChars: 8,
    truncated: false,
    channel: "stdout",
  });

  assert.equal(state.toolStreams[call.id].preview, "running\n");
  assert.equal(state.events.at(-1).type, "tool.output_updated");
  state = reduceSession(state, {
    type: "TOOL_RESULT",
    call,
    ok: true,
    status: "completed",
    result: "running",
    durationMs: 1,
  });
  assert.equal(state.toolStreams[call.id], undefined);
});
