import { afterEach, describe, expect, it, vi } from "vitest";
import { safeLog } from "./logging";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeLog", () => {
  it("emits an indexable object containing only approved scalar fields", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    safeLog("info", "command.accepted", {
      requestId: "request-1",
      environment: "staging",
      workerVersionId: "worker-version-1",
      boardIdHash: "bh_privacy-safe",
      actionKind: "item.create",
      seq: 7,
      result: "committed",
      operation: { text: "private board content" },
      token: "secret-capability",
      boardId: "b_AAAAAAAAAAAAAAAAAAAAAA",
    });

    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]?.[0]).toMatchObject({
      event: "command.accepted",
      level: "info",
      requestId: "request-1",
      environment: "staging",
      workerVersionId: "worker-version-1",
      boardIdHash: "bh_privacy-safe",
      actionKind: "item.create",
      seq: 7,
      result: "committed",
    });
    expect(output.mock.calls[0]?.[0]).not.toHaveProperty("operation");
    expect(output.mock.calls[0]?.[0]).not.toHaveProperty("token");
    expect(output.mock.calls[0]?.[0]).not.toHaveProperty("boardId");
  });
});
