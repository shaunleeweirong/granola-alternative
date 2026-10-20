import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import type { MicUser } from "../core/autoStop.ts";

/** stdio is ["ignore", "pipe", "pipe"], so stdin is null and both readers exist. */
type DetectorProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Supervises the macOS meeting detector (native/meeting-detector).
 *
 * The helper writes line-delimited JSON on stdout: a `start` event, then a
 * `mic` event listing every process using a microphone, again each time that
 * list changes. Deciding which of them is the call is left to the caller.
 */
export interface MeetingDetectorHandlers {
  onMicUsers: (users: MicUser[]) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** The part of the detector the auto-stop monitor needs. Narrow, so tests can stand in. */
export interface MicDetector {
  start(handlers: MeetingDetectorHandlers): Promise<void>;
  stop(): Promise<void>;
}

export interface MeetingDetectorOptions {
  command: string;
  args?: string[];
  /** How long to wait for the helper's `start` event before giving up. */
  startTimeoutMs?: number;
  spawnFn?: typeof spawn;
}

export class MeetingDetector implements MicDetector {
  private readonly options: Required<Omit<MeetingDetectorOptions, "spawnFn">> & {
    spawnFn: typeof spawn;
  };
  private child: DetectorProcess | null = null;
  /** Partial trailing line from a stdout read. */
  private lineCarry = "";
  private stopping = false;

  constructor(options: MeetingDetectorOptions) {
    this.options = {
      command: options.command,
      args: options.args ?? [],
      startTimeoutMs: options.startTimeoutMs ?? 5_000,
      spawnFn: options.spawnFn ?? spawn,
    };
  }

  /** Resolves once the helper reports it is watching; rejects otherwise. */
  start(handlers: MeetingDetectorHandlers): Promise<void> {
    if (this.child) return Promise.reject(new Error("Meeting detector is already running"));

    this.stopping = false;
    this.lineCarry = "";

    const child = this.options.spawnFn(this.options.command, this.options.args, {
      stdio: ["ignore", "pipe", "pipe"],
    }) as DetectorProcess;
    this.child = child;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.child = null;
          child.kill("SIGKILL");
          reject(error);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => {
        settle(new Error("Meeting detector did not start in time"));
      }, this.options.startTimeoutMs);

      child.stdout.on("data", (data: Buffer) => {
        for (const event of this.parseEvents(data)) {
          if (event.type === "start") settle();
          if (event.type === "mic" && Array.isArray(event.users)) {
            handlers.onMicUsers(event.users.filter(isMicUser));
          }
        }
      });
      // Only ever crash output from the runtime; the protocol is all on stdout.
      child.stderr.on("data", () => {});

      child.on("error", (error: Error) => settle(error));

      child.on("exit", (code, signal) => {
        this.child = null;
        if (!settled) {
          settle(new Error(`Meeting detector exited before starting (code ${code ?? "null"})`));
          return;
        }
        if (!this.stopping) handlers.onExit?.(code, signal);
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 2_000).unref?.();
    });

    this.child = null;
  }

  /** Parse whole JSON lines, holding any partial trailing line for the next read. */
  private parseEvents(data: Buffer): Array<{ type: string; users?: unknown }> {
    this.lineCarry += data.toString("utf8");
    const lines = this.lineCarry.split("\n");
    this.lineCarry = lines.pop() ?? "";

    const events: Array<{ type: string; users?: unknown }> = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { type?: unknown; users?: unknown };
        if (parsed && typeof parsed.type === "string") events.push({ type: parsed.type, users: parsed.users });
      } catch {
        // Not part of the protocol. Ignored rather than fatal: a stray line
        // must not take down detection for the rest of the meeting.
      }
    }
    return events;
  }
}

function isMicUser(value: unknown): value is MicUser {
  const user = value as Partial<MicUser> | null;
  return typeof user?.pid === "number" && typeof user.bundleId === "string";
}
