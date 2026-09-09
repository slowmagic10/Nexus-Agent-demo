// FOUNDATION — SQLite Session Journal plus a compatibility facade for Memory Interface.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createSessionBranch, migrateSessionState, reduceSession } from "../core/state.js";
import { resolveSessionDisplayTitle } from "../core/session-display-title.js";
import { deriveAgentProfileSnapshot } from "../core/agent-profile.js";
import { redactSensitiveValue } from "../security/redact.js";
import { createStatePatch } from "../state-patch.js";
import { EVENT_SCHEMA_VERSION, migrateDatabase } from "./migrations.js";
import { compileStateCachePatch } from "./state-cache-patch.js";
import { SQLiteMemoryAdapter } from "../memory/sqlite-adapter.js";
import { createMemoryScope } from "../memory/scope.js";
import { SQLiteArtifactAdapter } from "../artifacts/sqlite-adapter.js";
import { artifactMetadata, MAX_ARTIFACT_BYTES } from "../artifacts/interface.js";
import {
  ArchiveExportError,
  assertJournalImportBytes,
  assertJournalImportEnvelope,
  assertPortableArtifactBudget,
} from "./archive-limits.js";

const JOURNAL_FORMAT = "nexus.session-journal";
const JOURNAL_FORMAT_VERSION = 1;
export const MAX_TOOL_HISTORY_RECORD_BYTES = 4_000_000;

export function validateAndReplayJournalArchive(archive) {
  const validated = validateJournalArchive(archive);
  return {
    state: structuredClone(validated.state),
    events: structuredClone(validated.events),
    artifactCount: validated.artifacts.length,
  };
}

export class SessionStore {
  constructor(file, { checkpointInterval = 100, workspace, memoryScope } = {}) {
    if (!Number.isInteger(checkpointInterval) || checkpointInterval < 1) {
      throw new Error("checkpointInterval 必须是正整数");
    }
    this.file = path.resolve(file);
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("SessionStore 必须显式提供 workspace");
    this.workspace = path.resolve(workspace);
    this.memoryScope = createMemoryScope(memoryScope || { workspace: this.workspace });
    this.checkpointInterval = checkpointInterval;
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    try {
      migrateDatabase(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.db.prepare(`
      UPDATE memories SET scope_workspace = ?, scope_agent = ?, scope_user = ?
      WHERE scope_workspace IS NULL AND scope_agent IS NULL AND scope_user IS NULL
        AND provenance_json = '{"origin":"legacy"}'
    `).run(this.memoryScope.workspace, this.memoryScope.agentId, this.memoryScope.userId);
    this.memory = new SQLiteMemoryAdapter({
      db: this.db,
      defaultScope: this.memoryScope,
    });
    this.artifacts = new SQLiteArtifactAdapter({ db: this.db });
    this.upsert = this.db.prepare(`
      INSERT INTO sessions (
        id, created_at, updated_at, provider, workspace, phase, message_count, state_json,
        cache_cursor, display_title, cache_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        provider = excluded.provider,
        workspace = excluded.workspace,
        phase = excluded.phase,
        message_count = excluded.message_count,
        state_json = excluded.state_json,
        cache_cursor = excluded.cache_cursor,
        display_title = excluded.display_title,
        cache_generation = sessions.cache_generation + 1
    `);
  }

  save(state) {
    // Explicit legacy saves do not prove agreement with the current Journal.
    this.#saveDurable(redactSensitiveValue(state));
  }

  #saveDurable(durableState, cacheCursor = null, stateJson = JSON.stringify(durableState)) {
    this.upsert.run(
      durableState.id,
      durableState.createdAt,
      durableState.updatedAt,
      durableState.provider,
      durableState.workspace,
      durableState.phase,
      durableState.messages.length,
      stateJson,
      cacheCursor,
      resolveSessionDisplayTitle(durableState),
    );
  }

  ensureJournal(state) {
    return this.ensureJournalWithReceipt(state).state;
  }

  ensureJournalWithReceipt(state) {
    // The state, model projection and cursor must belong to the same database
    // snapshot. Reading a newer head after replay would make a stale state
    // appear current and defeat the expectedCursor check on its first commit.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT 1 FROM session_events WHERE session_id = ? LIMIT 1").get(state.id);
      let durableState;
      let events;
      if (existing) {
        events = this.readProjectionEvents(state.id);
        durableState = replayProjection(events, state.id);
      } else {
        const cache = this.db.prepare("SELECT cache_cursor FROM sessions WHERE id = ?").get(state.id);
        if (cache?.cache_cursor > 0) throw new Error(`会话 ${state.id} 的事件日志缺少基线`);
        durableState = redactSensitiveValue(state);
        this.#insertJournalBaseline(durableState);
        events = [{ cursor: 1, sessionId: durableState.id, type: "SESSION_BASELINE",
          at: durableState.createdAt, baseline: durableState }];
      }
      const cursor = this.latestSessionCursor(durableState.id);
      this.db.exec("COMMIT");
      return { state: durableState, cursor, events };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  commitSessionEvent(nextState, action, patch, { expectedCursor } = {}) {
    const trustedPatch = expectedCursor !== undefined;
    if (trustedPatch && (!Number.isSafeInteger(expectedCursor) || expectedCursor < 1)) {
      throw new Error("提交 expectedCursor 必须是正安全整数");
    }
    const metadata = redactSensitiveValue({ id: nextState.id, schemaVersion: nextState.schemaVersion,
      updatedAt: nextState.updatedAt, provider: nextState.provider, workspace: nextState.workspace,
      phase: nextState.phase, messageCount: nextState.messages.length, displayTitle: nextState.displayTitle ?? null });
    const durableAction = redactSensitiveValue(action);
    const durablePatch = redactSensitiveValue(patch);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM session_events WHERE session_id = ?",
      ).get(metadata.id);
      if (row.seq === 0) throw new Error(`会话 ${metadata.id} 尚未建立事件基线`);
      if (trustedPatch && row.seq !== expectedCursor) {
        throw new Error(`会话 ${metadata.id} 提交游标冲突：expectedCursor ${expectedCursor}，实际 ${row.seq}；请重新加载会话`);
      }
      const cursor = row.seq + 1;
      this.db.prepare(`
        INSERT INTO session_events (session_id, seq, at, type, event_json, schema_version)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        metadata.id,
        cursor,
        durableAction.at,
        durableAction.type,
        JSON.stringify({ action: durableAction, patch: durablePatch }),
        EVENT_SCHEMA_VERSION,
      );
      const checkpointDue = cursor % this.checkpointInterval === 0;
      // Checkpoints already require a full durable snapshot. Other trusted
      // commits bind only their delta; unsupported or stale caches fall back.
      if (checkpointDue || !trustedPatch || !this.#updateStateCache(metadata, nextState, durablePatch, expectedCursor, cursor)) {
        const durableState = redactSensitiveValue(nextState);
        const stateJson = JSON.stringify(durableState);
        this.#saveDurable(durableState, trustedPatch ? cursor : null, stateJson);
        if (checkpointDue) this.#writeCheckpoint(durableState, cursor, durableAction.at, stateJson);
      }
      this.db.exec("COMMIT");
      return {
        cursor,
        sessionId: metadata.id,
        type: durableAction.type,
        at: durableAction.at,
        action: durableAction,
        patch: durablePatch,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #updateStateCache(metadata, nextState, patch, expectedCursor, cursor) {
    const compiled = compileStateCachePatch(patch);
    if (!compiled) return false;
    // CASE guards malformed JSON before SQLite evaluates any JSON path. The
    // materialized candidate computes the patch once and keeps a NULL result
    // (e.g. append to a non-array) out of the NOT NULL compatibility snapshot.
    // state_json remains complete and current for legacy readers/deletion.
    const result = this.db.prepare(`
      WITH candidate AS MATERIALIZED (
        SELECT CASE WHEN json_valid(state_json) THEN
          CASE WHEN json_type(state_json) = 'object'
            AND json_extract(state_json, '$.id') = ?
            AND json_extract(state_json, '$.schemaVersion') = ?
          THEN json_set(${compiled.expression}, '$.displayTitle', json(?)) END
        END AS patched
        FROM sessions WHERE id = ? AND cache_cursor = ?
      )
      UPDATE sessions SET state_json = (SELECT patched FROM candidate),
        updated_at = ?, provider = ?, workspace = ?, phase = ?, message_count = ?,
        display_title = ?, cache_cursor = ?, cache_generation = cache_generation + 1
      WHERE id = ? AND (SELECT patched FROM candidate) IS NOT NULL
    `).run(metadata.id, metadata.schemaVersion, ...compiled.params, JSON.stringify(metadata.displayTitle),
      metadata.id, expectedCursor, metadata.updatedAt, metadata.provider, metadata.workspace, metadata.phase,
      metadata.messageCount, resolveSessionDisplayTitle(nextState), cursor, metadata.id);
    return result.changes === 1;
  }

  listSessionEvents(id) {
    return this.readSessionEvents(id).map((event) => event.type === "SESSION_BASELINE"
      ? { type: event.type, at: event.at, state: event.baseline }
      : event.action);
  }

  readSessionEvents(id, { after = 0, limit, until } = {}) {
    const untilClause = until === undefined ? "" : " AND seq <= ?";
    const sql = `
      SELECT session_id, seq, at, type, event_json, schema_version FROM session_events
      WHERE session_id = ? AND seq > ?${untilClause}
      ORDER BY seq${limit ? " LIMIT ?" : ""}
    `;
    const params = [id, after];
    if (until !== undefined) params.push(until);
    if (limit) params.push(limit);
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => parseEventRow(row, id));
  }

  readProjectionEvents(id, { until } = {}) {
    const checkpoint = this.#latestValidCheckpoint(id, until);
    if (!checkpoint) return this.readSessionEvents(id, { until });
    return [
      {
        cursor: checkpoint.cursor,
        sessionId: id,
        type: "SESSION_CHECKPOINT",
        at: checkpoint.createdAt,
        baseline: checkpoint.state,
      },
      ...this.readSessionEvents(id, { after: checkpoint.cursor, until }),
    ];
  }

  latestSessionCursor(id) {
    return this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS cursor FROM session_events WHERE session_id = ?",
    ).get(id).cursor;
  }

  toolHistorySnapshot(id) {
    if (!this.db.prepare("SELECT 1 FROM sessions WHERE id = ? AND workspace = ?").get(id, this.workspace)) {
      throw new Error("工具历史所属 Session 不存在、已删除或不在当前工作区");
    }
    return this.latestSessionCursor(id);
  }

  readToolHistoryOccurrences(id, { after = 0, until, callId, limit = 11 } = {}) {
    this.#validateToolHistoryRange(id, until);
    if (!Number.isSafeInteger(after) || after < 0 || after > until
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 21) throw new Error("工具历史发现范围无效");
    const action = toolActionSql();
    const rows = this.db.prepare(`
      SELECT seq AS sourceCursor, substr(at, 1, 257) AS at,
        substr(json_extract(${action}, '$.call.id'), 1, 1001) AS callId,
        substr(json_extract(${action}, '$.call.name'), 1, 257) AS toolName
      FROM session_events
      WHERE session_id = ? AND type = 'TOOL_REQUESTED' AND seq > ? AND seq <= ?
        AND json_extract(${action}, '$.call.name') != 'read_tool_history'
        ${callId === undefined ? "" : `AND json_extract(${action}, '$.call.id') = ?`}
      ORDER BY seq LIMIT ?
    `).all(id, after, until, ...(callId === undefined ? [] : [callId]), limit);
    return rows.map((row) => ({ ...row, ...this.#toolHistoryResult(id, row, until, false) }));
  }

  readToolHistoryRecord(id, { sourceCursor, until } = {}) {
    this.#validateToolHistoryRange(id, until);
    if (!Number.isSafeInteger(sourceCursor) || sourceCursor < 1 || sourceCursor > until) throw new Error("工具历史 source cursor 无效");
    const action = toolActionSql();
    // Preflight in SQLite before moving a potentially huge action into JS.
    // These queries still scan JSON/index ranges; this is a materialization and
    // response budget, not a promise of constant query CPU for long journals.
    const row = this.db.prepare(`
      SELECT seq AS sourceCursor, substr(at, 1, 257) AS at, length(CAST(${action} AS BLOB)) AS requestBytes,
        substr(json_extract(${action}, '$.call.id'), 1, 1001) AS callId,
        substr(json_extract(${action}, '$.call.name'), 1, 257) AS toolName,
        EXISTS(SELECT 1 FROM json_each(${action}, '$.effects') WHERE value IN ('memory', 'credential')) AS privateTool
      FROM session_events WHERE session_id = ? AND seq = ? AND type = 'TOOL_REQUESTED'
    `).get(id, sourceCursor);
    if (!row) return null;
    const result = this.#toolHistoryResult(id, row, until, true);
    const metadata = { ...row, ...result };
    const recordBytes = row.requestBytes + (result.resultBytes ?? 0);
    if (recordBytes > MAX_TOOL_HISTORY_RECORD_BYTES) {
      return { ...metadata, contentOmitted: "record_too_large", recordBytes, maxRecordBytes: MAX_TOOL_HISTORY_RECORD_BYTES };
    }
    // Select at most this bounded request and its paired result, never patches,
    // baseline system/user messages, private state, or an entire journal.
    const readBody = (cursor, byteLimit) => this.db.prepare(`SELECT ${action} AS action_json
      FROM session_events WHERE session_id = ? AND seq = ?
        AND length(CAST(${action} AS BLOB)) <= ?`).get(id, cursor, byteLimit)?.action_json;
    const requestJson = readBody(sourceCursor, MAX_TOOL_HISTORY_RECORD_BYTES);
    const resultJson = result.resultCursor && readBody(result.resultCursor, MAX_TOOL_HISTORY_RECORD_BYTES - Buffer.byteLength(requestJson ?? "", "utf8"));
    if (!requestJson || (result.resultCursor && !resultJson)) throw new Error("工具历史记录在读取期间已删除或超出正文预算");
    return { ...metadata, request: JSON.parse(requestJson), result: resultJson ? JSON.parse(resultJson) : null };
  }

  #validateToolHistoryRange(id, until) {
    const latest = this.toolHistorySnapshot(id);
    if (!Number.isSafeInteger(until) || until < 1 || until > latest) throw new Error("工具历史 snapshot cursor 无效");
  }

  #toolHistoryResult(id, request, until, includeSize) {
    const action = toolActionSql();
    const match = `session_id = ? AND json_extract(${action}, '$.call.id') =
      (SELECT json_extract(${action}, '$.call.id') FROM session_events WHERE session_id = ? AND seq = ?)`;
    const parameters = [id, id, request.sourceCursor];
    const next = this.db.prepare(`SELECT seq FROM session_events WHERE ${match}
      AND type = 'TOOL_REQUESTED' AND seq > ? AND seq <= ? ORDER BY seq LIMIT 1`)
      .get(...parameters, request.sourceCursor, until);
    const priorBalance = this.db.prepare(`SELECT COALESCE(SUM(CASE type
      WHEN 'TOOL_REQUESTED' THEN 1 WHEN 'TOOL_RESULT' THEN -1 ELSE 0 END), 0) AS balance
      FROM session_events WHERE ${match} AND seq < ? AND type IN ('TOOL_REQUESTED', 'TOOL_RESULT')`)
      .get(...parameters, request.sourceCursor).balance;
    const row = this.db.prepare(`
      SELECT seq AS resultCursor,
        substr(json_extract(${action}, '$.status'), 1, 257) AS status,
        json_extract(${action}, '$.ok') AS ok,
        json_extract(${action}, '$.sourceCursor') AS explicitSourceCursor
        ${includeSize ? `, length(CAST(${action} AS BLOB)) AS resultBytes,
          ${toolArtifactMetadataSql(action, "$.artifact")} AS artifact_json,
          ${toolArtifactMetadataSql(action, "$.fileChanges.diffArtifact")} AS diff_artifact_json` : ""}
      FROM session_events WHERE ${match} AND type = 'TOOL_RESULT' AND seq > ? AND seq <= ?
        AND json_extract(${action}, '$.call.name') =
          (SELECT json_extract(${action}, '$.call.name') FROM session_events WHERE session_id = ? AND seq = ?)
        AND (json_extract(${action}, '$.sourceCursor') = ?
          OR (json_extract(${action}, '$.sourceCursor') IS NULL AND seq < ?))
      ORDER BY seq LIMIT 1
    `).get(...parameters, request.sourceCursor, until, id, request.sourceCursor, request.sourceCursor, next?.seq ?? until + 1);
    // Old records do not carry sourceCursor on every result. A reused call ID
    // with overlapping requests cannot be reliably paired; never guess which
    // occurrence a result belongs to. Explicit durable linkage remains usable.
    if (priorBalance !== 0 && row?.explicitSourceCursor !== request.sourceCursor) {
      return { resultCursor: null, status: "ambiguous", association: "ambiguous" };
    }
    return { resultCursor: row?.resultCursor ?? null,
      status: row ? row.status ?? (row.ok ? "completed" : "failed") : "pending",
      ...(includeSize ? { resultBytes: row?.resultBytes ?? 0,
        artifacts: [row?.artifact_json, row?.diff_artifact_json].filter(Boolean).map((value) => JSON.parse(value)) } : {}) };
  }

  load(id) {
    const row = this.db.prepare("SELECT cache_cursor FROM sessions WHERE id = ?").get(id);
    if (!row) return null;
    const events = this.readProjectionEvents(id);
    if (!events.length) {
      if (row.cache_cursor > 0) throw new Error(`会话 ${id} 的事件日志缺少基线`);
      return parseState(this.db.prepare("SELECT state_json FROM sessions WHERE id = ?").get(id).state_json, id);
    }
    return replayProjection(events, id);
  }

  sessionDeletionIds(id) {
    const root = this.db.prepare("SELECT workspace FROM sessions WHERE id = ?").get(id);
    if (!root || root.workspace !== this.workspace) return [];
    const rows = this.db.prepare(`
      WITH RECURSIVE owned(id) AS (
        SELECT id FROM sessions WHERE id = ? AND workspace = ?
        UNION
        SELECT child.id FROM sessions child JOIN owned parent
          ON json_extract(child.state_json, '$.lineage.parentSessionId') = parent.id
        WHERE child.workspace = ?
          AND json_extract(child.state_json, '$.lineage.kind') = 'delegation'
      )
      SELECT id FROM owned
    `).all(id, this.workspace, this.workspace);
    return rows.map((row) => row.id);
  }

  deleteSessions(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id)) {
      throw new Error("删除会话需要非空 ID 列表");
    }
    const deletedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const exists = this.db.prepare("SELECT 1 FROM sessions WHERE id = ? AND workspace = ?");
      const tombstone = this.db.prepare("INSERT INTO deleted_sessions (id, deleted_at) VALUES (?, ?)");
      const remove = this.db.prepare("DELETE FROM sessions WHERE id = ? AND workspace = ?");
      for (const id of new Set(ids)) {
        if (!exists.get(id, this.workspace)) throw new Error(`未找到会话：${id}`);
        tombstone.run(id, deletedAt);
        // Foreign keys cascade to journal events, checkpoints, and artifacts.
        remove.run(id, this.workspace);
      }
      this.db.exec("COMMIT");
      return [...new Set(ids)];
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  loadAt(id, cursor) {
    if (!Number.isInteger(cursor) || cursor < 1) throw new Error("分支 cursor 必须是正整数");
    const row = this.db.prepare("SELECT 1 AS found FROM sessions WHERE id = ?").get(id);
    if (!row) return null;
    const latest = this.latestSessionCursor(id);
    if (cursor > latest) throw new Error(`分支 cursor ${cursor} 超过会话最新 cursor ${latest}`);
    const events = this.readProjectionEvents(id, { until: cursor });
    if (!events.length || !events[0].baseline) throw new Error(`会话 ${id} 在 cursor ${cursor} 缺少可重放基线`);
    return events.slice(1).reduce((state, event) => reduceSession(state, event.action), parseState(
      JSON.stringify(events[0].baseline),
      `${id} cursor ${cursor}`,
    ));
  }

  branchSession(parentId, {
    cursor,
    id = `session-${randomUUID().slice(0, 12)}`,
    provider,
    workspace,
    agentProfile,
    branchedAt = new Date().toISOString(),
  }) {
    if (this.db.prepare("SELECT 1 AS found FROM sessions WHERE id = ?").get(id)) {
      throw new Error(`会话已存在：${id}`);
    }
    const parent = this.loadAt(parentId, cursor);
    if (!parent) throw new Error(`未找到父会话：${parentId}`);
    const branch = createSessionBranch(parent, {
      id,
      parentCursor: cursor,
      provider: provider || parent.provider,
      workspace: workspace || parent.workspace,
      agentProfile,
      branchedAt,
    });
    const artifactIds = referencedArtifactIds(parent);
    const durableBranch = redactSensitiveValue(branch);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#insertJournalBaseline(durableBranch);
      copySessionArtifacts(this.db, {
        sourceSessionId: parentId,
        targetSessionId: id,
        artifactIds,
      });
      this.db.exec("COMMIT");
      return durableBranch;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  exportJournal(id, { exportedAt = new Date().toISOString() } = {}) {
    try {
      return this.#exportRecoverableJournal(id, exportedAt);
    } catch (error) {
      if (error instanceof ArchiveExportError) throw error;
      throw new ArchiveExportError(`无法生成可恢复归档：${error.message}`, { statusCode: 422 });
    }
  }

  #exportRecoverableJournal(id, exportedAt) {
    preflightJournalExport(this.db, id);
    let state = this.load(id);
    if (!state) throw new Error(`未找到会话：${id}`);
    if (this.latestSessionCursor(id) === 0) {
      state = this.ensureJournal(state);
    }
    const artifacts = exportSessionArtifacts(this.db, id);
    const events = this.readSessionEvents(id);
    const core = {
      format: "nexus.session-journal",
      formatVersion: 1,
      session: {
        id: state.id,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        provider: state.provider,
        workspace: state.workspace,
        cursor: this.latestSessionCursor(id),
        // Header describes the source journal, whose baseline is immutable even
        // after load/resume migrates its current projection to a newer schema.
        stateSchemaVersion: events[0]?.baseline?.schemaVersion,
        lineage: state.lineage || null,
      },
      events,
      ...(artifacts.length ? { artifacts } : {}),
    };
    const archive = {
      ...core,
      exportedAt,
      checksum: archiveChecksum(core),
    };
    assertJournalImportEnvelope(archive, { exporting: true });
    const validated = validateJournalArchive(archive);
    // Legacy archives may omit the artifacts member. New exports must still
    // prove every reference resolves, including when all content is missing.
    validateArtifactReferences(validated.state, artifacts, state.id);
    return archive;
  }

  importJournal(archive, { id, workspace } = {}) {
    const validated = validateJournalArchive(archive);
    const targetId = validateImportTarget(id ?? validated.state.id, "导入会话 ID");
    const targetWorkspace = validateImportTarget(workspace ?? validated.state.workspace, "导入 workspace");
    const imported = adaptJournal(validated.events, { id: targetId, workspace: targetWorkspace });

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 AS found FROM sessions WHERE id = ?").get(targetId)) {
        throw new Error(`会话已存在：${targetId}`);
      }
      this.#saveDurable(redactSensitiveValue(imported.state), imported.events.length);
      const insertEvent = this.db.prepare(`
        INSERT INTO session_events (session_id, seq, at, type, event_json, schema_version)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const event of imported.events) {
        insertEvent.run(
          targetId,
          event.cursor,
          event.at,
          event.type,
          JSON.stringify(event.type === "SESSION_BASELINE"
            ? { type: event.type, at: event.at, state: event.baseline }
            : { action: event.action, patch: event.patch }),
          EVENT_SCHEMA_VERSION,
        );
      }
      insertPortableArtifacts(this.db, validated.artifacts, targetId);
      if (imported.events.length % this.checkpointInterval === 0) {
        this.#writeCheckpoint(imported.state, imported.events.length, imported.state.updatedAt);
      }
      this.db.exec("COMMIT");
      return structuredClone(imported.state);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  latest(workspace) {
    const row = this.db.prepare(`
      SELECT id FROM sessions
      WHERE workspace = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(workspace);
    return row ? this.load(row.id) : null;
  }

  list(workspace, limit = 20) {
    return this.db.prepare(`
      SELECT id, created_at AS createdAt, updated_at AS updatedAt,
             provider, phase, message_count AS messageCount, display_title AS displayTitle
      FROM sessions
      WHERE workspace = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(workspace, limit).map(({ displayTitle, ...row }) => ({
      ...row,
      title: displayTitle === null
        ? resolveSessionDisplayTitle(parseState(this.db.prepare("SELECT state_json FROM sessions WHERE id = ?").get(row.id).state_json, row.id))
        : resolveSessionDisplayTitle({ displayTitle }),
    }));
  }

  async addMemory(content, {
    tags = [], sourceSession = null, sourceCursor = null, toolCallId = null, scope, kind = "fact", confidence = 1,
    origin = sourceSession ? "tool" : "user_explicit",
  } = {}) {
    return await this.memory.add({ content, tags, kind, confidence }, {
      scope: scope || this.memoryScope,
      provenance: {
        origin,
        sessionId: sourceSession,
        sourceCursor,
        toolCallId,
        actor: sourceSession ? "agent" : "local-user",
      },
    });
  }

  async searchMemories(query = "", limit = 20, scope = this.memoryScope) {
    return await this.memory.search(query, { scope }, { limit });
  }

  async deleteMemory(id, reason = "用户请求删除", provenance = {}, scope = this.memoryScope) {
    return await this.memory.delete(id, reason, {
      scope,
      provenance: { origin: "user_explicit", actor: "local-user", ...provenance },
    });
  }

  async verifyMemory(id, scope = this.memoryScope) {
    return await this.memory.verify(id, { scope });
  }

  close() {
    this.db.close();
  }

  #writeCheckpoint(state, cursor, createdAt, stateJson = JSON.stringify(state)) {
    this.db.prepare(`
      INSERT INTO session_checkpoints (session_id, cursor, state_json, checksum, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, cursor) DO UPDATE SET
        state_json = excluded.state_json,
        checksum = excluded.checksum,
        created_at = excluded.created_at
    `).run(state.id, cursor, stateJson, checkpointChecksum(state.id, cursor, stateJson), createdAt);
  }

  #insertJournalBaseline(state) {
    this.#saveDurable(state, 1);
    this.db.prepare(`
      INSERT INTO session_events (session_id, seq, at, type, event_json, schema_version)
      VALUES (?, 1, ?, 'SESSION_BASELINE', ?, ?)
    `).run(
      state.id,
      state.createdAt,
      JSON.stringify({ type: "SESSION_BASELINE", at: state.createdAt, state }),
      EVENT_SCHEMA_VERSION,
    );
  }

  #latestValidCheckpoint(id, until = Number.MAX_SAFE_INTEGER) {
    const candidates = this.db.prepare(`
      SELECT cursor, state_json AS stateJson, checksum, created_at AS createdAt
      FROM session_checkpoints
      WHERE session_id = ? AND cursor <= ?
      ORDER BY cursor DESC
    `);
    const eventExists = this.db.prepare(
      "SELECT 1 AS found FROM session_events WHERE session_id = ? AND seq = ?",
    );
    // The existing (session_id, cursor DESC) index supplies one candidate at a
    // time. Do not materialize every historical state or cap the candidate
    // count: a much older checkpoint can still recover a damaged journal.
    // StatementSync.iterate arrived after the supported Node 22.5 minimum.
    // Older runtimes can use the same index with one-row keyset reads instead.
    const rows = typeof candidates.iterate === "function"
      ? candidates.iterate(id, until)
      : (function* () {
          let ceiling = until;
          while (true) {
            const row = candidates.get(id, ceiling);
            if (!row) return;
            yield row;
            ceiling = row.cursor - 1;
          }
        })();
    let failed = false;
    try {
      while (true) {
        const { done, value: row } = rows.next();
        if (done) return null;
        if (checkpointChecksum(id, row.cursor, row.stateJson) !== row.checksum) continue;
        if (!eventExists.get(id, row.cursor)) continue;
        try {
          const state = parseState(row.stateJson, `${id} checkpoint ${row.cursor}`);
          if (state.id !== id) continue;
          return { ...row, state };
        } catch {}
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Also release the statement when next() itself throws; a for-of loop's
      // automatic IteratorClose only covers failures after obtaining a row.
      try { rows.return(); } catch (error) {
        if (!failed) throw error;
      }
    }
  }
}

function replayProjection(events, id) {
  if (!events[0]?.baseline) throw new Error(`会话 ${id} 的事件日志缺少基线`);
  return events.slice(1).reduce((state, event) => reduceSession(state, event.action), parseState(
    JSON.stringify(events[0].baseline), `${id} 基线`,
  ));
}

function parseState(value, label) {
  try {
    const state = migrateSessionState(JSON.parse(value));
    if (!state?.id || !Array.isArray(state.messages) || !Array.isArray(state.events)) {
      throw new Error("状态结构不完整");
    }
    return state;
  } catch (error) {
    throw new Error(`会话 ${label} 的持久化数据损坏：${error.message}`);
  }
}

function toolActionSql() {
  // Legacy schema-v1 archives can contain a bare action instead of {action,
  // patch}. Mirror parseEventRow without loading a projection patch.
  return "CASE WHEN json_type(event_json, '$.action') = 'object' THEN json_extract(event_json, '$.action') ELSE event_json END";
}

function toolArtifactMetadataSql(action, jsonPath) {
  // Only bounded reference fields are selected, never a nested content field.
  // An abnormally long ID cannot be a useful bounded reference; omit it.
  return `CASE WHEN json_type(${action}, '${jsonPath}.id') = 'text'
    AND length(json_extract(${action}, '${jsonPath}.id')) <= 256
    THEN json_object('id', json_extract(${action}, '${jsonPath}.id'),
      'kind', substr(json_extract(${action}, '${jsonPath}.kind'), 1, 256),
      'sha256', substr(json_extract(${action}, '${jsonPath}.sha256'), 1, 64),
      'byteSize', CASE WHEN json_type(${action}, '${jsonPath}.byteSize') = 'integer'
        THEN json_extract(${action}, '${jsonPath}.byteSize') ELSE NULL END) ELSE NULL END`;
}

function parseEventRow(row, label) {
  try {
    const payload = migrateEventPayload(JSON.parse(row.event_json), row.schema_version);
    if (row.type === "SESSION_BASELINE") {
      if (!payload?.state) throw new Error("基线结构不完整");
      return {
        cursor: row.seq,
        sessionId: row.session_id,
        type: row.type,
        at: row.at,
        schemaVersion: EVENT_SCHEMA_VERSION,
        baseline: payload.state,
      };
    }
    const action = payload.action || payload;
    if (!action?.type || !action?.at) throw new Error("事件结构不完整");
    return {
      cursor: row.seq,
      sessionId: row.session_id,
      type: row.type,
      at: row.at,
      schemaVersion: EVENT_SCHEMA_VERSION,
      action,
      patch: payload.action ? payload.patch : null,
    };
  } catch (error) {
    throw new Error(`会话 ${label} 的事件日志损坏：${error.message}`);
  }
}

function migrateEventPayload(payload, version) {
  if (!Number.isInteger(version) || version < 1) throw new Error(`无效事件 schema version：${version}`);
  if (version > EVENT_SCHEMA_VERSION) {
    throw new Error(`事件 schema v${version} 高于当前支持的 v${EVENT_SCHEMA_VERSION}`);
  }
  return payload;
}

function checkpointChecksum(id, cursor, stateJson) {
  return `sha256:${createHash("sha256").update(`${id}\n${cursor}\n${stateJson}`).digest("hex")}`;
}

function archiveChecksum(core) {
  return `sha256:${createHash("sha256").update(stableStringify(core)).digest("hex")}`;
}

function validateJournalArchive(archive) {
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
    throw new Error("portable journal archive 必须是对象");
  }
  if (archive.format !== JOURNAL_FORMAT) {
    throw new Error(`不支持的 portable journal format：${archive.format || "<missing>"}`);
  }
  if (archive.formatVersion !== JOURNAL_FORMAT_VERSION) {
    throw new Error(`portable journal format v${archive.formatVersion} 高于或不同于当前支持的 v${JOURNAL_FORMAT_VERSION}`);
  }
  if (!archive.session || typeof archive.session !== "object" || !Array.isArray(archive.events)) {
    throw new Error("portable journal archive 缺少 session 或 events");
  }
  const core = journalCore(archive);
  if (typeof archive.checksum !== "string"
      || (archiveChecksum(core) !== archive.checksum && legacyArchiveChecksum(core) !== archive.checksum)) {
    throw new Error("portable journal checksum 校验失败");
  }
  if (!archive.events.length) throw new Error("portable journal events 不能为空");
  const artifacts = validatePortableArtifacts(archive.artifacts);

  const sourceId = validateImportTarget(archive.session.id, "archive session ID");
  let state = null;
  let sourceStateSchemaVersion = null;
  const events = archive.events.map((sourceEvent, index) => {
    const event = structuredClone(sourceEvent);
    const cursor = index + 1;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`portable journal event ${cursor} 必须是对象`);
    }
    if (event.cursor !== cursor) {
      throw new Error(`portable journal cursor 不连续：期望 ${cursor}，实际 ${event.cursor}`);
    }
    if (event.sessionId !== sourceId) {
      throw new Error(`portable journal event ${cursor} 的 sessionId 不一致`);
    }
    migrateEventPayload({}, event.schemaVersion);

    if (cursor === 1) {
      if (event.type !== "SESSION_BASELINE" || !event.baseline) {
        throw new Error("portable journal 第一个事件必须是 SESSION_BASELINE");
      }
      sourceStateSchemaVersion = event.baseline.schemaVersion;
      if (archive.session.stateSchemaVersion !== sourceStateSchemaVersion) {
        throw new Error("portable journal session.stateSchemaVersion 与 baseline 不一致");
      }
      state = validateArchiveState(event.baseline, sourceId, "baseline");
      if (event.at !== state.createdAt) {
        throw new Error("portable journal baseline 时间与会话创建时间不一致");
      }
      return event;
    }
    if (event.type === "SESSION_BASELINE") {
      throw new Error(`portable journal cursor ${cursor} 不允许重复 SESSION_BASELINE`);
    }
    if (!event.action || typeof event.action !== "object" || !event.action.type || !event.action.at) {
      throw new Error(`portable journal event ${cursor} 的 action 结构不完整`);
    }
    if (event.type !== event.action.type || event.at !== event.action.at) {
      throw new Error(`portable journal event ${cursor} 的类型或时间与 action 不一致`);
    }
    const next = reduceSession(state, event.action);
    const replayedPatch = createStatePatch(state, next);
    const comparablePatch = migrateArchivePatchForReplay(event.patch, {
      sourceStateSchemaVersion,
      action: event.action,
      replayedPatch,
    });
    if (event.patch != null && stableStringify(comparablePatch) !== stableStringify(replayedPatch)) {
      throw new Error(`portable journal event ${cursor} 的 patch 与事实重放结果不一致`);
    }
    state = next;
    return event;
  });

  if (!Number.isInteger(archive.session.cursor) || archive.session.cursor !== events.length) {
    throw new Error("portable journal session cursor 与 events 数量不一致");
  }
  validateArchiveMetadata(archive.session, state, sourceStateSchemaVersion);
  if (Object.hasOwn(archive, "artifacts")) validateArtifactReferences(state, artifacts, sourceId);
  return { events, state, artifacts };
}

function migrateArchivePatchForReplay(patch, { sourceStateSchemaVersion, action, replayedPatch }) {
  if (patch == null || sourceStateSchemaVersion >= 16 || action.type !== "USER_MESSAGE") return patch;
  if (Object.hasOwn(patch.set || {}, "displayTitle")
      || !Object.hasOwn(replayedPatch.set || {}, "displayTitle")) return patch;
  return {
    ...structuredClone(patch),
    set: {
      ...(patch.set || {}),
      displayTitle: structuredClone(replayedPatch.set.displayTitle),
    },
  };
}

function adaptJournal(events, { id, workspace }) {
  const adaptedEvents = [];
  const sourceId = events[0].baseline.id;
  const sourceBaseline = migrateSessionState(structuredClone(events[0].baseline));
  const baseline = redactSensitiveValue({
    ...sourceBaseline,
    id,
    workspace,
    memoryScope: createMemoryScope({ ...sourceBaseline.memoryScope, workspace }),
    agentProfile: deriveAgentProfileSnapshot(sourceBaseline.agentProfile, {
      workspace,
      memoryScope: createMemoryScope({ ...sourceBaseline.memoryScope, workspace }),
    }),
    pendingMemoryMutations: sourceBaseline.pendingMemoryMutations.map((mutation) => (
      adaptMemoryMutation(mutation, { sourceId, id, workspace })
    )),
    memoryMutationIssues: sourceBaseline.memoryMutationIssues.map((issue) => ({
      ...issue,
      mutation: adaptMemoryMutation(issue.mutation, { sourceId, id, workspace }),
    })),
    toolGrants: sourceBaseline.toolGrants.map((grant) => adaptSessionGrant(grant, { id, workspace })),
    events: adaptStateArtifactReferences(sourceBaseline.events, id),
  });
  let state = baseline;
  adaptedEvents.push({
    cursor: 1,
    sessionId: id,
    type: "SESSION_BASELINE",
    at: events[0].at,
    schemaVersion: EVENT_SCHEMA_VERSION,
    baseline,
  });

  for (const event of events.slice(1)) {
    const action = redactSensitiveValue(structuredClone(event.action));
    if (action.type === "RESUMED") {
      action.workspace = workspace;
      if (action.agentProfile) {
        action.agentProfile = deriveAgentProfileSnapshot(action.agentProfile, {
          workspace,
          memoryScope: createMemoryScope({ ...action.agentProfile.memoryScope, workspace }),
        });
      }
    }
    if (action.type === "MEMORY_MUTATION_REQUESTED") {
      action.mutation = adaptMemoryMutation(action.mutation, { sourceId, id, workspace });
    }
    if (action.type === "TOOL_GRANT_ISSUED") {
      action.grant = adaptSessionGrant(action.grant, { id, workspace });
    }
    if (action.type === "TOOL_RESULT" && action.artifact) {
      action.artifact = { ...action.artifact, sessionId: id };
    }
    if (action.type === "TOOL_RESULT" && action.fileChanges?.diffArtifact) {
      action.fileChanges = {
        ...action.fileChanges,
        diffArtifact: { ...action.fileChanges.diffArtifact, sessionId: id },
      };
    }
    if ([
      "MEMORY_MUTATION_APPLIED",
      "MEMORY_MUTATION_FAILED",
      "MEMORY_MUTATION_OUTCOME_UNKNOWN",
      "MEMORY_MUTATION_MANUAL_REQUIRED",
      "MEMORY_MUTATION_DISCARDED",
    ].includes(action.type)) {
      action.mutationId = adaptMutationId(action.mutationId, sourceId, id);
    }
    const next = redactSensitiveValue(reduceSession(state, action));
    adaptedEvents.push({
      cursor: event.cursor,
      sessionId: id,
      type: action.type,
      at: action.at,
      schemaVersion: EVENT_SCHEMA_VERSION,
      action,
      patch: redactSensitiveValue(createStatePatch(state, next)),
    });
    state = next;
  }
  return { events: adaptedEvents, state };
}

function adaptMemoryMutation(mutation, { sourceId, id, workspace }) {
  const adapted = structuredClone(mutation);
  adapted.id = adaptMutationId(adapted.id, sourceId, id);
  adapted.scope = createMemoryScope({ ...adapted.scope, workspace });
  if (adapted.provenance?.sessionId === sourceId) adapted.provenance.sessionId = id;
  adapted.reconcilePolicy = "manual";
  return adapted;
}

function adaptSessionGrant(grant, { id, workspace }) {
  return { ...structuredClone(grant), sessionId: id, workspace };
}

function adaptMutationId(value, sourceId, id) {
  return typeof value === "string" && value.startsWith(`${sourceId}:`)
    ? `${id}:${value.slice(sourceId.length + 1)}`
    : value;
}

function validateArchiveState(value, sourceId, label) {
  let state;
  try {
    state = migrateSessionState(structuredClone(value));
  } catch (error) {
    throw new Error(`portable journal ${label} 状态无效：${error.message}`);
  }
  if (state.id !== sourceId || !Array.isArray(state.messages) || !Array.isArray(state.events)) {
    throw new Error(`portable journal ${label} 状态结构不完整或 ID 不一致`);
  }
  return state;
}

function validateArchiveMetadata(metadata, state, sourceStateSchemaVersion) {
  const fields = ["id", "createdAt", "updatedAt", "provider", "workspace"];
  for (const field of fields) {
    if (metadata[field] !== state[field]) {
      throw new Error(`portable journal session.${field} 与重放状态不一致`);
    }
  }
  if (metadata.stateSchemaVersion !== sourceStateSchemaVersion) {
    throw new Error("portable journal state schema version 与重放状态不一致");
  }
  if (stableStringify(metadata.lineage || null) !== stableStringify(state.lineage || null)) {
    throw new Error("portable journal lineage 与重放状态不一致");
  }
}

function validateImportTarget(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  if (value.length > 4096) throw new Error(`${label} 过长`);
  return value;
}

function journalCore(archive) {
  return {
    format: archive.format,
    formatVersion: archive.formatVersion,
    session: archive.session,
    events: archive.events,
    ...(Object.hasOwn(archive, "artifacts") ? { artifacts: archive.artifacts } : {}),
  };
}

function preflightJournalExport(db, sessionId) {
  const { count, byteSize, actualBytes, largestBytes } = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS byteSize,
      COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS actualBytes,
      COALESCE(MAX(length(CAST(content AS BLOB))), 0) AS largestBytes
    FROM artifacts WHERE session_id = ?
  `).get(sessionId);
  assertPortableArtifactBudget({ count, byteSize: Math.max(byteSize, actualBytes) }, { exporting: true });
  if (largestBytes > MAX_ARTIFACT_BYTES) throw new Error(`Artifact 超过 ${MAX_ARTIFACT_BYTES} 字节上限，无法导出`);
  const { journalBytes } = db.prepare(`
    SELECT COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) AS journalBytes
    FROM session_events WHERE session_id = ?
  `).get(sessionId);
  // A lower bound avoids loading unbounded BLOB/journal data merely to reject it.
  assertJournalImportBytes(actualBytes + journalBytes, { exporting: true });
}

function exportSessionArtifacts(db, sessionId) {
  const artifacts = [];
  let encodedBytes = 0;
  const rows = db.prepare(`
    SELECT id, call_id, kind, media_type, byte_size, sha256, content, created_at
    FROM artifacts WHERE session_id = ? ORDER BY created_at, id
  `).iterate(sessionId);
  for (const row of rows) {
    const bytes = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    if (bytes.byteLength !== row.byte_size || artifactDigest(bytes) !== row.sha256) {
      throw new Error(`Artifact ${row.id} 完整性校验失败，无法导出`);
    }
    const artifact = {
      id: row.id,
      callId: row.call_id,
      kind: row.kind,
      mediaType: row.media_type,
      byteSize: row.byte_size,
      sha256: row.sha256,
      createdAt: row.created_at,
      content: bytes.toString("utf8"),
    };
    encodedBytes += Buffer.byteLength(JSON.stringify(artifact), "utf8");
    assertJournalImportBytes(encodedBytes, { exporting: true });
    artifacts.push(artifact);
  }
  return artifacts;
}

function validatePortableArtifacts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("portable journal artifacts 必须是数组");
  assertPortableArtifactBudget({ count: value.length, byteSize: 0 });
  const ids = new Set();
  let totalBytes = 0;
  return value.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`portable journal Artifact ${index + 1} 必须是对象`);
    }
    if (Object.hasOwn(source, "sessionId")) {
      throw new Error(`portable journal Artifact ${index + 1} 不得绑定源 Session`);
    }
    if (typeof source.content !== "string") {
      throw new Error(`portable journal Artifact ${index + 1} 首版只支持文本内容`);
    }
    const bytes = Buffer.from(source.content, "utf8");
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(`portable journal Artifact ${index + 1} 超过 ${MAX_ARTIFACT_BYTES} 字节上限`);
    }
    totalBytes += bytes.byteLength;
    assertPortableArtifactBudget({ count: value.length, byteSize: totalBytes });
    const metadata = artifactMetadata({ ...source, sessionId: "portable-validation" });
    if (metadata.byteSize !== bytes.byteLength || metadata.sha256 !== artifactDigest(bytes)) {
      throw new Error(`portable journal Artifact ${metadata.id} 完整性校验失败`);
    }
    if (ids.has(metadata.id)) throw new Error(`portable journal Artifact ID 重复：${metadata.id}`);
    ids.add(metadata.id);
    return {
      id: metadata.id,
      callId: metadata.callId,
      kind: metadata.kind,
      mediaType: metadata.mediaType,
      byteSize: metadata.byteSize,
      sha256: metadata.sha256,
      createdAt: metadata.createdAt,
      content: source.content,
    };
  });
}

function validateArtifactReferences(state, artifacts, sourceId) {
  const records = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const event of state.events || []) {
    const references = [event.artifact, event.fileChanges?.diffArtifact].filter(Boolean);
    for (const reference of references) {
      const record = records.get(reference.id);
      if (!record) throw new Error(`portable journal 缺少被事件引用的 Artifact：${reference.id}`);
      const expected = artifactMetadata({ ...record, sessionId: sourceId });
      const actual = artifactMetadata(reference);
      if (stableStringify(expected) !== stableStringify(actual)) {
        throw new Error(`portable journal Artifact ${reference.id} 元数据与事件引用不一致`);
      }
    }
  }
}

function insertPortableArtifacts(db, artifacts, sessionId) {
  if (!artifacts.length) return;
  const insert = db.prepare(`
    INSERT INTO artifacts (
      id, session_id, call_id, kind, media_type, byte_size, sha256, content, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const artifact of artifacts) {
    insert.run(
      artifact.id,
      sessionId,
      artifact.callId,
      artifact.kind,
      artifact.mediaType,
      artifact.byteSize,
      artifact.sha256,
      Buffer.from(artifact.content, "utf8"),
      artifact.createdAt,
    );
  }
}

function referencedArtifactIds(state) {
  return [...new Set((state.events || []).flatMap((event) => [
    event.artifact?.id,
    event.fileChanges?.diffArtifact?.id,
  ]).filter((id) => typeof id === "string" && id))];
}

function copySessionArtifacts(db, { sourceSessionId, targetSessionId, artifactIds }) {
  if (!artifactIds.length) return;
  const copy = db.prepare(`
    INSERT INTO artifacts (
      id, session_id, call_id, kind, media_type, byte_size, sha256, content, created_at
    )
    SELECT id, ?, call_id, kind, media_type, byte_size, sha256, content, created_at
    FROM artifacts WHERE session_id = ? AND id = ?
  `);
  for (const artifactId of artifactIds) {
    const result = copy.run(targetSessionId, sourceSessionId, artifactId);
    if (result.changes !== 1) throw new Error(`Branch 引用的 Artifact 不存在：${artifactId}`);
  }
}

function adaptStateArtifactReferences(events, sessionId) {
  return (events || []).map((event) => ({
    ...event,
    ...(event.artifact ? { artifact: { ...event.artifact, sessionId } } : {}),
    ...(event.fileChanges?.diffArtifact ? {
      fileChanges: {
        ...event.fileChanges,
        diffArtifact: { ...event.fileChanges.diffArtifact, sessionId },
      },
    } : {}),
  }));
}

function artifactDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function legacyArchiveChecksum(core) {
  return `sha256:${createHash("sha256").update(JSON.stringify(core)).digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}
