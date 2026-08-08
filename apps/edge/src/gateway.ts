import {
  BOARD_FEATURE_KEYS,
  type BoardFeatures,
  DEFAULT_BOARD_FEATURES,
  normalizeBoardFeatures,
} from "@collab/protocol";
import { BoardRoom } from "./board-room";
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
import { OrganisationAuthService, type VerifiedOrganisationLaunch } from "./organisation-auth";
import {
  MAX_ORGANISATION_TEMPLATE_BYTES,
  normalizeOrganisationWebhookUrl,
  OrganisationRoom,
} from "./organisation-room";
import { runtimeTelemetryContext } from "./telemetry";
import { turnstileRequiredForRequest, validateTurnstile } from "./turnstile";
import type { Env } from "./types";
import { optionalTitle, requireBoardId, requireDisplayName } from "./validation";
import { randomDisplayName } from "./validation-internal";

export { BoardRoom, OrganisationRoom };

const BOARD_ROUTE = /^\/api\/v1\/boards\/(b_[A-Za-z0-9_-]{22})(?:\/|$)/u;
const VIEWER_ASSET_ROUTE = /^\/api\/v1\/viewer\/assets\/(asset_[A-Za-z0-9_-]{43})$/u;
const VIEWER_ASSET_TOKEN_HEADER = "X-SpaceScale-Viewer-Asset-Token";
const VIEWER_ASSET_EXPIRY_HEADER = "X-SpaceScale-Viewer-Asset-Expires";
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
      response = await routeRequest(
        stripInternalHeaders(request),
        env,
        requestId,
        turnstileRequiredForRequest(request, env),
      );
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

async function routeRequest(
  request: Request,
  env: Env,
  requestId: string,
  turnstileRequired: boolean,
): Promise<Response> {
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
          required: turnstileRequired,
          siteKey: env.TURNSTILE_SITE_KEY ?? null,
        },
      },
      { headers },
    );
  }

  const viewerAsset = VIEWER_ASSET_ROUTE.exec(url.pathname);
  if (viewerAsset !== null) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const assetId = viewerAsset[1];
    if (assetId === undefined) {
      throw new HttpError(404, "NOT_FOUND", "Image asset not found.");
    }
    const identity = new HmacIdentityService(env);
    const session = await identity.verifyViewerAssetSession(request);
    const clientAddress = request.headers.get("cf-connecting-ip") ?? "local";
    enforceGatewayRateLimit(`viewer-asset:ip:${clientAddress}`, 240, 4);
    enforceGatewayRateLimit(`viewer-asset:actor:${session.actorId}`, 240, 4);
    const internal = new Request(
      `${url.origin}/__internal/organisation-assets/${assetId}?organisationId=${encodeURIComponent(session.organisationId)}`,
      { method: "GET", headers: { Accept: "image/*" } },
    );
    return env.BOARD_ROOMS.getByName(session.boardId).fetch(
      makeInternalRequest(internal, session.actorId, session.expiresAt, requestId),
    );
  }

  if (url.pathname === "/api/v1/viewer/session") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    requireSameOrigin(request, env);
    const body = await readJsonBody(request, 12 * 1_024);
    assertExactKeys(body, ["token"], ["token"]);
    const now = Date.now();
    const launch = await new OrganisationAuthService(env).verifyLaunchToken(body.token, now);
    const clientAddress = request.headers.get("cf-connecting-ip") ?? "local";
    enforceGatewayRateLimit(`viewer:ip:${clientAddress}`, 120, 2);
    enforceGatewayRateLimit(`viewer:actor:${launch.actorId}`, 60, 1);
    const internal = new Request(`${url.origin}/__internal/organisation-export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organisationId: launch.organisationId,
        format: "canonical",
      }),
    });
    const exportResponse = await env.BOARD_ROOMS.getByName(launch.boardId).fetch(
      makeInternalRequest(internal, launch.actorId, launch.expiresAtMs, requestId),
    );
    if (!exportResponse.ok) return exportResponse;
    const viewerAssetSession = await new HmacIdentityService(env).issueViewerAssetSession(
      launch.actorId,
      launch.boardId,
      launch.organisationId,
      launch.expiresAtMs,
      now,
    );
    const headers = new Headers(exportResponse.headers);
    headers.set(VIEWER_ASSET_TOKEN_HEADER, viewerAssetSession.token);
    headers.set(VIEWER_ASSET_EXPIRY_HEADER, String(viewerAssetSession.session.expiresAt));
    return new Response(exportResponse.body, {
      status: exportResponse.status,
      statusText: exportResponse.statusText,
      headers,
    });
  }

  if (
    url.pathname === "/api/v1/organisation-admin/session" ||
    url.pathname === "/api/v1/organisation-admin/webhook"
  ) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    requireSameOrigin(request, env);
    const body = await readJsonBody(request, 16 * 1_024);
    const updatingWebhook = url.pathname.endsWith("/webhook");
    assertExactKeys(
      body,
      updatingWebhook ? ["token", "webhookUrl"] : ["token"],
      updatingWebhook ? ["token", "webhookUrl"] : ["token"],
    );
    const organisationAuth = new OrganisationAuthService(env);
    const launch = await organisationAuth.verifyLaunchToken(body.token);
    if (launch.role !== "owner") {
      throw new HttpError(403, "FORBIDDEN", "An Organisation owner assertion is required.");
    }
    enforceGatewayRateLimit(`organisation-admin:${launch.organisationId}`, 120, 2);
    const organisationRoom = env.ORGANISATION_ROOMS.getByName(launch.organisationId);
    const baseInternalUrl = `${url.origin}/__internal/organisations/${launch.organisationId}`;
    if (updatingWebhook) {
      const webhookUrl = normalizeOrganisationWebhookUrl(body.webhookUrl);
      const updated = await organisationRoom.fetch(
        new Request(`${baseInternalUrl}/settings`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-whiteboard-internal-request-id": requestId,
          },
          body: JSON.stringify({ webhookUrl, updatedBy: launch.actorId }),
        }),
      );
      if (!updated.ok) return updated;
    }
    const adminResponse = await organisationRoom.fetch(
      new Request(`${baseInternalUrl}/admin`, {
        method: "GET",
        headers: { "x-whiteboard-internal-request-id": requestId },
      }),
    );
    if (!adminResponse.ok) return adminResponse;
    const snapshot = await parseOrganisationAdminSnapshot(
      await adminResponse.json(),
      launch,
      organisationAuth,
      expectedOrigin(request, env),
    );
    return Response.json(updatingWebhook ? snapshot.settings : snapshot);
  }

  if (url.pathname === "/api/v1/embed/session") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    requireSameOrigin(request, env);
    const clientAddress = request.headers.get("cf-connecting-ip") ?? "local";
    enforceGatewayRateLimit(`embed:ip:${clientAddress}`, 120, 2);
    const body = await readJsonBody(request, MAX_CLASSROOM_IMPORT_ENCODED_CHARS + 16 * 1_024);
    assertExactKeys(body, ["token", "importSnapshot"], ["token"]);
    if (body.importSnapshot !== undefined && typeof body.importSnapshot !== "string") {
      throw new HttpError(400, "BAD_REQUEST", "The Space import is invalid.");
    }
    if (
      typeof body.importSnapshot === "string" &&
      body.importSnapshot.length > MAX_CLASSROOM_IMPORT_ENCODED_CHARS
    ) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The Space import is too large.");
    }

    const now = Date.now();
    const organisationAuth = new OrganisationAuthService(env);
    const launch = await organisationAuth.verifyLaunchToken(body.token, now);
    enforceGatewayRateLimit(`embed:actor:${launch.actorId}`, 10, 1 / 10);

    const stub = env.BOARD_ROOMS.getByName(launch.boardId);
    const internalLaunch = new Request(`${url.origin}/__internal/organisation-launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicId: launch.boardId,
        organisationId: launch.organisationId,
        spaceId: launch.spaceId,
        title: launch.spaceTitle,
        role: launch.role,
        displayName: launch.displayName,
        participantId: launch.participantId,
        launchIssuedAtMs: launch.issuedAtMs,
        placeholderOwnerActorId: launch.placeholderOwnerActorId,
        ownerRecoveryHash: launch.ownerRecoveryHash,
        features: launch.features,
        ...(body.importSnapshot === undefined ? {} : { importSnapshot: body.importSnapshot }),
      }),
    });
    const launchResponse = await stub.fetch(
      makeInternalRequest(internalLaunch, launch.actorId, launch.expiresAtMs, requestId),
    );
    if (!launchResponse.ok) return launchResponse;
    const effective = parseOrganisationLaunchResponse(await launchResponse.json(), launch);

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

  const organisationApi = matchOrganisationApiRoute(url.pathname);
  if (organisationApi !== null) {
    const launch = await authenticateOrganisationOwnerApiRequest(request, env);
    if (launch.role !== "owner") {
      throw new HttpError(403, "FORBIDDEN", "An organisation owner assertion is required.");
    }
    if (launch.organisationKey !== organisationApi.organisationKey) throw boardNotFoundError();
    enforceGatewayRateLimit(`organisation-api:${launch.organisationId}`, 120, 2);

    if (organisationApi.kind === "export") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      if (launch.boardId !== organisationApi.boardId) throw boardNotFoundError();
      const internal = new Request(`${url.origin}/__internal/organisation-export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organisationId: launch.organisationId,
          format: organisationApi.format,
        }),
      });
      return env.BOARD_ROOMS.getByName(organisationApi.boardId).fetch(
        makeInternalRequest(internal, launch.actorId, launch.expiresAtMs, requestId),
      );
    }

    const organisationRoom = env.ORGANISATION_ROOMS.getByName(launch.organisationId);
    const internalBase = `${url.origin}/__internal/organisations/${launch.organisationId}`;
    if (organisationApi.kind === "templates") {
      const internalUrl = `${internalBase}/templates`;
      if (request.method === "GET") {
        const response = await organisationRoom.fetch(
          new Request(internalUrl, {
            method: "GET",
            headers: { "x-whiteboard-internal-request-id": requestId },
          }),
        );
        if (!response.ok) return response;
        const templates: unknown = await response.json();
        if (!Array.isArray(templates)) {
          throw new HttpError(
            500,
            "INTERNAL_ERROR",
            "The organisation template response is invalid.",
          );
        }
        return Response.json({ organisationId: launch.organisationId, templates });
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request, MAX_ORGANISATION_TEMPLATE_BYTES + 32 * 1_024);
        assertExactKeys(body, ["name", "description", "items"], ["name", "items"]);
        return organisationRoom.fetch(
          new Request(internalUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-whiteboard-internal-request-id": requestId,
            },
            body: JSON.stringify({ ...body, createdBy: launch.actorId }),
          }),
        );
      }
      return methodNotAllowed("GET, POST");
    }
    if (organisationApi.kind === "template") {
      const internalUrl = `${internalBase}/templates/${organisationApi.templateId}`;
      if (request.method === "PATCH") {
        const body = await readJsonBody(request, MAX_ORGANISATION_TEMPLATE_BYTES + 32 * 1_024);
        assertExactKeys(body, ["name", "description", "items"]);
        if (Object.keys(body).length === 0) {
          throw new HttpError(400, "BAD_REQUEST", "At least one template field is required.");
        }
        return organisationRoom.fetch(
          new Request(internalUrl, {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-whiteboard-internal-request-id": requestId,
            },
            body: JSON.stringify(body),
          }),
        );
      }
      if (request.method === "DELETE") {
        return organisationRoom.fetch(
          new Request(internalUrl, {
            method: "DELETE",
            headers: { "x-whiteboard-internal-request-id": requestId },
          }),
        );
      }
      return methodNotAllowed("PATCH, DELETE");
    }

    const internalUrl = `${internalBase}/settings`;
    if (request.method === "GET") {
      const response = await organisationRoom.fetch(
        new Request(internalUrl, {
          method: "GET",
          headers: { "x-whiteboard-internal-request-id": requestId },
        }),
      );
      if (!response.ok) return response;
      return Response.json({
        organisationId: launch.organisationId,
        ...parseOrganisationSettingsResponse(await response.json()),
      });
    }
    if (request.method === "PUT") {
      const body = await readJsonBody(request, 8 * 1_024);
      assertExactKeys(body, ["webhookUrl"], ["webhookUrl"]);
      const webhookUrl = normalizeOrganisationWebhookUrl(body.webhookUrl);
      const response = await organisationRoom.fetch(
        new Request(internalUrl, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-whiteboard-internal-request-id": requestId,
          },
          body: JSON.stringify({ webhookUrl, updatedBy: launch.actorId }),
        }),
      );
      if (!response.ok) return response;
      return Response.json({
        organisationId: launch.organisationId,
        ...parseOrganisationSettingsResponse(await response.json()),
      });
    }
    return methodNotAllowed("GET, PUT");
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
      throw new HttpError(403, "FORBIDDEN", "The embed session is Space-scoped.");
    }
    await identity.verifyCsrf(request, session);
    const clientAddress = request.headers.get("cf-connecting-ip") ?? "local";
    enforceGatewayRateLimit(`create:ip:${clientAddress}`, 30, 1 / 5);
    enforceGatewayRateLimit(`create:actor:${session.actorId}`, 3, 1 / 60);
    const body = await readJsonBody(request, 16 * 1_024);
    assertExactKeys(body, ["title", "accessMode", "displayName", "turnstileToken", "features"]);
    const title = optionalTitle(body.title);
    const accessMode = body.accessMode ?? "link_view";
    if (accessMode !== "private" && accessMode !== "link_view") {
      throw new HttpError(400, "BAD_REQUEST", "The board access mode is invalid.");
    }
    const displayName =
      body.displayName === undefined
        ? randomDisplayName(session.actorId, true)
        : requireDisplayName(body.displayName);
    const features = initialBoardFeatures(body.features);
    await validateTurnstile(body.turnstileToken, env, "board_create", turnstileRequired);

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
        features,
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
          features,
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
      throw new HttpError(403, "FORBIDDEN", "The embed session is not valid for this Space.");
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
        turnstileRequired,
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

type OrganisationAdminSnapshot = {
  organisation: { id: string; name: string };
  settings: {
    webhookUrl: string | null;
    details: Array<{
      key: string;
      label: string;
      value: string | number | boolean | null;
      description?: string;
    }>;
  };
  boards: Array<{
    id: string;
    name: string;
    owners: Array<{ displayName: string; identifierHash: string }>;
    participants: Array<{ displayName: string; identifierHash: string }>;
    viewerUrl: string;
  }>;
};

async function parseOrganisationAdminSnapshot(
  value: unknown,
  launch: VerifiedOrganisationLaunch,
  organisationAuth: OrganisationAuthService,
  origin: string,
): Promise<OrganisationAdminSnapshot> {
  if (
    !isRecord(value) ||
    !isRecord(value.settings) ||
    (value.settings.webhookUrl !== null && typeof value.settings.webhookUrl !== "string") ||
    !Number.isSafeInteger(value.templateCount) ||
    (value.templateCount as number) < 0 ||
    !Array.isArray(value.boards)
  ) {
    throw new HttpError(500, "INTERNAL_ERROR", "The Organisation admin response is invalid.");
  }

  const boards = await Promise.all(
    value.boards.map(async (raw) => {
      if (
        !isRecord(raw) ||
        typeof raw.boardId !== "string" ||
        typeof raw.spaceId !== "string" ||
        typeof raw.title !== "string" ||
        typeof raw.archived !== "boolean"
      ) {
        throw new HttpError(500, "INTERNAL_ERROR", "The Organisation Space response is invalid.");
      }
      const boardId = requireBoardId(raw.boardId);
      const owners = parseOrganisationAdminPeople(raw.owners);
      const participants = parseOrganisationAdminPeople(raw.participants);
      const viewer = await organisationAuth.issueViewerLaunchToken(
        launch.organisationKey,
        raw.spaceId,
        boardId,
      );
      return {
        id: boardId,
        name: raw.archived ? `${raw.title} (archived)` : raw.title,
        owners,
        participants,
        viewerUrl: `${origin}/viewer#launch=${encodeURIComponent(viewer.token)}`,
      };
    }),
  );

  return {
    organisation: {
      id: launch.organisationId,
      name: launch.organisationKey,
    },
    settings: {
      webhookUrl: value.settings.webhookUrl,
      details: [
        {
          key: "organisationId",
          label: "Organisation ID",
          value: launch.organisationId,
          description: "Stable SpaceScale identifier for this Organisation.",
        },
        { key: "spaceCount", label: "Spaces", value: boards.length },
        { key: "templateCount", label: "Templates", value: value.templateCount as number },
        {
          key: "viewerValidity",
          label: "View-only links",
          value: "12 hours",
          description: "Links are signed and do not grant editing access.",
        },
      ],
    },
    boards,
  };
}

function parseOrganisationAdminPeople(
  value: unknown,
): Array<{ displayName: string; identifierHash: string }> {
  if (!Array.isArray(value)) {
    throw new HttpError(500, "INTERNAL_ERROR", "The Organisation member response is invalid.");
  }
  return value.map((person) => {
    if (
      !isRecord(person) ||
      typeof person.displayName !== "string" ||
      typeof person.identifierHash !== "string"
    ) {
      throw new HttpError(500, "INTERNAL_ERROR", "The Organisation member response is invalid.");
    }
    return {
      displayName: person.displayName,
      identifierHash: person.identifierHash,
    };
  });
}

type OrganisationLaunchResponse = {
  board: {
    id: string;
    title: string;
    accessMode: "private" | "link_view";
    drawingPolicy: "editors_enabled" | "owner_only" | "locked";
    imagesEnabled: boolean;
    features: BoardFeatures;
    aclVersion: number;
  };
  actor: {
    id: string;
    role: "owner" | "editor" | "viewer";
    displayName: string;
  };
};

function parseOrganisationLaunchResponse(
  value: unknown,
  launch: VerifiedOrganisationLaunch,
): OrganisationLaunchResponse {
  if (!isRecord(value) || !isRecord(value.board) || !isRecord(value.actor)) {
    throw new HttpError(500, "INTERNAL_ERROR", "The Space response is invalid.");
  }
  const board = value.board;
  const actor = value.actor;
  const features = responseBoardFeatures(board.features);
  if (
    board.id !== launch.boardId ||
    typeof board.title !== "string" ||
    (board.accessMode !== "private" && board.accessMode !== "link_view") ||
    (board.drawingPolicy !== "editors_enabled" &&
      board.drawingPolicy !== "owner_only" &&
      board.drawingPolicy !== "locked") ||
    typeof board.imagesEnabled !== "boolean" ||
    board.imagesEnabled !== features.images ||
    !Number.isSafeInteger(board.aclVersion) ||
    (board.aclVersion as number) < 1 ||
    actor.id !== launch.actorId ||
    (actor.role !== "owner" && actor.role !== "editor" && actor.role !== "viewer") ||
    typeof actor.displayName !== "string"
  ) {
    throw new HttpError(500, "INTERNAL_ERROR", "The Space response is invalid.");
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
      features,
      aclVersion: board.aclVersion as number,
    },
    actor: { id: launch.actorId, role: actor.role, displayName },
  };
}

function initialBoardFeatures(value: unknown): BoardFeatures {
  if (value === undefined) return { ...DEFAULT_BOARD_FEATURES };
  if (!isRecord(value)) {
    throw new HttpError(400, "BAD_REQUEST", "The board feature settings are invalid.");
  }
  const allowed = new Set<string>(BOARD_FEATURE_KEYS);
  const patch: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (!allowed.has(key) || typeof enabled !== "boolean") {
      throw new HttpError(400, "BAD_REQUEST", "The board feature settings are invalid.");
    }
    patch[key] = enabled;
  }
  try {
    return normalizeBoardFeatures({ ...DEFAULT_BOARD_FEATURES, ...patch });
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "The board feature settings are invalid.");
  }
}

function responseBoardFeatures(value: unknown): BoardFeatures {
  try {
    return normalizeBoardFeatures(value);
  } catch {
    throw new HttpError(500, "INTERNAL_ERROR", "The Space response is invalid.");
  }
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

type OrganisationApiRoute =
  | {
      kind: "export";
      organisationKey: string;
      boardId: string;
      format: "canonical" | "attributed";
    }
  | { kind: "webhook-settings"; organisationKey: string }
  | { kind: "templates"; organisationKey: string }
  | { kind: "template"; organisationKey: string; templateId: string };

function matchOrganisationApiRoute(pathname: string): OrganisationApiRoute | null {
  const templateMatch =
    /^\/api\/v1\/organisations\/([^/]{1,720})\/templates(?:\/(tpl_[A-Za-z0-9_-]{22}))?$/u.exec(
      pathname,
    );
  if (templateMatch !== null) {
    const organisationKey = decodeOrganisationKey(templateMatch[1]);
    const templateId = templateMatch[2];
    return templateId === undefined
      ? { kind: "templates", organisationKey }
      : { kind: "template", organisationKey, templateId };
  }

  const match =
    /^\/api\/v1\/organisations\/([^/]{1,720})(?:\/boards\/(b_[A-Za-z0-9_-]{22})\/(export(?:\.attributed)?\.json)|\/webhook)$/u.exec(
      pathname,
    );
  if (match === null) return null;
  const organisationKey = decodeOrganisationKey(match[1]);
  const boardId = match[2];
  const exportName = match[3];
  if (boardId !== undefined && exportName !== undefined) {
    return {
      kind: "export",
      organisationKey,
      boardId: requireBoardId(boardId),
      format: exportName === "export.attributed.json" ? "attributed" : "canonical",
    };
  }
  return { kind: "webhook-settings", organisationKey };
}

function decodeOrganisationKey(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    throw new HttpError(404, "NOT_FOUND", "The requested endpoint does not exist.");
  }
}

async function authenticateOrganisationOwnerApiRequest(
  request: Request,
  env: Env,
): Promise<VerifiedOrganisationLaunch> {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer ([A-Za-z0-9._-]{10,8192})$/u.exec(authorization ?? "");
  if (match === null) {
    throw new HttpError(401, "AUTH_REQUIRED", "A signed organisation assertion is required.");
  }
  const launch = await new OrganisationAuthService(env).verifyLaunchToken(match[1]);
  if (launch.role !== "owner") {
    throw new HttpError(403, "FORBIDDEN", "An organisation owner assertion is required.");
  }
  return launch;
}

function boardNotFoundError(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Board not found.");
}

function parseOrganisationSettingsResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HttpError(500, "INTERNAL_ERROR", "The organisation settings response is invalid.");
  }
  return value;
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
