import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * The commit this build came from, shown in the app.
 *
 * Without it, "which build am I running?" is unanswerable from the app itself,
 * and an old copy left in Applications looks exactly like a new one that does
 * not work. That cost a debugging round once already.
 */
function buildId(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  root: path.join(import.meta.dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.join(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome126",
  },
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  server: { port: 5273, strictPort: true },
});
