import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSession } from "../src/core/state.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { ProjectCatalog } from "../src/projects/catalog.js";
import { GatewayProjectCoordinator } from "../src/projects/gateway-coordinator.js";

test("Project Coordinator 延迟加载运行时并把 Session 路由回固定 Workspace", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-coordinator-"));
  const root = path.join(fixture, "projects");
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  const second = await catalog.create({ name: "第二项目" });
  const activations = [];
  const coordinator = new GatewayProjectCoordinator({
    catalog,
    createProjectManager: (project) => createManagerBundle(project, activations),
  });
  t.after(async () => {
    await coordinator.close();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  const projects = await coordinator.listProjects();
  assert.equal(projects.projects.length, 2);
  assert.equal(activations.length, 0);
  assert.deepEqual(await coordinator.list(), []);
  assert.equal(activations.length, 0);

  const defaultSession = await coordinator.create();
  const secondSession = await coordinator.create({ projectId: second.id });
  assert.equal(activations.length, 2);
  assert.equal(defaultSession.project.isDefault, true);
  assert.equal(secondSession.project.id, second.id);
  assert.equal(defaultSession.workspace, await fs.realpath(path.join(root, "Default")));
  assert.equal(secondSession.workspace, second.workspace);

  const summaries = await coordinator.list();
  assert.deepEqual(new Set(summaries.map((session) => session.project.id)), new Set([
    defaultSession.project.id,
    second.id,
  ]));
  assert.equal((await coordinator.view(secondSession.id)).state.workspace, second.workspace);
});

test("Project Coordinator 重启后可只读列出全部项目会话，打开时才激活所属运行时", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-restart-"));
  const root = path.join(fixture, "projects");
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  const second = await catalog.create({ name: "恢复项目" });
  const firstActivations = [];
  const first = new GatewayProjectCoordinator({
    catalog,
    createProjectManager: (project) => createManagerBundle(project, firstActivations),
  });
  const original = await first.create({ projectId: second.id });
  await first.close();

  const activations = [];
  const restarted = new GatewayProjectCoordinator({
    catalog,
    createProjectManager: (project) => createManagerBundle(project, activations),
  });
  t.after(async () => {
    await restarted.close();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  const summaries = await restarted.list();
  assert.equal(summaries.some((session) => session.id === original.id), true);
  assert.equal(activations.length, 0);

  const view = await restarted.view(original.id);
  assert.equal(view.state.id, original.id);
  assert.equal(view.state.project.id, second.id);
  assert.deepEqual(activations, [second.id]);
});

test("Project Coordinator 在关闭时等待并回收尚未完成的 Project Runtime", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-close-race-"));
  const root = path.join(fixture, "projects");
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let managerClosed = 0;
  let bundleClosed = 0;
  const coordinator = new GatewayProjectCoordinator({
    catalog,
    createProjectManager: async () => {
      await gate;
      return {
        manager: {
          close: async () => { managerClosed += 1; },
          create: async () => ({ id: "late-session" }),
        },
        close: async () => { bundleClosed += 1; },
      };
    },
  });

  const creation = coordinator.create();
  const closing = coordinator.close();
  release();
  await assert.rejects(creation, (error) => error.status === 503);
  await closing;
  assert.equal(managerClosed, 1);
  assert.equal(bundleClosed, 1);
  await fs.rm(fixture, { recursive: true, force: true });
});

test("Project Coordinator 先等待运行中 Session 收束，再关闭底层 Store", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-close-order-"));
  const root = path.join(fixture, "projects");
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  let releaseRun;
  const runSettled = new Promise((resolve) => { releaseRun = resolve; });
  let managerSettled = false;
  let storeClosed = false;
  const coordinator = new GatewayProjectCoordinator({
    catalog,
    createProjectManager: async () => ({
      manager: {
        runtimeInfo: async () => ({}),
        close: async () => {
          await runSettled;
          managerSettled = true;
        },
      },
      close: async () => {
        assert.equal(managerSettled, true);
        storeClosed = true;
      },
    }),
  });
  await coordinator.runtimeInfo();
  const closing = coordinator.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storeClosed, false);
  releaseRun();
  await closing;
  assert.equal(storeClosed, true);
  await fs.rm(fixture, { recursive: true, force: true });
});

test("Project Coordinator 对跨项目重复 Session ID fail closed", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-id-conflict-"));
  const root = path.join(fixture, "projects");
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  const second = await catalog.create({ name: "Second" });
  for (const project of await catalog.list()) {
    if (![catalog.defaultProjectId, second.id].includes(project.id)) continue;
    const store = new SessionStore(path.join(project.workspace, ".nexus", "nexus.db"), { workspace: project.workspace });
    const state = createSession({
      id: "same-session-id",
      provider: "test",
      workspace: project.workspace,
    });
    store.ensureJournal(state);
    assert.equal(state.id, "same-session-id");
    store.close();
  }
  const coordinator = new GatewayProjectCoordinator({
    catalog,
    createProjectManager: (project) => createManagerBundle(project, []),
  });
  t.after(async () => {
    await coordinator.close();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  const targeted = await coordinator.list(second.id);
  assert.equal(targeted.some((session) => session.id === "same-session-id"), true);
  await assert.rejects(coordinator.get("same-session-id"), (error) => error.status === 409);
  await assert.rejects(
    coordinator.create({ projectId: second.id, resume: "same-session-id" }),
    (error) => error.status === 409,
  );
  await assert.rejects(
    coordinator.create({ projectId: second.id, resume: "latest" }),
    (error) => error.status === 409,
  );
  await assert.rejects(coordinator.list(), (error) => error.status === 409);
  await assert.rejects(coordinator.get("same-session-id"), (error) => error.status === 409);
});

test("Project Coordinator 离线列表不会跟随项目内 .nexus 符号链接", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-list-link-"));
  const root = path.join(fixture, "projects");
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  const unsafe = await catalog.create({ name: "Unsafe" });
  const outside = path.join(fixture, "outside-state");
  await fs.mkdir(outside);
  const outsideStore = new SessionStore(path.join(outside, "nexus.db"), { workspace: unsafe.workspace });
  outsideStore.ensureJournal(createSession({ id: "external-session", provider: "test", workspace: unsafe.workspace }));
  outsideStore.close();
  await fs.symlink(outside, path.join(unsafe.workspace, ".nexus"));
  let activations = 0;
  const coordinator = new GatewayProjectCoordinator({
    catalog,
    createProjectManager: (project) => {
      activations += 1;
      return createManagerBundle(project, []);
    },
  });
  t.after(async () => {
    await coordinator.close();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  await assert.rejects(coordinator.list(), /\.nexus 必须是真实目录/);
  assert.equal(activations, 0);
});

test("Project Coordinator 对已激活项目保持与离线列表一致的 100 条窗口", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-list-limit-"));
  const root = path.join(fixture, "projects");
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  let observedLimit = null;
  const coordinator = new GatewayProjectCoordinator({
    catalog,
    createProjectManager: async () => ({
      manager: {
        create: async () => ({ id: "activation-session" }),
        list: async (limit) => {
          observedLimit = limit;
          return [];
        },
        close: async () => {},
      },
      close: async () => {},
    }),
  });
  t.after(async () => {
    await coordinator.close();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  await coordinator.create();
  await coordinator.list();
  assert.equal(observedLimit, 100);
});

function createManagerBundle(project, activations) {
  activations.push(project.id);
  const store = new SessionStore(path.join(project.workspace, ".nexus", "nexus.db"), {
    workspace: project.workspace,
  });
  const manager = new GatewaySessionManager({
    workspace: project.workspace,
    provider: {
      name: `provider-${project.id.slice(0, 8)}`,
      complete: async () => ({ text: "完成", toolCalls: [] }),
    },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  return {
    manager,
    close: () => store.close(),
  };
}
