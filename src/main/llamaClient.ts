import type { ChatMessage } from "../core/notes/notePrompt.ts";

/**
 * Client for a locally spawned `llama-server` (llama.cpp), bound to loopback.
 * It exposes an OpenAI-shaped chat endpoint; nothing here reaches the network.
 */
export interface LlamaClientOptions {
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Called with each token as it arrives (FR-26). */
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export class LlamaError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlamaError";
    this.status = status;
  }
}

/**
 * Extracts text deltas from a Server-Sent Events stream.
 *
 * Kept separate from the transport so the parsing rules that actually bite —
 * an event split across two network reads, `[DONE]`, blank keep-alive lines,
 * multi-line data — are unit-testable without a socket.
 */
export class SseAccumulator {
  private buffer = "";
  private done = false;

  get isDone(): boolean {
    return this.done;
  }

  /** @returns the text deltas contained in this piece of the stream. */
  push(piece: string): string[] {
    this.buffer += piece;
    const deltas: string[] = [];

    // Events are separated by a blank line; a trailing partial event stays in
    // the buffer until the rest of it arrives.
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);

      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (data === "[DONE]") {
        this.done = true;
      } else if (data) {
        const delta = this.extractDelta(data);
        if (delta) deltas.push(delta);
      }

      boundary = this.buffer.indexOf("\n\n");
    }

    return deltas;
  }

  private extractDelta(data: string): string {
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: unknown }; text?: unknown }>;
      };
      const choice = parsed.choices?.[0];
      if (typeof choice?.delta?.content === "string") return choice.delta.content;
      if (typeof choice?.text === "string") return choice.text;
      return "";
    } catch {
      // A malformed chunk is not worth failing a whole generation over.
      return "";
    }
  }
}

export class LlamaClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: LlamaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model ?? "local";
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async generate(options: GenerateOptions): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: options.messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 2048,
          stream: true,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LlamaError(
          `Note generation failed (${response.status}): ${body.slice(0, 200)}`,
          response.status
        );
      }
      if (!response.body) throw new LlamaError("Note generation returned no stream");

      const accumulator = new SseAccumulator();
      const decoder = new TextDecoder();
      let full = "";

      for await (const piece of streamChunks(response.body)) {
        for (const delta of accumulator.push(decoder.decode(piece, { stream: true }))) {
          full += delta;
          options.onDelta?.(delta);
        }
        if (accumulator.isDone) break;
      }

      return full.trim();
    } catch (error) {
      if (error instanceof LlamaError) throw error;
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw new LlamaError(`Note generation timed out after ${this.timeoutMs}ms`);
      }
      throw new LlamaError(
        `Could not reach the local language model: ${(error as Error).message}`
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/health`, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }
}

async function* streamChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
