// Bounded directory snapshots and resumable, literal text search. Cursors are
// registry-local: they never contain trusted paths supplied by the caller.
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { withWorkspaceFile } from "./workspace-read.js";
import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";
import { serializeRedactedToolJson } from "../security/tool-json.js";

const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_RUN_BYTES = 8_000_000;
const MAX_RUNS = 8;
const MAX_CURSORS = 128;
const CURSOR_TTL_MS = 15 * 60_000;
const MAX_FILE_BYTES = 1_000_000;
const PAGE_BYTE_LIMIT = 4_000_000;
const RECORD_CHAR_LIMIT = 7_200;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build"]);

export function createWorkspaceSearch({ workspace, policyFor }) {
  const runs = new Map();
  const cursors = new Map();
  const cursorTurns = new Map();

  async function execute(kind, args = {}, context = {}) {
    // Serialize retries of one cursor so they return the same immutable page
    // and cannot account the same directory snapshot twice.
    if (typeof args.cursor !== "string") return executePage(kind, args, context);
    const key = args.cursor;
    const previous = cursorTurns.get(key) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    cursorTurns.set(key, turn);
    try {
      await previous;
      checkCancelled(context.signal);
      return await executePage(kind, args, context);
    } finally {
      release();
      if (cursorTurns.get(key) === turn) cursorTurns.delete(key);
    }
  }

  async function executePage(kind, args = {}, context = {}) {
    checkCancelled(context.signal);
    const options = normalizeOptions(kind, args);
    const accessPolicy = policyFor(context);
    const access = { workspace, accessPolicy, authorizeRead: context.authorizeRead, signal: context.signal };
    const signature = hash({ kind, options, session: context.state?.id || null, profile: context.state?.permissionProfile || accessPolicy?.name || null, policyVersion: accessPolicy?.version || null });
    prune();
    let run;
    let position;
    let cursorEntry;
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== "string" || !args.cursor || args.cursor.length > 100) throw staleCursor();
      cursorEntry = cursors.get(args.cursor);
      if (!cursorEntry || cursorEntry.run.signature !== signature) throw staleCursor();
      run = cursorEntry.run;
      await validateSnapshots(run, access);
      if (cursorEntry.result) return cursorEntry.result;
      position = structuredClone(cursorEntry.position);
    } else {
      run = { id: randomUUID(), signature, options, directories: new Map(), files: new Map(), observedAccess: new Map(), bytes: 0, entryCount: 0, createdAt: Date.now() };
      const directory = await directorySnapshot(run, options.path, access);
      position = { stack: [{ path: options.path, index: 0 }], pending: null, totals: emptyCounters() };
      if (!directory.entries.length) position.stack = [];
      runs.set(run.id, run);
      prune();
    }

    const counters = emptyCounters();
    const records = [];
    let recordChars = 2;
    const append = (record) => {
      const safeRecord = redactSensitiveValue(record);
      const chars = serializeRedactedToolJson(safeRecord).length + 1;
      if (recordChars + chars > RECORD_CHAR_LIMIT) return false;
      records.push(safeRecord);
      recordChars += chars;
      return true;
    };
    const matcher = kind === "search" ? compilePattern(options.file_pattern) : null;
    const needle = options.query?.toLowerCase();

    while (position.stack.length || position.pending) {
      checkCancelled(access.signal);
      if (records.length >= options.limit || (!position.pending && counters.scanned_entries >= options.scan_limit)) break;
      if (position.pending) {
        const pending = position.pending;
        const read = await readSearchFile(run, pending.path, access, PAGE_BYTE_LIMIT - counters.scanned_bytes);
        if (read.deferred) break;
        if (read.skipped) {
          counters.skipped[read.skipped] += 1;
          counters.scanned_bytes += read.bytes || 0;
          position.pending = null;
          continue;
        }
        counters.scanned_files += 1;
        counters.scanned_bytes += read.bytes;
        const lines = read.content.split("\n");
        const safeLines = redactSensitiveText(read.content).split("\n");
        if (safeLines.length !== lines.length) throw new Error("脱敏后的行边界发生变化，无法可靠展示搜索位置");
        if (lines.at(-1) === "") lines.pop();
        let stopped = false;
        for (let line = pending.line; line < lines.length; line += 1) {
          checkCancelled(access.signal);
          if (lines[line].toLowerCase().includes(needle)) {
            const content = safeLines[line].trim();
            const hit = { ...displayPath(pending.path), line: line + 1, text: content.slice(0, 240), ...(content.length > 240 ? { text_truncated: true } : {}) };
            if (records.length >= options.limit || !append(hit)) {
              position.pending = { path: pending.path, line };
              stopped = true;
              break;
            }
          }
        }
        if (stopped) break;
        position.pending = null;
        normalizeStack(position, run);
        continue;
      }

      normalizeStack(position, run);
      if (!position.stack.length) break;
      const frame = position.stack.at(-1);
      const directory = run.directories.get(frame.path);
      const entry = directory.entries[frame.index++];
      counters.scanned_entries += 1;
      const relative = normalizedPath(path.join(frame.path, entry.name));
      const allowed = await canRead(relative, access);
      rememberAccess(run, relative, allowed);
      if (!allowed) {
        counters.skipped.restricted += 1;
      } else if (entry.type === "symlink") {
        counters.skipped.symlink += 1;
      } else if (kind === "list") {
        if (!append({ ...displayPath(relative), type: entry.type })) {
          frame.index -= 1;
          counters.scanned_entries -= 1;
          break;
        }
      } else if ((entry.type === "directory" && IGNORED_DIRECTORIES.has(entry.name)) || /^nexus\.db(?:-(?:wal|shm))?$/.test(entry.name)) {
        counters.skipped.ignored += 1;
      } else if (entry.type === "directory") {
        try {
          await directorySnapshot(run, relative, access);
          if (position.stack.length >= 128) throw resourceLimit("目录层级超过 128 层");
          position.stack.push({ path: relative, index: 0 });
        } catch (error) {
          throwIfFatal(error, access.signal);
          counters.skipped[error.code === "SEARCH_RESTRICTED" ? "restricted" : "unreadable"] += 1;
        }
      } else if (entry.type !== "file") {
        counters.skipped.special += 1;
      } else if (!matcher(path.posix.relative(options.path === "." ? "" : options.path, relative), access.signal)) {
        counters.skipped.filtered += 1;
      } else {
        position.pending = { path: relative, line: 0 };
      }
      normalizeStack(position, run);
    }

    normalizeStack(position, run);
    // Files and directories can change while another file on the same page is
    // being read. Never certify an incomplete snapshot as a complete result.
    await validateSnapshots(run, access);
    addCounters(position.totals, counters);
    const hasMore = Boolean(position.stack.length || position.pending);
    const complete = !hasMore && !["restricted", "unreadable", "too_large", "symlink", "special", "binary"].some((key) => position.totals.skipped[key] > 0);
    let nextCursor = null;
    if (hasMore) {
      nextCursor = `ws-${randomUUID()}`;
      cursors.set(nextCursor, { run, position: structuredClone(position), result: null });
    }
    const output = serializeRedactedToolJson(redactSensitiveValue({
      path: options.path, complete, has_more: hasMore, next_cursor: nextCursor,
      ...counters, totals: position.totals,
      scope: kind === "list" ? "immediate directory; symlinks and denied paths excluded" : "recursive literal case-insensitive UTF-8 search; symlinks, denied paths, binary/oversized files excluded; ignored directories: .git,node_modules,dist,build; nexus database files excluded",
      ...(kind === "search" ? { file_pattern: options.file_pattern, max_file_bytes: MAX_FILE_BYTES, page_byte_limit: PAGE_BYTE_LIMIT } : {}),
      [kind === "list" ? "entries" : "matches"]: records,
    }));
    if (output.length > 10_000) throw resourceLimit("分页响应超过字符预算，请缩小 path");
    if (cursorEntry) cursorEntry.result = output;
    prune();
    return output;
  }

  function prune() {
    const now = Date.now();
    for (const [id, run] of runs) if (now - run.createdAt >= CURSOR_TTL_MS) runs.delete(id);
    while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
    for (const [cursor, entry] of cursors) if (!runs.has(entry.run.id)) cursors.delete(cursor);
    while (cursors.size > MAX_CURSORS) cursors.delete(cursors.keys().next().value);
  }

  return { list: (args, context) => execute("list", args, context), search: (args, context) => execute("search", args, context) };
}

function normalizeOptions(kind, args) {
  if (typeof args.path !== "undefined" && (typeof args.path !== "string" || !args.path || args.path.length > 512)) throw new Error("path 必须为不超过 512 字符的工作区相对目录路径");
  const requested = args.path || ".";
  if (path.isAbsolute(requested) || requested.split(/[\\/]/).includes("..")) throw new Error("路径越过了工作区边界");
  const options = { path: normalizedPath(requested), limit: args.limit ?? (kind === "list" ? 120 : 80), scan_limit: args.scan_limit ?? (kind === "list" ? 1_000 : 300) };
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > (kind === "list" ? 200 : 80)) throw new Error("limit 超出允许范围");
  if (!Number.isSafeInteger(options.scan_limit) || options.scan_limit < 1 || options.scan_limit > 1_000) throw new Error("scan_limit 必须是 1 到 1000 的整数");
  if (kind === "search") {
    if (typeof args.query !== "string" || !args.query || args.query.length > 1_024 || /[\r\n]/.test(args.query)) throw new Error("query 必须为 1 到 1024 字符的非空单行字面字符串");
    options.query = args.query;
    options.file_pattern = args.file_pattern ?? "**/*";
    compilePattern(options.file_pattern);
  }
  return options;
}

function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 256 || /[\[\]{}!\\]/.test(pattern) || pattern.startsWith("/") || pattern.split("/").includes("..")) throw new Error("file_pattern 只支持相对路径中的 *、?、**/；不支持括号、集合、取反或转义");
  const patterns = pattern.split("/");
  for (let index = 0; index < patterns.length; index += 1) {
    const segment = patterns[index];
    if (!segment || (segment.includes("**") && (segment !== "**" || index === patterns.length - 1))) throw new Error("file_pattern 中 ** 必须独占目录段并写作 **/");
  }
  return (relative, signal) => {
    const segments = relative.split("/");
    let previous = new Uint8Array(segments.length + 1);
    previous[0] = 1;
    for (const segmentPattern of patterns) {
      checkCancelled(signal);
      const next = new Uint8Array(segments.length + 1);
      if (segmentPattern === "**") {
        next[0] = previous[0];
        for (let index = 1; index <= segments.length; index += 1) next[index] = previous[index] || next[index - 1];
      } else {
        for (let index = 1; index <= segments.length; index += 1) {
          if (previous[index - 1]) next[index] = matchSegment(segmentPattern, segments[index - 1], signal) ? 1 : 0;
        }
      }
      previous = next;
    }
    return previous[segments.length] === 1;
  };
}

// Two-row wildcard DP is bounded by pattern length × filename length. Unlike
// regex backtracking, adversarial '*a*a*…b' patterns cannot grow exponentially.
function matchSegment(pattern, value, signal) {
  let previous = new Uint8Array(value.length + 1);
  previous[0] = 1;
  for (const char of pattern) {
    checkCancelled(signal);
    const next = new Uint8Array(value.length + 1);
    if (char === "*") next[0] = previous[0];
    for (let index = 1; index <= value.length; index += 1) {
      next[index] = char === "*" ? previous[index] || next[index - 1] : previous[index - 1] && (char === "?" || char === value[index - 1]) ? 1 : 0;
    }
    previous = next;
  }
  return previous[value.length] === 1;
}

async function directorySnapshot(run, relative, access) {
  if (run.directories.has(relative)) return run.directories.get(relative);
  const opened = await resolveDirectory(relative, access);
  const entries = [];
  let bytes = 0;
  const directory = await fs.opendir(opened.canonical);
  for await (const entry of directory) {
    checkCancelled(access.signal);
    if (entries.length >= MAX_DIRECTORY_ENTRIES || run.entryCount + entries.length >= MAX_DIRECTORY_ENTRIES) throw resourceLimit("目录快照超过 20000 项");
    const item = { name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "special" };
    bytes += Buffer.byteLength(entry.name) + 100;
    if (run.bytes + bytes > MAX_RUN_BYTES) throw resourceLimit("目录快照超过 8MB");
    entries.push(item);
  }
  const after = await resolveDirectory(relative, access);
  if (after.version !== opened.version) throw staleCursor();
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const snapshot = { ...opened, entries };
  run.directories.set(relative, snapshot);
  run.entryCount += entries.length;
  run.bytes += bytes;
  return snapshot;
}

async function resolveDirectory(relative, access) {
  checkCancelled(access.signal);
  const candidate = path.resolve(access.workspace, relative);
  assertContained(access.workspace, candidate);
  await requireRead(relative, access);
  // Directories are never followed through symlinks, including intermediate
  // components. This deliberately narrows the search scope.
  let current = access.workspace;
  for (const component of path.relative(access.workspace, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const item = await fs.lstat(current);
    if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("搜索目录必须是真实目录，不能通过符号链接");
  }
  const canonical = await fs.realpath(candidate);
  assertContained(access.workspace, canonical);
  await requireRead(normalizedPath(path.relative(access.workspace, canonical)), access);
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("搜索目录必须是真实目录");
  return { canonical, version: statVersion(stat) };
}

async function readSearchFile(run, relative, access, remainingBytes) {
  try {
    const before = await fs.lstat(path.join(access.workspace, relative));
    if (before.isSymbolicLink()) return { skipped: "symlink" };
    if (!before.isFile()) return { skipped: "special" };
    const version = statVersion(before);
    if (run.files.has(relative) && run.files.get(relative) !== version) throw staleCursor();
    const result = await withWorkspaceFile({ ...access, path: relative }, async (file) => {
      if (file.size > MAX_FILE_BYTES) return { skipped: "too_large" };
      if (file.size > remainingBytes) return { deferred: true };
      const chunks = [];
      for (let offset = 0; offset < file.size; offset += 64 * 1024) chunks.push(await file.read(offset, Math.min(64 * 1024, file.size - offset)));
      const buffer = Buffer.concat(chunks);
      if (buffer.includes(0)) return { skipped: "binary", bytes: buffer.byteLength };
      try {
        return { content: new TextDecoder("utf-8", { fatal: true }).decode(buffer), bytes: buffer.byteLength };
      } catch {
        return { skipped: "binary", bytes: buffer.byteLength };
      }
    });
    if (!run.files.has(relative)) {
      run.bytes += Buffer.byteLength(relative) + 160;
      if (run.bytes > MAX_RUN_BYTES) throw resourceLimit("文件快照超过 8MB");
      run.files.set(relative, version);
    }
    return result;
  } catch (error) {
    throwIfFatal(error, access.signal);
    return { skipped: await canRead(relative, access) ? "unreadable" : "restricted" };
  }
}

async function validateSnapshots(run, access) {
  for (const [relative, allowed] of run.observedAccess) {
    if (await canRead(relative, access) !== allowed) throw staleCursor();
  }
  for (const [relative, snapshot] of run.directories) {
    try {
      const current = await resolveDirectory(relative, access);
      if (current.version !== snapshot.version) throw staleCursor();
    } catch (error) { checkCancelled(access.signal); throw staleCursor(); }
  }
  for (const [relative, version] of run.files) {
    checkCancelled(access.signal);
    if (!await canRead(relative, access)) throw staleCursor();
    try {
      const current = await fs.lstat(path.join(access.workspace, relative));
      if (current.isSymbolicLink() || !current.isFile() || statVersion(current) !== version) throw staleCursor();
    } catch { throw staleCursor(); }
  }
}

function rememberAccess(run, relative, allowed) {
  if (!run.observedAccess.has(relative)) {
    run.bytes += Buffer.byteLength(relative) + 80;
    if (run.bytes > MAX_RUN_BYTES) throw resourceLimit("权限快照超过 8MB");
  }
  run.observedAccess.set(relative, allowed);
}
function normalizeStack(position, run) {
  while (position.stack.length && position.stack.at(-1).index >= run.directories.get(position.stack.at(-1).path).entries.length) position.stack.pop();
}
function emptyCounters() { return { scanned_entries: 0, scanned_files: 0, scanned_bytes: 0, skipped: { ignored: 0, filtered: 0, restricted: 0, unreadable: 0, too_large: 0, symlink: 0, special: 0, binary: 0 } }; }
function addCounters(target, source) { for (const key of ["scanned_entries", "scanned_files", "scanned_bytes"]) target[key] += source[key]; for (const key of Object.keys(target.skipped)) target.skipped[key] += source.skipped[key]; }
function normalizedPath(value) { return path.normalize(value).split(path.sep).join("/").replace(/\/$/, "") || "."; }
function displayPath(value) {
  const safe = redactSensitiveText(value);
  return { path: safe.slice(0, 512), ...(safe.length > 512 ? { path_truncated: true } : {}), ...(safe !== value ? { path_redacted: true } : {}) };
}
function statVersion(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function checkCancelled(signal) { signal?.throwIfAborted(); }
function staleCursor() { return Object.assign(new Error("分页游标已失效或参数不匹配（文件、目录、权限变化或缓存过期）；请从不带 cursor 的请求重新开始"), { code: "SEARCH_STALE_CURSOR" }); }
function resourceLimit(reason) { return Object.assign(new Error(`搜索范围达到资源上限：${reason}；请缩小 path 后重新搜索，不能据此判定无匹配`), { code: "SEARCH_RESOURCE_LIMIT" }); }
function throwIfFatal(error, signal) { checkCancelled(signal); if (["SEARCH_STALE_CURSOR", "SEARCH_RESOURCE_LIMIT"].includes(error?.code)) throw error; }
function assertContained(root, target) { const relative = path.relative(root, target); if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("路径越过了工作区边界"); }
async function requireRead(relative, access) {
  checkCancelled(access.signal);
  if (!await canRead(relative, access)) throw Object.assign(new Error("搜索范围包含受限路径"), { code: "SEARCH_RESTRICTED" });
}
async function canRead(relative, access) {
  checkCancelled(access.signal);
  try {
    if (access.accessPolicy?.canAccessPath && !access.accessPolicy.canAccessPath(relative, "read")) return false;
    const decision = access.accessPolicy?.assertPath?.(relative, "read");
    if (decision && decision.decision !== "allow") return false;
    if (access.authorizeRead && await access.authorizeRead(relative) !== true) return false;
    checkCancelled(access.signal);
    return true;
  } catch { checkCancelled(access.signal); return false; }
}
