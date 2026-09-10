import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextLifecycle } from "../src/core/context-lifecycle.js";
import { selectContextSummaryBatch } from "../src/core/context-summary.js";
import { measureModelRequest } from "../src/core/model-usage.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore, validateAndReplayJournalArchive } from "../src/persistence/session-store.js";

const summary = { objective: "完成原始目标", completed: ["保留历史已知结果"] };
const mainResponse = { text: "完成", toolCalls: [], usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };

test("真实 Lifecycle 的巨大首 turn 摘要来源有界，缺失 usage 按实际完整请求记账", async () => {
  const messages = [{ role: "user", content: `原始用户目标：完成全部模块 ${"U".repeat(20_000)}` }];
  for (let index = 0; index < 10; index++) {
    messages.push({ role: "assistant", content: `历史步骤 ${index} ${"A".repeat(20_000)}`,
      provider_items: [{ type: "reasoning", encrypted_content: "opaque-must-stay-private" }] });
  }
  messages.push({ role: "assistant", content: "最终历史证据：全部离线验证已执行" }, { role: "user", content: "继续当前任务" });
  const session = memorySession(messages);
  const { lifecycle, summaryRequests, mainRequests } = fixture(session);

  await (await lifecycle.startTurn()).completeModelStep();

  assert.equal(summaryRequests.length, 1);
  const request = summaryRequests[0];
  const input = JSON.parse(request.messages[0].content);
  assert.ok(JSON.stringify(input.newHistory).length <= 48_000);
  assert.ok(input.newHistory.some((message) => message.role === "context_source_notice"));
  assert.equal(typeof input.sourceNotice, "string");
  assert.match(request.messages[0].content, /原始用户目标/);
  assert.match(request.messages[0].content, /最终历史证据/);
  assert.doesNotMatch(request.messages[0].content, /opaque-must-stay-private/);
  assert.deepEqual(request.tools, []);
  assert.deepEqual(request.messages.map(({ role }) => role), ["user"]);
  const event = session.state.events.find((item) => item.type === "context.summary_completed");
  assert.equal(event.usage.inputTokens, measureModelRequest(request).estimatedInputTokens);
  assert.equal(event.usageEstimated, true);
  assert.equal(event.usageEstimator, "utf8-bytes-div3-v1");
  assert.equal(event.sourceComplete, false);
  assert.equal(session.state.contextSummary.throughMessage, messages.length - 1);
  assert.equal(session.state.contextSummary.sourceComplete, false);
  assert.deepEqual(session.state.messages, messages);
  assert.equal(mainRequests.length, 1);
  assert.deepEqual(mainRequests[0].messages.at(-1), messages.at(-1));
  assert.equal(session.state.events.findLast((item) => item.type === "model.context_compacted").summary.sourceComplete, false);
});

test("来源曾不完整时，下一批完整历史仍传播不完整状态至实际请求和完成 action", async () => {
  const session = sessionAfterPartialSummary();
  const batch = selectContextSummaryBatch(session.state.messages, { fromMessage: 2, throughMessage: 4 });
  assert.equal(batch.sourceComplete, true);
  const { lifecycle, summaryRequests } = fixture(session);

  await (await lifecycle.startTurn()).completeModelStep();

  assert.equal(summaryRequests.length, 1);
  const input = JSON.parse(summaryRequests[0].messages[0].content);
  assert.deepEqual(input.newHistory, batch.messages);
  assert.equal(typeof input.sourceNotice, "string");
  assert.equal(session.state.contextSummary.throughMessage, 4);
  assert.equal(session.state.contextSummary.revision, 2);
  assert.equal(session.state.contextSummary.sourceComplete, false);
  const event = session.state.events.findLast((item) => item.type === "context.summary_completed");
  assert.equal(event.sourceComplete, false);
  assert.equal(event.usage.inputTokens, measureModelRequest(summaryRequests[0]).estimatedInputTokens);
});

test("旧完整摘要合并完整来源时保留 true，实际请求没有新增不完整说明", async () => {
  const session = sessionAfterPartialSummary(true);
  const { lifecycle, summaryRequests } = fixture(session);

  await (await lifecycle.startTurn()).completeModelStep();

  assert.equal(summaryRequests.length, 1);
  assert.equal("sourceNotice" in JSON.parse(summaryRequests[0].messages[0].content), false);
  assert.equal(session.state.contextSummary.sourceComplete, true);
  assert.equal(session.state.contextSummary.throughMessage, 4);
});

for (const mode of ["failure", "invalid-json", "cancel"]) {
  test(`不完整摘要继续更新发生 ${mode} 时不推进覆盖，按实际请求保留尝试成本`, async () => {
    const controller = new AbortController();
    const session = sessionAfterPartialSummary();
    const before = session.state.contextSummary;
    const { lifecycle, summaryRequests, mainRequests } = fixture(session, {
      completeSummary: async () => {
        if (mode === "cancel") {
          controller.abort(new Error("用户取消来源摘要"));
          throw controller.signal.reason;
        }
        if (mode === "failure") throw new Error("摘要请求失败");
        return { text: "invalid JSON", usage: null };
      },
    });
    const turn = await lifecycle.startTurn({ signal: controller.signal });

    if (mode === "cancel") await assert.rejects(turn.completeModelStep(), /用户取消来源摘要/);
    else await turn.completeModelStep();

    assert.equal(summaryRequests.length, 1);
    assert.deepEqual(session.state.contextSummary, before);
    assert.equal(mainRequests.length, mode === "cancel" ? 0 : 1);
    const event = session.state.events.findLast((item) => item.type === "context.summary_degraded");
    assert.ok(event);
    assert.equal(event.fromMessage, 2);
    assert.equal(event.throughMessage, 4);
    assert.equal(event.usage.inputTokens, measureModelRequest(summaryRequests[0]).estimatedInputTokens);
    assert.equal(event.usageEstimated, true);
  });
}

test("摘要完成后的取消保留已提交覆盖，不启动第二批或主模型", async () => {
  const controller = new AbortController();
  const session = sessionAfterPartialSummary();
  const { lifecycle, summaryRequests, mainRequests } = fixture(session);
  session.subscribeEvents((event) => {
    if (event.action.type === "CONTEXT_SUMMARY_COMPLETED") controller.abort(new Error("摘要完成后取消"));
  });

  const turn = await lifecycle.startTurn({ signal: controller.signal });
  await assert.rejects(turn.completeModelStep(), /摘要完成后取消/);

  assert.equal(summaryRequests.length, 1);
  assert.equal(mainRequests.length, 0);
  assert.equal(session.state.contextSummary.throughMessage, 4);
  assert.equal(session.state.contextSummary.sourceComplete, false);
  assert.equal(session.state.events.some((event) => event.type === "context.summary_degraded"), false);
});

test("旧 false 到 true 摘要 action 保持事实重放及 portable Journal 导入导出兼容", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-summary-compatibility-"));
  const store = new SessionStore(path.join(workspace, "sessions.db"), { workspace });
  try {
    const session = new AgentSession({ state: createSession({ provider: "summary-fixture", workspace }),
      reducer: reduceSession, journal: store });
    for (const sourceComplete of [false, true]) {
      const fromMessage = session.state.messages.length;
      await session.dispatch({ type: "USER_MESSAGE", content: "旧版摘要来源" });
      await session.dispatch({ type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "旧版结果" } });
      await session.dispatch({ type: "CONTEXT_SUMMARY_COMPLETED", summary, fromMessage,
        throughMessage: fromMessage + 2, sourceCursor: session.cursor, sourceComplete, modelCall: false });
      assert.equal(session.state.contextSummary.sourceComplete, sourceComplete);
    }
    const archive = store.exportJournal(session.id);
    const replayed = validateAndReplayJournalArchive(archive);
    assert.equal(replayed.state.contextSummary.sourceComplete, true);
    assert.deepEqual(replayed.events.filter((event) => event.type === "CONTEXT_SUMMARY_COMPLETED")
      .map((event) => event.action.sourceComplete), [false, true]);
    const imported = store.importJournal(archive, { id: "summary-legacy-import", workspace });
    assert.equal(imported.contextSummary.sourceComplete, true);
    assert.equal(store.load(imported.id).contextSummary.sourceComplete, true);
    const roundTrip = validateAndReplayJournalArchive(store.exportJournal(imported.id));
    assert.equal(roundTrip.state.contextSummary.sourceComplete, true);
    assert.deepEqual(roundTrip.events.filter((event) => event.type === "CONTEXT_SUMMARY_COMPLETED")
      .map((event) => event.action.sourceComplete), [false, true]);
  } finally {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

function memorySession(messages) {
  const state = createSession({ provider: "summary-fixture", workspace: "/tmp" });
  state.messages = structuredClone(messages);
  return new AgentSession({ state, reducer: reduceSession });
}

function sessionAfterPartialSummary(sourceComplete = false) {
  let state = createSession({ provider: "summary-fixture", workspace: "/tmp" });
  state = reduceSession(state, { type: "USER_MESSAGE", content: `第一轮 ${"A".repeat(9_000)}` });
  state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "第一轮结果" } });
  state = reduceSession(state, { type: "CONTEXT_SUMMARY_COMPLETED", summary, fromMessage: 0,
    throughMessage: 2, sourceCursor: 2, sourceComplete, modelCall: false });
  state = reduceSession(state, { type: "USER_MESSAGE", content: `第二轮 ${"B".repeat(9_000)}` });
  state = reduceSession(state, { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "第二轮结果" } });
  state = reduceSession(state, { type: "USER_MESSAGE", content: "继续当前任务" });
  return new AgentSession({ state, reducer: reduceSession });
}

function fixture(session, { completeSummary = async () => ({ text: JSON.stringify(summary), usage: null }) } = {}) {
  const summaryRequests = [];
  const mainRequests = [];
  const lifecycle = new ContextLifecycle({ session, systemPrompt: "保持原始用户目标", getTools: () => [],
    maxInputTokens: 2_000,
    provider: { name: "summary-fixture", complete: async (request) => {
      summaryRequests.push(request);
      return completeSummary(request);
    } },
    requestModel: async (request) => { mainRequests.push(request); return mainResponse; },
  });
  return { lifecycle, summaryRequests, mainRequests };
}
