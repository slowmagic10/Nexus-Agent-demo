import assert from "node:assert/strict";
import test from "node:test";
import { createTaskDeletion } from "../src/web/task-deletion.js";

test("删除确认展示捕获的名称，取消和 Escape 都不发请求", async () => {
  const fixture = createFixture();
  const first = fixture.deletion.open({ id: "a", title: "<重要任务>", phase: "thinking" });
  assert.equal(fixture.titleNode.textContent, "<重要任务>");
  assert.equal(fixture.runningNode.hidden, false);
  assert.equal(fixture.cancelButton.focused, true);
  fixture.cancelButton.dispatchEvent(new Event("click"));
  assert.equal(await first, null);
  const next = fixture.deletion.open({ id: "b", phase: "completed" });
  assert.equal(fixture.runningNode.hidden, true);
  const escape = new Event("cancel", { cancelable: true });
  fixture.dialog.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(await next, null);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.deleted, []);
  fixture.deletion.destroy();
});

test("删除请求只使用已确认 ID，重复提交、迟到切换和 Escape 不产生第二次删除", async () => {
  let resolve;
  const fixture = createFixture({ deleteSession: () => new Promise((done) => { resolve = done; }) });
  const original = { id: "a", title: "旧任务" };
  const pending = fixture.deletion.open(original);
  original.id = "b";
  assert.equal(fixture.deletion.open({ id: "b" }), pending);
  fixture.submit();
  fixture.submit();
  fixture.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  assert.equal(fixture.deletion.isOpen(), true);
  assert.equal(fixture.cancelButton.disabled, true);
  assert.equal(fixture.submitButton.disabled, true);
  assert.deepEqual(fixture.calls, [{ sessionId: "a" }]);
  resolve({ deleted: true, deletedSessionIds: ["a", "child", "child"] });
  assert.deepEqual((await pending).deletedSessionIds, ["a", "child"]);
  assert.equal(fixture.dialog.open, false);
  assert.equal(fixture.deleted[0].sessionId, "a");
  fixture.deletion.destroy();
});

test("删除失败保留目标与明确错误，重试仍删除原任务", async () => {
  let tries = 0;
  const fixture = createFixture({ deleteSession: async () => {
    if (++tries === 1) throw Object.assign(new Error("父任务仍在等待此子任务"), { status: 409 });
    return { deleted: true, deletedSessionIds: ["a"] };
  } });
  const pending = fixture.deletion.open({ id: "a" });
  fixture.submit();
  await settle();
  assert.equal(fixture.deletion.isOpen(), true);
  assert.equal(fixture.errorNode.textContent, "父任务仍在等待此子任务");
  assert.equal(fixture.submitButton.disabled, false);
  assert.deepEqual(fixture.deleted, []);
  fixture.submit();
  assert.equal((await pending).sessionId, "a");
  assert.deepEqual(fixture.calls, [{ sessionId: "a" }, { sessionId: "a" }]);
  fixture.deletion.destroy();
});

test("404 清理已不存在的任务，销毁后忽略迟到的删除响应", async () => {
  const fixture = createFixture({ deleteSession: async () => { throw Object.assign(new Error("不存在"), { status: 404 }); } });
  const pending = fixture.deletion.open({ id: "a" });
  fixture.submit();
  assert.equal((await pending).alreadyDeleted, true);
  assert.deepEqual(fixture.deleted[0].deletedSessionIds, ["a"]);
  fixture.deletion.destroy();

  let resolve;
  const late = createFixture({ deleteSession: () => new Promise((done) => { resolve = done; }) });
  const latePending = late.deletion.open({ id: "b" });
  late.submit();
  late.deletion.destroy();
  assert.equal(await latePending, null);
  resolve({ deleted: true, deletedSessionIds: ["b"] });
  await settle();
  assert.deepEqual(late.deleted, []);
});

function createFixture({ deleteSession = async ({ sessionId }) => ({ deleted: true, deletedSessionIds: [sessionId] }) } = {}) {
  const nodes = Object.fromEntries(["dialog", "form", "titleNode", "runningNode", "errorNode", "cancelButton", "submitButton"].map((name) => [name, fakeElement()]));
  nodes.dialog.showModal = () => { nodes.dialog.open = true; };
  nodes.dialog.close = () => { nodes.dialog.open = false; };
  const calls = [];
  const deleted = [];
  const deletion = createTaskDeletion({
    ...nodes,
    deleteSession: (target) => { calls.push(target); return deleteSession(target); },
    onDeleted: (result) => deleted.push(result),
  });
  return { ...nodes, calls, deleted, deletion, submit: () => nodes.form.dispatchEvent(new Event("submit", { cancelable: true })) };
}

function fakeElement() {
  const element = new EventTarget();
  element.textContent = "";
  element.focus = () => { element.focused = true; };
  element.setAttribute = () => {};
  return element;
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}
