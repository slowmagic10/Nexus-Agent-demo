import { redactSensitiveText } from "../security/redact.js";

export const UNIFIED_DIFF_FORMAT = "unified-context-v1";
const CONTEXT_LINES = 3;
const DEFAULT_MAX_WORK = 1_000_000;
const TRUNCATED = "…Diff 已达到采集上限…\n";
const NO_NEWLINE = "\\ No newline at end of file\n";

// A bounded, readable view of already-authorized captures. It does not write or
// apply patches. Redaction happens before selecting context or adding +/- signs.
export function renderUnifiedDiff(changes, maxChars, { maxWork = DEFAULT_MAX_WORK } = {}) {
  if (!Array.isArray(changes) || !positive(maxChars) || !positive(maxWork)) throw new Error("Unified Diff 输入或预算无效");
  const work = { remaining: maxWork, limited: false };
  const blocks = [];
  let chars = 0;
  let truncated = false;
  function append(text, first, hunks, redacted) {
    if (text === null || chars + text.length > maxChars) { truncated = true; return false; }
    blocks.push({ text, first, hunks, redacted: first && redacted });
    chars += text.length;
    return true;
  }
  outer: for (const change of changes) {
    const { relativePath, operation, before, after } = change;
    if ((before && typeof before.text !== "string") || (after && typeof after.text !== "string")) continue;
    const rawOld = before?.text || "";
    const rawNew = after?.text || "";
    const oldText = redactSensitiveText(rawOld);
    const newText = redactSensitiveText(rawNew);
    const oldLines = lines(oldText);
    const newLines = lines(newText);
    const redacted = rawOld !== oldText || rawNew !== newText;
    const header = `--- ${operation === "created" ? "/dev/null" : quotedPath("a", relativePath)}\n`
      + `+++ ${operation === "deleted" ? "/dev/null" : quotedPath("b", relativePath)}\n`;
    if (lineCount(rawOld) !== oldLines.length || lineCount(rawNew) !== newLines.length) {
      if (!append(header + "# 脱敏后无法保持原始行位置，仅保留文件变更元数据。\n", true, 0, true)) break;
      continue;
    }
    if (oldText === newText) {
      const note = operation === "created" ? "空文件已创建。" : operation === "deleted" ? "空文件已删除。"
        : redacted ? "原始文件已变化；脱敏后无可见文本差异。" : "文件元数据已变化；文本内容相同。";
      if (!append(header + `# ${note}\n`, true, 0, redacted)) break;
      continue;
    }
    let first = true;
    for (const hunk of contextHunks(diffRanges(oldLines, newLines, work))) {
      const prefix = first ? header : "";
      const rendered = renderHunk(hunk, oldLines, newLines, maxChars - chars - prefix.length);
      if (!append(rendered === null ? null : prefix + rendered, first, 1, redacted)) break outer;
      first = false;
    }
  }
  if (truncated) {
    const marker = TRUNCATED.slice(0, maxChars);
    // Only remove complete hunks/file notes. Never publish a partial line, hunk
    // count or surrogate pair merely to fill the response budget.
    while (blocks.length && chars + marker.length > maxChars) chars -= blocks.pop().text.length;
    blocks.push({ text: marker, first: false, hunks: 0, redacted: false });
  }
  return {
    content: blocks.map((block) => block.text).join(""), truncated, format: UNIFIED_DIFF_FORMAT,
    stats: { files: blocks.filter((block) => block.first).length,
      hunks: blocks.reduce((sum, block) => sum + block.hunks, 0),
      redactedFiles: blocks.filter((block) => block.redacted).length,
      workLimited: work.limited },
  };
}

function diffRanges(oldLines, newLines, work) {
  const output = [];
  const stack = [{ a0: 0, a1: oldLines.length, b0: 0, b1: newLines.length }];
  const emit = (type, a0, a1, b0, b1) => {
    if (a0 === a1 && b0 === b1) return;
    const last = output.at(-1);
    if (last?.type === type && last.a1 === a0 && last.b1 === b0) { last.a1 = a1; last.b1 = b1; }
    else output.push({ type, a0, a1, b0, b1 });
  };
  while (stack.length) {
    const task = stack.pop();
    let { a0, a1, b0, b1 } = task;
    if (task.type) { emit(task.type, a0, a1, b0, b1); continue; }
    const startA = a0;
    const startB = b0;
    while (a0 < a1 && b0 < b1 && consume(work) && oldLines[a0] === newLines[b0]) { a0++; b0++; }
    emit(" ", startA, a0, startB, b0);
    const endA = a1;
    const endB = b1;
    while (a0 < a1 && b0 < b1 && consume(work) && oldLines[a1 - 1] === newLines[b1 - 1]) { a1--; b1--; }
    if (a1 < endA) stack.push({ type: " ", a0: a1, a1: endA, b0: b1, b1: endB });
    if (a0 === a1 || b0 === b1) {
      emit("-", a0, a1, b0, b0);
      emit("+", a1, a1, b0, b1);
      continue;
    }
    const anchors = patienceAnchors(oldLines, newLines, { a0, a1, b0, b1 }, work);
    if (!anchors.length) {
      // No unique anchors or exhausted work: replacing this unmatched region is
      // still faithful. We do not claim a globally shortest edit script.
      emit("-", a0, a1, b0, b0);
      emit("+", a1, a1, b0, b1);
      continue;
    }
    const tasks = [];
    for (const [a, b] of anchors) {
      tasks.push({ a0, a1: a, b0, b1: b }, { type: " ", a0: a, a1: a + 1, b0: b, b1: b + 1 });
      a0 = a + 1; b0 = b + 1;
    }
    tasks.push({ a0, a1, b0, b1 });
    for (let index = tasks.length - 1; index >= 0; index--) stack.push(tasks[index]);
  }
  return output;
}

function patienceAnchors(oldLines, newLines, { a0, a1, b0, b1 }, work) {
  const oldUnique = uniquePositions(oldLines, a0, a1, work);
  const newUnique = uniquePositions(newLines, b0, b1, work);
  if (!oldUnique || !newUnique) return [];
  const pairs = [];
  for (const [line, a] of oldUnique) {
    if (!consume(work)) return [];
    const b = newUnique.get(line);
    if (a !== null && b !== null && b !== undefined) pairs.push([a, b]);
  }
  const previous = [];
  const tails = [];
  for (let index = 0; index < pairs.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      if (!consume(work)) return [];
      const middle = (low + high) >>> 1;
      if (pairs[tails[middle]][1] < pairs[index][1]) low = middle + 1;
      else high = middle;
    }
    previous[index] = low ? tails[low - 1] : -1;
    tails[low] = index;
  }
  const selected = [];
  for (let index = tails.at(-1) ?? -1; index !== -1; index = previous[index]) selected.push(pairs[index]);
  return selected.reverse();
}

function uniquePositions(source, start, end, work) {
  const positions = new Map();
  for (let index = start; index < end; index++) {
    if (!consume(work)) return null;
    const line = source[index];
    positions.set(line, positions.has(line) ? null : index);
  }
  return positions;
}

function* contextHunks(ranges) {
  let current = [];
  let leading = null;
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    if (range.type !== " ") {
      if (!current.length && leading) current.push(leading);
      current.push(range);
      leading = null;
      continue;
    }
    const length = range.a1 - range.a0;
    if (current.length && (length > 2 * CONTEXT_LINES || index === ranges.length - 1)) {
      current.push(equalSlice(range, 0, Math.min(CONTEXT_LINES, length)));
      yield current;
      current = [];
    } else if (current.length) current.push(range);
    leading = equalSlice(range, Math.max(0, length - CONTEXT_LINES), length);
  }
  if (current.length) yield current;
}

function equalSlice(range, start, end) {
  return { type: " ", a0: range.a0 + start, a1: range.a0 + end, b0: range.b0 + start, b1: range.b0 + end };
}

function renderHunk(ranges, oldLines, newLines, maxChars) {
  const first = ranges[0];
  const oldCount = ranges.reduce((sum, range) => sum + range.a1 - range.a0, 0);
  const newCount = ranges.reduce((sum, range) => sum + range.b1 - range.b0, 0);
  const header = `@@ -${first.a0 + (oldCount ? 1 : 0)},${oldCount} +${first.b0 + (newCount ? 1 : 0)},${newCount} @@\n`;
  if (header.length > maxChars) return null;
  let used = header.length;
  const parts = [header];
  for (const range of ranges) {
    const source = range.type === "+" ? newLines : oldLines;
    const start = range.type === "+" ? range.b0 : range.a0;
    const end = range.type === "+" ? range.b1 : range.a1;
    for (let index = start; index < end; index++) {
      const raw = source[index];
      const ending = raw.endsWith("\n") ? "" : `\n${NO_NEWLINE}`;
      if (used + 1 + raw.length + ending.length > maxChars) return null;
      parts.push(range.type, raw, ending);
      used += 1 + raw.length + ending.length;
    }
  }
  return parts.join("");
}

function quotedPath(prefix, value) {
  const text = `${prefix}/${redactSensitiveText(String(value))}`;
  if (!/[\x00-\x20\x7f-\x9f"\\\u2028\u2029]/u.test(text)) return text;
  const escapes = { 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r", 34: '\\"', 92: "\\\\" };
  return '"' + [...Buffer.from(text, "utf8")].map((byte) => escapes[byte]
    || (byte < 32 || byte >= 127 ? `\\${byte.toString(8).padStart(3, "0")}` : String.fromCharCode(byte))).join("") + '"';
}
function consume(work) {
  if (work.remaining <= 0) { work.limited = true; return false; }
  work.remaining--;
  return true;
}
function lines(value) { return value.match(/[^\n]*\n|[^\n]+$/g) || []; }
function lineCount(value) {
  let count = 0;
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 10) count++;
  return count + (value && !value.endsWith("\n") ? 1 : 0);
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
