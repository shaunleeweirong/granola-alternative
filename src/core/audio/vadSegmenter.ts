import {
  BYTES_PER_SAMPLE,
  FRAME_SAMPLES,
  msToSamples,
  pcm16ToFloat32,
  samplesToBytes,
  samplesToMs,
} from "./format.ts";
import { EnergyVad, type VadDetector } from "./energyVad.ts";

/**
 * Turns a continuous PCM stream into transcription windows cut at silence.
 *
 * FR-9 / FR-10 / FR-11. The reference implementation accumulated a fixed five
 * seconds on a wall-clock timer and sent whatever it had, which severs a word
 * mid-syllable every five seconds and denies Whisper the long context window it
 * was trained on (teardown finding 5a). Here a window is 15-30 s, is cut only
 * where the VAD reports silence, and carries ~1 s of overlap into the next
 * window so a boundary can never lose a word.
 *
 * Nothing is discarded except audio that contains no speech at all.
 */
export interface TranscriptionWindow {
  /** Absolute sample offset from the start of the stream. */
  startSample: number;
  endSample: number;
  /** Milliseconds from the start of the stream. This is the only timestamp the
   *  transcript ever uses (FR-18) — never the wall-clock time transcription finished. */
  startMs: number;
  endMs: number;
  pcm: Buffer;
  /** How much of this window's head repeats the previous window (FR-17). */
  overlapMs: number;
}

export interface VadSegmenterOptions {
  minWindowMs?: number;
  maxWindowMs?: number;
  /** Silence needed before a cut is considered safe. */
  silenceBoundaryMs?: number;
  /** Emit a short window if speech has stopped for this long (FR-11). */
  idleFlushMs?: number;
  /** Overlap carried into the next window (FR-10). */
  overlapMs?: number;
  /** Keep this much audio after the last speech frame so a tail is never clipped. */
  speechPadMs?: number;
  /** Windows shorter than this cannot hold a real utterance; not worth an ASR call. */
  minEmitMs?: number;
  vad?: VadDetector;
}

const DEFAULTS = {
  minWindowMs: 15_000,
  maxWindowMs: 30_000,
  silenceBoundaryMs: 400,
  idleFlushMs: 8_000,
  overlapMs: 1_000,
  speechPadMs: 200,
  minEmitMs: 300,
};

export class VadSegmenter {
  private readonly vad: VadDetector;
  private readonly minWindow: number;
  private readonly maxWindow: number;
  private readonly silenceBoundary: number;
  private readonly idleFlush: number;
  private readonly overlap: number;
  private readonly speechPad: number;
  private readonly minEmit: number;

  /** Audio retained from `pendingStartSample` onward. */
  private pending: Buffer = Buffer.alloc(0);
  private pendingStartSample = 0;
  /** Total samples ever pushed. */
  private cursorSample = 0;
  /** Samples classified by the VAD so far. */
  private analyzedSample = 0;
  private windowStartSample = 0;
  /** End of the last frame the VAD latched as speech. Decides whether a window
   *  holds an utterance at all. */
  private lastSpeechEndSample: number | null = null;
  /** End of the last frame with actual energy, with no hangover applied. Silence
   *  boundaries are measured from here — measuring from the latched state would
   *  swallow every pause shorter than the hangover. */
  private lastLoudEndSample: number | null = null;
  /** End of the most recently emitted window. Audio at or before this has been
   *  transcribed already, so speech there must never produce a second window. */
  private lastEmittedSample = 0;
  /** How much of the current window's head repeats the previous window. */
  private headOverlapSamples = 0;

  constructor(options: VadSegmenterOptions = {}) {
    const opts = { ...DEFAULTS, ...options };
    this.vad = options.vad ?? new EnergyVad();
    this.minWindow = msToSamples(opts.minWindowMs);
    this.maxWindow = msToSamples(opts.maxWindowMs);
    this.silenceBoundary = msToSamples(opts.silenceBoundaryMs);
    this.idleFlush = msToSamples(opts.idleFlushMs);
    this.overlap = msToSamples(opts.overlapMs);
    this.speechPad = msToSamples(opts.speechPadMs);
    this.minEmit = msToSamples(opts.minEmitMs);
  }

  /** Feed PCM16. Returns any windows that became ready. */
  push(pcm: Buffer): TranscriptionWindow[] {
    if (pcm.length === 0) return [];

    this.pending = this.pending.length === 0 ? Buffer.from(pcm) : Buffer.concat([this.pending, pcm]);
    this.cursorSample += Math.floor(pcm.length / BYTES_PER_SAMPLE);

    const ready: TranscriptionWindow[] = [];

    while (this.analyzedSample + FRAME_SAMPLES <= this.cursorSample) {
      const offsetBytes = samplesToBytes(this.analyzedSample - this.pendingStartSample);
      const frameBytes = samplesToBytes(FRAME_SAMPLES);
      const frame = pcm16ToFloat32(this.pending.subarray(offsetBytes, offsetBytes + frameBytes));

      const verdict = this.vad.analyze(frame);
      this.analyzedSample += FRAME_SAMPLES;
      if (verdict.speech) this.lastSpeechEndSample = this.analyzedSample;
      if (verdict.loud) this.lastLoudEndSample = this.analyzedSample;

      const window = this.considerCut();
      if (window) ready.push(window);
    }

    return ready;
  }

  /** End of stream: emit whatever remains if it holds untranscribed speech. */
  flush(): TranscriptionWindow[] {
    const window = this.hasUntranscribedSpeech() ? this.cut(this.cursorSample, true) : null;
    this.reset();
    return window ? [window] : [];
  }

  /**
   * A window is only worth emitting if it contains speech newer than the last
   * one we emitted. Without this, the ~1 s overlap retained after a cut would
   * itself look like "a window containing speech" and be transcribed twice.
   */
  private hasUntranscribedSpeech(): boolean {
    return this.lastSpeechEndSample !== null && this.lastSpeechEndSample > this.lastEmittedSample;
  }

  private considerCut(): TranscriptionWindow | null {
    const windowSamples = this.analyzedSample - this.windowStartSample;

    if (!this.hasUntranscribedSpeech()) {
      // Nothing new to say. Slide the window forward so the buffer stays
      // bounded, retaining one overlap's worth in case a word starts now.
      if (windowSamples > this.idleFlush) {
        this.advanceWindowTo(Math.max(this.lastEmittedSample, this.analyzedSample - this.overlap));
      }
      return null;
    }

    const silenceSamples =
      this.lastLoudEndSample === null ? 0 : this.analyzedSample - this.lastLoudEndSample;

    if (windowSamples >= this.maxWindow) {
      // Hard ceiling: cut even mid-speech rather than grow without bound. The
      // overlap means the severed word still reaches the next window intact.
      return this.cut(this.analyzedSample);
    }

    const atSafeBoundary = silenceSamples >= this.silenceBoundary;
    if (windowSamples >= this.minWindow && atSafeBoundary) {
      return this.cut(this.paddedCutPoint());
    }

    if (silenceSamples >= this.idleFlush) {
      return this.cut(this.paddedCutPoint());
    }

    return null;
  }

  /**
   * Cut just after the last speech, so a trailing consonant is never clipped.
   *
   * The cut must also cover `lastSpeechEndSample`, the latched tail. The latch
   * runs on past the last loud frame by the hangover, so a cut placed only from
   * loudness would leave latched speech *after* the emitted window — which
   * `hasUntranscribedSpeech` then reads as new speech, re-emitting the same
   * slice on every frame forever.
   */
  private paddedCutPoint(): number {
    if (this.lastLoudEndSample === null) return this.analyzedSample;
    const fromLoudness = this.lastLoudEndSample + this.speechPad;
    const latchedTail = this.lastSpeechEndSample ?? 0;
    return Math.min(Math.max(fromLoudness, latchedTail), this.analyzedSample);
  }

  private cut(cutSample: number, final = false): TranscriptionWindow | null {
    const startSample = this.windowStartSample;
    const endSample = Math.max(cutSample, startSample);

    if (endSample - startSample < this.minEmit) {
      // Below the VAD's own onset+hangover floor, so this cannot be an
      // utterance. Skip it rather than spend a transcription call on a click.
      this.lastEmittedSample = Math.max(this.lastEmittedSample, endSample);
      if (!final) this.advanceWindowTo(endSample);
      return null;
    }

    const from = samplesToBytes(startSample - this.pendingStartSample);
    const to = samplesToBytes(endSample - this.pendingStartSample);

    const window: TranscriptionWindow = {
      startSample,
      endSample,
      startMs: samplesToMs(startSample),
      endMs: samplesToMs(endSample),
      pcm: Buffer.from(this.pending.subarray(from, to)),
      overlapMs: samplesToMs(this.headOverlapSamples),
    };

    this.lastEmittedSample = endSample;

    if (!final) {
      const nextStart = Math.max(startSample, endSample - this.overlap);
      this.advanceWindowTo(nextStart);
      this.headOverlapSamples = endSample - nextStart;
    }

    return window;
  }

  private advanceWindowTo(sample: number): void {
    if (sample <= this.windowStartSample) return;
    this.windowStartSample = sample;
    this.headOverlapSamples = 0;
    this.trimPending();
  }

  private trimPending(): void {
    const drop = samplesToBytes(this.windowStartSample - this.pendingStartSample);
    if (drop <= 0) return;
    this.pending = Buffer.from(this.pending.subarray(drop));
    this.pendingStartSample = this.windowStartSample;
  }

  private reset(): void {
    this.pending = Buffer.alloc(0);
    this.pendingStartSample = this.cursorSample;
    this.windowStartSample = this.cursorSample;
    this.analyzedSample = this.cursorSample;
    this.lastEmittedSample = this.cursorSample;
    this.lastSpeechEndSample = null;
    this.lastLoudEndSample = null;
    this.headOverlapSamples = 0;
    this.vad.reset();
  }

  /** Bytes currently retained. Exposed so tests can assert the buffer stays bounded. */
  get bufferedBytes(): number {
    return this.pending.length;
  }
}
