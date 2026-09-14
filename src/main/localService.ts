import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Supervises a local inference server (whisper.cpp or llama.cpp) bound to
 * loopback. Both are optional at launch: if the binary is missing the app still
 * runs and the UI explains what to install, rather than failing to start.
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
}

export class LocalService {
  private readonly options: Required<Omit<LocalServiceOptions, "binaryPath" | "onLog">> & {
    binaryPath: string | null;
    onLog?: (line: string) => void;
  };
  private child: ChildProcess | null = null;
  private ready = false;

  constructor(options: LocalServiceOptions) {
    this.options = {
      readyTimeoutMs: 60_000,
      pollIntervalMs: 500,
      ...options,
    };
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isAvailable(): boolean {
    return !!this.options.binaryPath && existsSync(this.options.binaryPath);
  }

  /** @returns true when the server answers its health check. */
  async start(): Promise<boolean> {
    // Somebody may already be running one on the port (a developer, or a
    // previous run); prefer it over spawning a duplicate.
    if (await this.options.healthCheck()) {
      this.ready = true;
      return true;
    }

    if (!this.isAvailable) {
      this.options.onLog?.(`${this.options.name}: binary not found, service unavailable`);
      return false;
    }

    this.child = spawn(this.options.binaryPath as string, this.options.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (d: Buffer) =>
      this.options.onLog?.(`${this.options.name}: ${d.toString().trim()}`)
    );
    this.child.stderr?.on("data", (d: Buffer) =>
      this.options.onLog?.(`${this.options.name}: ${d.toString().trim()}`)
    );
    this.child.on("exit", (code) => {
      this.ready = false;
      this.child = null;
      this.options.onLog?.(`${this.options.name}: exited with code ${code ?? "null"}`);
    });

    this.ready = await this.waitForHealth();
    return this.ready;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = false;
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

  private async waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.options.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child === null) return false; // exited while starting
      if (await this.options.healthCheck()) return true;
      await new Promise((r) => setTimeout(r, this.options.pollIntervalMs));
    }
    this.options.onLog?.(`${this.options.name}: did not become ready in time`);
    return false;
  }
}
