// FOUNDATION — ordered, transactional SQLite schema evolution.
export const EVENT_SCHEMA_VERSION = 1;

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
