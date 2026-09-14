import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.join(import.meta.dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.join(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome126",
  },
  server: { port: 5273, strictPort: true },
});
