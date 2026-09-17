import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveModelPath, userModelTarget } from "../../src/core/modelPaths.ts";

const present = (...paths: string[]) => (candidate: string) => paths.includes(candidate);

test("a packaged build finds the model shipped inside the app", () => {
  const resolved = resolveModelPath({
    name: "ggml-base.en.bin",
    userModelDir: "/Users/me/Library/Application Support/Clean Record/models",
    bundledModelDir: "/Applications/Clean Record.app/Contents/Resources/models",
    exists: present("/Applications/Clean Record.app/Contents/Resources/models/ggml-base.en.bin"),
  });

  assert.deepEqual(resolved, {
    path: "/Applications/Clean Record.app/Contents/Resources/models/ggml-base.en.bin",
    source: "bundled",
  });
});

test("a model the user installed themselves beats the bundled one", () => {
  // So swapping in a larger, more accurate model never needs a new release.
  const userPath = "/Users/me/Library/Application Support/Clean Record/models/ggml-base.en.bin";
  const bundledPath = "/Applications/Clean Record.app/Contents/Resources/models/ggml-base.en.bin";

  const resolved = resolveModelPath({
    name: "ggml-base.en.bin",
    userModelDir: "/Users/me/Library/Application Support/Clean Record/models",
    bundledModelDir: "/Applications/Clean Record.app/Contents/Resources/models",
    exists: present(userPath, bundledPath),
  });

  assert.equal(resolved?.source, "user");
  assert.equal(resolved?.path, userPath);
});

test("a development run with no bundle still finds a downloaded model", () => {
  const resolved = resolveModelPath({
    name: "ggml-base.en.bin",
    userModelDir: "/home/dev/models",
    bundledModelDir: null,
    exists: present("/home/dev/models/ggml-base.en.bin"),
  });
  assert.equal(resolved?.source, "user");
});

test("returns null when the model is nowhere, so the UI can explain", () => {
  assert.equal(
    resolveModelPath({
      name: "ggml-base.en.bin",
      userModelDir: "/a",
      bundledModelDir: "/b",
      exists: () => false,
    }),
    null
  );
});

test("an empty or blank model name resolves to nothing", () => {
  const exists = (): boolean => true;
  assert.equal(resolveModelPath({ name: "", userModelDir: "/a", bundledModelDir: "/b", exists }), null);
  assert.equal(resolveModelPath({ name: "   ", userModelDir: "/a", bundledModelDir: "/b", exists }), null);
});

test("missing directories are skipped rather than joined into nonsense", () => {
  const seen: string[] = [];
  const resolved = resolveModelPath({
    name: "model.bin",
    userModelDir: null,
    bundledModelDir: null,
    exists: (p) => {
      seen.push(p);
      return true;
    },
  });
  assert.equal(resolved, null);
  assert.deepEqual(seen, [], "no path is even tested when both directories are absent");
});

test("downloads always target the writable per-user directory", () => {
  assert.equal(userModelTarget("/Users/me/models", "ggml-large.bin"), "/Users/me/models/ggml-large.bin");
});
