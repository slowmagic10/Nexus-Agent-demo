// Bounded workspace reads. Paths and open descriptors are checked independently;
// consumers receive data only after the final authorization and identity check.
import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";
import { serializeRedactedToolJson } from "../security/tool-json.js";

export const WORKSPACE_READ_CHUNK_BYTES = 65_536;
export const WORKSPACE_READ_SCAN_BYTES = 8 * 1024 * 1024;
const FULL_READ_BYTES = 65_536;
const DEFAULT_PAGE_BYTES = 16_384;
const MAX_RESPONSE_CHARS = 10_000;
const MAX_REDACTION_CONTEXT_BYTES = 2 * 1024 * 1024;
const TEXT_SCOPE = "UTF-8 text; content may be redacted; byte offsets refer to the original file";

export async function withWorkspaceFile({
  workspace, path: requested, accessPolicy, authorizeRead, signal, fileSystem = fs,
  maxReadBytes = WORKSPACE_READ_SCAN_BYTES,
}, consume) {
  if (typeof consume !== "function") throw new TypeError("安全读取需要 consumer");
  integer(maxReadBytes, "maxReadBytes", 1, WORKSPACE_READ_SCAN_BYTES);
  if (!accessPolicy || typeof accessPolicy.assertPath !== "function") throw new Error("读取需要 Access Policy");
  checkCancelled(signal);
  const root = await fileSystem.realpath(path.resolve(workspace));
  if (typeof requested !== "string" || !requested || requested.includes("\0")) throw new Error("读取路径必须是非空字符串");
  const alias = path.resolve(root, requested);
  assertContained(root, alias);
  const assertAuthorized = async (target) => {
    checkCancelled(signal);
    const relative = path.relative(root, target) || ".";
    const decision = accessPolicy.assertPath(relative, "read");
    if (decision?.decision && decision.decision !== "allow") throw new Error("文件读取权限未获授权");
    if (authorizeRead && await authorizeRead(relative) !== true) throw new Error("文件读取权限未获授权");
    checkCancelled(signal);
  };
  await assertAuthorized(alias);
  const canonical = await fileSystem.realpath(alias);
  assertContained(root, canonical);
  await assertAuthorized(canonical);
  const parent = path.dirname(canonical);
  if (await fileSystem.realpath(parent) !== parent) throw changed();
  const parentBefore = await fileSystem.stat(parent, { bigint: true });
  const before = await fileSystem.lstat(canonical, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("读取目标必须是普通文件，不能是目录、管道或设备");
  checkCancelled(signal);
  const handle = await fileSystem.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw changed();
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("文件大小超出安全读取范围");
    const verify = async () => {
      checkCancelled(signal);
      await assertAuthorized(alias);
      await assertAuthorized(canonical);
      if (await fileSystem.realpath(alias) !== canonical || await fileSystem.realpath(parent) !== parent) throw changed();
      const parentAfter = await fileSystem.stat(parent, { bigint: true });
      const named = await fileSystem.lstat(canonical, { bigint: true });
      const current = await handle.stat({ bigint: true });
      if (!sameIdentity(parentBefore, parentAfter) || !named.isFile() || !sameFile(opened, named) || !sameFile(opened, current)) throw changed();
      checkCancelled(signal);
    };
    await verify();
    let total = 0;
    const result = await consume({
      path: path.relative(root, alias), size, version: fileVersion(opened),
      get remainingReadBytes() { return maxReadBytes - total; },
      async read(position, length) {
        checkCancelled(signal);
        integer(position, "position", 0, Number.MAX_SAFE_INTEGER);
        integer(length, "length", 0, WORKSPACE_READ_CHUNK_BYTES);
        const bounded = Math.min(length, Math.max(0, size - position));
        if (total + bounded > maxReadBytes) throw new Error("读取已达到累计字节预算");
        total += bounded;
        const buffer = Buffer.alloc(bounded);
        let offset = 0;
        while (offset < bounded) {
          checkCancelled(signal);
          const { bytesRead } = await handle.read(buffer, offset, bounded - offset, position + offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        checkCancelled(signal);
        return buffer.subarray(0, offset);
      },
    });
    await verify();
    return result;
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceFile(options) {
  const { start_line, line_count, offset, limit, version, maxScanBytes = WORKSPACE_READ_SCAN_BYTES } = options;
  if (offset !== undefined && (start_line !== undefined || line_count !== undefined)) throw new Error("offset 字节模式不能与行分页参数混用");
  if (start_line !== undefined) integer(start_line, "start_line", 1, Number.MAX_SAFE_INTEGER);
  if (line_count !== undefined) integer(line_count, "line_count", 1, 2000);
  if (offset !== undefined) integer(offset, "offset", 0, Number.MAX_SAFE_INTEGER);
  if (limit !== undefined) integer(limit, "limit", 1, WORKSPACE_READ_CHUNK_BYTES);
  if (limit !== undefined && offset === undefined) throw new Error("limit 只用于 offset 字节模式");
  if (version !== undefined && (typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version))) throw new Error("version 必须是读取结果中的文件版本");
  integer(maxScanBytes, "maxScanBytes", 4, WORKSPACE_READ_SCAN_BYTES);
  return withWorkspaceFile({ ...options, maxReadBytes: maxScanBytes }, async (file) => {
    if (version !== undefined && version !== file.version) throw new Error("文件版本已变化，请从新版本重新读取");
    const explicit = start_line !== undefined || line_count !== undefined || offset !== undefined || version !== undefined;
    if (!explicit && file.size <= FULL_READ_BYTES && file.size <= maxScanBytes) {
      return decode(await file.read(0, file.size), true).content;
    }
    // Keep the most recent scan chunk so common short-line pages can inspect
    // their boundaries without reading the same bytes again.
    let cached = null;
    const reader = {
      ...file,
      get remainingReadBytes() { return file.remainingReadBytes; },
      async read(position, length) {
        const bytes = await file.read(position, length);
        cached = { position, bytes };
        return bytes;
      },
      async contextRead(position, length) {
        if (cached && position >= cached.position && position + length <= cached.position + cached.bytes.length) {
          return cached.bytes.subarray(position - cached.position, position - cached.position + length);
        }
        if (length > file.remainingReadBytes) return null;
        return file.read(position, length);
      },
    };
    const page = offset !== undefined
      ? await readBytes(reader, offset, limit ?? DEFAULT_PAGE_BYTES, maxScanBytes)
      : await readLines(reader, start_line ?? 1, line_count ?? 200, maxScanBytes);
    return protectPage(reader, page);
  });
}

async function protectPage(file, page) {
  if (!page.content) return boundedPage({ ...page, redacted: false, content_omitted: false });
  const source = Buffer.from(page.content);
  const prefix = [];
  const suffix = [];
  let contextBytes = source.length;
  let contextStart = page.start_offset;
  let contextEnd = page.end_offset;
  let beforeComplete = contextStart === 0;
  let afterComplete = contextEnd === file.size;
  // Existing redaction patterns use \s, so their labels and values can span
  // physical lines. Retain five adjacent nonempty lines in each direction;
  // blank lines still consume the same bounded context and I/O budgets.
  const beforeLines = adjacentLines("before", true);
  const afterLines = adjacentLines("after", source.at(-1) !== 10);
  while (!beforeComplete && contextBytes < MAX_REDACTION_CONTEXT_BYTES) {
    const length = Math.min(16_384, contextStart, MAX_REDACTION_CONTEXT_BYTES - contextBytes);
    if (!length) break;
    const bytes = await file.contextRead(contextStart - length, length);
    if (!bytes?.length) break;
    const start = beforeLines.consume(bytes);
    const part = bytes.subarray(start ?? 0);
    prefix.unshift(part);
    contextStart -= part.length;
    contextBytes += part.length;
    beforeComplete = start !== null || contextStart === 0;
  }
  while (!afterComplete && contextBytes < MAX_REDACTION_CONTEXT_BYTES) {
    const length = Math.min(16_384, file.size - contextEnd, MAX_REDACTION_CONTEXT_BYTES - contextBytes);
    if (!length) break;
    const bytes = await file.contextRead(contextEnd, length);
    if (!bytes?.length) break;
    const end = afterLines.consume(bytes);
    const part = bytes.subarray(0, end ?? bytes.length);
    suffix.push(part);
    contextEnd += part.length;
    contextBytes += part.length;
    afterComplete = end !== null || contextEnd === file.size;
  }
  if (!beforeComplete || !afterComplete) {
    return boundedPage({
      ...page, content: "", redacted: false, content_omitted: true,
      complete: false, next_offset: null, next_line: null, stop_reason: "redaction_context_limit",
      continuation_hint: "无法在 2MiB 完整行及前后各五个非空邻行上下文或本次 8MiB 读取预算内确认安全片段；请换到其他完整行范围，或读取已有脱敏 Artifact，不要原样重复此页。",
    });
  }
  const bytes = Buffer.concat([...prefix, source, ...suffix], contextBytes);
  prefix.length = 0;
  suffix.length = 0;
  const context = decode(bytes, true).content;
  const redactedContext = redactSensitiveText(context);
  const sensitive = [];
  let charOffset = 0;
  let redactedOffset = 0;
  let byteOffset = contextStart;
  while (charOffset < context.length) {
    const newline = context.indexOf("\n", charOffset);
    const lineEnd = newline < 0 ? context.length : newline + 1;
    const line = context.slice(charOffset, lineEnd);
    const redactedNewline = redactedContext.indexOf("\n", redactedOffset);
    const redactedEnd = redactedNewline < 0 ? redactedContext.length : redactedNewline + 1;
    const redactedLine = redactedContext.slice(redactedOffset, redactedEnd);
    const byteEnd = byteOffset + Buffer.byteLength(line);
    if (redactedLine !== line) sensitive.push({ start: byteOffset, end: byteEnd });
    charOffset = lineEnd;
    redactedOffset = redactedEnd;
    byteOffset = byteEnd;
  }
  return fitProtectedPage(page, source, sensitive);
}

function adjacentLines(direction, skipBoundaryLine) {
  let remaining = 5;
  let parts = [];
  let skip = skipBoundaryLine;
  const completeLine = () => {
    if (skip) skip = false;
    else if (Buffer.concat(parts).toString("utf8").trim()) remaining -= 1;
    parts = [];
    return remaining === 0;
  };
  return {
    consume(bytes) {
      if (direction === "before") {
        let end = bytes.length;
        while (end > 0) {
          const newline = bytes.lastIndexOf(10, end - 1);
          if (!skip) parts.unshift(bytes.subarray(newline + 1, end));
          if (newline < 0) return null;
          if (completeLine()) return newline + 1;
          end = newline;
        }
      } else {
        let start = 0;
        while (start < bytes.length) {
          const newline = bytes.indexOf(10, start);
          if (!skip) parts.push(bytes.subarray(start, newline < 0 ? bytes.length : newline));
          if (newline < 0) return null;
          if (completeLine()) return newline + 1;
          start = newline + 1;
        }
      }
      return null;
    },
  };
}

function fitProtectedPage(page, source, sensitive) {
  const build = (count) => {
    let end = count;
    if (end > 0 && /[\uD800-\uDBFF]/u.test(page.content[end - 1])) end -= 1;
    const original = page.content.slice(0, end);
    const endOffset = page.start_offset + Buffer.byteLength(original);
    const shortened = end < page.content.length;
    // Derive every coordinate from original bytes before replacing sensitive
    // fragments. Placeholder length must never affect a continuation offset.
    const raw = updateLineRange({
      ...page, content: original, end_offset: endOffset,
      ...(shortened ? { complete: false, next_offset: endOffset, stop_reason: "response_limit" } : {}),
    });
    let position = page.start_offset;
    let redacted = 0;
    const parts = [];
    for (const range of sensitive) {
      const start = Math.max(range.start, page.start_offset);
      const stop = Math.min(range.end, endOffset);
      if (stop <= start) continue;
      if (start > position) parts.push(source.subarray(position - page.start_offset, start - page.start_offset).toString("utf8"));
      const fragment = source.subarray(start - page.start_offset, stop - page.start_offset);
      const ending = fragment.at(-1) === 10 ? fragment.at(-2) === 13 ? "\r\n" : "\n" : fragment.at(-1) === 13 ? "\r" : "";
      parts.push(`[REDACTED]${ending}`);
      position = stop;
      redacted += 1;
    }
    if (position < endOffset) parts.push(source.subarray(position - page.start_offset, endOffset - page.start_offset).toString("utf8"));
    return { ...raw, content: parts.join(""), redacted: redacted > 0, redacted_line_count: redacted, content_omitted: false };
  };
  const full = build(page.content.length);
  if (serializedPageLength(full) <= MAX_RESPONSE_CHARS) return full;
  let low = 1;
  let high = page.content.length;
  let fitted = null;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = build(count);
    if (candidate.end_offset > candidate.start_offset && serializedPageLength(candidate) <= MAX_RESPONSE_CHARS) {
      fitted = candidate;
      low = count + 1;
    } else high = count - 1;
  }
  if (!fitted) throw new Error("文件路径或分页元信息超过响应预算");
  return fitted;
}

async function readBytes(file, requestedOffset, limit, scanBudget) {
  const offset = Math.min(requestedOffset, file.size);
  const bytes = await file.read(offset, Math.min(limit, scanBudget));
  const decoded = decode(bytes, offset + bytes.length >= file.size);
  if (bytes.length && !decoded.bytes) throw new Error("limit 太小，无法完整读取一个 UTF-8 字符；请增大 limit");
  return fitResponse({
    path: file.path, version: file.version, mode: "bytes", scope: TEXT_SCOPE, total_bytes: file.size,
    start_offset: offset, end_offset: offset + decoded.bytes,
    start_line: null, end_line: null, next_line: null,
    next_offset: offset + decoded.bytes >= file.size ? null : offset + decoded.bytes,
    complete: offset + decoded.bytes >= file.size,
    partial_line: null, stop_reason: offset + decoded.bytes >= file.size ? "eof" : "byte_limit",
    content: decoded.content,
  });
}

async function readLines(file, startLine, lineCount, scanBudget) {
  let position = 0;
  let line = 1;
  let pageStart = null;
  const parts = [];
  let outputBytes = 0;
  let reason = "eof";
  let finalChunk = null;
  const finalLine = startLine + lineCount - 1;
  while (position < file.size && position < scanBudget) {
    const bytes = await file.read(position, Math.min(WORKSPACE_READ_CHUNK_BYTES, scanBudget - position));
    if (!bytes.length) break;
    finalChunk = bytes;
    let index = 0;
    while (line < startLine && index < bytes.length) {
      const newline = bytes.indexOf(10, index);
      if (newline < 0) { index = bytes.length; break; }
      index = newline + 1;
      line += 1;
    }
    if (line >= startLine && index < bytes.length) {
      pageStart ??= position + index;
      const begin = index;
      while (index < bytes.length && line <= finalLine && outputBytes + index - begin < WORKSPACE_READ_CHUNK_BYTES) {
        if (bytes[index++] === 10) line += 1;
      }
      parts.push(bytes.subarray(begin, index));
      outputBytes += index - begin;
      position += index;
      if (line > finalLine) { reason = "line_limit"; break; }
      if (outputBytes >= WORKSPACE_READ_CHUNK_BYTES) { reason = "byte_limit"; break; }
    } else {
      position += bytes.length;
    }
  }
  if (position >= scanBudget && position < file.size && reason === "eof") reason = "scan_limit";
  // A scan can stop before the requested line, in the middle of a UTF-8 code
  // point. Return a usable byte continuation instead of an invalid offset.
  if (pageStart === null && position < file.size && finalChunk) {
    position -= finalChunk.length - utf8BoundaryEnd(finalChunk);
  }
  const bytes = Buffer.concat(parts, outputBytes);
  const decoded = decode(bytes, position >= file.size);
  const start = pageStart ?? position;
  const end = pageStart === null ? position : start + decoded.bytes;
  const complete = end >= file.size;
  const result = {
    path: file.path, version: file.version, mode: "lines", scope: TEXT_SCOPE, total_bytes: file.size,
    start_offset: start, end_offset: end,
    start_line: startLine, end_line: null,
    next_line: complete ? null : pageStart === null ? line : startLine,
    next_offset: complete ? null : end,
    complete, partial_line: !complete, stop_reason: complete ? "eof" : reason,
    content: decoded.content,
  };
  return fitResponse(updateLineRange(result));
}

function fitResponse(page) {
  if (serializedPageLength(page) <= MAX_RESPONSE_CHARS) return page;
  const source = page.content;
  let low = 0;
  let high = source.length;
  let fitted = null;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    let end = length;
    if (end > 0 && /[\uD800-\uDBFF]/u.test(source[end - 1])) end -= 1;
    const content = source.slice(0, end);
    const next = page.start_offset + Buffer.byteLength(content);
    const candidate = updateLineRange({ ...page, content, end_offset: next, next_offset: next, complete: false, stop_reason: "response_limit" });
    if (serializedPageLength(candidate) <= MAX_RESPONSE_CHARS) { fitted = candidate; low = length + 1; }
    else high = length - 1;
  }
  if (!fitted?.content) throw new Error("文件路径或分页元信息超过响应预算");
  return fitted;
}

function serializedPageLength(page) {
  return serializeRedactedToolJson(redactSensitiveValue(page)).length;
}

function boundedPage(page) {
  if (serializedPageLength(page) > MAX_RESPONSE_CHARS) throw new Error("文件路径或分页元信息超过响应预算");
  return page;
}

function updateLineRange(page) {
  if (page.mode !== "lines" || !page.content) return page;
  const newlines = page.content.split("\n").length - 1;
  return {
    ...page,
    end_line: page.start_line + newlines - (page.content.endsWith("\n") ? 1 : 0),
    next_line: page.complete ? null : page.start_line + newlines,
    partial_line: !page.complete && !page.content.endsWith("\n"),
  };
}

function decode(bytes, complete) {
  const end = complete ? bytes.length : utf8BoundaryEnd(bytes);
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)); }
  catch { throw new Error("read_file 只支持合法 UTF-8 文本；offset 必须位于 UTF-8 字符边界"); }
  if (content.includes("\0")) throw new Error("read_file 只支持文本文件，检测到二进制内容");
  return { content, bytes: end };
}

function utf8BoundaryEnd(bytes) {
  const end = bytes.length;
  let lead = end - 1;
  while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return end;
  const first = bytes[lead];
  const length = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
  return end - lead < length ? lead : end;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min} 到 ${max} 的整数`);
}
function checkCancelled(signal) {
  if (signal?.aborted) throw signal.reason || new Error("读取已取消");
}
function assertContained(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("读取路径越过了工作区边界");
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function fileVersion(stat) {
  return createHash("sha256").update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")).digest("hex");
}
function changed() { return new Error("文件或父目录在读取期间发生变化，请重新读取"); }
