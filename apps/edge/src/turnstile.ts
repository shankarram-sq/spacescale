import { HttpError } from "./http/errors";
import type { Env } from "./types";

const LIKELY_AUTOMATED_SCORE_MAX = 29;
const AUTOMATION_USER_AGENT =
  /(?:\b(?:bot|crawler|spider)\b|headless|playwright|puppeteer|selenium|curl|wget|httpie|python-requests|scrapy|undici)/iu;

type BotManagementSignals = {
  score?: unknown;
  verifiedBot?: unknown;
  staticResource?: unknown;
  jsDetection?: { passed?: unknown };
};

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
  required = true,
): Promise<void> {
  if (env.TURNSTILE_ENABLED !== "true" || !required) return;
  if (typeof token !== "string" || token.length < 1 || token.length > 2_048) {
    throw new HttpError(428, "TURNSTILE_REQUIRED", "Browser verification is required.");
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

/**
 * Decides whether a browser should be challenged. Turnstile being configured
 * does not by itself require a token: normal browser traffic continues without
 * loading the widget.
 *
 * Cloudflare's Bot Management score is authoritative when present. The
 * fetch-metadata and user-agent checks are deliberately narrow fallbacks for
 * plans/environments where Bot Management fields are unavailable.
 */
export function turnstileRequiredForRequest(request: Request, env: Env): boolean {
  if (env.TURNSTILE_ENABLED !== "true") return false;

  const bot = botManagementSignals(request);
  if (bot !== null) {
    if (bot.verifiedBot === true || bot.staticResource === true) return false;
    if (
      typeof bot.score === "number" &&
      Number.isFinite(bot.score) &&
      bot.score >= 1 &&
      bot.score <= LIKELY_AUTOMATED_SCORE_MAX
    ) {
      return true;
    }
    if (bot.jsDetection?.passed === false) return true;
  }

  const userAgent = request.headers.get("user-agent")?.trim() ?? "";
  if (userAgent.length === 0 || AUTOMATION_USER_AGENT.test(userAgent)) return true;

  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "same-site";
}

function botManagementSignals(request: Request): BotManagementSignals | null {
  const cf = request.cf as unknown;
  if (!isRecord(cf) || !isRecord(cf.botManagement)) return null;
  const bot = cf.botManagement;
  return {
    score: bot.score,
    verifiedBot: bot.verifiedBot,
    staticResource: bot.staticResource,
    ...(isRecord(bot.jsDetection) ? { jsDetection: { passed: bot.jsDetection.passed } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
