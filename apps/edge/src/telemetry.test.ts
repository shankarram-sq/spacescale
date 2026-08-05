import { describe, expect, it } from "vitest";
import { boardIdHash, durableObjectTelemetryContext, runtimeTelemetryContext } from "./telemetry";
import type { Env } from "./types";

const boardId = "b_AAAAAAAAAAAAAAAAAAAAAA";

describe("runtime telemetry context", () => {
  it("uses a stable one-way board fingerprint and never the routable ID", async () => {
    const first = await boardIdHash(boardId);
    const second = await boardIdHash(boardId);
    const other = await boardIdHash("b_BBBBBBBBBBBBBBBBBBBBBB");

    expect(first).toBe(second);
    expect(first).toMatch(/^bh_[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain(boardId);
    expect(other).not.toBe(first);
  });

  it("always supplies the configured environment and Worker version", async () => {
    const context = await runtimeTelemetryContext(
      {
        ENVIRONMENT: "staging",
        WORKER_VERSION: { id: "worker-version-1" } as Env["WORKER_VERSION"],
      },
      boardId,
    );

    expect(context).toMatchObject({
      environment: "staging",
      workerVersionId: "worker-version-1",
    });
    expect(context.boardIdHash).toMatch(/^bh_/u);
  });

  it("keeps required fields present when local bindings are malformed", async () => {
    await expect(
      runtimeTelemetryContext({} as Pick<Env, "ENVIRONMENT" | "WORKER_VERSION">),
    ).resolves.toEqual({ environment: "unknown", workerVersionId: "unknown" });
  });

  it("maps the version metadata binding to the Durable Object contract field", async () => {
    await expect(
      durableObjectTelemetryContext({
        ENVIRONMENT: "production",
        WORKER_VERSION: { id: "worker-version-2" } as Env["WORKER_VERSION"],
      }),
    ).resolves.toMatchObject({
      environment: "production",
      workerVersionId: "worker-version-2",
      durableObjectVersion: "worker-version-2",
    });
  });
});
