import assert from "node:assert/strict";
import test from "node:test";
import {
  createReviewWorkspace,
  projectReviewWorkspace,
} from "../src/web/review-workspace.js";

test("Review Workspace 按 Turn 和工具 occurrence 保留同路径与重复 callId", () => {
  const projection = projectReviewWorkspace({
    turns: [
      turn("turn:1", [entry("one", "repeat", "src/app.js")]),
      turn("turn:2", [entry("two", "repeat", "src/app.js")]),
    ],
  });

  assert.equal(projection.groups.length, 2);
  assert.equal(projection.batches.length, 2);
  assert.equal(projection.summary.batches, 2);
  assert.equal(projection.summary.occurrences, 2);
  assert.equal(projection.summary.uniquePaths, 1);
  assert.notEqual(projection.batches[0].batchKey, projection.batches[1].batchKey);
  assert.match(projection.batches[0].batchKey, /turn%3A1/);
  assert.match(projection.batches[1].batchKey, /turn%3A2/);
  assert.deepEqual(projection.batches.map((batch) => batch.callId), ["repeat", "repeat"]);
});

test("继承变化独立成组，默认选择最新批次并支持 turnKey/runKey 定位", () => {
  const fixture = domFixture();
  const workspace = createReviewWorkspace({ root: fixture.root, loadArtifact: async () => null });
  const executionProjection = {
    inheritedFileChanges: [{
      ...entry("parent-run", "same", "old.txt"),
      entryKey: "inherited-one",
      status: "inherited",
      parentSessionId: "parent",
    }],
    turns: [turn("turn:1", [entry("current-run", "same", "new.txt")])],
  };

  workspace.update({ sessionId: "session", cursor: 4, executionProjection });
  assert.equal(workspace.snapshot().selectedBatch.runKey, "current-run");
  assert.deepEqual(workspace.snapshot().projection.groups.map((group) => group.kind), ["inherited", "turn"]);

  workspace.select({ turnKey: "turn:1", runKey: "current-run", path: "new.txt" });
  assert.equal(workspace.snapshot().selectedPath, "new.txt");
  assert.equal(workspace.snapshot().selectedBatchKey.includes("same"), false);
  workspace.destroy();
});

test("状态投影明确区分采集、Diff、元数据和非法记录且不截断文件列表", () => {
  const manyChanges = Array.from({ length: 80 }, (_, index) => change(`src/file-${index}.js`));
  const validRef = artifactRef("session", "artifact-truncated", "diff");
  const projected = projectReviewWorkspace({
    turns: [turn("turn:status", [
      manifestEntry("capture", { complete: false, captureUnavailable: true, changes: [] }),
      manifestEntry("unavailable", { complete: true, diffUnavailable: true, changes: [change("a.js")] }),
      manifestEntry("truncated", { complete: true, diffTruncated: true, diffArtifact: validRef, changes: [change("b.js")] }),
      manifestEntry("metadata", { complete: true, changes: manyChanges }),
      manifestEntry("invalid", { complete: true, changes: [{ path: "broken", operation: "renamed" }] }),
    ])],
  }, { sessionId: "session" });

  const [capture, unavailable, truncated, metadata, invalid] = projected.batches;
  assert.deepEqual(capture.statusTags, ["complete=false", "captureUnavailable"]);
  assert.deepEqual(unavailable.statusTags, ["diffUnavailable"]);
  assert.deepEqual(truncated.statusTags, ["diffTruncated"]);
  assert.deepEqual(metadata.statusTags, ["metadata_only"]);
  assert.deepEqual(invalid.statusTags, ["invalid"]);
  assert.equal(metadata.changes.length, 80);
  assert.equal(projected.summary.occurrences, 83);

  const fixture = domFixture();
  const workspace = createReviewWorkspace({ root: fixture.root, loadArtifact: async () => null });
  workspace.update({ sessionId: "session", executionProjection: {
    turns: [turn("turn:many", [manifestEntry("many", { complete: true, changes: manyChanges })])],
  } });
  assert.equal(findAll(fixture.root, "review-workspace-file").length, 80);
  assert.equal(findOne(fixture.root, "review-workspace-status").textContent, "仅有文件元数据");
  workspace.destroy();
});

test("整批 Diff 按需加载并以 sessionId、artifactId、sha256 缓存", async () => {
  const fixture = domFixture();
  const content = "--- a/a.js\n+++ b/a.js\n+after\n";
  const ref = artifactRef("session", "artifact-one", content);
  let loads = 0;
  const workspace = createReviewWorkspace({
    root: fixture.root,
    loadArtifact: async ({ sessionId, artifactId }) => {
      loads += 1;
      assert.deepEqual([sessionId, artifactId], ["session", "artifact-one"]);
      return { artifact: loadedArtifact(ref, content) };
    },
  });
  const executionProjection = oneArtifactProjection("run-one", ref);
  workspace.update({ sessionId: "session", cursor: 1, executionProjection });

  findOne(fixture.root, "review-workspace-load-diff").dispatchEvent(new Event("click"));
  assert.equal(findOne(fixture.root, "review-workspace-diff-section").getAttribute("aria-busy"), "true");
  await settle();
  assert.equal(loads, 1);
  assert.equal(workspace.snapshot().artifact.status, "loaded");
  assert.equal(findOne(fixture.root, "review-workspace-diff").textContent, content);
  assert.equal(findOne(fixture.root, "review-workspace-diff-section").getAttribute("aria-busy"), "false");

  workspace.select({
    turnKey: "turn:artifact",
    runKey: "run-one",
    path: "a.js",
  });
  const renderedShell = fixture.root.children[0];
  workspace.update({ sessionId: "session", cursor: 2, executionProjection });
  assert.equal(workspace.snapshot().artifact.status, "loaded");
  assert.equal(workspace.snapshot().cacheKeys.length, 1);
  assert.equal(workspace.snapshot().selectedPath, "a.js");
  assert.equal(findOne(fixture.root, "review-workspace-file").getAttribute("aria-current"), "true");
  assert.equal(fixture.root.children[0], renderedShell);
  assert.equal(loads, 1);
  workspace.destroy();
});

test("快速切换批次时迟到的 Artifact 不会覆盖当前 Diff", async () => {
  const fixture = domFixture();
  const firstContent = "first\n";
  const secondContent = "second\n";
  const firstRef = artifactRef("session", "artifact-first", firstContent, "a");
  const secondRef = artifactRef("session", "artifact-second", secondContent, "b");
  const pending = new Map();
  const workspace = createReviewWorkspace({
    root: fixture.root,
    loadArtifact: ({ artifactId }) => new Promise((resolve) => pending.set(artifactId, resolve)),
  });
  workspace.update({ sessionId: "session", executionProjection: {
    turns: [turn("turn:race", [
      manifestEntry("run-first", manifestWithArtifact("first.txt", firstRef)),
      manifestEntry("run-second", manifestWithArtifact("second.txt", secondRef)),
    ])],
  } });
  const [first, second] = workspace.snapshot().projection.batches;

  workspace.select({ batchKey: first.batchKey });
  findOne(fixture.root, "review-workspace-load-diff").dispatchEvent(new Event("click"));
  await settle(1);
  workspace.select({ batchKey: second.batchKey });
  findOne(fixture.root, "review-workspace-load-diff").dispatchEvent(new Event("click"));
  await settle(1);

  pending.get("artifact-second")({ artifact: loadedArtifact(secondRef, secondContent) });
  await settle();
  assert.equal(workspace.snapshot().selectedBatchKey, second.batchKey);
  assert.equal(findOne(fixture.root, "review-workspace-diff").textContent, secondContent);

  pending.get("artifact-first")({ artifact: loadedArtifact(firstRef, firstContent) });
  await settle();
  assert.equal(workspace.snapshot().selectedBatchKey, second.batchKey);
  assert.equal(findOne(fixture.root, "review-workspace-diff").textContent, secondContent);
  workspace.destroy();
});

test("快速切换 Session 时旧请求不会污染新 Session", async () => {
  const fixture = domFixture();
  const oldContent = "old session\n";
  const newContent = "new session\n";
  const oldRef = artifactRef("old-session", "shared-artifact", oldContent, "c");
  const newRef = artifactRef("new-session", "shared-artifact", newContent, "d");
  const pending = new Map();
  const workspace = createReviewWorkspace({
    root: fixture.root,
    loadArtifact: ({ sessionId }) => new Promise((resolve) => pending.set(sessionId, resolve)),
  });

  workspace.update({ sessionId: "old-session", executionProjection: oneArtifactProjection("old-run", oldRef) });
  findOne(fixture.root, "review-workspace-load-diff").dispatchEvent(new Event("click"));
  await settle(1);
  workspace.update({ sessionId: "new-session", executionProjection: oneArtifactProjection("new-run", newRef) });
  findOne(fixture.root, "review-workspace-load-diff").dispatchEvent(new Event("click"));
  await settle(1);

  pending.get("new-session")(loadedArtifact(newRef, newContent));
  await settle();
  pending.get("old-session")(loadedArtifact(oldRef, oldContent));
  await settle();

  assert.equal(workspace.snapshot().sessionId, "new-session");
  assert.equal(workspace.snapshot().selectedBatch.runKey, "new-run");
  assert.equal(findOne(fixture.root, "review-workspace-diff").textContent, newContent);
  assert.equal(workspace.snapshot().cacheKeys.length, 1);
  assert.equal(workspace.snapshot().cacheKeys[0].includes("new-session"), true);
  workspace.destroy();
});

test("Artifact 元数据不匹配时 fail-closed 且可以重试", async () => {
  const fixture = domFixture();
  const content = "safe diff\n";
  const ref = artifactRef("session", "artifact-retry", content);
  let attempts = 0;
  const workspace = createReviewWorkspace({
    root: fixture.root,
    loadArtifact: async () => {
      attempts += 1;
      return attempts === 1
        ? { ...loadedArtifact(ref, content), sessionId: "other-session" }
        : loadedArtifact(ref, content);
    },
  });
  workspace.update({ sessionId: "session", executionProjection: oneArtifactProjection("retry-run", ref) });

  findOne(fixture.root, "review-workspace-load-diff").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(workspace.snapshot().artifact.status, "error");
  assert.match(workspace.snapshot().artifact.error, /sessionId/);
  assert.equal(findAll(fixture.root, "review-workspace-diff").length, 0);

  findOne(fixture.root, "review-workspace-load-diff").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(attempts, 2);
  assert.equal(workspace.snapshot().artifact.status, "loaded");
  assert.equal(findOne(fixture.root, "review-workspace-diff").textContent, content);
  workspace.destroy();
});

test("文件路径和 Diff 只通过 textContent 渲染", async () => {
  const fixture = domFixture();
  const dangerousPath = '<img src=x onerror="globalThis.pwned=true">';
  const dangerousDiff = '<script>globalThis.pwned=true</script>\n';
  const ref = artifactRef("session", "artifact-html", dangerousDiff);
  const workspace = createReviewWorkspace({
    root: fixture.root,
    loadArtifact: async () => loadedArtifact(ref, dangerousDiff),
  });
  workspace.update({ sessionId: "session", executionProjection: {
    turns: [turn("turn:html", [manifestEntry("html-run", manifestWithArtifact(dangerousPath, ref))])],
  } });
  assert.equal(findOne(fixture.root, "review-workspace-path").textContent, dangerousPath);
  findOne(fixture.root, "review-workspace-load-diff").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(findOne(fixture.root, "review-workspace-diff").textContent, dangerousDiff);
  assert.equal(fixture.document.innerHTMLWrites, 0);
  workspace.destroy();
});

function turn(turnKey, entries) {
  return { execution: { turnKey, fileChanges: { entries } } };
}

function entry(runKey, callId, path) {
  return manifestEntry(runKey, {
    complete: true,
    changes: [change(path)],
  }, callId);
}

function manifestEntry(runKey, manifest, callId = "same") {
  return {
    entryKey: runKey,
    runKey,
    callId,
    tool: "write_file",
    status: "succeeded",
    manifest,
  };
}

function change(path, operation = "modified") {
  return { path, operation, before: { kind: "file" }, after: { kind: "file" } };
}

function manifestWithArtifact(path, ref) {
  return { complete: true, changes: [change(path)], diffArtifact: ref };
}

function oneArtifactProjection(runKey, ref) {
  return { turns: [turn("turn:artifact", [manifestEntry(runKey, manifestWithArtifact("a.js", ref))])] };
}

function artifactRef(sessionId, id, content, digestCharacter = "a") {
  return {
    id,
    sessionId,
    kind: "file_diff",
    sha256: digestCharacter.repeat(64),
    byteSize: Buffer.byteLength(content),
  };
}

function loadedArtifact(ref, content) {
  return { ...ref, content };
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function domFixture() {
  const document = new FakeDocument();
  const root = document.createElement("div");
  return { document, root };
}

function findOne(root, className) {
  const matches = findAll(root, className);
  assert.equal(matches.length > 0, true, `找不到 .${className}`);
  return matches[0];
}

function findAll(root, className) {
  const matches = [];
  const visit = (node) => {
    if (node.classList?.contains(className)) matches.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return matches;
}

class FakeDocument {
  constructor() {
    this.innerHTMLWrites = 0;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
}

class FakeElement extends EventTarget {
  constructor(ownerDocument, tagName) {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.classes = new Set();
    this._textContent = "";
    this.disabled = false;
    this.type = "";
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classes].join(" ");
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set innerHTML(_value) {
    this.ownerDocument.innerHTMLWrites += 1;
    throw new Error("测试禁止 innerHTML");
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
    this._textContent = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}
