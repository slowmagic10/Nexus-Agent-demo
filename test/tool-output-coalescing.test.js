import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { ToolHost } from "../src/tools/host.js";
import { createToolOutputStream } from "../src/tools/output-stream.js";

const call = { id: "coalesced-output", name: "run_shell", arguments: {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const output = (chunk, channel = "stdout") => ({ channel, chunk });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function gatedStream(options = {}) {
  const actions = [];
  const starts = [deferred(), deferred(), deferred()];
  const gates = [deferred(), deferred(), deferred()];
  let active = 0;
  let maximumActive = 0;
  const stream = createToolOutputStream({
    call,
    minUpdateChars: 1,
    ...options,
    dispatch: async (action) => {
      const index = actions.length;
      actions.push(structuredClone(action));
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      starts[index]?.resolve();
      try {
        await gates[index]?.promise;
        return { committed: index + 1, preview: action.preview };
      } finally {
        active -= 1;
      }
    },
  });
  return { stream, actions, gates, starts, maximumActive: () => maximumActive };
}

test("Tool Output Stream 万次突发追加只保留首条与最新快照，共享两个有界回执", async () => {
  const { stream, actions, gates, starts, maximumActive } = gatedStream({ maxPreviewChars: 150_000 });
  const first = stream.append(output("ready\n"));
  await starts[0].promise;
  const chunks = Array.from({ length: 10_000 }, (_, index) => `line ${index}\n`);
  const acknowledgements = chunks.map((chunk) => stream.append(output(chunk)));
  const tail = "final unterminated tail";
  acknowledgements.push(stream.append(output(tail, "stderr")));
  let closed = false;
  const closing = stream.close().then((state) => { closed = true; return state; });

  assert.equal(new Set([first, ...acknowledgements]).size, 2);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].preview, "ready\n");
  assert.equal(closed, false);
  gates[0].resolve();
  assert.deepEqual(await first, { committed: 1, preview: "ready\n" });
  await starts[1].promise;
  assert.equal(actions.length, 2);
  assert.equal(actions[1].preview, `ready\n${chunks.join("")}${tail}`);
  assert.equal(actions[1].channel, "stderr");
  assert.equal(actions[1].capturedChars, actions[1].preview.length);
  assert.equal(actions[1].truncated, false);
  assert.equal(closed, false);

  gates[1].resolve();
  const finalState = await closing;
  const acknowledged = await Promise.all(acknowledgements);
  assert.ok(acknowledged.every((state) => state === finalState));
  assert.equal(finalState.committed, 2);
  assert.equal(maximumActive(), 1);
  assert.equal(actions.length, 2);
});

test("Tool Output Stream 忙碌期间不断替换 pending，提交完成后继续保留最新变化", async () => {
  const { stream, actions, gates, starts, maximumActive } = gatedStream();
  const first = stream.append(output("one\n"));
  await starts[0].promise;
  const second = stream.append(output("two\n"));
  const coalesced = stream.append(output("three\n", "stderr"));
  assert.equal(second, coalesced);
  gates[0].resolve();
  await first;
  await starts[1].promise;
  assert.equal(actions[1].preview, "one\ntwo\nthree\n");
  assert.equal(actions[1].channel, "stderr");

  const third = stream.append(output("four\n"));
  assert.notEqual(third, second);
  const closing = stream.close();
  gates[1].resolve();
  await second;
  await starts[2].promise;
  assert.equal(actions[2].preview, "one\ntwo\nthree\nfour\n");
  gates[2].resolve();
  assert.equal((await closing).committed, 3);
  assert.equal((await third).committed, 3);
  assert.equal(maximumActive(), 1);
});

test("Tool Output Stream 空闲后仍按完整行字符差节流，close 刷新未到阈值的末尾", async () => {
  const actions = [];
  const stream = createToolOutputStream({ call, minUpdateChars: 10, dispatch: async (action) => {
    actions.push(action);
    return { committed: actions.length };
  } });
  const first = await stream.append(output("go\n"));
  assert.equal(first.committed, 1);
  assert.equal(await stream.append(output("ab\n")), first);
  assert.equal(await stream.append(output("cd\n")), first);
  assert.equal(actions.length, 1);
  assert.equal((await stream.append(output("efgh\n"))).committed, 2);
  assert.equal(actions[1].preview, "go\nab\ncd\nefgh\n");
  await stream.append(output("tail"));
  const finalState = await stream.close();
  assert.equal(finalState.committed, 3);
  assert.equal(actions[2].preview, "go\nab\ncd\nefgh\ntail");
});

test("Tool Output Stream pending 合并不会持久化分块 token、密码和不完整行", async () => {
  const { stream, actions, gates, starts } = gatedStream();
  const first = stream.append(output("safe first\n"));
  await starts[0].promise;
  stream.append(output("Authorization: Bear"));
  stream.append(output("er split-private-token\n"));
  stream.append(output('password="split-'));
  const pending = stream.append(output('private-password"\n', "stderr"));
  const closing = stream.close();
  gates[0].resolve();
  await first;
  await starts[1].promise;
  assert.equal(actions.length, 2);
  assert.equal(actions[0].preview, "safe first\n");
  assert.match(actions[1].preview, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(actions), /split-private-token|split-private-password/);
  assert.equal(actions[1].channel, "stderr");
  gates[1].resolve();
  await Promise.all([pending, closing]);
});

test("Tool Output Stream 截断丢弃不完整敏感末行，容量外通道变化不重复提交", async () => {
  const actions = [];
  const stream = createToolOutputStream({ call, minUpdateChars: 1, maxPreviewChars: 18, dispatch: async (action) => {
    actions.push(structuredClone(action));
    return { committed: actions.length };
  } });
  await stream.append(output("safe\n"));
  await stream.append(output("Authorization: Bearer should-not-appear\n"));
  const truncated = actions.at(-1);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.capturedChars, 18);
  assert.match(truncated.preview, /^safe\n.*预览上限/);
  assert.doesNotMatch(truncated.preview, /Authorization|Bearer|should-not-appear/);
  const count = actions.length;
  await stream.append(output("ignored tail", "stderr"));
  await stream.close();
  assert.equal(actions.length, count);
});

test("Tool Output Stream busy 时截断产生单个最新安全预览", async () => {
  const { stream, actions, gates, starts } = gatedStream({ maxPreviewChars: 24 });
  const first = stream.append(output("first\n"));
  await starts[0].promise;
  const pending = stream.append(output("second\npassword=private-data\n", "stderr"));
  for (let index = 0; index < 1000; index += 1) stream.append(output("discarded\n", "stderr"));
  const closing = stream.close();
  gates[0].resolve();
  await first;
  await starts[1].promise;
  assert.equal(actions.length, 2);
  assert.equal(actions[1].capturedChars, 24);
  assert.equal(actions[1].channel, "stderr");
  assert.match(actions[1].preview, /^first\nsecond\n.*预览上限/);
  assert.doesNotMatch(actions[1].preview, /password|private|discarded/);
  gates[1].resolve();
  await Promise.all([pending, closing]);
});

test("Tool Output Stream 相同内容的重复 close 等待 active，成功后不写重复事件", async () => {
  const { stream, actions, gates, starts } = gatedStream();
  const first = stream.append(output("only\n"));
  await starts[0].promise;
  let closes = 0;
  const closing = stream.close().then((state) => { closes += 1; return state; });
  const closingAgain = stream.close().then((state) => { closes += 1; return state; });
  await tick();
  assert.equal(closes, 0);
  assert.throws(() => stream.append(output("late\n")), /已关闭/);
  gates[0].resolve();
  const [firstState, finalState, repeatedState] = await Promise.all([first, closing, closingAgain]);
  assert.equal(finalState, firstState);
  assert.equal(repeatedState, firstState);
  assert.equal(actions.length, 1);
  assert.equal(closes, 2);
});

test("Tool Output Stream active 写入失败拒绝原回执，pending 继续串行提交并使 close 成功", async () => {
  const { stream, actions, gates, starts, maximumActive } = gatedStream();
  const first = stream.append(output("first\n"));
  const failed = assert.rejects(first, /first write failed/);
  await starts[0].promise;
  const pending = stream.append(output("second\n"));
  const closing = stream.close();
  gates[0].reject(new Error("first write failed"));
  await failed;
  await starts[1].promise;
  assert.equal(actions[1].preview, "first\nsecond\n");
  gates[1].resolve();
  assert.equal((await pending).committed, 2);
  assert.equal((await closing).committed, 2);
  assert.equal(maximumActive(), 1);
});

test("Tool Output Stream close 保留相同内容的最后重试，active 失败后仍能写入", async () => {
  const { stream, actions, gates, starts } = gatedStream();
  const first = stream.append(output("retry same preview\n"));
  const failed = assert.rejects(first, /first failed/);
  await starts[0].promise;
  const closing = stream.close();
  gates[0].reject(new Error("first failed"));
  await failed;
  await starts[1].promise;
  assert.equal(actions[1].preview, actions[0].preview);
  gates[1].resolve();
  assert.equal((await closing).committed, 2);
});

test("Tool Output Stream pending 最后写入失败时 close 与回执都拒绝，重复 close 不重新写入", async () => {
  const { stream, actions, gates, starts } = gatedStream();
  const first = stream.append(output("first\n"));
  await starts[0].promise;
  const pending = stream.append(output("last\n"));
  const pendingFailed = assert.rejects(pending, /last failed/);
  const closeFailed = assert.rejects(stream.close(), /last failed/);
  gates[0].resolve();
  await first;
  await starts[1].promise;
  gates[1].reject(new Error("last failed"));
  await Promise.all([pendingFailed, closeFailed]);
  await assert.rejects(stream.close(), /last failed/);
  assert.equal(actions.length, 2);
});

test("Tool Output Stream 同步 dispatch 异常不会卡住后续输出", async () => {
  const actions = [];
  const stream = createToolOutputStream({ call, minUpdateChars: 1, dispatch: (action) => {
    actions.push(action);
    if (actions.length === 1) throw new Error("synchronous write failed");
    return { committed: actions.length };
  } });
  await assert.rejects(stream.append(output("first\n")), /synchronous write failed/);
  assert.equal((await stream.append(output("second\n"))).committed, 2);
  assert.equal((await stream.close()).committed, 2);
  assert.equal(actions.length, 2);
  assert.equal(actions[1].preview, "first\nsecond\n");
});

test("Tool Output Stream 未 await 的失败 append 不触发 unhandledRejection，close 可恢复", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  let attempts = 0;
  try {
    const stream = createToolOutputStream({ call, minUpdateChars: 1, dispatch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ignored append failed");
      return { committed: attempts };
    } });
    stream.append(output("ignored by tool\n"));
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
    assert.equal((await stream.close()).committed, 2);
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("Tool Output Stream 保留 dispatch 返回的完整 Session 快照，回执修改不污染 Session", async () => {
  const session = new AgentSession({ state: createSession({ provider: "test", workspace: "/tmp" }), reducer: reduceSession });
  await session.dispatch({ type: "TOOL_EXECUTION_STARTED", call, argsHash: "test-hash", toolVersion: "test-version",
    effects: ["execute"], idempotency: "unknown", adapter: "native" });
  const gate = deferred();
  const started = deferred();
  let writes = 0;
  const stream = createToolOutputStream({ call, minUpdateChars: 1, dispatch: async (action) => {
    writes += 1;
    if (writes === 1) { started.resolve(); await gate.promise; }
    return session.dispatch(action);
  } });
  const first = stream.append(output("first\n"));
  await started.promise;
  const pending = stream.append(output("second\n"));
  const samePending = stream.append(output("third\n"));
  const closing = stream.close();
  gate.resolve();
  const [firstState, finalState, closeState] = await Promise.all([first, pending, closing]);
  assert.equal(pending, samePending);
  assert.equal(finalState, closeState);
  assert.equal(firstState.id, session.id);
  assert.equal(firstState.toolStreams[call.id].preview, "first\n");
  assert.equal(finalState.toolStreams[call.id].preview, "first\nsecond\nthird\n");
  assert.ok(Array.isArray(finalState.messages));
  firstState.toolStreams[call.id].preview = "modified first receipt";
  finalState.toolStreams[call.id].preview = "modified final receipt";
  finalState.events.length = 0;
  assert.equal(session.state.toolStreams[call.id].preview, "first\nsecond\nthird\n");
  assert.equal(session.state.events.filter((event) => event.type === "tool.output_updated").length, 2);
  session.close();
});

test("Tool Host 未 await 的突发 onOutput 在最终工具结果前排空，完整结果保持独立", async () => {
  const session = new AgentSession({ state: createSession({ provider: "test", workspace: "/tmp" }), reducer: reduceSession });
  const started = deferred();
  const gate = deferred();
  const originalDispatch = session.dispatch.bind(session);
  let outputWrites = 0;
  session.dispatch = async (action) => {
    if (action.type === "TOOL_OUTPUT_UPDATED" && ++outputWrites === 1) {
      started.resolve();
      await gate.promise;
    }
    return originalDispatch(action);
  };
  const actions = [];
  session.subscribeEvents((event) => actions.push(event.action));
  const fullResult = `FULL RESULT\n${"independent result content\n".repeat(300)}FULL_RESULT_END`;
  const tool = {
    name: "streaming_read",
    description: "合并输出测试",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    capability: { risk: "R0", readOnly: true, resources: [{ kind: "session", access: "read" }] },
    execute: async (_args, context) => {
      context.onOutput(output("first preview\n"));
      for (let index = 0; index < 1000; index += 1) context.onOutput(output(`part ${index}\n`));
      context.onOutput(output("last preview tail", "stderr"));
      return fullResult;
    },
  };
  const host = new ToolHost({
    registry: {
      get: (name) => name === tool.name ? tool : null,
      schemas: () => [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }],
    },
    policy: new WorkspacePolicy(),
  });
  let finished = false;
  const running = host.execute({ id: "host-coalesced", name: tool.name, arguments: {} }, { session })
    .then((result) => { finished = true; return result; });
  await started.promise;
  await tick();
  assert.equal(finished, false);
  assert.equal(actions.some((action) => action.type === "TOOL_RESULT"), false);
  gate.resolve();
  const result = await running;
  assert.equal(result.status, "completed");
  assert.equal(result.result, fullResult);
  const previews = actions.filter((action) => action.type === "TOOL_OUTPUT_UPDATED");
  assert.equal(previews.length, 2);
  assert.equal(previews[0].preview, "first preview\n");
  assert.match(previews[1].preview, /part 999\nlast preview tail$/);
  assert.equal(previews[1].channel, "stderr");
  assert.equal(actions.at(-1).type, "TOOL_RESULT");
  assert.equal(actions.at(-1).result, fullResult);
  assert.equal(session.state.messages.at(-1).content, fullResult);
  assert.equal(session.state.toolStreams["host-coalesced"], undefined);
  session.close();
});

test("Tool Output Stream 空流 close 不提交，关闭后拒绝追加", async () => {
  let writes = 0;
  const stream = createToolOutputStream({ call, dispatch: () => { writes += 1; } });
  assert.equal(await stream.close(), undefined);
  assert.equal(await stream.close(), undefined);
  assert.equal(writes, 0);
  assert.throws(() => stream.append(output("late")), /已关闭/);
});
