/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type Session = { cookie: string; csrfToken: string };

async function session(): Promise<Session> {
  const response = await SELF.fetch("http://localhost/api/v1/session", {
    method: "POST",
    headers: { Origin: "http://localhost" },
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const body = (await response.json()) as { csrfToken?: unknown };
  if (!cookie || typeof body.csrfToken !== "string") throw new Error("Session setup failed.");
  return { cookie, csrfToken: body.csrfToken };
}

function staticGif(): Uint8Array {
  return Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs="), (value) =>
    value.charCodeAt(0),
  );
}

describe("gateway image asset authentication", () => {
  it("requires a session, same origin, and CSRF for upload, then re-authenticates reads", async () => {
    const identity = await session();
    const created = await SELF.fetch("http://localhost/api/v1/boards", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        Cookie: identity.cookie,
        "X-CSRF-Token": identity.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Gateway asset auth" }),
    });
    const boardId = ((await created.json()) as { board: { id: string } }).board.id;
    const policy = await SELF.fetch(`http://localhost/api/v1/boards/${boardId}/settings`, {
      method: "PATCH",
      headers: {
        Origin: "http://localhost",
        Cookie: identity.cookie,
        "X-CSRF-Token": identity.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedAclVersion: 1, imagesEnabled: true }),
    });
    expect(policy.status).toBe(200);

    const url = `http://localhost/api/v1/boards/${boardId}/assets`;
    const uploadInit = {
      method: "POST",
      headers: { "Content-Type": "image/gif" },
      body: staticGif(),
    } satisfies RequestInit;
    expect((await SELF.fetch(url, uploadInit)).status).toBe(401);
    expect(
      (
        await SELF.fetch(url, {
          ...uploadInit,
          headers: { ...uploadInit.headers, Cookie: identity.cookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await SELF.fetch(url, {
          ...uploadInit,
          headers: {
            ...uploadInit.headers,
            Origin: "http://localhost",
            Cookie: identity.cookie,
          },
        })
      ).status,
    ).toBe(403);

    const uploaded = await SELF.fetch(url, {
      ...uploadInit,
      headers: {
        ...uploadInit.headers,
        Origin: "http://localhost",
        Cookie: identity.cookie,
        "X-CSRF-Token": identity.csrfToken,
      },
    });
    expect(uploaded.status).toBe(201);
    const assetId = ((await uploaded.json()) as { assetId: string }).assetId;
    const assetUrl = `${url}/${assetId}`;
    expect((await SELF.fetch(assetUrl)).status).toBe(401);
    const fetched = await SELF.fetch(assetUrl, { headers: { Cookie: identity.cookie } });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("cache-control")).toBe("private, no-store");
    expect(fetched.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
