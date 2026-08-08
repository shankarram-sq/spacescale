import {
  BOARD_FEATURE_KEYS,
  type BoardFeatures,
  DEFAULT_BOARD_FEATURES,
  normalizeBoardFeatures,
  ProtocolValidationError,
  validatePlainText,
} from "@collab/protocol";
import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, hmacSha256, utf8 } from "./crypto";
import { HttpError } from "./http/errors";
import type { BoardRole } from "./types";
import { requireDisplayName } from "./validation";

const TOKEN_PREFIX = "el1";
const MAX_TOKEN_BYTES = 8 * 1_024;
const MAX_REGISTRY_BYTES = 64 * 1_024;
const MAX_ORGANISATIONS = 256;
const MAX_PREVIOUS_KEYS = 8;
const MIN_HMAC_KEY_BYTES = 32;
const MAX_HMAC_KEY_BYTES = 4 * 1_024;
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const MAX_ORGANISATION_ID_CODE_POINTS = 120;
const MAX_SPACE_ID_CODE_POINTS = 120;
const MAX_PARTICIPANT_ID_CODE_POINTS = 320;

const PAYLOAD_KEYS = [
  "v",
  "aud",
  "organisation_id",
  "space_id",
  "key_id",
  "role",
  "display_name",
  "participant_id",
  "iat",
  "exp",
] as const;
const OPTIONAL_PAYLOAD_KEYS = ["features"] as const;

const ORGANISATION_KEY_SET_KEYS = ["derivation_key", "current", "previous"] as const;
const SIGNING_KEY_KEYS = ["key_id", "key"] as const;

export interface OrganisationLaunchPayload {
  v: 1;
  aud: string;
  organisation_id: string;
  space_id: string;
  key_id: string;
  role: BoardRole;
  display_name: string;
  participant_id: string;
  iat: number;
  exp: number;
  features?: Partial<BoardFeatures>;
}

export interface OrganisationSigningKey {
  key_id: string;
  key: string;
}

/**
 * JSON shape accepted by ORGANISATION_SIGNING_KEYS:
 *
 * {
 *   "school-42": {
 *     "derivation_key": "stable, organisation-specific secret (32+ UTF-8 bytes)",
 *     "current": { "key_id": "2026-08", "key": "current signing secret (32+ bytes)" },
 *     "previous": [{ "key_id": "2026-07", "key": "previous signing secret (32+ bytes)" }]
 *   }
 * }
 *
 * Rotate current/previous signing keys without changing derivation_key. The
 * latter keeps organisation, board, actor, custodian, and recovery identities
 * stable across signing-key rotation.
 */
export type OrganisationSigningKeyRegistry = Record<
  string,
  {
    derivation_key: string;
    current: OrganisationSigningKey;
    previous: OrganisationSigningKey[];
  }
>;

export interface OrganisationAuthEnv {
  APP_HOSTNAME?: string;
  ORGANISATION_SIGNING_KEYS?: string;
}

export interface VerifiedOrganisationLaunch {
  audience: string;
  organisationId: string;
  organisationKey: string;
  spaceId: string;
  spaceTitle: string;
  boardId: string;
  keyId: string;
  role: BoardRole;
  displayName: string;
  participantId: string;
  actorId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  placeholderOwnerActorId: string;
  ownerRecoveryHash: string;
  features: BoardFeatures;
}

interface ParsedOrganisationKeys {
  derivationKey: string;
  currentSigningKey: OrganisationSigningKey;
  signingKeysById: ReadonlyMap<string, string>;
}

export interface OrganisationWebhookSignature {
  keyId: string;
  signature: string;
}
export interface OrganisationViewerLaunch {
  token: string;
  expiresAtMs: number;
}

export class OrganisationAuthService {
  readonly #audience: string;
  readonly #organisations: ReadonlyMap<string, ParsedOrganisationKeys>;

  constructor(env: OrganisationAuthEnv) {
    if (!env.APP_HOSTNAME) throw configurationError();
    this.#audience = normalizeConfiguredAudience(env.APP_HOSTNAME);
    this.#organisations = parseSigningKeyRegistry(env.ORGANISATION_SIGNING_KEYS);
  }

  async verifyLaunchToken(token: unknown, now = Date.now()): Promise<VerifiedOrganisationLaunch> {
    if (
      typeof token !== "string" ||
      token.length < TOKEN_PREFIX.length + 2 ||
      utf8(token).byteLength > MAX_TOKEN_BYTES
    ) {
      throw invalidLaunchToken();
    }

    const pieces = token.split(".");
    if (pieces.length !== 3 || pieces[0] !== TOKEN_PREFIX) throw invalidLaunchToken();
    const encodedPayload = pieces[1];
    const payloadBytes = encodedPayload === undefined ? null : base64UrlToBytes(encodedPayload);
    const suppliedSignature = pieces[2] === undefined ? null : base64UrlToBytes(pieces[2]);
    if (
      encodedPayload === undefined ||
      payloadBytes === null ||
      suppliedSignature === null ||
      suppliedSignature.byteLength !== 32
    ) {
      throw invalidLaunchToken();
    }

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payloadBytes),
      );
    } catch {
      throw invalidLaunchToken();
    }
    const payload = normalizePayload(rawPayload);

    const organisationKeys = this.#organisations.get(payload.organisation_id);
    const signingKey = organisationKeys?.signingKeysById.get(payload.key_id);
    if (organisationKeys === undefined || signingKey === undefined) throw invalidLaunchToken();

    const signed = `${TOKEN_PREFIX}.${encodedPayload}`;
    const expectedSignature = await hmacSha256(signingKey, signed);
    if (!constantTimeEqual(suppliedSignature, expectedSignature)) throw invalidLaunchToken();
    if (payload.aud !== this.#audience) throw invalidLaunchToken();

    const nowSeconds = Math.floor(now / 1_000);
    if (
      payload.iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
      payload.exp <= payload.iat ||
      payload.exp <= nowSeconds ||
      payload.exp - payload.iat > MAX_LIFETIME_SECONDS
    ) {
      throw invalidLaunchToken();
    }

    const organisationScope = `${payload.organisation_id}`;
    const spaceScope = `${organisationScope}\u0000${payload.space_id}`;
    const [organisationId, boardId, actorId, placeholderOwnerActorId, ownerRecoveryHash] =
      await Promise.all([
        deriveOpaqueId(
          "o_",
          organisationKeys.derivationKey,
          `organisation:v1\u0000${organisationScope}`,
        ),
        deriveOpaqueId(
          "b_",
          organisationKeys.derivationKey,
          `organisation-board:v1\u0000${spaceScope}`,
        ),
        deriveOpaqueId(
          "a_",
          organisationKeys.derivationKey,
          `organisation-actor:v1\u0000${organisationScope}\u0000${payload.participant_id}`,
        ),
        deriveOpaqueId(
          "a_",
          organisationKeys.derivationKey,
          `organisation-custodian:v1\u0000${spaceScope}`,
        ),
        deriveInitialRecoverySentinelHash(
          organisationKeys.derivationKey,
          organisationScope,
          payload.space_id,
        ),
      ]);

    return {
      audience: payload.aud,
      organisationId,
      organisationKey: payload.organisation_id,
      spaceId: payload.space_id,
      spaceTitle: payload.space_id,
      boardId,
      keyId: payload.key_id,
      role: payload.role,
      displayName: payload.display_name,
      participantId: payload.participant_id,
      actorId,
      issuedAtMs: payload.iat * 1_000,
      expiresAtMs: payload.exp * 1_000,
      placeholderOwnerActorId,
      ownerRecoveryHash,
      features: payload.features,
    };
  }
  async issueViewerLaunchToken(
    organisationKey: string,
    spaceId: string,
    boardId: string,
    now = Date.now(),
  ): Promise<OrganisationViewerLaunch> {
    const keys = this.#organisations.get(organisationKey);
    const normalizedSpaceId = normalizeStableIdentifier(
      spaceId,
      MAX_SPACE_ID_CODE_POINTS,
      configurationError,
    );
    if (
      keys === undefined ||
      normalizedSpaceId !== spaceId ||
      !BOARD_OPAQUE_ID_PATTERN.test(boardId)
    ) {
      throw configurationError();
    }
    const derivedBoardId = await deriveOpaqueId(
      "b_",
      keys.derivationKey,
      `organisation-board:v1\u0000${organisationKey}\u0000${spaceId}`,
    );
    if (derivedBoardId !== boardId) throw configurationError();
    const issuedAt = Math.floor(now / 1_000);
    const expiresAt = issuedAt + 12 * 60 * 60;
    const token = await signOrganisationLaunchToken(
      {
        v: 1,
        aud: this.#audience,
        organisation_id: organisationKey,
        space_id: spaceId,
        key_id: keys.currentSigningKey.key_id,
        role: "viewer",
        display_name: "Space viewer",
        participant_id: `spacescale-viewer:${boardId}`,
        iat: issuedAt,
        exp: expiresAt,
      },
      keys.currentSigningKey.key,
    );
    return { token, expiresAtMs: expiresAt * 1_000 };
  }

  async signWebhookPayload(
    organisationId: string,
    timestampSeconds: number,
    body: string,
  ): Promise<OrganisationWebhookSignature> {
    if (!ORGANISATION_OPAQUE_ID_PATTERN.test(organisationId)) throw configurationError();
    if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) throw configurationError();
    for (const [organisationKey, keys] of this.#organisations) {
      const candidateId = await deriveOpaqueId(
        "o_",
        keys.derivationKey,
        `organisation:v1\u0000${organisationKey}`,
      );
      if (candidateId !== organisationId) continue;
      const signed = `v1.${timestampSeconds}.${body}`;
      return {
        keyId: keys.currentSigningKey.key_id,
        signature: bytesToBase64Url(await hmacSha256(keys.currentSigningKey.key, signed)),
      };
    }
    throw configurationError();
  }
}
const BOARD_OPAQUE_ID_PATTERN = /^b_[A-Za-z0-9_-]{22}$/u;

export async function signOrganisationLaunchToken(
  payload: OrganisationLaunchPayload,
  signingKey: string,
): Promise<string> {
  if (!isValidHmacKey(signingKey)) {
    throw new Error("An organisation signing key of at least 32 UTF-8 bytes is required.");
  }
  const encodedPayload = bytesToBase64Url(utf8(JSON.stringify(payload)));
  const signed = `${TOKEN_PREFIX}.${encodedPayload}`;
  return `${signed}.${bytesToBase64Url(await hmacSha256(signingKey, signed))}`;
}

function parseSigningKeyRegistry(
  value: string | undefined,
): ReadonlyMap<string, ParsedOrganisationKeys> {
  if (!value || utf8(value).byteLength > MAX_REGISTRY_BYTES) throw configurationError();

  let rawRegistry: unknown;
  try {
    rawRegistry = JSON.parse(value);
  } catch {
    throw configurationError();
  }
  if (!isPlainObject(rawRegistry)) throw configurationError();
  const entries = Object.entries(rawRegistry);
  if (entries.length < 1 || entries.length > MAX_ORGANISATIONS) throw configurationError();

  const organisations = new Map<string, ParsedOrganisationKeys>();
  const keyOwners = new Map<string, string>();
  for (const [rawOrganisationKey, rawKeySet] of entries) {
    const organisationKey = normalizeStableIdentifier(
      rawOrganisationKey,
      MAX_ORGANISATION_ID_CODE_POINTS,
      configurationError,
    );
    if (organisationKey !== rawOrganisationKey || organisations.has(organisationKey)) {
      throw configurationError();
    }
    if (!hasExactKeys(rawKeySet, ORGANISATION_KEY_SET_KEYS)) throw configurationError();

    const derivationKey = rawKeySet.derivation_key;
    if (!isValidHmacKey(derivationKey)) throw configurationError();
    recordUniqueSecret(keyOwners, derivationKey, `${organisationKey}:derivation`);

    const current = parseSigningKey(rawKeySet.current);
    if (!Array.isArray(rawKeySet.previous) || rawKeySet.previous.length > MAX_PREVIOUS_KEYS) {
      throw configurationError();
    }
    const previous = rawKeySet.previous.map(parseSigningKey);
    const signingKeysById = new Map<string, string>();
    for (const entry of [current, ...previous]) {
      if (signingKeysById.has(entry.key_id)) throw configurationError();
      signingKeysById.set(entry.key_id, entry.key);
      recordUniqueSecret(keyOwners, entry.key, `${organisationKey}:${entry.key_id}`);
    }
    organisations.set(organisationKey, {
      derivationKey,
      currentSigningKey: current,
      signingKeysById,
    });
  }
  return organisations;
}

const ORGANISATION_OPAQUE_ID_PATTERN = /^o_[A-Za-z0-9_-]{22}$/u;

function parseSigningKey(value: unknown): OrganisationSigningKey {
  if (!hasExactKeys(value, SIGNING_KEY_KEYS)) throw configurationError();
  if (
    typeof value.key_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.key_id) ||
    !isValidHmacKey(value.key)
  ) {
    throw configurationError();
  }
  return { key_id: value.key_id, key: value.key };
}

function recordUniqueSecret(owners: Map<string, string>, key: string, owner: string): void {
  if (owners.has(key)) throw configurationError();
  owners.set(key, owner);
}

function isValidHmacKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const byteLength = utf8(value).byteLength;
  return byteLength >= MIN_HMAC_KEY_BYTES && byteLength <= MAX_HMAC_KEY_BYTES;
}

function normalizePayload(value: unknown): OrganisationLaunchPayload & { features: BoardFeatures } {
  if (!hasRequiredAndOptionalKeys(value, PAYLOAD_KEYS, OPTIONAL_PAYLOAD_KEYS)) {
    throw invalidLaunchToken();
  }
  if (value.v !== 1) throw invalidLaunchToken();
  const audience = normalizeAudienceClaim(value.aud);
  const organisationId = normalizeStableIdentifier(
    value.organisation_id,
    MAX_ORGANISATION_ID_CODE_POINTS,
    invalidLaunchToken,
  );
  const spaceId = normalizeStableIdentifier(
    value.space_id,
    MAX_SPACE_ID_CODE_POINTS,
    invalidLaunchToken,
  );
  if (
    typeof value.key_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.key_id)
  ) {
    throw invalidLaunchToken();
  }
  if (value.role !== "owner" && value.role !== "editor" && value.role !== "viewer") {
    throw invalidLaunchToken();
  }
  const displayName = normalizeDisplayName(value.display_name);
  const participantId = normalizeStableIdentifier(
    value.participant_id,
    MAX_PARTICIPANT_ID_CODE_POINTS,
    invalidLaunchToken,
  );
  if (
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.exp) ||
    (value.iat as number) < 0 ||
    (value.exp as number) < 0
  ) {
    throw invalidLaunchToken();
  }
  const features = normalizeInitialFeatures(value.features, invalidLaunchToken);
  return {
    v: 1,
    aud: audience,
    organisation_id: organisationId,
    space_id: spaceId,
    key_id: value.key_id,
    role: value.role,
    display_name: displayName,
    participant_id: participantId,
    iat: value.iat as number,
    exp: value.exp as number,
    features,
  };
}

function normalizeInitialFeatures(value: unknown, errorFactory: () => HttpError): BoardFeatures {
  if (value === undefined) return { ...DEFAULT_BOARD_FEATURES };
  if (!isPlainObject(value)) throw errorFactory();
  const allowed = new Set<string>(BOARD_FEATURE_KEYS);
  const patch: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (!allowed.has(key) || typeof enabled !== "boolean") throw errorFactory();
    patch[key] = enabled;
  }
  try {
    return normalizeBoardFeatures({ ...DEFAULT_BOARD_FEATURES, ...patch });
  } catch {
    throw errorFactory();
  }
}

function normalizeConfiguredAudience(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 1 ||
    normalized.length > 253 ||
    !/^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*)$/u.test(
      normalized,
    )
  ) {
    throw configurationError();
  }
  return normalized;
}

function normalizeAudienceClaim(value: unknown): string {
  if (typeof value !== "string") throw invalidLaunchToken();
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 1 || normalized.length > 253) throw invalidLaunchToken();
  return normalized;
}

function normalizeStableIdentifier(
  value: unknown,
  maxCodePoints: number,
  errorFactory: () => HttpError,
): string {
  if (typeof value !== "string") throw errorFactory();
  const normalized = value.normalize("NFC").trim();
  try {
    validatePlainText(normalized, "identifier");
  } catch (error) {
    if (!(error instanceof ProtocolValidationError)) throw error;
    throw errorFactory();
  }
  if (
    [...normalized].length < 1 ||
    [...normalized].length > maxCodePoints ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw errorFactory();
  }
  return normalized;
}

function normalizeDisplayName(value: unknown): string {
  try {
    if (typeof value !== "string") throw invalidLaunchToken();
    return requireDisplayName(value.normalize("NFC"));
  } catch (error) {
    if (error instanceof HttpError && error.status === 500) throw error;
    throw invalidLaunchToken();
  }
}

function hasExactKeys<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): value is Record<Keys[number], unknown> {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasRequiredAndOptionalKeys<
  const Required extends readonly string[],
  const Optional extends readonly string[],
>(
  value: unknown,
  required: Required,
  optional: Optional,
): value is Record<Required[number], unknown> & Partial<Record<Optional[number], unknown>> {
  if (!isPlainObject(value)) return false;
  const allowed = new Set<string>([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function deriveOpaqueId(
  prefix: "a_" | "b_" | "o_",
  secret: string,
  input: string,
): Promise<string> {
  const digest = await hmacSha256(secret, input);
  return `${prefix}${bytesToBase64Url(digest.slice(0, 16))}`;
}

async function deriveInitialRecoverySentinelHash(
  secret: string,
  organisationKey: string,
  spaceId: string,
): Promise<string> {
  return bytesToBase64Url(
    await hmacSha256(
      secret,
      `organisation-owner-recovery-hash:v1\u0000${organisationKey}\u0000${spaceId}`,
    ),
  );
}

function invalidLaunchToken(): HttpError {
  return new HttpError(
    401,
    "AUTH_REQUIRED",
    "The organisation launch assertion is invalid or expired.",
  );
}

function configurationError(): HttpError {
  return new HttpError(
    500,
    "INTERNAL_ERROR",
    "Organisation launch authentication is not configured.",
  );
}

export const __organisationAuthTestUtils = {
  MAX_CLOCK_SKEW_SECONDS,
  MAX_LIFETIME_SECONDS,
  TOKEN_PREFIX,
};
