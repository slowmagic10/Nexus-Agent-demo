import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "../src/core/agent.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import {
  discardMemoryMutation,
  reconcileMemoryOutbox,
  resolveMemoryMutation,
  retryMemoryMutation,
} from "../src/memory/outbox.js";
import { MemoryMutationError } from "../src/memory/interface.js";
import { createMemoryScope } from "../src/memory/scope.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("memory_save provenance 精确指向 TOOL_REQUESTED durable cursor", async () => {
  const fixture = createFixture();
  try {
    const { runtime, session } = createMemoryRuntime(fixture);
    await runtime.runTurn("记住", async () => true);

    const [record] = await fixture.store.memory.search("durable fact", { scope: fixture.scope });
    assert.equal(record.sourceSession, session.id);
    assert.equal(record.sourceToolCall, "call-memory");
    assert.equal(record.provenanceValidated, true);
    const source = fixture.store.db.prepare(
      "SELECT type, event_json AS eventJson FROM session_events WHERE session_id = ? AND seq = ?",
    ).get(session.id, record.sourceCursor);
    assert.equal(source.type, "TOOL_REQUESTED");
    assert.equal(JSON.parse(source.eventJson).action.call.id, "call-memory");
  } finally {
    fixture.close();
  }
});

test("Memory mutation 在 TOOL_RESULT 失败前已有 durable outbox 事实", async () => {
  const fixture = createFixture();
  try {
    const original = fixture.store.commitSessionEvent.bind(fixture.store);
    fixture.store.commitSessionEvent = (next, action, patch) => {
      if (action.type === "TOOL_RESULT") throw new Error("forced tool result failure");
      return original(next, action, patch);
    };
    const { runtime } = createMemoryRuntime(fixture);
    await runtime.runTurn("记住", async () => true);

    assert.equal(runtime.state.phase, "failed");
    assert.equal((await fixture.store.memory.search("durable fact", { scope: fixture.scope })).length, 1);
    assert.ok(runtime.state.events.some((event) => event.type === "memory.mutation_requested"));
    assert.ok(runtime.state.events.some((event) => event.type === "memory.mutation_applied"));
  } finally {
    fixture.close();
  }
});

test("中断在 mutation applied event 前可幂等 retry", async () => {
  const fixture = createFixture();
  try {
    const original = fixture.store.commitSessionEvent.bind(fixture.store);
    let failed = false;
    fixture.store.commitSessionEvent = (next, action, patch) => {
      if (!failed && action.type === "MEMORY_MUTATION_APPLIED") {
        failed = true;
        throw new Error("forced applied event failure");
      }
      return original(next, action, patch);
    };
    const { runtime, session } = createMemoryRuntime(fixture);
    await runtime.runTurn("记住", async () => true);
    assert.equal(session.state.pendingMemoryMutations.length, 0);
    assert.equal(session.state.memoryMutationIssues[0].status, "outcome_unknown");
    assert.equal(session.state.memoryMutationIssues[0].retryable, true);

    await retryMemoryMutation({
      session,
      memory: fixture.store.memory,
      mutationId: session.state.memoryMutationIssues[0].mutation.id,
    });

    assert.deepEqual(session.state.pendingMemoryMutations, []);
    assert.deepEqual(session.state.memoryMutationIssues, []);
    const [record] = await fixture.store.memory.search("durable fact", { scope: fixture.scope });
    assert.equal(record.version, 1);
    assert.deepEqual((await fixture.store.memory.verify(record.id, { scope: fixture.scope })).events.map((event) => event.type), [
      "memory.added",
    ]);
  } finally {
    fixture.close();
  }
});

test("失败 mutation 进入可恢复终态且不再阻断后续 turn", async () => {
  const fixture = createFixture();
  try {
    const session = new AgentSession({
      state: createSession({ provider: "test", workspace: fixture.workspace, memoryScope: fixture.scope }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    const mutation = mutationFixture(session, { id: "mutation-fails", content: "坏 mutation" });
    await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation });
    let attempts = 0;
    const result = await reconcileMemoryOutbox({
      session,
      memory: {
        add: async () => {
          attempts += 1;
          throw new Error("adapter rejected mutation");
        },
      },
    });

    assert.equal(result[0].status, "outcome_unknown");
    assert.equal(attempts, 1);
    assert.deepEqual(session.state.pendingMemoryMutations, []);
    assert.equal(session.state.memoryMutationIssues[0].status, "outcome_unknown");
    assert.match(session.state.memoryMutationIssues[0].error, /adapter rejected mutation/);
    assert.equal(session.state.memoryMutationIssues[0].outcome, "outcome_unknown");
    assert.equal(session.state.memoryMutationIssues[0].retryable, false);
    assert.equal(session.state.memoryMutationIssues[0].retryPolicy, "resolve_or_discard");
    assert.equal(session.state.memoryMutationIssues[0].attempts, 1);

    let providerCalls = 0;
    const runtime = new AgentRuntime({
      session,
      provider: {
        complete: async () => {
          providerCalls += 1;
          return { text: "后续轮次完成", toolCalls: [] };
        },
      },
      tools: { schemas: () => [] },
      systemPrompt: () => "test",
      reconcile: ({ signal } = {}) => reconcileMemoryOutbox({ session, memory: fixture.store.memory, signal }),
    });
    await runtime.runTurn("继续", async () => true);
    assert.equal(providerCalls, 1);
    assert.equal(runtime.state.phase, "completed");
    assert.equal(runtime.state.memoryMutationIssues.length, 1);
  } finally {
    fixture.close();
  }
});

test("忽略 AbortSignal 的非幂等 Adapter 超时后进入 outcome_unknown 且禁止 retry", async () => {
  const fixture = createFixture();
  try {
    const session = new AgentSession({
      state: createSession({ provider: "test", workspace: fixture.workspace, memoryScope: fixture.scope }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    const mutation = mutationFixture(session, { id: "mutation-outcome-unknown", content: "未知结果" });
    await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation });
    let calls = 0;
    let effects = 0;
    const nonIdempotentMemory = {
      add: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        effects += 1;
        return { id: `remote-${effects}` };
      },
    };

    const [result] = await reconcileMemoryOutbox({
      session,
      memory: nonIdempotentMemory,
      timeoutMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(result.status, "outcome_unknown");
    assert.equal(session.state.memoryMutationIssues[0].status, "outcome_unknown");
    assert.equal(session.state.memoryMutationIssues[0].retryable, false);
    await assert.rejects(
      retryMemoryMutation({ session, memory: nonIdempotentMemory, mutationId: mutation.id }),
      /不可重试/,
    );
    assert.equal(calls, 1);
    assert.equal(effects, 1);
  } finally {
    fixture.close();
  }
});

test("Adapter 类型化错误控制 safe-to-retry 与 non-retryable 策略", async () => {
  const fixture = createFixture();
  try {
    for (const expected of [
      { outcome: "safe_to_retry", retryable: true },
      { outcome: "non_retryable", retryable: false },
    ]) {
      const session = new AgentSession({
        state: createSession({ provider: "test", workspace: fixture.workspace, memoryScope: fixture.scope }),
        reducer: reduceSession,
        journal: fixture.store,
      });
      const mutation = mutationFixture(session, {
        id: `mutation-${expected.outcome}`,
        content: expected.outcome,
      });
      await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation });
      const [result] = await reconcileMemoryOutbox({
        session,
        memory: {
          capabilities: { mutationIdempotency: "none" },
          add: async () => {
            throw new MemoryMutationError(expected.outcome, { outcome: expected.outcome });
          },
        },
      });

      assert.equal(result.status, "failed");
      assert.equal(result.outcome, expected.outcome);
      assert.equal(session.state.memoryMutationIssues[0].retryable, expected.retryable);
    }
  } finally {
    fixture.close();
  }
});

test("manual mutation 可 retry、discard 或人工 resolve", async () => {
  const fixture = createFixture();
  try {
    const session = new AgentSession({
      state: createSession({ provider: "test", workspace: fixture.workspace, memoryScope: fixture.scope }),
      reducer: reduceSession,
      journal: fixture.store,
    });
    const retryMutation = mutationFixture(session, {
      id: "mutation-retry",
      content: "retry fact",
      reconcilePolicy: "manual",
    });
    await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: retryMutation });
    const manual = await reconcileMemoryOutbox({ session, memory: fixture.store.memory });
    assert.equal(manual[0].status, "manual_required");
    assert.deepEqual(session.state.pendingMemoryMutations, []);
    assert.equal(session.state.memoryMutationIssues[0].status, "manual_required");

    const retried = await retryMemoryMutation({
      session,
      memory: fixture.store.memory,
      mutationId: retryMutation.id,
    });
    assert.equal(retried.content, "retry fact");
    assert.deepEqual(session.state.memoryMutationIssues, []);

    const discardMutation = mutationFixture(session, { id: "mutation-discard", content: "discard fact" });
    await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: discardMutation });
    await discardMemoryMutation({ session, mutationId: discardMutation.id, reason: "用户放弃" });
    assert.deepEqual(session.state.pendingMemoryMutations, []);
    assert.ok(session.state.events.some((event) => event.type === "memory.mutation_discarded"));

    const resolveMutation = mutationFixture(session, {
      id: "mutation-resolve",
      content: "resolved elsewhere",
      reconcilePolicy: "manual",
    });
    await session.dispatch({ type: "MEMORY_MUTATION_REQUESTED", mutation: resolveMutation });
    await assert.rejects(
      resolveMemoryMutation({ session, mutationId: resolveMutation.id, memoryId: "bypass" }),
      /未找到待处理的 Memory mutation/,
    );
    assert.equal(session.state.pendingMemoryMutations.length, 1);
    await reconcileMemoryOutbox({ session, memory: fixture.store.memory });
    await resolveMemoryMutation({
      session,
      mutationId: resolveMutation.id,
      memoryId: "external-memory-id",
    });
    assert.deepEqual(session.state.memoryMutationIssues, []);
    assert.ok(session.state.events.some((event) => (
      event.type === "memory.mutation_applied" && event.memoryId === "external-memory-id"
    )));
  } finally {
    fixture.close();
  }
});

function createMemoryRuntime(fixture) {
  let calls = 0;
  const provider = {
    name: "memory-provider",
    complete: async () => ++calls === 1
      ? { text: "", toolCalls: [{ id: "call-memory", name: "memory_save", arguments: { content: "durable fact", tags: [] } }] }
      : { text: "完成", toolCalls: [] },
  };
  const tools = createToolRegistry({
    workspace: fixture.workspace,
    bundledSkills: path.join(fixture.workspace, "skills"),
    memory: fixture.store.memory,
  });
  const session = new AgentSession({
    state: createSession({ provider: provider.name, workspace: fixture.workspace, memoryScope: fixture.scope }),
    reducer: reduceSession,
    journal: fixture.store,
  });
  const runtime = new AgentRuntime({ session, provider, tools, systemPrompt: () => "test" });
  return { runtime, session };
}

function createFixture() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-memory-runtime-"));
  const scope = createMemoryScope({ workspace, agentId: "agent-test", userId: "user-test" });
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace, memoryScope: scope });
  return {
    workspace,
    scope,
    store,
    close() {
      store.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

function mutationFixture(session, {
  id,
  content,
  reconcilePolicy = "automatic",
}) {
  return {
    id,
    operation: "add",
    reconcilePolicy,
    candidate: { content, kind: "fact", confidence: 1 },
    scope: session.state.memoryScope,
    provenance: { origin: "user_explicit", actor: session.state.memoryScope.agentId },
  };
}
