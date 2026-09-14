import { test } from "node:test";
import assert from "node:assert/strict";

import { dedupeOverlap, tailOf } from "../../src/core/transcript/overlapDedup.ts";
import { buildInitialPrompt } from "../../src/core/transcript/promptBuilder.ts";
import {
  channelText,
  formatTimestamp,
  formatTranscript,
  mergeSegments,
} from "../../src/core/transcript/merge.ts";
import type { TranscriptSegment } from "../../src/core/transcript/types.ts";

const seg = (
  id: string,
  channel: "you" | "them",
  startMs: number,
  text: string,
  endMs = startMs + 2000
): TranscriptSegment => ({ id, channel, text, startMs, endMs });

// ---------------------------------------------------------------- overlap

test("removes text the next window repeats from the previous one", () => {
  const previous = "so the migration is scheduled for Thursday morning";
  const next = "scheduled for Thursday morning and we should tell the team";
  assert.equal(dedupeOverlap(previous, next), "and we should tell the team");
});

test("matches across punctuation and casing differences from the decoder", () => {
  const previous = "we can ship it on Friday";
  const next = "Ship it on Friday, assuming CI is green.";
  assert.equal(dedupeOverlap(previous, next), "assuming CI is green.");
});

test("leaves an unrelated window completely alone", () => {
  const previous = "let us talk about the budget";
  const next = "moving on to hiring plans for next quarter";
  assert.equal(dedupeOverlap(previous, next), next);
});

test("a genuine repetition by the speaker is not deleted", () => {
  // Longer than maxOverlapTokens, so it cannot be overlap from a 1s window.
  const previous = "I want to be really clear that we are not going to ship this before the audit";
  const next = "I want to be really clear that we are not going to ship this before the audit";
  assert.equal(dedupeOverlap(previous, next), next, "a full repeat is content, not overlap");
});

test("a window that is entirely overlap collapses to empty", () => {
  assert.equal(dedupeOverlap("the deadline is next Tuesday", "deadline is next Tuesday"), "");
});

test("handles empty input on either side", () => {
  assert.equal(dedupeOverlap("", "hello there"), "hello there");
  assert.equal(dedupeOverlap("hello there", ""), "");
});

test("a single common word is not treated as an overlap", () => {
  assert.equal(dedupeOverlap("that is the plan", "the budget is separate"), "the budget is separate");
});

test("tailOf cuts at a word boundary", () => {
  const tail = tailOf("alpha beta gamma delta epsilon", 14);
  assert.ok(!tail.startsWith("elta"), `must not start mid-word, got "${tail}"`);
  assert.ok(tail.length <= 14);
  assert.ok("alpha beta gamma delta epsilon".endsWith(tail));
});

// ----------------------------------------------------------------- prompt

test("initial prompt carries the dictionary and the previous tail", () => {
  const prompt = buildInitialPrompt({
    previousText: "we reviewed the Kubernetes migration with Priya",
    dictionary: ["Priya Raghunathan", "Kubernetes", "ACME Corp"],
  });
  assert.match(prompt, /Priya Raghunathan/);
  assert.match(prompt, /Kubernetes/);
  assert.match(prompt, /reviewed the Kubernetes migration/);
});

test("initial prompt works with no previous context (first window)", () => {
  const prompt = buildInitialPrompt({ dictionary: ["Kubernetes"] });
  assert.match(prompt, /Kubernetes/);
  assert.ok(prompt.length > 0);
});

test("initial prompt is empty when there is nothing to say", () => {
  assert.equal(buildInitialPrompt(), "");
});

test("the dictionary survives when the prompt budget is tight", () => {
  // Whisper truncates an over-budget prompt from the front, so the dictionary
  // must come first or the user's spellings are the thing that gets dropped.
  const prompt = buildInitialPrompt({
    previousText: "word ".repeat(4000),
    dictionary: ["Raghunathan"],
    maxTotalChars: 120,
  });
  assert.ok(prompt.length <= 120, `prompt was ${prompt.length} chars`);
  assert.match(prompt, /Raghunathan/, "dictionary must survive truncation");
});

test("blank dictionary entries are ignored", () => {
  const prompt = buildInitialPrompt({ dictionary: ["  ", "", "Kubernetes"] });
  assert.equal(prompt, "Glossary: Kubernetes.");
});

// ------------------------------------------------------------------ merge

test("segments order by audio time across both channels", () => {
  // The case the reference implementation got wrong: a long remote turn finishes
  // transcribing after a short local interjection spoken in the middle of it.
  const segments = [
    seg("a", "them", 0, "So the way I see it, we have two options here", 30_000),
    seg("b", "you", 12_000, "Right", 12_800),
    seg("c", "them", 30_000, "and the second is cheaper", 34_000),
  ];
  const merged = mergeSegments(segments);
  assert.deepEqual(merged.map((s) => s.id), ["a", "b", "c"]);
});

test("merge does not mutate the input array", () => {
  const segments = [seg("b", "you", 5_000, "second"), seg("a", "them", 0, "first")];
  const copy = [...segments];
  mergeSegments(segments);
  assert.deepEqual(segments, copy);
});

test("ties break deterministically with You before Them", () => {
  const merged = mergeSegments([seg("t", "them", 1_000, "x"), seg("y", "you", 1_000, "y")]);
  assert.deepEqual(merged.map((s) => s.channel), ["you", "them"]);
});

test("transcript renders with timestamps and speaker labels", () => {
  const text = formatTranscript([
    seg("a", "them", 0, "Welcome everyone.", 3_000),
    seg("b", "you", 3_500, "Thanks for having me.", 5_000),
  ]);
  assert.equal(text, "[00:00] Them: Welcome everyone.\n[00:03] You: Thanks for having me.");
});

test("consecutive segments from one speaker collapse into one line", () => {
  const text = formatTranscript([
    seg("a", "them", 0, "First point.", 2_000),
    seg("b", "them", 2_000, "Second point.", 4_000),
    seg("c", "you", 4_000, "Understood.", 5_000),
  ]);
  assert.equal(text, "[00:00] Them: First point. Second point.\n[00:04] You: Understood.");
});

test("empty segments are dropped from the rendered transcript", () => {
  const text = formatTranscript([
    seg("a", "them", 0, "Real content.", 1_000),
    seg("b", "you", 1_000, "   ", 2_000),
  ]);
  assert.equal(text, "[00:00] Them: Real content.");
});

test("timestamps roll over into hours", () => {
  assert.equal(formatTimestamp(0), "00:00");
  assert.equal(formatTimestamp(65_000), "01:05");
  assert.equal(formatTimestamp(3_725_000), "1:02:05");
});

test("channelText extracts one lane in audio order for the next prompt", () => {
  const segments = [
    seg("b", "them", 5_000, "second"),
    seg("a", "them", 0, "first"),
    seg("c", "you", 2_000, "mine"),
  ];
  assert.equal(channelText(segments, "them"), "first second");
  assert.equal(channelText(segments, "you"), "mine");
});
