import assert from "node:assert/strict";
import test from "node:test";
import { createTaskNavigation } from "../src/web/task-navigation.js";

test("Task Navigation 在移动端打开、关闭并同步可访问状态", () => {
  const sidebar = fakeElement();
  const toggle = fakeElement();
  const backdrop = fakeElement(["hidden"]);
  const root = new EventTarget();
  const media = fakeMedia(true);
  const navigation = createTaskNavigation({ sidebar, toggle, backdrop, root, media });

  assert.equal(sidebar.attributes.get("aria-hidden"), "true");
  toggle.dispatchEvent(new Event("click"));
  assert.equal(navigation.isOpen(), true);
  assert.equal(sidebar.classList.contains("mobile-open"), true);
  assert.equal(backdrop.classList.contains("hidden"), false);
  assert.equal(toggle.attributes.get("aria-expanded"), "true");

  const escape = new KeyboardEventForTest("keydown", { key: "Escape" });
  root.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(sidebar.classList.contains("mobile-open"), false);
  assert.equal(navigation.isOpen(), false);
  assert.equal(sidebar.attributes.get("aria-hidden"), "true");
  navigation.destroy();
});

test("Task Navigation 切换到桌面端时关闭抽屉并移除 aria-hidden", () => {
  const sidebar = fakeElement();
  const toggle = fakeElement();
  const backdrop = fakeElement(["hidden"]);
  const media = fakeMedia(true);
  const navigation = createTaskNavigation({ sidebar, toggle, backdrop, root: new EventTarget(), media });
  navigation.open();

  media.matches = false;
  media.dispatchEvent(new Event("change"));

  assert.equal(sidebar.classList.contains("mobile-open"), false);
  assert.equal(sidebar.attributes.has("aria-hidden"), false);
  assert.equal(backdrop.classList.contains("hidden"), true);
  navigation.destroy();
});

class KeyboardEventForTest extends Event {
  constructor(type, { key }) {
    super(type, { cancelable: true });
    this.key = key;
  }
}

function fakeElement(classes = []) {
  const element = new EventTarget();
  const values = new Set(classes);
  element.attributes = new Map();
  element.classList = {
    toggle(name, force) {
      if (force === undefined ? !values.has(name) : force) values.add(name);
      else values.delete(name);
    },
    contains: (name) => values.has(name),
  };
  element.setAttribute = (name, value) => element.attributes.set(name, value);
  element.removeAttribute = (name) => element.attributes.delete(name);
  return element;
}

function fakeMedia(matches) {
  const media = new EventTarget();
  media.matches = matches;
  return media;
}
