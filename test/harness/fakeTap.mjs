#!/usr/bin/env node
/**
 * Stands in for native/macos-audio-tap so the host's supervision logic can be
 * exercised on any platform. Speaks the same protocol: PCM on stdout,
 * line-delimited JSON on stderr.
 *
 *   --mode start    emit a start event then stream PCM (default)
 *   --mode deny     emit a permission_denied error and exit
 *   --mode silent   emit nothing (exercises the start timeout)
 *   --mode crash    emit a start event, then exit mid-stream
 *   --mode crash-once  crash on the first spawn, behave normally afterwards
 *   --crash-spawns 1,3  crash on these spawn numbers only. Both need
 *                   --state <file> to count across processes, which is how the
 *                   host's restart path gets exercised end to end.
 *   --mode split    write JSON events and samples across deliberately awkward
 *                   read boundaries: half a JSON line, and an odd byte count
 *   --mode noise    write a non-JSON line to stderr
 *   --chunks N      how many PCM chunks to write
 *   --chunk-bytes N bytes per chunk
 */

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

let mode = readFlag("--mode", "start");
const statePath = readFlag("--state", null);
const crashSpawns = readFlag("--crash-spawns", null);

// Which spawn this is cannot live in memory: the whole point of these modes is
// that the process dies and a fresh one replaces it, so the count goes on disk.
if (mode === "crash-once" || crashSpawns) {
  const fs = await import("node:fs");
  let spawnNumber = 1;
  if (statePath) {
    const previous = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
    spawnNumber = (Number.isFinite(previous) ? previous : 0) + 1;
    fs.writeFileSync(statePath, String(spawnNumber));
  }
  const crashOn = crashSpawns ? crashSpawns.split(",").map(Number) : [1];
  mode = crashOn.includes(spawnNumber) ? "crash" : "start";
}
const chunks = Number(readFlag("--chunks", "3"));
const chunkBytes = Number(readFlag("--chunk-bytes", "320"));

const emit = (obj) => process.stderr.write(`${JSON.stringify(obj)}\n`);

// A recognisable ramp, so the test can assert the bytes arrived intact.
const makeChunk = (index, bytes) => {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) buf.writeInt16LE(((index * 1000 + i) % 30000) - 15000, i);
  return buf;
};

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    emit({ type: "stopped" });
    process.exit(0);
  });
}

if (mode === "deny") {
  emit({ type: "error", code: "permission_denied", message: "System audio access was denied" });
  process.exit(1);
}

if (mode === "silent") {
  setInterval(() => {}, 1000);
} else if (mode === "noise") {
  process.stderr.write("dyld: some runtime warning that is not JSON\n");
  emit({ type: "start", sampleRate: 16000, channels: 1, bitsPerChannel: 16 });
  setInterval(() => {}, 1000);
} else if (mode === "split") {
  // A JSON line delivered in two writes, then an odd number of PCM bytes so the
  // host has to hold a carry byte to keep samples aligned.
  const line = JSON.stringify({ type: "start", sampleRate: 16000 });
  process.stderr.write(line.slice(0, 12));
  setTimeout(() => {
    process.stderr.write(`${line.slice(12)}\n`);
    const full = makeChunk(0, chunkBytes);
    process.stdout.write(full.subarray(0, chunkBytes - 1)); // odd count
    setTimeout(() => {
      process.stdout.write(full.subarray(chunkBytes - 1)); // the missing byte
      emit({ type: "marker", name: "split-complete" });
    }, 20);
  }, 20);
  setInterval(() => {}, 1000);
} else {
  emit({ type: "start", sampleRate: 16000, channels: 1, bitsPerChannel: 16 });
  let written = 0;
  const timer = setInterval(() => {
    if (stopping) return;
    if (written >= chunks) {
      if (mode === "crash") {
        emit({ type: "error", code: "device_lost", message: "Aggregate device disappeared" });
        process.exit(3);
      }
      return;
    }
    process.stdout.write(makeChunk(written, chunkBytes));
    written += 1;
  }, 10);
  timer.unref?.();
  setInterval(() => {}, 1000);
}
