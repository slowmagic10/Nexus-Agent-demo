import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { composeRuntimeConfig } from "../src/config/composer.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { createRuntimeAssembly } from "../src/runtime/assembly.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Runtime Assembly 延迟激活执行环境和 MCP，基础 Store 可独立关闭", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-runtime-assembly-lazy-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const config = await composeRuntimeConfig({
    root,
    env: {},
    args: [
      "--demo",
      `--workspace=${workspace}`,
      "--execution=local",
      `--mcp=${path.join(workspace, "missing-mcp.json")}`,
    ],
  });
  const assembly = await createRuntimeAssembly({
    config,
    bundledSkills: path.join(root, "skills"),
    environment: { NEXUS_USER_DATA_DIR: path.join(workspace, "user-data") },
  });

  assert.equal(assembly.workspace, workspace);
  assert.equal(assembly.defaultProviderBinding.provider.name, "offline-demo");
  assert.ok(assembly.store.list(workspace));
  await assembly.close();
  await assembly.close();
  await assert.rejects(assembly.activate(), /已关闭/);
});

test("Runtime Assembly 统一创建 Tool graph、AgentRuntime 和资源生命周期", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-runtime-assembly-active-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const config = await composeRuntimeConfig({
    root,
    env: {},
    args: ["--demo", `--workspace=${workspace}`, "--execution=local"],
  });
  const assembly = await createRuntimeAssembly({
    config,
    bundledSkills: path.join(root, "skills"),
    environment: { NEXUS_USER_DATA_DIR: path.join(workspace, "user-data") },
  });
  t.after(() => assembly.close());
  const activated = await assembly.activate({
    defaultPermissionProfile: "workspace-auto",
    permissionProfileNames: ["workspace-auto", "read-only"],
  });

  assert.equal(activated.workspaceExecution.id, "local-workspace");
  assert.deepEqual(Object.keys(activated.permissionToolHosts), ["workspace-auto", "read-only"]);
  assert.equal(activated.toolHost.policy.profile.name, "workspace-auto");
  assert.ok(activated.tools.schemas().some((schema) => schema.function.name === "read_file"));
  await assert.rejects(assembly.activate(), /已激活/);

  const provider = assembly.defaultProviderBinding.provider;
  const state = createSession({
    provider: provider.name,
    workspace,
    memoryScope: assembly.baseMemoryScope,
    permissionProfile: "workspace-auto",
  });
  const session = new AgentSession({ state, reducer: reduceSession, journal: assembly.store });
  const runtime = assembly.createAgentRuntime({
    session,
    provider,
    toolHost: activated.toolHost,
    systemPrompt: activated.systemPrompt,
    maxSteps: 2,
    maxTokensPerTurn: 2_000,
  });

  await runtime.runTurn("只回复一句完成");
  assert.equal(runtime.state.phase, "completed");
  assert.ok(runtime.state.events.some((event) => event.type === "model.completed"));
  await assembly.close();
  assert.deepEqual(activated.capabilityRuntime.list(), []);
});
