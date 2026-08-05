import { describe, expect, it } from "vitest";
import { HmacIdentityService } from "./identity";

const ACTOR_ID = "a_AAAAAAAAAAAAAAAAAAAAAA";
const BOARD_ID = "b_BBBBBBBBBBBBBBBBBBBBBB";
const NOW = 1_800_000_000_000;

describe("HmacIdentityService classroom bearer sessions", () => {
  it("issues and verifies a board-scoped non-ambient session", async () => {
    const identity = new HmacIdentityService({
      SESSION_SIGNING_KEY_CURRENT: "current-session-key-with-enough-entropy",
    });
    const issued = await identity.issueEmbedSession(ACTOR_ID, BOARD_ID, NOW + 60 * 60_000, NOW);
    expect(issued.token).toMatch(/^es1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

    const request = new Request(`https://board.test/api/v1/boards/${BOARD_ID}/bootstrap`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    const session = await identity.verifySession(request, NOW + 1_000);
    expect(session).toEqual({
      actorId: ACTOR_ID,
      boardId: BOARD_ID,
      issuedAt: NOW,
      expiresAt: NOW + 60 * 60_000,
      keyVersion: "current",
    });
    await expect(identity.verifyCsrf(request, session)).resolves.toBeUndefined();

    const ensured = await identity.ensureSession(request, NOW + 1_000);
    expect(ensured.session).toEqual(session);
    expect(ensured.setCookie).toBeUndefined();
    expect(ensured.csrfToken).toMatch(/^v1\.[A-Za-z0-9_-]+$/u);
  });

  it("accepts a session signed by the previous key during rotation", async () => {
    const old = new HmacIdentityService({ SESSION_SIGNING_KEY_CURRENT: "old-session-key" });
    const issued = await old.issueEmbedSession(ACTOR_ID, BOARD_ID, NOW + 60_000, NOW);
    const rotating = new HmacIdentityService({
      SESSION_SIGNING_KEY_CURRENT: "new-session-key",
      SESSION_SIGNING_KEY_PREVIOUS: "old-session-key",
    });
    const session = await rotating.verifySession(
      new Request("https://board.test", {
        headers: { Authorization: `Bearer ${issued.token}` },
      }),
      NOW + 1,
    );
    expect(session).toMatchObject({ boardId: BOARD_ID, keyVersion: "previous" });
  });

  it("rejects bearer tampering and expiry without falling back to a device cookie", async () => {
    const identity = new HmacIdentityService({
      SESSION_SIGNING_KEY_CURRENT: "current-session-key-with-enough-entropy",
    });
    const issued = await identity.issueEmbedSession(ACTOR_ID, BOARD_ID, NOW + 60_000, NOW);
    const tampered = issued.token.slice(0, -1) + (issued.token.endsWith("A") ? "B" : "A");
    const invalid = new Request("https://board.test/api/v1/session", {
      headers: {
        Authorization: `Bearer ${tampered}`,
        Cookie: "__Host-wb_session=not-a-valid-fallback",
      },
    });
    await expect(identity.verifySession(invalid, NOW + 1)).rejects.toMatchObject({ status: 401 });
    await expect(identity.ensureSession(invalid, NOW + 1)).rejects.toMatchObject({ status: 401 });

    const expired = new Request("https://board.test", {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    await expect(identity.verifySession(expired, NOW + 60_001)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("refuses malformed identities and sessions longer than the launch ceiling", async () => {
    const identity = new HmacIdentityService({
      SESSION_SIGNING_KEY_CURRENT: "current-session-key-with-enough-entropy",
    });
    await expect(
      identity.issueEmbedSession("a_bad", BOARD_ID, NOW + 60_000, NOW),
    ).rejects.toMatchObject({ status: 500 });
    await expect(
      identity.issueEmbedSession(ACTOR_ID, BOARD_ID, NOW + 25 * 60 * 60_000, NOW),
    ).rejects.toMatchObject({ status: 401 });
  });
});
