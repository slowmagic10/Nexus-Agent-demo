import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { connectMcpTools } from "../src/mcp/tool-adapter.js";

test("MCP 样例公开 Tools、Resources 和 Prompts", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const mcp = await connectMcpTools([{
    name: "echo",
    command: process.execPath,
    args: [path.join(root, "scripts", "mcp-echo-server.js")],
    cwd: root,
  }]);
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
  } finally {
    await mcp.close();
  }
});
