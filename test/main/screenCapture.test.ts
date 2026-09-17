import { test } from "node:test";
import assert from "node:assert/strict";

import { ScreenCaptureGate, type CaptureTarget } from "../../src/main/screenCapture.ts";

/** Records what setContentProtection was asked to do. */
function fakeWindow(): CaptureTarget & { calls: boolean[]; destroyed: boolean } {
  return {
    calls: [],
    destroyed: false,
    setContentProtection(enabled: boolean) {
      this.calls.push(enabled);
    },
    isDestroyed() {
      return this.destroyed;
    },
  };
}

test("a window is protected the moment it registers", () => {
  const gate = new ScreenCaptureGate();
  const win = fakeWindow();

  gate.register(win);

  assert.equal(gate.isAllowed, false, "blocked by default");
  assert.deepEqual(win.calls, [true], "protection on, so capture is off");
});

test("toggling lifts protection, and toggling back restores it", () => {
  const gate = new ScreenCaptureGate();
  const win = fakeWindow();
  gate.register(win);

  assert.equal(gate.toggle(), true);
  assert.equal(win.calls.at(-1), false, "protection off, so the window can be captured");

  assert.equal(gate.toggle(), false);
  assert.equal(win.calls.at(-1), true, "and back to protected");
});

test("a window opened after capture was allowed adopts that, not the default", () => {
  // On macOS, closing the window and reopening it from the dock builds a new
  // one. Setting protection directly in createWindow would silently re-protect
  // it while the menu still showed a tick, which reads as the toggle being broken.
  const gate = new ScreenCaptureGate();
  const first = fakeWindow();
  gate.register(first);
  gate.toggle();

  const reopened = fakeWindow();
  gate.register(reopened);

  assert.deepEqual(reopened.calls, [false], "the new window is capturable too");
});

test("every registered window follows the toggle", () => {
  const gate = new ScreenCaptureGate();
  const a = fakeWindow();
  const b = fakeWindow();
  gate.register(a);
  gate.register(b);

  gate.toggle();

  assert.equal(a.calls.at(-1), false);
  assert.equal(b.calls.at(-1), false);
});

test("a destroyed window is dropped rather than called", () => {
  // Electron throws on a destroyed window, and a stale reference would take
  // the toggle down with it for every other window.
  const gate = new ScreenCaptureGate();
  const dead = fakeWindow();
  const alive = fakeWindow();
  gate.register(dead);
  gate.register(alive);

  dead.destroyed = true;
  const callsBefore = dead.calls.length;

  gate.toggle();

  assert.equal(dead.calls.length, callsBefore, "the destroyed window was not touched");
  assert.equal(alive.calls.at(-1), false, "and the live one still followed");
});

test("a forgotten window stops following", () => {
  const gate = new ScreenCaptureGate();
  const win = fakeWindow();
  gate.register(win);
  gate.forget(win);

  const before = win.calls.length;
  gate.toggle();

  assert.equal(win.calls.length, before);
});

test("nothing is remembered across a restart", () => {
  // The safety net for the whole feature: allowing capture is a decision for
  // now. A fresh gate is a fresh app launch.
  const first = new ScreenCaptureGate();
  first.toggle();
  assert.equal(first.isAllowed, true);

  assert.equal(new ScreenCaptureGate().isAllowed, false);
});

test("setAllowed is idempotent and does not drift", () => {
  const gate = new ScreenCaptureGate();
  const win = fakeWindow();
  gate.register(win);

  gate.setAllowed(true);
  gate.setAllowed(true);

  assert.equal(gate.isAllowed, true);
  assert.deepEqual(win.calls, [true, false, false]);
});
