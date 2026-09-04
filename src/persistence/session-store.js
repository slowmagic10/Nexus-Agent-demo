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
import { SQLiteMemoryAdapter } from "../memory/sqlite-adapter.js";
import { createMemoryScope } from "../memory/scope.js";
import { SQLiteArtifactAdapter } from "../artifacts/sqlite-adapter.js";
import { artifactMetadata, MAX_ARTIFACT_BYTES } from "../artifacts/interface.js";

const JOURNAL_FORMAT = "nexus.session-journal";
const JOURNAL_FORMAT_VERSION = 1;
const MAX_PORTABLE_ARTIFACTS = 256;
const MAX_PORTABLE_ARTIFACT_BYTES = 64_000_000;

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
      this.#insertJournalBaseline(durableState);
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
    let state = this.load(id);
    if (!state) throw new Error(`未找到会话：${id}`);
    if (this.latestSessionCursor(id) === 0) {
      state = this.ensureJournal(state);
    }
    const artifacts = exportSessionArtifacts(this.db, id);
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
      ...(artifacts.length ? { artifacts } : {}),
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
             provider, phase, message_count AS messageCount, state_json AS stateJson
      FROM sessions
      WHERE workspace = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(workspace, limit).map(({ stateJson, ...row }) => ({
      ...row,
      title: resolveSessionDisplayTitle(parseState(stateJson, row.id)),
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

  #insertJournalBaseline(state) {
    this.save(state);
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

function exportSessionArtifacts(db, sessionId) {
  return db.prepare(`
    SELECT id, call_id, kind, media_type, byte_size, sha256, content, created_at
    FROM artifacts WHERE session_id = ? ORDER BY created_at, id
  `).all(sessionId).map((row) => {
    const bytes = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    if (bytes.byteLength !== row.byte_size || artifactDigest(bytes) !== row.sha256) {
      throw new Error(`Artifact ${row.id} 完整性校验失败，无法导出`);
    }
    return {
      id: row.id,
      callId: row.call_id,
      kind: row.kind,
      mediaType: row.media_type,
      byteSize: row.byte_size,
      sha256: row.sha256,
      createdAt: row.created_at,
      content: bytes.toString("utf8"),
    };
  });
}

function validatePortableArtifacts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("portable journal artifacts 必须是数组");
  if (value.length > MAX_PORTABLE_ARTIFACTS) {
    throw new Error(`portable journal Artifact 数量超过 ${MAX_PORTABLE_ARTIFACTS}`);
  }
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
    if (totalBytes > MAX_PORTABLE_ARTIFACT_BYTES) {
      throw new Error(`portable journal Artifact 总量超过 ${MAX_PORTABLE_ARTIFACT_BYTES} 字节上限`);
    }
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
