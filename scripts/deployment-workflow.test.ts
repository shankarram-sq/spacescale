import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

describe("lightweight deployment workflows", () => {
  it("keeps the full validation suite manual and outside promotion", () => {
    expect(ci).toContain("workflow_dispatch:");
    expect(ci).not.toContain("pull_request:");
    expect(ci).not.toContain("push:");
    expect(ci).toContain("npm run check");
    expect(ci).toContain("npm run cf:types -- --check");
    expect(ci).toContain("npm run test:e2e");
  });

  it("deploys only direct staging and main pushes at their exact SHA", () => {
    expect(deploy).toContain("branches: [staging, main]");
    expect(deploy).not.toContain("workflow_run");
    expect(occurrences(deploy, "ref: $" + "{{ github.sha }}")).toBe(2);
    expect(deploy).toContain("if: github.ref == 'refs/heads/staging'");
    expect(deploy).toContain("if: github.ref == 'refs/heads/main'");
  });

  it("provisions private buckets and deploys each uploaded version directly at 100%", () => {
    expect(deploy).toContain("npm run cf:bootstrap -- --env staging");
    expect(deploy).toContain("npm run cf:bootstrap -- --env production");
    expect(occurrences(deploy, "wrangler versions upload")).toBe(2);
    expect(occurrences(deploy, "$" + "{{ steps.upload.outputs.version_id }}@100")).toBe(2);
    expect(deploy).not.toContain("--strict");
  });

  it("keeps staging automation-friendly and production Turnstile-enabled", () => {
    expect(deploy).toContain("--env staging");
    expect(deploy).toContain("APP_HOSTNAME:staging-cloud-collab.spacescale.net");
    expect(deploy).toContain("TURNSTILE_ENABLED:false");
    expect(deploy).toContain("TURNSTILE_SITE_KEY: $" + "{{ vars.TURNSTILE_SITE_KEY }}");
    expect(deploy).toContain("APP_HOSTNAME:spacescale.net");
    expect(deploy).toContain("TURNSTILE_ENABLED:true");
    expect(deploy).toContain('--env=""');
  });

  it("uses only a small post-deploy health probe", () => {
    expect(occurrences(deploy, "for attempt in 1 2 3 4 5")).toBe(2);
    expect(occurrences(deploy, ".ok == true and .service ==")).toBe(2);
    expect(deploy).not.toContain("npm run check");
    expect(deploy).not.toContain("test:e2e");
    expect(deploy).not.toContain("load:smoke");
    expect(deploy).not.toContain("cloudflare/staging");
    expect(deploy).not.toContain("candidate");
    expect(deploy).not.toContain("rollback");
    expect(deploy).not.toContain("convergence");
    expect(deploy).not.toContain("Version-Overrides");
  });
});
