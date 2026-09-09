import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runWorkspaceTaskSuite } from "../src/evaluation/workspace-task-suite.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";

const fixture = (overrides = {}) => ({ id: "policy-suite", tasks: [{
  id: "write-file", prompt: "Write done to result.txt", files: [],
  checks: [{ id: "result", type: "file_equals", path: "result.txt", expected: "done" }],
  ...overrides,
}] });
const compatibleDescriptor = {
  adapter: "openai-compatible", contextWindowTokens: 16000,
  contextTargetTokens: 12000, maxOutputTokens: 6000,
  outputTokenParameter: "max_completion_tokens", streamUsage: true,
};

test("Workspace binding 以模型容量减输出预留和 context 目标的较小值运行，wire 与 contract 对应", async () => {
  const { report, requests, plans, workspace } = await runRecorded(compatibleDescriptor);
  const result = report.results[0];
  assert.equal(report.passed, true);
  assert.equal(result.budget.maxInputTokens, 10000);
  assert.deepEqual(result.providerContract, { version: "provider-request-policy-v1", ...compatibleDescriptor });
  assert.equal(result.providerContractHash, digest(result.providerContract));
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.equal(plan.maxInputTokens, 10000);
    assert.deepEqual(plan.contextBudget, {
      version: "context-budget-v1", contextWindowTokens: 16000,
      contextTargetTokens: 12000, reservedOutputTokens: 6000, maxInputTokens: 10000,
    });
  }
  for (const request of requests) {
    assert.equal(request.max_completion_tokens, 6000);
    assert.equal("max_tokens" in request, false);
    assert.deepEqual(request.stream_options, { include_usage: true });
  }
  await assert.rejects(fs.access(workspace));
});

test("Workspace 任务自身更窄的输入预算继续优先，fixture hash 不因 Provider 合同改变", async () => {
  const first = await runRecorded(compatibleDescriptor, { maxInputTokens: 6000 });
  const second = await runRecorded({ ...compatibleDescriptor, contextTargetTokens: 7000 }, { maxInputTokens: 6000 });
  for (const { report, plans } of [first, second]) {
    assert.equal(report.passed, true);
    assert.equal(report.results[0].budget.maxInputTokens, 6000);
    assert.ok(plans.every((plan) => plan.maxInputTokens === 6000));
    assert.ok(plans.every((plan) => plan.contextBudget.contextWindowTokens === 16000));
  }
  assert.equal(first.report.results[0].taskHash, second.report.results[0].taskHash);
  assert.notEqual(first.report.results[0].providerContractHash, second.report.results[0].providerContractHash);
});

test("只有 capacity 的 binding 仍限制输入，省略默认策略及 contextBudget 元数据", async () => {
  const descriptor = { adapter: "openai-compatible", contextWindowTokens: 8000 };
  const { report, requests, plans } = await runRecorded(descriptor);
  assert.equal(report.passed, true);
  assert.equal(report.results[0].budget.maxInputTokens, 8000);
  assert.deepEqual(report.results[0].providerContract, { version: "provider-request-policy-v1", ...descriptor });
  assert.ok(plans.every((plan) => plan.maxInputTokens === 8000 && !("contextBudget" in plan)));
  assert.ok(requests.every((request) => !("max_tokens" in request) && !("max_completion_tokens" in request) && !("stream_options" in request)));
});

test("Responses binding 的输出预留与真实 max_output_tokens 请求一致", async () => {
  const descriptor = { adapter: "openai-responses", contextWindowTokens: 14000, maxOutputTokens: 5000 };
  const { report, requests, plans } = await runRecorded(descriptor);
  assert.equal(report.passed, true);
  assert.equal(report.results[0].budget.maxInputTokens, 9000);
  assert.deepEqual(report.results[0].providerContract, { version: "provider-request-policy-v1", ...descriptor });
  assert.ok(plans.every((plan) => plan.maxInputTokens === 9000 && plan.contextBudget.reservedOutputTokens === 5000));
  assert.ok(requests.every((request) => request.max_output_tokens === 5000 && !("max_tokens" in request) && !("stream_options" in request)));
});

test("同名模型仅切 wire 参数时合同 hash 改变，原模型身份与产物 resultHash 保持语义", async () => {
  const first = (await runRecorded(compatibleDescriptor)).report.results[0];
  const second = (await runRecorded({ ...compatibleDescriptor, outputTokenParameter: "max_tokens" })).report.results[0];
  const third = (await runRecorded({ ...compatibleDescriptor, streamUsage: false })).report.results[0];
  for (const result of [first, second, third]) {
    assert.equal(result.passed, true);
    assert.equal(result.providerIdentityHash, first.providerIdentityHash);
    assert.equal(result.taskHash, first.taskHash);
    assert.equal(result.resultHash, first.resultHash);
    assert.equal(result.resultHash, digest({ phase: result.phase, passed: result.passed, errorCode: result.errorCode, checks: result.checks }));
  }
  assert.equal(new Set([first, second, third].map((result) => result.providerContractHash)).size, 3);
  assert.equal("streamUsage" in third.providerContract, false);
});

test("评测合同仅读取白名单字段，未知 descriptor 的密钥、端点和描述不进入报告或合同 hash", async () => {
  const descriptor = {
    ...compatibleDescriptor,
    apiKey: "sk-descriptor-private-0123456789", baseUrl: "http://192.168.121.110:18001/v1",
    model: "descriptor-private-model", name: "descriptor-private-name",
    description: "descriptor-private-description",
    nested: { token: "descriptor-private-token" },
    get unused() { throw new Error("must not inspect unused descriptor data"); },
    toJSON() { throw new Error("must not serialize raw descriptor"); },
  };
  const first = (await runRecorded(descriptor)).report;
  const second = (await runRecorded(compatibleDescriptor)).report;
  assert.equal(first.passed, true);
  assert.equal(first.results[0].providerContractHash, second.results[0].providerContractHash);
  assert.doesNotMatch(JSON.stringify(first), /descriptor-private|192\.168|18001|apiKey|baseUrl|description|must not/);
});

test("旧 Provider factory 维持原 report 字段与预算，忽略 Provider 自身偶然同名属性", async () => {
  let workspace;
  const requests = [];
  const plans = [];
  const report = await runWorkspaceTaskSuite(fixture({ maxInputTokens: 17000 }), { providerFactory: (context) => {
    workspace = context.workspace;
    const provider = fakeProvider({ adapter: "openai-compatible" }, workspace, requests, plans);
    Object.defineProperty(provider, "descriptor", { get: () => { throw new Error("legacy descriptor must not be touched"); } });
    Object.defineProperty(provider, "provider", { get: () => { throw new Error("legacy provider must not be touched"); } });
    return provider;
  } });
  const result = report.results[0];
  assert.equal(report.passed, true);
  assert.equal(result.budget.maxInputTokens, 17000);
  assert.equal("providerContract" in result, false);
  assert.equal("providerContractHash" in result, false);
  assert.ok(plans.every((plan) => plan.maxInputTokens === 17000 && !("contextBudget" in plan)));
  assert.equal(result.providerIdentityHash, digestBytes("openai-compatible/fixture-model"));
  assert.equal(result.resultHash, digest({ phase: result.phase, passed: result.passed, errorCode: result.errorCode, checks: result.checks }));
  await assert.rejects(fs.access(workspace));
});

test("显式 binding 非法 descriptor 在初始化失败，安全报告不包含原始错误且清理目录", async () => {
  for (const descriptor of [
    undefined,
    { adapter: "private-invalid-adapter", contextWindowTokens: 16000 },
    { adapter: "openai-compatible" },
    { adapter: "openai-compatible", contextWindowTokens: "16000" },
    { adapter: "openai-compatible", contextWindowTokens: 16000, contextTargetTokens: 16001 },
    { adapter: "openai-compatible", contextWindowTokens: 16000, maxOutputTokens: 1000 },
    { adapter: "openai-compatible", contextWindowTokens: 16000, maxOutputTokens: 16000, outputTokenParameter: "max_tokens" },
    { adapter: "openai-responses", contextWindowTokens: 16000, streamUsage: true },
    { adapter: "demo", contextWindowTokens: 16000, maxOutputTokens: 1000 },
    { get adapter() { throw new Error("private-error-body-with-api-key"); } },
  ]) {
    let workspace;
    let calls = 0;
    const report = await runWorkspaceTaskSuite(fixture(), { providerFactory: (context) => {
      workspace = context.workspace;
      return { provider: { name: "fixture", complete: async () => { calls += 1; } }, descriptor };
    } });
    const result = report.results[0];
    assert.equal(result.passed, false);
    assert.equal(result.errorCode, "provider_initialization_failed");
    assert.equal(calls, 0);
    assert.equal("providerContract" in result, false);
    assert.doesNotMatch(JSON.stringify(report), /private-invalid|private-error|api-key/);
    await assert.rejects(fs.access(workspace));
  }
});

test("合法 demo binding 可携带 context 目标，输出合同不增加默认字段", async () => {
  let workspace;
  const descriptor = { adapter: "demo", contextWindowTokens: 18000, contextTargetTokens: 9000, maxOutputTokens: null, outputTokenParameter: null, streamUsage: false };
  const report = await runWorkspaceTaskSuite(fixture(), { providerFactory: async (context) => {
    workspace = context.workspace;
    await fs.writeFile(path.join(workspace, "result.txt"), "done");
    return { provider: { name: "offline-demo", complete: async () => ({ text: "完成", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }) }, descriptor };
  } });
  assert.equal(report.passed, true);
  assert.equal(report.results[0].budget.maxInputTokens, 9000);
  assert.deepEqual(report.results[0].providerContract, { version: "provider-request-policy-v1", adapter: "demo", contextWindowTokens: 18000, contextTargetTokens: 9000 });
  await assert.rejects(fs.access(workspace));
});

test("binding 的真实 Provider fetch 忽略取消仍能结束评测并清理，迟到响应不执行工具", async (t) => {
  const abort = new AbortController();
  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  let workspace;
  let requests = 0;
  const running = runWorkspaceTaskSuite(fixture(), { signal: abort.signal, providerFactory: (context) => {
    workspace = context.workspace;
    return { descriptor: compatibleDescriptor, provider: new OpenAICompatibleProvider({
      apiKey: "test-key", baseUrl: "https://example.invalid/v1", model: "fixture-model",
      maxOutputTokens: 6000, outputTokenParameter: "max_completion_tokens", streamUsage: true,
      fetchImpl: async () => { requests += 1; started.resolve(); return pending.promise; },
    }) };
  } });
  await started.promise;
  abort.abort();
  let timeout;
  t.after(() => clearTimeout(timeout));
  const report = await Promise.race([running, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("cancel timeout")), 1000); })]);
  assert.equal(report.cancelled, true);
  assert.equal(report.results[0].phase, "cancelled");
  assert.equal(report.results[0].providerContract.maxOutputTokens, 6000);
  await assert.rejects(fs.access(workspace));
  pending.resolve(jsonResponse(chatWriteResponse()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  await assert.rejects(fs.access(workspace));
});

async function runRecorded(descriptor, taskOverrides = {}) {
  let workspace;
  const requests = [];
  const plans = [];
  const report = await runWorkspaceTaskSuite(fixture(taskOverrides), { providerFactory: (context) => {
    workspace = context.workspace;
    return { provider: fakeProvider(descriptor, workspace, requests, plans), descriptor };
  } });
  return { report, requests, plans, workspace };
}

function fakeProvider(descriptor, workspace, requests, plans) {
  const Provider = descriptor.adapter === "openai-responses" ? OpenAIResponsesProvider : OpenAICompatibleProvider;
  return new Provider({
    apiKey: "test-key", baseUrl: "https://example.invalid/v1", model: "fixture-model",
    maxOutputTokens: descriptor.maxOutputTokens, outputTokenParameter: descriptor.outputTokenParameter,
    streamUsage: descriptor.streamUsage,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const db = new DatabaseSync(path.join(workspace, ".nexus", "nexus.db"), { readOnly: true });
      try {
        const row = db.prepare("SELECT event_json FROM session_events WHERE type = 'MODEL_CONTEXT_PREPARED' ORDER BY seq DESC LIMIT 1").get();
        plans.push(JSON.parse(row.event_json).action.plan);
      } finally { db.close(); }
      if (descriptor.adapter === "openai-responses") return jsonResponse({
        status: "completed", output: requests.length === 1
          ? [{ type: "function_call", call_id: "write", name: "write_file", arguments: '{"path":"result.txt","content":"done"}' }]
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      return jsonResponse(requests.length === 1 ? chatWriteResponse() : {
        choices: [{ message: { content: "完成" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });
}

function chatWriteResponse() {
  return {
    choices: [{ message: { content: "", tool_calls: [{ id: "write", function: { name: "write_file", arguments: '{"path":"result.txt","content":"done"}' } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}
function jsonResponse(value) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
function digestBytes(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function digest(value) { return digestBytes(JSON.stringify(value)); }
