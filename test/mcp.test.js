import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CapabilityRuntime } from "../src/capabilities/runtime.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { connectMcpTools } from "../src/mcp/tool-adapter.js";
import { ToolHost } from "../src/tools/host.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("MCP 样例公开 Tools、Resources 和 Prompts", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const capabilityRuntime = new CapabilityRuntime();
  const registry = createToolRegistry({
    workspace: root,
    bundledSkills: path.join(root, "skills"),
    capabilityRuntime,
  });
  const mcp = await connectMcpTools([{
    name: "echo",
    command: process.execPath,
    args: [path.join(root, "scripts", "mcp-echo-server.js")],
    cwd: root,
  }], { capabilityRuntime });
  try {
    const names = mcp.tools.map((tool) => tool.name);
    assert.ok(names.includes("mcp__echo__echo"));
    assert.ok(names.includes("mcp__echo__resources_list"));
    assert.ok(names.includes("mcp__echo__resource_read"));
    assert.ok(names.includes("mcp__echo__prompts_list"));
    assert.ok(names.includes("mcp__echo__prompt_get"));
    const result = await mcp.tools.find((tool) => tool.name === "mcp__echo__resource_read")
      .execute({ uri: "nexus://echo/about" }, {});
    assert.match(result, /Nexus Echo MCP resource/);
    assert.equal(registry.schemas().some((schema) => schema.function.name === "mcp__echo__echo"), true);
  } finally {
    await mcp.close();
  }

  const oldCall = { id: "closed-mcp-call", name: "mcp__echo__echo", arguments: { text: "should-not-run" } };
  const session = new AgentSession({ state: createSession({ provider: "test", workspace: root }), reducer: reduceSession });
  const result = await new ToolHost({ registry }).execute(oldCall, { session });
  assert.equal(result.status, "not_found");
  assert.equal(registry.schemas().some((schema) => schema.function.name === "mcp__echo__echo"), false);
  assert.equal(capabilityRuntime.inspect().active.some((entry) => entry.owner === "mcp:echo"), false);
});
