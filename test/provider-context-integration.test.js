import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { composeRuntimeConfig, createConfiguredAgentProviders } from "../src/config/composer.js";
import { normalizeNamedAgentProfiles } from "../src/core/named-agent-profiles.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { createRuntimeAssembly } from "../src/runtime/assembly.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultProvider = {
  type: "openai-compatible", apiKey: "offline-fixture-key", baseUrl: "http://fixture.invalid/v1",
  model: "default-model", contextWindowTokens: 32_000, contextTargetTokens: 24_000,
  maxOutputTokens: 2_000, outputTokenParameter: "max_tokens", streamUsage: true,
};
const noTools = { schemas: () => [], get: () => null };

function captureRequests(binding, requests) {
  binding.provider.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    assert.equal(options.signal.aborted, false);
    const memory = body.messages[0].content.includes("长期记忆候选");
    return new Response(JSON.stringify({
      choices: [{ message: { content: memory ? "[]" : "完成。" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { headers: { "content-type": "application/json" } });
  };
}

async function runMessage(manager, id) {
  await manager.sendMessage(id, "仅回复完成。");
  await manager.sessions.get(id).run;
  assert.equal((await manager.get(id)).phase, "completed");
}

function lastContext(state) {
  return state.events.findLast((event) => event.type === "model.context_prepared");
}

test("具名 Gateway、分支和委派保留模型窗口，并将自身输出上限发送到同一 Provider", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-provider-gateway-context-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const agentProfiles = normalizeNamedAgentProfiles({
    compact: { provider: { model: "compact-model", contextWindowTokens: 16_000,
      contextTargetTokens: 15_000, maxOutputTokens: 4_000, outputTokenParameter: "max_completion_tokens" } },
  }, { defaultProvider });
  const agentProviders = createConfiguredAgentProviders({ agents: agentProfiles });
  const requests = [];
  for (const binding of agentProviders.values()) captureRequests(binding, requests);
  const defaults = agentProviders.get("default");
  const manager = new GatewaySessionManager({ workspace, store, tools: noTools,
    provider: defaults.provider, providerDescriptor: defaults.descriptor, agentProfiles, agentProviders,
    defaultPermissionProfile: "workspace-auto", systemPrompt: "按要求回复。", maxSteps: 2,
  });
  t.after(async () => { await manager.close(); store.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const parent = await manager.create({ agentProfileId: "compact" });
  await runMessage(manager, parent.id);
  const branch = await manager.branch(parent.id);
  await runMessage(manager, branch.id);
  await manager.delegate(parent.id, { objective: "仅回复完成。", context: [], maxSteps: 2, maxTokens: 1000 });
  const delegatedId = (await manager.get(parent.id)).delegations.at(-1).childSessionId;
  for (const id of [parent.id, branch.id, delegatedId]) {
    const state = await manager.get(id);
    assert.equal(state.agentProfile.provider.contextWindowTokens, 16_000);
    assert.equal(state.agentProfile.provider.maxOutputTokens, 4_000);
    assert.equal(lastContext(state).maxInputTokens, 12_000);
    assert.deepEqual(lastContext(state).contextBudget, {
      version: "context-budget-v1", contextWindowTokens: 16_000,
      contextTargetTokens: 15_000, reservedOutputTokens: 4_000, maxInputTokens: 12_000,
    });
  }
  assert.ok(requests.some((body) => body.messages[0].content.includes("长期记忆候选")));
  assert.ok(requests.some((body) => body.stream));
  for (const body of requests) {
    assert.equal(body.model, "compact-model");
    assert.equal(body.max_completion_tokens, 4_000);
    assert.equal(Object.hasOwn(body, "max_tokens"), false);
    assert.deepEqual(body.stream_options, body.stream ? { include_usage: true } : undefined);
  }
  const info = manager.runtimeInfo().agentProfiles.profiles.find((item) => item.id === "compact");
  assert.equal(info.maxInputTokens, 12_000);
  assert.equal(info.provider.contextWindowTokens, 16_000);
});

test("固定 Gateway Snapshot 从持久化请求策略还原有效输入预算", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-provider-fixed-context-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const agentProfiles = normalizeNamedAgentProfiles(undefined, { defaultProvider });
  const binding = createConfiguredAgentProviders({ agents: agentProfiles }).get("default");
  const requests = [];
  captureRequests(binding, requests);
  const seed = new GatewaySessionManager({ workspace, store, tools: noTools,
    provider: binding.provider, providerDescriptor: binding.descriptor,
    defaultPermissionProfile: "workspace-auto", systemPrompt: "按要求回复。",
  });
  const state = await seed.create();
  const fixed = state.agentProfile;
  await seed.close();
  const manager = new GatewaySessionManager({ workspace, store, tools: noTools,
    provider: binding.provider, agentProfile: fixed, systemPrompt: "按要求回复。",
    defaultPermissionProfile: "workspace-auto", maxInputTokens: 999_999,
  });
  t.after(async () => { await manager.close(); store.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  await runMessage(manager, state.id);
  const restored = store.load(state.id);
  assert.equal(restored.agentProfile.provider.contextWindowTokens, 32_000);
  assert.equal(lastContext(restored).maxInputTokens, 24_000);
  assert.equal(lastContext(restored).contextBudget.reservedOutputTokens, 2_000);
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((body) => body.max_tokens === 2_000));
});

test("Runtime Assembly 默认装配使用独立输入目标，主请求和记忆提取共享输出上限", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-provider-assembly-context-"));
  const config = await composeRuntimeConfig({ root: workspace,
    env: { OPENAI_API_KEY: "offline-fixture-key", OPENAI_MODEL: "assembly-model" },
    args: [`--workspace=${workspace}`, "--execution=local", "--context-window-tokens=32000",
      "--context-target-tokens=24000", "--max-output-tokens=10000", "--output-token-parameter=max_tokens"],
  });
  const assembly = await createRuntimeAssembly({ config, bundledSkills: path.join(root, "skills"),
    environment: { NEXUS_USER_DATA_DIR: path.join(workspace, "user-data") },
  });
  t.after(async () => { await assembly.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const activated = await assembly.activate();
  const requests = [];
  captureRequests(assembly.defaultProviderBinding, requests);
  const provider = assembly.defaultProviderBinding.provider;
  const session = new AgentSession({
    state: createSession({ provider: provider.name, workspace, permissionProfile: "workspace-auto" }),
    reducer: reduceSession, journal: assembly.store,
  });
  const runtime = assembly.createAgentRuntime({ session, provider, toolHost: activated.toolHost,
    systemPrompt: "按要求回复。", maxSteps: 2,
  });
  await runtime.runTurn("仅回复完成。");
  assert.equal(runtime.state.phase, "completed");
  assert.equal(lastContext(runtime.state).maxInputTokens, 22_000);
  assert.equal(lastContext(runtime.state).contextBudget.contextWindowTokens, 32_000);
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((body) => body.max_tokens === 10_000));
});

test("Runtime Assembly 以已绑定的具名 Provider 推导默认窗口，而不套用全局默认预算", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-provider-named-assembly-context-"));
  const composed = await composeRuntimeConfig({ root: workspace,
    env: { OPENAI_API_KEY: "offline-fixture-key" },
    args: [`--workspace=${workspace}`, "--execution=local", "--context-window-tokens=32000",
      "--context-target-tokens=24000", "--max-output-tokens=2000", "--output-token-parameter=max_tokens"],
  });
  const agents = normalizeNamedAgentProfiles({
    compact: { provider: { contextWindowTokens: 16_000, contextTargetTokens: 15_000, maxOutputTokens: 4_000 } },
  }, { defaultProvider: composed.provider, defaultId: "compact" });
  const assembly = await createRuntimeAssembly({ config: { ...composed, agents },
    bundledSkills: path.join(root, "skills"),
    environment: { NEXUS_USER_DATA_DIR: path.join(workspace, "user-data") },
  });
  t.after(async () => { await assembly.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  await assembly.activate();
  const requests = [];
  captureRequests(assembly.defaultProviderBinding, requests);
  const provider = assembly.defaultProviderBinding.provider;
  const session = new AgentSession({ state: createSession({ provider: provider.name, workspace }),
    reducer: reduceSession, journal: assembly.store,
  });
  const runtime = assembly.createAgentRuntime({ session, provider, systemPrompt: "按要求回复。", maxSteps: 2 });
  await runtime.runTurn("仅回复完成。");
  assert.equal(runtime.state.phase, "completed");
  assert.equal(lastContext(runtime.state).maxInputTokens, 12_000);
  assert.equal(lastContext(runtime.state).contextBudget.contextWindowTokens, 16_000);
  assert.equal(lastContext(runtime.state).contextBudget.reservedOutputTokens, 4_000);
  assert.ok(requests.every((body) => body.max_tokens === 4_000));
});
