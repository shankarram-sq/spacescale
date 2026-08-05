import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environment: "staging" as "staging" | "production",
  requiredCalls: [] as string[][],
  requestPaths: [] as string[],
  output: [] as string[],
  assertTurnstileSiteKeyForEnvironment: vi.fn(),
}));

function configuredValue(name: string): string {
  const staging = mocks.environment === "staging";
  const values: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
    SESSION_SIGNING_KEY_CURRENT: "s".repeat(32),
    CLASSROOM_INTEGRATION_KEY: "c".repeat(32),
    R2_BUCKET_NAME: staging ? "staging-cloud-collab" : "collab-canvas-snapshots",
    APP_HOSTNAME: staging ? "staging-cloud-collab.spacescale.net" : "spacescale.net",
    TURNSTILE_SITE_KEY: "real-turnstile-site-key",
    TURNSTILE_SECRET_KEY: "real-turnstile-secret-key",
  };
  const value = values[name];
  if (value === undefined) throw new Error(`No test value for ${name}`);
  return value;
}

vi.mock("./env.ts", () => ({
  assertPublicConfiguration: vi.fn(),
  assertTurnstileSiteKeyForEnvironment: mocks.assertTurnstileSiteKeyForEnvironment,
  loadLocalEnv: vi.fn(),
  requireEnvironment: vi.fn((names: readonly string[]) => {
    mocks.requiredCalls.push([...names]);
    return Object.fromEntries(names.map((name) => [name, configuredValue(name)]));
  }),
  publicApiFailure: vi.fn((label: string) => new Error(label)),
  cloudflareRequest: vi.fn(async (path: string) => {
    mocks.requestPaths.push(path);
    const hostname = configuredValue("APP_HOSTNAME");
    const bucketName = configuredValue("R2_BUCKET_NAME");
    const workerService =
      mocks.environment === "production"
        ? "cloudflare-collab-canvas"
        : "cloudflare-collab-canvas-staging";
    let result: unknown = {};
    if (path.endsWith("/tokens/verify")) result = { status: "active" };
    else if (path.endsWith("/workers/scripts")) result = [];
    else if (path.includes("/workers/domains?")) {
      result = [{ hostname, service: workerService, cert_id: "certificate" }];
    } else if (path.endsWith("/r2/buckets?per_page=1000")) {
      result = { buckets: [{ name: bucketName, jurisdiction: "default" }] };
    } else if (path.endsWith("/domains/managed")) result = { enabled: false };
    else if (path.endsWith("/domains/custom")) result = { domains: [] };
    else if (path.includes("/challenges/widgets/")) {
      result = {
        sitekey: configuredValue("TURNSTILE_SITE_KEY"),
        secret: configuredValue("TURNSTILE_SECRET_KEY"),
        domains: [hostname],
      };
    } else if (path.includes("/r2/buckets/")) {
      result = { name: bucketName, jurisdiction: "default" };
    }
    return {
      response: new Response(null, { status: 200 }),
      envelope: { success: true, result },
    };
  }),
}));

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  mocks.environment = "staging";
  mocks.requiredCalls.length = 0;
  mocks.requestPaths.length = 0;
  mocks.output.length = 0;
  mocks.assertTurnstileSiteKeyForEnvironment.mockReset();
  process.exitCode = 0;
  process.env.ALLOWED_ORIGINS = "*";
  delete process.env.BOARD_CREATION_ENABLED;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    mocks.output.push(String(chunk));
    return true;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  delete process.env.ALLOWED_ORIGINS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.sequential("Cloudflare command Turnstile configuration", () => {
  it("bootstraps staging without requiring a Turnstile site key", async () => {
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requiredCalls).toHaveLength(1);
    expect(mocks.requiredCalls[0]).not.toContain("TURNSTILE_SITE_KEY");
    expect(mocks.assertTurnstileSiteKeyForEnvironment).not.toHaveBeenCalled();
    expect(mocks.requestPaths.some((path) => path.includes("/challenges/"))).toBe(false);
  });

  it("keeps the production bootstrap site-key requirement strict", async () => {
    mocks.environment = "production";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "production"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requiredCalls).toHaveLength(1);
    expect(mocks.requiredCalls[0]).toContain("TURNSTILE_SITE_KEY");
    expect(mocks.assertTurnstileSiteKeyForEnvironment).toHaveBeenCalledWith(
      "real-turnstile-site-key",
      "production",
    );
  });

  it("checks staging access without requiring or probing Turnstile credentials", async () => {
    await import("./check-cloudflare-access.ts");

    expect(mocks.requiredCalls).toHaveLength(1);
    expect(mocks.requiredCalls[0]).not.toContain("TURNSTILE_SITE_KEY");
    expect(mocks.requiredCalls[0]).not.toContain("TURNSTILE_SECRET_KEY");
    expect(mocks.assertTurnstileSiteKeyForEnvironment).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.requestPaths.some((path) => path.includes("/challenges/widgets/"))).toBe(false);
    expect(mocks.output.join("")).toContain(
      JSON.stringify({ check: "turnstile", enabled: false, skipped: true }),
    );
  });

  it("keeps production access checks strict and probes both Turnstile credentials", async () => {
    mocks.environment = "production";

    await import("./check-cloudflare-access.ts");

    expect(mocks.requiredCalls).toHaveLength(2);
    expect(mocks.requiredCalls[1]).toEqual(["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"]);
    expect(mocks.assertTurnstileSiteKeyForEnvironment).toHaveBeenCalledWith(
      "real-turnstile-site-key",
      "production",
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.requestPaths.some((path) => path.includes("/challenges/widgets/"))).toBe(true);
    expect(process.exitCode).toBe(0);
  });
});
