import { describe, expect, it } from "vitest";
import { CSRF_HEADER, HmacIdentityService, SESSION_COOKIE } from "./identity";

describe("HmacIdentityService", () => {
  it("issues, verifies, and CSRF-binds a device session", async () => {
    const identity = new HmacIdentityService({
      SESSION_SIGNING_KEY_CURRENT: "test-key-with-enough-entropy",
    });
    const now = 1_800_000_000_000;
    const ensured = await identity.ensureSession(
      new Request("https://board.test/api/v1/session"),
      now,
    );
    expect(ensured.session.actorId).toMatch(/^a_[A-Za-z0-9_-]{22}$/u);
    expect(ensured.setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(ensured.setCookie).toContain("Secure; HttpOnly; SameSite=Lax");

    const cookie = ensured.setCookie?.split(";", 1)[0] ?? "";
    const authenticated = new Request("https://board.test/api/v1/boards", {
      method: "POST",
      headers: { cookie, [CSRF_HEADER]: ensured.csrfToken },
    });
    const session = await identity.verifySession(authenticated, now + 1_000);
    expect(session.actorId).toBe(ensured.session.actorId);
    await expect(identity.verifyCsrf(authenticated, session)).resolves.toBeUndefined();
  });

  it("accepts a previous signing key but rejects tampering and expiry", async () => {
    const old = new HmacIdentityService({ SESSION_SIGNING_KEY_CURRENT: "previous-key" });
    const now = 1_800_000_000_000;
    const issued = await old.ensureSession(new Request("https://board.test/api/v1/session"), now);
    const cookie = issued.setCookie?.split(";", 1)[0] ?? "";
    const rotating = new HmacIdentityService({
      SESSION_SIGNING_KEY_CURRENT: "new-key",
      SESSION_SIGNING_KEY_PREVIOUS: "previous-key",
    });
    const session = await rotating.verifySession(
      new Request("https://board.test", { headers: { cookie } }),
      now + 1,
    );
    expect(session.keyVersion).toBe("previous");

    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    await expect(
      rotating.verifySession(
        new Request("https://board.test", { headers: { cookie: tampered } }),
        now + 1,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      rotating.verifySession(
        new Request("https://board.test", { headers: { cookie } }),
        now + 31 * 24 * 60 * 60 * 1_000,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
