import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  assertPublicConfiguration,
  assertTurnstileSiteKeyForEnvironment,
  cloudflareRequest,
  loadLocalEnv,
  publicApiFailure,
  requireEnvironment,
} from "./env.ts";

type EnvironmentName = "development" | "staging" | "production";
type EnvironmentConfiguration = {
  bucketName: string;
  assetBucketName: string;
  jurisdiction: "default" | "eu" | "fedramp";
  hostname: string;
  turnstileEnabled: boolean;
  boardCreationEnabled: boolean;
};
type Bucket = {
  name: string;
  jurisdiction?: string;
  creation_date?: string;
  location?: string;
  storage_class?: string;
};

function jurisdictionHeaders(
  configuration: EnvironmentConfiguration,
): Record<string, string> | undefined {
  return configuration.jurisdiction === "default"
    ? undefined
    : { "cf-r2-jurisdiction": configuration.jurisdiction };
}

function parseArguments(args: string[]): { environment: EnvironmentName; deploy: boolean } {
  let environment: EnvironmentName | undefined;
  let deploy = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--env") {
      const candidate = args[index + 1];
      if (candidate === "development" || candidate === "staging" || candidate === "production") {
        environment = candidate;
        index += 1;
        continue;
      }
      throw new Error("--env must be development, staging, or production.");
    }
    if (value === "--deploy") {
      deploy = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!environment)
    throw new Error("Usage: npm run cf:bootstrap -- --env <environment> [--deploy]");
  return { environment, deploy };
}

function configurationFor(environment: EnvironmentName): EnvironmentConfiguration {
  const raw = JSON.parse(readFileSync("config/environments.json", "utf8")) as Record<
    string,
    EnvironmentConfiguration
  >;
  const configuration = raw[environment];
  if (!configuration) throw new Error(`No committed configuration for ${environment}.`);
  for (const bucketName of [configuration.bucketName, configuration.assetBucketName]) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucketName)) {
      throw new Error(`Committed bucket name for ${environment} is invalid.`);
    }
  }
  if (configuration.bucketName === configuration.assetBucketName) {
    throw new Error(`Committed buckets for ${environment} must be distinct.`);
  }
  if (!configuration.hostname || typeof configuration.hostname !== "string") {
    throw new Error(`Committed hostname for ${environment} is invalid.`);
  }
  if (
    typeof configuration.turnstileEnabled !== "boolean" ||
    typeof configuration.boardCreationEnabled !== "boolean"
  ) {
    throw new Error(`Committed public switches for ${environment} are invalid.`);
  }
  return configuration;
}

async function getBucket(
  account: string,
  configuration: EnvironmentConfiguration,
): Promise<Bucket | undefined> {
  const result = await cloudflareRequest<Bucket>(
    `/accounts/${account}/r2/buckets/${encodeURIComponent(configuration.bucketName)}`,
    { headers: jurisdictionHeaders(configuration) },
  );
  if (result.response.status === 404) return undefined;
  if (!result.response.ok || !result.envelope.success || !result.envelope.result) {
    throw publicApiFailure("R2 bucket lookup", result.response, result.envelope);
  }
  return result.envelope.result;
}

async function createBucket(
  account: string,
  configuration: EnvironmentConfiguration,
): Promise<Bucket | undefined> {
  const result = await cloudflareRequest<Bucket>(`/accounts/${account}/r2/buckets`, {
    method: "POST",
    headers: jurisdictionHeaders(configuration),
    body: JSON.stringify({ name: configuration.bucketName }),
  });
  // A concurrent first deployment may create this exact bucket between our
  // lookup and create calls. The caller re-reads and fully verifies it.
  if (result.response.status === 409) return undefined;
  if (!result.response.ok || !result.envelope.success || !result.envelope.result) {
    throw publicApiFailure("R2 bucket creation", result.response, result.envelope);
  }
  return result.envelope.result;
}

function verifyBucket(bucket: Bucket, configuration: EnvironmentConfiguration): void {
  if (bucket.name !== configuration.bucketName) {
    throw new Error("Cloudflare returned a bucket with an unexpected name.");
  }
  const actualJurisdiction = bucket.jurisdiction ?? "default";
  if (actualJurisdiction !== configuration.jurisdiction) {
    throw new Error(
      `Existing bucket jurisdiction ${actualJurisdiction} is incompatible with ${configuration.jurisdiction}.`,
    );
  }
}

async function assertBucketPrivate(
  account: string,
  configuration: EnvironmentConfiguration,
): Promise<void> {
  const name = encodeURIComponent(configuration.bucketName);
  const headers = jurisdictionHeaders(configuration);
  const managed = await cloudflareRequest<{ enabled?: boolean }>(
    `/accounts/${account}/r2/buckets/${name}/domains/managed`,
    { headers },
  );
  if (managed.response.status !== 404 && !managed.envelope.success) {
    throw publicApiFailure("R2 managed-domain check", managed.response, managed.envelope);
  }
  if (managed.envelope.result?.enabled === true) {
    throw new Error(
      "The R2 bucket has a public r2.dev managed domain; disable it before deployment.",
    );
  }
  const custom = await cloudflareRequest<{ domains?: unknown[] }>(
    `/accounts/${account}/r2/buckets/${name}/domains/custom`,
    { headers },
  );
  if (custom.response.status !== 404 && !custom.envelope.success) {
    throw publicApiFailure("R2 custom-domain check", custom.response, custom.envelope);
  }
  if ((custom.envelope.result?.domains?.length ?? 0) > 0) {
    throw new Error("The R2 bucket has a public custom domain; remove it before deployment.");
  }
}

async function provisionPrivateBucket(
  account: string,
  configuration: EnvironmentConfiguration,
): Promise<boolean> {
  let bucket = await getBucket(account, configuration);
  let created = false;
  if (!bucket) {
    const createdBucket = await createBucket(account, configuration);
    if (createdBucket) {
      bucket = createdBucket;
      created = true;
    } else {
      bucket = await getBucket(account, configuration);
    }
  }
  if (!bucket) {
    throw new Error("R2 bucket creation conflicted, but the exact bucket could not be verified.");
  }
  verifyBucket(bucket, configuration);
  await assertBucketPrivate(account, configuration);
  return created;
}

loadLocalEnv();
const args = parseArguments(process.argv.slice(2));
const configuration = configurationFor(args.environment);
const env = requireEnvironment(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const);
assertPublicConfiguration(env);

const requestedBucketName = process.env.R2_BUCKET_NAME?.trim();
if (requestedBucketName !== undefined && requestedBucketName !== configuration.bucketName) {
  throw new Error(
    `R2_BUCKET_NAME does not match committed ${args.environment} configuration (${configuration.bucketName}).`,
  );
}
const requestedHostname = process.env.APP_HOSTNAME?.trim();
if (requestedHostname !== undefined && requestedHostname !== configuration.hostname) {
  throw new Error(
    `APP_HOSTNAME does not match committed ${args.environment} configuration (${configuration.hostname}).`,
  );
}

if (args.deploy) {
  env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.trim() ?? "";
  assertPublicConfiguration({
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
    APP_HOSTNAME: configuration.hostname,
  });
  if (configuration.turnstileEnabled) {
    Object.assign(env, requireEnvironment(["TURNSTILE_SITE_KEY"] as const));
    assertTurnstileSiteKeyForEnvironment(env.TURNSTILE_SITE_KEY ?? "", args.environment);
  }

  const requestedBoardCreation = process.env.BOARD_CREATION_ENABLED?.trim();
  if (requestedBoardCreation !== undefined && !/^(?:true|false)$/u.test(requestedBoardCreation)) {
    throw new Error("BOARD_CREATION_ENABLED must be exactly true or false when provided.");
  }
  if (
    requestedBoardCreation !== undefined &&
    requestedBoardCreation !== String(configuration.boardCreationEnabled)
  ) {
    throw new Error(
      `BOARD_CREATION_ENABLED does not match committed ${args.environment} configuration (${configuration.boardCreationEnabled}).`,
    );
  }
}

const account = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID ?? "");
const tokenCheck = await cloudflareRequest<{ status?: string }>(
  `/accounts/${account}/tokens/verify`,
);
if (!tokenCheck.envelope.success || tokenCheck.envelope.result?.status !== "active") {
  throw publicApiFailure(
    "Cloudflare account token verification",
    tokenCheck.response,
    tokenCheck.envelope,
  );
}

const created = await provisionPrivateBucket(account, configuration);
const assetBucketConfiguration: EnvironmentConfiguration = {
  ...configuration,
  bucketName: configuration.assetBucketName,
};
const assetCreated = await provisionPrivateBucket(account, assetBucketConfiguration);

const result = {
  ok: true,
  environment: args.environment,
  bucketName: configuration.bucketName,
  assetBucketName: configuration.assetBucketName,
  jurisdiction: configuration.jurisdiction,
  hostname: configuration.hostname,
  turnstileEnabled: configuration.turnstileEnabled,
  boardCreationEnabled: configuration.boardCreationEnabled,
  created,
  assetCreated,
  private: true,
  deployment: args.deploy ? "starting" : "not_requested",
  nextCommand: args.deploy ? null : `npm run cf:bootstrap -- --env ${args.environment} --deploy`,
};
process.stdout.write(`${JSON.stringify(result)}\n`);

if (args.deploy) {
  const wranglerArguments = ["wrangler", "deploy"];
  if (args.environment !== "production") {
    wranglerArguments.push("--env", args.environment);
  }
  wranglerArguments.push(
    "--var",
    `APP_HOSTNAME:${configuration.hostname}`,
    "--var",
    `BOARD_CREATION_ENABLED:${configuration.boardCreationEnabled}`,
    "--var",
    `ALLOWED_ORIGINS:${env.ALLOWED_ORIGINS}`,
    "--var",
    `TURNSTILE_ENABLED:${configuration.turnstileEnabled}`,
    "--var",
    `ENVIRONMENT:${args.environment}`,
  );
  if (configuration.turnstileEnabled) {
    wranglerArguments.push("--var", `TURNSTILE_SITE_KEY:${env.TURNSTILE_SITE_KEY}`);
  }
  const deployment = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    wranglerArguments,
    { stdio: "inherit", env: process.env },
  );
  if (deployment.error) throw deployment.error;
  if (deployment.status !== 0) process.exitCode = deployment.status ?? 1;
}
