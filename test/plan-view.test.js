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
  });
});
