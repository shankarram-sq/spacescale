import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  scripts?: Record<string, string>;
};

type WranglerConfiguration = {
  env?: {
    development?: {
      routes?: unknown[];
      vars?: Record<string, string>;
    };
  };
};

describe("local development configuration", () => {
  it("forces the development environment, local bindings, and bundled local values", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
    const playwright = readFileSync("tests/playwright/playwright.config.ts", "utf8");
    const classroomTest = readFileSync("tests/playwright/classroom-embed.spec.ts", "utf8");
    const edgeTestConfig = readFileSync("vitest.cloudflare.config.ts", "utf8");
    const localOnlyCommand = "wrangler dev --env development --local --env-file .dev.vars.example";

    expect(manifest.scripts?.dev).toContain(localOnlyCommand);
    expect(playwright).toContain(localOnlyCommand);
    expect(playwright).toContain("cwd: repositoryRoot");
    expect(manifest.scripts?.["test:e2e"]).toContain("npm run build:web");
    expect(manifest.scripts?.["test:edge"]).toContain("npm run build:web");
    expect(classroomTest).toContain('".dev.vars.example"');
    expect(classroomTest).not.toContain('readFileSync(".dev.vars"');
    expect(edgeTestConfig).toContain("miniflare: { bindings: localBindings }");
    expect(edgeTestConfig).toContain('"./.dev.vars.example"');
  });

  it("uses local test values without requiring Cloudflare credentials", () => {
    const wrangler = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as WranglerConfiguration;
    const development = wrangler.env?.development;
    const localSecrets = readFileSync(".dev.vars.example", "utf8");

    expect(development?.routes).toEqual([]);
    expect(development?.vars).toMatchObject({
      APP_HOSTNAME: "localhost",
      ENVIRONMENT: "development",
      TURNSTILE_ENABLED: "false",
    });
    expect(localSecrets).toContain("SESSION_SIGNING_KEY_CURRENT=");
    expect(localSecrets).toContain("CLASSROOM_INTEGRATION_KEY=");
    expect(localSecrets).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(localSecrets).not.toContain("CLOUDFLARE_API_TOKEN");
  });
});
