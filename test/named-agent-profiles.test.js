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

test("具名 Agent Profile 拒绝危险权限、未知字段和不存在的默认项", () => {
  assert.throws(() => normalizeNamedAgentProfiles({ root: { permissionProfile: "danger-full-access" } }), /安全档位/);
  assert.throws(() => normalizeNamedAgentProfiles({ review: { provider: { unexpected: true } } }), /未知字段 unexpected/);
  assert.throws(() => normalizeNamedAgentProfiles({ review: {} }, { defaultId: "missing" }), /不存在/);
  assert.throws(() => normalizeNamedAgentProfiles({ "Invalid ID": {} }), /只能包含/);
});
