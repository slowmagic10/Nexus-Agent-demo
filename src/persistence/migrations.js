// FOUNDATION — ordered, transactional SQLite schema evolution.
export const EVENT_SCHEMA_VERSION = 1;
export const MEMORY_EVENT_SCHEMA_VERSION = 1;

const migrations = [
  {
    version: 1,
    up(db) {
      db.exec(`
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
        CREATE TABLE IF NOT EXISTS session_events (
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          event_json TEXT NOT NULL,
          PRIMARY KEY(session_id, seq),
          FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS session_events_session_seq
          ON session_events(session_id, seq);
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
    },
  },
  {
    version: 2,
    up(db) {
      if (!hasColumn(db, "session_events", "schema_version")) {
        db.exec(`
          ALTER TABLE session_events
          ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
        `);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_checkpoints (
          session_id TEXT NOT NULL,
          cursor INTEGER NOT NULL,
          state_json TEXT NOT NULL,
          checksum TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(session_id, cursor),
          FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS session_checkpoints_latest
          ON session_checkpoints(session_id, cursor DESC);
      `);
    },
  },
  {
    version: 3,
    up(db) {
      addColumn(db, "memories", "scope_workspace", "TEXT");
      addColumn(db, "memories", "scope_agent", "TEXT");
      addColumn(db, "memories", "scope_user", "TEXT");
      addColumn(db, "memories", "kind", "TEXT NOT NULL DEFAULT 'fact'");
      addColumn(db, "memories", "status", "TEXT NOT NULL DEFAULT 'active'");
      addColumn(db, "memories", "confidence", "REAL NOT NULL DEFAULT 1");
      addColumn(db, "memories", "source_event", "INTEGER");
      addColumn(db, "memories", "provenance_json", "TEXT NOT NULL DEFAULT '{\"origin\":\"legacy\"}'");
      addColumn(db, "memories", "observed_at", "TEXT");
      addColumn(db, "memories", "expires_at", "TEXT");
      addColumn(db, "memories", "version", "INTEGER NOT NULL DEFAULT 1");
      addColumn(db, "memories", "replacement_id", "TEXT");
      addColumn(db, "memories", "deleted_reason", "TEXT");
      db.exec(`
        UPDATE memories SET observed_at = created_at WHERE observed_at IS NULL;
        CREATE INDEX IF NOT EXISTS memories_scope_status_updated
          ON memories(scope_workspace, scope_agent, scope_user, status, updated_at DESC);
        CREATE TABLE IF NOT EXISTS memory_events (
          memory_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          PRIMARY KEY(memory_id, seq),
          FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS memory_events_memory_seq
          ON memory_events(memory_id, seq);
        INSERT INTO memory_events (memory_id, seq, at, type, provenance_json, detail_json)
        SELECT id, 1, created_at, 'memory.migrated', provenance_json, '{"legacy":true}'
        FROM memories
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_events WHERE memory_events.memory_id = memories.id
        );
      `);
    },
  },
  {
    version: 4,
    up(db) {
      addColumn(db, "memories", "source_cursor", "INTEGER");
      addColumn(db, "memories", "source_tool_call", "TEXT");
      addColumn(db, "memories", "provenance_validated", "INTEGER NOT NULL DEFAULT 0");
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_mutations (
          mutation_id TEXT PRIMARY KEY,
          memory_id TEXT,
          operation TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS memory_mutations_memory
          ON memory_mutations(memory_id, created_at DESC);
      `);
    },
  },
  {
    version: 5,
    up(db) {
      addColumn(db, "memory_events", "schema_version", "INTEGER NOT NULL DEFAULT 1");
      addColumn(db, "memory_mutations", "request_hash", "TEXT");
    },
  },
];

export function migrateDatabase(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const isApplied = db.prepare("SELECT 1 AS found FROM schema_migrations WHERE version = ?");
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  for (const migration of migrations) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!isApplied.get(migration.version)) {
        migration.up(db);
        record.run(migration.version, new Date().toISOString());
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`数据库 migration v${migration.version} 失败：${error.message}`);
    }
  }
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function addColumn(db, table, column, definition) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
