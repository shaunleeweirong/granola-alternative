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

const mode = readFlag("--mode", "start");
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
