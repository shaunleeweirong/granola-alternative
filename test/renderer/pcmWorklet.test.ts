import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PCM_WORKLET_SOURCE,
  WORKLET_CHUNK_SAMPLES,
  type CaptureMessage,
} from "../../src/renderer/audio/pcmWorklet.ts";
import { MIC_AUDIO_CONSTRAINTS, buildMicConstraints } from "../../src/renderer/audio/micConstraints.ts";
import { SAMPLE_RATE } from "../../src/core/audio/format.ts";

/**
 * The worklet runs in AudioWorkletGlobalScope, which node does not have. Its
 * source is plain ES2020, so it can be evaluated against a stand-in scope and
 * driven directly — which is the only way the downmix and cursor arithmetic get
 * tested at all.
 */
interface ProcessorHarness {
  process: (inputs: Float32Array[][]) => boolean;
  stop: () => void;
  messages: CaptureMessage[];
}

function loadWorklet(): ProcessorHarness {
  const messages: CaptureMessage[] = [];

  class FakeAudioWorkletProcessor {
    port: {
      postMessage: (message: CaptureMessage, transfer?: unknown[]) => void;
      onmessage: ((event: { data: unknown }) => void) | null;
    };

    constructor() {
      this.port = {
        postMessage: (message: CaptureMessage) => {
          // Copy out before the "transfer" detaches the buffer, as a real
          // structured-clone transfer would. ArrayBuffer.slice gives an exact
          // copy — Buffer.from(...).buffer would hand back node's shared 8 KB
          // pool rather than just these bytes.
          messages.push({
            pcm: message.pcm.slice(0),
            startSample: message.startSample,
          });
        },
        onmessage: null,
      };
    }
  }

  let registered: (new () => unknown) | null = null;
  const registerProcessor = (_name: string, ctor: new () => unknown): void => {
    registered = ctor;
  };

  // eslint-disable-next-line no-new-func
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", PCM_WORKLET_SOURCE)(
    FakeAudioWorkletProcessor,
    registerProcessor,
    SAMPLE_RATE
  );

  assert.ok(registered, "worklet source must register a processor");
  const instance = new (registered as new () => {
    process: (inputs: Float32Array[][]) => boolean;
    port: { onmessage: ((event: { data: unknown }) => void) | null };
  })();

  return {
    process: (inputs) => instance.process(inputs),
    stop: () => instance.port.onmessage?.({ data: "stop" }),
    messages,
  };
}

const readSamples = (message: CaptureMessage): Int16Array => new Int16Array(message.pcm);

test("emits a chunk once the buffer fills, and not before", () => {
  const worklet = loadWorklet();
  const quantum = new Float32Array(128).fill(0.5);

  // 320 samples per chunk; two 128-frame quanta is 256, still short.
  worklet.process([[quantum]]);
  worklet.process([[quantum]]);
  assert.equal(worklet.messages.length, 0, "no partial chunk is emitted");

  worklet.process([[quantum]]);
  assert.equal(worklet.messages.length, 1, "the chunk goes out once it is full");
  assert.equal(readSamples(worklet.messages[0]).length, WORKLET_CHUNK_SAMPLES);
});

test("averages every channel instead of taking only the first", () => {
  // Teardown finding 7b: the reference worklet read inputs[0][0] and discarded
  // the rest, so anything panned right was silently lost.
  const worklet = loadWorklet();
  const left = new Float32Array(WORKLET_CHUNK_SAMPLES).fill(0);
  const right = new Float32Array(WORKLET_CHUNK_SAMPLES).fill(0.8);

  worklet.process([[left, right]]);

  assert.equal(worklet.messages.length, 1);
  const samples = readSamples(worklet.messages[0]);
  const expected = Math.round(0.4 * 0x7fff);
  assert.ok(
    Math.abs(samples[0] - expected) <= 1,
    `right-channel-only audio must survive the downmix: got ${samples[0]}, expected ~${expected}`
  );
});

test("mono input passes through unchanged", () => {
  const worklet = loadWorklet();
  const mono = new Float32Array(WORKLET_CHUNK_SAMPLES).fill(0.25);
  worklet.process([[mono]]);

  const samples = readSamples(worklet.messages[0]);
  assert.ok(Math.abs(samples[0] - Math.round(0.25 * 0x7fff)) <= 1);
});

test("the sample cursor advances monotonically and never overlaps", () => {
  // FR-5: downstream timestamps are derived from this cursor, so a gap or a
  // repeat here becomes a misplaced transcript segment.
  const worklet = loadWorklet();
  const quantum = new Float32Array(128).fill(0.1);
  for (let i = 0; i < 40; i += 1) worklet.process([[quantum]]);

  assert.ok(worklet.messages.length >= 4, "expected several chunks");
  for (let i = 0; i < worklet.messages.length; i += 1) {
    assert.equal(
      worklet.messages[i].startSample,
      i * WORKLET_CHUNK_SAMPLES,
      "each chunk starts exactly where the previous one ended"
    );
  }
});

test("samples are clamped, so a hot signal cannot wrap to the opposite sign", () => {
  const worklet = loadWorklet();
  const hot = new Float32Array(WORKLET_CHUNK_SAMPLES).fill(2.5);
  worklet.process([[hot]]);

  const samples = readSamples(worklet.messages[0]);
  assert.equal(samples[0], 32767, "clipped to positive full scale, not wrapped");

  const cold = loadWorklet();
  cold.process([[new Float32Array(WORKLET_CHUNK_SAMPLES).fill(-2.5)]]);
  assert.equal(readSamples(cold.messages[0])[0], -32768);
});

test("stop flushes the partial buffer rather than discarding it", () => {
  const worklet = loadWorklet();
  worklet.process([[new Float32Array(100).fill(0.3)]]);
  assert.equal(worklet.messages.length, 0);

  worklet.stop();

  assert.equal(worklet.messages.length, 1, "the tail of the recording is not lost");
  const samples = readSamples(worklet.messages[0]);
  assert.equal(samples.length, 100);
  assert.equal(worklet.messages[0].startSample, 0);
});

test("an empty input quantum is tolerated without emitting anything", () => {
  const worklet = loadWorklet();
  assert.equal(worklet.process([[]]), true);
  assert.equal(worklet.process([]), true);
  assert.equal(worklet.messages.length, 0);
});

test("the processor stops after a stop message", () => {
  const worklet = loadWorklet();
  worklet.stop();
  assert.equal(worklet.process([[new Float32Array(128).fill(0.2)]]), false);
});

// -------------------------------------------------------- mic constraints

test("the microphone is opened WITH echo cancellation (FR-1)", () => {
  // This is the guard on the decision the whole design rests on. If someone
  // flips these to false, every bug in the teardown comes back.
  assert.equal(MIC_AUDIO_CONSTRAINTS.echoCancellation, true);
  assert.equal(MIC_AUDIO_CONSTRAINTS.noiseSuppression, true);
  assert.equal(MIC_AUDIO_CONSTRAINTS.autoGainControl, true);
});

test("mic constraints request the canonical capture format", () => {
  assert.equal(MIC_AUDIO_CONSTRAINTS.sampleRate, 16000);
  assert.equal(MIC_AUDIO_CONSTRAINTS.channelCount, 1);
});

test("a pinned device keeps the processing constraints", () => {
  const constraints = buildMicConstraints("device-123") as {
    audio: Record<string, unknown> & { deviceId: { exact: string } };
  };
  assert.equal(constraints.audio.deviceId.exact, "device-123");
  assert.equal(constraints.audio.echoCancellation, true, "pinning a device must not drop AEC");
});

test("with no device pinned the default input is used", () => {
  const constraints = buildMicConstraints() as { audio: Record<string, unknown> };
  assert.equal(constraints.audio.deviceId, undefined);
  assert.equal(constraints.audio.echoCancellation, true);
});
