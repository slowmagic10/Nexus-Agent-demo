import assert from "node:assert/strict";
import test from "node:test";
import { objectivePlanViewModel } from "../src/web/plan-view.js";

test("Objective 计划投影为紧凑 Web ViewModel", () => {
  assert.equal(objectivePlanViewModel(null, null), null);
  assert.deepEqual(objectivePlanViewModel({ text: "完成 M7", status: "active" }, {
    revision: 2,
    explanation: "先打通纵向切片",
    steps: [
      { step: "状态", status: "completed" },
      { step: "Web", status: "in_progress" },
      { step: "验证", status: "pending" },
    ],
  }), {
    objective: "完成 M7",
    status: "active",
    statusLabel: "进行中",
    explanation: "先打通纵向切片",
    revision: 2,
    steps: [
      { step: "状态", status: "completed", marker: "✓" },
      { step: "Web", status: "in_progress", marker: "→" },
      { step: "验证", status: "pending", marker: "·" },
    ],
    delegations: [],
  });
});

test("Objective 计划投影包含 Child 委派状态", () => {
  const view = objectivePlanViewModel({ text: "完成父任务", status: "active" }, null, [{
    objective: "检查子模块",
    childSessionId: "session-child",
    status: "running",
  }]);
  assert.deepEqual(view.delegations, [{
    objective: "检查子模块",
    childSessionId: "session-child",
    status: "running",
    statusLabel: "执行中",
    marker: "→",
  }]);
});
