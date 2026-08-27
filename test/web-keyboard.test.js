import assert from "node:assert/strict";
import test from "node:test";
import {
  composerActionState,
  shouldCancelRun,
  shouldSubmitMessage,
} from "../src/web/keyboard.js";

test("消息输入框只在非组合输入的普通 Enter 时提交", () => {
  assert.equal(shouldSubmitMessage({ key: "Enter" }), true);
  assert.equal(shouldSubmitMessage({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitMessage({ key: "a" }), false);
  assert.equal(shouldSubmitMessage({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSubmitMessage({ key: "Enter", keyCode: 229 }), false);
  assert.equal(shouldSubmitMessage({ key: "Enter", which: 229 }), false);
  assert.equal(shouldSubmitMessage({ key: "Enter" }, { composing: true }), false);
});

test("运行中 Composer 切换为可用的停止控制并支持 Esc", () => {
  assert.deepEqual(composerActionState("thinking"), {
    busy: true,
    mode: "stop",
    disabled: false,
    label: "停止任务",
    shortcut: "Esc 停止",
    symbol: "■",
  });
  assert.deepEqual(composerActionState("executing", { cancelling: true }), {
    busy: true,
    mode: "stop",
    disabled: true,
    label: "正在停止任务",
    shortcut: "正在停止…",
    symbol: "■",
  });
  assert.equal(composerActionState("completed").mode, "send");
  assert.equal(shouldCancelRun({ key: "Escape" }, { phase: "awaiting_approval" }), true);
  assert.equal(shouldCancelRun({ key: "Escape", repeat: true }, { phase: "thinking" }), false);
  assert.equal(shouldCancelRun({ key: "Escape" }, { phase: "completed" }), false);
  assert.equal(shouldCancelRun({ key: "Escape" }, { phase: "thinking", overlayOpen: true }), false);
});
