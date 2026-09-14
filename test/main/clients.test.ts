import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  DECODER_THRESHOLDS,
  WhisperClient,
  WhisperError,
  sanitizeTranscript,
} from "../../src/main/whisperClient.ts";
import { LlamaClient, LlamaError, SseAccumulator } from "../../src/main/llamaClient.ts";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function withServer(handler: Handler, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    req.setEncoding("latin1");
    req.on("data", (c: string) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });

// ---------------------------------------------------------------- whisper

test("sends a WAV with the language, prompt and hardened thresholds", async () => {
  let body = "";
  let url = "";

  await withServer(
    async (req, res) => {
      url = req.url ?? "";
      body = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: " the migration slipped to March " }));
    },
    async (baseUrl) => {
      const client = new WhisperClient({ baseUrl });
      const text = await client.transcribe({
        pcm: Buffer.alloc(3200),
        language: "en",
        initialPrompt: "Glossary: Kubernetes.",
      });
      assert.equal(text, "the migration slipped to March");
    }
  );

  assert.equal(url, "/inference");
  assert.match(body, /name="language"\r\n\r\nen/, "language is pinned explicitly (FR-14)");
  assert.match(body, /name="prompt"\r\n\r\nGlossary: Kubernetes\./, "initial prompt is sent (FR-12)");
  assert.match(body, /name="entropy_thold"\r\n\r\n2\.8/, "hardened thresholds are sent (FR-13)");
  assert.match(body, /name="logprob_thold"\r\n\r\n-1\.25/);
  assert.match(body, /filename="audio\.wav"/);
  assert.match(body, /RIFF/, "payload is a real WAV container");
});

test("the WAV header declares 16kHz mono 16-bit", async () => {
  let body = "";
  await withServer(
    async (req, res) => {
      body = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "ok" }));
    },
    async (baseUrl) => {
      await new WhisperClient({ baseUrl }).transcribe({ pcm: Buffer.alloc(320), language: "en" });
    }
  );

  const riffIndex = body.indexOf("RIFF");
  assert.ok(riffIndex >= 0, "expected a RIFF header");
  const header = Buffer.from(body.slice(riffIndex, riffIndex + 44), "latin1");
  assert.equal(header.readUInt16LE(22), 1, "mono");
  assert.equal(header.readUInt32LE(24), 16000, "16 kHz");
  assert.equal(header.readUInt16LE(34), 16, "16-bit");
});

test("omits the prompt field when there is no context yet", async () => {
  let body = "";
  await withServer(
    async (req, res) => {
      body = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "first window" }));
    },
    async (baseUrl) => {
      await new WhisperClient({ baseUrl }).transcribe({ pcm: Buffer.alloc(320), language: "en" });
    }
  );
  assert.doesNotMatch(body, /name="prompt"/);
});

test("a server error becomes a typed WhisperError carrying the status", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("model failed to load");
    },
    async (baseUrl) => {
      await assert.rejects(
        () => new WhisperClient({ baseUrl }).transcribe({ pcm: Buffer.alloc(320), language: "en" }),
        (error: unknown) => {
          assert.ok(error instanceof WhisperError);
          assert.equal(error.status, 500);
          assert.match(error.message, /model failed to load/);
          return true;
        }
      );
    }
  );
});

test("a malformed response is rejected rather than returned as text", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json at all");
    },
    async (baseUrl) => {
      await assert.rejects(
        () => new WhisperClient({ baseUrl }).transcribe({ pcm: Buffer.alloc(320), language: "en" }),
        /unexpected response/
      );
    }
  );
});

test("a hung server times out instead of stalling the queue", async () => {
  await withServer(
    () => {
      /* never responds */
    },
    async (baseUrl) => {
      const client = new WhisperClient({ baseUrl, timeoutMs: 150 });
      await assert.rejects(
        () => client.transcribe({ pcm: Buffer.alloc(320), language: "en" }),
        /timed out/
      );
    }
  );
});

test("an unreachable server gives an actionable message", async () => {
  const client = new WhisperClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 2_000 });
  await assert.rejects(
    () => client.transcribe({ pcm: Buffer.alloc(320), language: "en" }),
    /Could not reach the local transcription server/
  );
});

test("non-speech annotations are stripped from the transcript", () => {
  assert.equal(sanitizeTranscript("[BLANK_AUDIO]"), "");
  assert.equal(sanitizeTranscript("hello [MUSIC] world"), "hello world");
  assert.equal(sanitizeTranscript("(applause) thanks everyone"), "thanks everyone");
  assert.equal(sanitizeTranscript("  spaced   out  text "), "spaced out text");
  // Ordinary bracketed text is content and must survive.
  assert.equal(sanitizeTranscript("the [redacted] figure"), "the [redacted] figure");
});

test("thresholds are the hardened values, not whisper.cpp defaults", () => {
  assert.equal(DECODER_THRESHOLDS.entropy_thold, "2.8");
  assert.equal(DECODER_THRESHOLDS.logprob_thold, "-1.25");
});

// ------------------------------------------------------------------ llama

const sse = (payloads: string[]): string => payloads.map((p) => `data: ${p}\n\n`).join("");

const delta = (content: string): string => JSON.stringify({ choices: [{ delta: { content } }] });

test("streams note text token by token", async () => {
  const received: string[] = [];
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse([delta("## Summary"), delta("\n- We shipped"), "[DONE]"]));
    },
    async (baseUrl) => {
      const client = new LlamaClient({ baseUrl });
      const text = await client.generate({
        messages: [{ role: "user", content: "summarise" }],
        onDelta: (d) => received.push(d),
      });
      assert.equal(text, "## Summary\n- We shipped");
      assert.deepEqual(received, ["## Summary", "\n- We shipped"]);
    }
  );
});

test("sends the messages and asks for a stream", async () => {
  let body = "";
  let url = "";
  await withServer(
    async (req, res) => {
      url = req.url ?? "";
      body = await readBody(req);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse([delta("ok"), "[DONE]"]));
    },
    async (baseUrl) => {
      await new LlamaClient({ baseUrl }).generate({
        messages: [
          { role: "system", content: "you are an editor" },
          { role: "user", content: "the transcript" },
        ],
      });
    }
  );

  assert.equal(url, "/v1/chat/completions");
  const parsed = JSON.parse(body) as { stream: boolean; messages: Array<{ role: string }> };
  assert.equal(parsed.stream, true);
  assert.deepEqual(parsed.messages.map((m) => m.role), ["system", "user"]);
});

test("an error status becomes a typed LlamaError", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("no model loaded");
    },
    async (baseUrl) => {
      await assert.rejects(
        () => new LlamaClient({ baseUrl }).generate({ messages: [] }),
        (error: unknown) => {
          assert.ok(error instanceof LlamaError);
          assert.equal(error.status, 503);
          assert.match(error.message, /no model loaded/);
          return true;
        }
      );
    }
  );
});

test("generation can be cancelled by the caller", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse([delta("partial")]));
      // Then hang, so only an abort ends it.
    },
    async (baseUrl) => {
      const controller = new AbortController();
      const client = new LlamaClient({ baseUrl });
      const promise = client.generate({
        messages: [{ role: "user", content: "x" }],
        signal: controller.signal,
        onDelta: () => controller.abort(),
      });
      await assert.rejects(promise);
    }
  );
});

// --------------------------------------------------------- SSE unit tests

test("SSE events split across reads are reassembled", () => {
  const acc = new SseAccumulator();
  const payload = `data: ${delta("hello world")}\n\n`;
  const midpoint = Math.floor(payload.length / 2);

  assert.deepEqual(acc.push(payload.slice(0, midpoint)), [], "a partial event yields nothing yet");
  assert.deepEqual(acc.push(payload.slice(midpoint)), ["hello world"]);
});

test("SSE keep-alives and comments produce no deltas", () => {
  const acc = new SseAccumulator();
  assert.deepEqual(acc.push(": keep-alive\n\n"), []);
  assert.deepEqual(acc.push("\n\n"), []);
  assert.equal(acc.isDone, false);
});

test("SSE [DONE] marks the stream complete", () => {
  const acc = new SseAccumulator();
  acc.push(`data: ${delta("a")}\n\ndata: [DONE]\n\n`);
  assert.equal(acc.isDone, true);
});

test("a malformed SSE chunk is skipped rather than failing the generation", () => {
  const acc = new SseAccumulator();
  const deltas = acc.push(`data: {not json\n\ndata: ${delta("recovered")}\n\n`);
  assert.deepEqual(deltas, ["recovered"]);
});

test("multiple events arriving in one read are all returned", () => {
  const acc = new SseAccumulator();
  assert.deepEqual(acc.push(sse([delta("a"), delta("b"), delta("c")])), ["a", "b", "c"]);
});

test("the legacy completion shape is also understood", () => {
  const acc = new SseAccumulator();
  const legacy = JSON.stringify({ choices: [{ text: "older shape" }] });
  assert.deepEqual(acc.push(`data: ${legacy}\n\n`), ["older shape"]);
});
