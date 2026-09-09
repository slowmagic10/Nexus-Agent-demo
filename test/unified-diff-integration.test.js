import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginFileChangeCapture, finishFileChangeCapture } from "../src/artifacts/file-change-manifest.js";
import { renderUnifiedDiff } from "../src/artifacts/unified-diff.js";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { SessionStore } from "../src/persistence/session-store.js";
import { redactSensitiveText } from "../src/security/redact.js";
import { ToolHost } from "../src/tools/host.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { projectReviewWorkspace } from "../src/web/review-workspace.js";

test("真实文件 Diff 的分离 hunk 可按行号精确重建修改后文本", async (t) => {
  const before = Array.from({ length: 80 }, (_, index) => `line ${index + 1}\n`).join("");
  const after = before.replace("line 12\n", "replacement 十二 😀\n").replace("line 67\n", "replacement 67\n");
  const { diff, manifest } = await capture(t, before, after);
  assert.equal(manifest.diffTruncated, false);
  assert.equal(manifest.complete, true);
  assert.equal(diff.match(/^@@ /gm)?.length, 2);
  assert.ok(diff.length < before.length, "上下文 Diff 应省略远离改动的正文");
  assert.equal(applySingleFileDiff(before, diff), after);
});

test("真实文件 Diff 区分创建、删除、空文件和所有末尾 LF 变化", async (t) => {
  const cases = [
    [null, "first\nsecond\n"], ["first\nsecond\n", null],
    ["", "inserted"], ["removed", ""],
    ["same", "same\n"], ["same\n", "same"],
    ["one\r\ntwo\r\n", "one\r\nTWO\r\n"],
    ["one\r\ntwo", "one\r\nTWO"],
    ["same\r\n", "same\n"],
    ["a\nb\nc\n", "start\na\nb\nc\nend\n"],
    ["start\na\nb\nc\nend\n", "a\nb\nc\n"],
    ["\n\n", "\n"], ["", "\n"],
  ];
  for (const [before, after] of cases) {
    const result = await capture(t, before, after);
    assert.equal(result.manifest.diffTruncated, false);
    assert.equal(applySingleFileDiff(before || "", result.diff), after || "", JSON.stringify({ before, after }));
  }
});

test("重复行与确定性混合编辑的完整 Diff 不丢失内容", async (t) => {
  let seed = 84219;
  const random = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const alphabet = ["repeat\n", "\n", "甲😀\n", "brace {\n", "return;\r\n", "} end\n"];
  for (let trial = 0; trial < 36; trial += 1) {
    const oldLines = Array.from({ length: 8 + random(45) }, () => alphabet[random(alphabet.length)]);
    const newLines = [...oldLines];
    for (let edit = 0; edit < 4; edit += 1) {
      newLines.splice(random(newLines.length + 1), random(4), ...Array.from({ length: random(4) }, () => alphabet[random(alphabet.length)]));
    }
    let before = oldLines.join("");
    let after = newLines.join("");
    if (trial % 3 === 0) before = before.replace(/\n$/, "");
    if (trial % 4 === 0) after = after.replace(/\n$/, "");
    if (before === after) after += "changed\n";
    const result = await capture(t, before, after);
    assert.equal(result.manifest.diffTruncated, false);
    assert.equal(applySingleFileDiff(before, result.diff), after, `trial ${trial}`);
  }
});

test("Diff 先对完整正文脱敏，跨行凭据修改保留真实可见上下文", async (t) => {
  const before = "Authorization:\n  Bearer\n  synthetic-original-secret\nvisible old\n";
  const after = "Authorization:\n  Bearer\n  synthetic-updated-secret\nvisible new\n";
  const result = await capture(t, before, after);
  assert.doesNotMatch(result.diff, /synthetic-(?:original|updated)-secret/);
  assert.match(result.diff, /\[REDACTED\]/);
  assert.equal(applySingleFileDiff(redactSensitiveText(before), result.diff), redactSensitiveText(after));
});

test("仅凭据变化仍有修改元数据和明确的脱敏后无可见差异说明", async (t) => {
  const result = await capture(t, "ACCESS_TOKEN=synthetic-before\n", "ACCESS_TOKEN=synthetic-after\n");
  assert.equal(result.manifest.summary.modified, 1);
  assert.notEqual(result.manifest.changes[0].before.sha256, result.manifest.changes[0].after.sha256);
  assert.equal(result.manifest.diffTruncated, false);
  assert.ok(result.diff.length > 0);
  assert.doesNotMatch(result.diff, /synthetic-before|synthetic-after/);
  assert.doesNotMatch(result.diff, /^@@ /m);
  assert.match(result.diff, /redact|脱敏/i);
});

test("路径中的换行、Tab 和引号不能伪造额外 Diff 文件头", async (t) => {
  const maliciousPath = 'normal\n--- a/forged\n+++ b/forged\t"\\tail.txt';
  const { diff, manifest } = await capture(t, "before\n", "after\n", { file: maliciousPath });
  assert.equal(manifest.changes[0].path, maliciousPath);
  assert.equal(diff.match(/^--- /gm)?.length, 1);
  assert.equal(diff.match(/^\+\+\+ /gm)?.length, 1);
  const headers = diff.split("\n").slice(0, 2);
  for (const header of headers) assert.doesNotMatch(header, /[\r\t]/);
  assert.equal(applySingleFileDiff("before\n", diff), "after\n");
});

test("Diff 截断把提示计入上限并保持 Unicode 与脱敏边界", async (t) => {
  const after = `Authorization: Bearer synthetic-never-publish\n${"😀安全内容".repeat(300)}\n`;
  for (const maxDiffChars of [1, 18, 65, 128, 1000]) {
    const result = await capture(t, "old\n", after, { maxDiffChars });
    assert.equal(result.manifest.diffTruncated, true);
    assert.equal(result.manifest.complete, true, "采集覆盖状态不能与渲染截断状态混淆");
    assert.ok(result.diff.length <= maxDiffChars, `${result.diff.length} > ${maxDiffChars}`);
    assert.equal(result.diff.isWellFormed(), true);
    assert.doesNotMatch(result.diff, /synthetic-never-publish/);
  }
});

test("真实 ToolHost 的上下文 Diff 在持久化、分支和导入后仍可精确重建", async (t) => {
  const workspace = await fixture(t);
  const before = Array.from({ length: 50 }, (_, index) => `line ${index}\n`).join("");
  const after = before.replace("line 25\n", "changed 25\n");
  await fs.writeFile(path.join(workspace, "document.txt"), before);
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(() => store.close());
  const initial = createSession({ id: "context-diff-session", provider: "offline-test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts });
  const host = new ToolHost({ registry, artifactStore: store.artifacts });
  const result = await host.execute({ id: "context-diff-call", name: "write_file", arguments: { path: "document.txt", content: after } }, {
    session, requestApproval: async () => ({ approved: true, scope: "once" }),
  });
  assert.equal(result.ok, true);
  const manifest = result.fileChanges;
  const artifact = await store.artifacts.get(manifest.diffArtifact.id, { sessionId: session.id });
  assert.equal(applySingleFileDiff(before, artifact.content), after);
  assert.ok(artifact.content.length < before.length);
  const projection = projectReviewWorkspace({ turns: [{ execution: { turnKey: "context-turn", fileChanges: { entries: [{ manifest }] } } }] }, { sessionId: session.id });
  assert.deepEqual(projection.batches[0].statusTags, []);
  assert.equal(projection.batches[0].artifactRef.id, artifact.id);

  const branch = store.branchSession(session.id, { id: "context-diff-branch", cursor: session.cursor, provider: initial.provider, workspace });
  assert.equal((await store.artifacts.get(artifact.id, { sessionId: branch.id })).content, artifact.content);
  const importedWorkspace = await fixture(t);
  const importedStore = new SessionStore(path.join(importedWorkspace, ".nexus", "nexus.db"), { workspace: importedWorkspace });
  t.after(() => importedStore.close());
  const imported = importedStore.importJournal(store.exportJournal(session.id), { id: "context-diff-imported", workspace: importedWorkspace });
  const importedResult = importedStore.listSessionEvents(imported.id).find((event) => event.type === "TOOL_RESULT");
  const importedArtifact = await importedStore.artifacts.get(importedResult.fileChanges.diffArtifact.id, { sessionId: imported.id });
  assert.equal(importedArtifact.content, artifact.content);
  assert.equal(applySingleFileDiff(before, importedArtifact.content), after);
});

test("ToolHost 不对已脱敏 Diff 再套正文模式从而吞掉新增行标记", async (t) => {
  const workspace = await fixture(t);
  const before = "expect a b\nold\n";
  const after = "expect a b\nnew\n";
  assert.equal(redactSensitiveText(before), before);
  assert.equal(redactSensitiveText(after), after);
  await fs.writeFile(path.join(workspace, "document.txt"), before);
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"), { workspace });
  t.after(() => store.close());
  const initial = createSession({ id: "diff-redaction-boundary", provider: "offline-test", workspace });
  store.ensureJournal(initial);
  const session = new AgentSession({ state: initial, reducer: reduceSession, journal: store });
  const registry = createToolRegistry({ workspace, artifactStore: store.artifacts });
  const host = new ToolHost({ registry, artifactStore: store.artifacts });
  const result = await host.execute({ id: "diff-redaction-boundary-call", name: "write_file", arguments: { path: "document.txt", content: after } }, {
    session, requestApproval: async () => ({ approved: true, scope: "once" }),
  });
  assert.equal(result.ok, true);
  const artifact = await store.artifacts.get(result.fileChanges.diffArtifact.id, { sessionId: session.id });
  assert.equal(applySingleFileDiff(before, artifact.content), after);
});

test("Diff 工作预算耗尽及无唯一锚点时的替换块仍能重建原文", () => {
  const cases = [
    [Array.from({ length: 300 }, (_, index) => `unique ${index}\n`).join(""), Array.from({ length: 300 }, (_, index) => `unique ${(index + 20) % 300}\n`).join("")],
    ["a\nb\n".repeat(400), "b\na\n".repeat(400)],
    ["repeat\n".repeat(200) + "end", "start\n" + "repeat\n".repeat(200)],
  ];
  for (const [before, after] of cases) {
    for (const maxWork of [1, 10, 64, 1_000_000]) {
      const result = renderUnifiedDiff([textChange(before, after)], 100_000, { maxWork });
      assert.equal(result.truncated, false);
      if (maxWork === 1) assert.equal(result.stats.workLimited, true);
      assert.equal(applySingleFileDiff(before, result.content), after);
    }
  }
});

test("截断只移除完整 hunk，剩余行号、计数、EOF 和文件头保持有效", () => {
  const before = Array.from({ length: 100 }, (_, index) => `old ${index}\n`).join("");
  const after = before.replace("old 5\n", "first 😀\n").replace("old 45\n", "second 😀\n").replace("old 95\n", "third 😀\n");
  for (let maxChars = 1; maxChars <= 420; maxChars += 7) {
    const result = renderUnifiedDiff([textChange(before, after)], maxChars);
    assert.ok(result.content.length <= maxChars);
    assert.equal(result.content.isWellFormed(), true);
    const headerCount = result.content.match(/^--- /gm)?.length || 0;
    const hunks = result.content.match(/^@@ /gm)?.length || 0;
    assert.equal(headerCount, hunks ? 1 : 0);
    assert.equal(result.stats.files, headerCount);
    assert.equal(result.stats.hunks, hunks);
    if (hunks) applySingleFileDiff(before, result.content);
    if (!result.truncated) assert.equal(applySingleFileDiff(before, result.content), after);
  }
});

test("新增和删除空文件保留操作说明，不误称脱敏后无差异", async (t) => {
  for (const [before, after, operation] of [[null, "", "created"], ["", null, "deleted"]]) {
    const result = await capture(t, before, after);
    assert.equal(result.manifest.summary[operation], 1);
    assert.equal(result.manifest.diffTruncated, false);
    assert.match(result.diff, /空文件/);
    assert.doesNotMatch(result.diff, /脱敏|^@@ /m);
  }
});

function textChange(before, after) {
  return { relativePath: "document.txt", operation: "modified", before: { text: before }, after: { text: after } };
}

async function capture(t, before, after, { file = "document.txt", ...limits } = {}) {
  const workspace = await fixture(t);
  const target = path.join(workspace, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (before !== null) await fs.writeFile(target, before);
  const started = await beginFileChangeCapture({ workspace, mode: "paths", paths: [file], ...limits });
  if (after === null) await fs.rm(target);
  else await fs.writeFile(target, after);
  return await finishFileChangeCapture(started);
}

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-unified-diff-integration-"));
  t.after(async () => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}

// Independent patch consumer: it verifies the claimed hunk coordinates/counts,
// every removed/context line, and the exact EOF bytes before rebuilding output.
// It neither shares the diff algorithm nor invokes git, a service, or a model.
function applySingleFileDiff(before, diff) {
  const original = before.match(/[^\n]*\n|[^\n]+$/g) || [];
  const patch = diff.split("\n");
  const output = [];
  let consumed = 0;
  let hunks = 0;
  for (let index = 0; index < patch.length; index += 1) {
    if (!patch[index].startsWith("@@ ")) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patch[index]);
    assert.ok(header, `invalid hunk: ${patch[index]}`);
    const oldCount = Number(header[2] ?? 1);
    const newCount = Number(header[4] ?? 1);
    const oldStart = Number(header[1]) - (oldCount ? 1 : 0);
    const newStart = Number(header[3]) - (newCount ? 1 : 0);
    assert.ok(oldStart >= consumed, "hunks must be monotonic and nonoverlapping");
    output.push(...original.slice(consumed, oldStart));
    consumed = oldStart;
    assert.equal(output.length, newStart, "new hunk offset must include preceding edits");
    const oldBody = [];
    const newBody = [];
    while (index + 1 < patch.length && (oldBody.length < oldCount || newBody.length < newCount)) {
      const line = patch[++index];
      assert.ok([" ", "+", "-"].includes(line[0]), `unexpected hunk line: ${line}`);
      let body = `${line.slice(1)}\n`;
      if (patch[index + 1] === "\\ No newline at end of file") { body = body.slice(0, -1); index += 1; }
      if (line[0] !== "+") oldBody.push(body);
      if (line[0] !== "-") newBody.push(body);
    }
    assert.equal(oldBody.length, oldCount);
    assert.equal(newBody.length, newCount);
    assert.deepEqual(original.slice(consumed, consumed + oldCount), oldBody);
    consumed += oldCount;
    output.push(...newBody);
    hunks += 1;
  }
  assert.ok(hunks > 0, "expected a complete text patch");
  output.push(...original.slice(consumed));
  return output.join("");
}
