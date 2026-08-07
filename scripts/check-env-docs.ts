import { readFileSync } from "node:fs";

type EnvironmentName = "development" | "staging" | "production";
type EnvironmentConfiguration = {
  bucketName: string;
  assetBucketName: string;
  jurisdiction: "default" | "eu" | "fedramp";
  hostname: string;
  turnstileEnabled: boolean;
  boardCreationEnabled: boolean;
};
type WranglerEnvironment = {
  assets?: { run_worker_first?: unknown };
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  vars?: Record<string, string>;
  workers_dev?: boolean;
  routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
};
type WranglerConfiguration = WranglerEnvironment & {
  env?: Partial<Record<"development" | "staging", WranglerEnvironment>>;
};

const sample = readFileSync(".env.sample", "utf8");
const readme = readFileSync("README.md", "utf8");
const operations = readFileSync("docs/operations.md", "utf8");
const wranglerSource = readFileSync("wrangler.jsonc", "utf8");
const wrangler = JSON.parse(wranglerSource) as WranglerConfiguration;
const environments = JSON.parse(readFileSync("config/environments.json", "utf8")) as Record<
  EnvironmentName,
  EnvironmentConfiguration
>;
const gitignoreLines = readFileSync(".gitignore", "utf8").split(/\r?\n/u);
const sampleEntries: Array<[string, string]> = [];
for (const match of sample.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gmu)) {
  const key = match[1];
  const value = match[2];
  if (key !== undefined && value !== undefined) sampleEntries.push([key, value]);
}
const sampleValues = Object.fromEntries(sampleEntries) as Record<string, string>;
const keys = sampleEntries.map(([key]) => key);
const missing = keys.filter((key) => !readme.includes(`\`${key}\``));

const errors: string[] = [];
if (!readme.includes("## Cloudflare setup")) errors.push("README lacks a Cloudflare setup section");
if (!gitignoreLines.includes(".env")) errors.push(".env is not ignored");
if (!gitignoreLines.includes(".env.*")) errors.push(".env variants are not ignored");
if (!gitignoreLines.includes("!.env.sample")) errors.push(".env.sample is not unignored");
if (!gitignoreLines.includes(".dev.vars")) errors.push(".dev.vars is not ignored");

for (const forbiddenBinding of [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "CLASSROOM_INTEGRATION_KEY",
  "SESSION_SIGNING_KEY_CURRENT",
  "SESSION_SIGNING_KEY_PREVIOUS",
  "TURNSTILE_SECRET_KEY",
]) {
  if (wranglerSource.includes(forbiddenBinding)) {
    errors.push(`${forbiddenBinding} must not be a committed Worker binding`);
  }
}

const wranglerEnvironments: Record<EnvironmentName, WranglerEnvironment | undefined> = {
  development: wrangler.env?.development,
  staging: wrangler.env?.staging,
  production: wrangler,
};
for (const environmentName of ["development", "staging", "production"] as const) {
  const environment = environments[environmentName];
  const deployed = wranglerEnvironments[environmentName];
  if (!environment || !deployed) {
    errors.push(`Missing ${environmentName} environment configuration`);
    continue;
  }
  if (deployed.assets?.run_worker_first !== true) {
    errors.push(`${environmentName} Static Assets must run the Worker first`);
  }
  const snapshotBucket = deployed.r2_buckets?.find(
    (binding) => binding.binding === "BOARD_SNAPSHOTS",
  );
  const assetBucket = deployed.r2_buckets?.find((binding) => binding.binding === "BOARD_ASSETS");
  if (
    snapshotBucket?.bucket_name !== environment.bucketName ||
    assetBucket?.bucket_name !== environment.assetBucketName
  ) {
    errors.push(`${environmentName} R2 bindings do not match committed environment configuration`);
  }
  const expectedVariables = {
    APP_HOSTNAME: environment.hostname,
    BOARD_CREATION_ENABLED: String(environment.boardCreationEnabled),
    TURNSTILE_ENABLED: String(environment.turnstileEnabled),
    ENVIRONMENT: environmentName,
  };
  for (const [name, value] of Object.entries(expectedVariables)) {
    if (deployed.vars?.[name] !== value) {
      errors.push(`${environmentName} ${name} does not match committed environment configuration`);
    }
  }
  if (environmentName !== "development" && deployed.vars?.TURNSTILE_SITE_KEY !== undefined) {
    errors.push(
      `${environmentName} TURNSTILE_SITE_KEY must be supplied by the deployment environment`,
    );
  }
  if (environmentName === "development") {
    if (deployed.workers_dev !== true || (deployed.routes?.length ?? 0) !== 0) {
      errors.push("development must use its isolated workers.dev deployment without routes");
    }
  } else {
    const customDomain = deployed.routes?.find(
      (route) => route.pattern === environment.hostname && route.custom_domain === true,
    );
    if (deployed.workers_dev !== false || customDomain === undefined) {
      errors.push(
        `${environmentName} must be fail-closed to workers.dev and attached to its custom domain`,
      );
    }
  }
}

const production = environments.production;
if (sampleValues.R2_BUCKET_NAME !== production.bucketName) {
  errors.push(".env.sample R2_BUCKET_NAME does not match production configuration");
}
if (sampleValues.APP_HOSTNAME !== production.hostname) {
  errors.push(".env.sample APP_HOSTNAME does not match production configuration");
}
if (sampleValues.BOARD_CREATION_ENABLED !== String(production.boardCreationEnabled)) {
  errors.push(".env.sample BOARD_CREATION_ENABLED does not match production configuration");
}
if (
  !readme.includes(environments.staging.hostname) ||
  !operations.includes(environments.staging.hostname)
) {
  errors.push("Staging hostname is not documented in both deployment guides");
}
if (
  !readme.includes(environments.production.hostname) ||
  !operations.includes(environments.production.hostname)
) {
  errors.push("Production hostname is not documented in both deployment guides");
}
if (!readme.includes("--env staging") || !operations.includes("--env staging")) {
  errors.push("Staging Wrangler secret commands are not explicit in both deployment guides");
}
if (missing.length > 0) {
  errors.push(`README Cloudflare setup is missing .env.sample keys: ${missing.join(", ")}`);
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({ ok: true, documentedEnvironmentKeys: keys.length, validatedEnvironments: 3 })}\n`,
  );
}
