import type { Channel } from "./transcript/types.ts";

/**
 * When a recording should end without anyone pressing Stop.
 *
 * People forget. A recording left running after a call has ended keeps
 * capturing whatever plays on the Mac afterwards, for as long as the app stays
 * open. Three rules end it, whichever comes first:
 *
 *   * The call ended: the app that was using the microphone (Zoom, Teams, a
 *     browser tab) let go of it. Seconds after the call ends, and the most
 *     precise of the three.
 *   * Silence: nothing has been heard on either side for a chosen while. Covers
 *     in-person meetings and anything the call signal cannot see.
 *   * A hard cap on length. The backstop for when silence is fooled, for example
 *     by music playing after the call, since system audio is heard from every app.
 *
 * None of them stops a recording outright. Each opens a short countdown that
 * anyone still in the meeting can wave away, so a wrong guess costs a click
 * rather than the rest of the meeting.
 *
 * Pure and clock-free, so every rule is testable without waiting it out.
 */

export type AutoStopReason = "call-ended" | "silence" | "max-duration";

export interface AutoStopSettings {
  /** Stop once the app holding the microphone for the call lets go of it. */
  stopWhenCallEnds: boolean;
  /** Stop after this long with nothing heard on either side. */
  silenceLimitMs: number;
}

export interface AutoStopTimings {
  /** Hard cap on a recording's length. */
  maxDurationMs: number;
  /** How much longer "Keep recording" buys once the cap is reached. */
  maxDurationExtensionMs: number;
  /**
   * How long the call app must stay off the microphone before the call counts
   * as over. Rides out a rejoin, a device switch, or an app that briefly
   * releases the microphone while it reconfigures.
   */
  callEndGraceMs: number;
  /** How long the countdown runs before the recording actually stops. */
  countdownMs: number;
}

export const DEFAULT_AUTO_STOP_TIMINGS: AutoStopTimings = {
  maxDurationMs: 4 * 60 * 60_000,
  maxDurationExtensionMs: 60 * 60_000,
  callEndGraceMs: 15_000,
  countdownMs: 30_000,
};

/** What the countdown says, and what is said once it has run out. */
export interface AutoStopStatus {
  reason: AutoStopReason;
  /** Epoch milliseconds at which the recording stops unless kept. */
  stopsAt: number;
  /** Why the countdown is running, e.g. "The call seems to have ended." */
  message: string;
  /** What to say after the recording has stopped for this reason. */
  stoppedMessage: string;
}

// ---------------------------------------------------------------- settings

/** Keys in the settings table. */
export const AUTO_STOP_SETTING_KEYS = {
  stopWhenCallEnds: "autoStopWhenCallEnds",
  silenceMinutes: "autoStopSilenceMinutes",
} as const;

/**
 * The silence limits on offer. Nothing past two hours: the four-hour cap would
 * always end the recording first, so a longer choice would never take effect.
 */
export const SILENCE_LIMIT_CHOICES = [
  { minutes: 10, label: "10 Minutes" },
  { minutes: 30, label: "30 Minutes" },
  { minutes: 60, label: "1 Hour" },
  { minutes: 120, label: "2 Hours" },
] as const;

export const DEFAULT_SILENCE_LIMIT_MINUTES = 10;

/** A stored value that is not one of the choices falls back to the default. */
export function resolveSilenceLimitMinutes(raw: string | null | undefined): number {
  const minutes = Number(raw);
  return SILENCE_LIMIT_CHOICES.some((choice) => choice.minutes === minutes)
    ? minutes
    : DEFAULT_SILENCE_LIMIT_MINUTES;
}

/** Settings as stored, which is to say strings or nothing at all. */
export function resolveAutoStopSettings(stored: {
  stopWhenCallEnds: string | null | undefined;
  silenceMinutes: string | null | undefined;
}): AutoStopSettings {
  return {
    // On unless someone turned it off.
    stopWhenCallEnds: stored.stopWhenCallEnds !== "false",
    silenceLimitMs: resolveSilenceLimitMinutes(stored.silenceMinutes) * 60_000,
  };
}

// ------------------------------------------------------------------ hearing

/**
 * Loudness above which a chunk counts as something heard.
 *
 * System audio reuses the threshold the silent-tap warning already uses: any
 * audible playback at all. The microphone arrives noise suppressed, so a quiet
 * room reads near zero, and the bar is the VAD's own speech threshold in a
 * quiet room (its absolute floor times its SNR ratio, 0.0008 x 2.5).
 */
export const HEARD_RMS: Record<Channel, number> = {
  you: 0.002,
  them: 0.0005,
};

export const isHeard = (channel: Channel, rms: number): boolean => rms > HEARD_RMS[channel];

// ------------------------------------------------------------ microphone use

/** A process using a microphone, as reported by the meeting detector. */
export interface MicUser {
  pid: number;
  /** Empty for a bare executable with no app bundle. */
  bundleId: string;
}

/**
 * Bundle IDs whose microphone use never means a call.
 *
 * Clean Record records the microphone itself, so its own processes are always
 * on the list: the packaged app and its helpers, and Electron's when running
 * from source. CoreSpeech listens for "Hey Siri" more or less permanently, and
 * counting it would make every call look like it never ended.
 */
const NEVER_A_CALL = ["app.cleanrecord.desktop", "com.github.electron", "com.apple.corespeech"];

/**
 * Whether anything other than Clean Record itself is using the microphone.
 *
 * Deliberately not a list of known meeting apps. Whatever held the microphone
 * during the recording is treated as the call, which covers Zoom and Teams but
 * equally Meet in a browser tab, a Slack huddle, or an app nobody thought to
 * list.
 */
export function isCallUsingMic(users: readonly MicUser[], ownPids: ReadonlySet<number>): boolean {
  return users.some((user) => {
    if (ownPids.has(user.pid)) return false;
    const bundleId = user.bundleId.toLowerCase();
    return !NEVER_A_CALL.some((prefix) => bundleId.startsWith(prefix));
  });
}

// ----------------------------------------------------------------- wording

/** "10 minutes", "1 hour", "2 hours". */
export function formatSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function describeAutoStop(
  reason: AutoStopReason,
  limitMs: number
): { message: string; stoppedMessage: string } {
  switch (reason) {
    case "call-ended":
      return {
        message: "The call seems to have ended.",
        stoppedMessage: "Recording stopped automatically because the call ended.",
      };
    case "silence":
      return {
        message: `Nothing has been heard for ${formatSpan(limitMs)}.`,
        stoppedMessage: `Recording stopped automatically after ${formatSpan(limitMs)} of silence.`,
      };
    case "max-duration":
      return {
        message: `This recording has run for ${formatSpan(limitMs)}.`,
        stoppedMessage: `Recording stopped automatically after ${formatSpan(limitMs)}.`,
      };
  }
}

// ------------------------------------------------------------------- policy

/** Checked in this order, so the cap wins when several apply at once. */
const REASONS: AutoStopReason[] = ["max-duration", "call-ended", "silence"];

export interface AutoStopTick {
  /** The countdown started or was called off on this tick. */
  changed: boolean;
  /** Set when the countdown has run out and the recording should stop now. */
  stop: AutoStopReason | null;
}

export class AutoStopPolicy {
  private settings: AutoStopSettings;
  private readonly timings: AutoStopTimings;
  private readonly startedAt: number;
  private lastHeardAt: number;
  private capAt: number;
  private callActive = false;
  /** When the call app let go of the microphone. Null while it holds it, or before any call. */
  private callEndedAt: number | null = null;
  private pending: { reason: AutoStopReason; stopsAt: number } | null = null;

  constructor(options: {
    startedAt: number;
    settings: AutoStopSettings;
    timings?: Partial<AutoStopTimings>;
  }) {
    this.settings = options.settings;
    this.timings = { ...DEFAULT_AUTO_STOP_TIMINGS, ...options.timings };
    this.startedAt = options.startedAt;
    // Silence is measured from the start, so a recording begun into an empty
    // room is not kept open forever waiting for someone to speak.
    this.lastHeardAt = options.startedAt;
    this.capAt = options.startedAt + this.timings.maxDurationMs;
  }

  /** The countdown, if one is running. */
  get status(): AutoStopStatus | null {
    if (!this.pending) return null;
    const { reason, stopsAt } = this.pending;
    return { reason, stopsAt, ...describeAutoStop(reason, this.limitFor(reason)) };
  }

  /** Applies immediately, including to a countdown already running. */
  configure(settings: AutoStopSettings): void {
    this.settings = settings;
  }

  /** Something audible arrived on either side. */
  heard(now: number): void {
    this.lastHeardAt = now;
  }

  /** Whether an app other than Clean Record is using the microphone. */
  setCallActive(active: boolean, now: number): void {
    if (active) this.callEndedAt = null;
    else if (this.callActive) this.callEndedAt = now;
    this.callActive = active;
  }

  /** "Keep recording": call off the countdown and stop that rule re-firing at once. */
  keep(now: number): void {
    const reason = this.pending?.reason;
    this.pending = null;
    if (reason === "silence") this.lastHeardAt = now;
    // Waits for the next call to end, rather than for this one to end again.
    if (reason === "call-ended") this.callEndedAt = null;
    // From the old cap rather than from now, so the limits stay whole hours.
    if (reason === "max-duration") this.capAt += this.timings.maxDurationExtensionMs;
  }

  tick(now: number): AutoStopTick {
    if (this.pending) {
      // The reason went away on its own: someone spoke, the call came back, or
      // the setting behind it changed. Stand down without being asked.
      if (!this.holds(this.pending.reason, now)) {
        this.pending = null;
        return { changed: true, stop: null };
      }
      if (now >= this.pending.stopsAt) return { changed: false, stop: this.pending.reason };
      return { changed: false, stop: null };
    }

    const reason = REASONS.find((candidate) => this.holds(candidate, now));
    if (!reason) return { changed: false, stop: null };
    this.pending = { reason, stopsAt: now + this.timings.countdownMs };
    return { changed: true, stop: null };
  }

  private holds(reason: AutoStopReason, now: number): boolean {
    switch (reason) {
      case "max-duration":
        return now >= this.capAt;
      case "call-ended":
        return (
          this.settings.stopWhenCallEnds &&
          this.callEndedAt !== null &&
          now - this.callEndedAt >= this.timings.callEndGraceMs
        );
      case "silence":
        return now - this.lastHeardAt >= this.settings.silenceLimitMs;
    }
  }

  private limitFor(reason: AutoStopReason): number {
    if (reason === "silence") return this.settings.silenceLimitMs;
    if (reason === "max-duration") return this.capAt - this.startedAt;
    return 0;
  }
}
