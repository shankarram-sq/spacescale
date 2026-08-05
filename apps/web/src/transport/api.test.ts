import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api";

type CapturedRequest = { path: string; init: RequestInit };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("owner recovery APIs", () => {
  it("sends CSRF and idempotency headers for invitations, snapshots, and restore", async () => {
    const requests: CapturedRequest[] = [];
    const responses: unknown[] = [
      { csrfToken: "csrf-token" },
      {
        invitation: {
          id: "i_1234567890123456789012",
          role: "editor",
          label: "Workshop",
          maxUses: 1,
          expiresAt: 2_000_000_000_000,
        },
        token: "one-time-token",
        url: "https://example.test/b/board#invite=one-time-token",
        idempotentReplay: false,
      },
      { invitationId: "i_1234567890123456789012", revoked: true },
      {
        snapshot: {
          seq: 7,
          sha256: "digest",
          itemCount: 2,
          byteCount: 512,
          kind: "named",
          label: "Before workshop",
          createdAt: 1_900_000_000_000,
        },
      },
      { restoredFromSeq: 7, seq: 9, requiresResync: false },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({ path: String(input), init });
      return Response.json(responses.shift());
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new ApiClient();
    await api.ensureSession();
    const invitation = await api.createInvitation("b_1234567890123456789012", {
      role: "editor",
      label: "Workshop",
      maxUses: 1,
      expiresAt: 2_000_000_000_000,
    });
    await api.revokeInvitation("b_1234567890123456789012", invitation.invitation.id);
    const snapshot = await api.createNamedSnapshot("b_1234567890123456789012", "Before workshop");
    const restored = await api.restoreSnapshot("b_1234567890123456789012", snapshot.seq, 8);

    expect(invitation.invitation.id).toBe("i_1234567890123456789012");
    expect(snapshot).toMatchObject({ seq: 7, kind: "named", label: "Before workshop" });
    expect(restored).toEqual({ restoredFromSeq: 7, seq: 9, requiresResync: false });

    for (const request of requests.slice(1)) {
      expect(new Headers(request.init.headers).get("x-csrf-token")).toBe("csrf-token");
    }
    expect(new Headers(requests[1]?.init.headers).get("idempotency-key")).toBeTruthy();
    expect(new Headers(requests[3]?.init.headers).get("idempotency-key")).toBeTruthy();
    expect(new Headers(requests[4]?.init.headers).get("idempotency-key")).toBeTruthy();
    expect(requests.map((request) => request.path)).toEqual([
      "/api/v1/session",
      "/api/v1/boards/b_1234567890123456789012/invitations",
      "/api/v1/boards/b_1234567890123456789012/invitations/i_1234567890123456789012",
      "/api/v1/boards/b_1234567890123456789012/snapshots",
      "/api/v1/boards/b_1234567890123456789012/restore/7",
    ]);
  });

  it("keeps only fully validated snapshot metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          snapshots: [
            {
              seq: 11,
              sha256: "digest",
              itemCount: 4,
              byteCount: 1_024,
              kind: "automatic",
              label: null,
              createdBy: null,
              createdAt: 1_900_000_000_000,
            },
            {
              seq: "12",
              sha256: "bad",
              itemCount: 0,
              byteCount: 1,
              kind: "automatic",
              label: null,
              createdBy: null,
              createdAt: 1_900_000_000_000,
            },
          ],
        }),
      ),
    );

    const snapshots = await new ApiClient().snapshots("b_1234567890123456789012");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ seq: 11, kind: "automatic", itemCount: 4 });
  });
});

describe("board archive API", () => {
  it("posts the expected ACL version with same-origin credentials and CSRF", async () => {
    const requests: CapturedRequest[] = [];
    const responses: unknown[] = [
      { csrfToken: "csrf-token" },
      { archived: true, archivedAt: 1_900_000_000_000, aclVersion: 8 },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        return Response.json(responses.shift());
      }),
    );

    const api = new ApiClient();
    await api.ensureSession();
    const result = await api.archiveBoard("b_1234567890123456789012", 7);

    expect(result).toEqual({ archived: true, archivedAt: 1_900_000_000_000, aclVersion: 8 });
    const request = requests[1];
    expect(request?.path).toBe("/api/v1/boards/b_1234567890123456789012/archive");
    expect(request?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ expectedAclVersion: 7 }),
    });
    const headers = new Headers(request?.init.headers);
    expect(headers.get("x-csrf-token")).toBe("csrf-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
  });
});
