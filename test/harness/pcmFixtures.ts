import { SAMPLE_RATE, float32ToPcm16, msToSamples } from "../../src/core/audio/format.ts";

/** Deterministic PRNG so every fixture is byte-identical across runs. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/**
 * Room-tone floor. Not digital silence — a real capture always has some noise,
 * and a VAD that only works against absolute zero is not a VAD.
 */
export function makeSilence(ms: number, amplitude = 0.0004, seed = 7): Buffer {
  const rand = seededRandom(seed);
  const samples = new Float32Array(msToSamples(ms));
  for (let i = 0; i < samples.length; i += 1) samples[i] = (rand() * 2 - 1) * amplitude;
  return float32ToPcm16(samples);
}

/**
 * Speech-like signal: a voiced fundamental plus harmonics, amplitude-modulated
 * at a syllable rate so it has the internal low-energy dips that broke the
 * reference implementation's per-chunk energy gate.
 */
export function makeSpeech(ms: number, amplitude = 0.12, seed = 11, fundamental = 130): Buffer {
  const rand = seededRandom(seed);
  const samples = new Float32Array(msToSamples(ms));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / SAMPLE_RATE;
    // ~4 Hz syllable envelope, never quite reaching zero.
    const envelope = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 4 * t));
    const voiced =
      Math.sin(2 * Math.PI * fundamental * t) +
      0.5 * Math.sin(2 * Math.PI * fundamental * 2 * t) +
      0.25 * Math.sin(2 * Math.PI * fundamental * 3 * t);
    const breath = (rand() * 2 - 1) * 0.08;
    samples[i] = (voiced / 1.75 + breath) * envelope * amplitude;
  }
  return float32ToPcm16(samples);
}

/** A quiet talker: the case an absolute RMS threshold silently deletes. */
export function makeQuietSpeech(ms: number, seed = 23): Buffer {
  return makeSpeech(ms, 0.012, seed);
}

/** Split a buffer into fixed-size chunks, mimicking a live capture stream. */
export function chunk(pcm: Buffer, chunkMs = 100): Buffer[] {
  const size = msToSamples(chunkMs) * 2;
  const out: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += size) {
    out.push(pcm.subarray(offset, Math.min(offset + size, pcm.length)));
  }
  return out;
}

/** Count runs of exactly-zero samples — the signature of an energy gate that
 *  replaced audio with silence (teardown findings 1 and 2). */
export function longestZeroRun(pcm: Buffer): number {
  let longest = 0;
  let current = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (pcm.readInt16LE(i) === 0) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}
