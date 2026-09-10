import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalWorkspaceAdapter } from "../src/execution/local-workspace-adapter.js";
import { createOutputNotifier } from "../src/execution/output-notifier.js";

test("Output Notifier 同步暂停两个来源，慢通知不会积压后续 chunk", async () => {
  const gate = deferred();
  const received = [];
  const fixture = controllableSources(async (event) => { received.push(event); await gate.promise; });
  assert.equal(fixture.send("stdout", "first"), true);
  assert.deepEqual(fixture.sources.map((source) => source.paused), [true, true]);
  for (let index = 0; index < 1_000; index += 1) {
    assert.equal(fixture.send(index % 2 ? "stdout" : "stderr", "blocked"), false);
  }
  let drained = false;
  const drain = fixture.notifier.drain().then(() => { drained = true; });
  await nextTurn();
  assert.deepEqual(received, [{ channel: "stdout", chunk: "first" }]);
  assert.equal(drained, false);
  gate.resolve();
  await drain;
  assert.deepEqual(fixture.sources.map((source) => source.paused), [false, false]);
  assert.equal(fixture.send("stderr", "second"), true);
  await fixture.notifier.drain();
  assert.deepEqual(received.map((event) => event.channel), ["stdout", "stderr"]);
});

test("Output Notifier resume 同步产生下一项时不会意外恢复另一个通道", async () => {
  const first = deferred();
  const second = deferred();
  const received = [];
  const fixture = controllableSources(async (event) => {
    received.push(event.chunk);
    await (received.length === 1 ? first.promise : second.promise);
  });
  fixture.sources[0].onResume = () => {
    if (received.length === 1) fixture.send("stdout", "second");
  };
  fixture.send("stderr", "first");
  await nextTurn();
  first.resolve();
  await nextTurn();
  assert.deepEqual(received, ["first", "second"]);
  assert.deepEqual(fixture.sources.map((source) => source.paused), [true, true]);
  second.resolve();
  await fixture.notifier.drain();
  assert.deepEqual(fixture.sources.map((source) => source.paused), [false, false]);
});

test("Output Notifier drain 等待恢复来源时同步接受的新通知", async () => {
  const first = deferred();
  const second = deferred();
  const received = [];
  const fixture = controllableSources(async (event) => {
    received.push(event.chunk);
    await (received.length === 1 ? first.promise : second.promise);
  });
  fixture.sources[0].onResume = () => {
    if (received.length === 1) fixture.send("stdout", "second");
  };
  fixture.send("stderr", "first");
  let drained = false;
  const drain = fixture.notifier.drain().then(() => { drained = true; });
  await nextTurn();
  first.resolve();
  await nextTurn();
  assert.deepEqual(received, ["first", "second"]);
  assert.equal(drained, false, "drain 不能只等待调用时的第一项");
  second.resolve();
  await drain;
  assert.equal(drained, true);
});

test("Output Notifier 同步与异步回调失败均恢复来源且不破坏后续通知", async () => {
  const seen = [];
  const fixture = controllableSources((event) => {
    seen.push(event.chunk);
    if (event.chunk === "sync") throw new Error("同步持久化失败");
    if (event.chunk === "async") return Promise.reject(new Error("异步持久化失败"));
  });
  for (const [index, chunk] of ["sync", "async", "ok"].entries()) {
    assert.equal(fixture.send(index % 2 ? "stderr" : "stdout", chunk), true);
    await fixture.notifier.drain();
    assert.deepEqual(fixture.sources.map((source) => source.paused), [false, false]);
  }
  assert.deepEqual(seen, ["sync", "async", "ok"]);
});

test("Output Notifier stop 立即恢复管道继续采集，仍等待已接受通知闭合", async () => {
  const gate = deferred();
  const seen = [];
  const fixture = controllableSources(async (event) => { seen.push(event); await gate.promise; });
  fixture.send("stdout", "accepted");
  await nextTurn();
  fixture.notifier.stop();
  fixture.notifier.stop();
  assert.deepEqual(fixture.sources.map((source) => source.paused), [false, false]);
  assert.equal(fixture.send("stderr", "cleanup tail"), true);
  let drained = false;
  const drain = fixture.notifier.drain().then(() => { drained = true; });
  await nextTurn();
  assert.equal(drained, false);
  assert.equal(seen.length, 1);
  assert.deepEqual(fixture.collected.map((event) => event.chunk), ["accepted", "cleanup tail"]);
  gate.resolve();
  await drain;
  assert.equal(seen.length, 1);
  assert.deepEqual(fixture.sources.map((source) => source.pauses), [1, 1]);
});

test("Output Notifier 未配置观察回调时不暂停或恢复来源", async () => {
  const fixture = controllableSources(undefined);
  for (let index = 0; index < 20; index += 1) assert.equal(fixture.send("stdout", "output"), true);
  fixture.notifier.stop();
  await fixture.notifier.drain();
  assert.deepEqual(fixture.sources.map((source) => [source.pauses, source.resumes]), [[0, 0], [0, 0]]);
  assert.equal(fixture.collected.length, 20);
});

test("LocalWorkspaceAdapter 慢预览与观察失败不丢失最终 stdout/stderr", { timeout: 10_000 }, async (t) => {
  const { adapter } = await temporaryAdapter(t);
  const first = deferred();
  const release = deferred();
  const controller = new AbortController();
  t.after(() => { release.resolve(); controller.abort(); });
  const stdout = `${"stdout line\n".repeat(25_000)}OUT-END\n`;
  const stderr = "ERR-END\n";
  const received = [];
  let settled = false;
  const running = adapter.execute({
    program: process.execPath,
    args: ["-e", "process.stdout.write('stdout line\\n'.repeat(25000)+'OUT-END\\n');process.stderr.write('ERR-END\\n');"],
    maxOutputChars: 1_000_000,
  }, {
    signal: controller.signal,
    onOutput: async (event) => {
      received.push(event);
      first.resolve();
      await release.promise;
      throw new Error("预览观察失败");
    },
  }).finally(() => { settled = true; });
  await first.promise;
  await nextTurn();
  assert.equal(received.length, 1);
  assert.equal(settled, false);
  release.resolve();
  const result = await running;
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.equal(received.filter((event) => event.channel === "stdout").map((event) => event.chunk).join(""), stdout);
  assert.equal(received.filter((event) => event.channel === "stderr").map((event) => event.chunk).join(""), stderr);
});

for (const termination of ["cancelled", "timeout"]) {
  test(`LocalWorkspaceAdapter ${termination} 时恢复暂停的管道回收子进程并保留清理尾部`, { timeout: 10_000 }, async (t) => {
    if (process.platform === "win32") return t.skip("SIGTERM 清理处理器只适用于 POSIX");
    const { adapter, workspace } = await temporaryAdapter(t);
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    t.after(() => { release.resolve(); controller.abort(); });
    let count = 0;
    let settled = false;
    const source = [
      "const fs=require('node:fs');",
      "process.on('SIGTERM',()=>process.stderr.write('x'.repeat(262144)+'CLEANUP-END\\n',()=>{fs.writeFileSync('cleanup-finished','ok');process.exit(0)}));",
      "process.stdout.write('ready\\n');setInterval(()=>{},1000);",
    ].join("");
    const running = adapter.execute({
      program: process.execPath,
      args: ["-e", source],
      timeoutMs: termination === "timeout" ? 500 : null,
      maxOutputChars: 1_000_000,
    }, {
      signal: controller.signal,
      onOutput: async () => { count += 1; started.resolve(); await release.promise; },
    });
    const outcome = running.then((value) => ({ value }), (error) => ({ error })).finally(() => { settled = true; });
    await started.promise;
    if (termination === "cancelled") controller.abort(new Error("cancel-paused-output"));
    await waitForFile(path.join(workspace, "cleanup-finished"));
    assert.equal(settled, false, "已接受的通知不能被取消静默丢弃");
    assert.equal(count, 1, "终止后新输出只进入结果采集，不再排预览通知");
    release.resolve();
    const { error } = await outcome;
    assert.equal(error?.code, termination);
    assert.equal(error.result.stdout, "ready\n");
    assert.equal(error.result.stderr, `${"x".repeat(262_144)}CLEANUP-END\n`);
    assert.match(error.result.output, /CLEANUP-END\n$/);
  });
}

test("LocalWorkspaceAdapter spawn 失败会清理通知来源并保留 spawn_failed", async (t) => {
  const { adapter, workspace } = await temporaryAdapter(t);
  await assert.rejects(adapter.execute({ program: path.join(workspace, "missing-program") }, {
    onOutput: () => assert.fail("失败的 spawn 不应产生通知"),
  }), (error) => error.code === "spawn_failed");
});

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function controllableSources(callback) {
  const sources = ["stdout", "stderr"].map((channel) => ({
    channel, paused: false, pauses: 0, resumes: 0, onResume: null,
    pause() { this.paused = true; this.pauses += 1; },
    resume() { this.paused = false; this.resumes += 1; this.onResume?.(); },
  }));
  const notifier = createOutputNotifier(callback, { sources });
  const collected = [];
  return {
    notifier, sources, collected,
    send(channel, chunk) {
      if (sources.find((source) => source.channel === channel).paused) return false;
      const event = { channel, chunk };
      collected.push(event);
      notifier.emit(event);
      return true;
    },
  };
}

async function temporaryAdapter(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-output-backpressure-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return { workspace, adapter: new LocalWorkspaceAdapter({ workspace, environment: {}, killGraceMs: 2_000 }) };
}

async function waitForFile(file) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await fs.access(file); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("子进程清理尾部未能排空");
}
