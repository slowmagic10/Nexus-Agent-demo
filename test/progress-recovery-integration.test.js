import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { runWorkspaceTaskSuite } from "../src/evaluation/workspace-task-suite.js";

test("真实文件任务从连续读取/精确编辑失败恢复，干预进入安全诊断并验收实际产物", async () => {
  const suite = JSON.parse(await fs.readFile(new URL("../fixtures/task-suites/recovery-v1.json", import.meta.url), "utf8"));
  const callCounts = new Map();
  const report = await runWorkspaceTaskSuite(suite, { providerFactory: ({ taskId }) => {
    let step = 0;
    callCounts.set(taskId, 0);
    const call = (name, args) => {
      callCounts.set(taskId, callCounts.get(taskId) + 1);
      return { text: "", toolCalls: [{ id: "reused", name, arguments: args }], finishReason: "tool_calls" };
    };
    return { name: "offline-recovery", complete: async (request) => {
      step++;
      // Deliberately simulate a model repeating a bad operation. The suite's
      // fixtures remain normal tasks usable by any explicitly supplied Provider.
      if (step <= 3) {
        assert.doesNotMatch(request.systemPrompt, /进展检查/);
        return taskId === "locate-moved-config" ? call("read_file", { path: "settings.json" })
          : call("edit_file", { path: "src/add.js", old_text: "return a - b;", new_text: "return a + b;" });
      }
      assert.match(request.systemPrompt, /进展检查/);
      assert.ok(request.messages.every((message) => message.role !== "system"));
      if (taskId === "locate-moved-config") {
        if (step === 4) return call("read_file", { path: "README.md" });
        if (step === 5) {
          assert.match(request.messages.at(-1).content, /config\/app.json/);
          return call("read_file", { path: "config/app.json" });
        }
        if (step === 6) {
          const config = JSON.parse(request.messages.at(-1).content);
          config.enabled = true;
          return call("write_file", { path: "config/app.json", content: JSON.stringify(config) + "\n" });
        }
      } else {
        if (step === 4) return call("read_file", { path: "src/add.js" });
        if (step === 5) {
          assert.match(request.messages.at(-1).content, /return \(a - b\);/);
          return call("edit_file", { path: "src/add.js", old_text: "return (a - b);", new_text: "return (a + b);" });
        }
      }
      return { text: "已完成修改", toolCalls: [], finishReason: "stop" };
    } };
  } });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.score.falseCompletions, 0);
  assert.deepEqual([...callCounts.values()], [6, 5]);
  for (const result of report.results) {
    assert.equal(result.phase, "completed");
    assert.ok(result.checks.every((check) => check.passed));
    assert.equal(result.diagnostics.reliability.interventions.progressIntervened, 1);
    assert.equal(result.diagnostics.reliability.interventions.repeatedToolFailure, 1);
    assert.equal(result.diagnostics.reliability.observedUserContinuations, 0);
    assert.equal(result.diagnostics.reliability.unnecessaryContinuationRate, null);
    assert.equal(result.diagnostics.reliability.terminalEvents.failed, 0);
  }
});
