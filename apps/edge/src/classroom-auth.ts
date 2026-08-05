import { ProtocolValidationError, validatePlainText } from "@collab/protocol";
import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, hmacSha256, utf8 } from "./crypto";
import { HttpError } from "./http/errors";
import type { BoardRole, Env } from "./types";
import { optionalTitle, requireDisplayName } from "./validation";

const TOKEN_PREFIX = "cl1";
const MAX_TOKEN_BYTES = 8 * 1_024;
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const MAX_USER_IDENTIFIER_CODE_POINTS = 320;

const PAYLOAD_KEYS = [
  "v",
  "aud",
  "board_name",
  "role",
  "display_name",
  "user_identifier",
  "iat",
  "exp",
] as const;

export interface ClassroomLaunchPayload {
  v: 1;
  aud: string;
  board_name: string;
  role: BoardRole;
  display_name: string;
  user_identifier: string;
  iat: number;
  exp: number;
}

export interface VerifiedClassroomLaunch {
  audience: string;
  boardName: string;
  boardId: string;
  role: BoardRole;
  displayName: string;
  userIdentifier: string;
  actorId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  placeholderOwnerActorId: string;
  ownerRecoveryHash: string;
}

export class ClassroomAuthService {
  readonly #integrationKey: string;
  readonly #audience: string;

  constructor(env: Pick<Env, "APP_HOSTNAME" | "CLASSROOM_INTEGRATION_KEY">) {
    if (!env.CLASSROOM_INTEGRATION_KEY || utf8(env.CLASSROOM_INTEGRATION_KEY).byteLength < 32) {
      throw new HttpError(500, "INTERNAL_ERROR", "Classroom integration is not configured.");
    }
    if (!env.APP_HOSTNAME) {
      throw new HttpError(500, "INTERNAL_ERROR", "The application hostname is not configured.");
    }
    this.#integrationKey = env.CLASSROOM_INTEGRATION_KEY;
    this.#audience = normalizeAudience(env.APP_HOSTNAME);
  }

  async verifyLaunchToken(token: unknown, now = Date.now()): Promise<VerifiedClassroomLaunch> {
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
    const suppliedSignature = pieces[2] === undefined ? null : base64UrlToBytes(pieces[2]);
    const payloadBytes = encodedPayload === undefined ? null : base64UrlToBytes(encodedPayload);
    if (
      encodedPayload === undefined ||
      suppliedSignature === null ||
      suppliedSignature.byteLength !== 32 ||
      payloadBytes === null
    ) {
      throw invalidLaunchToken();
    }

    const signed = `${TOKEN_PREFIX}.${encodedPayload}`;
    const expectedSignature = await hmacSha256(this.#integrationKey, signed);
    if (!constantTimeEqual(suppliedSignature, expectedSignature)) throw invalidLaunchToken();

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payloadBytes),
      );
    } catch {
      throw invalidLaunchToken();
    }
    const payload = normalizePayload(rawPayload);
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

    const [boardId, actorId, placeholderOwnerActorId, ownerRecoveryHash] = await Promise.all([
      deriveOpaqueId("b_", this.#integrationKey, `classroom-board:v1\u0000${payload.board_name}`),
      deriveOpaqueId(
        "a_",
        this.#integrationKey,
        `classroom-actor:v1\u0000${payload.user_identifier}`,
      ),
      deriveOpaqueId(
        "a_",
        this.#integrationKey,
        `classroom-custodian:v1\u0000${payload.board_name}`,
      ),
      deriveInitialRecoverySentinelHash(this.#integrationKey, payload.board_name),
    ]);

    return {
      audience: payload.aud,
      boardName: payload.board_name,
      boardId,
      role: payload.role,
      displayName: payload.display_name,
      userIdentifier: payload.user_identifier,
      actorId,
      issuedAtMs: payload.iat * 1_000,
      expiresAtMs: payload.exp * 1_000,
      placeholderOwnerActorId,
      ownerRecoveryHash,
    };
  }
}

export async function signClassroomLaunchToken(
  payload: ClassroomLaunchPayload,
  integrationKey: string,
): Promise<string> {
  if (!integrationKey) throw new Error("An integration key is required.");
  const encodedPayload = bytesToBase64Url(utf8(JSON.stringify(payload)));
  const signed = `${TOKEN_PREFIX}.${encodedPayload}`;
  return `${signed}.${bytesToBase64Url(await hmacSha256(integrationKey, signed))}`;
}

function normalizePayload(value: unknown): ClassroomLaunchPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidLaunchToken();
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== PAYLOAD_KEYS.length ||
    PAYLOAD_KEYS.some((key) => !Object.hasOwn(object, key))
  ) {
    throw invalidLaunchToken();
  }
  if (object.v !== 1) throw invalidLaunchToken();
  const audience = normalizeAudienceClaim(object.aud);
  const boardName = normalizeBoardName(object.board_name);
  if (object.role !== "owner" && object.role !== "editor" && object.role !== "viewer") {
    throw invalidLaunchToken();
  }
  const displayName = normalizeDisplayName(object.display_name);
  const userIdentifier = normalizeUserIdentifier(object.user_identifier);
  if (!Number.isSafeInteger(object.iat) || !Number.isSafeInteger(object.exp)) {
    throw invalidLaunchToken();
  }
  return {
    v: 1,
    aud: audience,
    board_name: boardName,
    role: object.role,
    display_name: displayName,
    user_identifier: userIdentifier,
    iat: object.iat as number,
    exp: object.exp as number,
  };
}

function normalizeAudience(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 1 ||
    normalized.length > 253 ||
    !/^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*)$/u.test(
      normalized,
    )
  ) {
    throw new HttpError(500, "INTERNAL_ERROR", "The application hostname is invalid.");
  }
  return normalized;
}

function normalizeAudienceClaim(value: unknown): string {
  if (typeof value !== "string") throw invalidLaunchToken();
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 1 || normalized.length > 253) throw invalidLaunchToken();
  return normalized;
}

function normalizeBoardName(value: unknown): string {
  try {
    if (typeof value !== "string") throw invalidLaunchToken();
    return optionalTitle(value.normalize("NFC"));
  } catch (error) {
    if (error instanceof HttpError && error.status === 500) throw error;
    throw invalidLaunchToken();
  }
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

function normalizeUserIdentifier(value: unknown): string {
  if (typeof value !== "string") throw invalidLaunchToken();
  const normalized = value.normalize("NFC").trim();
  try {
    validatePlainText(normalized, "user_identifier");
  } catch (error) {
    if (!(error instanceof ProtocolValidationError)) throw error;
    throw invalidLaunchToken();
  }
  if ([...normalized].length > MAX_USER_IDENTIFIER_CODE_POINTS || /\p{Cc}/u.test(normalized)) {
    throw invalidLaunchToken();
  }
  return normalized;
}

async function deriveOpaqueId(prefix: "a_" | "b_", secret: string, input: string): Promise<string> {
  const digest = await hmacSha256(secret, input);
  return `${prefix}${bytesToBase64Url(digest.slice(0, 16))}`;
}

async function deriveInitialRecoverySentinelHash(
  secret: string,
  boardName: string,
): Promise<string> {
  // The trusted backend can always reissue an owner launch. This unpredictable
  // sentinel remains unclaimable until the primary explicitly rotates a link.
  return bytesToBase64Url(
    await hmacSha256(secret, `classroom-owner-recovery-hash:v1\u0000${boardName}`),
  );
}

function invalidLaunchToken(): HttpError {
  return new HttpError(401, "AUTH_REQUIRED", "The classroom launch token is invalid or expired.");
}

export const __classroomAuthTestUtils = {
  MAX_CLOCK_SKEW_SECONDS,
  MAX_LIFETIME_SECONDS,
  TOKEN_PREFIX,
};
