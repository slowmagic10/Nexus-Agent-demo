import assert from "node:assert/strict";
import test from "node:test";
import { createComposer } from "../src/web/composer.js";

test("Composer 在中文组合输入期间不会误提交，普通 Enter 才发送", async () => {
  const calls = [];
  const fixture = createFixture({
    sendMessage: async (request) => calls.push(request),
  });
  fixture.composer.update({ sessionId: "session-a", phase: "idle", provider: "DeepSeek" });
  fixture.input.value = "继续开发";

  fixture.input.dispatchEvent(new Event("compositionstart"));
  fixture.input.dispatchEvent(keyEvent("Enter"));
  fixture.input.dispatchEvent(new Event("compositionend"));
  fixture.input.dispatchEvent(keyEvent("Enter", { isComposing: true }));
  fixture.input.dispatchEvent(keyEvent("Enter", { keyCode: 229 }));
  fixture.input.dispatchEvent(keyEvent("Enter", { which: 229 }));
  fixture.input.dispatchEvent(keyEvent("Enter", { shiftKey: true }));
  assert.equal(calls.length, 0);

  const enter = keyEvent("Enter");
  fixture.input.dispatchEvent(enter);
  await settle();
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(calls, [{ sessionId: "session-a", content: "继续开发" }]);
  assert.equal(fixture.input.value, "");
  fixture.composer.destroy();
});

test("Composer 统一呈现 Session、Provider 与发送/停止状态", async () => {
  const cancellation = deferred();
  const fixture = createFixture({ cancelRun: () => cancellation.promise });

  assert.equal(fixture.input.disabled, true);
  assert.equal(fixture.action.disabled, true);
  fixture.composer.update({ sessionId: "session-a", phase: "idle", provider: "deepseek-v4-flash" });
  assert.equal(fixture.provider.textContent, "deepseek-v4-flash");
  assert.equal(fixture.input.disabled, false);
  assert.equal(fixture.action.textContent, "↑");
  assert.equal(fixture.action.getAttribute("aria-label"), "发送消息");
  assert.equal(fixture.shortcut.textContent, "Enter 发送");

  fixture.composer.update({ sessionId: "session-a", phase: "thinking", provider: "deepseek-v4-flash" });
  assert.equal(fixture.input.disabled, true);
  assert.equal(fixture.action.disabled, false);
  assert.equal(fixture.action.textContent, "■");
  assert.equal(fixture.action.classList.contains("stop-button"), true);
  fixture.action.dispatchEvent(new Event("click"));
  assert.equal(fixture.action.disabled, true);
  assert.equal(fixture.action.getAttribute("aria-label"), "正在停止任务");
  assert.equal(fixture.shortcut.textContent, "正在停止…");

  fixture.composer.update({ sessionId: "session-a", phase: "cancelled", provider: "deepseek-v4-flash" });
  assert.equal(fixture.input.disabled, false);
  assert.equal(fixture.action.disabled, false);
  assert.equal(fixture.action.textContent, "↑");
  cancellation.resolve();
  await settle();
  fixture.composer.destroy();
});

test("发送失败只恢复当前 Session 草稿，迟到结果不污染已切换会话", async () => {
  const sends = new Map();
  const fixture = createFixture({
    sendMessage: ({ sessionId }) => {
      const request = deferred();
      sends.set(sessionId, request);
      return request.promise;
    },
  });

  fixture.composer.update({ sessionId: "session-a", phase: "idle", provider: "A" });
  fixture.input.value = "A 的任务";
  fixture.form.requestSubmit();
  assert.equal(fixture.input.value, "");
  assert.equal(fixture.input.disabled, true);

  fixture.composer.update({ sessionId: "session-b", phase: "idle", provider: "B" });
  fixture.input.value = "B 的任务";
  sends.get("session-a").reject(new Error("A failed"));
  await settle();
  assert.equal(fixture.input.value, "B 的任务");
  assert.equal(fixture.input.disabled, false);

  fixture.form.requestSubmit();
  assert.equal(fixture.input.value, "");
  sends.get("session-b").reject(new Error("B failed"));
  await settle();
  assert.equal(fixture.input.value, "B 的任务");
  assert.equal(fixture.input.disabled, false);
  fixture.composer.destroy();
});

test("发送成功后等待 durable phase 推进再解除 Session-scoped lock", async () => {
  let sends = 0;
  const fixture = createFixture({
    sendMessage: async () => { sends += 1; },
  });
  fixture.composer.update({ sessionId: "session-a", phase: "idle", provider: "A" });
  fixture.input.value = "只发送一次";
  fixture.form.requestSubmit();
  await settle();
  assert.equal(sends, 1);
  assert.equal(fixture.input.disabled, true);
  assert.equal(fixture.action.disabled, true);
  assert.equal(fixture.shortcut.textContent, "正在发送…");

  fixture.form.requestSubmit();
  await settle();
  assert.equal(sends, 1);
  fixture.composer.update({ sessionId: "session-a", phase: "thinking", provider: "A" });
  assert.equal(fixture.action.textContent, "■");
  assert.equal(fixture.action.disabled, false);
  fixture.composer.update({ sessionId: "session-a", phase: "completed", provider: "A" });
  assert.equal(fixture.input.disabled, false);
  assert.equal(fixture.action.disabled, false);
  fixture.composer.destroy();
});

test("同 phase 完成的新 User Turn 也会解除跨 Session pending send", async () => {
  const fixture = createFixture({ sendMessage: async () => {} });
  fixture.composer.update({
    sessionId: "session-a",
    phase: "completed",
    provider: "A",
    userTurnCount: 1,
  });
  fixture.input.value = "A 的第二轮";
  fixture.form.requestSubmit();
  await settle();
  assert.equal(fixture.input.disabled, true);

  fixture.composer.update({
    sessionId: "session-b",
    phase: "completed",
    provider: "B",
    userTurnCount: 4,
  });
  fixture.composer.update({
    sessionId: "session-a",
    phase: "completed",
    provider: "A",
    userTurnCount: 2,
  });

  assert.equal(fixture.input.disabled, false);
  assert.equal(fixture.action.disabled, false);
  assert.equal(fixture.shortcut.textContent, "Enter 发送");
  fixture.composer.destroy();
});

test("取消状态按 Session 隔离，Escape 遵守 Overlay 并在失败后恢复", async () => {
  const cancellations = new Map();
  let overlayOpen = false;
  const fixture = createFixture({
    cancelRun: ({ sessionId }) => {
      const request = deferred();
      cancellations.set(sessionId, request);
      return request.promise;
    },
    isOverlayOpen: () => overlayOpen,
  });

  fixture.composer.update({ sessionId: "session-a", phase: "executing", provider: "A" });
  fixture.action.dispatchEvent(new Event("click"));
  assert.ok(cancellations.has("session-a"));
  assert.equal(fixture.action.disabled, true);

  fixture.composer.update({ sessionId: "session-b", phase: "thinking", provider: "B" });
  assert.equal(fixture.action.disabled, false);
  overlayOpen = true;
  const blockedEscape = keyEvent("Escape");
  fixture.eventRoot.dispatchEvent(blockedEscape);
  assert.equal(blockedEscape.defaultPrevented, false);
  assert.equal(cancellations.has("session-b"), false);

  overlayOpen = false;
  const consumedEscape = keyEvent("Escape");
  consumedEscape.preventDefault();
  fixture.eventRoot.dispatchEvent(consumedEscape);
  assert.equal(cancellations.has("session-b"), false);

  const escape = keyEvent("Escape");
  fixture.eventRoot.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.ok(cancellations.has("session-b"));
  assert.equal(fixture.action.disabled, true);

  cancellations.get("session-a").reject(new Error("A cancel failed"));
  await settle();
  assert.equal(fixture.action.disabled, true);
  cancellations.get("session-b").reject(new Error("B cancel failed"));
  await settle();
  assert.equal(fixture.action.disabled, false);
  assert.equal(fixture.action.getAttribute("aria-label"), "停止任务");
  fixture.composer.destroy();
});

test("旧运行的取消失败不会解除同 Session 新运行的停止锁", async () => {
  const cancellations = [];
  const fixture = createFixture({
    cancelRun: () => {
      const request = deferred();
      cancellations.push(request);
      return request.promise;
    },
  });

  fixture.composer.update({ sessionId: "session-a", phase: "thinking" });
  fixture.action.dispatchEvent(new Event("click"));
  fixture.composer.update({ sessionId: "session-a", phase: "cancelled" });
  fixture.composer.update({ sessionId: "session-a", phase: "thinking" });
  fixture.action.dispatchEvent(new Event("click"));
  assert.equal(cancellations.length, 2);
  assert.equal(fixture.action.disabled, true);

  cancellations[0].reject(new Error("old cancel failed"));
  await settle();
  assert.equal(fixture.action.disabled, true);
  assert.equal(fixture.action.getAttribute("aria-label"), "正在停止任务");

  cancellations[1].reject(new Error("current cancel failed"));
  await settle();
  assert.equal(fixture.action.disabled, false);
  fixture.composer.destroy();
});

test("setDraft/focus 与 destroy 构成完整且可释放的 Composer Interface", async () => {
  let sendCount = 0;
  let cancelCount = 0;
  const fixture = createFixture({
    sendMessage: async () => { sendCount += 1; },
    cancelRun: async () => { cancelCount += 1; },
  });
  fixture.composer.update({ sessionId: "session-a", phase: "idle" });
  fixture.composer.setDraft("从建议开始", { focus: true });
  assert.equal(fixture.input.value, "从建议开始");
  assert.equal(fixture.input.focusCount, 1);

  fixture.composer.destroy();
  fixture.input.dispatchEvent(keyEvent("Enter"));
  fixture.action.dispatchEvent(new Event("click"));
  fixture.eventRoot.dispatchEvent(keyEvent("Escape"));
  await settle();
  assert.equal(sendCount, 0);
  assert.equal(cancelCount, 0);
});

function createFixture({
  sendMessage = async () => {},
  cancelRun = async () => {},
  isOverlayOpen = () => false,
} = {}) {
  const form = fakeElement();
  const input = fakeElement();
  const action = fakeElement();
  const shortcut = fakeElement();
  const provider = fakeElement();
  const eventRoot = new EventTarget();
  form.requestSubmit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  const composer = createComposer({
    form,
    input,
    action,
    shortcut,
    provider,
    eventRoot,
    sendMessage,
    cancelRun,
    isOverlayOpen,
  });
  return { composer, form, input, action, shortcut, provider, eventRoot };
}

function fakeElement() {
  const element = new EventTarget();
  const classes = new Set();
  const attributes = new Map();
  element.value = "";
  element.textContent = "";
  element.disabled = false;
  element.title = "";
  element.focusCount = 0;
  element.classList = {
    toggle(name, force) {
      if (force === undefined ? !classes.has(name) : force) classes.add(name);
      else classes.delete(name);
    },
    contains: (name) => classes.has(name),
  };
  element.setAttribute = (name, value) => attributes.set(name, String(value));
  element.getAttribute = (name) => attributes.get(name) ?? null;
  element.focus = () => { element.focusCount += 1; };
  return element;
}

function keyEvent(key, options = {}) {
  const event = new Event("keydown", { cancelable: true });
  event.key = key;
  event.shiftKey = options.shiftKey === true;
  event.isComposing = options.isComposing === true;
  event.keyCode = options.keyCode;
  event.which = options.which;
  event.repeat = options.repeat === true;
  return event;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
