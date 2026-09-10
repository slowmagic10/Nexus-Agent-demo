import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelContextProjection, prepareModelRequest, projectModelContext } from "../src/core/model-context.js";
import { defineSystemPrompt, systemPromptFields } from "../src/core/system-prompt.js";
import { appendAgentInstructions } from "../src/core/named-agent-profiles.js";
import { AgentSession } from "../src/core/session.js";
import { ContextLifecycle } from "../src/core/context-lifecycle.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { buildSystemPrompt } from "../src/workspace.js";
import { promptContextFixture } from "./support/prompt-context-fixture.js";

const at = "2026-09-10T02:00:00.000Z";
const modelKeys = ["messages", "memory", "contextMemory", "contextSummary", "loadedSkills", "objective", "plan", "delegations"];
const builtin = () => buildSystemPrompt("工作区要求：只做离线验证。");
function fixture() {
  const { state, tools } = promptContextFixture();
  return { state, tools, context: projectModelContext([], state), projection: new ModelContextProjection([], state) };
}
function promptClones(run) {
  const native = globalThis.structuredClone;
  const snapshots = [];
  globalThis.structuredClone = (value, ...args) => {
    if (value && !Array.isArray(value) && Object.hasOwn(value, "contextMemory")) snapshots.push(Object.keys(value));
    return native(value, ...args);
  };
  try { return { result: run(), snapshots }; }
  finally { globalThis.structuredClone = native; }
}

test("提示依赖显式声明、校验并保存为不可变快照", () => {
  const fields = ["memory", "memory", "plan"];
  let received;
  const render = (context) => { received = context; return "提示"; };
  const prompt = defineSystemPrompt(fields, render);
  fields.push("messages");
  assert.deepEqual(systemPromptFields(prompt), ["memory", "plan"]);
  assert.equal(systemPromptFields(render), null);
  assert.throws(() => systemPromptFields(prompt).push("messages"), TypeError);
  const context = { memory: [] };
  assert.equal(prompt(context), "提示");
  assert.equal(received, context);
  for (const value of [null, "memory", ["unknown"], [undefined], Array(1)]) {
    assert.throws(() => defineSystemPrompt(value, render), /fields/);
  }
  assert.throws(() => defineSystemPrompt([], null), /render/);
  assert.deepEqual(systemPromptFields("固定提示"), []);
  for (const value of [null, undefined, 1, false, {}, () => "custom"]) assert.equal(systemPromptFields(value), null);
});

for (const opaque of [false, true]) {
  test(`${opaque ? "不透明 Provider" : "普通工具"}历史在各种提示和预算下与完整快照请求一致`, () => {
    const { state, tools } = promptContextFixture(10, { opaque });
    const projection = new ModelContextProjection([], state);
    const context = projectModelContext([], state);
    const before = structuredClone(state);
    const prompts = ["固定提示", builtin(), appendAgentInstructions(builtin(), "当前 Profile 额外要求"),
      appendAgentInstructions(appendAgentInstructions("固定提示", "第一层"), "第二层")];
    const observations = new Set();
    for (const systemPrompt of prompts) for (const maxInputTokens of [1, 4_200, 6_500, 9_000, 1_000_000]) {
      const options = { systemPrompt, tools, maxInputTokens };
      const actual = projection.prepareRequest(options);
      assert.deepEqual(actual, prepareModelRequest(context, options));
      assert.ok(actual.messages.some((message) => message.content === "继续当前任务，不启动服务"));
      if (actual.contextPlan.summary.included) observations.add("summary");
      if (actual.contextPlan.compacted) observations.add("compacted");
      if (!actual.contextPlan.compacted) observations.add("full");
      if (opaque && maxInputTokens === 1_000_000) {
        assert.equal(actual.contextPlan.historyProjection.applied, false);
        assert.equal(actual.contextPlan.activeToolProjection.applied, false);
        assert.deepEqual(actual.messages[1].provider_items, state.messages[1].provider_items);
      }
    }
    assert.deepEqual([...observations].sort(), ["compacted", "full", "summary"]);
    assert.deepEqual(state, before);
    assert.deepEqual(context, projectModelContext([], before));
  });
}

test("原生内置提示不复制 messages，静态提示只复制记忆审计与摘要元数据", () => {
  const { projection, tools } = fixture();
  for (const prompt of [builtin(), appendAgentInstructions(builtin(), "附加约束")]) {
    const { snapshots } = promptClones(() => projection.prepareRequest({ systemPrompt: prompt, tools }));
    assert.deepEqual(snapshots, [modelKeys.filter((key) => key !== "messages")]);
  }
  for (const prompt of ["固定提示", appendAgentInstructions("固定提示", "附加约束")]) {
    const { snapshots } = promptClones(() => projection.prepareRequest({ systemPrompt: prompt, tools }));
    assert.deepEqual(snapshots, [["contextMemory", "contextSummary"]]);
  }
});

test("公开纯函数即使遇到内置提示也保留完整快照与克隆异常", () => {
  const { context, tools } = fixture();
  const { snapshots } = promptClones(() => prepareModelRequest(context, { systemPrompt: builtin(), tools }));
  assert.deepEqual(snapshots, [modelKeys]);
  const badContext = { ...context, extra: () => null };
  assert.throws(() => prepareModelRequest(badContext, { systemPrompt: builtin(), tools }), { name: "DataCloneError" });
  let getterCalls = 0;
  const withGetter = { ...context, get extra() { getterCalls += 1; return "旧读取语义"; } };
  prepareModelRequest(withGetter, { systemPrompt: "固定提示", tools });
  assert.equal(getterCalls, 1);
});

test("自定义提示仍收到八字段快照，回调修改不能改变消息或下一次请求", () => {
  const { projection, context, tools } = fixture();
  let captured;
  const systemPrompt = (value) => {
    captured = value;
    assert.deepEqual(Object.keys(value), modelKeys);
    value.messages[0].content = "只改提示快照";
    value.messages.length = 1;
    value.plan.steps.length = 0;
    value.contextSummary.revision = 123;
    return "自定义提示";
  };
  const actual = projection.prepareRequest({ systemPrompt, tools });
  const retained = captured;
  assert.equal(actual.contextPlan.summary.revision, 123);
  assert.notEqual(actual.messages[0].content, "只改提示快照");
  assert.deepEqual(actual, prepareModelRequest(context, { systemPrompt, tools }));
  retained.loadedSkills[0].metadata.revision = -1;
  retained.contextMemory[0].scope.workspace = "外部改写";
  assert.deepEqual(projection.prepareRequest({ systemPrompt: builtin(), tools }),
    prepareModelRequest(context, { systemPrompt: builtin(), tools }));
});

test("显式依赖 messages 的提示仍能读取独立完整历史", () => {
  const { projection, tools } = fixture();
  let captured;
  const systemPrompt = defineSystemPrompt(["messages"], (context) => {
    captured = context;
    return `共 ${context.messages.length} 条消息`;
  });
  const actual = projection.prepareRequest({ systemPrompt, tools });
  assert.ok(actual.systemPrompt.startsWith(`共 ${captured.messages.length} 条消息`));
  assert.equal(Object.hasOwn(captured, "plan"), false);
  captured.messages[0].content = "外部改写";
  assert.deepEqual(projection.prepareRequest({ systemPrompt, tools }), actual);
});

test("按需快照保留字段内别名、回调前记忆审计和回调后摘要语义", () => {
  const { projection, context, tools } = fixture();
  const shared = { content: "同一个对象" };
  const patch = { set: { memory: [shared, shared] } };
  projection.applyEvent({ patch }, context);
  context.memory = structuredClone(patch.set.memory);
  let captured;
  const systemPrompt = defineSystemPrompt(["memory", "contextMemory", "contextSummary"], (value) => {
    captured = value;
    assert.equal(value.memory[0], value.memory[1]);
    value.memory[0].content = "本次提示";
    value.contextMemory[0].id = "callback-pinned-id";
    value.contextSummary.revision = 99;
    return value.memory[1].content;
  });
  const actual = projection.prepareRequest({ systemPrompt, tools });
  const retained = captured;
  assert.equal(actual.contextPlan.pinnedMemoryHits[0].id, "pinned");
  assert.equal(actual.contextPlan.summary.revision, 99);
  assert.deepEqual(actual, prepareModelRequest(context, { systemPrompt, tools }));
  retained.contextSummary.completed.length = 0;
  actual.contextPlan.pinnedMemoryHits[0].scope.workspace = "外部改写";
  actual.messages[0].content = "外部改写";
  actual.tools[0].function.name = "外部改写";
  assert.deepEqual(projection.prepareRequest({ systemPrompt: builtin(), tools }),
    prepareModelRequest(context, { systemPrompt: builtin(), tools }));
});

test("自定义回调抛错、tools 修改与选项 getter 的调用顺序保持", () => {
  const { projection } = fixture();
  const sentinel = new Error("提示构建失败");
  for (const systemPrompt of [() => { throw sentinel; }, defineSystemPrompt([], () => { throw sentinel; })]) {
    let clones = 0;
    const tools = [{ get name() { clones += 1; return "不能提前读取"; } }];
    assert.throws(() => projection.prepareRequest({ systemPrompt, tools }), (error) => error === sentinel);
    assert.equal(clones, 0);
  }
  const order = [];
  const tools = [{ name: "before" }];
  const result = projection.prepareRequest({
    get systemPrompt() { order.push("systemPrompt"); return defineSystemPrompt([], () => {
      order.push("render"); tools[0].name = "after"; return "提示";
    }); },
    get tools() { order.push("tools"); return tools; },
    get maxInputTokens() { order.push("maxInputTokens"); return 32_000; },
  });
  assert.deepEqual(order, ["systemPrompt", "tools", "maxInputTokens", "render"]);
  assert.equal(result.tools[0].name, "after");
  assert.throws(() => projection.prepareRequest({ systemPrompt: () => { throw sentinel; }, maxInputTokens: 0 }), /正整数/);
});

test("Proxy、bind 和普通包装不会隐式继承字段声明或探测属性", () => {
  const { projection, tools } = fixture();
  const base = builtin();
  let proxyCalls = 0;
  const proxy = new Proxy(base, {
    get() { throw new Error("不能探测回调属性"); },
    apply(target, receiver, args) { proxyCalls += 1; assert.deepEqual(Object.keys(args[0]), modelKeys);
      return Reflect.apply(target, receiver, args); },
  });
  const wrapped = (context) => { assert.deepEqual(Object.keys(context), modelKeys); return base(context); };
  Object.defineProperty(wrapped, "contextFields", { get() { throw new Error("不能信任自报字段"); } });
  for (const systemPrompt of [proxy, base.bind(null), wrapped, appendAgentInstructions(proxy, "附加约束")]) {
    assert.equal(systemPromptFields(systemPrompt), null);
    const { snapshots } = promptClones(() => projection.prepareRequest({ systemPrompt, tools }));
    assert.deepEqual(snapshots, [modelKeys]);
  }
  assert.equal(proxyCalls, 2);
});

test("具名 Profile 保留空附加时的身份与自定义回调的全上下文契约", () => {
  const { projection, tools } = fixture();
  const base = builtin();
  assert.equal(appendAgentInstructions(base, "  "), base);
  assert.deepEqual(systemPromptFields(appendAgentInstructions(appendAgentInstructions(base, "第一层"), "第二层")),
    systemPromptFields(base));
  let calls = 0;
  const custom = (context) => { calls += 1; assert.deepEqual(Object.keys(context), modelKeys); return " 原始提示 "; };
  const prompt = appendAgentInstructions(appendAgentInstructions(custom, " 第一层 "), " 第二层 ");
  assert.equal(systemPromptFields(prompt), null);
  const result = projection.prepareRequest({ systemPrompt: prompt, tools });
  assert.equal(calls, 1);
  assert.ok(result.systemPrompt.startsWith("原始提示\n\n## Agent Profile instructions\n第一层\n\n## Agent Profile instructions\n第二层"));
});

test("非字符串静态值的转换仍在完整提示快照之后执行", () => {
  const { projection, context, tools } = fixture();
  for (const systemPrompt of [undefined, null, false, 7, new String("boxed")]) {
    const actual = promptClones(() => projection.prepareRequest({ systemPrompt, tools }));
    assert.deepEqual(actual.snapshots, [modelKeys]);
    assert.deepEqual(actual.result, prepareModelRequest(context, { systemPrompt, tools }));
  }
  let conversions = 0;
  const value = { toString() { conversions += 1; return "对象提示"; } };
  projection.prepareRequest({ systemPrompt: appendAgentInstructions(value, "额外要求"), tools });
  assert.equal(conversions, 1);
});

test("连续事件后每次提示读取最新状态，既有请求和捕获值不被追加改写", async () => {
  const session = new AgentSession({ state: createSession({ provider: "demo", workspace: "/tmp", createdAt: at }), reducer: reduceSession });
  const systemPrompt = appendAgentInstructions(builtin(), "继续到完成");
  await session.dispatch({ type: "USER_MESSAGE", content: "第一个任务", at });
  const first = session.prepareModelRequest({ systemPrompt, tools: [] });
  const retained = structuredClone(first);
  for (const action of [
    { type: "MEMORY_ADDED", content: "新事实" },
    { type: "PLAN_UPDATED", steps: [{ step: "新步骤", status: "in_progress" }] },
    { type: "SKILL_LOADED", skill: { name: "new-skill", content: "新的技能要求" } },
    { type: "ASSISTANT_MESSAGE", message: { role: "assistant", content: "阶段结果" } },
    { type: "USER_MESSAGE", content: "继续完成", objectiveMode: "continue" },
  ]) {
    await session.dispatch({ ...action, at });
    assert.deepEqual(session.prepareModelRequest({ systemPrompt, tools: [] }),
      prepareModelRequest(projectModelContext([], session.state), { systemPrompt, tools: [] }));
  }
  const latest = session.prepareModelRequest({ systemPrompt, tools: [] });
  assert.match(latest.systemPrompt, /新事实/);
  assert.match(latest.systemPrompt, /新步骤/);
  assert.notEqual(latest.contextPlan.contextHash, first.contextPlan.contextHash);
  assert.deepEqual(first, retained);
  session.close();
  assert.deepEqual(session.prepareModelRequest({ systemPrompt, tools: [] }), latest);
});

test("真实 SQLite 恢复后的内置提示、Profile 和请求哈希保持一致", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexus-prompt-context-"));
  const database = path.join(workspace, "sessions.db");
  let store = new SessionStore(database, { workspace });
  try {
    const session = new AgentSession({ state: createSession({ provider: "demo", workspace, createdAt: at }), reducer: reduceSession, journal: store });
    await session.dispatch({ type: "USER_MESSAGE", content: "离线核对恢复", at });
    await session.dispatch({ type: "MEMORY_ADDED", content: "已保存事实", at });
    const systemPrompt = appendAgentInstructions(builtin(), "Profile 要求");
    const before = session.prepareModelRequest({ systemPrompt, tools: [] });
    const id = session.id;
    store.close();
    store = new SessionStore(database, { workspace });
    const restored = new AgentSession({ state: store.load(id), reducer: reduceSession, journal: store });
    const after = promptClones(() => restored.prepareModelRequest({ systemPrompt, tools: [] }));
    assert.deepEqual(after.result, before);
    assert.deepEqual(after.snapshots, [modelKeys.filter((key) => key !== "messages")]);
  } finally { store.close(); rmSync(workspace, { recursive: true, force: true }); }
});

test("真实 Lifecycle 用按需提示生成主请求并记录相同的输入审计身份", async () => {
  const { state, tools } = promptContextFixture(2);
  const session = new AgentSession({ state, reducer: reduceSession });
  const systemPrompt = appendAgentInstructions(builtin(), "集成验证");
  let actual;
  const lifecycle = new ContextLifecycle({ session, systemPrompt, getTools: () => tools,
    provider: { complete: async () => { throw new Error("不能调用外部模型"); } }, maxInputTokens: 1_000_000,
    requestModel: async (request) => {
      actual = request;
      const expected = prepareModelRequest(projectModelContext([], session.state), { systemPrompt, tools, maxInputTokens: 1_000_000 });
      assert.equal(request.systemPrompt, expected.systemPrompt);
      assert.deepEqual(request.messages, expected.messages);
      assert.deepEqual(request.tools, expected.tools);
      return { text: "离线结果", toolCalls: [], usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, finishReason: "stop" };
    } });
  const turn = await lifecycle.startTurn({ query: "当前任务" });
  assert.equal((await turn.completeModelStep()).text, "离线结果");
  const audit = session.state.events.find((event) => event.type === "model.context_prepared");
  const expected = prepareModelRequest(projectModelContext([], session.state), { systemPrompt, tools, maxInputTokens: 1_000_000 });
  assert.equal(audit.contextHash, expected.contextPlan.contextHash);
  assert.ok(actual.signal instanceof AbortSignal);
});
