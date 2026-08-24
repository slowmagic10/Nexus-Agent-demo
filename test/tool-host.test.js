import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { ToolHost } from "../src/tools/host.js";

test("Tool Host 在审批和执行前校验参数", async () => {
  let approvals = 0;
  let executions = 0;
  const { host, session } = fixture({
    name: "write_note",
    description: "写入内容",
    parameters: objectSchema({ content: { type: "string" } }, ["content"]),
    approval: "always",
    effects: ["write"],
    idempotency: "unknown",
    execute: async () => { executions += 1; return "不应执行"; },
  });

  const result = await host.execute({ id: "call-invalid", name: "write_note", arguments: {} }, {
    session,
    requestApproval: async () => { approvals += 1; return true; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "validation_failed");
  assert.equal(approvals, 0);
  assert.equal(executions, 0);
  assert.match(session.state.messages.at(-1).content, /缺少必填字段 content/);
  assert.ok(session.state.events.some((event) => event.type === "tool.validation_failed"));
});

test("Tool Host 将 Approval 绑定 args hash，并统一脱敏执行结果", async () => {
  let pending;
  const { host, session } = fixture({
    name: "external_write",
    description: "外部写入",
    parameters: objectSchema({ value: { type: "string" } }, ["value"]),
    approval: "always",
    effects: ["network", "write"],
    idempotency: "keyed",
    adapter: "mcp",
    execute: async ({ value }) => `已写入 ${value}；Authorization: Bearer secret-token`,
  });

  const result = await host.execute({ id: "call-approved", name: "external_write", arguments: { value: "ok" } }, {
    session,
    requestApproval: async () => {
      pending = session.state.pendingApproval;
      return true;
    },
  });

  assert.equal(result.ok, true);
  assert.match(pending.argsHash, /^[a-f0-9]{64}$/);
  assert.match(pending.toolVersion, /^[a-f0-9]{64}$/);
  assert.equal(session.state.pendingApproval, null);
  assert.match(session.state.messages.at(-1).content, /Bearer \[REDACTED\]/);
  const authorization = session.state.events.find((event) => event.type === "tool.authorization_decided");
  assert.equal(authorization.adapter, "mcp");
  assert.equal(authorization.risk, "R2");
  assert.equal(authorization.argsHash, pending.argsHash);
  assert.ok(session.state.events.some((event) => event.type === "tool.execution_started"));
});

test("有副作用工具超时后记录 execution_unknown 且不悬挂", async () => {
  const { host, session } = fixture({
    name: "slow_write",
    description: "缓慢写入",
    parameters: objectSchema({}),
    approval: "never",
    effects: ["write"],
    idempotency: "unknown",
    timeoutMs: 5,
    execute: async () => new Promise(() => {}),
  });

  const result = await host.execute({ id: "call-timeout", name: "slow_write", arguments: {} }, {
    session,
    requestApproval: async () => false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "execution_unknown");
  assert.match(result.result, /超时.*未知/);
  assert.ok(session.state.events.some((event) => (
    event.type === "tool.execution_unknown" && event.callId === "call-timeout"
  )));
  assert.equal(session.state.messages.at(-1).tool_call_id, "call-timeout");
});

test("Tool Host 收到预取消信号时不会启动有副作用工具", async () => {
  let executions = 0;
  const { host, session } = fixture({
    name: "cancelled_write",
    description: "不应启动的写入",
    parameters: objectSchema({}),
    approval: "never",
    effects: ["write"],
    idempotency: "unknown",
    execute: async () => { executions += 1; return "不应执行"; },
  });
  const controller = new AbortController();
  controller.abort(new Error("pre-cancelled"));

  await assert.rejects(
    host.execute({ id: "call-pre-cancelled", name: "cancelled_write", arguments: {} }, {
      session,
      signal: controller.signal,
    }),
    /pre-cancelled/,
  );

  assert.equal(executions, 0);
  assert.equal(session.state.events.some((event) => event.type === "tool.execution_started"), false);
  assert.equal(session.state.events.some((event) => event.type === "tool.execution_unknown"), false);
  assert.equal(session.state.messages.at(-1).tool_call_id, "call-pre-cancelled");
  assert.match(session.state.messages.at(-1).content, /取消.*尚未启动/);
});

test("Approval 后参数变化会失效且不会执行", async () => {
  let executions = 0;
  const call = { id: "call-stale", name: "write_value", arguments: { value: "before" } };
  const { host, session } = fixture({
    name: "write_value",
    description: "写入值",
    parameters: objectSchema({ value: { type: "string" } }, ["value"]),
    approval: "always",
    effects: ["write"],
    idempotency: "unknown",
    execute: async () => { executions += 1; return "不应执行"; },
  });

  const result = await host.execute(call, {
    session,
    requestApproval: async () => {
      call.arguments.value = "after";
      return true;
    },
  });

  assert.equal(result.status, "approval_stale");
  assert.equal(executions, 0);
  assert.ok(session.state.events.some((event) => event.type === "approval.stale"));
});

function fixture(tool) {
  const registry = {
    get: (name) => name === tool.name ? tool : null,
    schemas: () => [{
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }],
  };
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace: "/tmp" }),
    reducer: reduceSession,
  });
  return { host: new ToolHost({ registry }), session };
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
