import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc", environment: "development" },
    }),
  ],
  test: {
    include: ["apps/edge/**/*.test.ts", "tests/integration/**/*.test.ts"],
    fileParallelism: false,
    isolate: false,
    maxWorkers: 1,
  },
});
