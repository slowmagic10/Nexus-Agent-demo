import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createDelegatedSession } from "../src/core/state.js";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { routeGatewayRequest } from "../src/gateway/server.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { ProjectCatalog } from "../src/projects/catalog.js";
import { GatewayProjectCoordinator } from "../src/projects/gateway-coordinator.js";
import { createProjectGrant } from "../src/tools/authorization.js";
import { ProjectGrantStore } from "../src/tools/project-grant-store.js";

test("删除空闲任务清除持久状态及委派 Child，保留独立分支、源码、长期记忆和项目授权", async (t) => {
  const fixture = await createFixture(t);
  const { manager, store, workspace } = fixture;
  const state = await manager.create();
  const staleEntry = manager.sessions.get(state.id);
  await staleEntry.session.dispatch({ type: "USER_MESSAGE", content: "完成项目" });
  const child = createDelegatedSession(staleEntry.state, {
    id: "owned-child", delegationId: "old-delegation", parentCursor: staleEntry.session.cursor,
  });
  store.ensureJournal(child);
  const branch = await manager.branch(state.id);
  const artifact = await store.artifacts.put({ sessionId: state.id, content: "日志正文" });
  await store.artifacts.put({ sessionId: child.id, content: "子任务日志" });
  const memory = await store.addMemory("保留项目约定", { sourceSession: state.id, sourceCursor: staleEntry.session.cursor, origin: "user_explicit" });
  await fs.writeFile(path.join(workspace, "app.js"), "保留源码\n");
  const grantStore = new ProjectGrantStore(path.join(workspace, ".nexus", "grants.db"));
  t.after(() => grantStore.close());
  const grant = createProjectGrant({
    workspace, tool: "write_file", capabilityHash: "cap", policyVersion: "policy",
    resources: [{ kind: "workspace_path", value: "app.js", access: "write" }],
  });
  grantStore.issue(grant);
  manager.projectGrantStore = grantStore;
  const archive = await manager.exportSession(state.id);
  const events = [];
  const stop = await manager.subscribeEvents(state.id, (event) => events.push(event));
  assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM session_checkpoints WHERE session_id = ?").get(state.id).n > 0);

  const result = await manager.deleteSession(state.id);

  assert.deepEqual(result, { deleted: true, sessionId: state.id, deletedSessionIds: [state.id, child.id] });
  assert.equal(store.load(state.id), null);
  assert.equal(store.load(child.id), null);
  assert.equal(store.load(branch.id).id, branch.id);
  assert.equal((await manager.list()).length, 1);
  assert.equal(store.latest(workspace).id, branch.id);
  for (const table of ["session_events", "session_checkpoints", "artifacts"]) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(state.id).n, 0);
  }
  assert.equal(await store.artifacts.get(artifact.id, { sessionId: state.id }), null);
  assert.equal((await store.memory.get(memory.id, { scope: store.memoryScope })).content, "保留项目约定");
  assert.equal(grantStore.list({ workspace }).length, 1);
  assert.equal(await fs.readFile(path.join(workspace, "app.js"), "utf8"), "保留源码\n");
  assert.equal(events.at(-1).type, "SESSION_DELETED");
  assert.equal(staleEntry.eventSubscriptions.size, 0);
  assert.equal(staleEntry.subscribers.size, 0);
  stop();
  await assert.rejects(staleEntry.session.dispatch({ type: "READY" }), /已删除或关闭/);
  assert.throws(() => store.save(staleEntry.state), /会话已删除/);
  assert.throws(() => store.ensureJournal(staleEntry.state), /会话已删除/);
  await assert.rejects(manager.importSession(archive), (error) => error.status === 409);
  await assert.rejects(manager.get(state.id), (error) => error.status === 404);
  await assert.rejects(manager.deleteSession(state.id), (error) => error.status === 404);
  await assert.rejects(manager.create({ resume: state.id }), (error) => error.status === 404);
  const reopened = new SessionStore(store.file, { workspace });
  try {
    assert.equal(reopened.load(state.id), null);
    assert.throws(() => reopened.save(staleEntry.state), /会话已删除/);
  } finally { reopened.close(); }
});

test("删除运行中任务等待取消清理，合并并发 DELETE 并拒绝新消息与恢复", async (t) => {
  const started = deferred();
  const cleanup = deferred();
  const fixture = await createFixture(t, {
    provider: { name: "wait-cleanup", complete: async ({ signal }) => {
      started.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      await cleanup.promise;
      throw signal.reason;
    } },
  });
  const { manager, store } = fixture;
  const state = await manager.create();
  const entry = manager.sessions.get(state.id);
  await manager.sendMessage(state.id, "长任务");
  await started.promise;
  let deleted = false;
  const deletion = manager.deleteSession(state.id).then((result) => { deleted = true; return result; });
  const duplicate = manager.deleteSession(state.id);
  await assert.rejects(manager.sendMessage(state.id, "不要启动"), (error) => error.status === 409);
  await assert.rejects(manager.create({ resume: state.id }), (error) => error.status === 409);
  await assert.rejects(manager.branch(state.id), (error) => error.status === 409);
  assert.equal(deleted, false);
  assert.ok(store.load(state.id));
  cleanup.resolve();
  assert.deepEqual(await deletion, await duplicate);
  assert.equal(entry.run, null);
  assert.equal(entry.approval, null);
  assert.equal(store.load(state.id), null);
});

test("删除待审批任务拒绝审批并等待 Runtime 完整收束", async (t) => {
  let decision;
  const requested = deferred();
  const fixture = await createFixture(t, {
    runtimeFactory: ({ session }) => ({
      cancel() {},
      async runTurn(content, requestApproval) {
        const waiting = requestApproval({ id: "approval-1", name: "write_file" }, "需要审批");
        requested.resolve();
        decision = await waiting;
        await session.dispatch({ type: "CANCELLED", reason: "删除时拒绝审批" });
        return session.state;
      },
    }),
  });
  const state = await fixture.manager.create();
  await fixture.manager.sendMessage(state.id, "需批准");
  await requested.promise;
  await fixture.manager.deleteSession(state.id);
  assert.equal(decision, false);
  assert.equal(fixture.store.load(state.id), null);
});

test("删除 Parent 取消活动 Child 及代理审批，单独删被等待 Child 返回 409", async (t) => {
  const requested = deferred();
  const fixture = await createFixture(t, {
    runtimeFactory: ({ session, maxSteps, maxTokensPerTurn }) => ({
      maxSteps, maxTokensPerTurn,
      cancel() {},
      async runTurn(content, requestApproval) {
        const approval = requestApproval({ id: "child-call", name: "write_file" }, "审批 Child");
        requested.resolve();
        assert.equal(await approval, false);
        await session.dispatch({ type: "CANCELLED", reason: "父任务删除" });
        return session.state;
      },
    }),
  });
  const { manager, store } = fixture;
  const parent = await manager.create();
  const delegation = manager.delegate(parent.id, { objective: "子任务", context: [] });
  const rejectedDelegation = assert.rejects(delegation, /cancelled/);
  await requested.promise;
  await waitFor(() => manager.sessions.get(parent.id).approval);
  const childId = [...manager.sessions.get(parent.id).children][0];
  await assert.rejects(manager.deleteSession(childId), (error) => error.status === 409 && /父任务/.test(error.message));
  const result = await manager.deleteSession(parent.id);
  await rejectedDelegation;
  assert.ok(result.deletedSessionIds.includes(childId));
  assert.equal(store.load(childId), null);
  assert.equal(store.load(parent.id), null);
});

test("删除不会漏掉正在请求、尚未创建的委派 Child", async (t) => {
  const { manager, store } = await createFixture(t);
  const parent = await manager.create();
  const entry = manager.sessions.get(parent.id);
  const dispatched = deferred();
  const release = deferred();
  const original = entry.session.dispatch.bind(entry.session);
  entry.session.dispatch = async (action) => {
    const value = await original(action);
    if (action.type === "DELEGATION_REQUESTED") {
      dispatched.resolve();
      await release.promise;
    }
    return value;
  };
  const rejected = assert.rejects(manager.delegate(parent.id, { objective: "不应启动", context: [] }), /正在删除/);
  await dispatched.promise;
  const deletion = manager.deleteSession(parent.id);
  release.resolve();
  await deletion;
  await rejected;
  assert.deepEqual(store.list(store.workspace), []);
  assert.equal(manager.sessions.size, 0);
});

test("删除等待已开始的异步会话写入，事务失败释放锁并可重试", async (t) => {
  const { manager, store } = await createFixture(t);
  const state = await manager.create();
  const entry = manager.sessions.get(state.id);
  const entered = deferred();
  const release = deferred();
  const dispatch = entry.session.dispatch.bind(entry.session);
  entry.session.dispatch = async (action) => {
    if (action.type === "SESSION_DISPLAY_TITLE_CHANGED") {
      entered.resolve();
      await release.promise;
    }
    return dispatch(action);
  };
  const rename = manager.setDisplayTitle(state.id, "已开始的写入");
  await entered.promise;
  const remove = store.deleteSessions.bind(store);
  store.deleteSessions = () => { throw new Error("注入事务故障"); };
  const failed = assert.rejects(manager.deleteSession(state.id), /注入事务故障/);
  assert.ok(store.load(state.id));
  release.resolve();
  await rename;
  await failed;
  assert.equal((await manager.get(state.id)).displayTitle, "已开始的写入");
  store.deleteSessions = remove;
  assert.equal((await manager.deleteSession(state.id)).deleted, true);
});

test("持久删除是原子的，无效目标不会留下部分删除或墓碑", async (t) => {
  const { manager, store } = await createFixture(t);
  const state = await manager.create();
  assert.throws(() => store.deleteSessions([state.id, "missing-session"]), /未找到会话/);
  assert.ok(store.load(state.id));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM deleted_sessions").get().n, 0);
  store.save(state);
});

test("删除通知隔离异步订阅者异常并清理其他订阅", async (t) => {
  const { manager } = await createFixture(t);
  const state = await manager.create();
  let notified = false;
  await manager.subscribeEvents(state.id, async (event) => {
    if (event.type === "SESSION_DELETED") throw new Error("投影层订阅者失败");
  });
  await manager.subscribeEvents(state.id, (event) => {
    if (event.type === "SESSION_DELETED") notified = true;
  });
  assert.equal((await manager.deleteSession(state.id)).deleted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notified, true);
});

test("latest 恢复固定 barrier 登记时的目标 ID", async (t) => {
  const { manager, store } = await createFixture(t);
  const first = await manager.create();
  const second = await manager.create();
  const latest = store.latest.bind(store);
  let calls = 0;
  store.latest = () => (++calls === 1 ? first : second);
  assert.equal((await manager.create({ resume: "latest" })).id, first.id);
  assert.equal(calls, 1);
  store.latest = latest;
});

test("关闭 Manager 会等待正在删除的 Runtime 清理", async (t) => {
  const started = deferred();
  const release = deferred();
  const { manager, store } = await createFixture(t, {
    runtimeFactory: ({ session }) => ({
      cancel() {},
      async runTurn() {
        started.resolve();
        await release.promise;
        await session.dispatch({ type: "CANCELLED", reason: "收束" });
        return session.state;
      },
    }),
  });
  const state = await manager.create();
  await manager.sendMessage(state.id, "等待");
  await started.promise;
  const deletion = manager.deleteSession(state.id);
  let closed = false;
  const closing = manager.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([closing, deletion]);
  assert.equal(store.load(state.id), null);
});

test("HTTP 删除响应与 SSE 删除通知一致，并结束旧订阅", async (t) => {
  const { manager } = await createFixture(t);
  const state = await manager.create();
  const streamRequest = httpRequest("GET", `/sessions/${state.id}/events`);
  const streamResponse = httpResponse();
  await routeGatewayRequest(streamRequest, streamResponse, manager);
  assert.equal(streamResponse.status, 200);
  const deleteResponse = httpResponse();
  await routeGatewayRequest(httpRequest("DELETE", `/sessions/${state.id}`), deleteResponse, manager);
  assert.equal(deleteResponse.status, 200);
  assert.equal(JSON.parse(deleteResponse.body).sessionId, state.id);
  assert.match(streamResponse.body, /event: session_deleted/);
  assert.equal(streamResponse.ended, true);
  await assert.rejects(routeGatewayRequest(httpRequest("DELETE", `/sessions/${state.id}`), httpResponse(), manager), (error) => error.status === 404);
  await assert.rejects(routeGatewayRequest(httpRequest("GET", `/sessions/${state.id}/events`), httpResponse(), manager), (error) => error.status === 404);
});

test("SSE 在订阅建立期间被删除仍发终结事件，订阅失败不会发送 200 headers", async () => {
  let stopped = false;
  const request = httpRequest("GET", "/sessions/deleted/events");
  const response = httpResponse();
  await routeGatewayRequest(request, response, {
    async subscribeEvents(id, listener) {
      listener({ type: "SESSION_DELETED", deleted: true, sessionId: id, deletedSessionIds: [id] });
      return () => { stopped = true; };
    },
  });
  assert.equal(response.ended, true);
  assert.equal(stopped, true);
  const failingResponse = httpResponse();
  await assert.rejects(routeGatewayRequest(httpRequest("GET", "/sessions/gone/events"), failingResponse, {
    async subscribeEvents() { throw new Error("任务已删除"); },
  }), /任务已删除/);
  assert.equal(failingResponse.headersSent, false);
});

test("跨项目删除清除路由索引，重启只保留其他项目任务", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-delete-projects-"));
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  const second = await catalog.create({ name: "保留项目" });
  const factory = (project) => {
    const store = new SessionStore(path.join(project.workspace, ".nexus", "nexus.db"), { workspace: project.workspace });
    return { manager: createManager(project.workspace, store), close: () => store.close() };
  };
  let coordinator = new GatewayProjectCoordinator({ catalog, createProjectManager: factory });
  t.after(async () => { await coordinator.close(); await fs.rm(root, { recursive: true, force: true }); });
  const target = await coordinator.create();
  const kept = await coordinator.create({ projectId: second.id });
  await coordinator.get(target.id);
  await coordinator.deleteSession(target.id);
  assert.deepEqual((await coordinator.list()).map((item) => item.id), [kept.id]);
  await assert.rejects(coordinator.get(target.id), (error) => error.status === 404);
  await assert.rejects(coordinator.create({ resume: target.id }), (error) => error.status === 404);
  await coordinator.close();
  coordinator = new GatewayProjectCoordinator({ catalog, createProjectManager: factory });
  assert.deepEqual((await coordinator.list()).map((item) => item.id), [kept.id]);
  await assert.rejects(coordinator.get(target.id), (error) => error.status === 404);
  assert.equal((await coordinator.get(kept.id)).project.id, second.id);
});

test("晚到的所有权扫描不会覆盖删除后新建立的跨项目索引", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-delete-index-race-"));
  const projects = ["A", "B"].map((id) => ({ id, name: id, workspace: path.join(root, id) }));
  await Promise.all(projects.map((project) => fs.mkdir(project.workspace)));
  const targetId = "same-id-after-delete";
  const states = new Map([["A", { id: targetId, workspace: projects[0].workspace }]]);
  const moved = deferred();
  let triggerMove = false;
  let coordinator;
  const move = async () => {
    // Controlled creation supplies the old ownership index, then deletion
    // invalidates it and another controlled creation supplies the new owner.
    await coordinator.create({ projectId: "A" });
    await coordinator.deleteSession(targetId);
    await coordinator.create({ projectId: "B" });
  };
  coordinator = new GatewayProjectCoordinator({
    catalog: {
      root, defaultProjectId: "A",
      list: async () => projects,
      get: async (id) => projects.find((project) => project.id === id),
    },
    createProjectManager: (project) => ({ manager: {
      store: { load() {
        const state = states.get(project.id) || null;
        if (project.id === "A" && triggerMove) {
          triggerMove = false;
          queueMicrotask(() => { move().then(moved.resolve, moved.resolve); });
        }
        return state;
      } },
      runtimeInfo: () => ({}),
      create: async () => {
        const state = { id: targetId, workspace: project.workspace };
        states.set(project.id, state);
        return state;
      },
      deleteSession: async (id) => {
        states.delete(project.id);
        return { deleted: true, sessionId: id, deletedSessionIds: [id] };
      },
      get: async () => {
        const state = states.get(project.id);
        if (!state) throw new Error("错误路由到了已删除的旧项目");
        return state;
      },
      close: async () => {},
    } }),
  });
  t.after(async () => { await coordinator.close(); await fs.rm(root, { recursive: true, force: true }); });
  await coordinator.runtimeInfo("A");
  await coordinator.runtimeInfo("B");
  triggerMove = true;
  const state = await coordinator.get(targetId);
  const failure = await moved.promise;
  if (failure) throw failure;
  assert.equal(state.project.id, "B");
  assert.equal((await coordinator.get(targetId)).project.id, "B");
});

async function createFixture(t, options = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-session-delete-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace, checkpointInterval: 2 });
  const manager = createManager(workspace, store, options);
  t.after(async () => { await manager.close(); store.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  return { workspace, store, manager };
}

function createManager(workspace, store, options = {}) {
  return new GatewaySessionManager({
    workspace, store,
    provider: { name: "offline-delete-test", complete: async () => ({ text: "完成", toolCalls: [] }) },
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    memoryFlushPolicy: { flush: async () => {} },
    ...options,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("等待事件超时");
}

function httpRequest(method, url) {
  const request = Readable.from([]);
  request.method = method;
  request.url = url;
  request.headers = {};
  return request;
}

function httpResponse() {
  return {
    status: null, headersSent: false, body: "", ended: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    write(value) { this.body += value; },
    end(value = "") { this.body += value; this.ended = true; },
  };
}
