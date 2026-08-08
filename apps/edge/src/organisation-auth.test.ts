import { describe, expect, it } from "vitest";
import { bytesToBase64Url, hmacSha256 } from "./crypto";
import {
  __organisationAuthTestUtils,
  OrganisationAuthService,
  type OrganisationLaunchPayload,
  type OrganisationSigningKeyRegistry,
  signOrganisationLaunchToken,
} from "./organisation-auth";

const NOW = 1_800_000_000_000;
const ORG_A_DERIVATION_KEY = `org-a-derivation-key-${"d".repeat(32)}`;
const ORG_A_CURRENT_KEY = `org-a-current-signing-key-${"c".repeat(32)}`;
const ORG_A_PREVIOUS_KEY = `org-a-previous-signing-key-${"p".repeat(32)}`;
const ORG_A_NEXT_KEY = `org-a-next-signing-key-${"n".repeat(32)}`;
const ORG_B_DERIVATION_KEY = `org-b-derivation-key-${"e".repeat(32)}`;
const ORG_B_CURRENT_KEY = `org-b-current-signing-key-${"f".repeat(32)}`;

function registry(): OrganisationSigningKeyRegistry {
  return {
    "Café School": {
      derivation_key: ORG_A_DERIVATION_KEY,
      current: { key_id: "2026-08", key: ORG_A_CURRENT_KEY },
      previous: [{ key_id: "2026-07", key: ORG_A_PREVIOUS_KEY }],
    },
    "Other School": {
      derivation_key: ORG_B_DERIVATION_KEY,
      current: { key_id: "2026-08", key: ORG_B_CURRENT_KEY },
      previous: [],
    },
  };
}

function service(keys: unknown = registry()): OrganisationAuthService {
  return new OrganisationAuthService({
    APP_HOSTNAME: "localhost",
    ORGANISATION_SIGNING_KEYS: typeof keys === "string" ? keys : JSON.stringify(keys),
  });
}

function payload(overrides: Partial<OrganisationLaunchPayload> = {}): OrganisationLaunchPayload {
  const nowSeconds = Math.floor(NOW / 1_000);
  return {
    v: 1,
    aud: "localhost",
    organisation_id: "Café School",
    space_id: "Algebra workshop",
    key_id: "2026-08",
    role: "editor",
    display_name: "Asha",
    participant_id: "student-42",
    iat: nowSeconds - 30,
    exp: nowSeconds + 3_600,
    ...overrides,
  };
}

describe("OrganisationAuthService", () => {
  it("verifies normalized claims and derives stable organisation-scoped identities", async () => {
    const first = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(
        payload({
          aud: " LOCALHOST ",
          organisation_id: "  Cafe\u0301 School  ",
          space_id: "  Fractions cafe\u0301  ",
          display_name: "  Asha  ",
          participant_id: "  student-42  ",
          features: { line: false, images: true },
        }),
        ORG_A_CURRENT_KEY,
      ),
      NOW,
    );

    expect(first).toMatchObject({
      audience: "localhost",
      organisationKey: "Café School",
      spaceId: "Fractions café",
      spaceTitle: "Fractions café",
      keyId: "2026-08",
      role: "editor",
      displayName: "Asha",
      participantId: "student-42",
      features: expect.objectContaining({ line: false, images: true, pencil: true }),
    });
    expect(first.organisationId).toMatch(/^o_[A-Za-z0-9_-]{22}$/u);
    expect(first.boardId).toMatch(/^b_[A-Za-z0-9_-]{22}$/u);
    expect(first.actorId).toMatch(/^a_[A-Za-z0-9_-]{22}$/u);
    expect(first.placeholderOwnerActorId).toMatch(/^a_[A-Za-z0-9_-]{22}$/u);
    expect(first.placeholderOwnerActorId).not.toBe(first.actorId);
    expect(first.ownerRecoveryHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const sameActorOtherSpace = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(
        payload({ space_id: "Geometry", display_name: "Asha renamed", role: "viewer" }),
        ORG_A_CURRENT_KEY,
      ),
      NOW,
    );
    expect(sameActorOtherSpace.organisationId).toBe(first.organisationId);
    expect(sameActorOtherSpace.actorId).toBe(first.actorId);
    expect(sameActorOtherSpace.boardId).not.toBe(first.boardId);
    expect(sameActorOtherSpace.placeholderOwnerActorId).not.toBe(first.placeholderOwnerActorId);
    expect(sameActorOtherSpace.ownerRecoveryHash).not.toBe(first.ownerRecoveryHash);

    const sameSpaceOtherParticipant = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(
        payload({ space_id: "Fractions café", participant_id: "student-43" }),
        ORG_A_CURRENT_KEY,
      ),
      NOW,
    );
    expect(sameSpaceOtherParticipant.boardId).toBe(first.boardId);
    expect(sameSpaceOtherParticipant.actorId).not.toBe(first.actorId);
  });

  it("isolates identical space and participant keys between organisations", async () => {
    const first = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(payload(), ORG_A_CURRENT_KEY),
      NOW,
    );
    const second = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(
        payload({ organisation_id: "Other School" }),
        ORG_B_CURRENT_KEY,
      ),
      NOW,
    );

    expect(second.organisationId).not.toBe(first.organisationId);
    expect(second.boardId).not.toBe(first.boardId);
    expect(second.actorId).not.toBe(first.actorId);
    expect(second.placeholderOwnerActorId).not.toBe(first.placeholderOwnerActorId);
    expect(second.ownerRecoveryHash).not.toBe(first.ownerRecoveryHash);
  });

  it("accepts current and previous key IDs while stable derivations survive rotation", async () => {
    const current = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(payload(), ORG_A_CURRENT_KEY),
      NOW,
    );
    const previous = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(payload({ key_id: "2026-07" }), ORG_A_PREVIOUS_KEY),
      NOW,
    );
    expect(previous).toMatchObject({
      organisationId: current.organisationId,
      boardId: current.boardId,
      actorId: current.actorId,
      placeholderOwnerActorId: current.placeholderOwnerActorId,
      ownerRecoveryHash: current.ownerRecoveryHash,
      keyId: "2026-07",
    });

    const rotatedRegistry = registry();
    rotatedRegistry["Café School"] = {
      derivation_key: ORG_A_DERIVATION_KEY,
      current: { key_id: "2026-09", key: ORG_A_NEXT_KEY },
      previous: [{ key_id: "2026-08", key: ORG_A_CURRENT_KEY }],
    };
    const afterRotation = await service(rotatedRegistry).verifyLaunchToken(
      await signOrganisationLaunchToken(payload({ key_id: "2026-09" }), ORG_A_NEXT_KEY),
      NOW,
    );
    expect(afterRotation).toMatchObject({
      organisationId: current.organisationId,
      boardId: current.boardId,
      actorId: current.actorId,
      placeholderOwnerActorId: current.placeholderOwnerActorId,
      ownerRecoveryHash: current.ownerRecoveryHash,
      keyId: "2026-09",
    });
  });

  it("signs webhook payloads with the matching organisation current key and domain", async () => {
    const launch = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(payload(), ORG_A_CURRENT_KEY),
      NOW,
    );
    const timestamp = Math.floor(NOW / 1_000);
    const body = JSON.stringify({ event: "board.exported", deliveryId: "whd_example" });
    const signed = await service().signWebhookPayload(launch.organisationId, timestamp, body);

    expect(signed).toEqual({
      keyId: "2026-08",
      signature: bytesToBase64Url(await hmacSha256(ORG_A_CURRENT_KEY, `v1.${timestamp}.${body}`)),
    });
    await expect(
      service().signWebhookPayload(`o_${"Z".repeat(22)}`, timestamp, body),
    ).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
  });

  it("rejects unknown organisations, unknown key IDs, wrong keys, and tampering", async () => {
    const unknownOrganisation = await signOrganisationLaunchToken(
      payload({ organisation_id: "Unknown School" }),
      ORG_A_CURRENT_KEY,
    );
    const unknownKeyId = await signOrganisationLaunchToken(
      payload({ key_id: "unknown" }),
      ORG_A_CURRENT_KEY,
    );
    const wrongKey = await signOrganisationLaunchToken(payload(), ORG_B_CURRENT_KEY);
    const valid = await signOrganisationLaunchToken(payload(), ORG_A_CURRENT_KEY);
    const tampered = valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A");

    for (const token of [unknownOrganisation, unknownKeyId, wrongKey, tampered]) {
      await expect(service().verifyLaunchToken(token, NOW)).rejects.toMatchObject({
        status: 401,
        code: "AUTH_REQUIRED",
      });
    }
  });

  it("reports Organisation administration authority only for an explicit boolean claim", async () => {
    const plain = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(payload({ role: "owner" }), ORG_A_CURRENT_KEY),
      NOW,
    );
    const admin = await service().verifyLaunchToken(
      await signOrganisationLaunchToken(
        payload({ role: "owner", organisation_admin: true }),
        ORG_A_CURRENT_KEY,
      ),
      NOW,
    );

    expect(plain.organisationAdmin).toBe(false);
    expect(admin.organisationAdmin).toBe(true);

    const notBoolean = await signOrganisationLaunchToken(
      { ...payload(), organisation_admin: "yes" } as unknown as OrganisationLaunchPayload,
      ORG_A_CURRENT_KEY,
    );
    await expect(service().verifyLaunchToken(notBoolean, NOW)).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
  });

  it("requires the el1 prefix and exactly the version 1 organisation claims", async () => {
    const variants: unknown[] = [
      { ...payload(), unexpected: true },
      Object.fromEntries(Object.entries(payload()).filter(([key]) => key !== "participant_id")),
      { ...payload(), v: 2 },
      { ...payload(), role: "admin" },
      { ...payload(), key_id: "bad key_id" },
      { ...payload(), organisation_id: "\u0000school" },
      { ...payload(), space_id: "" },
      { ...payload(), participant_id: "p".repeat(321) },
      { ...payload(), features: { unknown: true } },
      { ...payload(), features: { line: "yes" } },
    ];
    for (const value of variants) {
      const token = await signOrganisationLaunchToken(
        value as OrganisationLaunchPayload,
        ORG_A_CURRENT_KEY,
      );
      await expect(service().verifyLaunchToken(token, NOW)).rejects.toMatchObject({ status: 401 });
    }

    const valid = await signOrganisationLaunchToken(payload(), ORG_A_CURRENT_KEY);
    await expect(
      service().verifyLaunchToken(valid.replace(/^el1\./u, "cl1."), NOW),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("enforces audience, Unix-second expiry, future skew, and a 24-hour lifetime", async () => {
    const nowSeconds = Math.floor(NOW / 1_000);
    const invalidPayloads = [
      payload({ aud: "other.example" }),
      payload({ iat: nowSeconds - 60, exp: nowSeconds }),
      payload({ iat: nowSeconds + __organisationAuthTestUtils.MAX_CLOCK_SKEW_SECONDS + 1 }),
      payload({
        iat: nowSeconds,
        exp: nowSeconds + __organisationAuthTestUtils.MAX_LIFETIME_SECONDS + 1,
      }),
      payload({ iat: nowSeconds + 1, exp: nowSeconds + 1 }),
      payload({ iat: -1 }),
    ];
    for (const invalid of invalidPayloads) {
      const token = await signOrganisationLaunchToken(invalid, ORG_A_CURRENT_KEY);
      await expect(service().verifyLaunchToken(token, NOW)).rejects.toMatchObject({ status: 401 });
    }
  });

  it("fails closed for malformed registries, short keys, duplicate key IDs, and reused secrets", () => {
    const malformedRegistries: unknown[] = [
      "not-json",
      [],
      {},
      {
        School: {
          derivation_key: "short",
          current: { key_id: "current", key: ORG_A_CURRENT_KEY },
          previous: [],
        },
      },
      {
        School: {
          derivation_key: ORG_A_DERIVATION_KEY,
          current: { key_id: "current", key: "short" },
          previous: [],
        },
      },
      {
        School: {
          derivation_key: ORG_A_DERIVATION_KEY,
          current: { key_id: "same", key: ORG_A_CURRENT_KEY },
          previous: [{ key_id: "same", key: ORG_A_PREVIOUS_KEY }],
        },
      },
      {
        School: {
          derivation_key: ORG_A_DERIVATION_KEY,
          current: { key_id: "current", key: ORG_A_CURRENT_KEY },
          previous: [{ key_id: "old", key: ORG_A_CURRENT_KEY }],
        },
      },
      {
        School: {
          derivation_key: ORG_A_DERIVATION_KEY,
          current: { key_id: "current", key: ORG_A_CURRENT_KEY },
          previous: [],
        },
        Other: {
          derivation_key: ORG_B_DERIVATION_KEY,
          current: { key_id: "current", key: ORG_A_CURRENT_KEY },
          previous: [],
        },
      },
      {
        " School ": {
          derivation_key: ORG_A_DERIVATION_KEY,
          current: { key_id: "current", key: ORG_A_CURRENT_KEY },
          previous: [],
        },
      },
    ];

    for (const malformed of malformedRegistries) {
      expect(() => service(malformed)).toThrowError(
        expect.objectContaining({ status: 500, code: "INTERNAL_ERROR" }),
      );
    }
    expect(
      () =>
        new OrganisationAuthService({
          APP_HOSTNAME: "localhost",
          ORGANISATION_SIGNING_KEYS: undefined,
        }),
    ).toThrowError(expect.objectContaining({ status: 500 }));
  });

  it("requires signing helpers to use HMAC keys of at least 32 UTF-8 bytes", async () => {
    await expect(signOrganisationLaunchToken(payload(), "short")).rejects.toThrow(
      "at least 32 UTF-8 bytes",
    );
    await expect(signOrganisationLaunchToken(payload(), "é".repeat(16))).resolves.toMatch(
      /^el1\./u,
    );
  });
});
