import { HttpError } from "./http/errors";
import type { Env } from "./types";

interface TurnstileResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  "error-codes"?: unknown;
}

export async function validateTurnstile(
  token: unknown,
  env: Env,
  expectedAction = "board_create",
): Promise<void> {
  if (env.TURNSTILE_ENABLED !== "true") return;
  if (typeof token !== "string" || token.length < 1 || token.length > 2_048) {
    throw new HttpError(400, "TURNSTILE_FAILED", "Human verification is required.");
  }
  if (!env.TURNSTILE_SECRET_KEY) {
    throw new HttpError(503, "TEMPORARILY_UNAVAILABLE", "Human verification is unavailable.");
  }
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  form.set("idempotency_key", crypto.randomUUID());
  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new HttpError(503, "TEMPORARILY_UNAVAILABLE", "Human verification is unavailable.");
  }
  if (!response.ok) {
    throw new HttpError(503, "TEMPORARILY_UNAVAILABLE", "Human verification is unavailable.");
  }
  let result: TurnstileResponse;
  try {
    result = (await response.json()) as TurnstileResponse;
  } catch {
    throw new HttpError(503, "TEMPORARILY_UNAVAILABLE", "Human verification is unavailable.");
  }
  if (
    result.success !== true ||
    result.hostname !== env.APP_HOSTNAME ||
    result.action !== expectedAction
  ) {
    throw new HttpError(403, "TURNSTILE_FAILED", "Human verification failed.");
  }
}
