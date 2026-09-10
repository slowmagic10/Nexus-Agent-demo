import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { ToolHost } from "../src/tools/host.js";

function fixture(execute) {
  const session = new AgentSession({
    state: createSession({ id: "preview-failure", provider: "offline", workspace: "/tmp" }), reducer: reduceSession,
  });
  const original = session.dispatch.bind(session);
  let failures = 0;
  session.dispatch = (action) => {
    if (action.type === "TOOL_OUTPUT_UPDATED") {
      failures++;
      return Promise.reject(new Error("secondary preview write failure"));
    }
    return original(action);
  };
  const tool = { name: "failure_boundary", description: "合成边界测试", approval: "never", adapter: "test",
    effects: ["read"], idempotency: "safe", parameters: { type: "object", properties: {}, additionalProperties: false },
    capability: { risk: "R0", readOnly: true, resources: [{ kind: "session", access: "read" }] }, execute };
  const host = new ToolHost({ registry: { schemas: () => [], get: (name) => name === tool.name ? tool : null } });
  return { session, host, call: { id: "call-failure", name: tool.name, arguments: {} }, failures: () => failures };
}

test("执行先失败、预览关闭再失败时仍记录原失败及完整结果输出", async () => {
  const f = fixture(async (args, context) => {
    context.onOutput({ channel: "stdout", chunk: "preview\n" });
    const error = new Error("primary execution failure");
    error.result = { output: "FULL-EXECUTION-OUTPUT\n" };
    throw error;
  });
  const result = await f.host.execute(f.call, { session: f.session });
  assert.equal(result.status, "external_failed");
  assert.match(result.result, /primary execution failure/);
  assert.match(result.result, /FULL-EXECUTION-OUTPUT/);
  assert.doesNotMatch(result.result, /secondary preview/);
  const completed = f.session.state.events.findLast((event) => event.type === "tool.completed");
  assert.equal(completed.status, "external_failed");
  assert.ok(f.failures() >= 1);
  assert.deepEqual(f.session.state.toolStreams, {});
});

test("取消先发生时预览关闭失败不覆盖取消原因，也不跳过工具终态", async () => {
  const controller = new AbortController();
  const cancelled = new Error("primary cancellation");
  const f = fixture(async (args, context) => {
    context.onOutput({ channel: "stdout", chunk: "preview\n" });
    controller.abort(cancelled);
    throw cancelled;
  });
  await assert.rejects(f.host.execute(f.call, { session: f.session, signal: controller.signal }),
    (error) => error === cancelled);
  const completed = f.session.state.events.findLast((event) => event.type === "tool.completed");
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.terminationReason, "cancelled");
  assert.equal(f.session.state.messages.at(-1).role, "tool");
  assert.ok(f.failures() >= 1);
  assert.deepEqual(f.session.state.toolStreams, {});
});

test("工具成功但最终预览写入失败仍按原规则标记错误，不伪造成功", async () => {
  const f = fixture(async (args, context) => {
    context.onOutput({ channel: "stdout", chunk: "preview\n" });
    return "successful operation output";
  });
  const result = await f.host.execute(f.call, { session: f.session });
  assert.equal(result.status, "external_failed");
  assert.match(result.result, /secondary preview write failure/);
  assert.match(result.result, /successful operation output/);
  assert.equal(f.session.state.events.findLast((event) => event.type === "tool.completed").ok, false);
});

test("结果记录失败后保留已经规范化的输出，不重复调用工具结果序列化钩子", async () => {
  let serializations = 0;
  const f = fixture(async () => ({ toJSON() { serializations++; return { output: "returned once" }; } }));
  const original = f.session.dispatch;
  let writes = 0;
  f.session.dispatch = function (action) {
    if (action.type === "TOOL_RESULT" && ++writes === 1) return Promise.reject(new Error("terminal write unavailable"));
    return original.call(this, action);
  };
  const result = await f.host.execute(f.call, { session: f.session });
  assert.equal(result.status, "external_failed");
  assert.match(result.result, /terminal write unavailable/);
  assert.match(result.result, /returned once/);
  assert.equal(serializations, 1);
  assert.equal(writes, 2);
});
