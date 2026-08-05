/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

type TestSession = {
  actorId: string;
  cookie: string;
  csrfToken: string;
};

afterEach(async () => reset());

async function createSession(): Promise<TestSession> {
  const response = await SELF.fetch("http://localhost/api/v1/session", {
    method: "POST",
    headers: { Origin: "http://localhost" },
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("Session response did not set a cookie.");
  const body = (await response.json()) as {
    actor?: { id?: unknown };
    csrfToken?: unknown;
  };
  if (typeof body.actor?.id !== "string" || typeof body.csrfToken !== "string") {
    throw new Error("Session response omitted identity data.");
  }
  return {
    actorId: body.actor.id,
    cookie: setCookie.split(";", 1)[0] ?? "",
    csrfToken: body.csrfToken,
  };
}

async function createBoard(
  session: TestSession,
  accessMode: "private" | "link_view" = "link_view",
): Promise<string> {
  const response = await SELF.fetch("http://localhost/api/v1/boards", {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.144",
    },
    body: JSON.stringify({ title: "Security integration", accessMode }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { board?: { id?: unknown } };
  if (typeof body.board?.id !== "string") throw new Error("Board response omitted its ID.");
  return body.board.id;
}

async function unavailableSignature(response: Response): Promise<{
  status: number;
  code: unknown;
  message: unknown;
}> {
  const body = (await response.json()) as {
    error?: { code?: unknown; message?: unknown };
  };
  return {
    status: response.status,
    code: body.error?.code,
    message: body.error?.message,
  };
}

function claim(
  boardId: string,
  session: TestSession,
  body: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch(`http://localhost/api/v1/boards/${boardId}/claims`, {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.145",
    },
    body: JSON.stringify(body),
  });
}

describe("gateway request-boundary security", () => {
  it("rejects absent and cross-site origins even when browser hint headers claim same-origin", async () => {
    const absent = await SELF.fetch("http://localhost/api/v1/session", { method: "POST" });
    expect(absent.status).toBe(403);
    await expect(absent.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });

    const crossSite = await SELF.fetch("http://localhost/api/v1/session", {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("does not let origin or internal-context headers substitute for a valid CSRF token", async () => {
    const session = await createSession();
    const response = await SELF.fetch("http://localhost/api/v1/boards", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        Cookie: session.cookie,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-Whiteboard-Internal-Actor": "a_ZZZZZZZZZZZZZZZZZZZZZZ",
        "X-Whiteboard-Internal-Session-Expiry": String(Date.now() + 86_400_000),
      },
      body: JSON.stringify({ title: "Must not be created" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("requires same-origin and CSRF checks before forwarding an owner archive", async () => {
    const owner = await createSession();
    const boardId = await createBoard(owner, "private");
    const archive = (origin: string, csrfToken?: string) =>
      SELF.fetch(`http://localhost/api/v1/boards/${boardId}/archive`, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: owner.cookie,
          ...(csrfToken === undefined ? {} : { "X-CSRF-Token": csrfToken }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedAclVersion: 1 }),
      });

    const crossSite = await archive("https://attacker.example", owner.csrfToken);
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });

    const missingCsrf = await archive("http://localhost");
    expect(missingCsrf.status).toBe(403);
    await expect(missingCsrf.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });

    const response = await archive("http://localhost", owner.csrfToken);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ archived: true, aclVersion: 2 });
  });

  it("overwrites externally supplied internal actor, expiry, and request identifiers", async () => {
    const session = await createSession();
    const boardId = await createBoard(session);
    const forgedActorId = "a_ZZZZZZZZZZZZZZZZZZZZZZ";
    expect(forgedActorId).not.toBe(session.actorId);

    const response = await SELF.fetch(`http://localhost/api/v1/boards/${boardId}/bootstrap`, {
      headers: {
        Cookie: session.cookie,
        "X-Whiteboard-Internal-Actor": forgedActorId,
        "X-Whiteboard-Internal-Session-Expiry": String(Date.now() + 86_400_000),
        "X-Whiteboard-Internal-Request-Id": "attacker-controlled-request-id",
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { actor?: { id?: unknown } };
    expect(body.actor?.id).toBe(session.actorId);
    expect(body.actor?.id).not.toBe(forgedActorId);
    expect(response.headers.get("x-request-id")).not.toBe("attacker-controlled-request-id");
  });

  it("does not reveal a private board to a signed anonymous non-member", async () => {
    const owner = await createSession();
    const outsider = await createSession();
    const boardId = await createBoard(owner, "private");
    const unknownBoardId = "b_ZZZZZZZZZZZZZZZZZZZZZZ";
    expect(boardId).not.toBe(unknownBoardId);

    const [privateBoard, unknownBoard] = await Promise.all([
      SELF.fetch(`http://localhost/api/v1/boards/${boardId}/bootstrap`, {
        headers: { Cookie: outsider.cookie },
      }),
      SELF.fetch(`http://localhost/api/v1/boards/${unknownBoardId}/bootstrap`, {
        headers: { Cookie: outsider.cookie },
      }),
    ]);

    const privateSignature = await unavailableSignature(privateBoard);
    const unknownSignature = await unavailableSignature(unknownBoard);
    expect(privateSignature).toEqual(unknownSignature);
    expect(privateSignature).toEqual({
      status: 404,
      code: "NOT_FOUND",
      message: "Board not found.",
    });
  });

  it.each(["invite", "recovery"] as const)(
    "does not reveal a private board through a well-formed invalid %s capability",
    async (type) => {
      const owner = await createSession();
      const outsider = await createSession();
      const boardId = await createBoard(owner, "private");
      const unknownBoardId = "b_YYYYYYYYYYYYYYYYYYYYYY";
      expect(boardId).not.toBe(unknownBoardId);
      const invalidToken = "A".repeat(43);
      const unavailable = {
        status: 404,
        code: "NOT_FOUND",
        message: "Board not found.",
      };
      const body =
        type === "invite"
          ? { type, token: invalidToken }
          : { type, token: invalidToken, confirmOwnershipTransfer: true };
      const existingSignature = await unavailableSignature(await claim(boardId, outsider, body));
      const unknownSignature = await unavailableSignature(
        await claim(unknownBoardId, outsider, body),
      );
      expect(existingSignature).toEqual(unknownSignature);
      expect(existingSignature).toEqual(unavailable);
    },
  );
});
