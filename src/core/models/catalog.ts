/**
 * The speech model the app uses, and how to recognise a good copy of it.
 *
 * The model is no longer shipped inside the .dmg. At 874 MB it was five times
 * the size of everything else combined, and welding it into the bundle meant
 * every bug fix cost another full download of it. It is fetched once on first
 * launch instead and lives in the user's application-support folder, where
 * `resolveModelPath` already prefers it.
 *
 * Pure: no filesystem, no network, no Electron, so the rules are testable.
 */

/** Which engine a model feeds. */
export type ModelKind = "speech" | "language";

export interface ModelSpec {
  kind: ModelKind;
  /** Stable identifier, used in settings and logs. */
  id: string;
  /** File name on disk. Also the name whisper.cpp is pointed at. */
  fileName: string;
  /** Shown to the user. Never a filename. */
  displayName: string;
  /** One line explaining the trade-off this model makes. */
  description: string;
  /**
   * Rough size, for "this will download about X" before a request is made.
   * The real total comes from the server's Content-Length; this is only ever
   * used for display, so being a few megabytes out is harmless.
   */
  approxBytes: number;
  /**
   * Smallest plausible size for a real copy. A 404 page, an error JSON or a
   * connection cut halfway all produce a file; this is what distinguishes them
   * from a model. Deliberately far below `approxBytes`.
   */
  minBytes: number;
  /**
   * Expected digest, once known. The publishing workflow prints it and it gets
   * pinned here. Null means the download is verified by size and header only,
   * which catches truncation and error pages but not corruption.
   */
  sha256: string | null;
  /**
   * Tried in order. The project's own release first: Hugging Face is rate
   * limited and blocked on plenty of corporate networks, which is exactly
   * where a meeting recorder runs. Hugging Face stays as the fallback so the
   * app still works before the release has been published.
   */
  urls: string[];
}

/**
 * 8-bit quantisation of large-v3-turbo. Same model as the 16-bit original,
 * fewer bits per weight: about half the size and half the memory, with a
 * quality cost small enough not to be worth the gigabyte.
 */
export const WHISPER_MODEL: ModelSpec = Object.freeze({
  kind: "speech",
  id: "large-v3-turbo-q8_0",
  fileName: "ggml-large-v3-turbo-q8_0.bin",
  displayName: "Whisper large-v3-turbo",
  description: "The accurate model, 8-bit. Runs faster than real time on Apple Silicon.",
  approxBytes: 874_000_000,
  minBytes: 600_000_000,
  sha256: null,
  urls: [
    "https://github.com/shaunleeweirong/granola-alternative/releases/download/models/ggml-large-v3-turbo-q8_0.bin",
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
  ],
});

/**
 * The model that writes the notes, run by llama.cpp.
 *
 * Optional and downloaded on demand: transcription is the product, and a
 * two-gigabyte model has no business in the path of someone who only wants a
 * transcript. 3B at 4-bit is about the floor for following a structured
 * summarisation prompt; smaller models drift off the requested format.
 *
 * Swapping it is one edit here plus a run of publish-model.yml.
 */
export const LANGUAGE_MODEL: ModelSpec = Object.freeze({
  kind: "language",
  id: "llama-3.2-3b-instruct-q4_k_m",
  fileName: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
  displayName: "Llama 3.2 3B Instruct",
  description: "Writes the summary, action items and decisions from a transcript.",
  approxBytes: 2_020_000_000,
  minBytes: 1_200_000_000,
  sha256: null,
  urls: [
    "https://github.com/shaunleeweirong/granola-alternative/releases/download/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
  ],
});

/** Every model the app knows how to fetch, by kind. */
export const MODELS: Record<ModelKind, ModelSpec> = Object.freeze({
  speech: WHISPER_MODEL,
  language: LANGUAGE_MODEL,
});

/**
 * Whether the first bytes of a file look like a model rather than an error.
 *
 * whisper.cpp reads a uint32 magic of 0x67676d6c, so on a little-endian
 * machine the file opens with the bytes `lmgg`. GGUF-era files spell `GGUF`
 * outright. Both are accepted, and so is the big-endian spelling, because the
 * job here is to reject an HTML error page saved under a .bin name, not to
 * authenticate the file.
 */
export function looksLikeModel(header: Uint8Array): boolean {
  if (header.length < 4) return false;
  const ascii = String.fromCharCode(header[0]!, header[1]!, header[2]!, header[3]!);
  return ascii === "lmgg" || ascii === "ggml" || ascii === "GGUF";
}

/** Bytes as a short human string. Used in the download panel. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Download progress as a fraction, or null when the server did not say how
 * big the file is. The UI shows an indeterminate bar rather than inventing a
 * percentage it cannot know.
 */
export function progressFraction(received: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(1, Math.max(0, received / total));
}
