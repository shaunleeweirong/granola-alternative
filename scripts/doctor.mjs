#!/usr/bin/env node
/**
 * Reports what is set up and what is missing, in plain language.
 *
 * This exists so that "it doesn't work" can become a specific, fixable
 * sentence. Every failed check prints the exact next action.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const isMac = process.platform === "darwin";

const userDataDir = isMac
  ? path.join(os.homedir(), "Library", "Application Support", "granola-alternative")
  : path.join(os.homedir(), ".config", "granola-alternative");
const modelDir = path.join(userDataDir, "models");
const WHISPER_MODEL = "ggml-large-v3-turbo.bin";

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (colour ? `[${code}m${text}[0m` : text);
const green = (t) => paint("32", t);
const red = (t) => paint("31", t);
const yellow = (t) => paint("33", t);
const dim = (t) => paint("2", t);
const bold = (t) => paint("1", t);

const results = [];

/**
 * @param {string} name        what is being checked, in plain words
 * @param {() => {ok: boolean, detail?: string, fix?: string, optional?: boolean}} check
 */
function check(name, fn) {
  let outcome;
  try {
    outcome = fn();
  } catch (error) {
    outcome = { ok: false, detail: error.message, fix: "Unexpected error running this check." };
  }
  results.push({ name, ...outcome });
}

const commandExists = (cmd) => spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;

const commandOutput = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return result.status === 0 ? (result.stdout || result.stderr).trim() : null;
};

const isExecutable = (file) => {
  if (!existsSync(file)) return false;
  try {
    return (statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const megabytes = (file) => (statSync(file).size / (1024 * 1024)).toFixed(0);

// ---------------------------------------------------------------- checks

check("Running on macOS", () => {
  if (!isMac) {
    return {
      ok: false,
      detail: `This machine is ${process.platform}, not macOS.`,
      fix: "The app records system audio using a macOS feature. It needs a Mac. Tests still run here.",
    };
  }
  const version = process.getSystemVersion?.() ?? commandOutput("sw_vers", ["-productVersion"]) ?? "";
  const [major, minor = 0] = version.split(".").map(Number);
  const supported = major > 14 || (major === 14 && minor >= 2);
  return {
    ok: supported,
    detail: `macOS ${version}`,
    fix: supported ? undefined : "Update to macOS 14.2 (Sonoma) or later. Apple menu > System Settings > General > Software Update.",
  };
});

check("Node.js 22 or newer", () => {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    ok: major >= 22,
    detail: `Node ${process.versions.node}`,
    fix: major >= 22 ? undefined : "Install a newer Node: brew install node",
  };
});

check("Apple developer tools", () => {
  if (!isMac) return { ok: true, detail: "not needed off macOS", optional: true };
  const installed = commandOutput("xcode-select", ["-p"]);
  return {
    ok: Boolean(installed),
    detail: installed ?? "not found",
    fix: installed ? undefined : "Run: xcode-select --install  (then click Install in the popup)",
  };
});

check("Swift compiler", () => {
  if (!isMac) return { ok: true, detail: "not needed off macOS", optional: true };
  const has = commandExists("swiftc");
  return {
    ok: has,
    detail: has ? (commandOutput("swiftc", ["--version"])?.split("\n")[0] ?? "present") : "not found",
    fix: has ? undefined : "Comes with Apple developer tools. Run: xcode-select --install",
  };
});

check("Project dependencies installed", () => {
  if (!existsSync(path.join(root, "node_modules", "better-sqlite3"))) {
    return { ok: false, detail: "missing", fix: "Run: npm install" };
  }
  // better-sqlite3 is native code, so "the folder exists" is not the same as
  // "it loads". Actually require it, and tell the two failure modes apart.
  try {
    createRequire(import.meta.url)("better-sqlite3");
    return { ok: true, detail: "installed and loading correctly" };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/NODE_MODULE_VERSION|was compiled against/i.test(message)) {
      return {
        ok: false,
        detail: "built for a different runtime",
        fix: "Run: npm run rebuild:node   (then npm run rebuild:electron before npm start)",
      };
    }
    return { ok: false, detail: message.split("\n")[0], fix: "Run: npm install" };
  }
});

check("System audio helper built", () => {
  const file = path.join(root, "resources", "bin", "meeting-audio-tap");
  const ok = isExecutable(file);
  return {
    ok,
    detail: ok ? file : "not built yet",
    fix: ok ? undefined : "Run: npm run build:tap",
  };
});

check("Speech recognition engine", () => {
  const file = path.join(root, "resources", "bin", "whisper-server");
  const ok = isExecutable(file);
  return {
    ok,
    detail: ok ? file : "not installed yet",
    fix: ok ? undefined : "Run: npm run setup:mac   (this downloads and builds it)",
  };
});

check("Speech recognition model", () => {
  const file = path.join(modelDir, WHISPER_MODEL);
  const ok = existsSync(file);
  return {
    ok,
    detail: ok ? `${WHISPER_MODEL} (${megabytes(file)} MB)` : `expected at ${file}`,
    fix: ok ? undefined : "Run: npm run setup:mac   (this downloads it)",
  };
});

check("Note-writing model (optional)", () => {
  const binary = path.join(root, "resources", "bin", "llama-server");
  const ok = isExecutable(binary);
  return {
    ok,
    optional: true,
    detail: ok ? binary : "not installed",
    fix: ok
      ? undefined
      : "Only needed to turn transcripts into written notes. Transcription works without it.",
  };
});

// ---------------------------------------------------------------- report

console.log(`\n${bold("Setup check")}\n`);

let blocking = 0;
let optionalMissing = 0;

for (const result of results) {
  const mark = result.ok ? green("  ok  ") : result.optional ? yellow(" skip ") : red(" MISS ");
  console.log(`${mark} ${result.name}`);
  if (result.detail) console.log(`       ${dim(result.detail)}`);
  if (!result.ok && result.fix) console.log(`       ${result.optional ? dim(result.fix) : yellow(`→ ${result.fix}`)}`);
  if (!result.ok) {
    if (result.optional) optionalMissing += 1;
    else blocking += 1;
  }
}

console.log();

if (blocking === 0) {
  console.log(green(bold("Everything needed is in place.")));
  console.log(`Next: ${bold("npm start")} to launch the app.`);
  if (optionalMissing > 0) {
    console.log(dim(`${optionalMissing} optional item not installed; that is fine for testing transcription.`));
  }
} else {
  console.log(red(bold(`${blocking} thing${blocking === 1 ? "" : "s"} still needed.`)));
  console.log("Follow the arrows above, top to bottom, then run this again:");
  console.log(`  ${bold("npm run doctor")}`);
}

console.log();
process.exit(blocking === 0 ? 0 : 1);
