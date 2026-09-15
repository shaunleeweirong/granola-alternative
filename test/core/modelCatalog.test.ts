import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WHISPER_MODEL,
  looksLikeModel,
  formatBytes,
  progressFraction,
} from "../../src/core/models/catalog.ts";

test("the shipped model entry is coherent", () => {
  assert.ok(WHISPER_MODEL.fileName.endsWith(".bin"));
  assert.ok(WHISPER_MODEL.urls.length >= 1, "at least one source");
  for (const url of WHISPER_MODEL.urls) {
    assert.ok(url.startsWith("https://"), `${url} must be https`);
    assert.ok(url.endsWith(WHISPER_MODEL.fileName), `${url} must serve the expected file name`);
  }
  // The floor exists to reject error pages, so it must sit well below a real
  // copy but far above anything an error could produce.
  assert.ok(WHISPER_MODEL.minBytes < WHISPER_MODEL.approxBytes);
  assert.ok(WHISPER_MODEL.minBytes > 1_000_000);
});

test("the project's own release is preferred over Hugging Face", () => {
  // Hugging Face rate limits and is blocked on many corporate networks, which
  // is exactly where this app runs.
  assert.match(WHISPER_MODEL.urls[0]!, /github\.com/);
  assert.ok(
    WHISPER_MODEL.urls.some((u) => /huggingface\.co/.test(u)),
    "but it stays as a fallback"
  );
});

test("a real ggml header is accepted", () => {
  // whisper.cpp writes magic 0x67676d6c as a little-endian uint32, so the file
  // opens with the bytes "lmgg".
  assert.equal(looksLikeModel(new TextEncoder().encode("lmgg")), true);
  assert.equal(looksLikeModel(new TextEncoder().encode("GGUF")), true);
});

test("an error page saved under a .bin name is rejected", () => {
  // This is the failure the check exists for: a 404 or a login redirect saved
  // to disk is a perfectly valid file that is not a model.
  assert.equal(looksLikeModel(new TextEncoder().encode("<!DO")), false);
  assert.equal(looksLikeModel(new TextEncoder().encode('{"er')), false);
  assert.equal(looksLikeModel(new Uint8Array([0, 1])), false, "and a truncated one");
});

test("sizes read the way a person would say them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(874_000_000), "834 MB");
  assert.equal(formatBytes(-1), "unknown");
});

test("progress is null when the server did not give a total", () => {
  // An indeterminate bar is honest; a made-up percentage is not.
  assert.equal(progressFraction(100, null), null);
  assert.equal(progressFraction(100, 0), null);
});

test("progress is clamped, so a mis-stated total cannot exceed the bar", () => {
  assert.equal(progressFraction(50, 200), 0.25);
  assert.equal(progressFraction(300, 200), 1);
  assert.equal(progressFraction(-5, 200), 0);
});
