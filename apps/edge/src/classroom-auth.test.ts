import { describe, expect, it } from "vitest";
import {
  __classroomAuthTestUtils,
  ClassroomAuthService,
  type ClassroomLaunchPayload,
  signClassroomLaunchToken,
} from "./classroom-auth";

const INTEGRATION_KEY = "classroom-integration-key-with-enough-entropy";
const NOW = 1_800_000_000_000;

function payload(overrides: Partial<ClassroomLaunchPayload> = {}): ClassroomLaunchPayload {
  const nowSeconds = Math.floor(NOW / 1_000);
  return {
    v: 1,
    aud: "localhost",
    board_name: "Algebra workshop",
    role: "editor",
    display_name: "Asha",
    user_identifier: "student-42",
    iat: nowSeconds - 30,
    exp: nowSeconds + 3_600,
    ...overrides,
  };
}

function service(key = INTEGRATION_KEY): ClassroomAuthService {
  return new ClassroomAuthService({
    APP_HOSTNAME: "localhost",
    CLASSROOM_INTEGRATION_KEY: key,
  });
}

describe("ClassroomAuthService", () => {
  it("verifies, normalizes, and deterministically derives classroom identities", async () => {
    const firstToken = await signClassroomLaunchToken(
      payload({
        aud: " LOCALHOST ",
        board_name: "  Cafe\u0301 geometry  ",
        display_name: "  Asha  ",
        user_identifier: "  student-42  ",
      }),
      INTEGRATION_KEY,
    );
    const first = await service().verifyLaunchToken(firstToken, NOW);

    expect(first).toMatchObject({
      audience: "localhost",
      boardName: "Café geometry",
      displayName: "Asha",
      userIdentifier: "student-42",
      role: "editor",
    });
    expect(first.boardId).toMatch(/^b_[A-Za-z0-9_-]{22}$/u);
    expect(first.actorId).toMatch(/^a_[A-Za-z0-9_-]{22}$/u);
    expect(first.placeholderOwnerActorId).toMatch(/^a_[A-Za-z0-9_-]{22}$/u);
    expect(first.placeholderOwnerActorId).not.toBe(first.actorId);
    expect(first.ownerRecoveryHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const sameIdentity = await service().verifyLaunchToken(
      await signClassroomLaunchToken(
        payload({
          board_name: "Café geometry",
          role: "viewer",
          display_name: "Asha renamed",
        }),
        INTEGRATION_KEY,
      ),
      NOW,
    );
    expect(sameIdentity.boardId).toBe(first.boardId);
    expect(sameIdentity.actorId).toBe(first.actorId);
    expect(sameIdentity.placeholderOwnerActorId).toBe(first.placeholderOwnerActorId);

    const otherBoard = await service().verifyLaunchToken(
      await signClassroomLaunchToken(payload({ board_name: "Calculus workshop" }), INTEGRATION_KEY),
      NOW,
    );
    const otherUser = await service().verifyLaunchToken(
      await signClassroomLaunchToken(
        payload({ board_name: "Café geometry", user_identifier: "student-43" }),
        INTEGRATION_KEY,
      ),
      NOW,
    );
    expect(otherBoard.boardId).not.toBe(first.boardId);
    expect(otherUser.boardId).toBe(first.boardId);
    expect(otherUser.actorId).not.toBe(first.actorId);
  });

  it("rejects tampering, the wrong audience, and unknown signed fields", async () => {
    const valid = await signClassroomLaunchToken(payload(), INTEGRATION_KEY);
    const tampered = valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A");
    await expect(service().verifyLaunchToken(tampered, NOW)).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });

    const wrongAudience = await signClassroomLaunchToken(
      payload({ aud: "other.example" }),
      INTEGRATION_KEY,
    );
    await expect(service().verifyLaunchToken(wrongAudience, NOW)).rejects.toMatchObject({
      status: 401,
    });

    const extraField = await signClassroomLaunchToken(
      { ...payload(), unexpected: true } as ClassroomLaunchPayload,
      INTEGRATION_KEY,
    );
    await expect(service().verifyLaunchToken(extraField, NOW)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("enforces Unix-second expiry, future skew, and the 24-hour lifetime", async () => {
    const nowSeconds = Math.floor(NOW / 1_000);
    const invalidPayloads = [
      payload({ iat: nowSeconds - 60, exp: nowSeconds }),
      payload({ iat: nowSeconds + __classroomAuthTestUtils.MAX_CLOCK_SKEW_SECONDS + 1 }),
      payload({
        iat: nowSeconds,
        exp: nowSeconds + __classroomAuthTestUtils.MAX_LIFETIME_SECONDS + 1,
      }),
      payload({ iat: nowSeconds + 1, exp: nowSeconds + 1 }),
    ];
    for (const invalid of invalidPayloads) {
      const token = await signClassroomLaunchToken(invalid, INTEGRATION_KEY);
      await expect(service().verifyLaunchToken(token, NOW)).rejects.toMatchObject({ status: 401 });
    }
  });

  it("fails closed when the integration key is absent or shorter than 32 UTF-8 bytes", () => {
    for (const CLASSROOM_INTEGRATION_KEY of [undefined, "short", "é".repeat(15)]) {
      expect(
        () =>
          new ClassroomAuthService({
            APP_HOSTNAME: "localhost",
            CLASSROOM_INTEGRATION_KEY,
          }),
      ).toThrowError(expect.objectContaining({ status: 500 }));
    }
    expect(() => service("é".repeat(16))).not.toThrow();
  });
});
