import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  downloadModel,
  isModelInstalled,
  verifyModelFile,
  partialBytes,
  ModelDownloadError,
} from "../../src/main/modelDownloader.ts";
import type { ModelSpec } from "../../src/core/models/catalog.ts";

/** A stand-in model: a real ggml header followed by filler. */
const MODEL_BODY = Buffer.concat([
  Buffer.from("lmgg", "ascii"),
  Buffer.alloc(4_000, 0x42),
]);

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function specFor(urls: string[], overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id: "test-model",
    fileName: "test-model.bin",
    displayName: "Test model",
    description: "",
    approxBytes: MODEL_BODY.length,
    minBytes: 1_000,
    sha256: null,
    urls,
    ...overrides,
  };
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/test-model.bin`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Serves the body whole, honouring Range requests. */
const rangeAwareHandler =
  (body: Buffer, seen?: string[]): Handler =>
  (req, res) => {
    const range = req.headers.range;
    seen?.push(range ?? "");
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      if (start >= body.length) {
        res.writeHead(416, { "content-range": `bytes */${body.length}` });
        res.end();
        return;
      }
      const slice = body.subarray(start);
      res.writeHead(206, {
        "content-length": String(slice.length),
        "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "content-length": String(body.length) });
    res.end(body);
  };

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ga-model-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("downloads and installs the model", async (t) => {
  const server = await serve(rangeAwareHandler(MODEL_BODY));
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const installed = await downloadModel({ spec: specFor([server.url]), destDir: dir });

  assert.equal(path.basename(installed), "test-model.bin");
  assert.deepEqual(await readFile(installed), MODEL_BODY);
  assert.equal(await isModelInstalled(dir, specFor([server.url])), true);
});

test("no .part file survives a successful download", async (t) => {
  const server = await serve(rangeAwareHandler(MODEL_BODY));
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor([server.url]);
  await downloadModel({ spec, destDir: dir });

  // The rename is what makes a half-written model impossible to mistake for a
  // real one, so prove it actually happened.
  assert.equal(await partialBytes(dir, spec), 0);
});

test("an error page saved under a .bin name is rejected, not installed", async (t) => {
  // The failure this whole verification step exists for. A 404 page, a proxy
  // error or a captive-portal login all save perfectly happily.
  const page = Buffer.from("<!DOCTYPE html><title>404 Not Found</title>", "ascii");
  const server = await serve((_req, res) => {
    res.writeHead(200, { "content-length": String(page.length) });
    res.end(page);
  });
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor([server.url]);
  await assert.rejects(
    () => downloadModel({ spec, destDir: dir }),
    (error: Error) => {
      assert.ok(error instanceof ModelDownloadError);
      assert.match(error.message, /error page|not a speech model/i);
      return true;
    }
  );
  assert.equal(await isModelInstalled(dir, spec), false);
  assert.equal(await partialBytes(dir, spec), 0, "and the bad bytes are not left to be resumed");
});

test("an interrupted download resumes instead of starting over", async (t) => {
  const seenRanges: string[] = [];
  let attempt = 0;
  const server = await serve((req, res) => {
    attempt += 1;
    seenRanges.push(req.headers.range ?? "");
    if (attempt === 1) {
      // Promise the whole file, then cut the connection halfway. The bytes are
      // flushed before the socket dies, as they would be in a real drop;
      // destroying immediately would fail the request before any data arrived.
      res.writeHead(200, { "content-length": String(MODEL_BODY.length) });
      res.write(MODEL_BODY.subarray(0, 1_500), () => setTimeout(() => res.destroy(), 10));
      return;
    }
    rangeAwareHandler(MODEL_BODY)(req, res);
  });
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor([server.url]);

  await assert.rejects(() => downloadModel({ spec, destDir: dir }));
  const carried = await partialBytes(dir, spec);
  assert.ok(carried > 0, "the partial download is kept");

  const installed = await downloadModel({ spec, destDir: dir });

  assert.deepEqual(await readFile(installed), MODEL_BODY);
  assert.match(seenRanges[1] ?? "", /^bytes=\d+-$/, "the retry asked to resume");
  assert.equal(seenRanges[1], `bytes=${carried}-`, "from exactly where it stopped");
});

test("a server that ignores Range is handled by starting over", async (t) => {
  // Plenty of CDNs and corporate proxies answer 200 with the whole file no
  // matter what was asked. Appending to the existing bytes would corrupt it.
  const server = await serve((_req, res) => {
    res.writeHead(200, { "content-length": String(MODEL_BODY.length) });
    res.end(MODEL_BODY);
  });
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor([server.url]);
  await writeFile(path.join(dir, "test-model.bin.part"), Buffer.alloc(900, 0x99));

  const installed = await downloadModel({ spec, destDir: dir });

  assert.deepEqual(await readFile(installed), MODEL_BODY, "stale bytes discarded, not appended");
});

test("a stale .part at or past the full length is discarded", async (t) => {
  const server = await serve(rangeAwareHandler(MODEL_BODY));
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor([server.url]);
  // Longer than the real file: the server answers 416 rather than 206.
  await writeFile(path.join(dir, "test-model.bin.part"), Buffer.alloc(MODEL_BODY.length + 50, 1));

  const installed = await downloadModel({ spec, destDir: dir });
  assert.deepEqual(await readFile(installed), MODEL_BODY);
});

test("a blocked source falls back to the next one", async (t) => {
  // The reason the project's own release is listed ahead of Hugging Face: one
  // host being unreachable must not be fatal.
  const blocked = await serve((_req, res) => {
    res.writeHead(403);
    res.end("forbidden");
  });
  t.after(blocked.close);
  const working = await serve(rangeAwareHandler(MODEL_BODY));
  t.after(working.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const installed = await downloadModel({
    spec: specFor([blocked.url, working.url]),
    destDir: dir,
  });

  assert.deepEqual(await readFile(installed), MODEL_BODY);
});

test("when every source fails the error names each one", async (t) => {
  const blocked = await serve((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  t.after(blocked.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  await assert.rejects(
    () => downloadModel({ spec: specFor([blocked.url, `${blocked.url}?second`]), destDir: dir }),
    (error: Error) => {
      assert.match(error.message, /403/);
      assert.equal(error.message.match(/127\.0\.0\.1/g)?.length, 2, "both sources reported");
      return true;
    }
  );
});

test("progress is reported and ends at the full size", async (t) => {
  const server = await serve(rangeAwareHandler(MODEL_BODY));
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const updates: { receivedBytes: number; totalBytes: number | null }[] = [];
  await downloadModel({
    spec: specFor([server.url]),
    destDir: dir,
    progressIntervalMs: 0,
    onProgress: (p) => updates.push(p),
  });

  assert.ok(updates.length >= 2, "at least a start and a finish");
  assert.equal(updates[0]!.receivedBytes, 0);
  assert.equal(updates.at(-1)!.receivedBytes, MODEL_BODY.length);
  assert.equal(updates.at(-1)!.totalBytes, MODEL_BODY.length);
});

test("progress reports an unknown total rather than inventing one", async (t) => {
  // Chunked responses carry no Content-Length. The UI shows an indeterminate
  // bar; it must not be fed a fabricated percentage.
  const server = await serve((_req, res) => {
    res.writeHead(200);
    res.end(MODEL_BODY);
  });
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const totals: (number | null)[] = [];
  await downloadModel({
    spec: specFor([server.url]),
    destDir: dir,
    progressIntervalMs: 0,
    onProgress: (p) => totals.push(p.totalBytes),
  });

  assert.ok(totals.every((t) => t === null));
});

test("a resumed download reports the full size, not the remaining size", async (t) => {
  const server = await serve(rangeAwareHandler(MODEL_BODY));
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor([server.url]);
  await writeFile(path.join(dir, "test-model.bin.part"), MODEL_BODY.subarray(0, 1_000));

  const updates: { receivedBytes: number; totalBytes: number | null }[] = [];
  await downloadModel({
    spec,
    destDir: dir,
    progressIntervalMs: 0,
    onProgress: (p) => updates.push(p),
  });

  // Content-Length on a 206 counts only what is left, so a naive reading would
  // show the bar jumping backwards and finishing at 400%.
  assert.equal(updates[0]!.totalBytes, MODEL_BODY.length);
  assert.equal(updates[0]!.receivedBytes, 1_000, "and counts what is already on disk");
});

test("cancelling stops the download and keeps what arrived", async (t) => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { "content-length": String(MODEL_BODY.length) });
    res.write(MODEL_BODY.subarray(0, 500));
    // Never finishes, so only the cancellation can end this.
  });
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const controller = new AbortController();
  const spec = specFor([server.url]);
  const pending = downloadModel({ spec, destDir: dir, signal: controller.signal });
  setTimeout(() => controller.abort(), 100).unref();

  await assert.rejects(pending, /cancelled/i);
  assert.equal(await isModelInstalled(dir, spec), false);
});

test("a stalled connection is abandoned rather than hanging forever", async (t) => {
  const server = await serve((_req, res) => {
    res.writeHead(200, { "content-length": String(MODEL_BODY.length) });
    res.write(MODEL_BODY.subarray(0, 100));
    // and then nothing, ever.
  });
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  await assert.rejects(
    () => downloadModel({ spec: specFor([server.url]), destDir: dir, stallTimeoutMs: 200 }),
    /stalled/i
  );
});

test("a checksum mismatch is caught when a digest is known", async (t) => {
  const server = await serve(rangeAwareHandler(MODEL_BODY));
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor([server.url], { sha256: sha256(Buffer.from("something else")) });

  await assert.rejects(() => downloadModel({ spec, destDir: dir }), /damaged|checksum/i);
  assert.equal(await isModelInstalled(dir, spec), false);
});

test("a matching checksum installs normally", async (t) => {
  const server = await serve(rangeAwareHandler(MODEL_BODY));
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor([server.url], { sha256: sha256(MODEL_BODY) });
  const installed = await downloadModel({ spec, destDir: dir });
  assert.deepEqual(await readFile(installed), MODEL_BODY);
});

test("an already-installed model is not downloaded again", async (t) => {
  let requests = 0;
  const server = await serve((req, res) => {
    requests += 1;
    rangeAwareHandler(MODEL_BODY)(req, res);
  });
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor([server.url]);
  await writeFile(path.join(dir, "test-model.bin"), MODEL_BODY);

  await downloadModel({ spec, destDir: dir });
  assert.equal(requests, 0, "874 MB is not re-fetched because the app restarted");
});

test("a truncated model already on disk is not treated as installed", async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const spec = specFor(["https://example.invalid/test-model.bin"]);
  await writeFile(path.join(dir, "test-model.bin"), MODEL_BODY.subarray(0, 200));

  assert.equal(await isModelInstalled(dir, spec), false);
  const verdict = await verifyModelFile(path.join(dir, "test-model.bin"), spec);
  assert.equal(verdict.ok, false);
});

test("the destination directory is created if it does not exist", async (t) => {
  const server = await serve(rangeAwareHandler(MODEL_BODY));
  t.after(server.close);
  const { dir, cleanup } = await tempDir();
  t.after(cleanup);

  const nested = path.join(dir, "Application Support", "Meeting Notes", "models");
  const installed = await downloadModel({ spec: specFor([server.url]), destDir: nested });
  assert.ok((await stat(installed)).size > 0);
});
