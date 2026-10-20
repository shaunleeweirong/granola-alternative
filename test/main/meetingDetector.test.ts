import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MeetingDetector } from "../../src/main/meetingDetector.ts";
import type { MicUser } from "../../src/core/autoStop.ts";

const FAKE_DETECTOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "harness",
  "fakeMeetingDetector.mjs"
);

const makeDetector = (mode: string, users: MicUser[][] = [[]], startTimeoutMs = 3_000): MeetingDetector =>
  new MeetingDetector({
    command: process.execPath,
    args: [FAKE_DETECTOR, "--mode", mode, "--users", JSON.stringify(users)],
    startTimeoutMs,
  });

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const ZOOM: MicUser = { pid: 900, bundleId: "us.zoom.xos" };
const CHROME: MicUser = { pid: 901, bundleId: "com.google.Chrome.helper" };

test("starts, then reports who is using the microphone as it changes", async (t) => {
  const detector = makeDetector("start", [[ZOOM], [ZOOM, CHROME], []]);
  t.after(() => detector.stop());

  const seen: MicUser[][] = [];
  await detector.start({ onMicUsers: (users) => seen.push(users) });
  await waitFor(() => seen.length === 3);

  assert.deepEqual(seen, [[ZOOM], [ZOOM, CHROME], []]);
});

test("a line split across reads, and a stray non-JSON line, are both survived", async (t) => {
  const detector = makeDetector("split", [[ZOOM]]);
  t.after(() => detector.stop());

  const seen: MicUser[][] = [];
  await detector.start({ onMicUsers: (users) => seen.push(users) });
  await waitFor(() => seen.length === 1);

  assert.deepEqual(seen, [[ZOOM]]);
});

test("malformed entries are dropped rather than passed on", async (t) => {
  const detector = new MeetingDetector({
    command: process.execPath,
    args: [
      FAKE_DETECTOR,
      "--users",
      JSON.stringify([[ZOOM, { pid: "nope", bundleId: 3 }, null, { pid: 5 }]]),
    ],
  });
  t.after(() => detector.stop());

  const seen: MicUser[][] = [];
  await detector.start({ onMicUsers: (users) => seen.push(users) });
  await waitFor(() => seen.length === 1);

  assert.deepEqual(seen, [[ZOOM]]);
});

test("a helper that never says it started is given up on", async () => {
  const detector = makeDetector("silent", [[]], 200);
  await assert.rejects(() => detector.start({ onMicUsers: () => {} }), /did not start in time/);
});

test("a helper that exits before starting is reported, not waited on", async () => {
  const detector = makeDetector("fail");
  await assert.rejects(() => detector.start({ onMicUsers: () => {} }), /exited before starting/);
});

test("a helper that dies later is reported through onExit", async () => {
  const detector = makeDetector("crash", [[ZOOM]]);
  let exitCode: number | null | undefined;
  await detector.start({ onMicUsers: () => {}, onExit: (code) => (exitCode = code) });
  await waitFor(() => exitCode !== undefined);
  assert.equal(exitCode, 3);
});

test("stopping is not mistaken for a crash", async () => {
  const detector = makeDetector("start", [[ZOOM]]);
  let exited = false;
  await detector.start({ onMicUsers: () => {}, onExit: () => (exited = true) });
  await detector.stop();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exited, false);
});

test("it can be started again after stopping", async (t) => {
  const detector = makeDetector("start", [[ZOOM]]);
  t.after(() => detector.stop());

  await detector.start({ onMicUsers: () => {} });
  await detector.stop();

  const seen: MicUser[][] = [];
  await detector.start({ onMicUsers: (users) => seen.push(users) });
  await waitFor(() => seen.length === 1);
  assert.deepEqual(seen, [[ZOOM]]);
});
