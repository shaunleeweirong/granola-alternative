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
}

/** Warn if the tap has produced nothing audible for this long (FR-7). */
const SILENCE_WARNING_MS = 45_000;

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

    const tapResult = await this.startTap();
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
      onError: (error) => this.deps.onError?.(error.message, false),
      onExit: () => this.deps.onError?.("System audio capture stopped unexpectedly", false),
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
