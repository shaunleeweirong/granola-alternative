import type BetterSqlite3 from "better-sqlite3";

import { migrate } from "./schema.ts";
import type { Channel, TranscriptSegment } from "../transcript/types.ts";
import { formatTranscript, mergeSegments } from "../transcript/merge.ts";

export interface NoteRow {
  id: number;
  title: string;
  manualNotes: string;
  generatedNotes: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
}

export interface NoteWithTranscript extends NoteRow {
  segments: TranscriptSegment[];
}

export interface NoteSummary extends NoteRow {
  segmentCount: number;
}

export interface SearchHit extends NoteRow {
  snippet: string;
}

interface RawNote {
  id: number;
  title: string;
  manual_notes: string;
  generated_notes: string;
  created_at: number;
  updated_at: number;
  duration_ms: number;
}

const toNote = (row: RawNote): NoteRow => ({
  id: row.id,
  title: row.title,
  manualNotes: row.manual_notes,
  generatedNotes: row.generated_notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  durationMs: row.duration_ms,
});

/**
 * Turns free text into a safe FTS5 MATCH expression.
 *
 * FTS5 treats bare input as a query language, so `note AND "` from a user is
 * either a syntax error or an unintended operator. Every token is quoted and
 * ANDed, which makes user input inert.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = input
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
}

export class NotesRepo {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
    migrate(this.db);
  }

  // ------------------------------------------------------------- notes

  createNote(input: { title?: string; createdAt?: number } = {}): number {
    const now = input.createdAt ?? Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO notes (title, manual_notes, generated_notes, created_at, updated_at, duration_ms)
         VALUES (?, '', '', ?, ?, 0)`
      )
      .run(input.title ?? "", now, now);
    const id = Number(result.lastInsertRowid);
    this.reindex(id);
    return id;
  }

  getNote(id: number): NoteWithTranscript | null {
    const row = this.db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as RawNote | undefined;
    if (!row) return null;
    return { ...toNote(row), segments: this.getSegments(id) };
  }

  updateNote(
    id: number,
    patch: { title?: string; manualNotes?: string; generatedNotes?: string; durationMs?: number }
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.manualNotes !== undefined) {
      sets.push("manual_notes = ?");
      values.push(patch.manualNotes);
    }
    if (patch.generatedNotes !== undefined) {
      sets.push("generated_notes = ?");
      values.push(patch.generatedNotes);
    }
    if (patch.durationMs !== undefined) {
      sets.push("duration_ms = ?");
      values.push(patch.durationMs);
    }
    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    this.reindex(id);
  }

  deleteNote(id: number): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
      this.db.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).run(id);
    })();
  }

  listNotes({ limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}): NoteSummary[] {
    const rows = this.db
      .prepare(
        `SELECT n.*, (SELECT COUNT(*) FROM transcript_segments s WHERE s.note_id = n.id) AS segment_count
         FROM notes n
         ORDER BY n.created_at DESC, n.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as Array<RawNote & { segment_count: number }>;
    return rows.map((row) => ({ ...toNote(row), segmentCount: row.segment_count }));
  }

  // ---------------------------------------------------------- segments

  /**
   * FR-22: segments are persisted as they are produced, so a crash mid-meeting
   * loses at most the window currently being transcribed.
   */
  appendSegments(noteId: number, segments: readonly TranscriptSegment[]): void {
    if (segments.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO transcript_segments (id, note_id, channel, text, start_ms, end_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const s of segments) {
        insert.run(s.id, noteId, s.channel, s.text, Math.round(s.startMs), Math.round(s.endMs));
      }
    })();
    this.reindex(noteId);
  }

  getSegments(noteId: number): TranscriptSegment[] {
    const rows = this.db
      .prepare(
        `SELECT id, channel, text, start_ms, end_ms
         FROM transcript_segments WHERE note_id = ? ORDER BY start_ms ASC, id ASC`
      )
      .all(noteId) as Array<{
      id: string;
      channel: Channel;
      text: string;
      start_ms: number;
      end_ms: number;
    }>;
    return mergeSegments(
      rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        text: r.text,
        startMs: r.start_ms,
        endMs: r.end_ms,
      }))
    );
  }

  // ------------------------------------------------------------ search

  search(query: string, { limit = 30 }: { limit?: number } = {}): SearchHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];

    const rows = this.db
      .prepare(
        `SELECT n.*, snippet(notes_fts, 1, '[', ']', '…', 12) AS snippet
         FROM notes_fts
         JOIN notes n ON n.id = notes_fts.note_id
         WHERE notes_fts MATCH ?
         ORDER BY bm25(notes_fts), n.created_at DESC
         LIMIT ?`
      )
      .all(match, limit) as Array<RawNote & { snippet: string }>;

    return rows.map((row) => ({ ...toNote(row), snippet: row.snippet }));
  }

  /** Rebuild one note's search row from every searchable field it owns. */
  private reindex(noteId: number): void {
    const note = this.db.prepare(`SELECT * FROM notes WHERE id = ?`).get(noteId) as
      | RawNote
      | undefined;
    if (!note) return;

    const transcript = formatTranscript(this.getSegments(noteId), { includeTimestamps: false });
    const body = [note.generated_notes, note.manual_notes, transcript].filter(Boolean).join("\n\n");

    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).run(noteId);
      this.db
        .prepare(`INSERT INTO notes_fts (title, body, note_id) VALUES (?, ?, ?)`)
        .run(note.title, body, noteId);
    })();
  }

  // ---------------------------------------------------------- settings

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  // -------------------------------------------------------- dictionary

  getDictionary(): string[] {
    const rows = this.db
      .prepare(`SELECT term FROM dictionary_terms ORDER BY term COLLATE NOCASE ASC`)
      .all() as Array<{ term: string }>;
    return rows.map((r) => r.term);
  }

  setDictionary(terms: readonly string[]): void {
    const cleaned = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM dictionary_terms`).run();
      const insert = this.db.prepare(`INSERT OR IGNORE INTO dictionary_terms (term) VALUES (?)`);
      for (const term of cleaned) insert.run(term);
    })();
  }
}
