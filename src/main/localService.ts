import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Supervises a local inference server (whisper.cpp or llama.cpp) bound to
 * loopback. Both are optional at launch: if the binary is missing the app still
 * runs and the UI explains what to install, rather than failing to start.
 *
 * Everything the child process prints is captured. The first version of this
 * class threw that output away, so when the speech engine failed to launch on a
 * real machine the app could only report "fetch failed" and the actual reason
 * (a missing shared library) was invisible.
 */
export interface LocalServiceOptions {
  name: string;
  binaryPath: string | null;
  args: string[];
  /** Polled until it answers true, or the timeout elapses. */
  healthCheck: () => Promise<boolean>;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  onLog?: (line: string) => void;
  /** Lines of child output to retain for diagnostics. */
  logLimit?: number;
}

export type ServiceState = "idle" | "starting" | "ready" | "failed";

export class LocalService {
  private readonly options: Required<Omit<LocalServiceOptions, "binaryPath" | "onLog">> & {
    binaryPath: string | null;
    onLog?: (line: string) => void;
  };
  private child: ChildProcess | null = null;
  private state: ServiceState = "idle";
  private failureReason: string | null = null;
  private readonly recentOutput: string[] = [];

  constructor(options: LocalServiceOptions) {
    this.options = {
      readyTimeoutMs: 60_000,
      pollIntervalMs: 500,
      logLimit: 40,
      ...options,
    };
  }

  get isReady(): boolean {
    return this.state === "ready";
  }

  get status(): ServiceState {
    return this.state;
  }

  /** Why the service is not running, in words a user can act on. */
  get reason(): string | null {
    return this.failureReason;
  }

  /** The child's most recent output, for a diagnostics view or a bug report. */
  get log(): string[] {
    return [...this.recentOutput];
  }

  get isAvailable(): boolean {
    return !!this.options.binaryPath && existsSync(this.options.binaryPath);
  }

  /** @returns true when the server answers its health check. */
  async start(): Promise<boolean> {
    this.failureReason = null;
    this.state = "starting";

    // Somebody may already be running one on the port (a developer, or a
    // previous run); prefer it over spawning a duplicate.
    if (await this.options.healthCheck()) {
      this.state = "ready";
      return true;
    }

    if (!this.options.binaryPath) {
      return this.fail("Not configured. No model is selected, so the server was not started.");
    }
    if (!existsSync(this.options.binaryPath)) {
      return this.fail(`Program is missing from the app: ${this.options.binaryPath}`);
    }

    try {
      this.child = spawn(this.options.binaryPath, this.options.args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return this.fail(`Could not launch: ${(error as Error).message}`);
    }

    this.child.stdout?.on("data", (d: Buffer) => this.record(d.toString()));
    this.child.stderr?.on("data", (d: Buffer) => this.record(d.toString()));

    this.child.on("error", (error: Error) => {
      this.record(`launch error: ${error.message}`);
    });

    let exitInfo: string | null = null;
    this.child.on("exit", (code, signal) => {
      this.child = null;
      exitInfo = signal ? `killed by ${signal}` : `exited with code ${code ?? "null"}`;
      this.record(exitInfo);
      if (this.state !== "ready") this.state = "failed";
    });

    const healthy = await this.waitForHealth();
    if (healthy) {
      this.state = "ready";
      return true;
    }

    // Prefer the child's own words over a generic timeout message: a missing
    // shared library or an unreadable model says so on stderr.
    const explanation = this.explainFromOutput();
    if (explanation) return this.fail(explanation);
    if (exitInfo) return this.fail(`The server ${exitInfo} during startup.`);
    return this.fail(`The server did not answer within ${this.options.readyTimeoutMs / 1000}s.`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.state = "idle";
    if (!child) return;

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3_000).unref?.();
    });
  }

  private fail(reason: string): false {
    this.state = "failed";
    this.failureReason = reason;
    this.options.onLog?.(`${this.options.name}: ${reason}`);
    return false;
  }

  private record(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.recentOutput.push(trimmed);
      if (this.recentOutput.length > this.options.logLimit) this.recentOutput.shift();
      this.options.onLog?.(`${this.options.name}: ${trimmed}`);
    }
  }

  /**
   * Turn the child's output into something a user can act on.
   *
   * The dyld case is the one that actually bit: a binary copied out of its
   * build tree without its shared libraries dies before printing anything of
   * its own, and the only clue is the loader's own error.
   */
  private explainFromOutput(): string | null {
    const text = this.recentOutput.join("\n");
    if (/library not loaded|image not found|dyld|symbol not found/i.test(text)) {
      return "The program is missing libraries it needs. This build is incomplete; please report it.";
    }
    if (/failed to (load|open|read) model|no such file|cannot open/i.test(text)) {
      return "The speech model could not be read. It may be missing or damaged.";
    }
    if (/address already in use|bind/i.test(text)) {
      return "The port it needs is already in use by another program.";
    }
    const lastLine = this.recentOutput[this.recentOutput.length - 1];
    return lastLine ? `Startup failed: ${lastLine}` : null;
  }

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.options.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child === null) return false; // exited while starting
      if (await this.options.healthCheck()) return true;
      await new Promise((r) => setTimeout(r, this.options.pollIntervalMs));
    }
    return false;
  }
}
