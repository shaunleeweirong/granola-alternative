#!/usr/bin/env node
/**
 * Compiles the native helpers into resources/bin:
 *
 *   native/macos-audio-tap  -> meeting-audio-tap  (system audio capture)
 *   native/meeting-detector -> meeting-detector   (which apps use the microphone)
 *
 * macOS only. On any other platform this exits 0 without building, so the
 * repository stays installable and testable everywhere — the app simply
 * reports that system audio is unavailable.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const outDir = path.join(root, "resources", "bin");

const helpers = [
  {
    name: "meeting-audio-tap",
    source: path.join(root, "native", "macos-audio-tap", "main.swift"),
    frameworks: ["AVFoundation", "CoreAudio", "Foundation"],
  },
  {
    name: "meeting-detector",
    source: path.join(root, "native", "meeting-detector", "main.swift"),
    frameworks: ["CoreAudio", "Foundation"],
  },
];

if (process.platform !== "darwin") {
  console.log("[audio-tap] not macOS, skipping (system audio will be unavailable)");
  process.exit(0);
}

if (spawnSync("which", ["swiftc"]).status !== 0) {
  console.error("[audio-tap] swiftc not found. Install Xcode command line tools:");
  console.error("[audio-tap]   xcode-select --install");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

for (const helper of helpers) {
  if (!existsSync(helper.source)) {
    console.error(`[audio-tap] missing source: ${helper.source}`);
    process.exit(1);
  }

  const output = path.join(outDir, helper.name);
  const result = spawnSync(
    "swiftc",
    [
      "-O",
      "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.2`,
      "-o", output,
      helper.source,
      ...helper.frameworks.flatMap((framework) => ["-framework", framework]),
    ],
    { stdio: "inherit" }
  );

  if (result.status !== 0) {
    console.error(`[audio-tap] ${helper.name} failed to build`);
    process.exit(result.status ?? 1);
  }

  console.log(`[audio-tap] built ${output}`);
}
