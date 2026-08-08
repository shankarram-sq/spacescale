/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { turnstileRequiredForRequest, validateTurnstile } from "./turnstile";
import type { Env } from "./types";

const TEST_SECRET = "synthetic-turnstile-secret";

function enabledEnv(overrides: Partial<Env> = {}): Env {
  return {
    TURNSTILE_ENABLED: "true",
    TURNSTILE_SECRET_KEY: TEST_SECRET,
    APP_HOSTNAME: "canvas.example.test",
    ...overrides,
  } as Env;
}

function siteverifyResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function riskRequest(
  userAgent: string,
  botManagement?: Record<string, unknown>,
  fetchSite = "same-origin",
): Request {
  const request = new Request("https://canvas.example.test/api/v1/session", {
    method: "POST",
    headers: { "user-agent": userAgent, "sec-fetch-site": fetchSite },
  });
  if (botManagement !== undefined) {
    Object.defineProperty(request, "cf", { value: { botManagement } });
  }
  return request;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Turnstile verification", () => {
  it("does not require a token for a normal browser request", () => {
    expect(
      turnstileRequiredForRequest(
        riskRequest("Mozilla/5.0 Chrome/140.0 Safari/537.36", { score: 82 }),
        enabledEnv(),
      ),
    ).toBe(false);
  });

  it.each([
    ["a likely-automated Bot Management score", { score: 29 }, "Mozilla/5.0 Chrome/140.0"],
    [
      "a failed JavaScript detection",
      { score: 70, jsDetection: { passed: false } },
      "Mozilla/5.0 Chrome/140.0",
    ],
    ["an automation user agent", undefined, "Playwright HeadlessChrome"],
  ])("requires a token for %s", (_name, botManagement, userAgent) => {
    expect(turnstileRequiredForRequest(riskRequest(userAgent, botManagement), enabledEnv())).toBe(
      true,
    );
  });

  it("does not challenge Cloudflare-verified bots or static-resource requests", () => {
    expect(
      turnstileRequiredForRequest(
        riskRequest("Googlebot", { score: 1, verifiedBot: true }),
        enabledEnv(),
      ),
    ).toBe(false);
    expect(
      turnstileRequiredForRequest(
        riskRequest("Synthetic monitor", { score: 1, staticResource: true }),
        enabledEnv(),
      ),
    ).toBe(false);
  });

  it("does not classify traffic when Turnstile is disabled", () => {
    expect(
      turnstileRequiredForRequest(
        riskRequest("Playwright HeadlessChrome", { score: 1 }),
        enabledEnv({ TURNSTILE_ENABLED: "false" }),
      ),
    ).toBe(false);
  });

  it("accepts only the configured hostname and exact expected action", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      siteverifyResponse({
        success: true,
        hostname: "canvas.example.test",
        action: "invitation_claim",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateTurnstile("synthetic-client-token", enabledEnv(), "invitation_claim"),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (call === undefined) throw new Error("Siteverify was not called.");
    const [target, init] = call;
    expect(target).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get("secret")).toBe(TEST_SECRET);
    expect(form.get("response")).toBe("synthetic-client-token");
    expect(form.get("idempotency_key")).toMatch(/^[0-9a-f-]{36}$/iu);
  });

  it.each([
    {
      name: "wrong action",
      body: { success: true, hostname: "canvas.example.test", action: "board_create" },
    },
    {
      name: "wrong hostname",
      body: { success: true, hostname: "attacker.example", action: "recovery_claim" },
    },
    {
      name: "invalid secret response",
      body: {
        success: false,
        hostname: "canvas.example.test",
        action: "recovery_claim",
        "error-codes": ["invalid-input-secret"],
      },
    },
  ])("rejects a $name", async ({ body }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => siteverifyResponse(body)),
    );

    await expect(
      validateTurnstile("synthetic-client-token", enabledEnv(), "recovery_claim"),
    ).rejects.toMatchObject({ status: 403, code: "TURNSTILE_FAILED" });
  });

  it.each([
    ["upstream HTTP failure", async () => siteverifyResponse({}, 503)],
    ["upstream network failure", async () => Promise.reject(new Error("synthetic failure"))],
    ["malformed upstream response", async () => new Response("not-json", { status: 200 })],
  ])("fails closed when Siteverify has an %s", async (_name, fetchImplementation) => {
    vi.stubGlobal("fetch", vi.fn(fetchImplementation));

    await expect(
      validateTurnstile("synthetic-client-token", enabledEnv(), "board_create"),
    ).rejects.toMatchObject({ status: 503, code: "TEMPORARILY_UNAVAILABLE" });
  });

  it("fails closed without a configured secret and does not call Siteverify", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateTurnstile("synthetic-client-token", enabledEnv({ TURNSTILE_SECRET_KEY: undefined })),
    ).rejects.toMatchObject({ status: 503, code: "TEMPORARILY_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a challenge without calling Siteverify when a required token is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateTurnstile(undefined, enabledEnv())).rejects.toMatchObject({
      status: 428,
      code: "TURNSTILE_REQUIRED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not require or validate a token for a normal request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateTurnstile(
        undefined,
        enabledEnv({ TURNSTILE_SECRET_KEY: undefined }),
        "board_create",
        false,
      ),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bypasses token and network validation only when explicitly disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateTurnstile(undefined, enabledEnv({ TURNSTILE_ENABLED: "false" })),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
