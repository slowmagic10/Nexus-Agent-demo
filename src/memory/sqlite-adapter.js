import { createHash, randomUUID } from "node:crypto";
import { redactSensitiveText, redactSensitiveValue } from "../security/redact.js";
import { MEMORY_EVENT_SCHEMA_VERSION } from "../persistence/migrations.js";
import {
  MemoryInterface,
  MemoryMutationError,
  normalizeMemoryAccess,
  normalizeMemoryCandidate,
  normalizeMemoryScope,
  normalizeSearchOptions,
  normalizeTags,
  throwIfMemoryAborted,
} from "./interface.js";

export class SQLiteMemoryAdapter extends MemoryInterface {
  constructor({ db, defaultScope = {}, clock = () => new Date(), idFactory = () => `memory-${randomUUID().slice(0, 12)}` }) {
    super();
    if (!db || typeof db.prepare !== "function") throw new Error("SQLiteMemoryAdapter 需要已迁移的 SQLite database");
    this.db = db;
    this.defaultScope = normalizeMemoryScope(defaultScope);
    this.clock = clock;
    this.idFactory = idFactory;
    this.id = "sqlite-lexical";
    this.capabilities = Object.freeze({ mutationIdempotency: "mutation-key" });
  }

  async search(query = "", accessInput, options = {}) {
    const access = normalizeMemoryAccess(accessInput, this.defaultScope);
    const needle = String(query || "").trim();
    const normalized = normalizeSearchOptions(options);
    const statusPlaceholders = normalized.statuses.map(() => "?").join(", ");
    const where = [
      `status IN (${statusPlaceholders})`,
      "(expires_at IS NULL OR expires_at > ?)",
      "scope_workspace IS ?",
      "scope_agent IS ?",
      "scope_user IS ?",
    ];
    const params = [
      ...normalized.statuses,
      this.#now(),
      access.scope.workspace,
      access.scope.agentId,
      access.scope.userId,
    ];
    let ranking = "updated_at DESC";
    if (needle) {
      where.push("(instr(lower(content), lower(?)) > 0 OR instr(lower(tags_json), lower(?)) > 0)");
      params.push(needle, needle);
      ranking = `
        CASE
          WHEN lower(content) = lower(?) THEN 3
          WHEN instr(lower(content), lower(?)) > 0 THEN 2
          ELSE 1
        END DESC,
        updated_at DESC
      `;
      params.push(needle, needle);
    }
    params.push(normalized.limit);
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE ${where.join(" AND ")}
      ORDER BY ${ranking}
      LIMIT ?
    `).all(...params);
    throwIfMemoryAborted(access.signal);
    return rows.map((row) => ({
      ...this.#parseRecord(row),
      adapter: this.id,
      retrievalQuery: needle,
      score: lexicalScore(row, needle),
    }));
  }

  async add(candidate, accessInput) {
    const access = normalizeMemoryAccess(accessInput, this.defaultScope, { requireProvenance: true });
    if (Object.hasOwn(candidate || {}, "scope")) throw new Error("MemoryCandidate.scope 由 MemoryAccessContext 决定，调用方不能直接指定");
    const safeCandidate = normalizeMemoryCandidate({
      ...candidate,
      content: redactSensitiveText(candidate?.content),
      scope: access.scope,
    }, this.defaultScope);
    if (["superseded", "expired", "deleted"].includes(safeCandidate.status)) {
      throw new Error("新增长期记忆只能是 active 或 candidate 状态");
    }
    const safeProvenance = redactSensitiveValue(access.provenance);
    const requestHash = mutationRequestHash("add", { candidate: safeCandidate }, access, safeProvenance);
    const replay = this.#readMutation(access, "add", requestHash);
    if (replay !== null) return replay;
    const provenanceValidated = this.#validateProvenance(safeProvenance, access.scope);
    const now = this.#now();
    const existing = this.#findDuplicate(safeCandidate);
    if (existing) {
      const record = {
        ...existing,
        tags: normalizeTags([...existing.tags, ...safeCandidate.tags]),
        confidence: Math.max(existing.confidence, safeCandidate.confidence),
        provenance: safeProvenance,
        provenanceValidated,
        sourceSession: safeProvenance.sessionId || existing.sourceSession,
        sourceCursor: safeProvenance.sourceCursor ?? existing.sourceCursor,
        sourceToolCall: safeProvenance.toolCallId ?? existing.sourceToolCall,
        observedAt: safeCandidate.observedAt || existing.observedAt,
        updatedAt: now,
        version: existing.version + 1,
      };
      this.#transaction(() => {
        this.#updateRecord(record);
        this.#appendEvent(record.id, "memory.observed_again", safeProvenance, { deduplicated: true });
        this.#recordMutation(access, "add", record.id, record, requestHash);
      });
      return record;
    }

    const record = {
      id: validateId(safeCandidate.id || this.idFactory()),
      scope: safeCandidate.scope,
      kind: safeCandidate.kind,
      content: safeCandidate.content,
      status: safeCandidate.status,
      confidence: safeCandidate.confidence,
      sourceSession: safeProvenance.sessionId,
      sourceCursor: safeProvenance.sourceCursor,
      sourceToolCall: safeProvenance.toolCallId,
      provenance: safeProvenance,
      provenanceValidated,
      observedAt: safeCandidate.observedAt || now,
      expiresAt: safeCandidate.expiresAt,
      version: 1,
      tags: safeCandidate.tags,
      replacementId: null,
      deletedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO memories (
          id, content, tags_json, source_session, created_at, updated_at,
          scope_workspace, scope_agent, scope_user, kind, status, confidence,
          source_event, provenance_json, observed_at, expires_at, version,
          replacement_id, deleted_reason, source_cursor, source_tool_call, provenance_validated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...recordValues(record));
      this.#appendEvent(record.id, "memory.added", safeProvenance, {
        kind: record.kind,
        status: record.status,
        sourceSession: record.sourceSession,
        sourceCursor: record.sourceCursor,
        sourceToolCall: record.sourceToolCall,
      });
      this.#recordMutation(access, "add", record.id, record, requestHash);
    });
    return record;
  }

  async update(id, patch, accessInput) {
    const access = normalizeMemoryAccess(accessInput, this.defaultScope, { requireProvenance: true });
    const memoryId = validateId(id);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("MemoryPatch 必须是对象");
    const allowedFields = new Set(["content", "kind", "status", "confidence", "tags", "observedAt", "expiresAt"]);
    const unsupported = Object.keys(patch).filter((field) => !allowedFields.has(field));
    if (unsupported.length) throw new Error(`MemoryPatch 包含不可修改字段：${unsupported.join(", ")}`);
    const safePatch = redactSensitiveValue({
      ...patch,
      ...(typeof patch.content === "string" ? { content: redactSensitiveText(patch.content) } : {}),
    });
    const safeProvenance = redactSensitiveValue(access.provenance);
    const requestHash = mutationRequestHash("update", { memoryId, patch: safePatch }, access, safeProvenance);
    const replay = this.#readMutation(access, "update", requestHash);
    if (replay !== null) return replay;
    const current = this.#getRecord(memoryId, access.scope, { includeInactive: true });
    if (!current || current.status === "deleted") throw new Error(`未找到可更新的长期记忆：${memoryId}`);
    const candidate = normalizeMemoryCandidate({
      ...current,
      ...safePatch,
      content: safePatch.content ?? current.content,
      scope: current.scope,
      tags: safePatch.tags ?? current.tags,
    }, this.defaultScope);
    if (["superseded", "deleted"].includes(candidate.status)) {
      throw new Error("请使用 supersede/delete 修改长期记忆终态");
    }
    const record = {
      ...current,
      ...candidate,
      provenance: safeProvenance,
      provenanceValidated: this.#validateProvenance(safeProvenance, access.scope),
      sourceSession: safeProvenance.sessionId || current.sourceSession,
      sourceCursor: safeProvenance.sourceCursor ?? current.sourceCursor,
      sourceToolCall: safeProvenance.toolCallId ?? current.sourceToolCall,
      updatedAt: this.#now(),
      version: current.version + 1,
    };
    this.#transaction(() => {
      this.#updateRecord(record);
      this.#appendEvent(record.id, "memory.updated", safeProvenance, { fields: Object.keys(safePatch).sort() });
      this.#recordMutation(access, "update", record.id, record, requestHash);
    });
    return record;
  }

  async supersede(id, replacementId, accessInput) {
    const access = normalizeMemoryAccess(accessInput, this.defaultScope, { requireProvenance: true });
    const memoryId = validateId(id);
    const safeReplacementId = validateId(replacementId);
    const safeProvenance = redactSensitiveValue(access.provenance);
    const requestHash = mutationRequestHash("supersede", {
      memoryId,
      replacementId: safeReplacementId,
    }, access, safeProvenance);
    const replay = this.#readMutation(access, "supersede", requestHash);
    if (replay !== null) return replay;
    if (memoryId === safeReplacementId) throw new Error("长期记忆不能 supersede 自身");
    const current = this.#getRecord(memoryId, access.scope, { includeInactive: true });
    const replacement = this.#getRecord(safeReplacementId, access.scope, { includeInactive: true });
    if (!current || current.status === "deleted") throw new Error(`未找到可替代的长期记忆：${memoryId}`);
    if (!replacement || replacement.status !== "active") throw new Error(`替代记忆必须处于 active：${safeReplacementId}`);
    const record = {
      ...current,
      status: "superseded",
      replacementId: safeReplacementId,
      provenance: safeProvenance,
      provenanceValidated: this.#validateProvenance(safeProvenance, access.scope),
      sourceSession: safeProvenance.sessionId || current.sourceSession,
      sourceCursor: safeProvenance.sourceCursor ?? current.sourceCursor,
      sourceToolCall: safeProvenance.toolCallId ?? current.sourceToolCall,
      updatedAt: this.#now(),
      version: current.version + 1,
    };
    this.#transaction(() => {
      this.#updateRecord(record);
      this.#appendEvent(memoryId, "memory.superseded", safeProvenance, { replacementId: safeReplacementId });
      this.#recordMutation(access, "supersede", memoryId, record, requestHash);
    });
    return record;
  }

  async delete(id, reason, accessInput) {
    const access = normalizeMemoryAccess(accessInput, this.defaultScope, { requireProvenance: true });
    const memoryId = validateId(id);
    if (typeof reason !== "string" || !reason.trim()) throw new Error("删除长期记忆必须提供原因");
    const safeReason = redactSensitiveText(reason.trim());
    const safeProvenance = redactSensitiveValue(access.provenance);
    const requestHash = mutationRequestHash("delete", { memoryId, reason: safeReason }, access, safeProvenance);
    const replay = this.#readMutation(access, "delete", requestHash);
    if (replay !== null) return replay;
    const current = this.#getRecord(memoryId, access.scope, { includeInactive: true });
    if (!current || current.status === "deleted") {
      this.#transaction(() => this.#recordMutation(access, "delete", current?.id || null, false, requestHash));
      return false;
    }
    const record = {
      ...current,
      status: "deleted",
      deletedReason: safeReason,
      provenance: safeProvenance,
      provenanceValidated: this.#validateProvenance(safeProvenance, access.scope),
      sourceSession: safeProvenance.sessionId || current.sourceSession,
      sourceCursor: safeProvenance.sourceCursor ?? current.sourceCursor,
      sourceToolCall: safeProvenance.toolCallId ?? current.sourceToolCall,
      updatedAt: this.#now(),
      version: current.version + 1,
    };
    this.#transaction(() => {
      this.#updateRecord(record);
      this.#appendEvent(memoryId, "memory.deleted", safeProvenance, { reason: record.deletedReason });
      this.#recordMutation(access, "delete", memoryId, true, requestHash);
    });
    return true;
  }

  async get(id, accessInput, { includeInactive = false } = {}) {
    const access = normalizeMemoryAccess(accessInput, this.defaultScope);
    return this.#getRecord(id, access.scope, { includeInactive });
  }

  async verify(id, accessInput) {
    const access = normalizeMemoryAccess(accessInput, this.defaultScope);
    const record = this.#getRecord(id, access.scope, { includeInactive: true });
    if (!record) return null;
    const events = this.db.prepare(`
      SELECT seq, at, type, schema_version AS schemaVersion,
        provenance_json AS provenanceJson, detail_json AS detailJson
      FROM memory_events WHERE memory_id = ? ORDER BY seq
    `).all(id).map((event) => ({
      seq: event.seq,
      at: event.at,
      type: event.type,
      schemaVersion: event.schemaVersion,
      provenance: parseJson(event.provenanceJson, {}),
      detail: parseJson(event.detailJson, {}),
    }));
    throwIfMemoryAborted(access.signal);
    return { record, events };
  }

  #getRecord(id, scope, { includeInactive = false } = {}) {
    const row = this.db.prepare(`
      SELECT * FROM memories
      WHERE id = ? AND scope_workspace IS ? AND scope_agent IS ? AND scope_user IS ?
    `).get(validateId(id), scope.workspace, scope.agentId, scope.userId);
    if (!row || (!includeInactive && row.status !== "active")) return null;
    return this.#parseRecord(row);
  }

  #findDuplicate(candidate) {
    const row = this.db.prepare(`
      SELECT * FROM memories
      WHERE status = 'active' AND lower(content) = lower(?)
        AND scope_workspace IS ? AND scope_agent IS ? AND scope_user IS ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(candidate.content, candidate.scope.workspace, candidate.scope.agentId, candidate.scope.userId);
    return row ? this.#parseRecord(row) : null;
  }

  #validateProvenance(provenance, accessScope) {
    const hasLocalSource = provenance.sessionId || provenance.sourceCursor || provenance.toolCallId;
    if (!hasLocalSource) {
      if (provenance.origin === "tool") throw new Error("tool provenance 必须包含 sessionId、sourceCursor 和 toolCallId");
      return provenance.origin !== "legacy";
    }
    if (!provenance.sessionId || !provenance.sourceCursor) {
      throw new Error("本地 provenance 必须同时包含 sessionId 和 sourceCursor");
    }
    if (provenance.origin === "tool" && !provenance.toolCallId) {
      throw new Error("tool provenance 必须包含 toolCallId");
    }
    const sourceEvents = this.db.prepare(`
      SELECT seq, type, event_json AS eventJson
      FROM session_events
      WHERE session_id = ? AND seq <= ?
        AND (seq = 1 OR seq = ? OR type = 'RESUMED')
      ORDER BY seq
    `).all(provenance.sessionId, provenance.sourceCursor, provenance.sourceCursor);
    const event = sourceEvents.find((item) => item.seq === provenance.sourceCursor);
    if (!event) throw new Error(`provenance 来源不存在：${provenance.sessionId}#${provenance.sourceCursor}`);
    const baseline = sourceEvents.find((item) => item.seq === 1 && item.type === "SESSION_BASELINE");
    if (!baseline) throw new Error(`provenance 来源 Session 缺少 Durable baseline：${provenance.sessionId}`);
    const baselineState = parseJson(baseline.eventJson, {}).state;
    let sourceScope = normalizeMemoryScope(baselineState?.memoryScope || { workspace: baselineState?.workspace });
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.type !== "RESUMED") continue;
      const action = parseJson(sourceEvent.eventJson, {}).action;
      if (action?.workspace) sourceScope = normalizeMemoryScope({ ...sourceScope, workspace: action.workspace });
    }
    if (!sameScope(sourceScope, accessScope)) {
      throw new Error("provenance 来源 Session 不属于当前 Memory scope");
    }
    if (provenance.toolCallId) {
      const payload = parseJson(event.eventJson, {});
      if (event.type !== "TOOL_REQUESTED" || payload.action?.call?.id !== provenance.toolCallId) {
        throw new Error("provenance.toolCallId 与 Durable Session Event 不匹配");
      }
    }
    return true;
  }

  #readMutation(access, operation, requestHash) {
    if (!access.mutationId) return null;
    const row = this.db.prepare(`
      SELECT operation, request_hash AS requestHash, result_json AS resultJson
      FROM memory_mutations WHERE mutation_id = ?
    `).get(access.mutationId);
    if (!row) return null;
    if (row.operation !== operation) throw new Error(`mutationId 已用于其他操作：${access.mutationId}`);
    if (!row.requestHash) {
      throw new MemoryMutationError(
        `legacy mutationId 无法验证请求内容，需要人工处理：${access.mutationId}`,
        {
          code: "MEMORY_LEGACY_MUTATION_UNVERIFIED",
          outcome: "outcome_unknown",
          retryable: false,
        },
      );
    }
    if (row.requestHash && row.requestHash !== requestHash) {
      throw new Error(`mutationId 请求内容冲突：${access.mutationId}`);
    }
    const envelope = parseJson(row.resultJson, null);
    if (!envelope || !sameScope(envelope.scope, access.scope)) {
      throw new Error("mutationId 不属于当前 Memory scope");
    }
    return structuredClone(envelope.value);
  }

  #recordMutation(access, operation, memoryId, value, requestHash) {
    if (!access.mutationId) return;
    this.db.prepare(`
      INSERT INTO memory_mutations (mutation_id, memory_id, operation, request_hash, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      access.mutationId,
      memoryId,
      operation,
      requestHash,
      JSON.stringify(redactSensitiveValue({ scope: access.scope, value })),
      this.#now(),
    );
  }

  #updateRecord(record) {
    this.db.prepare(`
      UPDATE memories SET
        content = ?, tags_json = ?, source_session = ?, updated_at = ?,
        scope_workspace = ?, scope_agent = ?, scope_user = ?, kind = ?, status = ?, confidence = ?,
        provenance_json = ?, observed_at = ?, expires_at = ?, version = ?, replacement_id = ?,
        deleted_reason = ?, source_cursor = ?, source_tool_call = ?, provenance_validated = ?
      WHERE id = ? AND scope_workspace IS ? AND scope_agent IS ? AND scope_user IS ?
    `).run(
      record.content,
      JSON.stringify(record.tags),
      record.sourceSession,
      record.updatedAt,
      record.scope.workspace,
      record.scope.agentId,
      record.scope.userId,
      record.kind,
      record.status,
      record.confidence,
      JSON.stringify(record.provenance),
      record.observedAt,
      record.expiresAt,
      record.version,
      record.replacementId,
      record.deletedReason,
      record.sourceCursor,
      record.sourceToolCall,
      record.provenanceValidated ? 1 : 0,
      record.id,
      record.scope.workspace,
      record.scope.agentId,
      record.scope.userId,
    );
  }

  #appendEvent(memoryId, type, provenance, detail) {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_events WHERE memory_id = ?",
    ).get(memoryId);
    this.db.prepare(`
      INSERT INTO memory_events (
        memory_id, seq, at, type, schema_version, provenance_json, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoryId,
      row.seq + 1,
      this.#now(),
      type,
      MEMORY_EVENT_SCHEMA_VERSION,
      JSON.stringify(redactSensitiveValue(provenance)),
      JSON.stringify(redactSensitiveValue(detail)),
    );
  }

  #parseRecord(row) {
    const scope = normalizeMemoryScope({
      workspace: row.scope_workspace,
      agentId: row.scope_agent,
      userId: row.scope_user,
    }, this.defaultScope);
    const legacyProvenance = { origin: "legacy", sessionId: row.source_session || null, sourceCursor: null };
    return {
      id: row.id,
      scope,
      kind: row.kind || "fact",
      content: row.content,
      status: row.status || "active",
      confidence: Number(row.confidence ?? 1),
      sourceSession: row.source_session || null,
      sourceCursor: row.source_cursor ?? null,
      sourceToolCall: row.source_tool_call || null,
      provenance: parseJson(row.provenance_json, legacyProvenance),
      provenanceValidated: Boolean(row.provenance_validated),
      observedAt: row.observed_at || row.created_at,
      expiresAt: row.expires_at || null,
      version: Number(row.version || 1),
      tags: parseJson(row.tags_json, []),
      replacementId: row.replacement_id || null,
      deletedReason: row.deleted_reason || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #transaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #now() {
    return this.clock().toISOString();
  }
}

function recordValues(record) {
  return [
    record.id,
    record.content,
    JSON.stringify(record.tags),
    record.sourceSession,
    record.createdAt,
    record.updatedAt,
    record.scope.workspace,
    record.scope.agentId,
    record.scope.userId,
    record.kind,
    record.status,
    record.confidence,
    null,
    JSON.stringify(record.provenance),
    record.observedAt,
    record.expiresAt,
    record.version,
    record.replacementId,
    record.deletedReason,
    record.sourceCursor,
    record.sourceToolCall,
    record.provenanceValidated ? 1 : 0,
  ];
}

function lexicalScore(row, query) {
  if (!query) return 1;
  const needle = query.toLowerCase();
  const content = row.content.toLowerCase();
  if (content === needle) return 1;
  if (content.includes(needle)) return 0.8;
  return 0.6;
}

function sameScope(left, right) {
  return Boolean(left && right)
    && left.workspace === right.workspace
    && left.agentId === right.agentId
    && left.userId === right.userId;
}

function mutationRequestHash(operation, payload, access, provenance) {
  const canonical = canonicalize({
    operation,
    payload: redactSensitiveValue(payload),
    scope: access.scope,
    provenance,
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function validateId(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("memoryId 必须是非空字符串");
  return value.trim();
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return structuredClone(fallback); }
}
