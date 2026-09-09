import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertAgentProfileSnapshot,
  compareAgentProfileSnapshots,
  createAgentProfileSnapshot,
  deriveAgentProfileSnapshot,
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

test("默认请求契约保留 schema 1 和先前 snapshot hash", () => {
  const baseProvider = { name: "openai-compatible/default", adapter: "openai-compatible", model: "default" };
  const profile = createAgentProfileSnapshot({ provider: baseProvider, workspace: "/tmp/profile-policy-fixture" });
  const explicitDefaults = createAgentProfileSnapshot({ provider: { ...baseProvider,
    contextTargetTokens: null, maxOutputTokens: null, outputTokenParameter: null, streamUsage: false,
  }, workspace: "/tmp/profile-policy-fixture" });
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.version, "17bd85027028ca849e861ac3a1529c795e7fd85db4a20904d4da4a3162019696");
  assert.deepEqual(explicitDefaults, profile);
  assert.deepEqual(assertAgentProfileSnapshot(profile), profile);
  assert.deepEqual(deriveAgentProfileSnapshot(profile), profile);
});

test("非默认请求契约使用 schema 2，逐字段记录 drift 并在派生时保留", () => {
  const options = { provider: { name: "openai-compatible/base", adapter: "openai-compatible", model: "base" },
    workspace: "/tmp/profile-contract" };
  const previous = createAgentProfileSnapshot(options);
  const current = createAgentProfileSnapshot({ ...options, provider: { ...options.provider,
    contextTargetTokens: 12_000, maxOutputTokens: 2_000, outputTokenParameter: "max_tokens", streamUsage: true,
  } });
  assert.equal(current.schemaVersion, 2);
  assert.equal(current.provider.contextWindowTokens, 32_000);
  assert.deepEqual(assertAgentProfileSnapshot(current), current);
  assert.deepEqual(compareAgentProfileSnapshots(previous, current).map((change) => change.field), [
    "provider.contextTargetTokens", "provider.maxOutputTokens", "provider.outputTokenParameter", "provider.streamUsage",
  ]);
  const child = deriveAgentProfileSnapshot(current, { workspace: "/tmp/profile-contract-child", budgets: { maxSteps: 2 } });
  assert.equal(child.schemaVersion, 2);
  assert.deepEqual(child.provider, current.provider);
  assert.deepEqual(assertAgentProfileSnapshot(child), child);
  const upgraded = deriveAgentProfileSnapshot(previous, { provider: current.provider });
  assert.equal(upgraded.schemaVersion, 2);
  assert.deepEqual(upgraded.provider, current.provider);
  const cleared = deriveAgentProfileSnapshot(current, { provider: previous.provider });
  assert.equal(cleared.schemaVersion, 1);
  assert.deepEqual(cleared.provider, previous.provider);
});

test("Profile 不接受降级伪装或带合法 hash 的非法 schema 2 契约", () => {
  const profile = createAgentProfileSnapshot({
    provider: { name: "openai-compatible/base", adapter: "openai-compatible", model: "base",
      contextTargetTokens: 10_000 }, workspace: "/tmp/profile-invalid-contract",
  });
  const legacy = rehashProfile({ ...profile, schemaVersion: 1 });
  assert.throws(() => assertAgentProfileSnapshot(legacy), /需要 schema version 2/);
  for (const changes of [
    { contextTargetTokens: 0 }, { contextTargetTokens: "10000" }, { contextTargetTokens: 32_001 },
    { maxOutputTokens: 1_000 }, { streamUsage: "true" }, { streamUsage: false },
    { contextTargetTokens: null }, { extraUnrecognizedOption: true },
  ]) {
    const invalid = rehashProfile({ ...profile, provider: { ...profile.provider, ...changes } });
    assert.throws(() => assertAgentProfileSnapshot(invalid));
  }
  const emptyV2 = rehashProfile({ ...profile, provider: Object.fromEntries(
    Object.entries(profile.provider).filter(([key]) => key !== "contextTargetTokens")),
  });
  assert.throws(() => assertAgentProfileSnapshot(emptyV2), /规范化/);
});

function rehashProfile(value) {
  const { version: _version, ...core } = value;
  return { ...core, version: createHash("sha256").update(stable(core)).digest("hex") };
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
