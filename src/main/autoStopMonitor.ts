import {
  AutoStopPolicy,
  isCallUsingMic,
  isHeard,
  type AutoStopSettings,
  type AutoStopStatus,
  type AutoStopTimings,
  type MicUser,
} from "../core/autoStop.ts";
import type { Channel } from "../core/transcript/types.ts";
import type { MicDetector } from "./meetingDetector.ts";

/**
 * Runs the auto-stop rules (src/core/autoStop.ts) for one recording at a time.
 *
 * Owns the meeting detector for the length of the recording, feeds the rules
 * what is heard and who is using the microphone, and reports two things: the
 * countdown starting or being called off, and the countdown running out.
 */
export interface AutoStopMonitorDeps {
  settings: () => AutoStopSettings;
  /** Null where meeting detection is unavailable. The other rules still apply. */
  createDetector: () => MicDetector | null;
  /**
   * Clean Record's own processes. They use the microphone too, for the
   * recording itself, and must never be mistaken for the call.
   */
  ownPids: () => Iterable<number>;
  onStatus: (status: AutoStopStatus | null) => void;
  onStop: (status: AutoStopStatus) => void;
  onLog?: (message: string) => void;
  now?: () => number;
  tickMs?: number;
  timings?: Partial<AutoStopTimings>;
}

export class AutoStopMonitor {
  private readonly deps: AutoStopMonitorDeps;
  private policy: AutoStopPolicy | null = null;
  private detector: MicDetector | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastStatus: AutoStopStatus | null = null;
  /** Bumped on every begin and end, so a detector from a finished recording is ignored. */
  private generation = 0;

  constructor(deps: AutoStopMonitorDeps) {
    this.deps = deps;
  }

  /** The countdown, if one is running. */
  get status(): AutoStopStatus | null {
    return this.lastStatus;
  }

  begin(startedAt: number): void {
    this.end();
    const generation = this.generation;
    this.policy = new AutoStopPolicy({
      startedAt,
      settings: this.deps.settings(),
      timings: this.deps.timings,
    });
    this.timer = setInterval(() => this.check(), this.deps.tickMs ?? 1_000);
    this.timer.unref?.();
    void this.startDetector(generation);
  }

  end(): void {
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.policy = null;
    const detector = this.detector;
    this.detector = null;
    void detector?.stop().catch(() => {});
    this.publish(null);
  }

  /** A chunk of audio arrived on one side, at this loudness. */
  heard(channel: Channel, rms: number): void {
    if (this.policy && isHeard(channel, rms)) this.policy.heard(this.now());
  }

  /** "Keep recording" from the countdown. */
  keep(): void {
    if (!this.policy) return;
    this.policy.keep(this.now());
    this.publish(this.policy.status);
  }

  /** Re-read the settings, so a change in the menu applies to this recording too. */
  settingsChanged(): void {
    if (!this.policy) return;
    this.policy.configure(this.deps.settings());
    this.check();
  }

  /** Evaluate the rules now. Runs on a timer; public so tests need not wait for one. */
  check(): void {
    const policy = this.policy;
    if (!policy) return;

    const tick = policy.tick(this.now());
    if (tick.stop) {
      const status = policy.status;
      this.end();
      if (status) this.deps.onStop(status);
      return;
    }
    if (tick.changed) this.publish(policy.status);
  }

  private async startDetector(generation: number): Promise<void> {
    const detector = this.deps.createDetector();
    if (!detector) return;

    try {
      await detector.start({
        onMicUsers: (users) => {
          if (generation === this.generation) this.micUsers(users);
        },
        // Losing the detector mid-call leaves the call marked as still going,
        // so the worst case is that this rule stops firing. Silence and the
        // cap carry on regardless.
        onExit: (code) => {
          if (generation === this.generation) {
            this.deps.onLog?.(`Meeting detector exited (code ${code ?? "null"}); call detection is off for this recording.`);
          }
        },
      });
    } catch (error) {
      this.deps.onLog?.(`Meeting detector unavailable: ${(error as Error).message}`);
      return;
    }

    // The recording ended while the helper was starting.
    if (generation !== this.generation) {
      await detector.stop().catch(() => {});
      return;
    }
    this.detector = detector;
  }

  private micUsers(users: MicUser[]): void {
    if (!this.policy) return;
    const own = new Set(this.deps.ownPids());
    this.policy.setCallActive(isCallUsingMic(users, own), this.now());
    this.check();
  }

  private publish(status: AutoStopStatus | null): void {
    if (status === this.lastStatus) return;
    if (status && this.lastStatus && status.reason === this.lastStatus.reason && status.stopsAt === this.lastStatus.stopsAt) {
      return;
    }
    this.lastStatus = status;
    this.deps.onStatus(status);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
