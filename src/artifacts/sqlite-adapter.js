// FOUNDATION — SQLite-backed, session-scoped text Artifact Adapter.
import { createHash, randomUUID } from "node:crypto";
import {
  artifactMetadata,
  DEFAULT_ARTIFACT_MEDIA_TYPE,
  MAX_ARTIFACT_BYTES,
} from "./interface.js";

export class SQLiteArtifactAdapter {
  constructor({ db, maxBytes = MAX_ARTIFACT_BYTES }) {
    if (!db || typeof db.prepare !== "function") throw new Error("SQLite Artifact Adapter 需要数据库连接");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Artifact maxBytes 必须是正整数");
    this.db = db;
    this.maxBytes = maxBytes;
  }

  async put({
    id = `artifact-${randomUUID()}`,
    sessionId,
    callId = null,
    kind = "tool_output",
    mediaType = DEFAULT_ARTIFACT_MEDIA_TYPE,
    content,
    createdAt = new Date().toISOString(),
  }) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Artifact sessionId 无效");
    if (typeof content !== "string") throw new Error("首版 Artifact Adapter 只接受文本内容");
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > this.maxBytes) throw new Error(`Artifact 超过 ${this.maxBytes} 字节上限`);
    const record = artifactMetadata({
      id,
      sessionId,
      callId,
      kind,
      mediaType,
      byteSize: bytes.byteLength,
      sha256: digest(bytes),
      createdAt,
    });
    this.db.prepare(`
      INSERT INTO artifacts (
        id, session_id, call_id, kind, media_type, byte_size, sha256, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sessionId,
      record.callId,
      record.kind,
      record.mediaType,
      record.byteSize,
      record.sha256,
      bytes,
      record.createdAt,
    );
    return record;
  }

  async get(id, { sessionId } = {}) {
    assertLookup(id, sessionId);
    const row = this.db.prepare(`
      SELECT id, session_id, call_id, kind, media_type, byte_size, sha256, content, created_at
      FROM artifacts WHERE id = ? AND session_id = ?
    `).get(id, sessionId);
    if (!row) return null;
    const bytes = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    if (bytes.byteLength !== row.byte_size || digest(bytes) !== row.sha256) {
      throw new Error(`Artifact ${id} 完整性校验失败`);
    }
    return {
      ...rowMetadata(row),
      content: bytes.toString("utf8"),
    };
  }

  async list({ sessionId } = {}) {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Artifact list 需要 sessionId");
    return this.db.prepare(`
      SELECT id, session_id, call_id, kind, media_type, byte_size, sha256, created_at
      FROM artifacts WHERE session_id = ? ORDER BY created_at, id
    `).all(sessionId).map(rowMetadata);
  }
}

function rowMetadata(row) {
  return artifactMetadata({
    id: row.id,
    sessionId: row.session_id,
    callId: row.call_id,
    kind: row.kind,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: row.created_at,
  });
}

function assertLookup(id, sessionId) {
  if (typeof id !== "string" || !id) throw new Error("Artifact id 无效");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Artifact get 需要 sessionId");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
