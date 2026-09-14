import type BetterSqlite3 from "better-sqlite3";

/**
 * Local SQLite schema (FR-32). There is no server, so this database is the
 * single source of truth for everything the app knows.
 */
export const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL DEFAULT '',
    manual_notes    TEXT    NOT NULL DEFAULT '',
    generated_notes TEXT    NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    duration_ms     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transcript_segments (
    id        TEXT    PRIMARY KEY,
    note_id   INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    channel   TEXT    NOT NULL CHECK (channel IN ('you', 'them')),
    text      TEXT    NOT NULL,
    start_ms  INTEGER NOT NULL,
    end_ms    INTEGER NOT NULL
  );

  -- Transcripts are always read in audio order for one note (FR-19).
  CREATE INDEX IF NOT EXISTS idx_segments_note_start
    ON transcript_segments (note_id, start_ms);

  -- One row per note holding everything searchable: title, both note bodies,
  -- and the flattened transcript. Rebuilt whenever any of those change.
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    body,
    note_id UNINDEXED
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dictionary_terms (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL UNIQUE
  );
  `,
];

export function migrate(db: BetterSqlite3.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const current = Number((db.pragma("user_version", { simple: true }) as number) ?? 0);
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec(MIGRATIONS[version]);
  }
  db.pragma(`user_version = ${MIGRATIONS.length}`);
}
