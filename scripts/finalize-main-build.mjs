// The package is type:module, so CommonJS output under dist/ needs its own
// package.json to stop node treating the emitted .js files as ES modules.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const dist = path.join(import.meta.dirname, "..", "dist");
await mkdir(dist, { recursive: true });
await writeFile(
  path.join(dist, "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`
);
console.log("dist/package.json written (type: commonjs)");
