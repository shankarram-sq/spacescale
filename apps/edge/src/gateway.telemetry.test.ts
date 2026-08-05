/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import gateway from "./gateway";
import { boardIdHash } from "./telemetry";
import type { Env } from "./types";

const metadata = {
  ENVIRONMENT: "staging",
  WORKER_VERSION: {
    id: "worker-version-1",
    tag: "test",
    timestamp: "2026-08-05T00:00:00.000Z",
  },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("gateway telemetry", () => {
  it("emits exactly one normalized completion for a mapped application error", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await gateway.fetch(
      new Request("http://localhost/api/v1/boards", {
        method: "POST",
        headers: { Origin: "http://localhost" },
      }),
      { ...metadata, BOARD_CREATION_ENABLED: "false" } as Env,
    );

    expect(response.status).toBe(503);
    expect(completions(output)).toEqual([
      expect.objectContaining({
        event: "http.request_completed",
        environment: "staging",
        workerVersionId: "worker-version-1",
        executionComponent: "gateway",
        status: 503,
        internalError: false,
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it("classifies an unexpected handler exception as an internal error", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await gateway.fetch(new Request("http://localhost/"), metadata as Env);

    expect(response.status).toBe(500);
    expect(completions(output)).toEqual([
      expect.objectContaining({ status: 500, internalError: true }),
    ]);
  });

  it("correlates board requests only by their one-way board hash", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boardId = "b_AAAAAAAAAAAAAAAAAAAAAA";

    const response = await gateway.fetch(
      new Request(`http://localhost/api/v1/boards/${boardId}/bootstrap`),
      { ...metadata, SESSION_SIGNING_KEY_CURRENT: "test-signing-key" } as Env,
    );

    expect(response.status).toBe(401);
    const [completion] = completions(output);
    expect(completion).toMatchObject({ boardIdHash: await boardIdHash(boardId) });
    expect(completion).not.toHaveProperty("boardId");
    expect(JSON.stringify(completion)).not.toContain(boardId);
  });

  it("emits a contract-ready board.created event after authoritative initialization", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const session = await SELF.fetch("http://localhost/api/v1/session", {
      method: "POST",
      headers: { Origin: "http://localhost" },
    });
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    const sessionBody = (await session.json()) as { csrfToken?: unknown };
    if (cookie === undefined || typeof sessionBody.csrfToken !== "string") {
      throw new Error("Session fixture did not return authentication material.");
    }
    output.mockClear();

    const response = await SELF.fetch("http://localhost/api/v1/boards", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        Cookie: cookie,
        "X-CSRF-Token": sessionBody.csrfToken,
        "Content-Type": "application/json",
        "CF-Connecting-IP": "192.0.2.221",
      },
      body: JSON.stringify({ title: "Telemetry contract" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { board?: { id?: unknown } };
    if (typeof body.board?.id !== "string") throw new Error("Board fixture omitted its ID.");

    const created = output.mock.calls
      .map((call) => call[0])
      .find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" &&
          value !== null &&
          (value as Record<string, unknown>).event === "board.created",
      );
    expect(created).toMatchObject({
      event: "board.created",
      environment: "development",
      workerVersionId: expect.any(String),
      boardIdHash: await boardIdHash(body.board.id),
      result: "created",
    });
    expect(created).not.toHaveProperty("boardId");
    expect(JSON.stringify(created)).not.toContain(body.board.id);
    expect(completions(output)).toHaveLength(1);
  });
});

function completions(output: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return output.mock.calls
    .map((call) => call[0])
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).event === "http.request_completed",
    );
}
