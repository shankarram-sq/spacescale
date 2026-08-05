/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { readJsonBody } from "./body";
import { HttpError } from "./errors";

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status, code });
}

describe("bounded safe HTTP JSON parsing", () => {
  it("rejects an oversized declared Content-Length before consuming the body", async () => {
    const request = new Request("https://example.test/input", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "129" },
      body: "{}",
    });

    await expectHttpError(readJsonBody(request, 128), 413, "PAYLOAD_TOO_LARGE");
  });

  it("enforces the streaming byte limit when Content-Length is absent", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"value":"'));
        controller.enqueue(encoder.encode("x".repeat(256)));
        controller.enqueue(encoder.encode('"}'));
        controller.close();
      },
    });
    const request = new Request("https://example.test/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
    });

    await expectHttpError(readJsonBody(request, 64), 413, "PAYLOAD_TOO_LARGE");
  });

  it("rejects JSON nesting beyond the configured safety limit", async () => {
    let value: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 10; depth += 1) value = { child: value };
    const request = new Request("https://example.test/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });

    await expectHttpError(readJsonBody(request, 4_096), 400, "BAD_REQUEST");
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects the prototype-pollution key %s at any depth",
    async (unsafeKey) => {
      const before = Object.hasOwn(Object.prototype, "polluted");
      const request = new Request("https://example.test/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `{"safe":{"${unsafeKey}":{"polluted":true}}}`,
      });

      await expectHttpError(readJsonBody(request, 1_024), 400, "BAD_REQUEST");
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(before);
    },
  );

  it("reports parser failures as bounded public errors", async () => {
    const request = new Request("https://example.test/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const result = readJsonBody(request, 64);
    await expect(result).rejects.toBeInstanceOf(HttpError);
    await expectHttpError(result, 400, "BAD_REQUEST");
  });
});
