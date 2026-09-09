// FOUNDATION — bounded workspace snapshots and deterministic text diff manifests.
import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import nodePath from "node:path";
import { createPermissionProfile } from "../tools/permission-profile.js";
import { renderUnifiedDiff } from "./unified-diff.js";

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
  authorizeRead = null,
} = {}) {
  const root = await fs.realpath(nodePath.resolve(requiredText(workspace, "workspace")));
  if (!["workspace", "paths"].includes(mode)) throw new Error(`File Change Capture mode 无效：${mode}`);
  const options = validateLimits({ maxFiles, maxFileBytes, maxTotalBytes, maxDiffChars });
  if (authorizeRead !== null && typeof authorizeRead !== "function") throw new Error("File Change Capture authorizeRead 必须是函数");
  const defaultPolicy = authorizeRead ? null : createPermissionProfile({ workspace: root, name: "workspace-auto" });
  options.authorizeRead = authorizeRead || ((relative) => defaultPolicy.assertPath(relative, "read"));
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
  // A path excluded from either snapshot cannot be called created/deleted safely.
  // In particular, a newly denied read must never publish the earlier body as a deletion diff.
  const excluded = [...capture.before.excluded, ...after.excluded];
  const comparable = (files) => new Map([...files].filter(([file]) => !excluded.some((prefix) => pathWithin(prefix, file))));
  const changes = compareSnapshots(comparable(capture.before.files), comparable(after.files));
  const rendered = renderUnifiedDiff(changes, capture.options.maxDiffChars);
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
      diffFormat: rendered.format,
      diffStats: rendered.stats,
      issues: [
        ...capture.before.issues.map((issue) => ({ phase: "before", ...issue })),
        ...after.issues.map((issue) => ({ phase: "after", ...issue })),
      ],
    },
    diff: rendered.content,
  };
}

async function snapshotWorkspace(root, options) {
  const state = { files: new Map(), complete: true, readBytes: 0, seenFiles: 0, visited: new Set(), excluded: new Set(), issues: [] };
  if (options.mode === "paths") {
    for (const target of options.targets) await snapshotTarget(root, target, options, state);
  } else {
    await snapshotTarget(root, root, options, state);
  }
  return { files: state.files, complete: state.complete, excluded: state.excluded, issues: state.issues };
}

async function walk(root, directory, relativeDir, options, state, stat) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
    await assertStablePath(directory, stat);
  } catch {
    exclude(state, relativeDir, "read_unavailable");
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = normalizeRelative(nodePath.join(relativeDir, entry.name));
    if (ignoredPath(relativePath)) continue;
    if (state.seenFiles >= options.maxFiles) {
      exclude(state, relativeDir, "file_limit");
      return;
    }
    await snapshotTarget(root, nodePath.join(root, relativePath), options, state);
  }
}

async function snapshotTarget(root, target, options, state) {
  const relativePath = normalizeRelative(nodePath.relative(root, target)) || ".";
  if (ignoredPath(relativePath) || state.visited.has(relativePath)) return;
  state.visited.add(relativePath);
  if (!await mayRead(relativePath, options, state)) return;
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    exclude(state, relativePath, "read_unavailable");
    return;
  }
  if (stat.isSymbolicLink()) {
    if (state.seenFiles >= options.maxFiles) return exclude(state, relativePath, "file_limit");
    state.seenFiles += 1;
    const linkRecord = await readSymlinkRecord(root, target, relativePath, options, state, stat);
    if (linkRecord) state.files.set(relativePath, linkRecord);
    if (linkRecord && options.mode === "paths") await snapshotSymlinkTarget(root, target, options, state);
    return;
  }
  const canonical = await readableCanonical(root, target, relativePath, options, state);
  if (!canonical) return;
  if (stat.isDirectory()) {
    await walk(root, canonical, relativePath, options, state, stat);
    return;
  }
  if (!stat.isFile()) return;
  if (state.seenFiles >= options.maxFiles) return exclude(state, relativePath, "file_limit");
  state.seenFiles += 1;
  const record = await readFileRecord(canonical, relativePath, options, state, stat);
  if (record) state.files.set(relativePath, record);
}

async function readFileRecord(file, relativePath, options, state, stat) {
  let handle;
  try {
    const base = { kind: "file", byteSize: stat.size, mtimeMs: stat.mtimeMs, sha256: null, text: null };
    if (stat.size > options.maxFileBytes || state.readBytes + stat.size > options.maxTotalBytes) {
      exclude(state, relativePath, "byte_limit", false);
      return base;
    }
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(opened, stat)) throw new Error("path changed");
    await assertStablePath(file, stat);
    if (opened.size > options.maxFileBytes || state.readBytes + opened.size > options.maxTotalBytes) {
      exclude(state, relativePath, "byte_limit", false);
      return base;
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    state.readBytes += bytes.byteLength;
    const finalStat = await handle.stat();
    if (finalStat.size !== opened.size || finalStat.mtimeMs !== opened.mtimeMs) throw new Error("file changed");
    return {
      ...base,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: isText(bytes) ? bytes.toString("utf8") : null,
    };
  } catch {
    exclude(state, relativePath, "read_unavailable");
    return null;
  } finally {
    await handle?.close();
  }
}

async function readSymlinkRecord(root, file, relativePath, options, state, stat) {
  try {
    const linkTarget = await fs.readlink(file);
    const resolved = await readableCanonical(root, file, relativePath, options, state, true);
    if (!resolved) return null;
    const current = await fs.lstat(file);
    if (!sameFile(current, stat) || !current.isSymbolicLink() || await fs.readlink(file) !== linkTarget) throw new Error("link changed");
    const bytes = Buffer.from(linkTarget, "utf8");
    if (bytes.byteLength > options.maxFileBytes || state.readBytes + bytes.byteLength > options.maxTotalBytes) {
      exclude(state, relativePath, "byte_limit");
      return null;
    }
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
    exclude(state, relativePath, "read_unavailable");
    return null;
  }
}

async function snapshotSymlinkTarget(root, link, options, state) {
  try {
    const resolved = await fs.realpath(link);
    if (!isContained(root, resolved)) {
      exclude(state, normalizeRelative(nodePath.relative(root, link)), "workspace_boundary");
      return;
    }
    await snapshotTarget(root, resolved, options, state);
  } catch (error) {
    if (error?.code !== "ENOENT") exclude(state, normalizeRelative(nodePath.relative(root, link)), "read_unavailable");
  }
}

async function readableCanonical(root, file, relativePath, options, state, allowMissing = false) {
  try {
    const canonical = allowMissing ? await resolveExistingPath(file) : await fs.realpath(file);
    if (!isContained(root, canonical)) {
      exclude(state, relativePath, "workspace_boundary");
      return null;
    }
    const canonicalRelative = normalizeRelative(nodePath.relative(root, canonical)) || ".";
    if (ignoredPath(canonicalRelative)) {
      exclude(state, relativePath, "scope_excluded");
      return null;
    }
    if (!await mayRead(canonicalRelative, options, state)) {
      exclude(state, relativePath, "read_denied");
      return null;
    }
    return canonical;
  } catch {
    exclude(state, relativePath, "read_unavailable");
    return null;
  }
}

async function resolveExistingPath(file, depth = 0) {
  if (depth > 40) throw new Error("too many links");
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // Preserve harmless dangling-link diffs while checking their eventual target.
    const stat = await fs.lstat(file).catch((failure) => {
      if (failure?.code !== "ENOENT") throw failure;
      return null;
    });
    if (stat?.isSymbolicLink()) return await resolveExistingPath(nodePath.resolve(nodePath.dirname(file), await fs.readlink(file)), depth + 1);
    const parent = nodePath.dirname(file);
    if (parent === file) throw error;
    return nodePath.join(await resolveExistingPath(parent, depth + 1), nodePath.basename(file));
  }
}

async function mayRead(relativePath, options, state) {
  try {
    const result = await options.authorizeRead(relativePath);
    if (result === true || result?.decision === "allow") return true;
  } catch {
    // Policy details may include protected material; persist only a stable reason.
  }
  exclude(state, relativePath, "read_denied");
  return false;
}

async function assertStablePath(file, stat) {
  const current = await fs.lstat(file);
  if (!sameFile(current, stat) || current.isSymbolicLink() || await fs.realpath(file) !== file) throw new Error("path changed");
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function exclude(state, relativePath, reason, suppressComparison = true) {
  state.complete = false;
  if (suppressComparison) state.excluded.add(relativePath);
  if (state.issues.some((issue) => issue.path === relativePath && issue.reason === reason)) return;
  state.issues.push({ path: relativePath, reason });
}

function isContained(root, target) {
  const relative = nodePath.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative);
}

function pathWithin(prefix, file) {
  return prefix === "." || file === prefix || file.startsWith(`${prefix}/`);
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
    if (!isContained(root, target)) throw new Error(`File Change Capture 路径越出 workspace：${requested}`);
    return target;
  }))].sort();
}

function ignoredPath(relativePath) {
  const segments = normalizeRelative(relativePath).split("/");
  return segments.some((segment) => IGNORED_SEGMENTS.has(segment));
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
