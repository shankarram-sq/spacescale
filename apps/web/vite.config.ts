import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@collab/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url),
      ),
      "@collab/geometry": fileURLToPath(
        new URL("../../packages/geometry/src/index.ts", import.meta.url),
      ),
      "@collab/board-core": fileURLToPath(
        new URL("../../packages/board-core/src/index.ts", import.meta.url),
      ),
      "@collab/svg-export": fileURLToPath(
        new URL("../../packages/svg-export/src/index.ts", import.meta.url),
      ),
      "@collab/test-fixtures": fileURLToPath(
        new URL("../../packages/test-fixtures/src/index.ts", import.meta.url),
      ),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
});
