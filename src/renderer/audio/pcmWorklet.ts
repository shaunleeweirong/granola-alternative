import { CHANNEL_COUNT, SAMPLE_RATE } from "../../core/audio/format.ts";

/** Samples per message. 320 at 16 kHz is 20 ms. */
export const WORKLET_CHUNK_SAMPLES = 320;

/**
 * Source for the capture AudioWorklet, loaded as a Blob URL.
 *
 * It runs in AudioWorkletGlobalScope, which cannot import modules, so the small
 * amount of logic it needs is inlined. Two details matter and both are
 * teardown fixes:
 *
 *   * Every input channel is averaged, not just `inputs[0][0]` (FR-4). The
 *     reference worklet read channel 0 only, so anything panned right was lost.
 *   * The chunk carries a running sample cursor (FR-5). Downstream timestamps
 *     come from that cursor, never from the time the message was received, so
 *     the two channels share one timeline and the transcript can be a sort.
 */
export const PCM_WORKLET_SOURCE = `
const CHUNK = ${WORKLET_CHUNK_SAMPLES};

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(CHUNK);
    this._offset = 0;
    this._cursor = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this._flush();
        this._stopped = true;
      }
    };
  }

  _flush() {
    if (this._offset === 0) return;
    const slice = this._buffer.slice(0, this._offset);
    this.port.postMessage(
      { pcm: slice.buffer, startSample: this._cursor - this._offset },
      [slice.buffer]
    );
    this._offset = 0;
  }

  process(inputs) {
    if (this._stopped) return false;

    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;

    const frames = channels[0].length;
    const channelCount = channels.length;

    for (let i = 0; i < frames; i += 1) {
      // Average every channel present rather than taking the first.
      let sum = 0;
      for (let c = 0; c < channelCount; c += 1) sum += channels[c][i];
      const sample = Math.max(-1, Math.min(1, sum / channelCount));

      this._buffer[this._offset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this._offset += 1;
      this._cursor += 1;

      if (this._offset >= CHUNK) {
        const full = this._buffer;
        this.port.postMessage(
          { pcm: full.buffer, startSample: this._cursor - CHUNK },
          [full.buffer]
        );
        this._buffer = new Int16Array(CHUNK);
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
`;

export interface CaptureMessage {
  pcm: ArrayBuffer;
  startSample: number;
}

export interface CapturePipeline {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: AudioWorkletNode;
  stop: () => Promise<void>;
}

let workletUrl: string | null = null;

function getWorkletUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" }));
  }
  return workletUrl;
}

/**
 * Build a capture graph for one MediaStream.
 *
 * The AudioContext is opened at the canonical rate so the browser does the
 * resampling in its own high-quality path and this codebase never resamples.
 */
export async function createCapturePipeline(
  stream: MediaStream,
  onChunk: (message: CaptureMessage) => void
): Promise<CapturePipeline> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (context.state === "suspended") await context.resume();

  await context.audioWorklet.addModule(getWorkletUrl());

  const source = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(context, "capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: CHANNEL_COUNT,
  });

  processor.port.onmessage = (event: MessageEvent<CaptureMessage>) => {
    if (event.data?.pcm) onChunk(event.data);
  };

  // Chrome's renderer is pull-based: a worklet only runs if its output reaches
  // the destination. Route through a silent gain so nothing is audible.
  const silence = context.createGain();
  silence.gain.value = 0;
  source.connect(processor);
  processor.connect(silence);
  silence.connect(context.destination);

  const stop = async (): Promise<void> => {
    try {
      processor.port.postMessage("stop");
      // Give the worklet a render quantum to flush its partial buffer.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      // Already torn down.
    }
    processor.port.onmessage = null;
    source.disconnect();
    processor.disconnect();
    silence.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
  };

  return { context, source, processor, stop };
}
