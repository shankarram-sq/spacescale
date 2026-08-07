import { BoardRoom } from "./board-room";
import { ClassroomAuthService, type VerifiedClassroomLaunch } from "./classroom-auth";
import { MAX_CLASSROOM_IMPORT_ENCODED_CHARS } from "./classroom-import";
import { bytesToBase64Url, randomBoardId, randomToken, sha256 } from "./crypto";
import { assertExactKeys, isRecord, readJsonBody } from "./http/body";
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
    const secured = withSecurityHeaders(response, request, env, requestId);
    if (
      new URL(request.url).pathname.startsWith("/api/") &&
      !secured.headers.get("cache-control")?.includes("no-store")
    ) {
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

  if (url.pathname === "/api/v1/embed/session") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    requireSameOrigin(request, env);
    const clientAddress = request.headers.get("cf-connecting-ip") ?? "local";
    enforceGatewayRateLimit(`embed:ip:${clientAddress}`, 120, 2);
    const body = await readJsonBody(request, MAX_CLASSROOM_IMPORT_ENCODED_CHARS + 16 * 1_024);
    assertExactKeys(body, ["token", "importSnapshot"], ["token"]);
    if (body.importSnapshot !== undefined && typeof body.importSnapshot !== "string") {
      throw new HttpError(400, "BAD_REQUEST", "The classroom import is invalid.");
    }
    if (
      typeof body.importSnapshot === "string" &&
      body.importSnapshot.length > MAX_CLASSROOM_IMPORT_ENCODED_CHARS
    ) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The classroom import is too large.");
    }

    const now = Date.now();
    const classroom = new ClassroomAuthService(env);
    const launch = await classroom.verifyLaunchToken(body.token, now);
    enforceGatewayRateLimit(`embed:actor:${launch.actorId}`, 10, 1 / 10);

    const stub = env.BOARD_ROOMS.getByName(launch.boardId);
    const internalLaunch = new Request(`${url.origin}/__internal/classroom-launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicId: launch.boardId,
        title: launch.boardName,
        role: launch.role,
        displayName: launch.displayName,
        launchIssuedAtMs: launch.issuedAtMs,
        placeholderOwnerActorId: launch.placeholderOwnerActorId,
        ownerRecoveryHash: launch.ownerRecoveryHash,
        ...(body.importSnapshot === undefined ? {} : { importSnapshot: body.importSnapshot }),
      }),
    });
    const launchResponse = await stub.fetch(
      makeInternalRequest(internalLaunch, launch.actorId, launch.expiresAtMs, requestId),
    );
    if (!launchResponse.ok) return launchResponse;
    const effective = parseClassroomLaunchResponse(await launchResponse.json(), launch);

    const identity = new HmacIdentityService(env);
    const issued = await identity.issueEmbedSession(
      launch.actorId,
      launch.boardId,
      launch.expiresAtMs,
      now,
    );
    const origin = expectedOrigin(request, env);
    return Response.json(
      {
        sessionToken: issued.token,
        sessionExpiresAt: issued.session.expiresAt,
        board: {
          ...effective.board,
          url: `${origin}/embed/b/${launch.boardId}`,
        },
        actor: effective.actor,
      },
      { headers: { "Cache-Control": "no-store" } },
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
    if (session.boardId !== undefined) {
      throw new HttpError(403, "FORBIDDEN", "The classroom session is board-scoped.");
    }
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
    const isSocket = url.pathname.endsWith("/socket");
    const socketAuth = isSocket
      ? authenticateWebSocketRequest(request)
      : { request, negotiatedProtocol: false };
    const routedRequest = socketAuth.request;
    const identity = new HmacIdentityService(env);
    const session = await identity.verifySession(routedRequest);
    if (session.boardId !== undefined && session.boardId !== boardId) {
      throw new HttpError(403, "FORBIDDEN", "The classroom session is not valid for this board.");
    }
    if (MUTATING_METHODS.has(routedRequest.method) || isSocket) {
      requireSameOrigin(routedRequest, env);
    }
    if (MUTATING_METHODS.has(routedRequest.method)) {
      await identity.verifyCsrf(routedRequest, session);
    }
    let roomRequest = routedRequest;
    if (url.pathname.endsWith("/claims") && routedRequest.method === "POST") {
      const clientAddress = routedRequest.headers.get("cf-connecting-ip") ?? "local";
      enforceGatewayRateLimit(`claim:ip:${clientAddress}`, 5, 1 / 12);
      enforceGatewayRateLimit(`claim:actor:${session.actorId}`, 5, 1 / 12);
      const body = await readJsonBody(routedRequest.clone(), 8 * 1_024);
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
      roomRequest = new Request(routedRequest.url, {
        method: routedRequest.method,
        headers: routedRequest.headers,
        body: JSON.stringify(forwardedBody),
      });
    }
    const stub = env.BOARD_ROOMS.getByName(boardId);
    const roomResponse = await stub.fetch(
      makeInternalRequest(roomRequest, session.actorId, session.expiresAt, requestId),
    );
    return socketAuth.negotiatedProtocol && roomResponse.status === 101
      ? selectWebSocketProtocol(roomResponse)
      : roomResponse;
  }

  if (url.pathname.startsWith("/api/")) {
    throw new HttpError(404, "NOT_FOUND", "The requested endpoint does not exist.");
  }

  return env.ASSETS.fetch(request);
}

type ClassroomLaunchResponse = {
  board: {
    id: string;
    title: string;
    accessMode: "private" | "link_view";
    drawingPolicy: "editors_enabled" | "owner_only" | "locked";
    imagesEnabled: boolean;
    aclVersion: number;
  };
  actor: {
    id: string;
    role: "owner" | "editor" | "viewer";
    displayName: string;
  };
};

function parseClassroomLaunchResponse(
  value: unknown,
  launch: VerifiedClassroomLaunch,
): ClassroomLaunchResponse {
  if (!isRecord(value) || !isRecord(value.board) || !isRecord(value.actor)) {
    throw new HttpError(500, "INTERNAL_ERROR", "The classroom room response is invalid.");
  }
  const board = value.board;
  const actor = value.actor;
  if (
    board.id !== launch.boardId ||
    typeof board.title !== "string" ||
    (board.accessMode !== "private" && board.accessMode !== "link_view") ||
    (board.drawingPolicy !== "editors_enabled" &&
      board.drawingPolicy !== "owner_only" &&
      board.drawingPolicy !== "locked") ||
    typeof board.imagesEnabled !== "boolean" ||
    !Number.isSafeInteger(board.aclVersion) ||
    (board.aclVersion as number) < 1 ||
    actor.id !== launch.actorId ||
    (actor.role !== "owner" && actor.role !== "editor" && actor.role !== "viewer") ||
    typeof actor.displayName !== "string"
  ) {
    throw new HttpError(500, "INTERNAL_ERROR", "The classroom room response is invalid.");
  }
  const title = optionalTitle(board.title);
  const displayName = requireDisplayName(actor.displayName);
  return {
    board: {
      id: launch.boardId,
      title,
      accessMode: board.accessMode,
      drawingPolicy: board.drawingPolicy,
      imagesEnabled: board.imagesEnabled,
      aclVersion: board.aclVersion as number,
    },
    actor: { id: launch.actorId, role: actor.role, displayName },
  };
}

function authenticateWebSocketRequest(request: Request): {
  request: Request;
  negotiatedProtocol: boolean;
} {
  const rawProtocols = request.headers.get("sec-websocket-protocol");
  if (rawProtocols === null || !rawProtocols.includes("auth.")) {
    return { request, negotiatedProtocol: false };
  }
  if (rawProtocols.length > 8_192 || request.headers.has("authorization")) {
    throw new HttpError(400, "BAD_REQUEST", "The WebSocket authentication is invalid.");
  }
  const protocols = rawProtocols.split(",").map((value) => value.trim());
  const authProtocols = protocols.filter((value) => value.startsWith("auth."));
  if (
    protocols.length !== 2 ||
    authProtocols.length !== 1 ||
    protocols.filter((value) => value === "whiteboard.v1").length !== 1
  ) {
    throw new HttpError(400, "BAD_REQUEST", "The WebSocket authentication is invalid.");
  }
  const token = authProtocols[0]?.slice("auth.".length) ?? "";
  if (token.length === 0 || token.length > 4_096 || /[^A-Za-z0-9._-]/u.test(token)) {
    throw new HttpError(400, "BAD_REQUEST", "The WebSocket authentication is invalid.");
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("sec-websocket-protocol", "whiteboard.v1");
  return { request: new Request(request, { headers }), negotiatedProtocol: true };
}

function selectWebSocketProtocol(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Sec-WebSocket-Protocol", "whiteboard.v1");
  const init: ResponseInit & { webSocket?: WebSocket } = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  if (socket !== undefined && socket !== null) init.webSocket = socket;
  return new Response(response.body, init);
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
