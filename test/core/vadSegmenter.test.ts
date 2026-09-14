import { test } from "node:test";
import assert from "node:assert/strict";

import { VadSegmenter, type TranscriptionWindow } from "../../src/core/audio/vadSegmenter.ts";
import { SAMPLE_RATE, bytesToMs, samplesToMs } from "../../src/core/audio/format.ts";
import { chunk, makeQuietSpeech, makeSilence, makeSpeech } from "../harness/pcmFixtures.ts";

const feed = (seg: VadSegmenter, pcm: Buffer, chunkMs = 100): TranscriptionWindow[] => {
  const out: TranscriptionWindow[] = [];
  for (const c of chunk(pcm, chunkMs)) out.push(...seg.push(c));
  return out;
};

const totalAudioMs = (windows: TranscriptionWindow[]): number =>
  windows.reduce((sum, w) => sum + bytesToMs(w.pcm.length), 0);

test("pure silence never produces a window", () => {
  const seg = new VadSegmenter();
  const windows = feed(seg, makeSilence(40_000));
  assert.equal(windows.length, 0);
  assert.deepEqual(seg.flush(), []);
});

test("a short utterance is emitted after the idle flush, not held forever", () => {
  const seg = new VadSegmenter({ idleFlushMs: 2_000 });
  const windows = [
    ...feed(seg, makeSilence(500)),
    ...feed(seg, makeSpeech(1_500)),
    ...feed(seg, makeSilence(4_000)),
  ];

  assert.equal(windows.length, 1, "one window for one utterance");
  const w = windows[0];
  // The window must span the speech, plus padding, and not the whole silence.
  assert.ok(w.endMs - w.startMs >= 1_500, `window covers the utterance (got ${w.endMs - w.startMs}ms)`);
  assert.ok(w.endMs - w.startMs < 3_500, `window is not padded out to the full idle wait`);
});

test("a long monologue is cut into 15-30s windows at silence boundaries", () => {
  const seg = new VadSegmenter();
  // Six ~10 s utterances separated by 600 ms pauses: 60 s of speech.
  const parts: Buffer[] = [];
  for (let i = 0; i < 6; i += 1) {
    parts.push(makeSpeech(10_000, 0.12, 100 + i));
    parts.push(makeSilence(600, 0.0004, 200 + i));
  }
  const windows = feed(seg, Buffer.concat(parts));
  windows.push(...seg.flush());

  assert.ok(windows.length >= 2, `expected several windows, got ${windows.length}`);
  for (const w of windows) {
    const durationMs = w.endMs - w.startMs;
    assert.ok(durationMs <= 30_000 + 50, `window ${durationMs}ms exceeds the 30s ceiling`);
  }
  // Windows must tile the stream forward in time with no gaps beyond the pauses.
  for (let i = 1; i < windows.length; i += 1) {
    assert.ok(
      windows[i].startSample <= windows[i - 1].endSample,
      "each window starts at or before the previous window ended (overlap, never a gap)"
    );
  }
});

test("consecutive windows overlap by ~1s so a boundary cannot lose a word", () => {
  const seg = new VadSegmenter({ overlapMs: 1_000 });
  const parts: Buffer[] = [];
  for (let i = 0; i < 5; i += 1) {
    parts.push(makeSpeech(9_000, 0.12, 300 + i));
    parts.push(makeSilence(500, 0.0004, 400 + i));
  }
  const windows = feed(seg, Buffer.concat(parts));

  assert.ok(windows.length >= 2, "need at least two windows to have an overlap");
  for (let i = 1; i < windows.length; i += 1) {
    const overlapSamples = windows[i - 1].endSample - windows[i].startSample;
    assert.ok(overlapSamples > 0, `window ${i} must overlap its predecessor`);
    assert.ok(
      Math.abs(samplesToMs(overlapSamples) - 1_000) < 60,
      `overlap should be ~1000ms, got ${samplesToMs(overlapSamples)}ms`
    );
    assert.equal(
      Math.round(windows[i].overlapMs),
      Math.round(samplesToMs(overlapSamples)),
      "reported overlapMs must match the real overlap"
    );
  }
});

test("the retained overlap is never re-emitted as its own window", () => {
  // Regression: after a cut, the ~1s of retained audio still contains speech.
  // A naive "does this window contain speech" check re-transcribes it forever.
  const seg = new VadSegmenter({ idleFlushMs: 1_500, minWindowMs: 2_000, maxWindowMs: 6_000 });
  const windows = [
    ...feed(seg, makeSpeech(3_000)),
    ...feed(seg, makeSilence(20_000)),
  ];
  windows.push(...seg.flush());

  assert.equal(windows.length, 1, `20s of trailing silence must not spawn extra windows`);
});

test("a quiet talker is segmented identically to a loud one", () => {
  // This is teardown finding 1 and 3 as a test. The reference implementation
  // used absolute RMS thresholds with AGC off, so a quiet mic fell permanently
  // below the floor and its speech was dropped.
  const loud = new VadSegmenter({ idleFlushMs: 2_000 });
  const quiet = new VadSegmenter({ idleFlushMs: 2_000 });

  const loudWindows = [
    ...feed(loud, makeSilence(400)),
    ...feed(loud, makeSpeech(4_000, 0.25, 31)),
    ...feed(loud, makeSilence(3_000)),
  ];
  const quietWindows = [
    ...feed(quiet, makeSilence(400)),
    ...feed(quiet, makeQuietSpeech(4_000, 31)),
    ...feed(quiet, makeSilence(3_000)),
  ];

  assert.equal(quietWindows.length, loudWindows.length, "quiet speech yields the same window count");
  assert.ok(quietWindows.length > 0, "quiet speech is not dropped");
  const quietMs = quietWindows[0].endMs - quietWindows[0].startMs;
  const loudMs = loudWindows[0].endMs - loudWindows[0].startMs;
  assert.ok(Math.abs(quietMs - loudMs) < 400, `durations comparable: ${quietMs} vs ${loudMs}`);
});

test("emitted audio is verbatim — no sample is ever zeroed or dropped mid-window", () => {
  // Teardown findings 1 and 2: the reference gate replaced sub-threshold 33ms
  // chunks with silence, perforating real speech. Nothing here may do that.
  const seg = new VadSegmenter({ idleFlushMs: 1_500 });
  const speech = makeSpeech(5_000, 0.12, 77);
  const windows = [...feed(seg, speech), ...feed(seg, makeSilence(3_000))];

  assert.ok(windows.length >= 1);
  const w = windows[0];
  // The window's payload must be a contiguous slice of what we pushed.
  const pushed = Buffer.concat([speech, makeSilence(3_000)]);
  const startByte = w.startSample * 2;
  const expected = pushed.subarray(startByte, startByte + w.pcm.length);
  assert.ok(w.pcm.equals(expected), "window PCM is a verbatim slice of the input stream");
});

test("timestamps come from the sample cursor, not wall clock", () => {
  const seg = new VadSegmenter({ idleFlushMs: 1_500 });
  feed(seg, makeSilence(10_000));
  const windows = [...feed(seg, makeSpeech(2_000)), ...feed(seg, makeSilence(3_000))];

  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.startMs, samplesToMs(w.startSample));
  assert.equal(w.endMs, samplesToMs(w.endSample));
  // 10 s of leading silence must be reflected in the offset.
  assert.ok(w.startMs > 8_000, `speech after 10s of silence starts late, got ${w.startMs}ms`);
});

test("the retained buffer stays bounded across a long stream", () => {
  const seg = new VadSegmenter();
  for (let i = 0; i < 30; i += 1) {
    feed(seg, makeSpeech(4_000, 0.12, 500 + i));
    feed(seg, makeSilence(1_000, 0.0004, 600 + i));
  }
  // Ceiling is maxWindow (30 s) plus a little slack, never the whole 150 s.
  const bufferedMs = bytesToMs(seg.bufferedBytes);
  assert.ok(bufferedMs <= 31_000, `buffer held ${bufferedMs}ms, expected <= 31s`);
});

test("total emitted audio covers the speech without runaway duplication", () => {
  const seg = new VadSegmenter();
  const parts: Buffer[] = [];
  for (let i = 0; i < 4; i += 1) {
    parts.push(makeSpeech(8_000, 0.12, 700 + i));
    parts.push(makeSilence(800, 0.0004, 800 + i));
  }
  const source = Buffer.concat(parts);
  const windows = feed(seg, source);
  windows.push(...seg.flush());

  const emitted = totalAudioMs(windows);
  const sourceMs = bytesToMs(source.length);
  assert.ok(emitted >= 30_000, `must cover the bulk of ${sourceMs}ms of speech, emitted ${emitted}ms`);
  assert.ok(emitted <= sourceMs * 1.25, `overlap should add ~5%, not double it (${emitted}/${sourceMs})`);
});

test("sample rate assumptions hold", () => {
  assert.equal(SAMPLE_RATE, 16000);
});
