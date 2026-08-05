import { BoardRoom } from "./board-room";
import { bytesToBase64Url, randomBoardId, randomToken, sha256 } from "./crypto";
import { assertExactKeys, readJsonBody } from "./http/body";
import { errorResponse, HttpError } from "./http/errors";
import {
  expectedOrigin,
  makeInternalRequest,
  requireSameOrigin,
  requireSecureTransport,
  stripInternalHeaders,
  withSecurityHeaders,
} from "./http/security";
import { HmacIdentityService } from "./identity";
import { safeLog } from "./logging";
import { runtimeTelemetryContext } from "./telemetry";
import { validateTurnstile } from "./turnstile";
import type { Env } from "./types";
import { optionalTitle, requireBoardId, requireDisplayName } from "./validation";
import { randomDisplayName } from "./validation-internal";

export { BoardRoom };

const BOARD_ROUTE = /^\/api\/v1\/boards\/(b_[A-Za-z0-9_-]{22})(?:\/|$)/u;
const MUTATING_METHODS = new Set(["POST", "PATCH", "DELETE", "PUT"]);
const MAX_GATEWAY_BUCKETS = 10_000;

type GatewayBucket = { tokens: number; updatedAt: number };
const gatewayBuckets = new Map<string, GatewayBucket>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
    const startedAt = performance.now();
    const requestBoardId = BOARD_ROUTE.exec(new URL(request.url).pathname)?.[1];
    const telemetry = await runtimeTelemetryContext(env, requestBoardId);
    let response: Response;
    let internalError = false;
    try {
      requireSecureTransport(request);
      response = await routeRequest(stripInternalHeaders(request), env, requestId);
    } catch (error) {
      const known = error instanceof HttpError;
      internalError = !known || error.code === "INTERNAL_ERROR";
      safeLog(known && error.status < 500 ? "warn" : "error", "http.request_failed", {
        ...telemetry,
        requestId,
        code: known ? error.code : "INTERNAL_ERROR",
        durationMs: Math.round(performance.now() - startedAt),
      });
      response = errorResponse(error, requestId);
    }
    const secured = withSecurityHeaders(response, requestId);
    if (new URL(request.url).pathname.startsWith("/api/")) {
      secured.headers.set("Cache-Control", "no-store");
    }
    safeLog("info", "http.request_completed", {
      ...telemetry,
      requestId,
      executionComponent: "gateway",
      status: secured.status,
      internalError,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return secured;
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return Response.json({
      ok: true,
      service: "cloudflare-collab-canvas-edge",
      versionId: env.WORKER_VERSION.id,
    });
  }

  if (url.pathname === "/api/v1/session") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    requireSameOrigin(request, env);
    const identity = new HmacIdentityService(env);
    const result = await identity.ensureSession(request);
    const headers = new Headers({ "Cache-Control": "no-store" });
    if (result.setCookie !== undefined) headers.append("Set-Cookie", result.setCookie);
    return Response.json(
      {
        actor: { id: result.session.actorId },
        csrfToken: result.csrfToken,
        sessionExpiresAt: result.session.expiresAt,
        turnstile: {
          enabled: env.TURNSTILE_ENABLED === "true",
          siteKey: env.TURNSTILE_SITE_KEY ?? null,
        },
      },
      { headers },
    );
  }

  if (url.pathname === "/api/v1/boards") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    requireSameOrigin(request, env);
    if (env.BOARD_CREATION_ENABLED !== "true") {
      throw new HttpError(
        503,
        "TEMPORARILY_UNAVAILABLE",
        "New board creation is temporarily unavailable.",
      );
    }
    const identity = new HmacIdentityService(env);
    const session = await identity.verifySession(request);
    await identity.verifyCsrf(request, session);
    const clientAddress = request.headers.get("cf-connecting-ip") ?? "local";
    enforceGatewayRateLimit(`create:ip:${clientAddress}`, 30, 1 / 5);
    enforceGatewayRateLimit(`create:actor:${session.actorId}`, 3, 1 / 60);
    const body = await readJsonBody(request, 16 * 1_024);
    assertExactKeys(body, ["title", "accessMode", "displayName", "turnstileToken"]);
    const title = optionalTitle(body.title);
    const accessMode = body.accessMode ?? "link_view";
    if (accessMode !== "private" && accessMode !== "link_view") {
      throw new HttpError(400, "BAD_REQUEST", "The board access mode is invalid.");
    }
    const displayName =
      body.displayName === undefined
        ? randomDisplayName(session.actorId, true)
        : requireDisplayName(body.displayName);
    await validateTurnstile(body.turnstileToken, env);

    const boardId = randomBoardId();
    const boardTelemetry = await runtimeTelemetryContext(env, boardId);
    const recoveryToken = randomToken(32);
    const recoveryHash = bytesToBase64Url(await sha256(recoveryToken));
    const stub = env.BOARD_ROOMS.getByName(boardId);
    const internalRequest = new Request(`${url.origin}/__internal/initialize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-whiteboard-internal-actor": session.actorId,
        "x-whiteboard-internal-session-expiry": String(session.expiresAt),
        "x-whiteboard-internal-request-id": requestId,
      },
      body: JSON.stringify({
        publicId: boardId,
        title,
        accessMode,
        ownerActorId: session.actorId,
        ownerDisplayName: displayName,
        ownerRecoveryHash: recoveryHash,
      }),
    });
    const initialized = await stub.fetch(internalRequest);
    if (!initialized.ok) {
      return initialized;
    }
    const origin = expectedOrigin(request, env);
    safeLog("info", "board.created", {
      ...boardTelemetry,
      requestId,
      result: "created",
    });
    return Response.json(
      {
        board: {
          id: boardId,
          url: `${origin}/b/${boardId}`,
          title,
          accessMode,
        },
        ownerRecoveryToken: recoveryToken,
        ownerRecoveryUrl: `${origin}/b/${boardId}#recovery=${recoveryToken}`,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  const boardMatch = BOARD_ROUTE.exec(url.pathname);
  if (boardMatch !== null) {
    const boardId = requireBoardId(boardMatch[1] ?? "");
    const identity = new HmacIdentityService(env);
    const session = await identity.verifySession(request);
    const isSocket = url.pathname.endsWith("/socket");
    if (MUTATING_METHODS.has(request.method) || isSocket) {
      requireSameOrigin(request, env);
    }
    if (MUTATING_METHODS.has(request.method)) {
      await identity.verifyCsrf(request, session);
    }
    let roomRequest = request;
    if (url.pathname.endsWith("/claims") && request.method === "POST") {
      const clientAddress = request.headers.get("cf-connecting-ip") ?? "local";
      enforceGatewayRateLimit(`claim:ip:${clientAddress}`, 5, 1 / 12);
      enforceGatewayRateLimit(`claim:actor:${session.actorId}`, 5, 1 / 12);
      const body = await readJsonBody(request.clone(), 8 * 1_024);
      assertExactKeys(
        body,
        ["type", "token", "displayName", "confirmOwnershipTransfer", "turnstileToken"],
        ["type", "token"],
      );
      if (body.type !== "invite" && body.type !== "recovery") {
        throw new HttpError(400, "BAD_REQUEST", "The claim type is invalid.");
      }
      if (typeof body.token !== "string" || body.token.length < 32 || body.token.length > 256) {
        throw new HttpError(400, "BAD_REQUEST", "The claim token is invalid.");
      }
      if (body.displayName !== undefined) requireDisplayName(body.displayName);
      if (
        body.confirmOwnershipTransfer !== undefined &&
        typeof body.confirmOwnershipTransfer !== "boolean"
      ) {
        throw new HttpError(400, "BAD_REQUEST", "The ownership confirmation is invalid.");
      }
      await validateTurnstile(
        body.turnstileToken,
        env,
        body.type === "invite" ? "invitation_claim" : "recovery_claim",
      );
      const { turnstileToken: _turnstileToken, ...forwardedBody } = body;
      roomRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(forwardedBody),
      });
    }
    const stub = env.BOARD_ROOMS.getByName(boardId);
    return stub.fetch(
      makeInternalRequest(roomRequest, session.actorId, session.expiresAt, requestId),
    );
  }

  if (url.pathname.startsWith("/api/")) {
    throw new HttpError(404, "NOT_FOUND", "The requested endpoint does not exist.");
  }

  return env.ASSETS.fetch(request);
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: { code: "METHOD_NOT_ALLOWED", message: "The method is not allowed." } },
    { status: 405, headers: { Allow: allow } },
  );
}

function enforceGatewayRateLimit(key: string, capacity: number, refillPerSecond: number): void {
  const now = Date.now();
  const existing = gatewayBuckets.get(key);
  const elapsedSeconds = existing === undefined ? 0 : Math.max(0, now - existing.updatedAt) / 1_000;
  const tokens = Math.min(
    capacity,
    (existing?.tokens ?? capacity) + elapsedSeconds * refillPerSecond,
  );
  if (tokens < 1) {
    gatewayBuckets.set(key, { tokens, updatedAt: now });
    throw new HttpError(429, "RATE_LIMITED", "Too many board requests. Try again shortly.");
  }
  gatewayBuckets.set(key, { tokens: tokens - 1, updatedAt: now });
  pruneGatewayBuckets(now);
}

function pruneGatewayBuckets(now: number): void {
  if (gatewayBuckets.size <= MAX_GATEWAY_BUCKETS) return;
  for (const [key, bucket] of gatewayBuckets) {
    if (now - bucket.updatedAt > 5 * 60 * 1_000) gatewayBuckets.delete(key);
  }
  while (gatewayBuckets.size > MAX_GATEWAY_BUCKETS) {
    const oldestKey = gatewayBuckets.keys().next().value;
    if (typeof oldestKey !== "string") break;
    gatewayBuckets.delete(oldestKey);
  }
}
