import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { ToolHost } from "../src/tools/host.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { runWorkspaceTaskSuite } from "../src/evaluation/workspace-task-suite.js";

test("压缩档案可经真实Host回查原始中段，不读取现已修改的文件或重放旧工具", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-history-recovery-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  const session = new AgentSession({ state: createSession({ id: "recovery", provider: "offline", workspace }), reducer: reduceSession, journal: store });
  t.after(async () => { await session.drain(); session.close(); store.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts });
  const host = new ToolHost({ registry, artifactStore: store.artifacts });
  const original = "A".repeat(5000) + "MIDDLE_EVIDENCE=orion-48217" + "B".repeat(5000);
  await fs.writeFile(path.join(workspace, "notes.txt"), original);
  await session.dispatch({ type: "USER_MESSAGE", content: "读取 notes.txt" });
  const read = { id: "old-read", name: "read_file", arguments: { path: "notes.txt" } };
  await session.dispatch({ type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "", tool_calls: [{ id: read.id, type: "function", function: { name: read.name, arguments: JSON.stringify(read.arguments) } }] } });
  await host.execute(read, { session, requestApproval: async () => true });
  await session.dispatch({ type: "USER_MESSAGE", content: "回查之前记录的中段证据" });
  const prepared = session.prepareModelRequest({ systemPrompt: "使用已有工具回查，不执行旧操作。", tools: registry.schemas(), maxInputTokens: 100000 });
  assert.equal(prepared.contextPlan.historyProjection.applied, true);
  const excerpt = prepared.messages.find((message) => message.context_archive === "tool-history" && JSON.parse(message.content).recordType === "tool_result");
  assert.ok(excerpt);
  assert.equal(excerpt.content.includes("orion-48217"), false);
  assert.match(prepared.systemPrompt, /read_tool_history/);
  await fs.writeFile(path.join(workspace, "notes.txt"), "different current data");
  const query = async (args) => {
    const result = await host.execute({ id: `query-${session.cursor}`, name: "read_tool_history", arguments: args }, { session, requestApproval: async () => false });
    assert.equal(result.ok, true, result.result);
    return JSON.parse(result.result);
  };
  const discovery = await query({ call_id: read.id });
  assert.equal(discovery.occurrences.length, 1);
  let page = await query({ source_cursor: discovery.occurrences[0].sourceCursor, snapshot_cursor: discovery.snapshotCursor, limit: 3000 });
  let content = page.page.content;
  while (page.page.nextOffset !== null) {
    page = await query({ source_cursor: discovery.occurrences[0].sourceCursor, snapshot_cursor: page.snapshotCursor, offset: page.page.nextOffset, limit: 3000, expected_sha256: page.page.sha256 });
    content += page.page.content;
  }
  assert.equal(JSON.parse(content).result.content, original);
  assert.equal(session.state.events.filter((event) => event.type === "tool.execution_started" && event.tool === "read_file").length, 1);
});

test("实际工作区评测可从大输出Artifact取回中段并写出真正产物", async () => {
  const marker = "RECOVERY_VALUE=orion-48217";
  const content = "A".repeat(30000) + marker + "B".repeat(10000);
  let step = 0;
  const report = await runWorkspaceTaskSuite({ id: "artifact-recovery", tasks: [{
    id: "recover", prompt: "读取并记录恢复值", files: [{ path: "notes.txt", content }],
    checks: [{ id: "result", type: "file_equals", path: "result.txt", expected: "orion-48217" }],
  }] }, { providerFactory: () => ({ name: "offline-recovery", complete: async ({ messages, tools }) => {
    step += 1;
    const call = (name, args) => ({ text: "", finishReason: "tool_calls", toolCalls: [{ id: `call-${step}`, name, arguments: args }] });
    if (step === 1) {
      assert.ok(tools.some((tool) => tool.function.name === "read_artifact"));
      assert.ok(tools.some((tool) => tool.function.name === "read_tool_history"));
      return call("read_file", { path: "notes.txt" });
    }
    if (step === 2) {
      const artifact = messages.at(-1).content.match(/Artifact：([^（\s]+)/)?.[1];
      assert.ok(artifact);
      return call("read_artifact", { id: artifact, offset: 30000, limit: 100 });
    }
    if (step === 3) {
      assert.match(messages.at(-1).content, /RECOVERY_VALUE=orion-48217/);
      return call("write_file", { path: "result.txt", content: "orion-48217" });
    }
    return { text: "完成", finishReason: "stop", toolCalls: [] };
  } }) });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.score.falseCompletions, 0);
});

test("检索效果fixture通过实际搜索游标找到第320个文件，并读取长文件尾部", async () => {
  const suite = JSON.parse(await fs.readFile(new URL("../fixtures/task-suites/retrieval-v1.json", import.meta.url), "utf8"));
  let searchedPages = 0;
  const report = await runWorkspaceTaskSuite(suite, { providerFactory: ({ taskId }) => {
    let step = 0;
    let wrote = false;
    return { name: "offline-retrieval-fixture", complete: async ({ messages }) => {
      step += 1;
      const call = (name, args) => ({ text: "", finishReason: "tool_calls", toolCalls: [{ id: `step-${step}`, name, arguments: args }] });
      if (wrote) return { text: "完成", finishReason: "stop", toolCalls: [] };
      if (taskId === "search-after-300") {
        const args = { path: "data", query: "SETTING=enabled", limit: 1, scan_limit: 300 };
        if (step === 1) return call("search_files", args);
        searchedPages += 1;
        const page = JSON.parse(messages.at(-1).content);
        if (!page.matches.length) {
          assert.equal(page.has_more, true);
          assert.equal(page.complete, false);
          return call("search_files", { ...args, cursor: page.next_cursor });
        }
        wrote = true;
        return call("write_file", { path: "result.txt", content: page.matches[0].path });
      }
      if (step === 1) return call("read_file", { path: "notes.txt", start_line: 2401, line_count: 1 });
      const page = JSON.parse(messages.at(-1).content);
      const value = page.content.match(/RECOVERY_MARKER=([^\r\n]+)/)?.[1];
      assert.ok(value);
      wrote = true;
      return call("write_file", { path: "result.txt", content: value });
    } };
  } });
  assert.ok(searchedPages >= 2);
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.score.passed, 2);
});
