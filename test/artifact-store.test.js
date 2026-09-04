import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CapabilityRuntime } from "../src/capabilities/runtime.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { connectMcpTools } from "../src/mcp/tool-adapter.js";
import { WorkspaceExecutionError } from "../src/execution/local-workspace-adapter.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ToolHost } from "../src/tools/host.js";

test("SQLite Artifact Adapter 按 Session 持久化并校验内容摘要", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-artifact-store-"));
  const database = path.join(workspace, ".nexus", "nexus.db");
  let store = new SessionStore(database, { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const session = createSession({ id: "session-artifact-owner", provider: "test", workspace });
  store.ensureJournal(session);

  const created = await store.artifacts.put({
    sessionId: session.id,
    callId: "call-output",
    content: "完整构建输出\n第二行",
  });
  assert.match(created.id, /^artifact-/);
  assert.equal(created.byteSize, Buffer.byteLength("完整构建输出\n第二行"));
  assert.match(created.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(created, "content"), false);

  store.close();
  store = new SessionStore(database, { workspace });
  const restored = await store.artifacts.get(created.id, { sessionId: session.id });
  assert.equal(restored.content, "完整构建输出\n第二行");
  assert.deepEqual((await store.artifacts.list({ sessionId: session.id })).map((item) => item.id), [created.id]);
  assert.equal(await store.artifacts.get(created.id, { sessionId: "session-foreign" }), null);

  store.db.prepare("UPDATE artifacts SET content = ? WHERE id = ?").run("被篡改", created.id);
  await assert.rejects(store.artifacts.get(created.id, { sessionId: session.id }), /完整性校验失败/);
});

test("Tool Host 将脱敏后的大输出保存为 Artifact 并写入 durable 引用", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-tool-artifact-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const initial = createSession({ id: "session-tool-artifact", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const tool = {
    name: "large_output",
    description: "返回大输出",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    approval: "never",
    effects: ["read"],
    idempotency: "safe",
    execute: async () => `${"x".repeat(160)}\nAuthorization: Bearer secret-token`,
  };
  const registry = {
    get: (name) => name === tool.name ? tool : null,
    schemas: () => [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }],
  };
  const host = new ToolHost({ registry, artifactStore: store.artifacts, maxResultChars: 80 });

  const result = await host.execute({ id: "call-large-output", name: tool.name, arguments: {} }, { session });
  assert.equal(result.ok, true);
  assert.match(result.artifact.id, /^artifact-/);
  assert.match(result.result, /完整输出已保存为 Artifact/);
  assert.ok(result.result.length < 300);
  const artifact = await store.artifacts.get(result.artifact.id, { sessionId: session.id });
  assert.equal(artifact.content.length > 160, true);
  assert.doesNotMatch(artifact.content, /secret-token/);
  assert.match(artifact.content, /Bearer \[REDACTED\]/);
  assert.equal(session.state.events.findLast((event) => event.type === "tool.completed").artifact.id, result.artifact.id);
  assert.match(session.state.messages.at(-1).content, new RegExp(result.artifact.id));
});

test("read_artifact 只读取当前 Session 的分段内容", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-read-artifact-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const owner = createSession({ id: "session-read-artifact", provider: "test", workspace });
  store.ensureJournal(owner);
  const artifact = await store.artifacts.put({ sessionId: owner.id, callId: "call-source", content: "0123456789abcdef" });
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts });
  const tool = registry.get("read_artifact");

  assert.equal(await tool.execute({ id: artifact.id, offset: 4, limit: 6 }, { state: owner }), "Artifact 4-10 / 16 字符\n456789");
  await assert.rejects(
    tool.execute({ id: artifact.id }, { state: { ...owner, id: "session-foreign" } }),
    /Artifact 不存在或不属于当前 Session/,
  );
});

test("run_shell 长输出经过 WorkspaceExecution 后保存为 Artifact", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-shell-artifact-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const initial = createSession({ id: "session-shell-artifact", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  let capturedSpec;
  const registry = createToolRegistry({
    workspace,
    artifactStore: store.artifacts,
    workspaceExecution: {
      id: "artifact-execution",
      execute: async (spec) => {
        capturedSpec = spec;
        return { exitCode: 0, output: "shell-output\n".repeat(100), durationMs: 1 };
      },
    },
  });
  const host = new ToolHost({ registry, artifactStore: store.artifacts, maxResultChars: 100 });

  const result = await host.execute({
    id: "call-shell-artifact",
    name: "run_shell",
    arguments: { command: "printf shell-output" },
  }, { session, requestApproval: async () => true });

  assert.equal(capturedSpec.maxOutputChars, 1_000_000);
  assert.match(result.artifact.id, /^artifact-/);
  assert.match((await store.artifacts.get(result.artifact.id, { sessionId: session.id })).content, /shell-output/);
});

test("run_shell 失败大输出也由 Tool Host 保存为 Artifact", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-shell-failed-artifact-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const initial = createSession({ id: "session-shell-failed-artifact", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const fullOutput = `${Array.from({ length: 5_000 }, (_, index) => index + 1).join("\n")}\nTAIL-5000`;
  const registry = createToolRegistry({
    workspace,
    artifactStore: store.artifacts,
    workspaceExecution: {
      id: "artifact-failed-execution",
      execute: async () => ({ exitCode: 7, output: fullOutput, durationMs: 1 }),
    },
  });
  const host = new ToolHost({ registry, artifactStore: store.artifacts, maxResultChars: 120 });

  const result = await host.execute({
    id: "call-shell-failed-artifact",
    name: "run_shell",
    arguments: { command: "/usr/bin/seq 1 5000; exit 7" },
  }, { session, requestApproval: async () => true });

  assert.equal(result.status, "external_failed");
  assert.match(result.artifact.id, /^artifact-/);
  assert.ok(result.result.length < 350);
  const artifact = await store.artifacts.get(result.artifact.id, { sessionId: session.id });
  assert.match(artifact.content, /TAIL-5000/);
  assert.match(artifact.content, /退出码 7/);
});

test("run_shell 超时保留 WorkspaceExecutionError 输出并生成 Artifact", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-shell-timeout-artifact-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const initial = createSession({ id: "session-shell-timeout-artifact", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const fullOutput = `${"timeout-output\n".repeat(200)}TIMEOUT-TAIL`;
  const registry = createToolRegistry({
    workspace,
    artifactStore: store.artifacts,
    workspaceExecution: {
      id: "artifact-timeout-execution",
      execute: async () => {
        throw new WorkspaceExecutionError("execution timed out", {
          code: "timeout",
          result: { output: fullOutput },
        });
      },
    },
  });
  const host = new ToolHost({ registry, artifactStore: store.artifacts, maxResultChars: 120 });

  const result = await host.execute({
    id: "call-shell-timeout-artifact",
    name: "run_shell",
    arguments: { command: "long build", timeout_ms: 60_000 },
  }, { session, requestApproval: async () => true });

  assert.equal(result.status, "execution_unknown");
  assert.match(result.artifact.id, /^artifact-/);
  const artifact = await store.artifacts.get(result.artifact.id, { sessionId: session.id });
  assert.match(artifact.content, /timeout-output/);
  assert.match(artifact.content, /TIMEOUT-TAIL/);
});

test("run_shell 取消保留 WorkspaceExecutionError 输出并生成 Artifact", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-shell-cancel-artifact-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const initial = createSession({ id: "session-shell-cancel-artifact", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const fullOutput = `${"cancel-output\n".repeat(200)}CANCEL-TAIL`;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const registry = createToolRegistry({
    workspace,
    artifactStore: store.artifacts,
    workspaceExecution: {
      id: "artifact-cancel-execution",
      execute: async (_spec, { signal }) => {
        markStarted();
        return await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new WorkspaceExecutionError("execution cancelled", {
            code: "cancelled",
            result: { output: fullOutput },
          })), { once: true });
        });
      },
    },
  });
  const host = new ToolHost({ registry, artifactStore: store.artifacts, maxResultChars: 120 });
  const controller = new AbortController();
  const execution = host.execute({
    id: "call-shell-cancel-artifact",
    name: "run_shell",
    arguments: { command: "long build" },
  }, { session, signal: controller.signal, requestApproval: async () => true });
  await started;

  controller.abort(new Error("user-stop"));
  await assert.rejects(execution, /execution cancelled/);

  const completed = session.state.events.find((event) => (
    event.type === "tool.completed" && event.callId === "call-shell-cancel-artifact"
  ));
  assert.equal(completed.status, "execution_unknown");
  assert.match(completed.artifact.id, /^artifact-/);
  const artifact = await store.artifacts.get(completed.artifact.id, { sessionId: session.id });
  assert.match(artifact.content, /cancel-output/);
  assert.match(artifact.content, /CANCEL-TAIL/);
});

test("run_shell 外部执行失败也保留 WorkspaceExecutionError 输出", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-shell-external-error-artifact-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const initial = createSession({ id: "session-shell-external-error-artifact", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const fullOutput = `${"container-output\n".repeat(200)}CONTAINER-TAIL`;
  const registry = createToolRegistry({
    workspace,
    artifactStore: store.artifacts,
    workspaceExecution: {
      id: "artifact-container-failed-execution",
      execute: async () => {
        throw new WorkspaceExecutionError("container failed", {
          code: "container_failed",
          result: { output: fullOutput },
        });
      },
    },
  });
  const host = new ToolHost({ registry, artifactStore: store.artifacts, maxResultChars: 120 });

  const result = await host.execute({
    id: "call-shell-external-error-artifact",
    name: "run_shell",
    arguments: { command: "container task" },
  }, { session, requestApproval: async () => true });

  assert.equal(result.status, "external_failed");
  assert.match(result.artifact.id, /^artifact-/);
  const artifact = await store.artifacts.get(result.artifact.id, { sessionId: session.id });
  assert.match(artifact.content, /container-output/);
  assert.match(artifact.content, /CONTAINER-TAIL/);
});

test("MCP 大输出在进入 Tool Host 前保持完整尾部", async (t) => {
  const root = path.resolve(import.meta.dirname, "..");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-mcp-artifact-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const capabilityRuntime = new CapabilityRuntime();
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts, capabilityRuntime });
  const mcp = await connectMcpTools([{
    name: "artifact-echo",
    command: process.execPath,
    args: [path.join(root, "scripts", "mcp-echo-server.js")],
    cwd: root,
  }], { capabilityRuntime });
  t.after(async () => {
    await mcp.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const initial = createSession({ id: "session-mcp-artifact", provider: "test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const host = new ToolHost({ registry, artifactStore: store.artifacts, maxResultChars: 120 });
  const tail = "MCP-TAIL-MARKER";

  const result = await host.execute({
    id: "call-mcp-artifact",
    name: "mcp__artifact-echo__echo",
    arguments: { text: `${"m".repeat(20_000)}${tail}` },
  }, { session, requestApproval: async () => true });

  assert.equal(result.status, "completed");
  const artifact = await store.artifacts.get(result.artifact.id, { sessionId: session.id });
  assert.match(artifact.content, new RegExp(`${tail}$`));
  assert.ok(artifact.content.length > 20_000);
});

test("Gateway Manager 只通过 Session 作用域列出和读取 Artifact", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-artifact-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const manager = new GatewaySessionManager({
    workspace,
    provider: { name: "artifact-provider", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const owner = await manager.create();
  const foreign = await manager.create();
  const artifact = await store.artifacts.put({ sessionId: owner.id, callId: "call-http", content: "full" });

  assert.deepEqual((await manager.listArtifacts(owner.id)).map((item) => item.id), [artifact.id]);
  assert.equal((await manager.getArtifact(owner.id, artifact.id)).content, "full");
  await assert.rejects(manager.getArtifact(foreign.id, artifact.id), (error) => error.status === 404);
});
