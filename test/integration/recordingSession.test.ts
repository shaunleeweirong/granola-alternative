import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { RecordingSession } from "../../src/core/recordingSession.ts";
import { NotesRepo } from "../../src/core/db/notesRepo.ts";
import { formatTranscript } from "../../src/core/transcript/merge.ts";
import { bytesToMs } from "../../src/core/audio/format.ts";
import type { Channel } from "../../src/core/transcript/types.ts";
import { chunk, longestZeroRun, makeQuietSpeech, makeSilence, makeSpeech } from "../harness/pcmFixtures.ts";

const feed = (session: RecordingSession, channel: Channel, pcm: Buffer): void => {
  for (const c of chunk(pcm, 100)) session.pushAudio(channel, c);
};

/**
 * Both channels stream at once in a real recording. Feeding one channel to
 * completion before the other is an artefact of the test, and it changes which
 * window reaches the queue first.
 */
const feedBoth = (session: RecordingSession, you: Buffer, them: Buffer): void => {
  const a = chunk(you, 100);
  const b = chunk(them, 100);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (i < b.length) session.pushAudio("them", b[i]);
    if (i < a.length) session.pushAudio("you", a[i]);
  }
};

test("produces a transcript from two channels, ordered by audio time", async () => {
  // Each window returns text tagged with the channel and its start time, so the
  // assertion can check ordering without depending on ASR behaviour.
  const session = new RecordingSession({
    language: "en",
    segmenterOptions: { idleFlushMs: 1_500, minWindowMs: 2_000, maxWindowMs: 8_000 },
    transcribe: async (req) => `${req.channel} speaking`,
  });

  // "them" talks for 4s, then "you" replies for 3s.
  feed(session, "them", makeSpeech(4_000, 0.12, 1));
  feed(session, "them", makeSilence(3_000));
  feed(session, "you", Buffer.concat([makeSilence(4_500), makeSpeech(3_000, 0.12, 2)]));
  feed(session, "you", makeSilence(3_000));

  const segments = await session.stop();

  assert.ok(segments.length >= 2, `expected both channels, got ${segments.length}`);
  const rendered = formatTranscript(segments);
  assert.match(rendered, /Them: them speaking/);
  assert.match(rendered, /You: you speaking/);

  // Ordering is by audio time: "them" started at 0, "you" at ~4.5s.
  const first = segments[0];
  assert.equal(first.channel, "them", "the earlier speaker comes first");
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i].startMs >= segments[i - 1].startMs, "segments are in audio order");
  }
});

test("a local interjection during a long remote turn lands in the right place", async () => {
  // The exact case the reference implementation reordered: the remote turn is
  // long, so its transcription finishes AFTER the short local "Right" that was
  // spoken in the middle of it. Wall-clock ordering would put "Right" last.
  const completionOrder: string[] = [];

  const session = new RecordingSession({
    segmenterOptions: { idleFlushMs: 1_200, minWindowMs: 2_000, maxWindowMs: 40_000 },
    transcribe: async (req) => {
      if (req.channel === "them") {
        // The long remote window takes much longer to decode.
        await new Promise((r) => setTimeout(r, 40));
        completionOrder.push("them");
        return "So the way I see it we have two options";
      }
      completionOrder.push("you");
      return "Right";
    },
  });

  feedBoth(
    session,
    // "Right" is spoken 8s in, i.e. in the middle of the remote turn.
    Buffer.concat([makeSilence(8_000), makeSpeech(900, 0.12, 4), makeSilence(14_000)]),
    Buffer.concat([makeSpeech(20_000, 0.12, 3), makeSilence(2_500)])
  );

  const segments = await session.stop();
  const rendered = formatTranscript(segments);

  assert.equal(completionOrder[0], "you", "the short local window decodes first");
  assert.ok(
    rendered.indexOf("Them: So the way") < rendered.indexOf("You: Right"),
    `transcript must follow audio time, not decode time:\n${rendered}`
  );
});

test("the initial prompt carries both the dictionary and the previous window", async () => {
  const prompts: string[] = [];
  const session = new RecordingSession({
    dictionary: ["Raghunathan", "Kubernetes"],
    segmenterOptions: { idleFlushMs: 1_200, minWindowMs: 2_000, maxWindowMs: 5_000 },
    transcribe: async (req) => {
      prompts.push(req.initialPrompt);
      return `window ${prompts.length}`;
    },
  });

  // Long enough to force several windows.
  feed(session, "them", makeSpeech(14_000, 0.12, 5));
  feed(session, "them", makeSilence(2_500));
  await session.stop();

  assert.ok(prompts.length >= 2, `expected several windows, got ${prompts.length}`);
  for (const prompt of prompts) {
    assert.match(prompt, /Raghunathan/, "every window carries the dictionary");
  }
  assert.doesNotMatch(prompts[0], /window 1/, "the first window has no prior context");
  assert.match(prompts[1], /window 1/, "later windows carry the previous transcript");
});

test("language is always passed explicitly, never left to auto-detection", async () => {
  const languages: string[] = [];
  const session = new RecordingSession({
    language: "de",
    segmenterOptions: { idleFlushMs: 1_200 },
    transcribe: async (req) => {
      languages.push(req.language);
      return "text";
    },
  });

  feed(session, "you", makeSpeech(3_000, 0.12, 6));
  feed(session, "you", makeSilence(2_500));
  await session.stop();

  assert.ok(languages.length > 0);
  assert.ok(languages.every((l) => l === "de"), `all calls pin the language: ${languages}`);
});

test("repeated text across a window boundary is de-duplicated", async () => {
  let call = 0;
  const session = new RecordingSession({
    segmenterOptions: { idleFlushMs: 1_200, minWindowMs: 2_000, maxWindowMs: 5_000 },
    transcribe: async () => {
      call += 1;
      // Window 2 re-reports the tail of window 1, as a 1s overlap really would.
      return call === 1 ? "we should ship on Friday" : "ship on Friday assuming CI is green";
    },
  });

  feed(session, "them", makeSpeech(12_000, 0.12, 7));
  feed(session, "them", makeSilence(2_500));
  const segments = await session.stop();

  const rendered = formatTranscript(segments, { includeTimestamps: false });
  const occurrences = rendered.split("ship on Friday").length - 1;
  assert.equal(occurrences, 1, `"ship on Friday" must appear once, got:\n${rendered}`);
  assert.match(rendered, /assuming CI is green/);
});

test("a failing window does not abort the recording", async () => {
  const errors: string[] = [];
  let call = 0;
  const session = new RecordingSession({
    segmenterOptions: { idleFlushMs: 1_200, minWindowMs: 2_000, maxWindowMs: 5_000 },
    transcribe: async () => {
      call += 1;
      if (call === 2) throw new Error("model out of memory");
      return `window ${call}`;
    },
    onError: (channel, error) => errors.push(`${channel}:${error.message}`),
  });

  feed(session, "them", makeSpeech(14_000, 0.12, 8));
  feed(session, "them", makeSilence(2_500));
  const segments = await session.stop();

  assert.deepEqual(errors, ["them:model out of memory"]);
  assert.ok(segments.length >= 1, "surviving windows still produce transcript");
});

test("raw audio is handed to the sink verbatim, never gated or zeroed", async () => {
  // Metric M-2 as a test: no code path may replace captured audio with silence.
  const captured: Record<Channel, Buffer[]> = { you: [], them: [] };
  const session = new RecordingSession({
    segmenterOptions: { idleFlushMs: 1_200 },
    transcribe: async () => "text",
    onAudio: (channel, pcm) => captured[channel].push(Buffer.from(pcm)),
  });

  const micAudio = makeQuietSpeech(4_000, 9);
  const systemAudio = makeSpeech(4_000, 0.3, 10);
  feed(session, "you", micAudio);
  feed(session, "them", systemAudio);
  await session.stop();

  const persistedMic = Buffer.concat(captured.you);
  assert.ok(persistedMic.equals(micAudio), "mic audio reaches disk byte-for-byte");
  // Quiet speech crosses zero, so isolated zero samples are ordinary 16-bit
  // quantisation. A gate zeroes a whole chunk — 33ms is 528 samples at 16kHz —
  // so anything under 10ms of consecutive zeros cannot be one.
  const zeroRunSamples = longestZeroRun(persistedMic);
  assert.ok(
    zeroRunSamples < 160,
    `longest zero run was ${zeroRunSamples} samples (${(zeroRunSamples / 16).toFixed(1)}ms); a gated chunk would be 528`
  );
});

test("quiet local speech survives while the remote channel is loud and continuous", async () => {
  // Metric M-1. This is the scenario the reference implementation fails: the
  // remote party talks throughout, and the local speaker is quiet. Its per-chunk
  // RMS gate zeroed or dropped the local channel for the whole call.
  const heard: Record<Channel, number> = { you: 0, them: 0 };
  const session = new RecordingSession({
    segmenterOptions: { idleFlushMs: 1_500, minWindowMs: 3_000, maxWindowMs: 10_000 },
    transcribe: async (req) => {
      heard[req.channel] += 1;
      return `${req.channel} utterance number ${heard[req.channel]}`;
    },
  });

  // 30 s of loud continuous remote audio.
  feed(session, "them", makeSpeech(30_000, 0.35, 11));
  // Five quiet local utterances spread through it.
  for (let i = 0; i < 5; i += 1) {
    feed(session, "you", makeSilence(4_000, 0.0004, 300 + i));
    feed(session, "you", makeQuietSpeech(2_000, 400 + i));
  }
  feed(session, "you", makeSilence(2_500));
  feed(session, "them", makeSilence(2_500));

  const segments = await session.stop();
  const yours = segments.filter((s) => s.channel === "you");

  assert.ok(heard.you > 0, "the quiet local channel must reach the model at all");
  assert.ok(yours.length > 0, "quiet local speech must appear in the transcript");
  assert.ok(
    yours.length >= 2,
    `expected the local utterances to survive, got ${yours.length} segments`
  );
});

test("stop() is idempotent and drains outstanding work", async () => {
  const session = new RecordingSession({
    segmenterOptions: { idleFlushMs: 1_200 },
    transcribe: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "text";
    },
  });

  feed(session, "you", makeSpeech(5_000, 0.12, 12));
  const first = await session.stop();
  const second = await session.stop();

  assert.equal(session.queueDepth, 0);
  assert.deepEqual(first, second);
});

test("audio pushed after stop is ignored", async () => {
  let calls = 0;
  const session = new RecordingSession({
    segmenterOptions: { idleFlushMs: 1_200 },
    transcribe: async () => {
      calls += 1;
      return "text";
    },
  });

  feed(session, "you", makeSpeech(3_000, 0.12, 13));
  await session.stop();
  const after = calls;

  feed(session, "you", makeSpeech(5_000, 0.12, 14));
  await session.stop();

  assert.equal(calls, after, "a stopped session accepts no more audio");
});

test("end to end: session output persists, searches and exports", async () => {
  const repo = new NotesRepo(new Database(":memory:"));
  const noteId = repo.createNote({ title: "Platform sync" });

  const session = new RecordingSession({
    dictionary: ["Kubernetes"],
    segmenterOptions: { idleFlushMs: 1_200, minWindowMs: 2_000, maxWindowMs: 6_000 },
    transcribe: async (req) =>
      req.channel === "them"
        ? "the Kubernetes migration slips to March"
        : "understood, I will tell the team",
    // FR-22: persist on commit, not at the end.
    onSegment: (segment) => repo.appendSegments(noteId, [segment]),
  });

  feed(session, "them", makeSpeech(4_000, 0.12, 15));
  feed(session, "them", makeSilence(2_000));
  feed(session, "you", Buffer.concat([makeSilence(5_000), makeSpeech(3_000, 0.12, 16)]));
  feed(session, "you", makeSilence(2_000));
  await session.stop();

  const stored = repo.getNote(noteId);
  assert.ok(stored);
  assert.ok(stored.segments.length >= 2, "segments were persisted as they arrived");

  // The transcript is searchable through the same FTS index as the notes.
  assert.deepEqual(repo.search("Kubernetes").map((h) => h.id), [noteId]);
  assert.deepEqual(repo.search("migration").map((h) => h.id), [noteId]);

  const rendered = formatTranscript(stored.segments);
  assert.match(rendered, /Them: the Kubernetes migration slips to March/);
  assert.match(rendered, /You: understood, I will tell the team/);
});

test("total audio handed to the model tracks the speech, not the wall clock", async () => {
  let transcribedMs = 0;
  const session = new RecordingSession({
    segmenterOptions: { idleFlushMs: 1_500, minWindowMs: 3_000, maxWindowMs: 12_000 },
    transcribe: async (req) => {
      transcribedMs += bytesToMs(req.pcm.length);
      return "text";
    },
  });

  // 20 s of speech buried in 60 s of silence.
  feed(session, "them", makeSilence(20_000));
  feed(session, "them", makeSpeech(20_000, 0.12, 17));
  feed(session, "them", makeSilence(20_000));
  await session.stop();

  assert.ok(transcribedMs >= 19_000, `speech must reach the model, got ${transcribedMs}ms`);
  assert.ok(
    transcribedMs < 35_000,
    `40s of silence must not be transcribed, sent ${transcribedMs}ms`
  );
});

test("a genuinely repeated phrase is kept when the windows do not overlap", async () => {
  // Regression: dedup compared the new window's head against all accumulated
  // text with a fixed token budget, so a speaker saying the same short phrase
  // in two separate windows lost the second one entirely. Only the overlap
  // region can hold duplicated audio, so dedup is bounded by it — and a window
  // separated from its predecessor by silence has no overlap at all.
  const session = new RecordingSession({
    segmenterOptions: { idleFlushMs: 1_200, minWindowMs: 2_000, maxWindowMs: 6_000 },
    transcribe: async () => "sounds good to me",
  });

  // Two utterances with 5s of silence between them, so the second window's
  // overlapMs is 0.
  feed(session, "you", makeSpeech(3_000, 0.12, 21));
  feed(session, "you", makeSilence(5_000, 0.0004, 22));
  feed(session, "you", makeSpeech(3_000, 0.12, 23));
  feed(session, "you", makeSilence(2_500, 0.0004, 24));

  const segments = await session.stop();
  const said = segments.filter((s) => s.text.includes("sounds good to me"));
  assert.equal(said.length, 2, `both utterances must survive, got ${segments.length} segments`);
});
