import assert from "node:assert/strict";
import test from "node:test";
import { profileDriftViewModel } from "../src/web/profile-view.js";

test("Profile 漂移投影为可读且不暴露 hash 的 Web 摘要", () => {
  assert.equal(profileDriftViewModel(null), null);
  const view = profileDriftViewModel({
    type: "agent.profile_selected",
    previousProfileVersion: "a".repeat(64),
    profileVersion: "b".repeat(64),
    changes: [
      { field: "provider.model", category: "provider", impact: "high", previous: "old", current: "new" },
      { field: "toolset", category: "capability", impact: "medium", previous: "secret-old-hash", current: "secret-new-hash" },
      { field: "provider.model", category: "provider", impact: "high", previous: "old", current: "new" },
    ],
  });

  assert.equal(view.count, 3);
  assert.deepEqual(view.labels, ["模型", "工具集"]);
  assert.equal(view.highImpact, true);
  assert.equal(view.summary, "运行配置已更新：模型、工具集");
  assert.equal(view.previousVersion, "aaaaaaaaaaaa");
  assert.equal(view.currentVersion, "bbbbbbbbbbbb");
  assert.doesNotMatch(view.summary, /secret|hash/);
});
