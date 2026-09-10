import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { composeRuntimeConfig } from "../src/config/composer.js";
import { AgentRuntime } from "../src/core/agent.js";
import { normalizeNamedAgentProfiles } from "../src/core/named-agent-profiles.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { runWorkspaceTaskSuite } from "../src/evaluation/workspace-task-suite.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { resolveContextBudget } from "../src/providers/request-policy.js";
import { createRuntimeAssembly } from "../src/runtime/assembly.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tools = { schemas: () => [], get: () => null };
const provider = () => ({ name: "summary-capacity-fixture", complete: async () => ({
  text: "完成", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
}) });

test("AgentRuntime 独立摘要预算不被旧主输入软目标收窄，并透传显式额度", () => {
  const create = (options = {}) => new AgentRuntime({
    session: session("/tmp"), provider: provider(), tools, systemPrompt: "完成任务", maxInputTokens: 400,
    ...options,
  });
  assert.equal(create().contextLifecycle.summaryMaxInputTokens, 32_000);
  assert.equal(create({ summaryMaxInputTokens: 8_000 }).contextLifecycle.summaryMaxInputTokens, 8_000);
  const contextBudget = resolveContextBudget({ contextWindowTokens: 16_000, contextTargetTokens: 400, maxOutputTokens: 4_000 });
  assert.equal(create({ contextBudget }).contextLifecycle.summaryMaxInputTokens, 12_000);
  assert.equal(create({ contextBudget, summaryMaxInputTokens: 20_000 }).contextLifecycle.summaryMaxInputTokens, 12_000);
  assert.equal(create({ contextBudget, summaryMaxInputTokens: 6_000 }).contextLifecycle.summaryMaxInputTokens, 6_000);
});

test("Assembly 只有容量的默认 binding 保留摘要容量，runtime 主目标和 override 独立", async (t) => {
  const { workspace, assembly } = await assemblyFixture(t);
  const bound = assembly.defaultProviderBinding.provider;
  const create = (overrides = {}) => assembly.createAgentRuntime({
    session: session(workspace), provider: bound, systemPrompt: "完成任务", maxInputTokens: 400,
    ...overrides,
  });
  assert.equal(create().contextLifecycle.summaryMaxInputTokens, 8_000);
  assert.equal(create().contextLifecycle.maxInputTokens, 400);
  assert.equal(create().contextLifecycle.contextBudget, null);
  assert.equal(create({ summaryMaxInputTokens: 2_000 }).contextLifecycle.summaryMaxInputTokens, 2_000);
  assert.equal(create({ summaryMaxInputTokens: 80_000 }).contextLifecycle.summaryMaxInputTokens, 8_000);
  for (const summaryMaxInputTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2000"]) {
    assert.throws(() => create({ summaryMaxInputTokens }), /summaryMaxInputTokens/);
  }
});

test("Assembly 具名 binding 以自身窗口减输出预留装配摘要，忽略更窄主目标", async (t) => {
  const { workspace, assembly } = await assemblyFixture(t, { named: true });
  const bound = assembly.agentProviders.get("compact").provider;
  const runtime = assembly.createAgentRuntime({ session: session(workspace), provider: bound,
    systemPrompt: "完成任务", maxInputTokens: 300 });
  assert.equal(runtime.contextLifecycle.maxInputTokens, 300);
  assert.equal(runtime.contextLifecycle.contextBudget.contextTargetTokens, 400);
  assert.equal(runtime.contextLifecycle.summaryMaxInputTokens, 12_000);
});

test("Gateway 默认、具名和固定 Snapshot 的摘要额度均由持久化 Provider 容量推导", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-summary-capacity-gateway-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  let manager;
  let fixed;
  t.after(async () => { await fixed?.close(); await manager?.close(); store.close();
    await fs.rm(workspace, { recursive: true, force: true }); });
  const defaultProvider = { type: "openai-compatible", model: "fixture", apiKey: "offline-fixture-key",
    baseUrl: "http://fixture.invalid/v1", contextWindowTokens: 8_000, contextTargetTokens: 400,
    maxOutputTokens: 2_000, outputTokenParameter: "max_tokens" };
  const agentProfiles = normalizeNamedAgentProfiles({ compact: { provider: {
    contextWindowTokens: 16_000, contextTargetTokens: 500, maxOutputTokens: 4_000,
  } } }, { defaultProvider });
  const instances = [];
  const runtimeFactory = (options) => {
    const runtime = new AgentRuntime(options);
    instances.push(runtime);
    return runtime;
  };
  manager = new GatewaySessionManager({ workspace, store, provider: provider(), agentProfiles,
    providerDescriptor: { ...defaultProvider, adapter: "openai-compatible", name: "summary-capacity-fixture" },
    tools, systemPrompt: "完成任务", runtimeFactory, defaultPermissionProfile: "workspace-auto" });
  const first = await manager.create();
  await manager.create({ agentProfileId: "compact" });
  assert.deepEqual(instances.map((runtime) => runtime.contextLifecycle.summaryMaxInputTokens), [6_000, 12_000]);
  assert.deepEqual(instances.map((runtime) => runtime.contextLifecycle.maxInputTokens), [400, 500]);
  fixed = new GatewaySessionManager({ workspace, store, provider: provider(), agentProfile: first.agentProfile,
    tools, systemPrompt: "完成任务", runtimeFactory, maxInputTokens: 999_999, defaultPermissionProfile: "workspace-auto" });
  await fixed.create({ resume: first.id });
  assert.equal(instances.at(-1).contextLifecycle.summaryMaxInputTokens, 6_000);
  assert.equal(instances.at(-1).contextLifecycle.maxInputTokens, 400);
});

test("无声明 Provider 容量的旧 Gateway 不把主输入目标误当摘要容量", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-summary-capacity-legacy-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({ workspace, store, provider: provider(), tools,
    systemPrompt: "完成任务", maxInputTokens: 400 });
  t.after(async () => { await manager.close(); store.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const state = await manager.create();
  assert.equal(manager.sessions.get(state.id).runtime.contextLifecycle.maxInputTokens, 400);
  assert.equal(manager.sessions.get(state.id).runtime.contextLifecycle.summaryMaxInputTokens, 32_000);
});

test("Workspace suite 将 binding 容量传入实际 Runtime，保留任务软目标和旧 factory 默认", async (t) => {
  const capacities = [];
  const original = AgentRuntime.prototype.runTurn;
  t.mock.method(AgentRuntime.prototype, "runTurn", function (...args) {
    capacities.push({ summary: this.contextLifecycle.summaryMaxInputTokens, main: this.contextLifecycle.maxInputTokens });
    return original.apply(this, args);
  });
  const descriptors = [
    { adapter: "openai-compatible", contextWindowTokens: 8_000 },
    { adapter: "openai-compatible", contextWindowTokens: 16_000, contextTargetTokens: 500,
      maxOutputTokens: 4_000, outputTokenParameter: "max_tokens" },
    null,
  ];
  for (const descriptor of descriptors) {
    const report = await runWorkspaceTaskSuite({ id: "summary-capacity", tasks: [{ id: "already-done",
      prompt: "回复完成", files: [{ path: "result.txt", content: "done" }], maxInputTokens: 400,
      checks: [{ id: "result", type: "file_equals", path: "result.txt", expected: "done" }],
    }] }, { providerFactory: () => descriptor ? { provider: provider(), descriptor } : provider() });
    assert.equal(report.passed, true);
    assert.equal(report.results[0].budget.maxInputTokens, 400);
    if (!descriptor) assert.equal("providerContract" in report.results[0], false);
  }
  assert.deepEqual(capacities, [
    { summary: 8_000, main: 400 }, { summary: 12_000, main: 400 }, { summary: 32_000, main: 400 },
  ]);
});

function session(workspace) {
  return new AgentSession({ state: createSession({ provider: "summary-capacity-fixture", workspace }), reducer: reduceSession });
}

async function assemblyFixture(t, { named = false } = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-summary-capacity-assembly-"));
  let assembly;
  t.after(async () => { await assembly?.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const composed = await composeRuntimeConfig({ root: workspace, env: { OPENAI_API_KEY: "offline-fixture-key" },
    args: [`--workspace=${workspace}`, "--execution=local", "--context-window-tokens=8000"],
  });
  const config = named ? { ...composed, agents: normalizeNamedAgentProfiles({ compact: { provider: {
    contextWindowTokens: 16_000, contextTargetTokens: 400, maxOutputTokens: 4_000, outputTokenParameter: "max_tokens",
  } } }, { defaultProvider: composed.provider }) } : composed;
  assembly = await createRuntimeAssembly({ config, bundledSkills: path.join(root, "skills"),
    environment: { NEXUS_USER_DATA_DIR: path.join(workspace, "user-data") } });
  await assembly.activate();
  return { workspace, assembly };
}
