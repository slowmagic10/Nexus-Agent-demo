import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeNamedAgentProfiles } from "../src/core/named-agent-profiles.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";

test("Gateway 显式选择具名 Agent Profile 并持久绑定运行上下文", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-named-agent-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const reviewRequests = [];
  const provider = {
    name: "coding-provider",
    model: "coding-model",
    complete: async (request) => {
      return { text: "开发完成", toolCalls: [] };
    },
  };
  const reviewProvider = {
    name: "review-provider",
    model: "review-model",
    apiKey: "must-not-enter-session",
    complete: async (request) => {
      reviewRequests.push(request);
      return { text: "完成", toolCalls: [] };
    },
  };
  const host = { schemas: () => [], execute: async () => { throw new Error("不应执行"); } };
  const catalog = normalizeNamedAgentProfiles({
    coding: { label: "开发 Agent", instructions: "优先完成可运行实现", maxSteps: 7 },
    review: { label: "审查 Agent", instructions: "只报告问题", permissionProfile: "read-only", maxTokensPerTurn: 3_000 },
  }, { defaultId: "coding", maxSteps: 20, maxTokensPerTurn: 9_000 });
  const manager = new GatewaySessionManager({
    workspace,
    provider,
    providerDescriptor: { name: provider.name, adapter: "test", model: provider.model },
    tools: { schemas: () => [], get: () => null },
    permissionToolHosts: { "workspace-auto": host, "read-only": host },
    defaultPermissionProfile: "workspace-auto",
    agentProfiles: catalog,
    agentProviders: new Map([
      ["coding", {
        provider,
        descriptor: { name: provider.name, adapter: "test", model: provider.model, baseUrl: null },
      }],
      ["review", {
        provider: reviewProvider,
        descriptor: { name: reviewProvider.name, adapter: "test", model: reviewProvider.model, baseUrl: null },
      }],
    ]),
    systemPrompt: () => "base prompt",
    store,
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const runtime = manager.runtimeInfo();
  assert.equal(runtime.agentProfiles.defaultProfile, "coding");
  assert.deepEqual(runtime.agentProfiles.profiles.map((profile) => profile.id), ["coding", "default", "review"]);
  assert.doesNotMatch(JSON.stringify(runtime), /只报告问题|优先完成可运行实现/);
  assert.doesNotMatch(JSON.stringify(runtime), /must-not-enter-session/);

  const review = await manager.create({ agentProfileId: "review" });
  assert.equal(review.agentProfile.id, "review");
  assert.equal(review.provider, "review-provider");
  assert.equal(review.agentProfile.provider.model, "review-model");
  assert.doesNotMatch(JSON.stringify(review), /must-not-enter-session/);
  assert.equal(review.permissionProfile, "read-only");
  assert.equal(review.memoryScope.agentId, "review");
  assert.deepEqual(review.agentProfile.budgets, { maxSteps: 20, maxTokensPerTurn: 3_000 });
  assert.equal(manager.sessions.get(review.id).runtime.maxTokensPerTurn, 3_000);

  const reviewMemory = await manager.addSessionMemory(review.id, "只属于审查 Agent 的记忆", ["review"]);
  assert.equal(reviewMemory.scope.agentId, "review");
  assert.deepEqual((await manager.listSessionMemories(review.id)).map((item) => item.id), [reviewMemory.id]);
  assert.deepEqual(await manager.listMemories("审查 Agent"), []);
  await manager.deleteSessionMemory(review.id, reviewMemory.id, "审查 Agent 删除自己的记忆");
  assert.deepEqual(await manager.listSessionMemories(review.id), []);

  const candidate = await store.memory.add({
    content: "审查 Agent 的候选记忆",
    status: "candidate",
  }, {
    scope: review.memoryScope,
    provenance: { origin: "auto_extract", actor: "review" },
  });
  assert.deepEqual((await manager.listSessionMemoryCandidates(review.id)).map((item) => item.id), [candidate.id]);
  assert.deepEqual(await manager.listMemoryCandidates(), []);

  await manager.sendMessage(review.id, "检查项目");
  await waitFor(async () => (await manager.get(review.id)).phase === "completed");
  assert.match(reviewRequests[0].systemPrompt, /base prompt/);
  assert.match(reviewRequests[0].systemPrompt, /只报告问题/);

  const delegated = await manager.delegate(review.id, { objective: "复核一个问题", context: [] });
  assert.match(delegated, /已完成/);
  const childId = (await manager.get(review.id)).delegations.at(-1).childSessionId;
  const child = await manager.get(childId);
  assert.equal(child.provider, "review-provider");
  assert.equal(child.agentProfile.provider.model, "review-model");

  const branch = await manager.branch(review.id);
  assert.equal(branch.provider, "review-provider");
  assert.equal(branch.agentProfile.provider.model, "review-model");
  await assert.rejects(manager.create({ resume: review.id, agentProfileId: "coding" }), /不能覆盖其 Agent Profile/);
  await assert.rejects(manager.create({ agentProfileId: "missing" }), /Agent Profile 不可用/);
});

async function waitFor(predicate) {
  for (let index = 0; index < 50; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("等待会话完成超时");
}
