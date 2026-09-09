import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAgentInstructions,
  inspectNamedAgentProfiles,
  normalizeNamedAgentProfiles,
} from "../src/core/named-agent-profiles.js";

test("具名 Agent Profile 继承默认值并只公开安全摘要", () => {
  const catalog = normalizeNamedAgentProfiles({
    review: {
      label: "代码审查",
      description: "只读检查代码",
      instructions: "private review instruction",
      permissionProfile: "read-only",
      maxSteps: 12,
    },
  }, {
    defaultId: "review",
    defaultPermissionProfile: "workspace-auto",
    maxTokensPerTurn: 8_000,
  });

  assert.equal(catalog.defaultProfile, "review");
  assert.deepEqual(catalog.profiles.map((profile) => profile.id), ["default", "review"]);
  const review = catalog.profiles.find((profile) => profile.id === "review");
  assert.equal(review.permissionProfile, "read-only");
  assert.equal(review.maxSteps, 12);
  assert.equal(review.maxTokensPerTurn, 8_000);
  const inspected = inspectNamedAgentProfiles(catalog);
  assert.equal(inspected.profiles.find((profile) => profile.id === "review").hasInstructions, true);
  assert.doesNotMatch(JSON.stringify(inspected), /private review instruction/);

  const prompt = appendAgentInstructions(() => "base prompt", review.instructions)({});
  assert.match(prompt, /base prompt/);
  assert.match(prompt, /private review instruction/);
});

test("具名 Agent Profile 继承并可覆盖 Provider Context Window", () => {
  const catalog = normalizeNamedAgentProfiles({
    inherited: {
      provider: { model: "inherited-model" },
    },
    million: {
      provider: { model: "million-model", contextWindowTokens: 1_000_000 },
    },
  }, {
    defaultId: "million",
    defaultProvider: {
      type: "openai-compatible",
      apiKey: "local-secret",
      baseUrl: "http://127.0.0.1:18001/v1",
      model: "base-model",
      thinking: "disabled",
      contextWindowTokens: 262_144,
    },
  });

  assert.equal(catalog.profiles.find((profile) => profile.id === "default").provider.contextWindowTokens, 262_144);
  assert.equal(catalog.profiles.find((profile) => profile.id === "inherited").provider.contextWindowTokens, 262_144);
  assert.equal(catalog.profiles.find((profile) => profile.id === "million").provider.contextWindowTokens, 1_000_000);
  assert.equal(
    inspectNamedAgentProfiles(catalog).profiles.find((profile) => profile.id === "million").provider.contextWindowTokens,
    1_000_000,
  );
});

test("具名 Agent Profile 拒绝危险权限、未知字段和不存在的默认项", () => {
  assert.throws(() => normalizeNamedAgentProfiles({ root: { permissionProfile: "danger-full-access" } }), /安全档位/);
  assert.throws(() => normalizeNamedAgentProfiles({ review: { provider: { unexpected: true } } }), /未知字段 unexpected/);
  assert.throws(() => normalizeNamedAgentProfiles({ review: {} }, { defaultId: "missing" }), /不存在/);
  assert.throws(() => normalizeNamedAgentProfiles({ "Invalid ID": {} }), /只能包含/);
  assert.throws(() => normalizeNamedAgentProfiles({ review: {
    provider: { type: "openai-responses", apiKey: "test", baseUrl: "https://example.com/v1", thinking: "enabled" },
  } }), /只支持 openai-compatible/);
  assert.throws(() => normalizeNamedAgentProfiles({ review: {
    provider: { contextWindowTokens: 0 },
  } }), /contextWindowTokens.*正整数/);
});

test("具名 Profile 完整继承请求契约，显式 null 和 false 可清除默认值", () => {
  const catalog = normalizeNamedAgentProfiles({
    inherited: { provider: { model: "same-contract" } },
    cleared: { provider: { contextTargetTokens: null, maxOutputTokens: null,
      outputTokenParameter: null, streamUsage: false } },
    changed: { provider: { contextTargetTokens: 25_000, maxOutputTokens: 3_000,
      outputTokenParameter: "max_completion_tokens" } },
  }, { defaultProvider: requestPolicyProvider() });
  const inherited = catalog.profiles.find((profile) => profile.id === "inherited").provider;
  assert.equal(inherited.contextTargetTokens, 20_000);
  assert.equal(inherited.maxOutputTokens, 2_000);
  assert.equal(inherited.outputTokenParameter, "max_tokens");
  assert.equal(inherited.streamUsage, true);
  const cleared = catalog.profiles.find((profile) => profile.id === "cleared").provider;
  assert.equal(cleared.contextTargetTokens, null);
  assert.equal(cleared.maxOutputTokens, null);
  assert.equal(cleared.outputTokenParameter, null);
  assert.equal(cleared.streamUsage, false);
  const summary = inspectNamedAgentProfiles(catalog).profiles;
  assert.equal(summary.find((profile) => profile.id === "changed").provider.maxOutputTokens, 3_000);
  assert.equal("maxOutputTokens" in summary.find((profile) => profile.id === "cleared").provider, false);
  assert.doesNotMatch(JSON.stringify(summary), /policy-secret/);
});

test("具名 Profile 切换 Adapter 清除不兼容继承，但拒绝显式不支持的选项", () => {
  const defaultProvider = requestPolicyProvider();
  const catalog = normalizeNamedAgentProfiles({
    responses: { provider: { type: "openai-responses" } },
    offline: { provider: { type: "demo" } },
  }, { defaultProvider });
  const responses = catalog.profiles.find((profile) => profile.id === "responses").provider;
  assert.equal(responses.maxOutputTokens, 2_000);
  assert.equal(responses.outputTokenParameter, null);
  assert.equal(responses.streamUsage, false);
  const offline = catalog.profiles.find((profile) => profile.id === "offline").provider;
  assert.equal(offline.contextTargetTokens, 20_000);
  assert.equal(offline.maxOutputTokens, null);
  assert.equal(offline.outputTokenParameter, null);
  assert.equal(offline.streamUsage, false);
  for (const provider of [
    { type: "openai-responses", streamUsage: true },
    { type: "openai-responses", outputTokenParameter: "max_tokens" },
    { type: "demo", maxOutputTokens: 2_000 },
    { maxOutputTokens: 5_000, outputTokenParameter: null },
    { contextTargetTokens: 40_001 },
    { maxOutputTokens: 40_000 },
    { contextTargetTokens: "1000" },
    { streamUsage: "false" },
  ]) assert.throws(() => normalizeNamedAgentProfiles({ invalid: { provider } }, { defaultProvider }));
});

test("Responses 切换 compatible 不继承缺少 wire 字段名的输出上限", () => {
  const defaultProvider = { ...requestPolicyProvider(), type: "openai-responses",
    outputTokenParameter: null, streamUsage: false };
  const catalog = normalizeNamedAgentProfiles({
    compatible: { provider: { type: "openai-compatible" } },
    explicit: { provider: { type: "openai-compatible", outputTokenParameter: "max_completion_tokens" } },
  }, { defaultProvider });
  const compatible = catalog.profiles.find((profile) => profile.id === "compatible").provider;
  assert.equal(compatible.maxOutputTokens, null);
  assert.equal(compatible.outputTokenParameter, null);
  assert.equal(compatible.contextTargetTokens, 20_000);
  const explicit = catalog.profiles.find((profile) => profile.id === "explicit").provider;
  assert.equal(explicit.maxOutputTokens, 2_000);
  assert.equal(explicit.outputTokenParameter, "max_completion_tokens");
  assert.throws(() => normalizeNamedAgentProfiles({ invalid: {
    provider: { type: "openai-compatible", maxOutputTokens: 1_000 },
  } }, { defaultProvider }), /显式选择 outputTokenParameter/);
});

function requestPolicyProvider() {
  return { type: "openai-compatible", apiKey: "policy-secret", baseUrl: "https://example.invalid/v1",
    model: "base", contextWindowTokens: 40_000, contextTargetTokens: 20_000,
    maxOutputTokens: 2_000, outputTokenParameter: "max_tokens", streamUsage: true };
}
