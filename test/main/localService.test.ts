import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";

import { LocalService } from "../../src/main/localService.ts";

/** Writes a throwaway executable shell script and returns its path. */
async function makeScript(body: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ga-svc-"));
  const file = path.join(dir, "fake-server");
  await writeFile(file, `#!/bin/bash\n${body}\n`);
  await chmod(file, 0o755);
  return { path: file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const never = async (): Promise<boolean> => false;
const always = async (): Promise<boolean> => true;

test("reports a missing program instead of a generic timeout", async () => {
  const service = new LocalService({
    name: "whisper",
    binaryPath: "/nonexistent/whisper-server",
    args: [],
    healthCheck: never,
    readyTimeoutMs: 200,
  });

  assert.equal(await service.start(), false);
  assert.equal(service.status, "failed");
  assert.match(service.reason ?? "", /missing from the app/i);
  assert.match(service.reason ?? "", /whisper-server/);
});

test("reports a service that was never configured", async () => {
  const service = new LocalService({
    name: "llama",
    binaryPath: null,
    args: [],
    healthCheck: never,
    readyTimeoutMs: 200,
  });

  assert.equal(await service.start(), false);
  assert.match(service.reason ?? "", /not configured/i);
});

test("a missing shared library is explained, not swallowed", async (t) => {
  // The exact failure that shipped: a binary copied out of its build tree
  // without its .dylib files dies before printing anything of its own, and
  // the only clue is the loader's error on stderr.
  const script = await makeScript(
    `echo "dyld[123]: Library not loaded: @rpath/libwhisper.1.dylib" >&2\nexit 1`
  );
  t.after(script.cleanup);

  const logs: string[] = [];
  const service = new LocalService({
    name: "whisper",
    binaryPath: script.path,
    args: [],
    healthCheck: never,
    readyTimeoutMs: 3_000,
    pollIntervalMs: 20,
    onLog: (line) => logs.push(line),
  });

  assert.equal(await service.start(), false);
  assert.match(service.reason ?? "", /missing libraries/i);
  assert.ok(
    service.log.some((l) => /Library not loaded/.test(l)),
    "the loader's own message is retained for a bug report"
  );
  assert.ok(logs.some((l) => /Library not loaded/.test(l)), "and forwarded to the log callback");
});

test("an unreadable model is explained in plain words", async (t) => {
  const script = await makeScript(`echo "whisper_init: failed to load model" >&2\nexit 1`);
  t.after(script.cleanup);

  const service = new LocalService({
    name: "whisper",
    binaryPath: script.path,
    args: [],
    healthCheck: never,
    readyTimeoutMs: 3_000,
    pollIntervalMs: 20,
  });

  assert.equal(await service.start(), false);
  assert.match(service.reason ?? "", /model could not be read/i);
});

test("a port clash is explained", async (t) => {
  const script = await makeScript(`echo "error: bind: Address already in use" >&2\nexit 1`);
  t.after(script.cleanup);

  const service = new LocalService({
    name: "whisper",
    binaryPath: script.path,
    args: [],
    healthCheck: never,
    readyTimeoutMs: 3_000,
    pollIntervalMs: 20,
  });

  assert.equal(await service.start(), false);
  assert.match(service.reason ?? "", /already in use/i);
});

test("a silent crash still names the exit, rather than blaming a timeout", async (t) => {
  const script = await makeScript(`exit 3`);
  t.after(script.cleanup);

  const service = new LocalService({
    name: "whisper",
    binaryPath: script.path,
    args: [],
    healthCheck: never,
    readyTimeoutMs: 3_000,
    pollIntervalMs: 20,
  });

  assert.equal(await service.start(), false);
  assert.match(service.reason ?? "", /exited with code 3/);
});

test("a server that starts is reported ready with no failure reason", async (t) => {
  const script = await makeScript(`sleep 5`);
  t.after(script.cleanup);

  let calls = 0;
  const service = new LocalService({
    name: "whisper",
    binaryPath: script.path,
    args: [],
    // Unhealthy at first, like a large model still loading.
    healthCheck: async () => ++calls > 3,
    readyTimeoutMs: 3_000,
    pollIntervalMs: 20,
  });
  t.after(() => service.stop());

  assert.equal(await service.start(), true);
  assert.equal(service.status, "ready");
  assert.equal(service.reason, null);
});

test("an already-running server is adopted rather than duplicated", async () => {
  let spawned = false;
  const service = new LocalService({
    name: "whisper",
    binaryPath: "/nonexistent/should-not-be-launched",
    args: [],
    healthCheck: async () => {
      spawned = true;
      return true;
    },
    readyTimeoutMs: 200,
  });

  assert.equal(await service.start(), true);
  assert.equal(service.isReady, true);
  assert.equal(spawned, true);
});

test("output is capped so a chatty server cannot grow without bound", async (t) => {
  const script = await makeScript(`for i in $(seq 1 200); do echo "line $i" >&2; done\nexit 1`);
  t.after(script.cleanup);

  const service = new LocalService({
    name: "whisper",
    binaryPath: script.path,
    args: [],
    healthCheck: never,
    readyTimeoutMs: 3_000,
    pollIntervalMs: 20,
    logLimit: 10,
  });

  await service.start();
  assert.ok(service.log.length <= 10, `retained ${service.log.length} lines, expected at most 10`);
  // The exit note is legitimately the newest entry, so check the window rather
  // than the single last line: recent output kept, early output discarded.
  const retained = service.log.join("\n");
  assert.match(retained, /line 200/, "keeps the most recent server output");
  assert.doesNotMatch(retained, /line 1\b/, "discards the oldest output");
});

test("stop is safe on a service that never started", async () => {
  const service = new LocalService({
    name: "whisper",
    binaryPath: null,
    args: [],
    healthCheck: always,
  });
  await service.stop();
  assert.equal(service.isReady, false);
});
