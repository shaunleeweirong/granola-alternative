import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AutoStopPolicy,
  DEFAULT_AUTO_STOP_TIMINGS,
  DEFAULT_SILENCE_LIMIT_MINUTES,
  SILENCE_LIMIT_CHOICES,
  describeAutoStop,
  formatSpan,
  isCallUsingMic,
  isHeard,
  resolveAutoStopSettings,
  resolveSilenceLimitMinutes,
  type AutoStopSettings,
} from "../../src/core/autoStop.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const SETTINGS: AutoStopSettings = { stopWhenCallEnds: true, silenceLimitMs: 10 * MINUTE };
const { countdownMs, callEndGraceMs } = DEFAULT_AUTO_STOP_TIMINGS;

/**
 * Read through a call, because asserting it is null would otherwise narrow
 * `policy.status` to null for the rest of the test, as far as TypeScript knows.
 */
const statusOf = (policy: AutoStopPolicy) => policy.status;

const makePolicy = (settings: Partial<AutoStopSettings> = {}): AutoStopPolicy =>
  new AutoStopPolicy({ startedAt: 0, settings: { ...SETTINGS, ...settings } });

/** Tick once a second up to `until`, with something heard on every tick when `talking`. */
function run(policy: AutoStopPolicy, from: number, until: number, talking = false): void {
  for (let now = from; now <= until; now += SECOND) {
    if (talking) policy.heard(now);
    const tick = policy.tick(now);
    if (tick.changed || tick.stop) return;
  }
}

// ------------------------------------------------------------------ silence

test("a conversation that keeps going is never interrupted", () => {
  const policy = makePolicy();
  run(policy, 0, 3 * HOUR, true);
  assert.equal(statusOf(policy), null);
});

test("silence for the chosen while opens a countdown, then stops", () => {
  const policy = makePolicy();
  assert.equal(policy.tick(10 * MINUTE - 1).changed, false, "not a moment early");

  const opened = policy.tick(10 * MINUTE);
  assert.equal(opened.changed, true);
  assert.equal(opened.stop, null, "a countdown, not a stop");
  assert.equal(statusOf(policy)?.reason, "silence");
  assert.equal(statusOf(policy)?.stopsAt, 10 * MINUTE + countdownMs);
  assert.equal(statusOf(policy)?.message, "Nothing has been heard for 10 minutes.");

  assert.equal(policy.tick(10 * MINUTE + countdownMs - 1).stop, null);
  assert.equal(policy.tick(10 * MINUTE + countdownMs).stop, "silence");
});

test("silence counts from the start, so an empty room does not record forever", () => {
  const policy = makePolicy();
  policy.tick(10 * MINUTE);
  assert.equal(statusOf(policy)?.reason, "silence");
});

test("anything heard during the countdown calls it off", () => {
  const policy = makePolicy();
  policy.tick(10 * MINUTE);
  policy.heard(10 * MINUTE + 5 * SECOND);

  const tick = policy.tick(10 * MINUTE + 5 * SECOND);
  assert.equal(tick.changed, true);
  assert.equal(statusOf(policy), null);
  assert.equal(policy.tick(10 * MINUTE + countdownMs).stop, null, "and it does not stop");
});

test("keep recording restarts the silence clock", () => {
  const policy = makePolicy();
  policy.tick(10 * MINUTE);
  policy.keep(10 * MINUTE + 10 * SECOND);
  assert.equal(statusOf(policy), null);

  assert.equal(policy.tick(19 * MINUTE).changed, false, "not again straight away");
  policy.tick(20 * MINUTE + 10 * SECOND);
  assert.equal(statusOf(policy)?.reason, "silence", "but again after another full stretch");
});

test("every silence choice is honoured", () => {
  for (const choice of SILENCE_LIMIT_CHOICES) {
    const limit = choice.minutes * MINUTE;
    const policy = makePolicy({ silenceLimitMs: limit });
    assert.equal(policy.tick(limit - 1).changed, false, `${choice.label}: not early`);
    assert.equal(policy.tick(limit).changed, true, `${choice.label}: on time`);
  }
});

test("lengthening the silence limit mid-recording calls off a countdown it no longer justifies", () => {
  const policy = makePolicy();
  policy.tick(10 * MINUTE);
  assert.equal(statusOf(policy)?.reason, "silence");

  policy.configure({ ...SETTINGS, silenceLimitMs: 30 * MINUTE });
  assert.equal(policy.tick(10 * MINUTE + SECOND).changed, true);
  assert.equal(statusOf(policy), null);
  policy.tick(30 * MINUTE);
  assert.equal(statusOf(policy)?.message, "Nothing has been heard for 30 minutes.");
});

// ---------------------------------------------------------------- call ended

test("the call app letting go of the microphone ends the recording after a grace period", () => {
  const policy = makePolicy();
  policy.setCallActive(true, 0);
  run(policy, 0, 20 * MINUTE, true);

  const endedAt = 20 * MINUTE;
  policy.setCallActive(false, endedAt);
  assert.equal(policy.tick(endedAt + callEndGraceMs - 1).changed, false, "not during the grace period");

  policy.tick(endedAt + callEndGraceMs);
  assert.equal(statusOf(policy)?.reason, "call-ended");
  assert.equal(statusOf(policy)?.message, "The call seems to have ended.");
  assert.equal(
    policy.tick(endedAt + callEndGraceMs + countdownMs).stop,
    "call-ended",
    "and stops once the countdown runs out"
  );
});

test("the call coming back inside the grace period is not an ending", () => {
  // A rejoin, or a device switch that briefly releases the microphone.
  const policy = makePolicy();
  policy.setCallActive(true, 0);
  policy.setCallActive(false, MINUTE);
  policy.setCallActive(true, MINUTE + 5 * SECOND);
  policy.heard(MINUTE + 5 * SECOND);

  assert.equal(policy.tick(MINUTE + callEndGraceMs + SECOND).changed, false);
  assert.equal(statusOf(policy), null);
});

test("the call coming back during the countdown calls it off", () => {
  const policy = makePolicy();
  policy.setCallActive(true, 0);
  policy.setCallActive(false, MINUTE);
  policy.heard(MINUTE);
  policy.tick(MINUTE + callEndGraceMs);
  assert.equal(statusOf(policy)?.reason, "call-ended");

  policy.setCallActive(true, MINUTE + callEndGraceMs + 3 * SECOND);
  assert.equal(policy.tick(MINUTE + callEndGraceMs + 3 * SECOND).changed, true);
  assert.equal(statusOf(policy), null);
});

test("with no call ever seen, the call rule has nothing to say", () => {
  // An in-person meeting: nothing else ever uses the microphone.
  const policy = makePolicy();
  policy.setCallActive(false, 0);
  run(policy, 0, HOUR, true);
  assert.equal(statusOf(policy), null);
});

test("turning the call rule off stops it firing", () => {
  const policy = makePolicy({ stopWhenCallEnds: false });
  policy.setCallActive(true, 0);
  policy.setCallActive(false, MINUTE);
  run(policy, MINUTE, 5 * MINUTE, true);
  assert.equal(statusOf(policy), null);
});

test("keep recording after a call ends waits for the next call to end", () => {
  const policy = makePolicy();
  policy.setCallActive(true, 0);
  policy.setCallActive(false, MINUTE);
  policy.heard(MINUTE);
  policy.tick(MINUTE + callEndGraceMs);
  policy.keep(MINUTE + callEndGraceMs + SECOND);

  run(policy, MINUTE + callEndGraceMs + SECOND, 5 * MINUTE, true);
  assert.equal(statusOf(policy), null, "not the same ending again");

  policy.setCallActive(true, 5 * MINUTE);
  policy.setCallActive(false, 6 * MINUTE);
  policy.tick(6 * MINUTE + callEndGraceMs);
  assert.equal(statusOf(policy)?.reason, "call-ended", "but a second call ending counts");
});

// -------------------------------------------------------------- the 4-hour cap

test("the cap ends even a recording that never goes quiet", () => {
  const policy = makePolicy();
  run(policy, 0, 4 * HOUR, true);
  assert.equal(statusOf(policy)?.reason, "max-duration");
  assert.equal(statusOf(policy)?.message, "This recording has run for 4 hours.");
});

test("the cap is four hours, not a moment less", () => {
  const policy = makePolicy();
  run(policy, 0, 4 * HOUR - SECOND, true);
  assert.equal(statusOf(policy), null);
});

test("keep recording at the cap buys another hour", () => {
  const policy = makePolicy();
  run(policy, 0, 4 * HOUR, true);
  policy.keep(4 * HOUR + 10 * SECOND);
  assert.equal(statusOf(policy), null);

  run(policy, 4 * HOUR + 11 * SECOND, 5 * HOUR - SECOND, true);
  assert.equal(statusOf(policy), null, "quiet until the extension runs out");
  run(policy, 5 * HOUR - SECOND, 5 * HOUR, true);
  assert.equal(statusOf(policy)?.message, "This recording has run for 5 hours.");
});

test("the cap wins when several rules apply at once", () => {
  const policy = makePolicy({ silenceLimitMs: 2 * HOUR });
  policy.setCallActive(true, 0);
  policy.setCallActive(false, 4 * HOUR - MINUTE);
  policy.tick(4 * HOUR);
  assert.equal(statusOf(policy)?.reason, "max-duration");
});

// ----------------------------------------------------------------- settings

test("the silence choices top out below the cap", () => {
  // A longer choice would never take effect: the cap would always come first.
  for (const choice of SILENCE_LIMIT_CHOICES) {
    assert.ok(choice.minutes * MINUTE < DEFAULT_AUTO_STOP_TIMINGS.maxDurationMs, choice.label);
  }
  assert.deepEqual(
    SILENCE_LIMIT_CHOICES.map((choice) => choice.minutes),
    [10, 30, 60, 120]
  );
});

test("settings default to on, and to ten minutes of silence", () => {
  assert.deepEqual(resolveAutoStopSettings({ stopWhenCallEnds: null, silenceMinutes: null }), {
    stopWhenCallEnds: true,
    silenceLimitMs: 10 * MINUTE,
  });
  assert.equal(DEFAULT_SILENCE_LIMIT_MINUTES, 10);
});

test("stored settings are read back", () => {
  assert.deepEqual(resolveAutoStopSettings({ stopWhenCallEnds: "false", silenceMinutes: "60" }), {
    stopWhenCallEnds: false,
    silenceLimitMs: HOUR,
  });
});

test("a stored silence limit that is not on offer falls back to the default", () => {
  // Including the four hours that was once proposed: the cap makes it moot.
  for (const raw of ["240", "0", "-5", "abc", "", undefined]) {
    assert.equal(resolveSilenceLimitMinutes(raw), DEFAULT_SILENCE_LIMIT_MINUTES, String(raw));
  }
});

// ------------------------------------------------------------ microphone use

const OWN = new Set([500, 501]);

test("another app on the microphone counts as a call", () => {
  assert.equal(isCallUsingMic([{ pid: 900, bundleId: "us.zoom.xos" }], OWN), true);
  assert.equal(isCallUsingMic([{ pid: 901, bundleId: "com.microsoft.teams2" }], OWN), true);
  // Meet and Teams in a browser show up as the browser's helper.
  assert.equal(isCallUsingMic([{ pid: 902, bundleId: "com.google.Chrome.helper" }], OWN), true);
});

test("Clean Record's own use of the microphone is never the call", () => {
  assert.equal(isCallUsingMic([{ pid: 500, bundleId: "" }], OWN), false, "by process");
  assert.equal(
    isCallUsingMic([{ pid: 777, bundleId: "app.cleanrecord.desktop.helper" }], OWN),
    false,
    "by bundle, for a helper the process list missed"
  );
  assert.equal(
    isCallUsingMic([{ pid: 778, bundleId: "com.github.Electron.helper" }], OWN),
    false,
    "and when running from source"
  );
});

test("Siri listening in the background is not a call", () => {
  assert.equal(isCallUsingMic([{ pid: 300, bundleId: "com.apple.CoreSpeech" }], OWN), false);
  assert.equal(isCallUsingMic([{ pid: 301, bundleId: "com.apple.corespeechd" }], OWN), false);
});

test("nobody on the microphone is no call", () => {
  assert.equal(isCallUsingMic([], OWN), false);
});

// ----------------------------------------------------------------- hearing

test("a quiet room is not mistaken for someone speaking", () => {
  assert.equal(isHeard("you", 0.0004), false, "noise-suppressed room tone");
  assert.equal(isHeard("you", 0.03), true, "ordinary speech");
  assert.equal(isHeard("them", 0), false, "nothing playing");
  assert.equal(isHeard("them", 0.01), true, "the other side talking");
});

// ------------------------------------------------------------------ wording

test("spans read naturally", () => {
  assert.equal(formatSpan(MINUTE), "1 minute");
  assert.equal(formatSpan(10 * MINUTE), "10 minutes");
  assert.equal(formatSpan(90 * MINUTE), "90 minutes");
  assert.equal(formatSpan(HOUR), "1 hour");
  assert.equal(formatSpan(2 * HOUR), "2 hours");
});

test("every reason explains itself before and after", () => {
  for (const reason of ["call-ended", "silence", "max-duration"] as const) {
    const { message, stoppedMessage } = describeAutoStop(reason, HOUR);
    assert.ok(message.endsWith("."), `${reason}: a sentence`);
    assert.match(stoppedMessage, /^Recording stopped automatically/, `${reason}: says what happened`);
  }
  assert.equal(
    describeAutoStop("silence", 30 * MINUTE).stoppedMessage,
    "Recording stopped automatically after 30 minutes of silence."
  );
});
