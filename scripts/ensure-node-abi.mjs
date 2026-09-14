#!/usr/bin/env node
/**
 * better-sqlite3 is a native module, so it is compiled for one runtime at a
 * time. `npm start` rebuilds it for Electron's Node; the tests need plain
 * Node's. Running one after the other otherwise fails with a cryptic
 * NODE_MODULE_VERSION error, so this rebuilds automatically when needed.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

try {
  require("better-sqlite3");
  process.exit(0);
} catch (error) {
  const message = String(error?.message ?? error);
  if (!/NODE_MODULE_VERSION|was compiled against|invalid ELF|mach-o/i.test(message)) {
    console.error(`[abi] better-sqlite3 could not be loaded:\n${message}`);
    process.exit(1);
  }
  console.log("[abi] better-sqlite3 is built for Electron; rebuilding for Node...");
}

const result = spawnSync("npm", ["rebuild", "better-sqlite3"], { stdio: "inherit" });
process.exit(result.status ?? 1);
