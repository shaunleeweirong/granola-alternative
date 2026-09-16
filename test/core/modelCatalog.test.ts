import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WHISPER_MODEL,
  LANGUAGE_MODEL,
  MODELS,
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

test("every catalogued model is coherent and self-consistent", () => {
  for (const [kind, model] of Object.entries(MODELS)) {
    assert.equal(model.kind, kind, `${kind} entry must declare its own kind`);
    assert.ok(model.urls.length >= 1, `${kind} needs at least one source`);
    for (const url of model.urls) {
      assert.ok(url.startsWith("https://"), `${url} must be https`);
      assert.ok(url.endsWith(model.fileName), `${url} must serve ${model.fileName}`);
    }
    assert.ok(model.minBytes < model.approxBytes, `${kind} floor must sit below its real size`);
    assert.ok(model.minBytes > 1_000_000, `${kind} floor must be far above an error page`);
    assert.ok(model.displayName.length > 0 && model.description.length > 0);
  }
});

test("the two models are distinct files", () => {
  // They land in the same directory, so a shared name would have one overwrite
  // the other and the app would run a summariser as a speech engine.
  assert.notEqual(WHISPER_MODEL.fileName, LANGUAGE_MODEL.fileName);
  assert.notEqual(WHISPER_MODEL.id, LANGUAGE_MODEL.id);
});

test("the language model is a GGUF and the speech model is a GGML", () => {
  // llama.cpp and whisper.cpp read different container formats; swapping them
  // produces a confusing load failure rather than an obvious one.
  assert.match(LANGUAGE_MODEL.fileName, /\.gguf$/);
  assert.match(WHISPER_MODEL.fileName, /\.bin$/);
});

test("every model pins a checksum, and it is a real digest", () => {
  // Without one, a download is verified by size and header only: enough to
  // reject a 404 page, not enough to catch a file that arrived corrupt.
  for (const [kind, model] of Object.entries(MODELS)) {
    assert.ok(model.sha256, `${kind} has no pinned checksum`);
    assert.match(model.sha256!, /^[0-9a-f]{64}$/, `${kind} checksum is not a sha256 digest`);
  }
});

test("the two models do not share a checksum", () => {
  // Copy-pasting one digest over the other would make one model permanently
  // unverifiable, and the failure would look like a corrupt download forever.
  assert.notEqual(WHISPER_MODEL.sha256, LANGUAGE_MODEL.sha256);
});
