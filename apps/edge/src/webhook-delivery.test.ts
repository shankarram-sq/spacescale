import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOrganisationWebhookOriginAllowed,
  deliverOrganisationWebhook,
} from "./webhook-delivery";

afterEach(() => {
  vi.unstubAllGlobals();
});

const delivery = {
  url: "https://hooks.partner.example/spacescale/board",
  body: '{"event":"board.exported"}',
  headers: {
    "content-type": "application/json; charset=utf-8",
    "x-spacescale-webhook-signature": "v1=signed",
  },
  timeoutMs: 5_000,
  allowedOrigins: "https://hooks.partner.example",
};

describe("Organisation webhook destination policy", () => {
  it("allows an exact configured HTTPS origin and any path beneath it", () => {
    expect(() =>
      assertOrganisationWebhookOriginAllowed(
        delivery.url,
        "https://one.example, https://hooks.partner.example",
      ),
    ).not.toThrow();
  });

  it("defaults to deny and rejects wildcard or malformed policy entries", () => {
    expect(() => assertOrganisationWebhookOriginAllowed(delivery.url, undefined)).toThrowError(
      expect.objectContaining({ status: 403, code: "WEBHOOK_ORIGIN_NOT_ALLOWED" }),
    );
    expect(() => assertOrganisationWebhookOriginAllowed(delivery.url, "*")).toThrowError(
      expect.objectContaining({ status: 503, code: "TEMPORARILY_UNAVAILABLE" }),
    );
    expect(() =>
      assertOrganisationWebhookOriginAllowed(delivery.url, "https://hooks.partner.example/path"),
    ).toThrowError(expect.objectContaining({ status: 503 }));
  });
});

describe("Organisation webhook delivery", () => {
  it("posts the signed body without following redirects", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverOrganisationWebhook(delivery)).resolves.toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(delivery.url);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: delivery.body,
      redirect: "manual",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(delivery.headers);
  });

  it("fails closed for unapproved origins, redirects, upstream errors, and network failures", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 302 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      deliverOrganisationWebhook({ ...delivery, allowedOrigins: "https://other.example" }),
    ).rejects.toMatchObject({ status: 403, code: "WEBHOOK_ORIGIN_NOT_ALLOWED" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(deliverOrganisationWebhook(delivery)).rejects.toMatchObject({
      status: 502,
      code: "WEBHOOK_DELIVERY_FAILED",
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(deliverOrganisationWebhook(delivery)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(deliverOrganisationWebhook(delivery)).rejects.toMatchObject({ status: 502 });
  });
});
