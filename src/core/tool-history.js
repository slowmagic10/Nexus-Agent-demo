// Read-only projection of current-session durable tool records. Never replays tools.
import { createHash } from "node:crypto";
import { redactSensitiveValue } from "../security/redact.js";
import { serializeRedactedToolJson as serializeToolHistory } from "../security/tool-json.js";
export { serializeRedactedToolJson as serializeToolHistory } from "../security/tool-json.js";

export const MAX_TOOL_HISTORY_RESPONSE_CHARS = 10_000;
const PRIVATE_TOOL_NAMES = new Set(["remember", "recall_memory", "memory_save", "memory_search", "memory_delete"]);
const QUERY_KEYS = new Set(["call_id", "source_cursor", "after_cursor", "snapshot_cursor", "page_size", "offset", "limit", "expected_sha256"]);

export function queryToolHistory(journal, sessionId, input = {}) {
  validateQuery(input);
  if (typeof journal?.toolHistorySnapshot !== "function"
      || typeof journal?.readToolHistoryOccurrences !== "function"
      || typeof journal?.readToolHistoryRecord !== "function") {
    return { available: false, reason: "durable_journal_unavailable" };
  }
  const latest = journal.toolHistorySnapshot(sessionId);
  const snapshotCursor = input.snapshot_cursor ?? latest;
  if (snapshotCursor > latest) throw new Error("snapshot_cursor 不能超过当前 Session 的 durable cursor");
  if (input.source_cursor === undefined) {
    const after = input.after_cursor ?? 0;
    if (after > snapshotCursor) throw new Error("after_cursor 不能超过 snapshot_cursor");
    const size = input.page_size ?? 10;
    const rows = journal.readToolHistoryOccurrences(sessionId, {
      after, until: snapshotCursor, callId: input.call_id, limit: size + 1,
    });
    const occurrences = [];
    const result = { available: true, snapshotCursor, occurrences, nextAfterCursor: null };
    for (const row of rows.slice(0, size)) {
      occurrences.push(safeMetadata(row));
      result.nextAfterCursor = row.sourceCursor;
      if (serializeToolHistory(result).length > MAX_TOOL_HISTORY_RESPONSE_CHARS) {
        occurrences.pop();
        break;
      }
    }
    result.nextAfterCursor = occurrences.length < rows.length ? occurrences.at(-1)?.sourceCursor ?? after : null;
    return result;
  }
  if (input.source_cursor > snapshotCursor) throw new Error("source_cursor 不能超过 snapshot_cursor");
  const raw = journal.readToolHistoryRecord(sessionId, { sourceCursor: input.source_cursor, until: snapshotCursor });
  if (!raw) throw new Error("source_cursor 不是当前 Session 的 TOOL_REQUESTED durable cursor；展示事件 seq 不能代替它");
  if (input.call_id !== undefined && input.call_id !== raw.callId) throw new Error("call_id 与 source_cursor 的工具调用不匹配");
  const record = safeMetadata(raw);
  const safe = safeRecord(raw);
  if (safe.contentOmitted) record.contentOmitted = safe.contentOmitted;
  if (safe.contentOmitted === "record_too_large") {
    record.recordBytes = safe.recordBytes;
    record.maxRecordBytes = safe.maxRecordBytes;
  }
  record.artifacts = (safe.contentOmitted === "record_too_large" ? safe.artifacts
    : safe.contentOmitted ? [] : [safe.result?.artifact, safe.result?.fileChanges?.diffArtifact])
    .filter(Boolean).map((artifact) => ({ ...artifact,
      ...(artifact.id.length > 256 ? { id: null, idInRecordPage: true } : {}) }));
  const content = JSON.stringify(safe);
  const sha256 = createHash("sha256").update(JSON.stringify(["nexus.tool-history.v1", sessionId, snapshotCursor, input.source_cursor, content])).digest("hex");
  if (input.expected_sha256 !== undefined && input.expected_sha256 !== sha256) {
    throw new Error("expected_sha256 与当前工具记录/snapshot不匹配，请重新从 offset 0 读取");
  }
  const offset = input.offset ?? 0;
  const { chars, totalChars } = unicodePage(content, offset, input.limit ?? 4_000);
  if (offset > totalChars) throw new Error("offset 超出工具记录字符长度");
  let count = chars.length;
  const response = { available: true, snapshotCursor, record,
    page: { encoding: "json", sha256, totalChars, offset, end: offset, content: "", nextOffset: null } };
  // JSON escaping may expand every character; cap the final wire response, not
  // merely the unescaped page, so ToolHost never silently cuts pagination data.
  do {
    response.page.end = offset + count;
    response.page.content = chars.slice(0, count).join("");
    response.page.nextOffset = response.page.end < totalChars ? response.page.end : null;
    if (serializeToolHistory(response).length <= MAX_TOOL_HISTORY_RESPONSE_CHARS) return response;
    count = Math.floor(count / 2);
  } while (count > 0);
  throw new Error("工具记录元数据过大，无法在有界响应内读取");
}

function unicodePage(content, offset, limit) {
  let totalChars = 0;
  const chars = [];
  for (const char of content) {
    if (totalChars >= offset && chars.length < limit) chars.push(char);
    totalChars += 1;
  }
  return { chars, totalChars };
}

function safeMetadata(raw) {
  return redactSensitiveValue({
    sourceCursor: raw.sourceCursor,
    callId: shortText(raw.callId),
    toolName: shortText(raw.toolName),
    at: shortText(raw.at),
    resultCursor: raw.resultCursor ?? null,
    status: shortText(raw.status ?? "pending"),
    ...(Object.values({ callId: raw.callId, toolName: raw.toolName, at: raw.at, status: raw.status })
      .some((value) => typeof value === "string" && Array.from(value).length > 256) ? { metadataTruncated: true } : {}),
    ...(raw.association === "ambiguous" ? { association: "ambiguous" } : {}),
  });
}

function safeRecord(raw) {
  const request = raw.request;
  const effects = Array.isArray(request?.effects) ? request.effects : [];
  const contentOmitted = raw.toolName === "read_tool_history" ? "history_read"
    : raw.privateTool || PRIVATE_TOOL_NAMES.has(raw.toolName) || effects.some((effect) => effect === "memory" || effect === "credential") ? "private_tool" : null;
  if (contentOmitted) return { ...safeMetadata(raw), contentOmitted };
  if (raw.contentOmitted === "record_too_large") return { ...safeMetadata(raw), contentOmitted: raw.contentOmitted,
    recordBytes: raw.recordBytes, maxRecordBytes: raw.maxRecordBytes,
    artifacts: (raw.artifacts ?? []).map(safeArtifact).filter(Boolean) };
  const action = raw.result;
  const artifact = safeArtifact(action?.artifact);
  const diffArtifact = safeArtifact(action?.fileChanges?.diffArtifact);
  return redactSensitiveValue({
    request: { arguments: request.call.arguments, effects },
    result: action ? {
      content: action.result,
      ok: action.ok,
      status: action.status ?? (action.ok ? "completed" : "failed"),
      durationMs: action.durationMs ?? 0,
      ...(action.terminationReason ? { terminationReason: action.terminationReason } : {}),
      ...(artifact ? { artifact } : {}),
      ...(diffArtifact ? { fileChanges: { diffArtifact } } : {}),
    } : null,
    ...(raw.association === "ambiguous" ? { resultUnavailable: "ambiguous_call_id_occurrence" } : {}),
  });
}

function safeArtifact(value) {
  if (!value || typeof value.id !== "string") return null;
  // References only: even imported metadata must not smuggle content into a
  // supposedly small envelope or permit an arbitrary Session lookup.
  return redactSensitiveValue({ id: value.id, kind: shortText(value.kind),
    sha256: shortText(value.sha256), byteSize: Number.isSafeInteger(value.byteSize) ? value.byteSize : null });
}

function shortText(value) {
  return typeof value === "string" ? Array.from(value).slice(0, 256).join("") : null;
}

function validateQuery(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("工具历史参数必须是对象");
  for (const key of Object.keys(input)) if (!QUERY_KEYS.has(key)) throw new Error(`工具历史不支持参数 ${key}`);
  for (const key of ["source_cursor", "snapshot_cursor"]) integer(input, key, 1, Number.MAX_SAFE_INTEGER);
  integer(input, "after_cursor", 0, Number.MAX_SAFE_INTEGER);
  integer(input, "offset", 0, Number.MAX_SAFE_INTEGER);
  integer(input, "limit", 1, 8_000);
  integer(input, "page_size", 1, 20);
  if (input.call_id !== undefined && (typeof input.call_id !== "string" || !input.call_id || input.call_id.length > 1_000)) throw new Error("call_id 必须是 1 到 1000 字符的字符串");
  if (input.expected_sha256 !== undefined && (typeof input.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.expected_sha256))) throw new Error("expected_sha256 必须是64位小写十六进制SHA-256");
  if (input.source_cursor === undefined && ["offset", "limit", "expected_sha256"].some((key) => input[key] !== undefined)) throw new Error("字符分页必须指定 source_cursor");
  if (input.source_cursor !== undefined && ["after_cursor", "page_size"].some((key) => input[key] !== undefined)) throw new Error("source_cursor 精读不能混用 after_cursor/page_size");
  if ((input.after_cursor ?? 0) > 0 && input.snapshot_cursor === undefined) throw new Error("发现后续页必须携带 snapshot_cursor");
  if ((input.offset ?? 0) > 0 && (input.snapshot_cursor === undefined || input.expected_sha256 === undefined)) throw new Error("字符后续页必须携带 snapshot_cursor 和 expected_sha256");
}

function integer(input, key, min, max) {
  if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max)) {
    throw new Error(`${key} 必须是 ${min} 到 ${max} 的整数`);
  }
}
