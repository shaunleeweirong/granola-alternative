import { pcm16ToWav } from "../core/audio/format.ts";

/**
 * Client for a locally spawned `whisper-server` (whisper.cpp), bound to
 * loopback. Nothing here reaches the network (FR-34).
 */

/**
 * FR-13: hardened decoder thresholds.
 *
 * whisper.cpp's defaults let a low-confidence decode through rather than
 * re-decoding at a higher temperature, which on near-silent audio produces
 * training-data boilerplate ("Thank you for watching", "Продолжение следует").
 * The reference implementation raised these for dictation but explicitly
 * reverted to defaults for meetings to save CPU — while feeding the model the
 * short, often quiet windows that provoke exactly that failure.
 *
 * Windows here are 15-30 s and silence-bounded, so the re-decode cost is paid
 * far less often than it would be on a 5 s timer.
 */
export const DECODER_THRESHOLDS = Object.freeze({
  entropy_thold: "2.8",
  logprob_thold: "-1.25",
});

/**
 * Bracketed non-speech annotations whisper emits for music, silence and noise.
 * They are not transcript and must not reach the notes.
 */
const NON_SPEECH_TAG = /[[(](?:blank_?audio|silence|music|sound|applause|laughter|inaudible)[\])]/gi;

export function sanitizeTranscript(raw: string): string {
  return raw
    .replace(NON_SPEECH_TAG, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WhisperClientOptions {
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface WhisperRequest {
  pcm: Buffer;
  language: string;
  initialPrompt?: string;
  signal?: AbortSignal;
}

export class WhisperError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "WhisperError";
    this.status = status;
  }
}

export class WhisperClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: WhisperClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async transcribe(request: WhisperRequest): Promise<string> {
    const wav = pcm16ToWav(request.pcm);
    // Copy into a plain ArrayBuffer: a node Buffer may be backed by a pooled or
    // shared buffer, which is not a valid BlobPart.
    const wavBytes = new Uint8Array(wav.byteLength);
    wavBytes.set(wav);

    const form = new FormData();
    form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");
    // FR-14: always explicit. Left to "auto", short turns ("yeah", "right")
    // mis-detect and the decoder emits another language entirely.
    form.append("language", request.language);
    if (request.initialPrompt) form.append("prompt", request.initialPrompt);
    for (const [key, value] of Object.entries(DECODER_THRESHOLDS)) form.append(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/inference`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && !request.signal?.aborted) {
        throw new WhisperError(`Transcription timed out after ${this.timeoutMs}ms`);
      }
      throw new WhisperError(
        `Could not reach the local transcription server: ${(error as Error).message}`
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new WhisperError(
        `Transcription failed (${response.status}): ${body.slice(0, 200)}`,
        response.status
      );
    }

    const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
    if (!payload || typeof payload.text !== "string") {
      throw new WhisperError("Transcription server returned an unexpected response");
    }

    return sanitizeTranscript(payload.text);
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/`, { method: "GET" });
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }
}
