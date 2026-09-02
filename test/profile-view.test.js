import assert from "node:assert/strict";
import test from "node:test";
import { profileDriftViewModel, providerThinkingLabel } from "../src/web/profile-view.js";

test("Provider 思考模式投影为新任务可见标签", () => {
  assert.equal(providerThinkingLabel("enabled"), "思考开");
  assert.equal(providerThinkingLabel("disabled"), "思考关");
  assert.equal(providerThinkingLabel("provider-default"), "Provider 默认");
  assert.equal(providerThinkingLabel(undefined), "Provider 默认");
});

test("Profile 漂移投影为可读且不暴露 hash 的 Web 摘要", () => {
  assert.equal(profileDriftViewModel(null), null);
  const view = profileDriftViewModel({
    type: "agent.profile_selected",
    previousProfileVersion: "a".repeat(64),
    profileVersion: "b".repeat(64),
    changes: [
      { field: "provider.model", category: "provider", impact: "high", previous: "old", current: "new" },
      { field: "provider.thinking", category: "provider", impact: "high", previous: "disabled", current: "enabled" },
      { field: "toolset", category: "capability", impact: "medium", previous: "secret-old-hash", current: "secret-new-hash" },
      { field: "provider.model", category: "provider", impact: "high", previous: "old", current: "new" },
    ],
  });

  assert.equal(view.count, 4);
  assert.deepEqual(view.labels, ["模型", "思考模式", "工具集"]);
  assert.equal(view.highImpact, true);
  assert.equal(view.summary, "运行配置已更新：模型、思考模式、工具集");
  assert.equal(view.previousVersion, "aaaaaaaaaaaa");
  assert.equal(view.currentVersion, "bbbbbbbbbbbb");
  assert.doesNotMatch(view.summary, /secret|hash/);
});
