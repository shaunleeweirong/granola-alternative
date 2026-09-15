import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { RecordingSession } from "../core/recordingSession.ts";
import type { NotesRepo } from "../core/db/notesRepo.ts";
import { computePcm16Rms } from "../core/audio/format.ts";
import type { Channel, TranscriptSegment } from "../core/transcript/types.ts";
import { AudioTapHost, type AudioTapHandlers } from "./audioTapHost.ts";
import type { WhisperClient } from "./whisperClient.ts";
import type { SystemAudioStatus } from "../shared/ipc.ts";

/**
 * Owns one recording end to end: the system-audio helper, the microphone feed
 * arriving from the renderer, raw PCM persistence, and the transcript.
 *
 * Deliberately free of any echo logic. The microphone arrives already echo
 * cancelled by the platform (FR-1), so the two channels are independent.
 */
export interface RecordingControllerDeps {
  repo: NotesRepo;
  whisper: WhisperClient;
  createTapHost: () => AudioTapHost | null;
  audioDir: string;
  language?: string;
  /** FR-33: keep raw captures after a successful transcription. */
  retainAudio?: boolean;
  onSegment?: (noteId: number, segment: TranscriptSegment) => void;
  onLevel?: (channel: Channel, rms: number) => void;
  onError?: (message: string, fatal: boolean) => void;
  onSystemAudioSilent?: () => void;
  onSystemAudioStatus?: (status: SystemAudioStatus) => void;
  /** Overridable so tests exercise the recovery path without waiting it out. */
  tapRestartDelaysMs?: number[];
  tapStableMs?: number;
}

/** Warn if the tap has produced nothing audible for this long (FR-7). */
const SILENCE_WARNING_MS = 45_000;

/**
 * Backoff before each attempt to bring the system-audio helper back.
 *
 * The helper dying mid-meeting used to be reported once and then simply
 * accepted, which meant the rest of the call was recorded microphone-only and
 * the remote half of the conversation was lost with no way to recover it. The
 * most plausible cause is the output device changing underneath it, which is
 * exactly the kind of transient a restart fixes. Three attempts: enough to ride
 * out a device switch, few enough to give up rather than thrash.
 */
const TAP_RESTART_DELAYS_MS = [400, 1_200, 3_000];

/**
 * How long a restarted helper must survive before its recovery counts as a
 * success and the attempt budget is refilled.
 *
 * Starting is not the same as staying up. A helper that announces itself and
 * then dies a moment later will do so every time, and crediting it for the
 * start alone turns "three attempts then give up" into an endless restart loop.
 */
const TAP_STABLE_MS = 15_000;

export interface ActiveRecording {
  sessionId: string;
  noteId: number;
  startedAt: number;
}

export class RecordingController {
  private readonly deps: RecordingControllerDeps;
  private session: RecordingSession | null = null;
  private tap: AudioTapHost | null = null;
  private active: ActiveRecording | null = null;
  private sinks: Partial<Record<Channel, WriteStream>> = {};
  private sinkPaths: Partial<Record<Channel, string>> = {};
  private lastAudibleAt = 0;
  private silenceTimer: NodeJS.Timeout | null = null;
  private silenceWarned = false;
  private transcriptionFailed = false;
  /** How many recovery attempts have been spent on the current failure. */
  private tapAttempt = 0;
  /** The helper's own last error, carried into the status so it is not lost. */
  private lastTapError: string | null = null;
  /** Resolves the pending restart backoff early when the recording stops. */
  private cancelRestartWait: (() => void) | null = null;
  /** Fires once a restarted helper has proven it can stay up. */
  private tapStableTimer: NodeJS.Timeout | null = null;

  constructor(deps: RecordingControllerDeps) {
    this.deps = deps;
  }

  get current(): ActiveRecording | null {
    return this.active;
  }

  async start(input: { title?: string } = {}): Promise<{
    sessionId: string;
    noteId: number;
    systemAudioReady: boolean;
    systemAudioReason?: string;
  }> {
    if (this.active) throw new Error("A recording is already in progress");

    const sessionId = randomUUID();
    const noteId = this.deps.repo.createNote({ title: input.title ?? "" });
    const startedAt = Date.now();
    this.active = { sessionId, noteId, startedAt };
    this.silenceWarned = false;
    this.transcriptionFailed = false;
    this.lastAudibleAt = startedAt;

    await mkdir(this.deps.audioDir, { recursive: true });
    for (const channel of ["you", "them"] as Channel[]) {
      const file = path.join(this.deps.audioDir, `${sessionId}-${channel}.pcm`);
      this.sinkPaths[channel] = file;
      this.sinks[channel] = createWriteStream(file);
    }

    const dictionary = this.deps.repo.getDictionary();

    this.session = new RecordingSession({
      language: this.deps.language ?? "en",
      dictionary,
      transcribe: (request) =>
        this.deps.whisper.transcribe({
          pcm: request.pcm,
          language: request.language,
          initialPrompt: request.initialPrompt,
        }),
      onAudio: (channel, pcm) => {
        // FR-8: audio hits disk before anything can fail downstream.
        this.sinks[channel]?.write(pcm);
      },
      onSegment: (segment) => {
        // FR-22: persist on commit, not at the end of the meeting.
        this.deps.repo.appendSegments(noteId, [segment]);
        this.deps.onSegment?.(noteId, segment);
      },
      onError: (channel, error) => {
        this.transcriptionFailed = true;
        this.deps.onError?.(`${channel}: ${error.message}`, false);
      },
    });

    this.tapAttempt = 0;
    this.lastTapError = null;

    const tapResult = await this.startTap();
    this.emitSystemAudio(
      tapResult.systemAudioReady
        ? { state: "capturing" }
        : {
            state: tapResult.systemAudioReason === "unsupported" ? "unsupported" : "lost",
            detail:
              tapResult.systemAudioReason === "unsupported"
                ? null
                : tapResult.systemAudioReason ?? null,
          }
    );
    this.startSilenceWatchdog();

    return { sessionId, noteId, ...tapResult };
  }

  /** Microphone PCM arriving from the renderer's capture worklet. */
  pushMicAudio(pcm: Buffer): void {
    if (!this.session) return;
    this.session.pushAudio("you", pcm);
    this.deps.onLevel?.("you", computePcm16Rms(pcm));
  }

  async stop(): Promise<{ noteId: number; segmentCount: number; durationMs: number }> {
    const active = this.active;
    const session = this.session;
    if (!active || !session) throw new Error("No recording is in progress");

    this.active = null;
    this.session = null;
    this.stopSilenceWatchdog();
    // A restart waiting out its backoff would otherwise spawn a helper for a
    // recording that has already finished.
    this.cancelRestartWait?.();
    this.clearAttemptReset();

    await this.tap?.stop().catch(() => {});
    this.tap = null;

    const segments = await session.stop();
    const durationMs = Date.now() - active.startedAt;

    await this.closeSinks();
    this.deps.repo.updateNote(active.noteId, { durationMs });

    // FR-33: raw audio is discarded once every window transcribed cleanly. A
    // failure keeps it, so the meeting can be re-transcribed rather than lost.
    if (!this.deps.retainAudio && !this.transcriptionFailed) {
      await this.deleteSinkFiles();
    }

    return { noteId: active.noteId, segmentCount: segments.length, durationMs };
  }

  private async startTap(): Promise<{ systemAudioReady: boolean; systemAudioReason?: string }> {
    const tap = this.deps.createTapHost();
    if (!tap) {
      return { systemAudioReady: false, systemAudioReason: "unsupported" };
    }

    const handlers: AudioTapHandlers = {
      onChunk: (pcm) => {
        this.session?.pushAudio("them", pcm);
        const rms = computePcm16Rms(pcm);
        this.deps.onLevel?.("them", rms);
        if (rms > 0.0005) {
          this.lastAudibleAt = Date.now();
          this.silenceWarned = false;
        }
      },
      // Kept, not announced: a non-fatal helper error is not worth a banner of
      // its own, but it is very often the explanation for the exit that follows.
      onError: (error) => {
        this.lastTapError = error.message;
      },
      onExit: (code, signal) => this.handleTapExit(code, signal),
    };

    try {
      await tap.start(handlers);
      this.tap = tap;
      return { systemAudioReady: true };
    } catch (error) {
      // Mic-only is a degraded but useful recording, so this never aborts.
      return {
        systemAudioReady: false,
        systemAudioReason: (error as Error).message,
      };
    }
  }

  private emitSystemAudio(status: SystemAudioStatus): void {
    this.deps.onSystemAudioStatus?.(status);
  }

  /**
   * The helper died while a recording was running.
   *
   * Prefer its own last words over the exit code: "Aggregate device
   * disappeared" tells the user something, "exited with code 3" does not.
   */
  private handleTapExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.tap = null;
    this.clearAttemptReset();
    if (!this.active) return;

    const detail =
      this.lastTapError ??
      (signal
        ? `The audio helper was killed by ${signal}.`
        : `The audio helper exited with code ${code ?? "unknown"}.`);

    void this.recoverTap(detail);
  }

  /** Bring the helper back, with backoff, until it works or the attempts run out. */
  private async recoverTap(detail: string): Promise<void> {
    if (!this.active) return;

    const delays = this.deps.tapRestartDelaysMs ?? TAP_RESTART_DELAYS_MS;
    const delay = delays[this.tapAttempt];
    if (delay === undefined) {
      this.emitSystemAudio({ state: "lost", detail });
      return;
    }

    this.tapAttempt += 1;
    this.emitSystemAudio({
      state: "recovering",
      detail,
      attempt: this.tapAttempt,
      maxAttempts: delays.length,
    });

    await this.waitBeforeRestart(delay);
    if (!this.active) return;

    const result = await this.startTap();

    // The recording can end while the helper is starting. Without this the
    // freshly spawned process outlives the meeting: stop() has already run and
    // cleared its reference, so nobody is left to shut it down.
    if (!this.active) {
      await this.tap?.stop().catch(() => {});
      this.tap = null;
      return;
    }

    if (result.systemAudioReady) {
      this.emitSystemAudio({ state: "capturing" });
      // The budget is refilled only once it has stayed up, so a helper that
      // starts and immediately dies still runs out of attempts.
      this.scheduleAttemptReset();
      return;
    }

    await this.recoverTap(result.systemAudioReason ?? detail);
  }

  private scheduleAttemptReset(): void {
    this.clearAttemptReset();
    this.tapStableTimer = setTimeout(() => {
      this.tapAttempt = 0;
      this.lastTapError = null;
      this.tapStableTimer = null;
    }, this.deps.tapStableMs ?? TAP_STABLE_MS);
    this.tapStableTimer.unref?.();
  }

  private clearAttemptReset(): void {
    if (this.tapStableTimer) clearTimeout(this.tapStableTimer);
    this.tapStableTimer = null;
  }

  private waitBeforeRestart(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.cancelRestartWait = null;
        resolve();
      }, ms);
      timer.unref?.();
      // Resolved rather than abandoned on cancellation, so the caller reaches
      // its own `active` check and unwinds instead of leaking a pending promise.
      this.cancelRestartWait = () => {
        clearTimeout(timer);
        this.cancelRestartWait = null;
        resolve();
      };
    });
  }

  private startSilenceWatchdog(): void {
    this.stopSilenceWatchdog();
    this.silenceTimer = setInterval(() => {
      if (this.silenceWarned) return;
      if (Date.now() - this.lastAudibleAt < SILENCE_WARNING_MS) return;
      this.silenceWarned = true;
      this.deps.onSystemAudioSilent?.();
    }, 5_000);
    this.silenceTimer.unref?.();
  }

  private stopSilenceWatchdog(): void {
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = null;
  }

  private async closeSinks(): Promise<void> {
    await Promise.all(
      Object.values(this.sinks).map(
        (sink) => new Promise<void>((resolve) => sink?.end(() => resolve()))
      )
    );
    this.sinks = {};
  }

  private async deleteSinkFiles(): Promise<void> {
    await Promise.all(
      Object.values(this.sinkPaths).map((file) =>
        file ? rm(file, { force: true }).catch(() => {}) : Promise.resolve()
      )
    );
    this.sinkPaths = {};
  }
}
