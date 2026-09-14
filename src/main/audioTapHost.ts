import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** stdio is ["ignore", "pipe", "pipe"], so stdin is null and both readers exist. */
type TapProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Supervises the macOS system-audio helper (native/macos-audio-tap).
 *
 * The helper speaks two streams: raw 16 kHz mono PCM16 on stdout, and
 * line-delimited JSON events on stderr. Both need care that is easy to get
 * wrong — stdout reads can split a sample across two chunks, and a stderr read
 * can split a JSON line — so both are re-aligned here.
 */
export interface TapEvent {
  type: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface AudioTapHandlers {
  onChunk: (pcm: Buffer) => void;
  onEvent?: (event: TapEvent) => void;
  onError?: (error: Error) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface AudioTapOptions {
  command: string;
  args?: string[];
  /** How long to wait for the helper's `start` event before giving up. */
  startTimeoutMs?: number;
  spawnFn?: typeof spawn;
}

export class TapStartError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TapStartError";
    this.code = code;
  }
}

export class AudioTapHost {
  private readonly options: Required<Omit<AudioTapOptions, "spawnFn">> & {
    spawnFn: typeof spawn;
  };
  private child: TapProcess | null = null;
  private handlers: AudioTapHandlers | null = null;
  /** Odd trailing byte from a stdout read; a sample must not be split. */
  private sampleCarry: Buffer = Buffer.alloc(0);
  /** Partial trailing line from a stderr read. */
  private lineCarry = "";
  private stopping = false;

  constructor(options: AudioTapOptions) {
    this.options = {
      command: options.command,
      args: options.args ?? [],
      startTimeoutMs: options.startTimeoutMs ?? 5_000,
      spawnFn: options.spawnFn ?? spawn,
    };
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Resolves once the helper reports it is capturing; rejects otherwise. */
  start(handlers: AudioTapHandlers): Promise<void> {
    if (this.child) return Promise.reject(new Error("Audio tap is already running"));

    this.handlers = handlers;
    this.stopping = false;
    this.sampleCarry = Buffer.alloc(0);
    this.lineCarry = "";

    const child = this.options.spawnFn(this.options.command, this.options.args, {
      stdio: ["ignore", "pipe", "pipe"],
    }) as TapProcess;
    this.child = child;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.killChild();
          reject(error);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => {
        settle(new TapStartError("start_timeout", "System audio helper did not start in time"));
      }, this.options.startTimeoutMs);

      child.stdout.on("data", (data: Buffer) => this.handleAudio(data));
      child.stderr.on("data", (data: Buffer) => {
        for (const event of this.parseEvents(data)) {
          this.handlers?.onEvent?.(event);

          if (event.type === "start") settle();
          if (event.type === "error") {
            const error = new TapStartError(
              event.code ?? "tap_error",
              event.message ?? "System audio capture failed"
            );
            if (settled) this.handlers?.onError?.(error);
            else settle(error);
          }
        }
      });

      child.on("error", (error: Error) => {
        if (settled) this.handlers?.onError?.(error);
        else settle(error);
      });

      child.on("exit", (code, signal) => {
        this.child = null;
        if (!settled) {
          settle(
            new TapStartError(
              "exited_early",
              `System audio helper exited before starting (code ${code ?? "null"})`
            )
          );
          return;
        }
        if (!this.stopping) this.handlers?.onExit?.(code, signal);
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;

    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once("exit", done);
      child.kill("SIGTERM");
      // The helper flushes and exits on SIGTERM; if it does not, do not hang.
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 2_000).unref?.();
    });

    this.child = null;
    this.handlers = null;
  }

  /**
   * Forward whole samples only. A stdout read boundary can land mid-sample, and
   * passing an odd byte count downstream shifts every following sample by one
   * byte, which turns the stream into noise.
   */
  private handleAudio(data: Buffer): void {
    const combined =
      this.sampleCarry.length === 0 ? data : Buffer.concat([this.sampleCarry, data]);
    const usableBytes = combined.length - (combined.length % 2);

    if (usableBytes > 0) {
      this.handlers?.onChunk(combined.subarray(0, usableBytes));
    }
    this.sampleCarry =
      usableBytes === combined.length ? Buffer.alloc(0) : Buffer.from(combined.subarray(usableBytes));
  }

  /** Parse whole JSON lines, holding any partial trailing line for the next read. */
  private parseEvents(data: Buffer): TapEvent[] {
    this.lineCarry += data.toString("utf8");
    const lines = this.lineCarry.split("\n");
    this.lineCarry = lines.pop() ?? "";

    const events: TapEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as TapEvent;
        if (parsed && typeof parsed.type === "string") events.push(parsed);
      } catch {
        // The helper only ever writes JSON; anything else is a crash log from
        // the runtime and is surfaced rather than swallowed.
        this.handlers?.onEvent?.({ type: "log", message: trimmed });
      }
    }
    return events;
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill("SIGKILL");
  }
}
