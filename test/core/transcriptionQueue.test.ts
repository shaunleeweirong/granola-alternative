import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TranscriptionQueue,
  type TranscriptionJob,
  type TranscriptionOutcome,
} from "../../src/core/queue/transcriptionQueue.ts";
import type { TranscriptionWindow } from "../../src/core/audio/vadSegmenter.ts";
import type { Channel } from "../../src/core/transcript/types.ts";

const makeWindow = (startMs: number, endMs: number): TranscriptionWindow => ({
  startSample: (startMs / 1000) * 16000,
  endSample: (endMs / 1000) * 16000,
  startMs,
  endMs,
  pcm: Buffer.alloc(16),
  overlapMs: 0,
});

const job = (id: string, channel: Channel, startMs: number): TranscriptionJob => ({
  id,
  channel,
  window: makeWindow(startMs, startMs + 1000),
});

test("drains a backlog oldest-audio-first regardless of enqueue order", async () => {
  const order: string[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const queue = new TranscriptionQueue(async (j) => {
    order.push(j.id);
    if (j.id === "warmup") await gate;
    return j.id;
  });

  // Hold the worker so a real backlog forms. A job already in flight cannot be
  // un-started, so ordering only ever applies to jobs waiting together.
  queue.enqueue(job("warmup", "you", 0));

  // Both channels now feed the queue out of audio order.
  queue.enqueue(job("them-30", "them", 30_000));
  queue.enqueue(job("you-10", "you", 10_000));
  queue.enqueue(job("them-20", "them", 20_000));
  assert.equal(queue.depth, 3);

  release();
  await queue.drain();

  assert.deepEqual(order, ["warmup", "you-10", "them-20", "them-30"]);
});

test("runs strictly one at a time", async () => {
  let concurrent = 0;
  let peak = 0;
  const queue = new TranscriptionQueue(async (j) => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent -= 1;
    return j.id;
  });

  for (let i = 0; i < 6; i += 1) queue.enqueue(job(`j${i}`, "you", i * 1000));
  await queue.drain();

  assert.equal(peak, 1, "local ASR must never be oversubscribed");
});

test("a failing window does not stall the queue", async () => {
  const completed: string[] = [];
  const failures: string[] = [];
  const queue = new TranscriptionQueue(
    async (j) => {
      if (j.id === "bad") throw new Error("model crashed");
      return j.id;
    },
    {
      onResult: (o: TranscriptionOutcome) => {
        completed.push(o.job.id);
      },
      onError: (j, err) => {
        failures.push(`${j.id}:${err.message}`);
      },
    }
  );

  queue.enqueue(job("first", "you", 0));
  queue.enqueue(job("bad", "you", 1_000));
  queue.enqueue(job("third", "you", 2_000));
  await queue.drain();

  assert.deepEqual(completed, ["first", "third"]);
  assert.deepEqual(failures, ["bad:model crashed"]);
});

test("jobs enqueued while the worker is busy are picked up", async () => {
  const seen: string[] = [];
  const queue = new TranscriptionQueue(async (j) => {
    seen.push(j.id);
    if (j.id === "a") queue.enqueue(job("b", "them", 5_000));
    await new Promise((r) => setTimeout(r, 1));
    return j.id;
  });

  queue.enqueue(job("a", "you", 0));
  await queue.drain();

  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(queue.depth, 0);
});

test("drain resolves immediately on an idle queue", async () => {
  const queue = new TranscriptionQueue(async () => "");
  await queue.drain();
  assert.equal(queue.depth, 0);
  assert.equal(queue.isRunning, false);
});

test("depth reflects the backlog", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const queue = new TranscriptionQueue(async (j) => {
    await gate;
    return j.id;
  });

  for (let i = 0; i < 4; i += 1) queue.enqueue(job(`j${i}`, "you", i * 1000));
  assert.equal(queue.depth, 3, "one in flight, three pending");

  release();
  await queue.drain();
  assert.equal(queue.depth, 0);
});

test("stop clears pending work and refuses new jobs", async () => {
  const seen: string[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const queue = new TranscriptionQueue(async (j) => {
    seen.push(j.id);
    await gate;
    return j.id;
  });

  queue.enqueue(job("inflight", "you", 0));
  queue.enqueue(job("dropped", "you", 1_000));
  queue.stop();
  queue.enqueue(job("rejected", "you", 2_000));

  release();
  await queue.drain();

  assert.deepEqual(seen, ["inflight"], "in-flight work completes, the rest is discarded");
});
