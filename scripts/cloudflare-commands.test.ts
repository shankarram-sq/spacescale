import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environment: "staging" as "staging" | "production",
  assetScenario: "existing" as "existing" | "missing" | "conflict",
  assetLookupCount: 0,
  wafScenario: "existing" as "existing" | "missing-ruleset" | "missing-rule" | "drifted",
  requiredCalls: [] as string[][],
  requestPaths: [] as string[],
  requestCalls: [] as Array<{
    path: string;
    method: string;
    body: string | undefined;
  }>,
  output: [] as string[],
  assertTurnstileSiteKeyForEnvironment: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));

function configuredValue(name: string): string {
  const staging = mocks.environment === "staging";
  const values: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
    SESSION_SIGNING_KEY_CURRENT: "s".repeat(32),
    ORGANISATION_SIGNING_KEYS: JSON.stringify({
      demo: {
        derivation_key: "d".repeat(32),
        current: { key_id: "v1", key: "c".repeat(32) },
        previous: [],
      },
    }),
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
  cloudflareRequest: vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method?.toUpperCase() ?? "GET";
    mocks.requestPaths.push(path);
    mocks.requestCalls.push({
      path,
      method,
      body: init.body === undefined ? undefined : String(init.body),
    });
    const hostname = configuredValue("APP_HOSTNAME");
    const bucketName = configuredValue("R2_BUCKET_NAME");
    const assetBucketName =
      mocks.environment === "staging" ? "staging-cloud-collab-assets" : "collab-canvas-assets";
    const account = "a".repeat(32);
    const bucketLookupPath = `/accounts/${account}/r2/buckets/${encodeURIComponent(bucketName)}`;
    const assetLookupPath = `/accounts/${account}/r2/buckets/${encodeURIComponent(assetBucketName)}`;
    const workerService =
      mocks.environment === "production"
        ? "cloudflare-collab-canvas"
        : "cloudflare-collab-canvas-staging";
    const zoneId = "b".repeat(32);
    const rulesetId = "c".repeat(32);
    const wafRuleId = "d".repeat(32);
    const wafDescription = `SpaceScale: skip bot checks for authenticated ${mocks.environment} server APIs`;
    const expectedWafRule = {
      id: wafRuleId,
      action: "skip",
      action_parameters: { phases: ["http_request_sbfm"] },
      description: wafDescription,
      enabled: true,
      expression: `(http.host eq "${hostname}" and starts_with(http.request.uri.path, "/api/v1/organisations/"))`,
      logging: { enabled: true },
    };
    let result: unknown = {};
    let status = 200;
    let success = true;
    let errors: Array<{ code: number; message?: string }> | undefined;
    if (path.startsWith("/zones?")) {
      const requestedZone = new URL(`https://api.test${path}`).searchParams.get("name");
      result =
        requestedZone === "spacescale.net"
          ? [{ id: zoneId, name: "spacescale.net", status: "active" }]
          : [];
    } else if (
      path === `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`
    ) {
      if (mocks.wafScenario === "missing-ruleset") {
        status = 404;
        success = false;
        result = undefined;
        errors = [{ code: 10003, message: "entrypoint ruleset not found" }];
      } else {
        result = {
          id: rulesetId,
          phase: "http_request_firewall_custom",
          rules:
            mocks.wafScenario === "missing-rule"
              ? [{ id: "e".repeat(32), action: "block", description: "Existing rule" }]
              : [
                  mocks.wafScenario === "drifted"
                    ? {
                        ...expectedWafRule,
                        action_parameters: { phases: ["http_request_firewall_managed"] },
                      }
                    : expectedWafRule,
                ],
        };
      }
    } else if (method === "POST" && path === `/zones/${zoneId}/rulesets`) {
      result = {
        id: rulesetId,
        phase: "http_request_firewall_custom",
        rules: [expectedWafRule],
      };
    } else if (
      (method === "POST" || method === "PATCH") &&
      path.startsWith(`/zones/${zoneId}/rulesets/${rulesetId}/rules`)
    ) {
      result = {
        id: rulesetId,
        phase: "http_request_firewall_custom",
        rules: [expectedWafRule],
      };
    } else if (path.endsWith("/tokens/verify")) result = { status: "active" };
    else if (path.endsWith("/workers/scripts")) result = [];
    else if (path.includes("/workers/domains?")) {
      result = [{ hostname, service: workerService, cert_id: "certificate" }];
    } else if (path.endsWith("/r2/buckets?per_page=1000")) {
      result = {
        buckets: [bucketName, assetBucketName].map((name) => ({ name, jurisdiction: "default" })),
      };
    } else if (path.endsWith("/domains/managed")) result = { enabled: false };
    else if (path.endsWith("/domains/custom")) result = { domains: [] };
    else if (path.includes("/challenges/widgets/")) {
      result = {
        sitekey: configuredValue("TURNSTILE_SITE_KEY"),
        secret: configuredValue("TURNSTILE_SECRET_KEY"),
        domains: [hostname],
      };
    } else if (method === "POST" && path.endsWith("/r2/buckets")) {
      const body = JSON.parse(String(init.body)) as { name: string };
      if (mocks.assetScenario === "conflict" && body.name === assetBucketName) {
        status = 409;
        success = false;
        result = undefined;
      } else {
        result = { name: body.name, jurisdiction: "default" };
      }
    } else if (path === assetLookupPath) {
      mocks.assetLookupCount += 1;
      if (
        mocks.assetScenario === "missing" ||
        (mocks.assetScenario === "conflict" && mocks.assetLookupCount === 1)
      ) {
        status = 404;
        success = false;
        result = undefined;
      } else {
        result = { name: assetBucketName, jurisdiction: "default" };
      }
    } else if (path === bucketLookupPath) {
      result = { name: bucketName, jurisdiction: "default" };
    }
    return {
      response: new Response(null, { status }),
      envelope: { success, result, errors },
    };
  }),
}));

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  mocks.environment = "staging";
  mocks.assetScenario = "existing";
  mocks.assetLookupCount = 0;
  mocks.wafScenario = "existing";
  mocks.requiredCalls.length = 0;
  mocks.requestPaths.length = 0;
  mocks.requestCalls.length = 0;
  mocks.output.length = 0;
  mocks.assertTurnstileSiteKeyForEnvironment.mockReset();
  mocks.spawnSync.mockReset();
  mocks.spawnSync.mockReturnValue({ status: 0 });
  process.exitCode = 0;
  process.env.ALLOWED_ORIGINS = "*";
  delete process.env.R2_BUCKET_NAME;
  delete process.env.APP_HOSTNAME;
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
  delete process.env.R2_BUCKET_NAME;
  delete process.env.APP_HOSTNAME;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.sequential("Cloudflare command Turnstile configuration", () => {
  it("bootstraps staging without requiring a Turnstile site key", async () => {
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requiredCalls).toEqual([["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]]);
    expect(mocks.assertTurnstileSiteKeyForEnvironment).not.toHaveBeenCalled();
    expect(mocks.requestPaths.some((path) => path.includes("/challenges/"))).toBe(false);
    expect(mocks.requestPaths.some((path) => path.includes("staging-cloud-collab-assets"))).toBe(
      true,
    );
  });

  it("creates the zone custom-rules entrypoint when it is absent", async () => {
    mocks.wafScenario = "missing-ruleset";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    const creation = mocks.requestCalls.find(
      (call) => call.method === "POST" && call.path === `/zones/${"b".repeat(32)}/rulesets`,
    );
    expect(JSON.parse(creation?.body ?? "{}")).toMatchObject({
      kind: "zone",
      phase: "http_request_firewall_custom",
      rules: [
        {
          action: "skip",
          action_parameters: { phases: ["http_request_sbfm"] },
          enabled: true,
          expression:
            '(http.host eq "staging-cloud-collab.spacescale.net" and starts_with(http.request.uri.path, "/api/v1/organisations/"))',
        },
      ],
    });
    expect(JSON.parse(mocks.output.at(-1) ?? "{}").serverApiBotBypass).toMatchObject({
      applicable: true,
      created: true,
      updated: false,
      zoneName: "spacescale.net",
    });
  });

  it("adds a missing bot-bypass rule without replacing the ruleset", async () => {
    mocks.wafScenario = "missing-rule";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    const creation = mocks.requestCalls.find(
      (call) =>
        call.method === "POST" &&
        call.path === `/zones/${"b".repeat(32)}/rulesets/${"c".repeat(32)}/rules`,
    );
    expect(JSON.parse(creation?.body ?? "{}")).toMatchObject({
      position: { before: "e".repeat(32) },
    });
    expect(JSON.parse(mocks.output.at(-1) ?? "{}").serverApiBotBypass).toMatchObject({
      created: true,
      updated: false,
    });
  });

  it("repairs a drifted bot-bypass rule in place", async () => {
    mocks.wafScenario = "drifted";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    const update = mocks.requestCalls.find((call) => call.method === "PATCH");
    expect(update?.path).toBe(
      `/zones/${"b".repeat(32)}/rulesets/${"c".repeat(32)}/rules/${"d".repeat(32)}`,
    );
    expect(JSON.parse(update?.body ?? "{}")).toMatchObject({
      action: "skip",
      action_parameters: { phases: ["http_request_sbfm"] },
      enabled: true,
    });
    expect(JSON.parse(mocks.output.at(-1) ?? "{}").serverApiBotBypass).toMatchObject({
      created: false,
      updated: true,
    });
  });

  it("provisions production without requiring deploy-only public configuration", async () => {
    mocks.environment = "production";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "production"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requiredCalls).toEqual([["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]]);
    expect(mocks.assertTurnstileSiteKeyForEnvironment).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("requires production public configuration only when deployment is requested", async () => {
    mocks.environment = "production";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "production", "--deploy"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requiredCalls).toEqual([
      ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
      ["TURNSTILE_SITE_KEY"],
    ]);
    expect(mocks.assertTurnstileSiteKeyForEnvironment).toHaveBeenCalledWith(
      "real-turnstile-site-key",
      "production",
    );
    expect(mocks.spawnSync).toHaveBeenCalledOnce();
  });

  it("does not mutate existing private buckets on a provisioning rerun", async () => {
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requestCalls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(JSON.parse(mocks.output.at(-1) ?? "{}")).toMatchObject({
      created: false,
      assetCreated: false,
    });
  });

  it("creates only the missing private asset bucket", async () => {
    mocks.assetScenario = "missing";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    const postCalls = mocks.requestCalls.filter((call) => call.method === "POST");
    expect(postCalls).toHaveLength(1);
    expect(JSON.parse(postCalls[0]?.body ?? "{}")).toEqual({
      name: "staging-cloud-collab-assets",
    });
    expect(JSON.parse(mocks.output.at(-1) ?? "{}")).toMatchObject({
      created: false,
      assetCreated: true,
    });
  });

  it("re-reads and verifies an exact bucket after a first-create conflict", async () => {
    mocks.assetScenario = "conflict";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requestCalls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(mocks.assetLookupCount).toBe(2);
    expect(JSON.parse(mocks.output.at(-1) ?? "{}")).toMatchObject({
      created: false,
      assetCreated: false,
    });
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
    expect(mocks.output.join("")).toContain('"configuredAssetBucketExists":true');
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
