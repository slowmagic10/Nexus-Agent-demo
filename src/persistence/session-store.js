// FOUNDATION — SQLite session snapshots and long-term memory.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export class SessionStore {
  constructor(file) {
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        workspace TEXT NOT NULL,
        phase TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        state_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_workspace_updated
        ON sessions(workspace, updated_at DESC);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_session TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_updated ON memories(updated_at DESC);
    `);
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
    this.upsert.run(
      state.id,
      state.createdAt,
      state.updatedAt,
      state.provider,
      state.workspace,
      state.phase,
      state.messages.length,
      JSON.stringify(state),
    );
  }

  load(id) {
    const row = this.db.prepare("SELECT state_json FROM sessions WHERE id = ?").get(id);
    return row ? parseState(row.state_json, id) : null;
  }

  latest(workspace) {
    const row = this.db.prepare(`
      SELECT state_json FROM sessions
      WHERE workspace = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(workspace);
    return row ? parseState(row.state_json, "latest") : null;
  }

  list(workspace, limit = 20) {
    return this.db.prepare(`
      SELECT id, created_at AS createdAt, updated_at AS updatedAt,
             provider, phase, message_count AS messageCount
      FROM sessions
      WHERE workspace = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(workspace, limit).map((row) => ({ ...row }));
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
    const state = JSON.parse(value);
    if (!state?.id || !Array.isArray(state.messages) || !Array.isArray(state.events)) {
      throw new Error("状态结构不完整");
    }
    return state;
  } catch (error) {
    throw new Error(`会话 ${label} 的持久化数据损坏：${error.message}`);
  }
}
