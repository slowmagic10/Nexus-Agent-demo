import assert from "node:assert/strict";
import test from "node:test";
import { createProjectPicker } from "../src/web/project-picker.js";

test("Project Picker 选择已有项目后才创建任务", async () => {
  const calls = [];
  const fixture = createFixture({
    createSession: async ({ projectId }) => {
      calls.push(projectId);
      return { id: "session-existing", projectId };
    },
  });

  const pending = fixture.picker.open();
  await settle();
  assert.equal(fixture.dialog.open, true);
  assert.equal(fixture.projectSelect.value, "project-default");
  assert.equal(calls.length, 0);

  fixture.projectSelect.value = "project-legacy";
  fixture.form.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.deepEqual(await pending, { id: "session-existing", projectId: "project-legacy" });
  assert.deepEqual(calls, ["project-legacy"]);
  assert.equal(fixture.dialog.open, false);
  fixture.picker.destroy();
});

test("Project Picker 可创建受管项目并立即在该目录新建任务", async () => {
  const catalog = defaultCatalog();
  const created = [];
  const sessions = [];
  const fixture = createFixture({
    loadProjects: async () => catalog,
    createProject: async ({ name }) => {
      const project = { id: "project-new", name, directory: name, managed: true };
      catalog.projects.push(project);
      created.push(name);
      return { project };
    },
    createSession: async ({ projectId }) => {
      sessions.push(projectId);
      return { id: "session-new", projectId };
    },
  });

  const pending = fixture.picker.open();
  await settle();
  fixture.createToggle.dispatchEvent(new Event("click"));
  fixture.nameInput.value = "模型实验";
  fixture.form.dispatchEvent(new Event("submit", { cancelable: true }));

  assert.deepEqual(await pending, { id: "session-new", projectId: "project-new" });
  assert.deepEqual(created, ["模型实验"]);
  assert.deepEqual(sessions, ["project-new"]);
  fixture.picker.destroy();
});

test("Project Picker 取消时不创建项目或 Session", async () => {
  let operations = 0;
  const fixture = createFixture({
    createProject: async () => { operations += 1; },
    createSession: async () => { operations += 1; },
  });
  const pending = fixture.picker.open();
  await settle();
  fixture.cancelButton.dispatchEvent(new Event("click", { cancelable: true }));
  assert.equal(await pending, null);
  assert.equal(operations, 0);
  fixture.picker.destroy();
});

test("Project Picker 加载期间取消后忽略迟到的项目列表", async () => {
  let release;
  const fixture = createFixture({
    loadProjects: () => new Promise((resolve) => { release = resolve; }),
  });
  const pending = fixture.picker.open();
  await settle(1);
  fixture.cancelButton.dispatchEvent(new Event("click", { cancelable: true }));
  assert.equal(await pending, null);

  release(defaultCatalog());
  await settle();
  assert.equal(fixture.projectSelect.children.length, 0);
  assert.equal(fixture.dialog.open, false);
  fixture.picker.destroy();
});

test("Project Picker 创建请求进行中不会把 Escape 伪装成成功取消", async () => {
  let finishSession;
  const fixture = createFixture({
    createSession: ({ projectId }) => new Promise((resolve) => {
      finishSession = () => resolve({ id: "session-delayed", projectId });
    }),
  });
  const pending = fixture.picker.open();
  await settle();
  fixture.form.dispatchEvent(new Event("submit", { cancelable: true }));
  await settle(1);

  const escape = new Event("cancel", { cancelable: true });
  fixture.dialog.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(fixture.picker.isOpen(), true);
  assert.equal(fixture.cancelButton.disabled, true);

  finishSession();
  assert.deepEqual(await pending, { id: "session-delayed", projectId: "project-default" });
  assert.equal(fixture.dialog.open, false);
  fixture.picker.destroy();
});

function createFixture({
  loadProjects = async () => defaultCatalog(),
  createProject = async () => ({ project: { id: "project-new", name: "New" } }),
  createSession = async ({ projectId }) => ({ id: "session", projectId }),
} = {}) {
  const dialog = fakeElement();
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const form = fakeElement();
  const projectSelect = fakeElement();
  const createToggle = fakeElement();
  const createFields = fakeElement();
  const nameInput = fakeElement();
  const cancelButton = fakeElement();
  const submitButton = fakeElement();
  const errorNode = fakeElement();
  const picker = createProjectPicker({
    dialog,
    form,
    projectSelect,
    createToggle,
    createFields,
    nameInput,
    cancelButton,
    submitButton,
    errorNode,
    loadProjects,
    createProject,
    createSession,
    createElement: () => fakeElement(),
  });
  return {
    picker,
    dialog,
    form,
    projectSelect,
    createToggle,
    createFields,
    nameInput,
    cancelButton,
    submitButton,
  };
}

function defaultCatalog() {
  return {
    defaultProjectId: "project-default",
    projects: [
      { id: "project-default", name: "默认工作区", directory: "Default", isDefault: true, managed: true },
      { id: "project-legacy", name: "Nexus Agent", directory: "Nexus Agent", legacy: true, managed: false },
    ],
  };
}

function fakeElement() {
  const element = new EventTarget();
  const classes = new Set();
  element.value = "";
  element.textContent = "";
  element.title = "";
  element.disabled = false;
  element.children = [];
  element.classList = {
    toggle(name, force) {
      if (force === undefined ? !classes.has(name) : force) classes.add(name);
      else classes.delete(name);
    },
    contains: (name) => classes.has(name),
  };
  element.replaceChildren = (...children) => { element.children = children; };
  element.focus = () => {};
  return element;
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
