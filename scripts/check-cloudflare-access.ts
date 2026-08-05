import { readFileSync } from "node:fs";
import {
  assertPublicConfiguration,
  assertTurnstileSiteKeyForEnvironment,
  cloudflareRequest,
  loadLocalEnv,
  requireEnvironment,
} from "./env.ts";

type Bucket = { name: string; jurisdiction?: string };
type BucketList = { buckets?: Bucket[] } | Bucket[];
type EnvironmentName = "development" | "staging" | "production";
type PublicEnvironment = {
  bucketName: string;
  hostname: string;
  turnstileEnabled: boolean;
  boardCreationEnabled: boolean;
};
type TurnstileWidget = {
  sitekey?: string;
  secret?: string;
  domains?: string[];
};
type WorkerDomain = { hostname?: string; service?: string; cert_id?: string };

loadLocalEnv();
const env = requireEnvironment([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "SESSION_SIGNING_KEY_CURRENT",
  "CLASSROOM_INTEGRATION_KEY",
  "R2_BUCKET_NAME",
  "APP_HOSTNAME",
] as const);
env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.trim() ?? "";
assertPublicConfiguration(env);

const environments = JSON.parse(readFileSync("config/environments.json", "utf8")) as Record<
  EnvironmentName,
  PublicEnvironment
>;
const selectedEnvironment = (
  Object.entries(environments) as Array<[EnvironmentName, PublicEnvironment]>
).find(
  ([, configuration]) =>
    configuration.bucketName === env.R2_BUCKET_NAME && configuration.hostname === env.APP_HOSTNAME,
);
if (!selectedEnvironment) {
  throw new Error(
    "APP_HOSTNAME and R2_BUCKET_NAME do not identify the same committed deployment environment.",
  );
}
const [environmentName, environmentConfiguration] = selectedEnvironment;
if (environmentConfiguration.turnstileEnabled) {
  Object.assign(env, requireEnvironment(["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"] as const));
  assertTurnstileSiteKeyForEnvironment(env.TURNSTILE_SITE_KEY ?? "", environmentName);
}
const requestedBoardCreation = process.env.BOARD_CREATION_ENABLED?.trim();
if (
  requestedBoardCreation !== undefined &&
  requestedBoardCreation !== String(environmentConfiguration.boardCreationEnabled)
) {
  throw new Error(
    `BOARD_CREATION_ENABLED does not match committed ${environmentName} configuration (${environmentConfiguration.boardCreationEnabled}).`,
  );
}

const account = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID ?? "");

function report(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const token = await cloudflareRequest<{ status?: string }>(`/accounts/${account}/tokens/verify`);
report({
  check: "public_configuration",
  environment: environmentName,
  hostnameMatchesCommittedConfiguration: true,
  bucketMatchesCommittedConfiguration: true,
  turnstileEnabled: environmentConfiguration.turnstileEnabled,
  boardCreationEnabled: environmentConfiguration.boardCreationEnabled,
});

report({
  check: "account_token",
  httpStatus: token.response.status,
  success: token.envelope.success,
  status: token.envelope.result?.status ?? null,
  errorCodes: (token.envelope.errors ?? []).map((error) => error.code),
});

const workers = await cloudflareRequest<unknown[]>(`/accounts/${account}/workers/scripts`);
report({
  check: "workers_access",
  httpStatus: workers.response.status,
  success: workers.envelope.success,
  errorCodes: (workers.envelope.errors ?? []).map((error) => error.code),
});

const domains = await cloudflareRequest<WorkerDomain[]>(
  `/accounts/${account}/workers/domains?hostname=${encodeURIComponent(env.APP_HOSTNAME ?? "")}`,
);
const configuredDomain = domains.envelope.result?.find(
  (domain) => domain.hostname === env.APP_HOSTNAME,
);
const expectedWorkerService =
  environmentName === "production"
    ? "cloudflare-collab-canvas"
    : `cloudflare-collab-canvas-${environmentName}`;
const expectedWorkerAttached = configuredDomain?.service === expectedWorkerService;
report({
  check: "workers_domain_access",
  httpStatus: domains.response.status,
  success: domains.envelope.success,
  configuredHostnameAttached: configuredDomain !== undefined,
  certificateAssigned: configuredDomain?.cert_id
    ? true
    : configuredDomain === undefined
      ? null
      : false,
  expectedWorkerAttached,
  predeployAttachmentRequired:
    environmentConfiguration.hostname !== "localhost" &&
    !environmentConfiguration.hostname.endsWith(".workers.dev") &&
    configuredDomain === undefined,
  errorCodes: (domains.envelope.errors ?? []).map((error) => error.code),
});

const buckets = await cloudflareRequest<BucketList>(
  `/accounts/${account}/r2/buckets?per_page=1000`,
);
const result = buckets.envelope.result;
const bucketList = Array.isArray(result) ? result : (result?.buckets ?? []);
report({
  check: "r2_access",
  httpStatus: buckets.response.status,
  success: buckets.envelope.success,
  configuredBucketExists: bucketList.some((bucket) => bucket.name === env.R2_BUCKET_NAME),
  bucketCount: bucketList.length,
  errorCodes: (buckets.envelope.errors ?? []).map((error) => error.code),
});

let turnstileAccessInvalid = false;
if (environmentConfiguration.turnstileEnabled) {
  const turnstileBody = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY ?? "",
    response: "codex-credential-validation-probe",
  });
  const turnstileResponse = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: turnstileBody,
      signal: AbortSignal.timeout(15_000),
    },
  );
  const turnstile = (await turnstileResponse.json()) as {
    success?: boolean;
    "error-codes"?: string[];
  };
  const turnstileErrors = turnstile["error-codes"] ?? [];
  report({
    check: "turnstile_secret",
    httpStatus: turnstileResponse.status,
    endpointReachable: turnstileResponse.ok,
    secretAccepted: !turnstileErrors.includes("invalid-input-secret"),
    expectedProbeRejected: turnstile.success === false,
    errorCodes: turnstileErrors,
  });

  // This lookup is intentionally optional: the least-privilege Workers/R2 token
  // documented by the project cannot read Turnstile widget configuration. When
  // a token with Turnstile Sites Read is used, validate the public key, allowed
  // hostname, and (when Cloudflare returns it) the Siteverify secret as one unit.
  const widget = await cloudflareRequest<TurnstileWidget>(
    `/accounts/${account}/challenges/widgets/${encodeURIComponent(env.TURNSTILE_SITE_KEY ?? "")}`,
  );
  const widgetReadable = widget.response.ok && widget.envelope.success && !!widget.envelope.result;
  const widgetSiteKeyMatches = widgetReadable
    ? widget.envelope.result?.sitekey === env.TURNSTILE_SITE_KEY
    : null;
  const widgetHostnameAllowed = widgetReadable
    ? widget.envelope.result?.domains?.includes(env.APP_HOSTNAME ?? "") === true
    : null;
  const returnedWidgetSecret = widget.envelope.result?.secret;
  const widgetSecretMatches =
    widgetReadable && typeof returnedWidgetSecret === "string"
      ? returnedWidgetSecret === env.TURNSTILE_SECRET_KEY
      : null;
  report({
    check: "turnstile_widget_pairing",
    httpStatus: widget.response.status,
    widgetReadable,
    siteKeyMatches: widgetSiteKeyMatches,
    hostnameAllowed: widgetHostnameAllowed,
    secretPairingValidated: widgetSecretMatches,
    manualDashboardConfirmationRequired: !widgetReadable || widgetSecretMatches === null,
    errorCodes: (widget.envelope.errors ?? []).map((error) => error.code),
  });

  const readableWidgetInvalid =
    widgetReadable &&
    (widgetSiteKeyMatches !== true ||
      widgetHostnameAllowed !== true ||
      widgetSecretMatches === false);
  turnstileAccessInvalid =
    !turnstileResponse.ok ||
    turnstileErrors.includes("invalid-input-secret") ||
    readableWidgetInvalid;
} else {
  report({
    check: "turnstile",
    enabled: false,
    skipped: true,
  });
}
if (
  !token.envelope.success ||
  token.envelope.result?.status !== "active" ||
  !workers.envelope.success ||
  !domains.envelope.success ||
  (configuredDomain !== undefined && !expectedWorkerAttached) ||
  !buckets.envelope.success ||
  turnstileAccessInvalid
) {
  process.exitCode = 1;
}
