import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { ToolHost } from "../src/tools/host.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { createToolRegistry } from "../src/tools/registry.js";

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-workspace-search-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const registry = createToolRegistry({ workspace });
  const run = async (name, args, context) => JSON.parse(await registry.get(name).execute(args, context));
  return { workspace, registry, run };
}

test("搜索展示保留跨行脱敏上下文，不因只返回命中行而漏出秘密", async (t) => {
  const { workspace, run } = await fixture(t);
  await fs.writeFile(path.join(workspace, "headers.txt"), 'Authorization:\nBearer fixture-crossline-secret\npassword:\n"fixture-quoted-secret"\nsafe\n');
  const result = await run("search_files", { query: "fixture" });
  assert.deepEqual(result.matches.map((match) => match.line), [2, 4]);
  assert.ok(result.matches.every((match) => match.text.includes("[REDACTED]")));
  assert.equal(JSON.stringify(result).includes("fixture-crossline-secret"), false);
  assert.equal(JSON.stringify(result).includes("fixture-quoted-secret"), false);
});

test("list_files 分页排序并可读取第 121 个文件，完整性明确", async (t) => {
  const { workspace, run } = await fixture(t);
  await Promise.all(Array.from({ length: 125 }, (_, n) => fs.writeFile(path.join(workspace, `${String(124 - n).padStart(3, "0")}.txt`), "x")));
  const first = await run("list_files", {});
  assert.equal(first.entries.length, 120);
  assert.equal(first.complete, false);
  assert.equal(first.has_more, true);
  const last = await run("list_files", { cursor: first.next_cursor });
  assert.equal(last.entries.length, 5);
  assert.equal(last.complete, true);
  assert.equal(last.has_more, false);
  assert.deepEqual([...first.entries, ...last.entries].map((entry) => entry.path), Array.from({ length: 125 }, (_, n) => `${String(n).padStart(3, "0")}.txt`));
});

test("search_files 首 300 个文件无匹配不会宣称全仓无结果，可翻到第 301 个", async (t) => {
  const { workspace, run } = await fixture(t);
  await Promise.all(Array.from({ length: 301 }, (_, n) => fs.writeFile(path.join(workspace, `${String(n).padStart(3, "0")}.txt`), n === 300 ? "TARGET" : "nothing")));
  const first = await run("search_files", { query: "target" });
  assert.deepEqual(first.matches, []);
  assert.equal(first.scanned_files, 300);
  assert.equal(first.has_more, true);
  assert.equal(first.complete, false);
  const second = await run("search_files", { query: "target", cursor: first.next_cursor });
  assert.equal(second.matches[0].path, "300.txt");
  assert.equal(second.complete, true);
});

test("同一文件超过结果上限时，游标继续下一行且重复游标结果一致", async (t) => {
  const { workspace, run } = await fixture(t);
  await fs.writeFile(path.join(workspace, "many.txt"), "needle\n".repeat(7));
  const first = await run("search_files", { query: "needle", limit: 3 });
  const args = { query: "needle", limit: 3, cursor: first.next_cursor };
  const second = await run("search_files", args);
  assert.deepEqual(second.matches.map((hit) => hit.line), [4, 5, 6]);
  const replay = await run("search_files", args);
  assert.deepEqual(replay, second);
  const final = await run("search_files", { ...args, cursor: second.next_cursor });
  assert.deepEqual(final.matches.map((hit) => hit.line), [7]);
  assert.equal(final.complete, true);
});

test("并发续查同一游标返回相同页面和下一游标", async (t) => {
  const { workspace, run } = await fixture(t);
  await fs.writeFile(path.join(workspace, "many.txt"), "needle\n".repeat(7));
  const first = await run("search_files", { query: "needle", limit: 1 });
  const args = { query: "needle", limit: 1, cursor: first.next_cursor };
  const [one, two] = await Promise.all([run("search_files", args), run("search_files", args)]);
  assert.deepEqual(one, two);
});

test("search_files 限定目录和明确支持的 file_pattern 通配符", async (t) => {
  const { workspace, run } = await fixture(t);
  await fs.mkdir(path.join(workspace, "src", "nested"), { recursive: true });
  await fs.writeFile(path.join(workspace, "outside.js"), "needle");
  await fs.writeFile(path.join(workspace, "src", "skip.txt"), "needle");
  await fs.writeFile(path.join(workspace, "src", "nested", "found.js"), "needle");
  const result = await run("search_files", { query: "needle", path: "src", file_pattern: "**/*.js" });
  assert.deepEqual(result.matches.map((hit) => hit.path), ["src/nested/found.js"]);
  assert.equal(result.scanned_files, 1);
  assert.equal(result.skipped.filtered, 1);
  await assert.rejects(run("search_files", { query: "x", file_pattern: "*.{js,ts}" }), /file_pattern/);
});

test("游标绑定参数和用户，目录或已搜索文件变化使游标失效", async (t) => {
  const { workspace, run } = await fixture(t);
  await fs.writeFile(path.join(workspace, "a.txt"), "needle\nneedle\nneedle");
  await fs.writeFile(path.join(workspace, "b.txt"), "needle");
  const first = await run("search_files", { query: "needle", limit: 1 }, { state: { id: "one" } });
  await assert.rejects(run("search_files", { query: "other", limit: 1, cursor: first.next_cursor }, { state: { id: "one" } }), /游标/);
  await assert.rejects(run("search_files", { query: "needle", limit: 1, cursor: first.next_cursor }, { state: { id: "two" } }), /游标/);
  await fs.writeFile(path.join(workspace, "a.txt"), "changed");
  await assert.rejects(run("search_files", { query: "needle", limit: 1, cursor: first.next_cursor }, { state: { id: "one" } }), /游标|变化/);
  const listing = await run("list_files", { limit: 1 });
  await fs.writeFile(path.join(workspace, "c.txt"), "new");
  await assert.rejects(run("list_files", { limit: 1, cursor: listing.next_cursor }), /游标|变化/);
});

test("受限、忽略、符号链接和超大文件都有计数，不泄露正文或受限路径", async (t) => {
  const { workspace, run } = await fixture(t);
  await fs.mkdir(path.join(workspace, "node_modules"));
  await fs.writeFile(path.join(workspace, "node_modules", "ignored.txt"), "needle ignored");
  await fs.writeFile(path.join(workspace, ".env.secret"), "needle sensitive");
  await fs.writeFile(path.join(workspace, "hidden.txt"), "needle host sensitive");
  await fs.writeFile(path.join(workspace, "visible.txt"), "needle visible");
  await fs.writeFile(path.join(workspace, "huge.txt"), "needle" + "x".repeat(1_000_000));
  await fs.symlink("visible.txt", path.join(workspace, "alias.txt"));
  const context = { authorizeRead: (relative) => relative !== "hidden.txt" };
  const result = await run("search_files", { query: "needle" }, context);
  assert.deepEqual(result.matches.map((hit) => hit.path), ["visible.txt"]);
  assert.equal(result.skipped.restricted, 2);
  assert.equal(result.skipped.ignored, 1);
  assert.equal(result.skipped.symlink, 1);
  assert.equal(result.skipped.too_large, 1);
  assert.equal(result.complete, false);
  assert.equal(result.has_more, false);
  const listing = await run("list_files", {}, context);
  assert.equal(JSON.stringify(listing).includes("hidden.txt"), false);
  assert.equal(JSON.stringify(result).includes("needle sensitive"), false);
  await assert.rejects(run("search_files", { query: "needle", path: "../" }), /边界/);
});

test("取消立即终止，扫描预算不因无匹配目录无限增长", async (t) => {
  const { workspace, run } = await fixture(t);
  for (const name of ["a", "b", "c"]) await fs.mkdir(path.join(workspace, name));
  const first = await run("search_files", { query: "nothing", scan_limit: 1 });
  assert.equal(first.has_more, true);
  assert.ok(first.scanned_entries <= 1);
  const controller = new AbortController();
  controller.abort(new Error("用户取消"));
  await assert.rejects(run("search_files", { query: "anything" }, { signal: controller.signal }), /用户取消/);
});

test("长匹配行的 JSON 保持在 Host 输出预算内，翻页无丢行", async (t) => {
  const { workspace, registry } = await fixture(t);
  await fs.writeFile(path.join(workspace, "long.txt"), Array.from({ length: 90 }, (_, n) => `needle ${n} ${"\\\"".repeat(300)}`).join("\n"));
  let cursor;
  const lineNumbers = [];
  do {
    const output = await registry.get("search_files").execute({ query: "needle", ...(cursor ? { cursor } : {}) });
    assert.ok(output.length <= 10_000);
    const page = JSON.parse(output);
    assert.ok(page.matches.every((match) => match.text_truncated));
    lineNumbers.push(...page.matches.map((match) => match.line));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(lineNumbers, Array.from({ length: 90 }, (_, n) => n + 1));
});

test("每页最多读取 4MB，字节预算末尾文件下一页继续", async (t) => {
  const { workspace, run } = await fixture(t);
  await Promise.all(Array.from({ length: 6 }, (_, n) => fs.writeFile(path.join(workspace, `${n}.txt`), "needle\n" + "x".repeat(899_993))));
  const first = await run("search_files", { query: "needle" });
  assert.equal(first.scanned_files, 4);
  assert.equal(first.scanned_bytes, 3_600_000);
  assert.equal(first.has_more, true);
  const last = await run("search_files", { query: "needle", cursor: first.next_cursor });
  assert.equal(last.scanned_files, 2);
  assert.equal(last.scanned_bytes, 1_800_000);
  assert.deepEqual([...first.matches, ...last.matches].map((match) => match.path), ["0.txt", "1.txt", "2.txt", "3.txt", "4.txt", "5.txt"]);
  assert.equal(last.complete, true);
});

test("已缓存分页结果仍复查 Host 权限，恢复或重建注册表后旧游标失效", async (t) => {
  const { workspace, run } = await fixture(t);
  await Promise.all(["a.txt", "b.txt", "c.txt"].map((name) => fs.writeFile(path.join(workspace, name), "needle")));
  let denied = false;
  const context = { authorizeRead: (relative) => !(denied && relative === "b.txt") };
  const first = await run("list_files", { limit: 1 }, context);
  const nextArgs = { limit: 1, cursor: first.next_cursor };
  assert.equal((await run("list_files", nextArgs, context)).entries[0].path, "b.txt");
  denied = true;
  await assert.rejects(run("list_files", nextArgs, context), /游标/);
  const restarted = createToolRegistry({ workspace });
  await assert.rejects(restarted.get("list_files").execute(nextArgs), /游标/);
});

test("二进制与非法 UTF-8 明确跳过并计入实际读取字节", async (t) => {
  const { workspace, run } = await fixture(t);
  await fs.writeFile(path.join(workspace, "binary.bin"), Buffer.from("needle\0tail"));
  await fs.writeFile(path.join(workspace, "invalid.txt"), Buffer.from([0xff, ...Buffer.from("needle")]));
  const page = await run("search_files", { query: "needle" });
  assert.equal(page.skipped.binary, 2);
  assert.equal(page.scanned_bytes, 18);
  assert.equal(page.complete, false);
  assert.equal(page.has_more, false);
  assert.deepEqual(page.matches, []);
});

test("超过目录快照上限时停止迭代并报明确资源范围错误", async (t) => {
  const { run } = await fixture(t);
  let visited = 0;
  let closed = false;
  t.mock.method(fs, "opendir", async () => (async function* () {
    try {
      for (let n = 0; n < 30_000; n += 1) {
        visited += 1;
        yield { name: `${n}.txt`, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
      }
    } finally { closed = true; }
  })());
  await assert.rejects(run("list_files", {}), /资源上限.*20000.*缩小 path/);
  assert.equal(visited, 20_001);
  assert.equal(closed, true);
});

test("恶意多星号 file_pattern 在有界时间内结束", async (t) => {
  const { workspace } = await fixture(t);
  await fs.writeFile(path.join(workspace, "a".repeat(100)), "needle");
  const worker = new Worker(`
    import { parentPort, workerData } from "node:worker_threads";
    import { createToolRegistry } from ${JSON.stringify(new URL("../src/tools/registry.js", import.meta.url).href)};
    const registry = createToolRegistry({ workspace: workerData.workspace });
    const result = await registry.get("search_files").execute({ query: "needle", file_pattern: "*a".repeat(30) + "b" });
    parentPort.postMessage(JSON.parse(result));
  `, { eval: true, workerData: { workspace } });
  t.after(() => worker.terminate());
  const page = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("file_pattern 未在有界时间内完成")), 1_500);
    worker.once("message", (value) => { clearTimeout(timer); resolve(value); });
    worker.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  assert.deepEqual(page.matches, []);
  assert.equal(page.complete, true);
});

test("同一页读取期间目录或已搜索文件变化，不能返回 complete 成功", async (t) => {
  for (const change of ["directory", "file"]) {
    const { workspace, run } = await fixture(t);
    await fs.writeFile(path.join(workspace, "a.txt"), "needle");
    await fs.writeFile(path.join(workspace, "b.txt"), "needle");
    let changed = false;
    await assert.rejects(run("search_files", { query: "needle" }, { authorizeRead: async (relative) => {
      if (relative === "b.txt" && !changed) {
        changed = true;
        await fs.writeFile(path.join(workspace, change === "directory" ? "c.txt" : "a.txt"), "needle changed");
      }
      return true;
    } }), /游标|变化/);
  }
});

test("真实 Host 和 Session 二次脱敏后 JSON 可解析，秘密移除且游标继续", async (t) => {
  const { workspace, registry } = await fixture(t);
  await fs.writeFile(path.join(workspace, "secrets.txt"), "needle API_KEY=first-secret\nneedle authorization: Bearer second-secret\nneedle visible\n");
  const session = new AgentSession({ state: createSession({ workspace, provider: "test" }), reducer: reduceSession });
  const host = new ToolHost({ registry, policy: new WorkspacePolicy({}, { profile: registry.accessPolicy }) });
  const firstResult = await host.execute({ id: "search-secret-1", name: "search_files", arguments: { query: "needle", limit: 1 } }, { session });
  assert.equal(firstResult.status, "completed");
  const first = JSON.parse(firstResult.result);
  assert.equal(first.matches[0].text, "needle API_KEY=[REDACTED]");
  assert.equal(firstResult.result.includes("first-secret"), false);
  const secondResult = await host.execute({ id: "search-secret-2", name: "search_files", arguments: { query: "needle", limit: 1, cursor: first.next_cursor } }, { session });
  assert.equal(secondResult.status, "completed");
  const second = JSON.parse(secondResult.result);
  assert.equal(second.matches[0].text, "needle authorization: Bearer [REDACTED]");
  assert.equal(secondResult.result.includes("second-secret"), false);
  for (const message of session.state.messages.filter((entry) => entry.role === "tool")) JSON.parse(message.content);
});

test("搜索内容在截断展示行之前脱敏，跨展示边界的带引号秘密不会漏出", async (t) => {
  const { workspace, run } = await fixture(t);
  await fs.writeFile(path.join(workspace, "quoted.txt"), `needle password="${"sensitive-text".repeat(40)}"`);
  const page = await run("search_files", { query: "needle" });
  assert.equal(page.matches[0].text, 'needle password="[REDACTED]"');
  assert.equal(JSON.stringify(page).includes("sensitive-text"), false);
});
