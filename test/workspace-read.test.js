import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolRegistry } from "../src/tools/registry.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { readWorkspaceFile, withWorkspaceFile } from "../src/tools/workspace-read.js";
import { ToolHost } from "../src/tools/host.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";

async function fixture(t, files = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-workspace-read-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await fs.writeFile(path.join(workspace, name), content);
  }
  const accessPolicy = createPermissionProfile({ workspace });
  return { workspace, accessPolicy, path: "source.txt" };
}

test("read_file 保持旧的小文件正文结果", async (t) => {
  const options = await fixture(t, { "source.txt": "甲\r\n乙\n" });
  const registry = createToolRegistry(options);
  assert.equal(await registry.get("read_file").execute({ path: options.path }), "甲\r\n乙\n");
});

test("行分页保留 UTF-8、CRLF 并明确下一行与文件版本", async (t) => {
  const options = await fixture(t, { "source.txt": "甲\r\n乙🙂\r\n丙\n丁" });
  const first = await readWorkspaceFile({ ...options, start_line: 2, line_count: 2 });
  assert.equal(first.content, "乙🙂\r\n丙\n");
  assert.equal(first.start_line, 2);
  assert.equal(first.end_line, 3);
  assert.equal(first.next_line, 4);
  assert.equal(first.complete, false);
  assert.equal(first.stop_reason, "line_limit");
  const next = await readWorkspaceFile({ ...options, start_line: first.next_line, version: first.version });
  assert.equal(next.content, "丁");
  assert.equal(next.complete, true);
  assert.equal(next.next_line, null);
});

test("默认大文件不再静默截断，字节分页可读取旧百万字符上限后的尾部", async (t) => {
  const content = `${"a".repeat(1_010_000)}尾部🙂`;
  const options = await fixture(t, { "source.txt": content });
  const first = await readWorkspaceFile(options);
  assert.equal(typeof first, "object");
  assert.equal(first.complete, false);
  assert.equal(first.stop_reason, "response_limit");
  assert.equal(first.partial_line, true);
  assert.equal(first.next_line, 1);
  const last = await readWorkspaceFile({ ...options, offset: 1_010_000, limit: 64, version: first.version });
  assert.equal(last.content, "尾部🙂");
  assert.equal(last.complete, true);
});

test("行分页可直接定位到旧百万字符上限后的行", async (t) => {
  const options = await fixture(t, { "source.txt": `${"line\n".repeat(210_000)}最后一行🙂` });
  const page = await readWorkspaceFile({ ...options, start_line: 210_001 });
  assert.equal(page.content, "最后一行🙂");
  assert.equal(page.start_line, 210_001);
  assert.equal(page.end_line, 210_001);
  assert.equal(page.complete, true);
});

test("字节页截断不拆 UTF-8 字符，可无损拼接且不丢 BOM", async (t) => {
  const content = "\uFEFF甲🙂乙\r\n🙂丙";
  const options = await fixture(t, { "source.txt": content });
  let offset = 0;
  let actual = "";
  let result;
  do {
    result = await readWorkspaceFile({ ...options, offset, limit: 5 });
    actual += result.content;
    if (!result.complete) assert.ok(result.next_offset > offset);
    offset = result.next_offset;
  } while (!result.complete);
  assert.equal(actual, content);
  await assert.rejects(readWorkspaceFile({ ...options, offset: 4 }), /UTF-8/);
});

test("分页后的版本变化会阻止拼接不同版本", async (t) => {
  const options = await fixture(t, { "source.txt": "old\nsecond" });
  const first = await readWorkspaceFile({ ...options, start_line: 1, line_count: 1 });
  await fs.writeFile(path.join(options.workspace, options.path), "new\nsecond");
  await assert.rejects(readWorkspaceFile({ ...options, start_line: 2, version: first.version }), /版本/);
});

test("超出文件的行和字节偏移返回明确 EOF", async (t) => {
  const options = await fixture(t, { "source.txt": "one\ntwo\n", "empty": "" });
  const page = await readWorkspaceFile({ ...options, start_line: 20 });
  assert.equal(page.content, "");
  assert.equal(page.complete, true);
  assert.equal(page.end_line, null);
  const bytes = await readWorkspaceFile({ ...options, offset: 100 });
  assert.equal(bytes.content, "");
  assert.equal(bytes.complete, true);
  assert.equal(await readWorkspaceFile({ ...options, path: "empty" }), "");
});

test("行定位扫描到预算上限时显式报告可继续位置", async (t) => {
  const options = await fixture(t, { "source.txt": "first\nsecond\nthird\nfourth\n" });
  const result = await readWorkspaceFile({ ...options, start_line: 4, maxScanBytes: 12 });
  assert.equal(result.content, "");
  assert.equal(result.complete, false);
  assert.equal(result.stop_reason, "scan_limit");
  assert.ok(result.next_offset > 0);
  assert.ok(result.next_line < 4);
  const remainder = await readWorkspaceFile({ ...options, offset: result.next_offset });
  assert.ok(remainder.content.includes("fourth"));
});

test("行定位扫描上限不会返回落在 UTF-8 字符内部的继续偏移", async (t) => {
  const options = await fixture(t, { "source.txt": "🙂🙂\n尾部" });
  const first = await readWorkspaceFile({ ...options, start_line: 2, maxScanBytes: 7 });
  assert.equal(first.stop_reason, "scan_limit");
  assert.equal(first.next_offset, 4);
  const next = await readWorkspaceFile({ ...options, offset: first.next_offset });
  assert.equal(next.content, "🙂\n尾部");
});

test("读后授权复查期间替换文件也不会返回陈旧数据", async (t) => {
  const options = await fixture(t, { "source.txt": "safe" });
  let authorizations = 0;
  await assert.rejects(readWorkspaceFile({ ...options, authorizeRead: async () => {
    authorizations += 1;
    if (authorizations === 5) await fs.writeFile(path.join(options.workspace, options.path), "evil");
    return true;
  } }), /变化/);
});

test("所有页使用有限 chunk 和累计预算，普通短行不重复扫描整文件", async (t) => {
  const options = await fixture(t, { "source.txt": "a".repeat(2_000_000), "lines.txt": `${"x".repeat(100)}\n`.repeat(20_000) });
  let bytesRead = 0;
  const requests = [];
  const fileSystem = {
    ...fs,
    readFile() { assert.fail("不得整文件读取"); },
    async open(...args) {
      const handle = await fs.open(...args);
      return {
        stat: (...values) => handle.stat(...values),
        close: () => handle.close(),
        async read(buffer, offset, length, position) {
          requests.push(length);
          const result = await handle.read(buffer, offset, length, position);
          bytesRead += result.bytesRead;
          return result;
        },
      };
    },
  };
  await readWorkspaceFile({ ...options, offset: 1_500_000, limit: 100, fileSystem });
  assert.ok(bytesRead <= 8 * 1024 * 1024);
  assert.ok(requests.every((length) => length <= 65_536));
  bytesRead = 0;
  await readWorkspaceFile({ ...options, path: "lines.txt", offset: 1_500_000, limit: 100, fileSystem });
  assert.ok(bytesRead < 40_000);
});

test("非法参数、非法 UTF-8 与二进制文件被拒绝", async (t) => {
  const options = await fixture(t, { "source.txt": "safe", "invalid": Buffer.from([0xff]), "binary": Buffer.from([0, 1, 2]) });
  for (const invalid of [{ start_line: 0 }, { line_count: 2001 }, { offset: -1 }, { limit: 0 }, { limit: 65_537 }, { offset: 0, start_line: 1 }]) {
    await assert.rejects(readWorkspaceFile({ ...options, ...invalid }));
  }
  await assert.rejects(readWorkspaceFile({ ...options, path: "invalid" }), /UTF-8/);
  await assert.rejects(readWorkspaceFile({ ...options, path: "binary" }), /文本|二进制/);
});

test("内部符号链接同时检查 alias 与真实路径的 Access Policy 和 Host 读授权", async (t) => {
  const options = await fixture(t, { "source.txt": "safe", ".env": "secret" });
  await fs.symlink("source.txt", path.join(options.workspace, "alias"));
  const authorized = [];
  assert.equal(await readWorkspaceFile({ ...options, path: "alias", authorizeRead: (name) => { authorized.push(name); return true; } }), "safe");
  assert.ok(authorized.includes("alias"));
  assert.ok(authorized.includes("source.txt"));
  await assert.rejects(readWorkspaceFile({ ...options, path: "alias", authorizeRead: (name) => name !== "source.txt" }), /授权|权限/);
  await assert.rejects(readWorkspaceFile({ ...options, path: "alias", authorizeRead: (name) => name !== "alias" }), /授权|权限/);
  await fs.symlink(".env", path.join(options.workspace, "secret-alias"));
  await assert.rejects(readWorkspaceFile({ ...options, path: "secret-alias" }), /受保护/);
  await fs.symlink("source.txt", path.join(options.workspace, ".env-alias"));
  await assert.rejects(readWorkspaceFile({ ...options, path: ".env-alias" }), /受保护/);
});

test("registry read_file 将 context.authorizeRead 与当前会话策略送入安全读取", async (t) => {
  const options = await fixture(t, { "source.txt": "safe" });
  const registry = createToolRegistry(options);
  await assert.rejects(registry.get("read_file").execute({ path: options.path }, { authorizeRead: () => false }), /授权|权限/);
  const denied = Object.create(options.accessPolicy);
  denied.name = "denied";
  denied.assertPath = () => { throw new Error("当前策略拒绝"); };
  const selected = createToolRegistry({ ...options, accessPolicies: new Map([["denied", denied]]) });
  await assert.rejects(selected.get("read_file").execute({ path: options.path }, { state: { permissionProfile: "denied" } }), /当前策略/);
});

test("结构化结果的 JSON 始终保留完整元信息且不超过 Host 默认显示预算", async (t) => {
  const options = await fixture(t, { "source.txt": "\t\"\\🙂\r\n".repeat(10_000) });
  let offset = 0;
  let reconstructed = "";
  do {
    const page = await readWorkspaceFile({ ...options, offset, limit: 65_536 });
    assert.ok(JSON.stringify(page).length <= 10_000);
    assert.equal(typeof JSON.parse(JSON.stringify(page)).complete, "boolean");
    reconstructed += page.content;
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(reconstructed, await fs.readFile(path.join(options.workspace, options.path), "utf8"));
});

test("真实 ToolHost 返回可解析分页，并对 canonical 路径重新应用 Workspace Policy", async (t) => {
  const options = await fixture(t, { "source.txt": "x".repeat(80_000) });
  const registry = createToolRegistry(options);
  const session = new AgentSession({ state: createSession({ provider: "read-test", workspace: options.workspace }), reducer: reduceSession });
  const policy = new WorkspacePolicy({}, { profile: options.accessPolicy });
  const host = new ToolHost({ registry, policy });
  const result = await host.execute({ id: "page", name: "read_file", arguments: { path: options.path, offset: 0, limit: 65_536 } }, { session });
  assert.equal(result.ok, true);
  const page = JSON.parse(result.result);
  assert.equal(page.complete, false);
  assert.equal(page.stop_reason, "response_limit");
  assert.ok(page.next_offset > 0);
  await fs.symlink("source.txt", path.join(options.workspace, "alias"));
  policy.replace({ rules: [{ id: "deny-source", tools: ["read_file"], pathPrefixes: ["source.txt"], decision: "deny" }] });
  const denied = await host.execute({ id: "alias", name: "read_file", arguments: { path: "alias" } }, { session });
  assert.equal(denied.ok, false);
  assert.equal(denied.result.includes("x".repeat(100)), false);
});

test("分页经 Host 与 durable Session 再次脱敏后仍保持 JSON 有效且秘密不泄露", async (t) => {
  const text = [
    "API_KEY=fixture-env-secret", "API_KEY=[REDACTED]", "authorization: bearer fixture-bearer-secret",
    "sshpass -p fixture-ssh-secret ssh host", "expect script host user fixture-expect-secret",
    "password: \"fixture-password-secret\"", "普通文本🙂", "=:-".repeat(4_000),
  ].join("\n");
  const options = await fixture(t, { "source.txt": text });
  const registry = createToolRegistry(options);
  const session = new AgentSession({ state: createSession({ provider: "read-test", workspace: options.workspace }), reducer: reduceSession });
  const host = new ToolHost({ registry, policy: new WorkspacePolicy({}, { profile: options.accessPolicy }) });
  const result = await host.execute({ id: "redacted-page", name: "read_file", arguments: { path: options.path, offset: 0, limit: 65_536 } }, { session });
  assert.equal(result.ok, true, result.result);
  const page = JSON.parse(result.result);
  assert.ok(result.result.length <= 10_000);
  assert.equal(page.complete, false);
  assert.equal(page.stop_reason, "response_limit");
  assert.ok(page.next_offset > 0 && page.next_offset < Buffer.byteLength(text));
  assert.match(page.content, /\[REDACTED\]/);
  assert.deepEqual(page.content.split("\n").slice(0, 7), [
    "[REDACTED]", "API_KEY=[REDACTED]", "[REDACTED]",
    "[REDACTED]", "[REDACTED]", "[REDACTED]", "普通文本🙂",
  ]);
  const durable = session.state.messages.findLast((message) => message.role === "tool").content;
  assert.deepEqual(JSON.parse(durable), page);
  for (const secret of ["fixture-env-secret", "fixture-bearer-secret", "fixture-ssh-secret", "fixture-expect-secret", "fixture-password-secret"]) {
    assert.equal(result.result.includes(secret), false);
    assert.equal(durable.includes(secret), false);
  }
  const continued = await readWorkspaceFile({ ...options, offset: page.next_offset, version: page.version });
  assert.equal(continued.content, Buffer.from(text).subarray(page.next_offset).toString("utf8").slice(0, continued.content.length));
});

test("显式字节偏移落在已有 API_KEY 值中间时也不会绕过完整行脱敏", async (t) => {
  const text = "API_KEY=fixture-short-secret\nordinary\n";
  const options = await fixture(t, { "source.txt": text });
  const registry = createToolRegistry(options);
  const session = new AgentSession({ state: createSession({ provider: "read-test", workspace: options.workspace }), reducer: reduceSession });
  const host = new ToolHost({ registry, policy: new WorkspacePolicy({}, { profile: options.accessPolicy }) });
  const offset = text.indexOf("short-secret");
  const result = await host.execute({ id: "middle-secret", name: "read_file", arguments: { path: options.path, offset } }, { session });
  const page = JSON.parse(result.result);
  assert.equal(page.content.includes("short-secret"), false);
  assert.match(page.content, /\[REDACTED\]/);
  assert.match(page.content, /ordinary/);
  assert.equal(page.redacted, true);
  assert.equal(page.start_offset, offset);
  assert.equal(page.end_offset, Buffer.byteLength(text));
  assert.equal(page.complete, true);
  assert.deepEqual(JSON.parse(session.state.messages.findLast((message) => message.role === "tool").content), page);
});

test("quoted password 结束引号在读取块之外时先补齐上下文再脱敏", async (t) => {
  const marker = "fixture-cross-page-secret";
  const text = `password: "${marker}${"a".repeat(70_000)}"\nordinary\n`;
  const options = await fixture(t, { "source.txt": text });
  const registry = createToolRegistry(options);
  const session = new AgentSession({ state: createSession({ provider: "read-test", workspace: options.workspace }), reducer: reduceSession });
  const host = new ToolHost({ registry, policy: new WorkspacePolicy({}, { profile: options.accessPolicy }) });
  const result = await host.execute({ id: "long-secret", name: "read_file", arguments: { path: options.path, offset: 0, limit: 65_536 } }, { session });
  const page = JSON.parse(result.result);
  assert.equal(page.content.includes(marker), false);
  assert.equal(page.content, "[REDACTED]");
  assert.equal(page.redacted, true);
  assert.equal(page.complete, false);
  assert.ok(page.next_offset > 0);
  const next = JSON.parse(await registry.get("read_file").execute({ path: options.path, offset: page.next_offset, version: page.version }));
  assert.equal(next.content, "[REDACTED]");
  assert.ok(next.next_offset > page.next_offset);
});

test("邻行上下文保留既有 authorization、quoted password 与 expect 跨行脱敏能力", async (t) => {
  const cases = [
    { content: "Authorization:\nBearer fixture-crossline-secret\nsafe\n", line: 2, secret: "fixture-crossline-secret" },
    { content: "password:\n\"fixture-password-line-secret\"\nsafe\n", line: 2, secret: "fixture-password-line-secret" },
    { content: "expect\nscript\nhost\nuser\nfixture-expect-line-secret\nsafe\n", line: 5, secret: "fixture-expect-line-secret" },
    { content: "Authorization:\n\u00a0\n\u00a0\n\u00a0\n\u00a0\n\u00a0\nBearer fixture-blank-lines-secret\nsafe\n", line: 7, secret: "fixture-blank-lines-secret" },
  ];
  const options = await fixture(t, Object.fromEntries(cases.map((item, index) => [`${index}.txt`, item.content])));
  const registry = createToolRegistry(options);
  for (let index = 0; index < cases.length; index += 1) {
    const sample = cases[index];
    const wire = await registry.get("read_file").execute({ path: `${index}.txt`, start_line: sample.line, line_count: 1 });
    const page = JSON.parse(wire);
    assert.equal(page.content.includes(sample.secret), false);
    assert.equal(page.redacted, true);
    assert.equal(page.content, "[REDACTED]\n");
    const after = JSON.parse(await registry.get("read_file").execute({ path: `${index}.txt`, start_line: sample.line + 1, line_count: 1 }));
    assert.equal(after.content, "safe\n");
  }
});

test("无法在上下文预算内补齐长行时不输出未知片段或假称完成", async (t) => {
  const options = await fixture(t, { "source.txt": `password: "${"a".repeat(3_000_000)}"` });
  const page = await readWorkspaceFile({ ...options, offset: 0, limit: 100 });
  assert.equal(page.content, "");
  assert.equal(page.content_omitted, true);
  assert.equal(page.complete, false);
  assert.equal(page.stop_reason, "redaction_context_limit");
  assert.equal(page.next_offset, null);
  assert.match(page.continuation_hint, /范围|Artifact/);
});

test("脱敏与大量 JSON 转义触发响应裁页时，续页按原字节坐标保留全部普通后文", async (t) => {
  const ordinary = (n) => `普通-${n}-🙂${"\t\"\\=:-".repeat(80)}\r\n`;
  const before = Array.from({ length: 15 }, (_, n) => ordinary(n)).join("");
  const after = Array.from({ length: 30 }, (_, n) => ordinary(n + 15)).join("");
  const secretLine = `API_KEY=fixture-${"private".repeat(80)}\r\n`;
  const text = before + secretLine + after;
  const options = await fixture(t, { "source.txt": text });
  const registry = createToolRegistry(options);
  let offset = 0;
  let actual = "";
  let redacted = false;
  let responseLimited = false;
  do {
    const wire = await registry.get("read_file").execute({ path: options.path, offset, limit: 65_536 });
    assert.ok(wire.length <= 10_000);
    const page = JSON.parse(wire);
    assert.equal(page.start_offset, offset);
    assert.equal(page.content_omitted, false);
    assert.equal(page.content.includes("fixture-private"), false);
    actual += page.content;
    redacted ||= page.redacted;
    responseLimited ||= page.stop_reason === "response_limit";
    if (page.next_offset !== null) assert.ok(page.next_offset > offset);
    else { assert.equal(page.complete, true); assert.equal(page.end_offset, Buffer.byteLength(text)); }
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(redacted, true);
  assert.equal(responseLimited, true);
  assert.equal(actual.replaceAll("[REDACTED]", ""), `${before}\r\n${after}`);
});

test("拒绝工作区越界、目录、FIFO，打开必须 NOFOLLOW 和 NONBLOCK", async (t) => {
  const options = await fixture(t, { "source.txt": "safe" });
  await fs.symlink(os.tmpdir(), path.join(options.workspace, "outside"));
  await assert.rejects(readWorkspaceFile({ ...options, path: "../outside" }), /边界/);
  await assert.rejects(readWorkspaceFile({ ...options, path: "outside" }), /边界/);
  await assert.rejects(readWorkspaceFile({ ...options, path: "." }), /普通文件/);
  execFileSync("mkfifo", [path.join(options.workspace, "pipe")]);
  await assert.rejects(readWorkspaceFile({ ...options, path: "pipe" }), /普通文件/);
  const fileSystem = { ...fs, open(target, flags) {
    assert.ok(flags & constants.O_NOFOLLOW);
    assert.ok(flags & constants.O_NONBLOCK);
    return fs.open(target, flags);
  } };
  assert.equal(await readWorkspaceFile({ ...options, fileSystem }), "safe");
});

test("安全句柄最终复查 inode 与内容变化，不返回读取期间被替换的数据", async (t) => {
  const options = await fixture(t, { "source.txt": "safe" });
  await assert.rejects(withWorkspaceFile(options, async (file) => {
    const content = await file.read(0, 4);
    await fs.rename(path.join(options.workspace, options.path), path.join(options.workspace, "old"));
    await fs.writeFile(path.join(options.workspace, options.path), "evil");
    return content;
  }), /变化/);
});

test("普通文件在 open 前被替换为 FIFO 时不会阻塞读取", { timeout: 2000 }, async (t) => {
  const options = await fixture(t, { "source.txt": "safe" });
  let closed = false;
  const fileSystem = { ...fs, async open(target, flags) {
    await fs.unlink(target);
    execFileSync("mkfifo", [target]);
    const handle = await fs.open(target, flags);
    return {
      stat: (...args) => handle.stat(...args),
      close: async () => { closed = true; await handle.close(); },
      read() { assert.fail("不能读取 FIFO"); },
    };
  } };
  await assert.rejects(readWorkspaceFile({ ...options, fileSystem }), /变化/);
  assert.equal(closed, true);
});

test("安全句柄最终复查父目录，阻止目录替换", async (t) => {
  const options = await fixture(t, { "dir/source.txt": "safe" });
  await assert.rejects(withWorkspaceFile({ ...options, path: "dir/source.txt" }, async (file) => {
    const content = await file.read(0, 4);
    await fs.rename(path.join(options.workspace, "dir"), path.join(options.workspace, "old-dir"));
    await fs.symlink("old-dir", path.join(options.workspace, "dir"));
    return content;
  }), /变化/);
});

test("取消中断块扫描并关闭句柄，安全reader拒绝超出累计字节预算", async (t) => {
  const options = await fixture(t, { "source.txt": "a".repeat(100_000) });
  const controller = new AbortController();
  controller.abort(new Error("用户取消"));
  await assert.rejects(readWorkspaceFile({ ...options, signal: controller.signal }), /用户取消/);
  await assert.rejects(withWorkspaceFile({ ...options, maxReadBytes: 10 }, async (file) => {
    await file.read(0, 6);
    await file.read(6, 6);
  }), /预算/);
  const reading = new AbortController();
  let closed = false;
  let chunks = 0;
  const fileSystem = { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    return {
      stat: (...values) => handle.stat(...values),
      close: async () => { closed = true; await handle.close(); },
      async read(...values) {
        chunks += 1;
        const result = await handle.read(...values);
        reading.abort(new Error("扫描取消"));
        return result;
      },
    };
  } };
  await assert.rejects(readWorkspaceFile({ ...options, start_line: 1000, signal: reading.signal, fileSystem }), /扫描取消/);
  assert.equal(chunks, 1);
  assert.equal(closed, true);
});
