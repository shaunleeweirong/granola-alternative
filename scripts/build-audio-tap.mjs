#!/usr/bin/env node
/**
 * Compiles native/macos-audio-tap into resources/bin/meeting-audio-tap.
 *
 * macOS only. On any other platform this exits 0 without building, so the
 * repository stays installable and testable everywhere — the app simply
 * reports that system audio is unavailable.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const source = path.join(root, "native", "macos-audio-tap", "main.swift");
const outDir = path.join(root, "resources", "bin");
const output = path.join(outDir, "meeting-audio-tap");

if (process.platform !== "darwin") {
  console.log("[audio-tap] not macOS, skipping (system audio will be unavailable)");
  process.exit(0);
}

if (spawnSync("which", ["swiftc"]).status !== 0) {
  console.error("[audio-tap] swiftc not found. Install Xcode command line tools:");
  console.error("[audio-tap]   xcode-select --install");
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(`[audio-tap] missing source: ${source}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const result = spawnSync(
  "swiftc",
  [
    "-O",
    "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.2`,
    "-o", output,
    source,
    "-framework", "AVFoundation",
    "-framework", "CoreAudio",
    "-framework", "Foundation",
  ],
  { stdio: "inherit" }
);

if (result.status !== 0) {
  console.error("[audio-tap] build failed");
  process.exit(result.status ?? 1);
}

console.log(`[audio-tap] built ${output}`);
