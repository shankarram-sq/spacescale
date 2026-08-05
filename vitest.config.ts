import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@collab/protocol": new URL("./packages/protocol/src/index.ts", import.meta.url).pathname,
      "@collab/geometry": new URL("./packages/geometry/src/index.ts", import.meta.url).pathname,
      "@collab/board-core": new URL("./packages/board-core/src/index.ts", import.meta.url).pathname,
      "@collab/svg-export": new URL("./packages/svg-export/src/index.ts", import.meta.url).pathname,
      "@collab/test-fixtures": new URL("./packages/test-fixtures/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/web/**/*.test.ts",
      "scripts/**/*.test.ts",
      "tests/load/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist", "apps/edge/**"],
    environment: "node",
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
