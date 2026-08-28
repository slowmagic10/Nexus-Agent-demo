// FOUNDATION — bounded workspace snapshots and deterministic text diff manifests.
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import nodePath from "node:path";

const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_FILE_BYTES = 256_000;
const DEFAULT_MAX_TOTAL_BYTES = 16_000_000;
const DEFAULT_MAX_DIFF_CHARS = 1_000_000;
const IGNORED_SEGMENTS = new Set([".git", ".nexus", "node_modules"]);

export async function beginFileChangeCapture({
  workspace,
  mode = "workspace",
  paths = [],
  maxFiles = DEFAULT_MAX_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxDiffChars = DEFAULT_MAX_DIFF_CHARS,
} = {}) {
  const root = await fs.realpath(nodePath.resolve(requiredText(workspace, "workspace")));
  if (!["workspace", "paths"].includes(mode)) throw new Error(`File Change Capture mode 无效：${mode}`);
  const options = validateLimits({ maxFiles, maxFileBytes, maxTotalBytes, maxDiffChars });
  const targets = mode === "paths" ? normalizeTargets(root, paths) : [];
  const before = await snapshotWorkspace(root, { mode, targets, ...options });
  return Object.freeze({ root, mode, targets, options, before });
}

export async function finishFileChangeCapture(capture) {
  if (!capture?.root || !capture.before || !capture.options) throw new Error("File Change Capture 无效");
  const after = await snapshotWorkspace(capture.root, {
    mode: capture.mode,
    targets: capture.targets,
    ...capture.options,
  });
  const changes = compareSnapshots(capture.before.files, after.files);
  const rendered = renderDiff(changes, capture.options.maxDiffChars);
  return {
    manifest: {
      version: 1,
      complete: capture.before.complete && after.complete,
      summary: summarize(changes),
      changes: changes.map(({ relativePath, operation, before, after: next }) => ({
        path: relativePath,
        operation,
        before: publicFileRecord(before),
        after: publicFileRecord(next),
      })),
      diffTruncated: rendered.truncated,
    },
    diff: rendered.content,
  };
}

async function snapshotWorkspace(root, options) {
  const state = { files: new Map(), complete: true, readBytes: 0, seenFiles: 0 };
  if (options.mode === "paths") {
    for (const target of options.targets) await snapshotTarget(root, target, options, state);
  } else {
    await walk(root, "", options, state);
  }
  return { files: state.files, complete: state.complete };
}

async function walk(root, relativeDir, options, state) {
  let entries;
  try {
    entries = await fs.readdir(nodePath.join(root, relativeDir), { withFileTypes: true });
  } catch {
    state.complete = false;
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = normalizeRelative(nodePath.join(relativeDir, entry.name));
    if (ignoredPath(relativePath)) continue;
    if (entry.isSymbolicLink()) {
      if (state.seenFiles >= options.maxFiles) {
        state.complete = false;
        return;
      }
      state.seenFiles += 1;
      const record = await readSymlinkRecord(nodePath.join(root, relativePath), state);
      if (record) state.files.set(relativePath, record);
      continue;
    }
    if (entry.isDirectory()) {
      await walk(root, relativePath, options, state);
      continue;
    }
    if (!entry.isFile()) continue;
    if (state.seenFiles >= options.maxFiles) {
      state.complete = false;
      return;
    }
    state.seenFiles += 1;
    const record = await readFileRecord(nodePath.join(root, relativePath), options, state);
    if (record) state.files.set(relativePath, record);
  }
}

async function snapshotTarget(root, target, options, state) {
  const relativePath = normalizeRelative(nodePath.relative(root, target));
  if (!relativePath || ignoredPath(relativePath)) return;
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    state.complete = false;
    return;
  }
  if (stat.isSymbolicLink()) {
    state.seenFiles += 1;
    const linkRecord = await readSymlinkRecord(target, state, stat);
    if (linkRecord) state.files.set(relativePath, linkRecord);
    await snapshotSymlinkTarget(root, target, options, state);
    return;
  }
  if (stat.isDirectory()) {
    await walk(root, relativePath, options, state);
    return;
  }
  if (!stat.isFile()) return;
  state.seenFiles += 1;
  const record = await readFileRecord(target, options, state, stat);
  if (record) state.files.set(relativePath, record);
}

async function readFileRecord(file, options, state, knownStat = null) {
  try {
    const stat = knownStat || await fs.lstat(file);
    const base = { kind: "file", byteSize: stat.size, mtimeMs: stat.mtimeMs, sha256: null, text: null };
    if (stat.size > options.maxFileBytes || state.readBytes + stat.size > options.maxTotalBytes) {
      state.complete = false;
      return base;
    }
    const bytes = await fs.readFile(file);
    state.readBytes += bytes.byteLength;
    return {
      ...base,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: isText(bytes) ? bytes.toString("utf8") : null,
    };
  } catch {
    state.complete = false;
    return null;
  }
}

async function readSymlinkRecord(file, state, knownStat = null) {
  try {
    const stat = knownStat || await fs.lstat(file);
    const linkTarget = await fs.readlink(file);
    const bytes = Buffer.from(linkTarget, "utf8");
    state.readBytes += bytes.byteLength;
    return {
      kind: "symlink",
      byteSize: bytes.byteLength,
      mtimeMs: stat.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: `symlink -> ${linkTarget}\n`,
      linkTarget,
    };
  } catch {
    state.complete = false;
    return null;
  }
}

async function snapshotSymlinkTarget(root, link, options, state) {
  try {
    const resolved = await fs.realpath(link);
    const relative = nodePath.relative(root, resolved);
    if (!relative || relative.startsWith("..") || nodePath.isAbsolute(relative)) {
      state.complete = false;
      return;
    }
    await snapshotTarget(root, resolved, options, state);
  } catch {
    state.complete = false;
  }
}

function compareSnapshots(before, after) {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];
  for (const relativePath of paths) {
    const previous = before.get(relativePath) || null;
    const next = after.get(relativePath) || null;
    const operation = !previous ? "created" : !next ? "deleted" : changed(previous, next) ? "modified" : null;
    if (operation) changes.push({ relativePath, operation, before: previous, after: next });
  }
  return changes;
}

function changed(left, right) {
  if (left.sha256 && right.sha256) return left.sha256 !== right.sha256;
  return left.byteSize !== right.byteSize || left.mtimeMs !== right.mtimeMs;
}

function renderDiff(changes, maxChars) {
  let content = "";
  let truncated = false;
  for (const change of changes) {
    const chunk = renderFileDiff(change);
    if (!chunk) continue;
    if (content.length + chunk.length > maxChars) {
      content += chunk.slice(0, Math.max(0, maxChars - content.length));
      truncated = true;
      break;
    }
    content += chunk;
  }
  if (truncated) content += "\n…Diff 已达到采集上限…\n";
  return { content, truncated };
}

function renderFileDiff({ relativePath, operation, before, after }) {
  if ((before && before.text === null) || (after && after.text === null)) return "";
  const beforeText = before?.text || "";
  const afterText = after?.text || "";
  const oldLines = splitLines(beforeText);
  const newLines = splitLines(afterText);
  const from = operation === "created" ? "/dev/null" : `a/${relativePath}`;
  const to = operation === "deleted" ? "/dev/null" : `b/${relativePath}`;
  return [
    `--- ${from}`,
    `+++ ${to}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function splitLines(value) {
  if (!value) return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function summarize(changes) {
  const summary = { created: 0, modified: 0, deleted: 0, total: changes.length };
  for (const change of changes) summary[change.operation] += 1;
  return summary;
}

function publicFileRecord(record) {
  if (!record) return null;
  return {
    kind: record.kind,
    byteSize: record.byteSize,
    sha256: record.sha256,
    ...(record.kind === "symlink" ? { linkTarget: record.linkTarget } : {}),
  };
}

function normalizeTargets(root, values) {
  if (!Array.isArray(values) || !values.length) throw new Error("paths 模式必须提供至少一个路径");
  return [...new Set(values.map((value) => {
    const requested = requiredText(value, "path");
    const target = nodePath.resolve(root, requested);
    const relative = nodePath.relative(root, target);
    if (relative.startsWith("..") || nodePath.isAbsolute(relative)) throw new Error(`File Change Capture 路径越出 workspace：${requested}`);
    return target;
  }))].sort();
}

function ignoredPath(relativePath) {
  const segments = normalizeRelative(relativePath).split("/");
  return segments.some((segment) => IGNORED_SEGMENTS.has(segment) || segment.startsWith(".env"));
}

function normalizeRelative(value) {
  return value.split(nodePath.sep).join("/").replace(/^\.\//, "");
}

function isText(bytes) {
  if (bytes.includes(0)) return false;
  const sample = bytes.subarray(0, 8_192);
  let controls = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return sample.length === 0 || controls / sample.length < 0.02;
}

function validateLimits(values) {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`File Change Capture ${name} 必须是正整数`);
  }
  return values;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`File Change Capture ${label} 无效`);
  return value;
}
