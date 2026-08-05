/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { validateTurnstile } from "./turnstile";
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Turnstile verification", () => {
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

  it("bypasses token and network validation only when explicitly disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateTurnstile(undefined, enabledEnv({ TURNSTILE_ENABLED: "false" })),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
