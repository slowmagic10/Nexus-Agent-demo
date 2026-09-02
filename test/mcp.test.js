import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CapabilityRuntime } from "../src/capabilities/runtime.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { connectMcpTools } from "../src/mcp/tool-adapter.js";
import { McpStdioClient } from "../src/mcp/stdio-client.js";
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

test("MCP 子进程只继承白名单环境和显式配置", async (t) => {
  const key = "NEXUS_MCP_PARENT_ONLY_SECRET";
  const localeLikeKey = "LC_NEXUS_MCP_PARENT_ONLY_SECRET";
  const previous = process.env[key];
  const previousLocaleLike = process.env[localeLikeKey];
  const previousLocale = process.env.LC_CTYPE;
  process.env[key] = "must-not-leak";
  process.env[localeLikeKey] = "must-not-leak-either";
  process.env.LC_CTYPE = "C.UTF-8";
  const client = createProbeClient({ MCP_EXPLICIT_VALUE: "visible" });
  t.after(async () => {
    await client.close();
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    if (previousLocaleLike === undefined) delete process.env[localeLikeKey];
    else process.env[localeLikeKey] = previousLocaleLike;
    if (previousLocale === undefined) delete process.env.LC_CTYPE;
    else process.env.LC_CTYPE = previousLocale;
  });

  const initialized = await client.initialize();

  assert.equal(initialized.probe.parentSecret, null);
  assert.equal(initialized.probe.localeLikeSecret, null);
  assert.equal(initialized.probe.locale, "C.UTF-8");
  assert.equal(initialized.probe.explicit, "visible");
  assert.equal(initialized.probe.hasPath, true);
});

test("MCP close 等待退出并强制终止忽略 SIGTERM 的子进程", async (t) => {
  const client = createProbeClient({ MCP_IGNORE_TERM: "1" }, { closeGraceMs: 30 });
  const pid = client.child.pid;
  t.after(() => {
    if (processAlive(pid)) process.kill(pid, "SIGKILL");
  });
  await client.initialize();

  await client.close();

  assert.equal(processAlive(pid), false);
});

function createProbeClient(env = {}, options = {}) {
  return new McpStdioClient({
    name: "probe",
    command: process.execPath,
    args: ["-e", MCP_PROBE_SCRIPT],
    env,
    timeout: 2_000,
    ...options,
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const MCP_PROBE_SCRIPT = String.raw`
  const readline = require("node:readline");
  if (process.env.MCP_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method !== "initialize") return;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "probe", version: "1" },
        probe: {
          parentSecret: process.env.NEXUS_MCP_PARENT_ONLY_SECRET || null,
          localeLikeSecret: process.env.LC_NEXUS_MCP_PARENT_ONLY_SECRET || null,
          locale: process.env.LC_CTYPE || null,
          explicit: process.env.MCP_EXPLICIT_VALUE || null,
          hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
        },
      },
    }) + "\n");
  });
  setInterval(() => {}, 1000);
`;
