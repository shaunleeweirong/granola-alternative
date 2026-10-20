import { test } from "node:test";
import assert from "node:assert/strict";

import { AutoStopMonitor } from "../../src/main/autoStopMonitor.ts";
import type { MeetingDetectorHandlers, MicDetector } from "../../src/main/meetingDetector.ts";
import {
  DEFAULT_AUTO_STOP_TIMINGS,
  type AutoStopSettings,
  type AutoStopStatus,
  type MicUser,
} from "../../src/core/autoStop.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const { countdownMs, callEndGraceMs } = DEFAULT_AUTO_STOP_TIMINGS;

/** Stands in for the helper: the test decides who is on the microphone. */
class FakeDetector implements MicDetector {
  handlers: MeetingDetectorHandlers | null = null;
  stopped = false;
  failStart = false;

  async start(handlers: MeetingDetectorHandlers): Promise<void> {
    if (this.failStart) throw new Error("CoreAudio is unavailable");
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  report(users: MicUser[]): void {
    this.handlers?.onMicUsers(users);
  }
}

/** Read through a call, so asserting null once does not narrow it for the rest of a test. */
const statusOf = (monitor: AutoStopMonitor) => monitor.status;

const OWN_PID = 500;
const ZOOM: MicUser = { pid: 900, bundleId: "us.zoom.xos" };
const OURSELVES: MicUser = { pid: OWN_PID, bundleId: "app.cleanrecord.desktop.helper" };

interface Harness {
  monitor: AutoStopMonitor;
  detector: FakeDetector;
  statuses: Array<AutoStopStatus | null>;
  stops: AutoStopStatus[];
  settings: AutoStopSettings;
  clock: { now: number };
  /** Move the clock on and evaluate, as the timer would. */
  advance: (ms: number) => void;
}

async function makeHarness(
  options: { detector?: FakeDetector | null; settings?: Partial<AutoStopSettings> } = {}
): Promise<Harness> {
  const detector = options.detector === undefined ? new FakeDetector() : options.detector;
  const clock = { now: 0 };
  const statuses: Array<AutoStopStatus | null> = [];
  const stops: AutoStopStatus[] = [];
  const settings: AutoStopSettings = { stopWhenCallEnds: true, silenceLimitMs: 10 * MINUTE, ...options.settings };

  const monitor = new AutoStopMonitor({
    settings: () => settings,
    createDetector: () => detector,
    ownPids: () => [OWN_PID],
    onStatus: (status) => statuses.push(status),
    onStop: (status) => stops.push(status),
    now: () => clock.now,
    // The tests drive check() themselves; the real timer must not interfere.
    tickMs: 60 * 60_000,
  });

  monitor.begin(0);
  // Let the detector's start resolve.
  await new Promise((r) => setImmediate(r));

  return {
    monitor,
    detector: detector ?? new FakeDetector(),
    statuses,
    stops,
    settings,
    clock,
    advance: (ms) => {
      clock.now += ms;
      monitor.check();
    },
  };
}

test("a call that ends opens a countdown, then stops the recording", async (t) => {
  const h = await makeHarness();
  t.after(() => h.monitor.end());

  h.detector.report([OURSELVES, ZOOM]);
  h.monitor.heard("them", 0.05);
  h.advance(5 * MINUTE);
  h.monitor.heard("them", 0.05);

  h.detector.report([OURSELVES]);
  h.advance(callEndGraceMs);

  assert.equal(h.statuses.at(-1)?.reason, "call-ended", "the countdown is announced");
  assert.equal(statusOf(h.monitor)?.message, "The call seems to have ended.");
  assert.equal(h.stops.length, 0, "but nothing stops yet");

  h.advance(countdownMs);
  assert.equal(h.stops.length, 1);
  assert.equal(h.stops[0].reason, "call-ended");
  assert.equal(h.stops[0].stoppedMessage, "Recording stopped automatically because the call ended.");
  assert.equal(h.statuses.at(-1), null, "and the countdown is taken down");
  assert.equal(h.detector.stopped, true, "the detector does not outlive the recording");
});

test("the app's own microphone use never counts as the call", async (t) => {
  // Clean Record records the microphone itself. If that counted, the call
  // could never be seen to end.
  const h = await makeHarness();
  t.after(() => h.monitor.end());

  h.detector.report([OURSELVES]);
  h.monitor.heard("you", 0.05);
  h.detector.report([]);
  h.advance(callEndGraceMs + SECOND);

  assert.equal(statusOf(h.monitor), null, "no call was ever seen, so none can end");
});

test("keep recording calls the countdown off", async (t) => {
  const h = await makeHarness();
  t.after(() => h.monitor.end());

  h.advance(10 * MINUTE);
  assert.equal(statusOf(h.monitor)?.reason, "silence");

  h.monitor.keep();
  assert.equal(statusOf(h.monitor), null);
  assert.equal(h.statuses.at(-1), null, "and says so");

  h.advance(countdownMs);
  assert.equal(h.stops.length, 0);
});

test("sound during the countdown calls it off without anyone clicking", async (t) => {
  const h = await makeHarness();
  t.after(() => h.monitor.end());

  h.advance(10 * MINUTE);
  assert.equal(statusOf(h.monitor)?.reason, "silence");

  h.clock.now += 5 * SECOND;
  h.monitor.heard("you", 0.05);
  h.monitor.check();

  assert.equal(statusOf(h.monitor), null);
});

test("room tone below the bar does not keep a recording alive", async (t) => {
  const h = await makeHarness();
  t.after(() => h.monitor.end());

  for (let i = 0; i < 10; i += 1) {
    h.clock.now += MINUTE;
    h.monitor.heard("you", 0.0003);
    h.monitor.heard("them", 0.0001);
    h.monitor.check();
  }
  assert.equal(statusOf(h.monitor)?.reason, "silence");
});

test("a changed setting applies to the recording already running", async (t) => {
  const h = await makeHarness();
  t.after(() => h.monitor.end());

  h.advance(10 * MINUTE);
  assert.equal(statusOf(h.monitor)?.reason, "silence");

  h.settings.silenceLimitMs = 30 * MINUTE;
  h.monitor.settingsChanged();
  assert.equal(statusOf(h.monitor), null, "the longer limit is not yet reached");

  h.advance(20 * MINUTE);
  assert.equal(statusOf(h.monitor)?.message, "Nothing has been heard for 30 minutes.");
});

test("without a detector, silence and the cap still apply", async (t) => {
  const h = await makeHarness({ detector: null });
  t.after(() => h.monitor.end());

  h.advance(10 * MINUTE);
  assert.equal(statusOf(h.monitor)?.reason, "silence");
});

test("a detector that fails to start leaves the other rules running", async (t) => {
  const detector = new FakeDetector();
  detector.failStart = true;
  const h = await makeHarness({ detector });
  t.after(() => h.monitor.end());

  h.advance(10 * MINUTE);
  assert.equal(statusOf(h.monitor)?.reason, "silence");
});

test("a detector from a finished recording cannot end the next one", async (t) => {
  // Each recording gets its own detector. A late report from the previous one
  // must not count as the new call ending.
  const detectors: FakeDetector[] = [];
  const clock = { now: 0 };
  const stops: AutoStopStatus[] = [];
  const monitor = new AutoStopMonitor({
    settings: () => ({ stopWhenCallEnds: true, silenceLimitMs: 10 * MINUTE }),
    createDetector: () => {
      const detector = new FakeDetector();
      detectors.push(detector);
      return detector;
    },
    ownPids: () => [OWN_PID],
    onStatus: () => {},
    onStop: (status) => stops.push(status),
    now: () => clock.now,
    tickMs: 60 * 60_000,
  });
  t.after(() => monitor.end());

  monitor.begin(0);
  await new Promise((r) => setImmediate(r));
  monitor.end();

  monitor.begin(0);
  await new Promise((r) => setImmediate(r));
  assert.equal(detectors.length, 2);

  detectors[0].report([ZOOM]);
  detectors[0].report([]);
  clock.now = callEndGraceMs + SECOND;
  monitor.check();

  assert.equal(statusOf(monitor), null, "the old detector's call is not this recording's call");
  assert.deepEqual(stops, []);
});

test("ending clears the countdown it was showing", async () => {
  const h = await makeHarness();
  h.advance(10 * MINUTE);
  assert.ok(statusOf(h.monitor));

  h.monitor.end();
  assert.equal(statusOf(h.monitor), null);
  assert.equal(h.statuses.at(-1), null);
});
