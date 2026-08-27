import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CapabilityRuntime } from "../src/capabilities/runtime.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { ToolHost } from "../src/tools/host.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("Capability Runtime 按 owner 撤销，并在异步 dispose 前立即隐藏能力", async () => {
  const runtime = new CapabilityRuntime();
  let releaseDispose;
  let markDisposeStarted;
  let disposed = 0;
  const disposal = new Promise((resolve) => { releaseDispose = resolve; });
  const disposeStarted = new Promise((resolve) => { markDisposeStarted = resolve; });
  const observed = [];
  runtime.subscribe((event) => observed.push(event));
  const serverHandle = runtime.register({
    kind: "mcp_server",
    name: "remote",
    owner: "mcp:remote",
    value: { name: "remote" },
    dispose: async () => { disposed += 1; markDisposeStarted(); await disposal; },
  });
  const toolHandle = runtime.register({
    kind: "tool",
    name: "remote_read",
    owner: "mcp:remote",
    value: { name: "remote_read" },
  });

  assert.equal(runtime.get("tool", "remote_read").name, "remote_read");
  assert.equal(runtime.resolve("tool", "remote_read").registrationId, toolHandle.registrationId);
  assert.equal("value" in runtime.inspect().active.find((entry) => entry.name === "remote_read"), false);
  const lease = runtime.acquire("tool", "remote_read", toolHandle.registrationId);
  assert.ok(lease);
  assert.throws(() => runtime.register({
    kind: "tool",
    name: "remote_read",
    owner: "other",
    value: {},
  }), /能力名称冲突/);

  const revoking = runtime.revokeOwner("mcp:remote", "连接关闭");
  assert.equal(runtime.get("tool", "remote_read"), null);
  assert.deepEqual(runtime.list("tool"), []);
  assert.equal(disposed, 0);
  lease.release();
  await disposeStarted;
  assert.equal(disposed, 1);
  releaseDispose();
  const result = await revoking;

  assert.deepEqual(result.revoked, [serverHandle.registrationId, toolHandle.registrationId]);
  assert.equal(runtime.inspect().active.length, 0);
  assert.deepEqual(observed.map((event) => event.type), [
    "capability.registered",
    "capability.registered",
    "capability.revoked",
    "capability.revoked",
  ]);
  assert.equal(await toolHandle.revoke("重复撤销"), false);
});

test("Tool Host 在执行前拒绝已经撤销的旧 capability registration", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-capability-runtime-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const runtime = new CapabilityRuntime();
  let executions = 0;
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    capabilityRuntime: runtime,
    extraTools: [{
      capabilityOwner: "adapter:test",
      name: "dynamic_read",
      description: "动态只读工具",
      adapter: "test",
      effects: ["read"],
      idempotency: "safe",
      capability: {
        risk: "R0",
        readOnly: true,
        resources: [{ kind: "external", access: "read", value: "test" }],
      },
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: async () => { executions += 1; return "不应执行"; },
    }],
  });
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace }),
    reducer: reduceSession,
  });
  const dispatch = session.dispatch.bind(session);
  session.dispatch = async (action) => {
    const state = await dispatch(action);
    if (action.type === "TOOL_AUTHORIZATION_DECIDED") {
      await runtime.revokeOwner("adapter:test", "测试热撤销");
    }
    return state;
  };
  const host = new ToolHost({ registry });

  assert.equal(host.schemas().some((schema) => schema.function.name === "dynamic_read"), true);
  const result = await host.execute({ id: "dynamic-call", name: "dynamic_read", arguments: {} }, { session });

  assert.equal(result.status, "capability_unavailable");
  assert.equal(executions, 0);
  assert.equal(host.schemas().some((schema) => schema.function.name === "dynamic_read"), false);
  assert.equal(session.state.events.some((event) => event.type === "tool.execution_started"), false);
  assert.ok(session.state.events.some((event) => event.type === "tool.capability_unavailable"));
});
