import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  hmacSha256,
  randomActorId,
  utf8,
} from "./crypto";
import { HttpError } from "./http/errors";
import type { DeviceSession, Env } from "./types";

export const SESSION_COOKIE = "__Host-wb_session";
export const CSRF_HEADER = "x-csrf-token";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const EMBED_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const EMBED_SESSION_PREFIX = "es1";
const ACTOR_ID_PATTERN = /^a_[A-Za-z0-9_-]{22}$/u;
const BOARD_ID_PATTERN = /^b_[A-Za-z0-9_-]{22}$/u;

interface SessionPayload {
  v: 1;
  a: string;
  i: number;
  e: number;
}

interface EmbedSessionPayload {
  v: 1;
  a: string;
  b: string;
  i: number;
  e: number;
}

export interface IssuedEmbedSession {
  token: string;
  session: DeviceSession & { boardId: string };
}

export interface EnsuredSession {
  session: DeviceSession;
  csrfToken: string;
  setCookie?: string;
}

export interface IdentityService {
  ensureSession(request: Request, now?: number): Promise<EnsuredSession>;
  verifySession(request: Request, now?: number): Promise<DeviceSession>;
  verifyCsrf(request: Request, session: DeviceSession): Promise<void>;
  issueEmbedSession(
    actorId: string,
    boardId: string,
    expiresAt: number,
    now?: number,
  ): Promise<IssuedEmbedSession>;
}

export class HmacIdentityService implements IdentityService {
  readonly #currentKey: string;
  readonly #previousKey?: string;

  constructor(env: Pick<Env, "SESSION_SIGNING_KEY_CURRENT" | "SESSION_SIGNING_KEY_PREVIOUS">) {
    if (!env.SESSION_SIGNING_KEY_CURRENT) {
      throw new HttpError(500, "INTERNAL_ERROR", "Session signing is not configured.");
    }
    this.#currentKey = env.SESSION_SIGNING_KEY_CURRENT;
    this.#previousKey = env.SESSION_SIGNING_KEY_PREVIOUS || undefined;
  }

  async ensureSession(request: Request, now = Date.now()): Promise<EnsuredSession> {
    if (request.headers.has("authorization")) {
      const session = await this.verifySession(request, now);
      return { session, csrfToken: await this.createCsrfToken(session) };
    }
    try {
      const session = await this.verifySession(request, now);
      return { session, csrfToken: await this.createCsrfToken(session) };
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      const payload: SessionPayload = {
        v: 1,
        a: randomActorId(),
        i: now,
        e: now + SESSION_LIFETIME_MS,
      };
      const value = await this.signPayload(payload, this.#currentKey);
      const session: DeviceSession = {
        actorId: payload.a,
        issuedAt: payload.i,
        expiresAt: payload.e,
        keyVersion: "current",
      };
      return {
        session,
        csrfToken: await this.createCsrfToken(session),
        setCookie: serializeSessionCookie(value, payload.e),
      };
    }
  }

  async verifySession(request: Request, now = Date.now()): Promise<DeviceSession> {
    const authorization = request.headers.get("authorization");
    if (authorization !== null) return this.verifyEmbedAuthorization(authorization, now);

    const raw = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (raw === null) throw new HttpError(401, "AUTH_REQUIRED", "A device session is required.");
    const pieces = raw.split(".");
    if (pieces.length !== 3 || pieces[0] !== "v1") {
      throw new HttpError(401, "AUTH_REQUIRED", "The device session is invalid.");
    }
    const encodedPayload = pieces[1];
    const signature = pieces[2] === undefined ? null : base64UrlToBytes(pieces[2]);
    const payloadBytes = encodedPayload === undefined ? null : base64UrlToBytes(encodedPayload);
    if (signature === null || payloadBytes === null) {
      throw new HttpError(401, "AUTH_REQUIRED", "The device session is invalid.");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payloadBytes),
      );
    } catch {
      throw new HttpError(401, "AUTH_REQUIRED", "The device session is invalid.");
    }
    if (!isSessionPayload(payload)) {
      throw new HttpError(401, "AUTH_REQUIRED", "The device session is invalid.");
    }

    const signed = `v1.${encodedPayload}`;
    const currentExpected = await hmacSha256(this.#currentKey, signed);
    const currentMatches = constantTimeEqual(signature, currentExpected);
    let previousMatches = false;
    if (this.#previousKey !== undefined) {
      previousMatches = constantTimeEqual(signature, await hmacSha256(this.#previousKey, signed));
    }
    if (!currentMatches && !previousMatches) {
      throw new HttpError(401, "AUTH_REQUIRED", "The device session is invalid.");
    }
    if (payload.i > now + MAX_CLOCK_SKEW_MS || payload.e <= payload.i || payload.e <= now) {
      throw new HttpError(401, "AUTH_REQUIRED", "The device session has expired.");
    }
    if (payload.e - payload.i > SESSION_LIFETIME_MS + MAX_CLOCK_SKEW_MS) {
      throw new HttpError(401, "AUTH_REQUIRED", "The device session is invalid.");
    }
    return {
      actorId: payload.a,
      issuedAt: payload.i,
      expiresAt: payload.e,
      keyVersion: currentMatches ? "current" : "previous",
    };
  }

  async verifyCsrf(request: Request, session: DeviceSession): Promise<void> {
    if (session.boardId !== undefined) return;
    const supplied = request.headers.get(CSRF_HEADER);
    if (supplied === null || supplied.length > 128) {
      throw new HttpError(403, "FORBIDDEN", "The CSRF token is missing or invalid.");
    }
    const pieces = supplied.split(".");
    const signature =
      pieces.length === 2 && pieces[0] === "v1" ? base64UrlToBytes(pieces[1] ?? "") : null;
    if (signature === null) {
      throw new HttpError(403, "FORBIDDEN", "The CSRF token is missing or invalid.");
    }
    const input = csrfInput(session);
    const currentMatches = constantTimeEqual(signature, await hmacSha256(this.#currentKey, input));
    let previousMatches = false;
    if (this.#previousKey !== undefined) {
      previousMatches = constantTimeEqual(signature, await hmacSha256(this.#previousKey, input));
    }
    if (!currentMatches && !previousMatches) {
      throw new HttpError(403, "FORBIDDEN", "The CSRF token is missing or invalid.");
    }
  }

  async issueEmbedSession(
    actorId: string,
    boardId: string,
    expiresAt: number,
    now = Date.now(),
  ): Promise<IssuedEmbedSession> {
    if (!ACTOR_ID_PATTERN.test(actorId) || !BOARD_ID_PATTERN.test(boardId)) {
      throw new HttpError(500, "INTERNAL_ERROR", "The embed identity is invalid.");
    }
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt - now > EMBED_SESSION_LIFETIME_MS + MAX_CLOCK_SKEW_MS
    ) {
      throw new HttpError(401, "AUTH_REQUIRED", "The Space session has expired.");
    }
    const payload: EmbedSessionPayload = { v: 1, a: actorId, b: boardId, i: now, e: expiresAt };
    const token = await this.signPayloadWithPrefix(EMBED_SESSION_PREFIX, payload, this.#currentKey);
    return {
      token,
      session: {
        actorId,
        boardId,
        issuedAt: now,
        expiresAt,
        keyVersion: "current",
      },
    };
  }

  private async signPayload(payload: SessionPayload, secret: string): Promise<string> {
    return this.signPayloadWithPrefix("v1", payload, secret);
  }

  private async signPayloadWithPrefix(
    prefix: string,
    payload: SessionPayload | EmbedSessionPayload,
    secret: string,
  ): Promise<string> {
    const encoded = bytesToBase64Url(utf8(JSON.stringify(payload)));
    const signed = `${prefix}.${encoded}`;
    return `${signed}.${bytesToBase64Url(await hmacSha256(secret, signed))}`;
  }

  private async createCsrfToken(session: DeviceSession): Promise<string> {
    const key =
      session.keyVersion === "previous" && this.#previousKey ? this.#previousKey : this.#currentKey;
    return `v1.${bytesToBase64Url(await hmacSha256(key, csrfInput(session)))}`;
  }

  private async verifyEmbedAuthorization(
    authorization: string,
    now: number,
  ): Promise<DeviceSession & { boardId: string }> {
    if (authorization.length > 4_096 || !authorization.startsWith("Bearer ")) {
      throw invalidSession();
    }
    const raw = authorization.slice("Bearer ".length);
    if (raw.length === 0 || raw.includes(" ") || raw.includes("\t") || raw.includes(",")) {
      throw invalidSession();
    }
    const pieces = raw.split(".");
    if (pieces.length !== 3 || pieces[0] !== EMBED_SESSION_PREFIX) throw invalidSession();
    const encodedPayload = pieces[1];
    const signature = pieces[2] === undefined ? null : base64UrlToBytes(pieces[2]);
    const payloadBytes = encodedPayload === undefined ? null : base64UrlToBytes(encodedPayload);
    if (
      encodedPayload === undefined ||
      signature === null ||
      signature.byteLength !== 32 ||
      payloadBytes === null
    ) {
      throw invalidSession();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payloadBytes),
      );
    } catch {
      throw invalidSession();
    }
    if (!isEmbedSessionPayload(payload)) throw invalidSession();

    const signed = `${EMBED_SESSION_PREFIX}.${encodedPayload}`;
    const currentMatches = constantTimeEqual(signature, await hmacSha256(this.#currentKey, signed));
    let previousMatches = false;
    if (this.#previousKey !== undefined) {
      previousMatches = constantTimeEqual(signature, await hmacSha256(this.#previousKey, signed));
    }
    if (!currentMatches && !previousMatches) throw invalidSession();
    if (
      payload.i > now + MAX_CLOCK_SKEW_MS ||
      payload.e <= payload.i ||
      payload.e <= now ||
      payload.e - payload.i > EMBED_SESSION_LIFETIME_MS + MAX_CLOCK_SKEW_MS
    ) {
      throw invalidSession();
    }
    return {
      actorId: payload.a,
      boardId: payload.b,
      issuedAt: payload.i,
      expiresAt: payload.e,
      keyVersion: currentMatches ? "current" : "previous",
    };
  }
}

function csrfInput(session: DeviceSession): string {
  return session.boardId === undefined
    ? `csrf:v1:${session.actorId}:${session.issuedAt}:${session.expiresAt}`
    : "csrf:embed:v1:" +
        session.actorId +
        ":" +
        session.boardId +
        ":" +
        session.issuedAt +
        ":" +
        session.expiresAt;
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null || header.length > 8_192) return null;
  let found: string | null = null;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    const key = segment.slice(0, separator).trim();
    if (key !== name) continue;
    if (found !== null) return null;
    found = segment.slice(separator + 1).trim();
  }
  return found;
}

function serializeSessionCookie(value: string, expiresAt: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1_000)}; Secure; HttpOnly; SameSite=Lax`;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    Object.keys(object).length === 4 &&
    object.v === 1 &&
    typeof object.a === "string" &&
    ACTOR_ID_PATTERN.test(object.a) &&
    Number.isSafeInteger(object.i) &&
    Number.isSafeInteger(object.e)
  );
}

function isEmbedSessionPayload(value: unknown): value is EmbedSessionPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    Object.keys(object).length === 5 &&
    object.v === 1 &&
    typeof object.a === "string" &&
    ACTOR_ID_PATTERN.test(object.a) &&
    typeof object.b === "string" &&
    BOARD_ID_PATTERN.test(object.b) &&
    Number.isSafeInteger(object.i) &&
    Number.isSafeInteger(object.e)
  );
}

function invalidSession(): HttpError {
  return new HttpError(401, "AUTH_REQUIRED", "The Space session is invalid or expired.");
}

export const __identityTestUtils = {
  EMBED_SESSION_PREFIX,
  isEmbedSessionPayload,
  isSessionPayload,
  readCookie,
  serializeSessionCookie,
};
