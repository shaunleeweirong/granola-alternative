import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { AudioTapHost, TapStartError, type TapEvent } from "../../src/main/audioTapHost.ts";

const FAKE_TAP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "harness",
  "fakeTap.mjs"
);

const makeHost = (mode: string, extra: string[] = [], startTimeoutMs = 3_000): AudioTapHost =>
  new AudioTapHost({
    command: process.execPath,
    args: [FAKE_TAP, "--mode", mode, ...extra],
    startTimeoutMs,
  });

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("starts, streams PCM, and stops cleanly", async (t) => {
  const host = makeHost("start", ["--chunks", "4", "--chunk-bytes", "320"]);
  t.after(() => host.stop());

  const chunks: Buffer[] = [];
  const events: TapEvent[] = [];
  await host.start({ onChunk: (c) => chunks.push(c), onEvent: (e) => events.push(e) });

  assert.equal(host.isRunning, true);
  assert.equal(events[0]?.type, "start");
  assert.equal(events[0]?.sampleRate, 16000, "helper must report the canonical rate");

  await waitFor(() => chunks.length >= 4);
  await host.stop();

  assert.equal(host.isRunning, false);
  const total = Buffer.concat(chunks);
  assert.ok(total.length >= 4 * 320);
  assert.equal(total.length % 2, 0, "only whole samples are forwarded");
});

test("a denied permission surfaces as a typed start error", async () => {
  const host = makeHost("deny");
  await assert.rejects(
    () => host.start({ onChunk: () => {} }),
    (error: unknown) => {
      assert.ok(error instanceof TapStartError);
      assert.equal(error.code, "permission_denied");
      assert.match(error.message, /denied/i);
      return true;
    }
  );
  assert.equal(host.isRunning, false);
});

test("a helper that never reports start times out instead of hanging", async (t) => {
  const host = makeHost("silent", [], 200);
  t.after(() => host.stop());

  await assert.rejects(
    () => host.start({ onChunk: () => {} }),
    (error: unknown) => {
      assert.ok(error instanceof TapStartError);
      assert.equal(error.code, "start_timeout");
      return true;
    }
  );
});

test("samples split across a read boundary are re-aligned, never shifted", async (t) => {
  // A stdout read can end mid-sample. Passing an odd byte count downstream
  // shifts every following sample by one byte and turns the stream into noise.
  const host = makeHost("split", ["--chunk-bytes", "320"]);
  t.after(() => host.stop());

  const chunks: Buffer[] = [];
  const events: TapEvent[] = [];
  await host.start({ onChunk: (c) => chunks.push(c), onEvent: (e) => events.push(e) });

  await waitFor(() => events.some((e) => e.name === "split-complete"));
  await waitFor(() => Buffer.concat(chunks).length === 320);

  for (const chunk of chunks) {
    assert.equal(chunk.length % 2, 0, "every forwarded chunk holds whole samples");
  }

  // Reassembled, the bytes must equal the ramp the helper wrote.
  const total = Buffer.concat(chunks);
  const expected = Buffer.alloc(320);
  for (let i = 0; i + 1 < 320; i += 2) expected.writeInt16LE((i % 30000) - 15000, i);
  assert.ok(total.equals(expected), "audio survives an odd-sized read boundary intact");
});

test("a JSON event split across two stderr reads is still parsed", async (t) => {
  const host = makeHost("split");
  t.after(() => host.stop());

  const events: TapEvent[] = [];
  await host.start({ onChunk: () => {}, onEvent: (e) => events.push(e) });

  assert.equal(events[0]?.type, "start", "start arrived despite being written in two pieces");
});

test("non-JSON helper output is surfaced as a log event, not swallowed", async (t) => {
  const host = makeHost("noise");
  t.after(() => host.stop());

  const events: TapEvent[] = [];
  await host.start({ onChunk: () => {}, onEvent: (e) => events.push(e) });

  const log = events.find((e) => e.type === "log");
  assert.ok(log, "runtime output on stderr must reach the caller");
  assert.match(String(log.message), /dyld/);
});

test("a mid-session crash reports an error and an exit", async (t) => {
  const host = makeHost("crash", ["--chunks", "2", "--chunk-bytes", "64"]);
  t.after(() => host.stop());

  const errors: Error[] = [];
  let exited = false;
  await host.start({
    onChunk: () => {},
    onError: (e) => errors.push(e),
    onExit: () => {
      exited = true;
    },
  });

  await waitFor(() => exited, 3_000);
  assert.ok(errors.length > 0, "the failure reason is reported before the exit");
  assert.equal((errors[0] as TapStartError).code, "device_lost");
});

test("stopping a host that never started is a no-op", async () => {
  const host = new AudioTapHost({ command: process.execPath, args: ["-e", ""] });
  await host.stop();
  assert.equal(host.isRunning, false);
});

test("starting twice is rejected rather than leaking a second helper", async (t) => {
  const host = makeHost("start");
  t.after(() => host.stop());

  await host.start({ onChunk: () => {} });
  await assert.rejects(() => host.start({ onChunk: () => {} }), /already running/);
});

test("a missing binary rejects instead of throwing asynchronously", async () => {
  const host = new AudioTapHost({
    command: "/nonexistent/meeting-audio-tap",
    args: [],
    startTimeoutMs: 1_000,
  });
  await assert.rejects(() => host.start({ onChunk: () => {} }));
  assert.equal(host.isRunning, false);
});
