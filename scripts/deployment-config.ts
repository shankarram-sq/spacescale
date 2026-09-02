import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type DeploymentEnvironment = "development" | "staging" | "production";

export type DeploymentConfiguration = {
  environment: DeploymentEnvironment;
  workerName: string;
  bucketName: string;
  assetBucketName: string;
  jurisdiction: "default" | "eu" | "fedramp";
  hostname: string;
  turnstileEnabled: boolean;
  boardCreationEnabled: boolean;
  allowedOrigins: string;
  webhookAllowedOrigins: string;
  turnstileSiteKey?: string;
};

export class DeploymentConfigurationError extends Error {
  constructor(fields: string[] = []) {
    const detail = fields.length > 0 ? ` Check: ${fields.join(", ")}.` : "";
    super(
      `Deployment initialization is incomplete or invalid.${detail} Copy .env.sample to .env, replace every required placeholder, and run \`npm run deployment:init -- --env <environment>\`.`,
    );
    this.name = "DeploymentConfigurationError";
  }
}

const PLACEHOLDER_PREFIX = "replace-with-";
const GENERATED_DIRECTORY = ".generated";

export function generatedWranglerConfigPath(environment: DeploymentEnvironment): string {
  return `${GENERATED_DIRECTORY}/wrangler.${environment}.jsonc`;
}

export function parseDeploymentEnvironment(value: string | undefined): DeploymentEnvironment {
  if (value === "development" || value === "staging" || value === "production") return value;
  throw new DeploymentConfigurationError();
}

export function deploymentConfigurationFromEnvironment(
  environment: DeploymentEnvironment,
  values: NodeJS.ProcessEnv,
): DeploymentConfiguration {
  if (environment === "development") return localDevelopmentConfiguration(values);

  const deploymentName = optionalValue(values.DEPLOYMENT_NAME);
  const configuredHostname = optionalValue(values.APP_HOSTNAME);
  const legacyMappings = [
    "R2_BUCKET_NAME",
    "R2_ASSET_BUCKET_NAME",
    "CLOUDFLARE_WORKER_NAME",
  ].filter((name) => optionalValue(values[name]) !== undefined);
  const requiredDetails = [
    ...(deploymentName ? [] : ["DEPLOYMENT_NAME"]),
    ...(configuredHostname ? [] : ["APP_HOSTNAME"]),
    ...legacyMappings,
  ];
  if (!deploymentName || !configuredHostname || legacyMappings.length > 0) {
    throw new DeploymentConfigurationError(requiredDetails);
  }

  const hostname = normalizeHostname(configuredHostname);
  const resourceNames = derivedResourceNames(deploymentName, environment);
  const jurisdiction = optionalValue(values.R2_BUCKET_JURISDICTION) ?? "default";
  const turnstileEnabled = booleanValue(values.TURNSTILE_ENABLED, environment === "production");
  const boardCreationEnabled = booleanValue(values.BOARD_CREATION_ENABLED, true);

  if (
    !validDeploymentName(deploymentName) ||
    !validHostname(hostname) ||
    (jurisdiction !== "default" && jurisdiction !== "eu" && jurisdiction !== "fedramp")
  ) {
    throw new DeploymentConfigurationError([
      "DEPLOYMENT_NAME",
      "APP_HOSTNAME",
      "R2_BUCKET_JURISDICTION",
    ]);
  }

  const turnstileSiteKey = optionalValue(values.TURNSTILE_SITE_KEY);
  if (turnstileEnabled && !turnstileSiteKey) {
    throw new DeploymentConfigurationError(["TURNSTILE_SITE_KEY"]);
  }

  return {
    environment,
    ...resourceNames,
    jurisdiction,
    hostname,
    turnstileEnabled,
    boardCreationEnabled,
    allowedOrigins: values.ALLOWED_ORIGINS?.trim() ?? "",
    webhookAllowedOrigins: values.WEBHOOK_ALLOWED_ORIGINS?.trim() ?? "",
    ...(turnstileSiteKey ? { turnstileSiteKey } : {}),
  };
}

export function writeGeneratedWranglerConfig(configuration: DeploymentConfiguration): string {
  const path = generatedWranglerConfigPath(configuration.environment);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(wranglerConfiguration(configuration), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

function wranglerConfiguration(configuration: DeploymentConfiguration): Record<string, unknown> {
  const local = configuration.environment === "development";
  const workersDev = local || configuration.hostname.endsWith(".workers.dev");
  return {
    $schema: "../node_modules/wrangler/config-schema.json",
    name: configuration.workerName,
    main: "../apps/edge/src/gateway.ts",
    compatibility_date: "2026-08-04",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: workersDev,
    ...(local || workersDev ? { routes: [] } : {}),
    assets: {
      directory: "../apps/web/dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    },
    durable_objects: {
      bindings: [
        { name: "BOARD_ROOMS", class_name: "BoardRoom" },
        { name: "ORGANISATION_ROOMS", class_name: "OrganisationRoom" },
      ],
    },
    exports: {
      BoardRoom: { type: "durable-object", storage: "sqlite" },
      OrganisationRoom: { type: "durable-object", storage: "sqlite" },
    },
    r2_buckets: [
      { binding: "BOARD_SNAPSHOTS", bucket_name: configuration.bucketName },
      { binding: "BOARD_ASSETS", bucket_name: configuration.assetBucketName },
    ],
    vars: {
      APP_HOSTNAME: configuration.hostname,
      BOARD_CREATION_ENABLED: String(configuration.boardCreationEnabled),
      ALLOWED_ORIGINS: configuration.allowedOrigins,
      WEBHOOK_ALLOWED_ORIGINS: configuration.webhookAllowedOrigins,
      TURNSTILE_ENABLED: String(configuration.turnstileEnabled),
      ENVIRONMENT: configuration.environment,
      ...(configuration.turnstileSiteKey
        ? { TURNSTILE_SITE_KEY: configuration.turnstileSiteKey }
        : {}),
    },
    observability: { enabled: true, head_sampling_rate: 1 },
    version_metadata: { binding: "WORKER_VERSION" },
  };
}

function localDevelopmentConfiguration(values: NodeJS.ProcessEnv): DeploymentConfiguration {
  const deploymentName = optionalValue(values.DEPLOYMENT_NAME) ?? "spacescale";
  if (!validDeploymentName(deploymentName)) {
    throw new DeploymentConfigurationError(["DEPLOYMENT_NAME"]);
  }
  return {
    environment: "development",
    ...derivedResourceNames(deploymentName, "development"),
    jurisdiction: "default",
    hostname: "localhost",
    turnstileEnabled: false,
    boardCreationEnabled: true,
    allowedOrigins:
      "http://localhost,http://localhost:4173,http://localhost:5173,https://127.0.0.1:8787",
    webhookAllowedOrigins: "",
    turnstileSiteKey: "1x00000000000000000000AA",
  };
}

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.startsWith(PLACEHOLDER_PREFIX)) return undefined;
  return normalized;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  const normalized = optionalValue(value);
  if (normalized === undefined) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new DeploymentConfigurationError();
}

function normalizeHostname(value: string): string {
  if (!value.startsWith("https://")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DeploymentConfigurationError();
  }
  if (url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new DeploymentConfigurationError();
  }
  return url.hostname;
}

function derivedResourceNames(
  deploymentName: string,
  environment: DeploymentEnvironment,
): Pick<DeploymentConfiguration, "workerName" | "bucketName" | "assetBucketName"> {
  const prefix = `${deploymentName}-${environment}`;
  return {
    workerName: prefix,
    bucketName: `${prefix}-snapshots`,
    assetBucketName: `${prefix}-assets`,
  };
}

function validDeploymentName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/u.test(value);
}

function validHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(value)
  );
}
