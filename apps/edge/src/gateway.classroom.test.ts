/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it, vi } from "vitest";
import { MAX_CLASSROOM_IMPORT_ENCODED_CHARS } from "./classroom-import";
import gateway from "./gateway";
import { configuredFrameAncestors } from "./http/security";
import { HmacIdentityService } from "./identity";
import {
  type OrganisationSigningKeyRegistry,
  signOrganisationLaunchToken,
} from "./organisation-auth";
import type { Env } from "./types";

const ORGANISATION_KEY = "school-42";
const DERIVATION_KEY = `organisation-derivation-key-${"d".repeat(32)}`;
const SIGNING_KEY = `organisation-signing-key-${"s".repeat(32)}`;
const SESSION_KEY = "classroom-session-key-with-enough-entropy";

const SIGNING_KEYS: OrganisationSigningKeyRegistry = {
  [ORGANISATION_KEY]: {
    derivation_key: DERIVATION_KEY,
    current: { kid: "2026-08", key: SIGNING_KEY },
    previous: [],
  },
};

type CapturedRequest = {
  boardId: string;
  url: string;
  headers: Headers;
  body: unknown;
};

function makeEnv(options: { allowedOrigins?: string } = {}): {
  env: Env;
  captured: CapturedRequest[];
  getByName: ReturnType<typeof vi.fn>;
} {
  const captured: CapturedRequest[] = [];
  const getByName = vi.fn((boardId: string) => ({
    fetch: async (request: Request): Promise<Response> => {
      const body = request.body === null ? null : await request.clone().json();
      captured.push({
        boardId,
        url: request.url,
        headers: new Headers(request.headers),
        body,
      });
      const pathname = new URL(request.url).pathname;
      if (pathname === "/__internal/organisation-launch") {
        const launch = body as {
          publicId: string;
          title: string;
          role: "owner" | "editor" | "viewer";
          displayName: string;
        };
        return Response.json(
          {
            board: {
              id: launch.publicId,
              title: launch.title,
              accessMode: "private",
              drawingPolicy: "editors_enabled",
              imagesEnabled: false,
              aclVersion: 1,
            },
            actor: {
              id: request.headers.get("x-whiteboard-internal-actor"),
              role: launch.role,
              displayName: launch.displayName,
            },
            created: true,
            launchApplied: true,
          },
          { status: 201 },
        );
      }
      if (pathname.endsWith("/socket")) {
        const pair = new WebSocketPair();
        pair[1].accept();
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return Response.json({ forwarded: true });
    },
  }));
  const env = {
    APP_HOSTNAME: "localhost",
    ORGANISATION_SIGNING_KEYS: JSON.stringify(SIGNING_KEYS),
    ALLOWED_ORIGINS: options.allowedOrigins,
    SESSION_SIGNING_KEY_CURRENT: SESSION_KEY,
    SESSION_SIGNING_KEY_PREVIOUS: "",
    BOARD_CREATION_ENABLED: "true",
    TURNSTILE_ENABLED: "false",
    ENVIRONMENT: "development",
    WORKER_VERSION: { id: "organisation-test-version" },
    BOARD_ROOMS: { getByName },
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><title>Canvas</title>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    },
  } as unknown as Env;
  return { env, captured, getByName };
}

async function launchToken(
  suffix: string,
  overrides: Partial<{
    organisation_id: string;
    space_id: string;
    role: "owner" | "editor" | "viewer";
    display_name: string;
    participant_id: string;
  }> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return signOrganisationLaunchToken(
    {
      v: 1,
      aud: "localhost",
      organisation_id: ORGANISATION_KEY,
      space_id: `Classroom Space ${suffix}`,
      kid: "2026-08",
      role: "editor",
      display_name: `Student ${suffix}`,
      participant_id: `student-${suffix}`,
      iat: now - 5,
      exp: now + 3_600,
      ...overrides,
    },
    SIGNING_KEY,
  );
}

async function exchange(
  env: Env,
  token: string,
  origin = "http://localhost",
  importSnapshot?: string,
): Promise<Response> {
  return gateway.fetch(
    new Request("http://localhost/api/v1/embed/session", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...(importSnapshot === undefined ? {} : { importSnapshot }) }),
    }),
    env,
  );
}

describe("organisation embed gateway", () => {
  it("exchanges a signed launch for a scoped session after authoritative membership", async () => {
    const { env, captured, getByName } = makeEnv();
    const response = await exchange(
      env,
      await launchToken("exchange", {
        space_id: "  Algebra Space  ",
        role: "owner",
        display_name: "  Coach Mira  ",
        participant_id: "coach-mira",
      }),
      "http://localhost",
      "eyJmb3JtYXQiOiJjZi13aGl0ZWJvYXJkLWpzb24ifQ",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = (await response.json()) as {
      sessionToken: string;
      sessionExpiresAt: number;
      board: { id: string; title: string; url: string };
      actor: { id: string; role: string; displayName: string };
    };
    expect(result.board).toMatchObject({
      title: "Algebra Space",
      url: `http://localhost/embed/b/${result.board.id}`,
    });
    expect(result.actor).toMatchObject({ role: "owner", displayName: "Coach Mira" });
    expect(getByName).toHaveBeenCalledWith(result.board.id);

    expect(captured).toHaveLength(1);
    const forwarded = captured[0];
    expect(forwarded?.url).toBe("http://localhost/__internal/organisation-launch");
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("x-whiteboard-internal-actor")).toBe(result.actor.id);
    expect(forwarded?.headers.get("x-whiteboard-internal-session-expiry")).toBe(
      String(result.sessionExpiresAt),
    );
    expect(forwarded?.body).toEqual({
      publicId: result.board.id,
      organisationId: expect.stringMatching(/^o_[A-Za-z0-9_-]{22}$/u),
      title: "Algebra Space",
      role: "owner",
      displayName: "Coach Mira",
      launchIssuedAtMs: expect.any(Number),
      placeholderOwnerActorId: expect.stringMatching(/^a_[A-Za-z0-9_-]{22}$/u),
      ownerRecoveryHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      importSnapshot: "eyJmb3JtYXQiOiJjZi13aGl0ZWJvYXJkLWpzb24ifQ",
    });

    const verified = await new HmacIdentityService(env).verifySession(
      new Request("http://localhost", {
        headers: { Authorization: `Bearer ${result.sessionToken}` },
      }),
    );
    expect(verified).toMatchObject({ actorId: result.actor.id, boardId: result.board.id });
  });

  it("requires exact same-origin launch POSTs and fails closed on invalid tokens", async () => {
    const { env, getByName } = makeEnv();
    const token = await launchToken("origin");
    const crossSite = await exchange(env, token, "https://attacker.example");
    expect(crossSite.status).toBe(403);
    expect(getByName).not.toHaveBeenCalled();

    const absentOrigin = await gateway.fetch(
      new Request("http://localhost/api/v1/embed/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      env,
    );
    expect(absentOrigin.status).toBe(403);

    const invalid = await exchange(env, `${token.slice(0, -1)}x`);
    expect(invalid.status).toBe(401);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("bounds import transport before the signed launch reaches a room", async () => {
    const { env, getByName } = makeEnv();
    const token = await launchToken("import-bounds");
    const invalidType = await gateway.fetch(
      new Request("http://localhost/api/v1/embed/session", {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({ token, importSnapshot: 42 }),
      }),
      env,
    );
    expect(invalidType.status).toBe(400);

    const tooLarge = await exchange(
      env,
      token,
      "http://localhost",
      "A".repeat(MAX_CLASSROOM_IMPORT_ENCODED_CHARS + 1),
    );
    expect(tooLarge.status).toBe(413);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("accepts bearer mutations without CSRF but enforces the exact board scope", async () => {
    const { env, captured } = makeEnv();
    const launch = await exchange(env, await launchToken("scope"));
    const result = (await launch.json()) as { sessionToken: string; board: { id: string } };
    captured.length = 0;

    const allowed = await gateway.fetch(
      new Request(`http://localhost/api/v1/boards/${result.board.id}/settings`, {
        method: "PATCH",
        headers: {
          Origin: "http://localhost",
          Authorization: `Bearer ${result.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedAclVersion: 1, drawingPolicy: "owner_only" }),
      }),
      env,
    );
    expect(allowed.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.get("authorization")).toBeNull();

    const otherBoard = "b_ZZZZZZZZZZZZZZZZZZZZZZ";
    const denied = await gateway.fetch(
      new Request(`http://localhost/api/v1/boards/${otherBoard}/bootstrap`, {
        headers: { Authorization: `Bearer ${result.sessionToken}` },
      }),
      env,
    );
    expect(denied.status).toBe(403);
    expect(captured).toHaveLength(1);

    const legacyCreate = await gateway.fetch(
      new Request("http://localhost/api/v1/boards", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          Authorization: `Bearer ${result.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Out of scope" }),
      }),
      env,
    );
    expect(legacyCreate.status).toBe(403);
  });

  it("extracts WebSocket bearer auth, strips it before forwarding, and negotiates only v1", async () => {
    const { env, captured } = makeEnv();
    const launch = await exchange(env, await launchToken("socket"));
    const result = (await launch.json()) as { sessionToken: string; board: { id: string } };
    captured.length = 0;

    const response = await gateway.fetch(
      new Request(
        "http://localhost/api/v1/boards/" +
          result.board.id +
          "/socket?since=0&client=018f0000-0000-7000-8000-000000000001",
        {
          headers: {
            Origin: "http://localhost",
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Protocol": `whiteboard.v1, auth.${result.sessionToken}`,
          },
        },
      ),
      env,
    );
    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe("whiteboard.v1");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.get("sec-websocket-protocol")).toBe("whiteboard.v1");
    expect(captured[0]?.headers.get("authorization")).toBeNull();

    const ambiguous = await gateway.fetch(
      new Request(
        "http://localhost/api/v1/boards/" +
          result.board.id +
          "/socket?since=0&client=018f0000-0000-7000-8000-000000000002",
        {
          headers: {
            Origin: "http://localhost",
            Upgrade: "websocket",
            Authorization: `Bearer ${result.sessionToken}`,
            "Sec-WebSocket-Protocol": `whiteboard.v1, auth.${result.sessionToken}`,
          },
        },
      ),
      env,
    );
    expect(ambiguous.status).toBe(400);
  });
});

describe("embed response framing policy", () => {
  it("allows only configured exact origins on embed paths and keeps normal pages denied", async () => {
    const { env } = makeEnv({
      allowedOrigins: "https://classroom.example, https://lms.example",
    });
    const embed = await gateway.fetch(new Request("http://localhost/embed"), env);
    expect(embed.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://classroom.example https://lms.example",
    );
    expect(embed.headers.get("x-frame-options")).toBeNull();

    const nestedEmbed = await gateway.fetch(
      new Request("http://localhost/embed/b/b_AAAAAAAAAAAAAAAAAAAAAA"),
      env,
    );
    expect(nestedEmbed.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://classroom.example https://lms.example",
    );
    expect(nestedEmbed.headers.get("x-frame-options")).toBeNull();

    const normal = await gateway.fetch(new Request("http://localhost/"), env);
    expect(normal.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(normal.headers.get("x-frame-options")).toBe("DENY");
  });

  it("allows explicit all-origins opt-in and fails closed for invalid origin lists", async () => {
    expect(configuredFrameAncestors(undefined)).toBe("'none'");
    expect(configuredFrameAncestors("   ")).toBe("'none'");
    expect(configuredFrameAncestors("x".repeat(2_049))).toBe("'none'");
    expect(configuredFrameAncestors("*")).toBe("*");
    expect(configuredFrameAncestors("https://*.example.com")).toBe("'none'");
    expect(configuredFrameAncestors("http://classroom.example")).toBe("'none'");
    expect(configuredFrameAncestors("https://classroom.example/path")).toBe("'none'");
    expect(configuredFrameAncestors("https://classroom.example/")).toBe("'none'");
    expect(configuredFrameAncestors("not-an-origin")).toBe("'none'");
    expect(configuredFrameAncestors("https://one.example https://two.example")).toBe("'none'");
    expect(configuredFrameAncestors("https://one.example,")).toBe("'none'");
    expect(configuredFrameAncestors("*,https://classroom.example")).toBe("'none'");
    expect(configuredFrameAncestors("http://localhost:4173")).toBe("http://localhost:4173");

    const { env } = makeEnv({ allowedOrigins: "https://ok.example,/not-an-origin" });
    const response = await gateway.fetch(new Request("http://localhost/embed"), env);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBeNull();

    const { env: allowAll } = makeEnv({ allowedOrigins: "*" });
    const allowAllResponse = await gateway.fetch(new Request("http://localhost/embed"), allowAll);
    expect(allowAllResponse.headers.get("content-security-policy")).toContain("frame-ancestors *");
    expect(allowAllResponse.headers.get("x-frame-options")).toBeNull();
  });
});
