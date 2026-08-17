// FOUNDATION — SQLite session snapshots and long-term memory.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createSessionBranch, migrateSessionState, reduceSession } from "../core/state.js";
import { redactSensitiveValue } from "../security/redact.js";
import { createStatePatch } from "../state-patch.js";
import { EVENT_SCHEMA_VERSION, migrateDatabase } from "./migrations.js";

const JOURNAL_FORMAT = "nexus.session-journal";
const JOURNAL_FORMAT_VERSION = 1;

export class SessionStore {
  constructor(file, { checkpointInterval = 100 } = {}) {
    if (!Number.isInteger(checkpointInterval) || checkpointInterval < 1) {
      throw new Error("checkpointInterval 必须是正整数");
    }
    this.file = path.resolve(file);
    this.checkpointInterval = checkpointInterval;
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    try {
      migrateDatabase(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.upsert = this.db.prepare(`
      INSERT INTO sessions (
        id, created_at, updated_at, provider, workspace, phase, message_count, state_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        provider = excluded.provider,
        workspace = excluded.workspace,
        phase = excluded.phase,
        message_count = excluded.message_count,
        state_json = excluded.state_json
    `);
  }

  save(state) {
    const durableState = redactSensitiveValue(state);
    this.upsert.run(
      durableState.id,
      durableState.createdAt,
      durableState.updatedAt,
      durableState.provider,
      durableState.workspace,
      durableState.phase,
      durableState.messages.length,
      JSON.stringify(durableState),
    );
  }

  ensureJournal(state) {
    const existing = this.db.prepare(
      "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?",
    ).get(state.id);
    if (existing.count > 0) return this.load(state.id);

    const durableState = redactSensitiveValue(state);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.save(durableState);
      this.db.prepare(`
        INSERT INTO session_events (session_id, seq, at, type, event_json, schema_version)
        VALUES (?, 1, ?, 'SESSION_BASELINE', ?, ?)
      `).run(
        durableState.id,
        durableState.createdAt,
        JSON.stringify({ type: "SESSION_BASELINE", at: durableState.createdAt, state: durableState }),
        EVENT_SCHEMA_VERSION,
      );
      this.db.exec("COMMIT");
      return durableState;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  commitSessionEvent(nextState, action, patch) {
    const durableState = redactSensitiveValue(nextState);
    const durableAction = redactSensitiveValue(action);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM session_events WHERE session_id = ?",
      ).get(durableState.id);
      if (row.seq === 0) throw new Error(`会话 ${durableState.id} 尚未建立事件基线`);
      const cursor = row.seq + 1;
      this.db.prepare(`
        INSERT INTO session_events (session_id, seq, at, type, event_json, schema_version)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        durableState.id,
        cursor,
        durableAction.at,
        durableAction.type,
        JSON.stringify({ action: durableAction, patch: redactSensitiveValue(patch) }),
        EVENT_SCHEMA_VERSION,
      );
      this.save(durableState);
      if (cursor % this.checkpointInterval === 0) {
        this.#writeCheckpoint(durableState, cursor, durableAction.at);
      }
      this.db.exec("COMMIT");
      return {
        cursor,
        sessionId: durableState.id,
        type: durableAction.type,
        at: durableAction.at,
        action: durableAction,
        patch: redactSensitiveValue(patch),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  load(id) {
    const row = this.db.prepare("SELECT state_json FROM sessions WHERE id = ?").get(id);
    if (!row) return null;
    const events = this.readProjectionEvents(id);
    if (!events.length) return parseState(row.state_json, id);
    if (!events[0].baseline) {
      throw new Error(`会话 ${id} 的事件日志缺少基线`);
    }
    return events.slice(1).reduce((state, event) => reduceSession(state, event.action), parseState(
      JSON.stringify(events[0].baseline),
      `${id} 基线`,
    ));
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
      branchedAt,
    });
    return this.ensureJournal(branch);
  }

  exportJournal(id, { exportedAt = new Date().toISOString() } = {}) {
    let state = this.load(id);
    if (!state) throw new Error(`未找到会话：${id}`);
    if (this.latestSessionCursor(id) === 0) {
      state = this.ensureJournal(state);
    }
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
        stateSchemaVersion: state.schemaVersion,
        lineage: state.lineage || null,
      },
      events: this.readSessionEvents(id),
    };
    return {
      ...core,
      exportedAt,
      checksum: archiveChecksum(core),
    };
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
      this.save(imported.state);
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
             provider, phase, message_count AS messageCount, state_json AS stateJson
      FROM sessions
      WHERE workspace = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(workspace, limit).map(({ stateJson, ...row }) => ({
      ...row,
      title: sessionTitle(parseState(stateJson, row.id)),
    }));
  }

  addMemory(content, { tags = [], sourceSession = null } = {}) {
    const now = new Date().toISOString();
    const memory = {
      id: `memory-${randomUUID().slice(0, 12)}`,
      content: typeof content === "string" ? content.trim() : "",
      tags: [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20),
      sourceSession,
      createdAt: now,
      updatedAt: now,
    };
    if (!memory.content) throw new Error("长期记忆内容不能为空");
    this.db.prepare(`
      INSERT INTO memories (id, content, tags_json, source_session, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(memory.id, memory.content, JSON.stringify(memory.tags), sourceSession, now, now);
    return memory;
  }

  searchMemories(query = "", limit = 20) {
    const needle = String(query).trim();
    const rows = needle
      ? this.db.prepare(`
          SELECT * FROM memories
          WHERE instr(lower(content), lower(?)) > 0 OR instr(lower(tags_json), lower(?)) > 0
          ORDER BY updated_at DESC LIMIT ?
        `).all(needle, needle, limit)
      : this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map(parseMemoryRow);
  }

  deleteMemory(id) {
    return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  close() {
    this.db.close();
  }

  #writeCheckpoint(state, cursor, createdAt) {
    const stateJson = JSON.stringify(state);
    this.db.prepare(`
      INSERT INTO session_checkpoints (session_id, cursor, state_json, checksum, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, cursor) DO UPDATE SET
        state_json = excluded.state_json,
        checksum = excluded.checksum,
        created_at = excluded.created_at
    `).run(state.id, cursor, stateJson, checkpointChecksum(state.id, cursor, stateJson), createdAt);
  }

  #latestValidCheckpoint(id, until = Number.MAX_SAFE_INTEGER) {
    const rows = this.db.prepare(`
      SELECT cursor, state_json AS stateJson, checksum, created_at AS createdAt
      FROM session_checkpoints
      WHERE session_id = ? AND cursor <= ?
      ORDER BY cursor DESC
    `).all(id, until);
    const eventExists = this.db.prepare(
      "SELECT 1 AS found FROM session_events WHERE session_id = ? AND seq = ?",
    );
    for (const row of rows) {
      if (checkpointChecksum(id, row.cursor, row.stateJson) !== row.checksum) continue;
      if (!eventExists.get(id, row.cursor)) continue;
      try {
        const state = parseState(row.stateJson, `${id} checkpoint ${row.cursor}`);
        if (state.id !== id) continue;
        return { ...row, state };
      } catch {}
    }
    return null;
  }
}

function sessionTitle(state) {
  const firstRequest = state.messages?.find((message) => message.role === "user")?.content?.trim();
  if (!firstRequest) return "新任务";
  const title = firstRequest.replace(/\s+/g, " ");
  return title.length > 36 ? `${title.slice(0, 36).trimEnd()}…` : title;
}

function parseMemoryRow(row) {
  return {
    id: row.id,
    content: row.content,
    tags: JSON.parse(row.tags_json),
    sourceSession: row.source_session,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

  const sourceId = validateImportTarget(archive.session.id, "archive session ID");
  let state = null;
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
    if (event.patch != null && stableStringify(event.patch) !== stableStringify(createStatePatch(state, next))) {
      throw new Error(`portable journal event ${cursor} 的 patch 与事实重放结果不一致`);
    }
    state = next;
    return event;
  });

  if (!Number.isInteger(archive.session.cursor) || archive.session.cursor !== events.length) {
    throw new Error("portable journal session cursor 与 events 数量不一致");
  }
  validateArchiveMetadata(archive.session, state);
  return { events, state };
}

function adaptJournal(events, { id, workspace }) {
  const adaptedEvents = [];
  const baseline = redactSensitiveValue({
    ...migrateSessionState(structuredClone(events[0].baseline)),
    id,
    workspace,
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
    if (action.type === "RESUMED") action.workspace = workspace;
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

function validateArchiveMetadata(metadata, state) {
  const fields = ["id", "createdAt", "updatedAt", "provider", "workspace"];
  for (const field of fields) {
    if (metadata[field] !== state[field]) {
      throw new Error(`portable journal session.${field} 与重放状态不一致`);
    }
  }
  if (metadata.stateSchemaVersion !== state.schemaVersion) {
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
  };
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
