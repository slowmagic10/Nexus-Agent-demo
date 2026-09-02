import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertAgentProfileSnapshot,
  compareAgentProfileSnapshots,
  createAgentProfileSnapshot,
} from "../src/core/agent-profile.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";

test("Agent Profile snapshot 稳定摘要运行身份且不保存敏感正文", () => {
  const common = {
    provider: {
      name: "openai-compatible/deepseek-v4-flash",
      adapter: "openai-compatible",
      model: "deepseek-v4-flash",
      thinking: "disabled",
      apiKey: "must-not-persist",
      baseUrl: "https://private.example/v1",
    },
    workspace: "/tmp/profile-workspace",
    systemPrompt: () => "system prompt with private-token",
    permission: {
      defaultProfile: "workspace-auto",
      profiles: [{ name: "workspace-auto", policyVersion: "policy-v1" }],
    },
    execution: { id: "native-sandbox", isolation: "macos-seatbelt", command: "must-not-persist" },
    memoryScope: { workspace: "/tmp/profile-workspace", agentId: "coding", userId: "local" },
    budgets: { maxSteps: Infinity, maxTokensPerTurn: 20_000 },
  };
  const first = createAgentProfileSnapshot({
    ...common,
    toolSchemas: [toolSchema("write_file"), toolSchema("read_file")],
  });
  const reordered = createAgentProfileSnapshot({
    ...common,
    toolSchemas: [toolSchema("read_file"), toolSchema("write_file")],
  });
  const differentEndpoint = createAgentProfileSnapshot({
    ...common,
    provider: { ...common.provider, baseUrl: "https://another.example/v1" },
    toolSchemas: [toolSchema("read_file"), toolSchema("write_file")],
  });
  const differentThinking = createAgentProfileSnapshot({
    ...common,
    provider: { ...common.provider, thinking: "enabled" },
    toolSchemas: [toolSchema("read_file"), toolSchema("write_file")],
  });

  assert.equal(first.version, reordered.version);
  assert.notEqual(first.version, differentEndpoint.version);
  assert.notEqual(first.version, differentThinking.version);
  assert.deepEqual(compareAgentProfileSnapshots(first, reordered), []);
  assert.deepEqual(compareAgentProfileSnapshots(first, differentEndpoint).map((change) => change.field), ["provider.endpoint"]);
  assert.deepEqual(compareAgentProfileSnapshots(first, differentThinking).map((change) => change.field), ["provider.thinking"]);
  assert.deepEqual(first.toolset.names, ["read_file", "write_file"]);
  assert.equal(first.budgets.maxSteps, "unlimited");
  assert.equal(first.budgets.maxTokensPerTurn, 20_000);
  assert.match(first.systemPromptHash, /^[a-f0-9]{64}$/);
  assert.match(first.provider.endpointHash, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /must-not-persist|private-token|private\.example/);
  assert.deepEqual(assertAgentProfileSnapshot(first), first);
  assert.throws(() => assertAgentProfileSnapshot({ ...first, workspace: "/tmp/tampered" }), /version 与内容不匹配/);
});

test("Gateway 恢复到不同运行 Profile 时写入 durable 选择事件", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-agent-profile-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const tools = { schemas: () => [toolSchema("read_file")], get: () => null };
  const firstManager = new GatewaySessionManager({
    workspace,
    provider: provider("provider/model-a", "model-a"),
    providerDescriptor: { name: "provider/model-a", adapter: "test", model: "model-a" },
    tools,
    systemPrompt: () => "profile prompt",
    store,
    maxSteps: 8,
    maxTokensPerTurn: 5_000,
  });
  const created = await firstManager.create();
  const originalVersion = created.agentProfile.version;
  assert.equal(created.agentProfile.provider.model, "model-a");
  assert.equal(store.readSessionEvents(created.id)[0].baseline.agentProfile.version, originalVersion);
  await firstManager.close();

  const resumedManager = new GatewaySessionManager({
    workspace,
    provider: provider("provider/model-b", "model-b"),
    providerDescriptor: { name: "provider/model-b", adapter: "test", model: "model-b" },
    tools,
    systemPrompt: () => "profile prompt",
    store,
    maxSteps: 8,
    maxTokensPerTurn: 5_000,
  });
  t.after(() => resumedManager.close());
  const resumed = await resumedManager.create({ resume: created.id });

  assert.notEqual(resumed.agentProfile.version, originalVersion);
  assert.equal(resumed.agentProfile.provider.model, "model-b");
  const selected = resumed.events.find((event) => event.type === "agent.profile_selected");
  assert.equal(selected.previousProfileVersion, originalVersion);
  assert.equal(selected.profileVersion, resumed.agentProfile.version);
  assert.equal(selected.reason, "gateway_resume");
  assert.deepEqual(selected.changes.map((change) => change.field), ["provider.name", "provider.model"]);
  assert.deepEqual(selected.changeCategories, ["provider"]);
});

function toolSchema(name) {
  return {
    type: "function",
    function: {
      name,
      description: `${name} description must-not-persist`,
      parameters: { type: "object", properties: {} },
    },
  };
}

function provider(name, model) {
  return {
    name,
    model,
    complete: async () => ({ text: "完成", toolCalls: [] }),
  };
}
