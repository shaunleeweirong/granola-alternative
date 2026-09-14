/**
 * Canonical audio format for the whole application.
 *
 * FR-3: 16 kHz mono 16-bit PCM, end to end. Both capture sources emit exactly
 * this, and whisper.cpp / Parakeet both consume exactly this, so the codebase
 * contains no resampling step at all. The reference implementation captured at
 * 24 kHz and downsampled with unfiltered linear interpolation, folding 8-12 kHz
 * content back into the sibilance band (teardown finding 7a). The fix is not a
 * better resampler; it is not needing one.
 */
export const SAMPLE_RATE = 16000;
export const CHANNEL_COUNT = 1;
export const BYTES_PER_SAMPLE = 2;

/** 30 ms — the VAD frame size. 480 samples at 16 kHz. */
export const FRAME_SAMPLES = 480;

export const samplesToMs = (samples: number): number => (samples / SAMPLE_RATE) * 1000;
export const msToSamples = (ms: number): number => Math.round((ms / 1000) * SAMPLE_RATE);
export const bytesToSamples = (bytes: number): number => Math.floor(bytes / BYTES_PER_SAMPLE);
export const samplesToBytes = (samples: number): number => samples * BYTES_PER_SAMPLE;
export const bytesToMs = (bytes: number): number => samplesToMs(bytesToSamples(bytes));

/**
 * Read a PCM16 buffer as floats in [-1, 1).
 *
 * Tolerates an odd byteOffset (an Int16Array view would throw) because buffers
 * sliced out of a child process's stdout are not guaranteed to be aligned.
 */
export function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const sampleCount = pcm.length >> 1;
  const out = new Float32Array(sampleCount);
  if ((pcm.byteOffset & 1) === 0) {
    const view = new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
    for (let i = 0; i < sampleCount; i += 1) out[i] = view[i] / 32768;
  } else {
    for (let i = 0; i < sampleCount; i += 1) out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

export function float32ToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), i * 2);
  }
  return out;
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / samples.length);
}

export function computePcm16Rms(pcm: Buffer): number {
  return computeRms(pcm16ToFloat32(pcm));
}

/**
 * FR-4: average every channel present rather than reading channel 0.
 *
 * The reference worklet took `inputs[0][0]` and discarded the rest, so anything
 * panned right was lost on any stereo source (teardown finding 7b).
 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];

  const frames = channels[0].length;
  const out = new Float32Array(frames);
  for (let c = 0; c < channels.length; c += 1) {
    const channel = channels[c];
    for (let i = 0; i < frames; i += 1) out[i] += channel[i];
  }
  for (let i = 0; i < frames; i += 1) out[i] /= channels.length;
  return out;
}

/** Wrap raw PCM16 in a WAV container. whisper.cpp's HTTP server wants a file. */
export function pcm16ToWav(pcm: Buffer, sampleRate = SAMPLE_RATE, channels = CHANNEL_COUNT): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
