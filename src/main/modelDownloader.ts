import { createWriteStream, createReadStream } from "node:fs";
import { stat, rename, unlink, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, type Writable } from "node:stream";
import { once } from "node:events";

import { looksLikeModel, type ModelSpec } from "../core/models/catalog.ts";

/**
 * Fetches the speech model on first launch.
 *
 * This runs once per machine and moves the better part of a gigabyte over
 * whatever network a laptop happens to be on, so it assumes the transfer will
 * be interrupted rather than hoping it will not:
 *
 *  - bytes land in a `.part` file and are only renamed into place once the
 *    whole thing has been verified, so a half-written model can never be
 *    mistaken for a real one;
 *  - an interrupted attempt resumes with a Range request instead of starting
 *    over, and falls back to starting over if the server ignores it;
 *  - a stalled connection is abandoned rather than hanging forever;
 *  - each source is tried in turn, so a blocked host is not fatal.
 *
 * The verification exists because of how this app has already failed once: a
 * file that is present but unusable produces a far more confusing failure than
 * a file that is missing.
 */

export interface DownloadProgress {
  receivedBytes: number;
  /** Null when the server did not say how big the file is. */
  totalBytes: number | null;
}

export interface DownloadModelOptions {
  spec: ModelSpec;
  /** Writable per-user model directory. Created if absent. */
  destDir: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
  /** Minimum gap between progress callbacks, so the UI is not flooded. */
  progressIntervalMs?: number;
  /** Abandon the attempt if no bytes arrive for this long. */
  stallTimeoutMs?: number;
}

export class ModelDownloadError extends Error {
  /** True when retrying may succeed: a cut connection, a blocked host. */
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = "ModelDownloadError";
    this.retryable = retryable;
  }
}

/**
 * Ends a write stream and waits for its buffer to reach disk. Resolves on
 * error too: a partly written file is still useful to resume from, and there
 * is nothing left to do about the error here.
 */
function closeStream(stream: Writable): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream.destroyed || stream.writableEnded) {
      stream.once("close", () => resolve());
      if (stream.destroyed) resolve();
      return;
    }
    stream.once("error", () => resolve());
    stream.end(() => resolve());
  });
}

const partPathFor = (finalPath: string): string => `${finalPath}.part`;

/** Where the model will live once installed. */
export function modelPathIn(destDir: string, spec: ModelSpec): string {
  return path.join(destDir, spec.fileName);
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function readHeader(file: string, bytes = 4): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Is this file a usable copy of the model?
 *
 * Size alone is not enough: a 404 page, a captive-portal login or a proxy
 * error all save perfectly happily under a .bin name.
 */
export async function verifyModelFile(
  file: string,
  spec: ModelSpec
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const size = await sizeOf(file);
  if (size === 0) return { ok: false, reason: "The file is empty." };
  if (size < spec.minBytes) {
    return {
      ok: false,
      reason: `The download is only ${size} bytes, far smaller than the model. The server probably returned an error page.`,
    };
  }
  if (!looksLikeModel(await readHeader(file))) {
    return { ok: false, reason: "The download is not a speech model. The server returned something else." };
  }
  if (spec.sha256) {
    const digest = await sha256Of(file);
    if (digest !== spec.sha256) {
      return { ok: false, reason: "The download is damaged; its checksum does not match." };
    }
  }
  return { ok: true };
}

/** Whether an installed, verified model is already present. */
export async function isModelInstalled(destDir: string, spec: ModelSpec): Promise<boolean> {
  const file = modelPathIn(destDir, spec);
  if ((await sizeOf(file)) === 0) return false;
  return (await verifyModelFile(file, spec)).ok;
}

/** How many bytes of a resumable attempt are already on disk. */
export async function partialBytes(destDir: string, spec: ModelSpec): Promise<number> {
  return sizeOf(partPathFor(modelPathIn(destDir, spec)));
}

/**
 * Downloads the model, resuming and falling back between sources as needed.
 *
 * @returns the path of the installed model.
 */
export async function downloadModel(options: DownloadModelOptions): Promise<string> {
  const {
    spec,
    destDir,
    onProgress,
    signal,
    fetchFn = fetch,
    progressIntervalMs = 250,
    stallTimeoutMs = 60_000,
  } = options;

  await mkdir(destDir, { recursive: true });
  const finalPath = modelPathIn(destDir, spec);
  const partPath = partPathFor(finalPath);

  // Someone may have put the model there already, by hand or by a previous run.
  if (await isModelInstalled(destDir, spec)) return finalPath;

  const failures: string[] = [];

  for (const url of spec.urls) {
    if (signal?.aborted) throw new ModelDownloadError("Download cancelled.", true);
    try {
      await fetchTo({
        url,
        partPath,
        spec,
        onProgress,
        signal,
        fetchFn,
        progressIntervalMs,
        stallTimeoutMs,
      });

      const verdict = await verifyModelFile(partPath, spec);
      if (!verdict.ok) {
        // Provably wrong content, not a short read: another attempt at the same
        // source would reproduce it, so do not leave it to be resumed.
        await unlink(partPath).catch(() => {});
        failures.push(`${hostOf(url)}: ${verdict.reason}`);
        continue;
      }

      await rename(partPath, finalPath);
      return finalPath;
    } catch (error) {
      if (signal?.aborted) throw new ModelDownloadError("Download cancelled.", true);
      failures.push(`${hostOf(url)}: ${(error as Error).message}`);
    }
  }

  throw new ModelDownloadError(
    `Could not download the speech model. ${failures.join(" ")}`.trim()
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface FetchToOptions {
  url: string;
  partPath: string;
  spec: ModelSpec;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  fetchFn: typeof fetch;
  progressIntervalMs: number;
  stallTimeoutMs: number;
}

async function fetchTo(options: FetchToOptions): Promise<void> {
  const { url, partPath, onProgress, signal, fetchFn, progressIntervalMs, stallTimeoutMs } =
    options;

  let already = await sizeOf(partPath);
  const headers: Record<string, string> = {};
  if (already > 0) headers.Range = `bytes=${already}-`;

  // A stalled transfer must not hang the app forever. This controller also
  // carries the caller's cancellation.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let watchdog: NodeJS.Timeout | undefined;
  let stalled = false;
  const armWatchdog = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallTimeoutMs);
    watchdog.unref?.();
  };

  try {
    let response = await fetchFn(url, { headers, signal: controller.signal, redirect: "follow" });

    // The part file is at or past the full length; it is stale, not resumable.
    if (response.status === 416) {
      await unlink(partPath).catch(() => {});
      already = 0;
      response = await fetchFn(url, { signal: controller.signal, redirect: "follow" });
    }

    if (!response.ok) {
      throw new ModelDownloadError(`the server answered ${response.status}.`);
    }
    if (!response.body) {
      throw new ModelDownloadError("the server sent no data.");
    }

    // A server that ignores Range replies 200 with the whole file, so the
    // bytes already on disk must be discarded rather than appended to.
    const resuming = already > 0 && response.status === 206;
    if (already > 0 && !resuming) already = 0;

    const total = totalBytesOf(response, resuming, already);

    let received = already;
    let lastReport = 0;
    const report = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastReport < progressIntervalMs) return;
      lastReport = now;
      onProgress?.({ receivedBytes: received, totalBytes: total });
    };
    report(true);

    armWatchdog();
    const out = createWriteStream(partPath, { flags: resuming ? "a" : "w" });
    try {
      for await (const chunk of Readable.fromWeb(response.body as never) as AsyncIterable<Buffer>) {
        received += chunk.length;
        armWatchdog();
        report();
        if (!out.write(chunk)) await once(out, "drain");
      }
    } finally {
      // Deliberately not `pipeline`: it destroys the write stream on error,
      // discarding whatever was still buffered. Those bytes are exactly what
      // makes the next attempt a resume rather than a restart, so the stream
      // is always ended cleanly, on the failure path too.
      await closeStream(out);
    }
    report(true);
  } catch (error) {
    if (stalled) {
      throw new ModelDownloadError(
        `the connection stalled for ${Math.round(stallTimeoutMs / 1000)}s.`
      );
    }
    if (signal?.aborted) throw new ModelDownloadError("Download cancelled.", true);
    if (error instanceof ModelDownloadError) throw error;
    throw new ModelDownloadError(`${(error as Error).message}.`);
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The full size of the file, not the size of this response. On a resumed
 * request Content-Length counts only the remaining bytes, so the total has to
 * come from Content-Range.
 */
function totalBytesOf(response: Response, resuming: boolean, already: number): number | null {
  if (resuming) {
    const range = response.headers.get("content-range");
    const match = range?.match(/\/\s*(\d+)\s*$/);
    if (match) return Number(match[1]);
    const remaining = Number(response.headers.get("content-length"));
    return Number.isFinite(remaining) && remaining > 0 ? already + remaining : null;
  }
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) && length > 0 ? length : null;
}
