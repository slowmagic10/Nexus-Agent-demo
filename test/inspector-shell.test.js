import assert from "node:assert/strict";
import test from "node:test";
import { createInspectorShell } from "../src/web/inspector-shell.js";

test("Inspector Shell 初始化默认视图并同步可访问状态", () => {
  const fixture = createFixture();
  const shell = createInspectorShell(fixture.options);

  assert.equal(shell.isOpen(), false);
  assert.equal(fixture.root.classList.contains("active"), false);
  assert.equal(fixture.root.attributes.get("aria-hidden"), "true");
  assert.equal(fixture.root.attributes.has("role"), false);
  assert.equal(fixture.root.attributes.has("aria-modal"), false);
  assert.equal(fixture.root.inert, true);
  assert.equal(fixture.root.attributes.has("inert"), true);
  assert.equal(fixture.toggle.attributes.get("aria-expanded"), "false");
  assert.equal(fixture.toggle.attributes.get("aria-label"), "打开任务详情");
  assert.equal(fixture.backdrop.classList.contains("hidden"), true);
  assertSelected(fixture, "overview");

  shell.destroy();
});

test("Inspector Shell 打开指定视图、关闭并将焦点还给触发元素", () => {
  const fixture = createFixture();
  const selected = [];
  const beforeOpen = [];
  const shell = createInspectorShell({
    ...fixture.options,
    onViewSelected: (view) => selected.push(view),
    onBeforeOpen: (view) => beforeOpen.push(view),
  });
  fixture.document.activeElement = fixture.trigger;

  shell.open("context");

  assert.equal(shell.isOpen(), true);
  assert.equal(fixture.root.classList.contains("active"), true);
  assert.equal(fixture.root.attributes.get("aria-hidden"), "false");
  assert.equal(fixture.root.attributes.get("role"), "dialog");
  assert.equal(fixture.root.attributes.get("aria-modal"), "true");
  assert.equal(shell.isModalOpen(), true);
  assert.equal(fixture.root.inert, false);
  assert.equal(fixture.root.attributes.has("inert"), false);
  assert.equal(fixture.toggle.attributes.get("aria-expanded"), "true");
  assert.equal(fixture.toggle.attributes.get("aria-label"), "关闭任务详情");
  assert.equal(fixture.backdrop.classList.contains("hidden"), false);
  assert.deepEqual(beforeOpen, ["context"]);
  assert.deepEqual(selected, ["context"]);
  assertSelected(fixture, "context");
  assert.equal(fixture.tabs.context.focusCount, 1);
  assert.equal(fixture.document.activeElement, fixture.tabs.context);

  fixture.closeButton.dispatchEvent(new Event("click"));
  assert.equal(shell.isOpen(), false);
  assert.equal(fixture.trigger.focusCount, 1);
  assert.equal(fixture.document.activeElement, fixture.trigger);
  assert.equal(fixture.root.inert, true);
  shell.destroy();
});

test("Inspector Shell 将 Tab 焦点限制在模态详情内", () => {
  const fixture = createFixture();
  const shell = createInspectorShell(fixture.options);
  fixture.document.activeElement = fixture.trigger;
  shell.open("overview");

  const forward = new KeyboardEventForTest("keydown", { key: "Tab" });
  fixture.document.dispatchEvent(forward);
  assert.equal(forward.defaultPrevented, true);
  assert.equal(fixture.document.activeElement, fixture.closeButton);

  const backward = new KeyboardEventForTest("keydown", { key: "Tab", shiftKey: true });
  fixture.document.dispatchEvent(backward);
  assert.equal(backward.defaultPrevented, true);
  assert.equal(fixture.document.activeElement, fixture.tabs.overview);
  shell.destroy();
});

test("Inspector Shell 只在打开时响应 Escape，背景点击也可关闭", () => {
  const fixture = createFixture();
  const shell = createInspectorShell(fixture.options);
  fixture.document.activeElement = fixture.trigger;

  const closedEscape = new KeyboardEventForTest("keydown", { key: "Escape" });
  fixture.document.dispatchEvent(closedEscape);
  assert.equal(closedEscape.defaultPrevented, false);
  assert.equal(fixture.trigger.focusCount, 0);

  fixture.toggle.dispatchEvent(new Event("click"));
  const openEscape = new KeyboardEventForTest("keydown", { key: "Escape" });
  fixture.document.dispatchEvent(openEscape);
  assert.equal(openEscape.defaultPrevented, true);
  assert.equal(shell.isOpen(), false);
  assert.equal(fixture.trigger.focusCount, 1);

  fixture.toggle.dispatchEvent(new Event("click"));
  fixture.backdrop.dispatchEvent(new Event("click"));
  assert.equal(shell.isOpen(), false);
  shell.destroy();
});

test("Inspector Shell 对未知视图 fail-closed 且不执行打开回调", () => {
  const fixture = createFixture();
  let beforeOpenCount = 0;
  const shell = createInspectorShell({
    ...fixture.options,
    onBeforeOpen: () => { beforeOpenCount += 1; },
  });

  assert.throws(() => shell.open("raw"), /未知视图：raw/);
  assert.throws(() => shell.select("raw"), /未知视图：raw/);
  assert.equal(shell.isOpen(), false);
  assert.equal(beforeOpenCount, 0);
  assertSelected(fixture, "overview");
  shell.destroy();
});

test("Inspector Shell 标签点击切换视图，destroy 后移除全部监听", () => {
  const fixture = createFixture();
  const selected = [];
  const shell = createInspectorShell({
    ...fixture.options,
    onViewSelected: (view) => selected.push(view),
  });

  fixture.tabs.context.dispatchEvent(new Event("click"));
  assert.deepEqual(selected, ["context"]);
  assertSelected(fixture, "context");

  shell.destroy();
  fixture.tabs.overview.dispatchEvent(new Event("click"));
  fixture.toggle.dispatchEvent(new Event("click"));
  fixture.document.dispatchEvent(new KeyboardEventForTest("keydown", { key: "Escape" }));
  assert.deepEqual(selected, ["context"]);
  assertSelected(fixture, "context");
  assert.equal(shell.isOpen(), false);
});

test("Inspector Shell 标签支持方向键和首尾导航", () => {
  const fixture = createFixture();
  const shell = createInspectorShell(fixture.options);
  shell.open("overview");

  const right = new KeyboardEventForTest("keydown", { key: "ArrowRight" });
  fixture.tabs.overview.dispatchEvent(right);
  assert.equal(right.defaultPrevented, true);
  assertSelected(fixture, "context");
  assert.equal(fixture.document.activeElement, fixture.tabs.context);

  fixture.tabs.context.dispatchEvent(new KeyboardEventForTest("keydown", { key: "Home" }));
  assertSelected(fixture, "overview");
  fixture.tabs.overview.dispatchEvent(new KeyboardEventForTest("keydown", { key: "ArrowLeft" }));
  assertSelected(fixture, "context");
  shell.destroy();
});

test("Inspector Shell 桌面端常驻显示且不具有模态关闭行为", () => {
  const media = new FakeMediaQueryList(true);
  const fixture = createFixture({ media });
  const selected = [];
  const beforeOpen = [];
  const shell = createInspectorShell({
    ...fixture.options,
    onViewSelected: (view) => selected.push(view),
    onBeforeOpen: (view) => beforeOpen.push(view),
  });

  assert.equal(shell.isPersistent(), true);
  assert.equal(shell.isOpen(), true);
  assert.equal(fixture.root.classList.contains("active"), true);
  assert.equal(fixture.root.classList.contains("persistent"), true);
  assert.equal(fixture.root.attributes.has("aria-hidden"), false);
  assert.equal(fixture.root.attributes.has("role"), false);
  assert.equal(fixture.root.attributes.has("aria-modal"), false);
  assert.equal(shell.isModalOpen(), false);
  assert.equal(fixture.root.inert, false);
  assert.equal(fixture.root.attributes.has("inert"), false);
  assert.equal(fixture.backdrop.classList.contains("hidden"), true);
  assert.equal(fixture.toggle.attributes.has("aria-expanded"), false);
  assert.equal(fixture.toggle.attributes.get("aria-label"), "转到任务详情概览");
  assert.equal(fixture.closeButton.hidden, true);

  shell.select("context");
  fixture.closeButton.dispatchEvent(new Event("click"));
  fixture.backdrop.dispatchEvent(new Event("click"));
  const escape = new KeyboardEventForTest("keydown", { key: "Escape" });
  fixture.document.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false);
  assert.equal(shell.isOpen(), true);
  assertSelected(fixture, "context");

  const tab = new KeyboardEventForTest("keydown", { key: "Tab" });
  fixture.document.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, false);

  fixture.toggle.dispatchEvent(new Event("click"));
  assert.deepEqual(beforeOpen, ["overview"]);
  assert.deepEqual(selected, ["context", "overview"]);
  assertSelected(fixture, "overview");
  assert.equal(fixture.tabs.overview.focusCount, 1);
  assert.equal(shell.isOpen(), true);
  shell.destroy();
});

test("Inspector Shell 在桌面与移动展示方式之间同步并在销毁后解除媒体监听", () => {
  const media = new FakeMediaQueryList(false);
  const fixture = createFixture({ media });
  const shell = createInspectorShell(fixture.options);

  shell.open("context");
  assert.equal(shell.isOpen(), true);
  assert.equal(shell.isPersistent(), false);
  assert.equal(fixture.backdrop.classList.contains("hidden"), false);

  media.setMatches(true);
  assert.equal(shell.isPersistent(), true);
  assert.equal(shell.isOpen(), true);
  assert.equal(fixture.root.classList.contains("persistent"), true);
  assert.equal(fixture.backdrop.classList.contains("hidden"), true);
  assert.equal(fixture.closeButton.hidden, true);

  media.setMatches(false);
  assert.equal(shell.isPersistent(), false);
  assert.equal(shell.isOpen(), false);
  assert.equal(fixture.root.classList.contains("active"), false);
  assert.equal(fixture.root.classList.contains("persistent"), false);
  assert.equal(fixture.root.attributes.get("aria-hidden"), "true");
  assert.equal(fixture.root.attributes.has("role"), false);
  assert.equal(fixture.root.attributes.has("aria-modal"), false);
  assert.equal(fixture.root.inert, true);
  assert.equal(fixture.closeButton.hidden, false);
  assert.equal(fixture.toggle.attributes.get("aria-expanded"), "false");
  assert.equal(fixture.toggle.attributes.get("aria-label"), "打开任务详情");

  shell.destroy();
  media.setMatches(true);
  assert.equal(shell.isPersistent(), false);
  assert.equal(shell.isOpen(), false);
});

test("Inspector Shell 从常驻栏缩为抽屉时不会把焦点留在 inert 内容中", () => {
  const media = new FakeMediaQueryList(true);
  const fixture = createFixture({ media });
  const shell = createInspectorShell(fixture.options);
  fixture.tabs.context.focus();

  media.setMatches(false);

  assert.equal(shell.isOpen(), false);
  assert.equal(shell.isModalOpen(), false);
  assert.equal(fixture.root.inert, true);
  assert.equal(fixture.toggle.focusCount, 1);
  assert.equal(fixture.document.activeElement, fixture.toggle);
  shell.destroy();
});

test("Inspector Shell 校验标签与内容视图必须一一对应", () => {
  const fixture = createFixture();
  assert.throws(() => createInspectorShell({
    ...fixture.options,
    views: { overview: fixture.views.overview },
  }), /缺少 context 内容视图/);
});

function createFixture({ media } = {}) {
  const document = new FakeDocument();
  const root = fakeElement({ ownerDocument: document });
  const toggle = fakeElement({ ownerDocument: document });
  const backdrop = fakeElement({ ownerDocument: document });
  const closeButton = fakeElement({ ownerDocument: document });
  const trigger = fakeElement({ ownerDocument: document });
  const tabs = {
    overview: fakeElement({ ownerDocument: document }),
    context: fakeElement({ ownerDocument: document }),
  };
  const views = {
    overview: fakeElement({ ownerDocument: document }),
    context: fakeElement({ ownerDocument: document }),
  };
  root.querySelectorAll = () => [closeButton, tabs.overview, tabs.context];
  root.contains = (element) => [closeButton, ...Object.values(tabs), ...Object.values(views)].includes(element);
  return {
    document,
    root,
    toggle,
    backdrop,
    closeButton,
    trigger,
    tabs,
    views,
    options: { root, toggle, backdrop, closeButton, tabs, views, ...(media ? { media } : {}) },
  };
}

function assertSelected(fixture, selectedName) {
  for (const [name, tab] of Object.entries(fixture.tabs)) {
    const selected = name === selectedName;
    assert.equal(tab.classList.contains("active"), selected);
    assert.equal(tab.attributes.get("aria-selected"), String(selected));
    assert.equal(tab.attributes.get("tabindex"), selected ? "0" : "-1");
  }
  for (const [name, view] of Object.entries(fixture.views)) {
    const selected = name === selectedName;
    assert.equal(view.classList.contains("active"), selected);
    assert.equal(view.classList.contains("hidden"), !selected);
  }
}

class FakeDocument extends EventTarget {
  activeElement = null;
}

class FakeMediaQueryList extends EventTarget {
  constructor(matches) {
    super();
    this.matches = matches;
  }

  setMatches(matches) {
    this.matches = matches;
    const event = new Event("change");
    Object.defineProperty(event, "matches", { value: matches });
    this.dispatchEvent(event);
  }
}

class KeyboardEventForTest extends Event {
  constructor(type, { key, shiftKey = false }) {
    super(type, { cancelable: true });
    this.key = key;
    this.shiftKey = shiftKey;
  }
}

function fakeElement({ ownerDocument, classes = [] } = {}) {
  const element = new EventTarget();
  const values = new Set(classes);
  element.ownerDocument = ownerDocument;
  element.attributes = new Map();
  element.focusCount = 0;
  element.classList = {
    toggle(name, force) {
      if (force === undefined ? !values.has(name) : force) values.add(name);
      else values.delete(name);
    },
    contains: (name) => values.has(name),
  };
  element.setAttribute = (name, value) => element.attributes.set(name, value);
  element.removeAttribute = (name) => element.attributes.delete(name);
  element.getAttribute = (name) => element.attributes.get(name) ?? null;
  element.closest = () => null;
  element.focus = () => {
    element.focusCount += 1;
    if (ownerDocument) ownerDocument.activeElement = element;
  };
  return element;
}
