import type { TranscriptionWindow } from "../audio/vadSegmenter.ts";
import type { Channel } from "../transcript/types.ts";

/**
 * One worker, oldest-audio-first, across both channels (FR-15).
 *
 * Local ASR is CPU-bound. Running the two channels concurrently oversubscribes
 * the machine during exactly the moments that matter — both people talking —
 * and makes each window slower. Serialising also means each channel's windows
 * reach the model in audio order, which is what makes the carried-context
 * prompt (FR-12) correct.
 */
export interface TranscriptionJob {
  id: string;
  channel: Channel;
  window: TranscriptionWindow;
}

export interface TranscriptionOutcome {
  job: TranscriptionJob;
  text: string;
}

export interface QueueHandlers {
  onResult?: (outcome: TranscriptionOutcome) => void | Promise<void>;
  onError?: (job: TranscriptionJob, error: Error) => void;
}

export type TranscribeFn = (job: TranscriptionJob) => Promise<string>;

export class TranscriptionQueue {
  private readonly pending: TranscriptionJob[] = [];
  private running = false;
  private stopped = false;
  private drainWaiters: Array<() => void> = [];

  private readonly transcribe: TranscribeFn;
  private readonly handlers: QueueHandlers;

  constructor(transcribe: TranscribeFn, handlers: QueueHandlers = {}) {
    this.transcribe = transcribe;
    this.handlers = handlers;
  }

  enqueue(job: TranscriptionJob): void {
    if (this.stopped) return;
    this.pending.push(job);
    void this.pump();
  }

  enqueueAll(jobs: readonly TranscriptionJob[]): void {
    for (const job of jobs) this.enqueue(job);
  }

  /** Pending jobs not yet started. Success metric M-6 watches this. */
  get depth(): number {
    return this.pending.length;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Resolves once every enqueued job has finished (successfully or not). */
  drain(): Promise<void> {
    if (!this.running && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  /** Stop accepting work. In-flight work still completes. */
  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
  }

  private takeOldest(): TranscriptionJob | undefined {
    if (this.pending.length === 0) return undefined;
    let bestIndex = 0;
    for (let i = 1; i < this.pending.length; i += 1) {
      if (this.pending[i].window.startMs < this.pending[bestIndex].window.startMs) bestIndex = i;
    }
    return this.pending.splice(bestIndex, 1)[0];
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      for (;;) {
        const job = this.takeOldest();
        if (!job) break;

        try {
          const text = await this.transcribe(job);
          await this.handlers.onResult?.({ job, text });
        } catch (error) {
          // One bad window must never stall the meeting. Report and continue.
          this.handlers.onError?.(job, error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.running = false;
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
