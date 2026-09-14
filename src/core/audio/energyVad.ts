import { FRAME_SAMPLES, computeRms } from "./format.ts";

/**
 * Voice activity detection over 30 ms frames.
 *
 * This is a speech/no-speech classifier used to choose *where to cut* a
 * transcription window. It is emphatically NOT the energy gate from the
 * teardown: nothing here ever discards, mutes, or zeroes audio inside a window,
 * and its decision never depends on what the other channel is doing. Frames it
 * calls silence are still transcribed when they sit between two speech frames.
 *
 * The threshold adapts to a rolling noise floor rather than being an absolute
 * constant, so it behaves the same on a hot desktop mic and a quiet laptop one.
 */
export interface VadFrame {
  /** Latched speech state, with onset and hangover applied. Answers
   *  "are we inside an utterance", bridging unvoiced consonants. */
  speech: boolean;
  /** Raw per-frame energy decision, with no hangover. Answers "is there sound
   *  right now", which is what a silence *boundary* must be measured from —
   *  measuring it from `speech` would hide every pause shorter than the
   *  hangover, and natural inter-sentence pauses are often 300-600 ms. */
  loud: boolean;
  rms: number;
}

export interface VadDetector {
  /** Classify one frame. Frame must be FRAME_SAMPLES long. */
  analyze(frame: Float32Array): VadFrame;
  reset(): void;
}

export interface EnergyVadOptions {
  /** Absolute RMS below which a frame is always silence. Guards a zeroed stream. */
  absoluteFloor?: number;
  /** A frame counts as loud when its RMS exceeds noiseFloor * this. */
  snrRatio?: number;
  /** Loud frames required before the detector latches on. Rejects clicks. */
  onsetFrames?: number;
  /** Quiet frames tolerated before the detector latches off. Bridges stop consonants. */
  hangoverFrames?: number;
  /** EMA weight for the noise floor when idle. Lower adapts more slowly. */
  noiseAdaptation?: number;
}

const DEFAULTS = {
  absoluteFloor: 0.0008,
  snrRatio: 2.5,
  onsetFrames: 2,
  hangoverFrames: 10,
  noiseAdaptation: 0.02,
};

export class EnergyVad implements VadDetector {
  private readonly opts: Required<EnergyVadOptions>;
  private noiseFloor: number;
  private consecutiveLoud: number;
  private consecutiveQuiet: number;
  private latched: boolean;

  constructor(options: EnergyVadOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.noiseFloor = this.opts.absoluteFloor;
    this.consecutiveLoud = 0;
    this.consecutiveQuiet = 0;
    this.latched = false;
  }

  reset(): void {
    this.noiseFloor = this.opts.absoluteFloor;
    this.consecutiveLoud = 0;
    this.consecutiveQuiet = 0;
    this.latched = false;
  }

  analyze(frame: Float32Array): VadFrame {
    const rms = computeRms(frame);
    const threshold = Math.max(this.opts.absoluteFloor, this.noiseFloor * this.opts.snrRatio);
    const loud = rms > threshold;

    if (loud) {
      this.consecutiveLoud += 1;
      this.consecutiveQuiet = 0;
    } else {
      this.consecutiveQuiet += 1;
      this.consecutiveLoud = 0;
      // Only adapt the floor while confidently idle, so a slow talker's pauses
      // don't drag the threshold up over their own voice.
      if (!this.latched) {
        this.noiseFloor =
          this.noiseFloor * (1 - this.opts.noiseAdaptation) + rms * this.opts.noiseAdaptation;
      }
    }

    if (!this.latched && this.consecutiveLoud >= this.opts.onsetFrames) {
      this.latched = true;
    } else if (this.latched && this.consecutiveQuiet >= this.opts.hangoverFrames) {
      this.latched = false;
    }

    return { speech: this.latched, loud, rms };
  }
}

/** Split a sample array into whole FRAME_SAMPLES frames, discarding any remainder. */
export function* frames(samples: Float32Array): Generator<Float32Array> {
  const count = Math.floor(samples.length / FRAME_SAMPLES);
  for (let i = 0; i < count; i += 1) {
    yield samples.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES);
  }
}
