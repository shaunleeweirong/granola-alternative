import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

import { RecordingController } from "../../src/main/recordingController.ts";
import { AudioTapHost } from "../../src/main/audioTapHost.ts";
import { WhisperClient } from "../../src/main/whisperClient.ts";
import { NotesRepo } from "../../src/core/db/notesRepo.ts";
import { formatTranscript } from "../../src/core/transcript/merge.ts";
import { makeSilence, makeSpeech, chunk } from "../harness/pcmFixtures.ts";
import type { Channel, TranscriptSegment } from "../../src/core/transcript/types.ts";

const FAKE_TAP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "harness",
  "fakeTap.mjs"
);

interface Harness {
  controller: RecordingController;
  repo: NotesRepo;
  audioDir: string;
  segments: TranscriptSegment[];
  errors: string[];
  levels: Record<Channel, number[]>;
  prompts: string[];
  cleanup: () => Promise<void>;
}

async function makeHarness(
  options: {
    tapMode?: string | null;
    transcribeText?: (callIndex: number) => string;
    whisperStatus?: number;
    retainAudio?: boolean;
  } = {}
): Promise<Harness> {
  const prompts: string[] = [];
  let calls = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("latin1");
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => {
      const match = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(body);
      prompts.push(match ? match[1] : "");

      if (options.whisperStatus && options.whisperStatus !== 200) {
        res.writeHead(options.whisperStatus, { "Content-Type": "text/plain" });
        res.end("model unavailable");
        return;
      }
      calls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ text: options.transcribeText?.(calls) ?? `transcribed window ${calls}` })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const audioDir = await mkdtemp(path.join(os.tmpdir(), "ga-audio-"));
  const repo = new NotesRepo(new Database(":memory:"));
  const segments: TranscriptSegment[] = [];
  const errors: string[] = [];
  const levels: Record<Channel, number[]> = { you: [], them: [] };

  const controller = new RecordingController({
    repo,
    whisper: new WhisperClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5_000 }),
    audioDir,
    language: "en",
    retainAudio: options.retainAudio ?? false,
    createTapHost: () =>
      options.tapMode === null
        ? null
        : new AudioTapHost({
            command: process.execPath,
            args: [FAKE_TAP, "--mode", options.tapMode ?? "start", "--chunks", "0"],
            startTimeoutMs: 3_000,
          }),
    onSegment: (_noteId, segment) => segments.push(segment),
    onError: (message) => errors.push(message),
    onLevel: (channel, rms) => levels[channel].push(rms),
  });

  return {
    controller,
    repo,
    audioDir,
    segments,
    errors,
    levels,
    prompts,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(audioDir, { recursive: true, force: true });
    },
  };
}

const pushMic = (controller: RecordingController, pcm: Buffer): void => {
  for (const c of chunk(pcm, 100)) controller.pushMicAudio(c);
};

test("records, transcribes and persists a full session", async (t) => {
  const h = await makeHarness({ transcribeText: () => "we agreed to ship on Friday" });
  t.after(h.cleanup);

  const started = await h.controller.start({ title: "Vendor call" });
  assert.ok(started.sessionId);
  assert.equal(started.systemAudioReady, true, "the tap started");

  pushMic(h.controller, makeSpeech(6_000, 0.12, 41));
  pushMic(h.controller, makeSilence(3_000));

  const result = await h.controller.stop();

  assert.equal(result.noteId, started.noteId);
  assert.ok(result.segmentCount >= 1, "at least one window was transcribed");
  assert.ok(result.durationMs >= 0);

  const note = h.repo.getNote(started.noteId);
  assert.ok(note);
  assert.equal(note.title, "Vendor call");
  assert.ok(note.segments.length >= 1, "segments persisted to the database");
  assert.match(formatTranscript(note.segments), /You: we agreed to ship on Friday/);
  assert.ok(h.segments.length >= 1, "segments were emitted live during the recording");
});

test("the dictionary reaches whisper as an initial prompt", async (t) => {
  const h = await makeHarness();
  t.after(h.cleanup);

  h.repo.setDictionary(["Raghunathan", "Datadog"]);

  await h.controller.start({ title: "With glossary" });
  pushMic(h.controller, makeSpeech(6_000, 0.12, 42));
  pushMic(h.controller, makeSilence(3_000));
  await h.controller.stop();

  assert.ok(h.prompts.length >= 1, "whisper was called");
  assert.match(h.prompts[0], /Raghunathan/, "the user's dictionary reached the decoder");
  assert.match(h.prompts[0], /Datadog/);
});

test("raw PCM is written during the recording and removed after success", async (t) => {
  const h = await makeHarness();
  t.after(h.cleanup);

  const started = await h.controller.start();
  pushMic(h.controller, makeSpeech(4_000, 0.12, 43));

  // FR-8: audio is on disk before any transcription has succeeded.
  const during = await readdir(h.audioDir);
  assert.ok(during.some((f) => f.includes(started.sessionId)), "PCM files exist mid-recording");
  const micFile = path.join(h.audioDir, `${started.sessionId}-you.pcm`);
  assert.ok((await stat(micFile)).size > 0, "microphone audio is being written");

  pushMic(h.controller, makeSilence(3_000));
  await h.controller.stop();

  // FR-33: discarded once every window transcribed cleanly.
  assert.deepEqual(await readdir(h.audioDir), [], "temporary audio is cleaned up");
});

test("audio is retained when transcription failed, so nothing is lost", async (t) => {
  const h = await makeHarness({ whisperStatus: 500 });
  t.after(h.cleanup);

  const started = await h.controller.start();
  pushMic(h.controller, makeSpeech(6_000, 0.12, 44));
  pushMic(h.controller, makeSilence(3_000));
  await h.controller.stop();

  assert.ok(h.errors.length > 0, "the failure was reported");
  const remaining = await readdir(h.audioDir);
  assert.ok(
    remaining.some((f) => f.includes(started.sessionId)),
    "a failed transcription keeps the audio for a retry"
  );
});

test("audio is retained when the user asked for it", async (t) => {
  const h = await makeHarness({ retainAudio: true });
  t.after(h.cleanup);

  const started = await h.controller.start();
  pushMic(h.controller, makeSpeech(5_000, 0.12, 45));
  pushMic(h.controller, makeSilence(3_000));
  await h.controller.stop();

  const remaining = await readdir(h.audioDir);
  assert.ok(remaining.some((f) => f.includes(started.sessionId)));
});

test("a failed system-audio tap degrades to microphone only instead of aborting", async (t) => {
  const h = await makeHarness({ tapMode: "deny" });
  t.after(h.cleanup);

  const started = await h.controller.start({ title: "Mic only" });

  assert.equal(started.systemAudioReady, false);
  assert.match(String(started.systemAudioReason), /denied/i);

  // The recording still works.
  pushMic(h.controller, makeSpeech(6_000, 0.12, 46));
  pushMic(h.controller, makeSilence(3_000));
  const result = await h.controller.stop();

  assert.ok(result.segmentCount >= 1, "microphone-only recording still produces a transcript");
});

test("an unsupported platform reports it rather than throwing", async (t) => {
  const h = await makeHarness({ tapMode: null });
  t.after(h.cleanup);

  const started = await h.controller.start();
  assert.equal(started.systemAudioReady, false);
  assert.equal(started.systemAudioReason, "unsupported");
  await h.controller.stop();
});

test("level updates are emitted for the meters", async (t) => {
  const h = await makeHarness();
  t.after(h.cleanup);

  await h.controller.start();
  pushMic(h.controller, makeSpeech(2_000, 0.2, 47));
  await h.controller.stop();

  assert.ok(h.levels.you.length > 0, "mic levels drive the meter");
  assert.ok(Math.max(...h.levels.you) > 0.01, "a loud signal reads as loud");
});

test("starting twice is refused", async (t) => {
  const h = await makeHarness();
  t.after(h.cleanup);

  await h.controller.start();
  await assert.rejects(() => h.controller.start(), /already in progress/);
  await h.controller.stop();
});

test("stopping without starting is refused", async (t) => {
  const h = await makeHarness();
  t.after(h.cleanup);
  await assert.rejects(() => h.controller.stop(), /No recording is in progress/);
});

test("the note records how long the meeting ran", async (t) => {
  const h = await makeHarness();
  t.after(h.cleanup);

  const started = await h.controller.start();
  pushMic(h.controller, makeSpeech(3_000, 0.12, 48));
  await new Promise((r) => setTimeout(r, 30));
  await h.controller.stop();

  const note = h.repo.getNote(started.noteId);
  assert.ok(note);
  assert.ok(note.durationMs > 0, "duration was persisted");
});

test("consecutive recordings do not leak state into each other", async (t) => {
  const h = await makeHarness({ transcribeText: (n) => `call text ${n}` });
  t.after(h.cleanup);

  const first = await h.controller.start({ title: "First" });
  pushMic(h.controller, makeSpeech(5_000, 0.12, 49));
  pushMic(h.controller, makeSilence(3_000));
  await h.controller.stop();

  const second = await h.controller.start({ title: "Second" });
  pushMic(h.controller, makeSpeech(5_000, 0.12, 50));
  pushMic(h.controller, makeSilence(3_000));
  await h.controller.stop();

  assert.notEqual(first.noteId, second.noteId);
  const firstNote = h.repo.getNote(first.noteId);
  const secondNote = h.repo.getNote(second.noteId);

  assert.ok(firstNote && secondNote);
  // Timestamps restart from zero for each recording.
  assert.ok(secondNote.segments[0].startMs < 20_000, "the second recording starts its own clock");
  for (const segment of secondNote.segments) {
    assert.ok(
      !firstNote.segments.some((s) => s.id === segment.id && s.text === segment.text),
      "no segment is shared between recordings"
    );
  }
});
