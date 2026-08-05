import { existsSync, readFileSync } from "node:fs";

export function loadLocalEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Keep runtime configuration canonical while accepting the common local
    // mistake of pasting an HTTPS origin into the hostname-only .env field.
    if (key === "APP_HOSTNAME" && value.startsWith("https://")) {
      const url = new URL(value);
      if (url.pathname !== "/" || url.search || url.hash || url.port) {
        throw new Error("APP_HOSTNAME may not contain a port, path, query, or fragment.");
      }
      value = url.hostname;
    }
    process.env[key] = value;
  }
}

export function requireEnvironment(names: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (!value || value.startsWith("replace-with-")) missing.push(name);
    else values[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(`Missing configured environment variables: ${missing.join(", ")}`);
  }
  return values;
}

export function assertPublicConfiguration(values: Record<string, string>): void {
  if (
    values.CLOUDFLARE_ACCOUNT_ID !== undefined &&
    !/^[a-f\d]{32}$/iu.test(values.CLOUDFLARE_ACCOUNT_ID)
  ) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal identifier.");
  }
  const hostname = values.APP_HOSTNAME;
  if (
    hostname &&
    hostname !== "localhost" &&
    (!/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(
      hostname,
    ) ||
      hostname.includes("://") ||
      hostname.includes("/"))
  ) {
    throw new Error("APP_HOSTNAME must contain only a valid hostname.");
  }
  const signingKey = values.SESSION_SIGNING_KEY_CURRENT;
  if (signingKey) {
    const looksBase64 = /^[A-Za-z\d+/]+={0,2}$/u.test(signingKey) && signingKey.length % 4 === 0;
    const keyBytes = looksBase64
      ? Buffer.from(signingKey, "base64").byteLength
      : Buffer.byteLength(signingKey, "utf8");
    if (keyBytes < 32) {
      throw new Error("SESSION_SIGNING_KEY_CURRENT must contain at least 32 random bytes.");
    }
  }
}

export function assertTurnstileSiteKeyForEnvironment(
  siteKey: string,
  environment: "development" | "staging" | "production",
): void {
  if (siteKey.startsWith("replace-with-") || siteKey.length < 10) {
    throw new Error("TURNSTILE_SITE_KEY must be a configured public widget site key.");
  }
  if (environment !== "development" && /^[123]x0{10,}/u.test(siteKey)) {
    throw new Error(`Cloudflare Turnstile test site keys are forbidden in ${environment}.`);
  }
}

export type CloudflareEnvelope<T> = {
  success: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
};

export async function cloudflareRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; envelope: CloudflareEnvelope<T> }> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not configured.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  let envelope: CloudflareEnvelope<T>;
  try {
    envelope = (await response.json()) as CloudflareEnvelope<T>;
  } catch {
    envelope = { success: false, errors: [{ code: response.status }] };
  }
  return { response, envelope };
}

export function publicApiFailure(
  label: string,
  response: Response,
  envelope: CloudflareEnvelope<unknown>,
): Error {
  const codes = (envelope.errors ?? [])
    .map((error) => error.code)
    .filter((code): code is number => typeof code === "number");
  return new Error(
    `${label} failed (HTTP ${response.status}; codes ${codes.join(",") || "none"}).`,
  );
}
