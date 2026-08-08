import { HttpError } from "./http/errors";

export type OrganisationWebhookDeliveryRequest = {
  url: string;
  body: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  allowedOrigins?: string;
};

export async function deliverOrganisationWebhook(
  delivery: OrganisationWebhookDeliveryRequest,
): Promise<number> {
  assertOrganisationWebhookOriginAllowed(delivery.url, delivery.allowedOrigins);
  let response: Response;
  try {
    response = await fetch(delivery.url, {
      method: "POST",
      headers: delivery.headers,
      body: delivery.body,
      redirect: "manual",
      signal: AbortSignal.timeout(delivery.timeoutMs),
    });
  } catch {
    throw deliveryFailed();
  }

  if (!response.ok) throw deliveryFailed();
  return response.status;
}

export function assertOrganisationWebhookOriginAllowed(
  webhookUrl: string,
  configuredOrigins: string | undefined,
): void {
  const allowedOrigins = parseAllowedOrigins(configuredOrigins);
  if (!allowedOrigins.has(new URL(webhookUrl).origin)) {
    throw new HttpError(
      403,
      "WEBHOOK_ORIGIN_NOT_ALLOWED",
      "The webhook origin is not approved by this SpaceScale deployment.",
    );
  }
}

function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === "") return new Set();
  if (new TextEncoder().encode(value).byteLength > 8 * 1_024) throw invalidPolicy();
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length > 64 || entries.some((entry) => entry.length === 0 || entry === "*")) {
    throw invalidPolicy();
  }
  const origins = new Set<string>();
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw invalidPolicy();
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== entry
    ) {
      throw invalidPolicy();
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function invalidPolicy(): HttpError {
  return new HttpError(
    503,
    "TEMPORARILY_UNAVAILABLE",
    "The organisation webhook destination policy is invalid.",
  );
}

function deliveryFailed(): HttpError {
  return new HttpError(
    502,
    "WEBHOOK_DELIVERY_FAILED",
    "The organisation webhook did not accept the board export.",
  );
}
