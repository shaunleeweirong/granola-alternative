import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { NotesRepo, toFtsQuery } from "../../src/core/db/notesRepo.ts";
import type { TranscriptSegment } from "../../src/core/transcript/types.ts";

const freshRepo = (): NotesRepo => new NotesRepo(new Database(":memory:"));

const seg = (
  id: string,
  channel: "you" | "them",
  startMs: number,
  text: string
): TranscriptSegment => ({ id, channel, text, startMs, endMs: startMs + 2000 });

test("creates, reads back and updates a note", () => {
  const repo = freshRepo();
  const id = repo.createNote({ title: "Pricing sync" });

  repo.updateNote(id, { manualNotes: "ask about the discount tier", durationMs: 1_800_000 });

  const note = repo.getNote(id);
  assert.ok(note);
  assert.equal(note.title, "Pricing sync");
  assert.equal(note.manualNotes, "ask about the discount tier");
  assert.equal(note.durationMs, 1_800_000);
  assert.deepEqual(note.segments, []);
});

test("getNote returns null for a missing id", () => {
  assert.equal(freshRepo().getNote(999), null);
});

test("segments persist and come back in audio order", () => {
  const repo = freshRepo();
  const id = repo.createNote();

  // Appended out of order, as a two-channel queue would produce them.
  repo.appendSegments(id, [seg("c", "them", 20_000, "third")]);
  repo.appendSegments(id, [seg("a", "them", 0, "first"), seg("b", "you", 10_000, "second")]);

  const note = repo.getNote(id);
  assert.deepEqual(note?.segments.map((s) => s.text), ["first", "second", "third"]);
});

test("re-appending the same segment id replaces rather than duplicates", () => {
  const repo = freshRepo();
  const id = repo.createNote();
  repo.appendSegments(id, [seg("w1", "you", 0, "draft text")]);
  repo.appendSegments(id, [seg("w1", "you", 0, "corrected text")]);

  const note = repo.getNote(id);
  assert.equal(note?.segments.length, 1);
  assert.equal(note?.segments[0].text, "corrected text");
});

test("deleting a note removes its segments and its search row", () => {
  const repo = freshRepo();
  const id = repo.createNote({ title: "Doomed" });
  repo.appendSegments(id, [seg("a", "them", 0, "ephemeral content")]);

  repo.deleteNote(id);

  assert.equal(repo.getNote(id), null);
  assert.deepEqual(repo.getSegments(id), []);
  assert.deepEqual(repo.search("ephemeral"), []);
});

test("notes list newest first", () => {
  const repo = freshRepo();
  repo.createNote({ title: "oldest", createdAt: 1_000 });
  repo.createNote({ title: "newest", createdAt: 3_000 });
  repo.createNote({ title: "middle", createdAt: 2_000 });

  assert.deepEqual(repo.listNotes().map((n) => n.title), ["newest", "middle", "oldest"]);
});

test("list reports segment counts", () => {
  const repo = freshRepo();
  const id = repo.createNote({ title: "With transcript" });
  repo.appendSegments(id, [seg("a", "you", 0, "one"), seg("b", "them", 5_000, "two")]);
  repo.createNote({ title: "Empty" });

  const byTitle = Object.fromEntries(repo.listNotes().map((n) => [n.title, n.segmentCount]));
  assert.equal(byTitle["With transcript"], 2);
  assert.equal(byTitle["Empty"], 0);
});

// ------------------------------------------------------------------ search

test("search covers titles, manual notes, generated notes and transcripts", () => {
  const repo = freshRepo();

  const a = repo.createNote({ title: "Quarterly planning" });
  repo.updateNote(a, { manualNotes: "remember to raise the staffing question" });

  const b = repo.createNote({ title: "Vendor call" });
  repo.updateNote(b, { generatedNotes: "## Decisions\n- Renew the Datadog contract" });

  const c = repo.createNote({ title: "Standup" });
  repo.appendSegments(c, [seg("x", "them", 0, "the deployment pipeline is blocked on credentials")]);

  assert.deepEqual(repo.search("quarterly").map((h) => h.id), [a]);
  assert.deepEqual(repo.search("staffing").map((h) => h.id), [a]);
  assert.deepEqual(repo.search("Datadog").map((h) => h.id), [b]);
  assert.deepEqual(repo.search("credentials").map((h) => h.id), [c]);
});

test("search reflects edits rather than stale content", () => {
  const repo = freshRepo();
  const id = repo.createNote({ title: "Notes" });
  repo.updateNote(id, { manualNotes: "aardvark" });
  assert.equal(repo.search("aardvark").length, 1);

  repo.updateNote(id, { manualNotes: "buffalo" });
  assert.equal(repo.search("aardvark").length, 0, "old text must leave the index");
  assert.equal(repo.search("buffalo").length, 1);
});

test("search returns a snippet marking the hit", () => {
  const repo = freshRepo();
  const id = repo.createNote({ title: "Retro" });
  repo.updateNote(id, { manualNotes: "the rollback procedure needs documenting before launch" });

  const [hit] = repo.search("rollback");
  assert.ok(hit, "expected a hit");
  assert.match(hit.snippet, /\[rollback\]/i);
});

test("multi-word search requires all terms", () => {
  const repo = freshRepo();
  const a = repo.createNote({ title: "Alpha" });
  repo.updateNote(a, { manualNotes: "migration timeline" });
  const b = repo.createNote({ title: "Beta" });
  repo.updateNote(b, { manualNotes: "migration only" });

  assert.deepEqual(repo.search("migration timeline").map((h) => h.id), [a]);
});

test("FTS operators in user input are inert, not syntax errors", () => {
  const repo = freshRepo();
  const id = repo.createNote({ title: "Safe" });
  repo.updateNote(id, { manualNotes: "ordinary content" });

  // Each of these is a valid FTS5 operator or a syntax error if passed through.
  for (const nasty of ['ordinary AND "', "NOT content", "ordinary*", '"', "^ordinary", "a OR b"]) {
    assert.doesNotThrow(() => repo.search(nasty), `search must survive input: ${nasty}`);
  }
  assert.deepEqual(repo.search("").map((h) => h.id), []);
  assert.deepEqual(repo.search("   !!!  ").map((h) => h.id), []);
});

test("toFtsQuery quotes every token and rejects empty input", () => {
  assert.equal(toFtsQuery("hello world"), '"hello" AND "world"');
  assert.equal(toFtsQuery("  "), null);
  assert.equal(toFtsQuery('say "hi"'), '"say" AND "hi"');
});

test("search stays under 300ms with 500 notes (metric M-7)", () => {
  const repo = freshRepo();
  for (let i = 0; i < 500; i += 1) {
    const id = repo.createNote({ title: `Meeting ${i}`, createdAt: 1_000 + i });
    repo.updateNote(id, {
      manualNotes: `agenda item ${i} covering budget, staffing and the platform roadmap`,
    });
    repo.appendSegments(id, [
      seg(`${i}-a`, "them", 0, `we discussed the ${i} quarter forecast at some length today`),
      seg(`${i}-b`, "you", 5_000, `noted, I will follow up on item ${i} tomorrow morning`),
    ]);
  }

  const started = performance.now();
  const hits = repo.search("forecast");
  const elapsed = performance.now() - started;

  assert.ok(hits.length > 0, "expected matches");
  assert.ok(elapsed < 300, `search took ${elapsed.toFixed(1)}ms, budget is 300ms`);
});

// -------------------------------------------------------- settings + dict

test("settings round-trip and overwrite", () => {
  const repo = freshRepo();
  assert.equal(repo.getSetting("model"), null);
  repo.setSetting("model", "large-v3-turbo");
  assert.equal(repo.getSetting("model"), "large-v3-turbo");
  repo.setSetting("model", "base");
  assert.equal(repo.getSetting("model"), "base");
});

test("dictionary de-duplicates, trims and sorts", () => {
  const repo = freshRepo();
  repo.setDictionary(["  Kubernetes ", "ACME", "Kubernetes", "", "   "]);
  assert.deepEqual(repo.getDictionary(), ["ACME", "Kubernetes"]);
});

test("setting the dictionary replaces the previous list", () => {
  const repo = freshRepo();
  repo.setDictionary(["old"]);
  repo.setDictionary(["new"]);
  assert.deepEqual(repo.getDictionary(), ["new"]);
});

test("foreign keys cascade segments when a note row is removed", () => {
  const repo = freshRepo();
  const id = repo.createNote();
  repo.appendSegments(id, [seg("a", "you", 0, "text")]);
  repo.deleteNote(id);
  assert.deepEqual(repo.getSegments(id), []);
});
