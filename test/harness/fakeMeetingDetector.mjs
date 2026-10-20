#!/usr/bin/env node
/**
 * Stands in for native/meeting-detector so the host's supervision logic can be
 * exercised on any platform. Speaks the same protocol: line-delimited JSON on
 * stdout.
 *
 *   --mode start    emit a start event, then each --users snapshot in turn (default)
 *   --mode silent   emit nothing (exercises the start timeout)
 *   --mode fail     exit before starting
 *   --mode crash    start, emit the snapshots, then exit unexpectedly
 *   --mode split    deliver a JSON line across two writes, plus a non-JSON line
 *   --users JSON    an array of snapshots, each an array of {pid, bundleId}
 *   --interval N    ms between snapshots
 */

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const mode = readFlag("--mode", "start");
const snapshots = JSON.parse(readFlag("--users", "[[]]"));
const interval = Number(readFlag("--interval", "10"));

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    emit({ type: "stopped" });
    process.exit(0);
  });
}

if (mode === "fail") {
  process.stderr.write("CoreAudio is unavailable\n");
  process.exit(2);
}

if (mode === "silent") {
  setInterval(() => {}, 1000);
} else if (mode === "split") {
  const line = JSON.stringify({ type: "mic", users: snapshots[0] ?? [] });
  emit({ type: "start" });
  process.stdout.write("not json at all\n");
  process.stdout.write(line.slice(0, 9));
  setTimeout(() => process.stdout.write(`${line.slice(9)}\n`), 20);
  setInterval(() => {}, 1000);
} else {
  emit({ type: "start" });
  let index = 0;
  const timer = setInterval(() => {
    if (index < snapshots.length) {
      emit({ type: "mic", users: snapshots[index] });
      index += 1;
      return;
    }
    clearInterval(timer);
    if (mode === "crash") process.exit(3);
  }, interval);
  setInterval(() => {}, 1000);
}
