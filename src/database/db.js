const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');

function initDb(dbPath) {
  fs.ensureDirSync(path.dirname(dbPath));

  const db = new Database(dbPath);

  // Use WAL mode for performance
  db.pragma('journal_mode = WAL');

  // Create tables as defined in TRD
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id   TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      state        TEXT NOT NULL DEFAULT 'ACTIVE',
      -- ACTIVE | NEAR_LIMIT | FINAL_WINDOW | CLOSED
      summary_path TEXT,
      alias        TEXT,
      focused_at   INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_focus (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      focused_at  INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE IF NOT EXISTS files (
      file_id          TEXT PRIMARY KEY,
      file_name        TEXT NOT NULL,
      original_name    TEXT NOT NULL,
      file_path        TEXT NOT NULL,
      hash             TEXT NOT NULL UNIQUE,
      file_type        TEXT,
      size_bytes       INTEGER,
      created_at       INTEGER NOT NULL,
      linked_session_id TEXT,
      project_id       TEXT,
      FOREIGN KEY (linked_session_id) REFERENCES sessions(session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_session ON files(linked_session_id);
    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);

    CREATE TABLE IF NOT EXISTS file_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      -- CREATED | MOVED | LINKED | DEDUPLICATED | REJECTED | REASSIGNED | ARCHIVED | DELETED
      detail      TEXT,
      timestamp   INTEGER NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(file_id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_file ON file_events(file_id);
    CREATE INDEX IF NOT EXISTS idx_events_time ON file_events(timestamp);

    CREATE TABLE IF NOT EXISTS projects (
      project_id   TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_active  INTEGER
    );

    CREATE TABLE IF NOT EXISTS cleanup_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      action      TEXT NOT NULL,  -- DELETED | ARCHIVED | KEPT | SKIPPED
      triggered_at INTEGER NOT NULL,
      resolved_at  INTEGER
    );
  `);

  return db;
}

module.exports = {
  initDb
};
