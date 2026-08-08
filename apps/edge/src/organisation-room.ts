import { DurableObject } from "cloudflare:workers";
import {
  type BoardFeatures,
  normalizeBoardFeatures,
  type BoardItem as ProtocolBoardItem,
  ProtocolValidationError,
  validatePlainText,
} from "@collab/protocol";
import { randomOpaqueId } from "./crypto";
import { BoardDomainError, canonicalItemFromUnknown } from "./domain";
import { assertExactKeys, isRecord, readJsonBody } from "./http/body";
import { errorResponse, HttpError } from "./http/errors";
import { applyOrganisationMigrations } from "./migrations";
import type { BoardItem, Env } from "./types";
import { ACTOR_ID_PATTERN } from "./validation";
import { assertOrganisationWebhookOriginAllowed } from "./webhook-delivery";

export const ORGANISATION_ID_PATTERN = /^o_[A-Za-z0-9_-]{22}$/u;
export const TEMPLATE_ID_PATTERN = /^tpl_[A-Za-z0-9_-]{22}$/u;
export const MAX_ORGANISATION_TEMPLATES = 100;
export const MAX_ORGANISATION_TEMPLATE_ITEMS = 100;
export const MAX_ORGANISATION_TEMPLATE_BYTES = 512 * 1_024;
export const MAX_ORGANISATION_TEMPLATE_TOTAL_BYTES = 5 * 1_024 * 1_024;

const MAX_TEMPLATE_NAME_CODE_POINTS = 100;
const MAX_TEMPLATE_DESCRIPTION_CODE_POINTS = 500;
const TEMPLATE_COLLECTION_PATH = /^\/__internal\/organisations\/(o_[A-Za-z0-9_-]{22})\/templates$/u;
const TEMPLATE_ITEM_PATH =
  /^\/__internal\/organisations\/(o_[A-Za-z0-9_-]{22})\/templates\/(tpl_[A-Za-z0-9_-]{22})$/u;
const SETTINGS_PATH = /^\/__internal\/organisations\/(o_[A-Za-z0-9_-]{22})\/settings$/u;
const ADMIN_PATH = /^\/__internal\/organisations\/(o_[A-Za-z0-9_-]{22})\/admin$/u;
const SPACE_PATH =
  /^\/__internal\/organisations\/(o_[A-Za-z0-9_-]{22})\/spaces\/(b_[A-Za-z0-9_-]{22})$/u;
const BOARD_ID_PATTERN = /^b_[A-Za-z0-9_-]{22}$/u;
const MAX_SPACE_SUMMARY_BYTES = 64 * 1_024;
const MAX_WEBHOOK_URL_BYTES = 2_048;

export type OrganisationTemplate = {
  id: string;
  name: string;
  description: string | null;
  items: BoardItem[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type OrganisationWebhookSettings = {
  webhookUrl: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
};
export type OrganisationAdminMember = {
  id: string;
  displayName: string;
  role: "owner" | "editor" | "viewer";
  identifierHash: string;
};

export type OrganisationAdminBoardSettings = {
  accessMode: "private" | "link_view";
  drawingPolicy: "editors_enabled" | "owner_only" | "locked";
  features: BoardFeatures;
  aclVersion: number;
};

export type OrganisationAdminSpace = {
  boardId: string;
  spaceId: string;
  title: string;
  archived: boolean;
  owners: OrganisationAdminMember[];
  participants: OrganisationAdminMember[];
  settings: OrganisationAdminBoardSettings;
  updatedAt: number;
};

type SpaceRow = {
  [key: string]: SqlStorageValue;
  board_id: string;
  space_id: string;
  title: string;
  archived: number;
  members_json: string;
  settings_json: string;
  updated_at_ms: number;
};

type TemplateRow = {
  [key: string]: SqlStorageValue;
  template_id: string;
  name: string;
  description: string | null;
  items_json: string;
  byte_count: number;
  created_by: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export class OrganisationRoom extends DurableObject<Env> {
  readonly #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => {
      applyOrganisationMigrations(ctx.storage);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const requestId =
      request.headers.get("x-whiteboard-internal-request-id") || crypto.randomUUID();
    try {
      return await this.route(request);
    } catch (error) {
      return errorResponse(mapOrganisationRoomError(error), requestId);
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const settingsMatch = SETTINGS_PATH.exec(url.pathname);
    if (settingsMatch !== null) {
      const organisationId = requireOrganisationId(settingsMatch[1]);
      this.bindOrganisation(organisationId);
      if (request.method === "GET") return Response.json(this.readWebhookSettings());
      if (request.method === "PATCH") return this.patchWebhookSettings(request);
      return methodNotAllowed("GET, PATCH");
    }

    const adminMatch = ADMIN_PATH.exec(url.pathname);
    if (adminMatch !== null) {
      const organisationId = requireOrganisationId(adminMatch[1]);
      this.bindOrganisation(organisationId);
      if (request.method === "GET") return Response.json(this.readAdminSummary());
      return methodNotAllowed("GET");
    }

    const spaceMatch = SPACE_PATH.exec(url.pathname);
    if (spaceMatch !== null) {
      const organisationId = requireOrganisationId(spaceMatch[1]);
      const boardId = requireBoardId(spaceMatch[2]);
      this.bindOrganisation(organisationId);
      if (request.method === "PUT") return this.upsertSpaceSummary(request, boardId);
      return methodNotAllowed("PUT");
    }

    const collectionMatch = TEMPLATE_COLLECTION_PATH.exec(url.pathname);
    if (collectionMatch !== null) {
      const organisationId = requireOrganisationId(collectionMatch[1]);
      this.bindOrganisation(organisationId);
      if (request.method === "GET") return Response.json(this.listTemplates());
      if (request.method === "POST") return this.createTemplate(request);
      return methodNotAllowed("GET, POST");
    }

    const itemMatch = TEMPLATE_ITEM_PATH.exec(url.pathname);
    if (itemMatch !== null) {
      const organisationId = requireOrganisationId(itemMatch[1]);
      const templateId = requireTemplateId(itemMatch[2]);
      this.bindOrganisation(organisationId);
      if (request.method === "DELETE") return this.deleteTemplate(templateId);
      return methodNotAllowed("DELETE");
    }
    throw new HttpError(404, "NOT_FOUND", "The requested endpoint does not exist.");
  }

  private readWebhookSettings(): OrganisationWebhookSettings {
    const row = this.#sql
      .exec<{
        webhook_url: string | null;
        webhook_updated_by: string | null;
        webhook_updated_at_ms: number | null;
      }>(
        `SELECT webhook_url, webhook_updated_by, webhook_updated_at_ms
         FROM organisation WHERE singleton = 1`,
      )
      .one();
    const webhookUrl = normalizeOrganisationWebhookUrl(row.webhook_url);
    if (
      (row.webhook_updated_by !== null && !ACTOR_ID_PATTERN.test(row.webhook_updated_by)) ||
      (row.webhook_updated_at_ms !== null &&
        (!Number.isSafeInteger(row.webhook_updated_at_ms) || row.webhook_updated_at_ms < 0))
    ) {
      throw new Error("Stored organisation webhook metadata is invalid.");
    }
    return {
      webhookUrl,
      updatedBy: row.webhook_updated_by,
      updatedAt: row.webhook_updated_at_ms,
    };
  }

  private async patchWebhookSettings(request: Request): Promise<Response> {
    const body = await readJsonBody(request, MAX_WEBHOOK_URL_BYTES + 4 * 1_024);
    assertExactKeys(body, ["webhookUrl", "updatedBy"], ["webhookUrl", "updatedBy"]);
    const webhookUrl = normalizeOrganisationWebhookUrl(body.webhookUrl);
    if (webhookUrl !== null) {
      assertOrganisationWebhookOriginAllowed(webhookUrl, this.env.WEBHOOK_ALLOWED_ORIGINS);
    }
    const updatedBy = requireCreatedBy(body.updatedBy);
    const updatedAt = Date.now();
    this.#sql.exec(
      `UPDATE organisation SET webhook_url = ?, webhook_updated_by = ?, webhook_updated_at_ms = ?
       WHERE singleton = 1`,
      webhookUrl,
      updatedBy,
      updatedAt,
    );
    return Response.json({
      webhookUrl,
      updatedBy,
      updatedAt,
    } satisfies OrganisationWebhookSettings);
  }
  private readAdminSummary(): {
    settings: OrganisationWebhookSettings;
    templateCount: number;
    boards: OrganisationAdminSpace[];
  } {
    const templateCount = this.#sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM templates")
      .one().count;
    const boards = this.#sql
      .exec<SpaceRow>(
        `SELECT board_id, space_id, title, archived, members_json, settings_json, updated_at_ms
         FROM spaces ORDER BY updated_at_ms DESC, board_id`,
      )
      .toArray()
      .map(spaceFromRow);
    return { settings: this.readWebhookSettings(), templateCount, boards };
  }

  private async upsertSpaceSummary(request: Request, boardId: string): Promise<Response> {
    const body = await readJsonBody(request, MAX_SPACE_SUMMARY_BYTES);
    assertExactKeys(
      body,
      ["spaceId", "title", "archived", "members", "settings"],
      ["spaceId", "title", "archived", "members", "settings"],
    );
    if (typeof body.spaceId !== "string") {
      throw new HttpError(400, "BAD_REQUEST", "The Space ID is invalid.");
    }
    const spaceId = requireVisibleText(body.spaceId, "Space ID", 1, 120);
    if (typeof body.title !== "string") {
      throw new HttpError(400, "BAD_REQUEST", "The Space title is invalid.");
    }
    const title = requireVisibleText(body.title, "Space title", 1, 100);
    if (typeof body.archived !== "boolean") {
      throw new HttpError(400, "BAD_REQUEST", "The Space archive state is invalid.");
    }
    if (!Array.isArray(body.members) || body.members.length > 500) {
      throw new HttpError(400, "BAD_REQUEST", "The Space member list is invalid.");
    }
    const seen = new Set<string>();
    const members: OrganisationAdminMember[] = body.members.map((raw) => {
      assertExactKeys(raw, ["id", "displayName", "role"], ["id", "displayName", "role"]);
      if (typeof raw.id !== "string" || !ACTOR_ID_PATTERN.test(raw.id) || seen.has(raw.id)) {
        throw new HttpError(400, "BAD_REQUEST", "The Space member is invalid.");
      }
      if (typeof raw.displayName !== "string") {
        throw new HttpError(400, "BAD_REQUEST", "The Space member name is invalid.");
      }
      if (raw.role !== "owner" && raw.role !== "editor" && raw.role !== "viewer") {
        throw new HttpError(400, "BAD_REQUEST", "The Space member role is invalid.");
      }
      seen.add(raw.id);
      return {
        id: raw.id,
        displayName: requireVisibleText(raw.displayName, "member name", 1, 40),
        role: raw.role,
        identifierHash: raw.id,
      };
    });
    if (!isRecord(body.settings)) {
      throw new HttpError(400, "BAD_REQUEST", "The Space settings are invalid.");
    }
    assertExactKeys(
      body.settings,
      ["accessMode", "drawingPolicy", "features", "aclVersion"],
      ["accessMode", "drawingPolicy", "features", "aclVersion"],
    );
    if (body.settings.accessMode !== "private" && body.settings.accessMode !== "link_view") {
      throw new HttpError(400, "BAD_REQUEST", "The Space access setting is invalid.");
    }
    if (
      body.settings.drawingPolicy !== "editors_enabled" &&
      body.settings.drawingPolicy !== "owner_only" &&
      body.settings.drawingPolicy !== "locked"
    ) {
      throw new HttpError(400, "BAD_REQUEST", "The Space drawing setting is invalid.");
    }
    if (
      !Number.isSafeInteger(body.settings.aclVersion) ||
      (body.settings.aclVersion as number) < 1
    ) {
      throw new HttpError(400, "BAD_REQUEST", "The Space ACL version is invalid.");
    }
    let features: BoardFeatures;
    try {
      features = normalizeBoardFeatures(body.settings.features);
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        throw new HttpError(400, "BAD_REQUEST", error.message);
      }
      throw error;
    }
    const settings: OrganisationAdminBoardSettings = {
      accessMode: body.settings.accessMode,
      drawingPolicy: body.settings.drawingPolicy,
      features,
      aclVersion: body.settings.aclVersion as number,
    };
    const now = Date.now();
    const membersJson = JSON.stringify(members);
    const settingsJson = JSON.stringify(settings);
    this.#sql.exec(
      `INSERT INTO spaces(board_id, space_id, title, archived, members_json, settings_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(board_id) DO UPDATE SET space_id = excluded.space_id, title = excluded.title,
         archived = excluded.archived, members_json = excluded.members_json,
         settings_json = excluded.settings_json, updated_at_ms = excluded.updated_at_ms`,
      boardId,
      spaceId,
      title,
      body.archived ? 1 : 0,
      membersJson,
      settingsJson,
      now,
    );
    return Response.json(
      spaceFromRow({
        board_id: boardId,
        space_id: spaceId,
        title,
        archived: body.archived ? 1 : 0,
        members_json: membersJson,
        settings_json: settingsJson,
        updated_at_ms: now,
      }),
    );
  }

  private bindOrganisation(organisationId: string): void {
    this.ctx.storage.transactionSync(() => {
      const existing = this.#sql
        .exec<{ organisation_id: string }>(
          "SELECT organisation_id FROM organisation WHERE singleton = 1",
        )
        .toArray()[0];
      if (existing === undefined) {
        this.#sql.exec(
          "INSERT INTO organisation(singleton, organisation_id, created_at_ms) VALUES (1, ?, ?)",
          organisationId,
          Date.now(),
        );
        return;
      }
      if (existing.organisation_id !== organisationId) {
        throw new HttpError(409, "CONFLICT", "The organisation store is already initialized.");
      }
    });
  }

  private listTemplates(): OrganisationTemplate[] {
    return this.#sql
      .exec<TemplateRow>(
        `SELECT template_id, name, description, items_json, byte_count,
          created_by, created_at_ms, updated_at_ms
         FROM templates ORDER BY updated_at_ms DESC, template_id`,
      )
      .toArray()
      .map(templateFromRow);
  }

  private async createTemplate(request: Request): Promise<Response> {
    const body = await readJsonBody(request, MAX_ORGANISATION_TEMPLATE_BYTES + 16 * 1_024);
    assertExactKeys(
      body,
      ["name", "description", "items", "createdBy"],
      ["name", "items", "createdBy"],
    );
    const name = requireTemplateName(body.name);
    const description = optionalTemplateDescription(body.description);
    const createdBy = requireCreatedBy(body.createdBy);
    const items = normalizeTemplateItems(body.items);
    const itemsJson = JSON.stringify(items);
    const byteCount = new TextEncoder().encode(itemsJson).byteLength;
    if (byteCount > MAX_ORGANISATION_TEMPLATE_BYTES) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The template contents are too large.");
    }

    const now = Date.now();
    const templateId = randomOpaqueId("tpl_");
    this.ctx.storage.transactionSync(() => {
      const usage = this.#sql
        .exec<{ template_count: number; byte_count: number }>(
          `SELECT COUNT(*) AS template_count,
            COALESCE(SUM(byte_count), 0) AS byte_count FROM templates`,
        )
        .one();
      if (usage.template_count >= MAX_ORGANISATION_TEMPLATES) {
        throw new HttpError(
          413,
          "BOARD_LIMIT_REACHED",
          "The organisation template limit was reached.",
        );
      }
      if (usage.byte_count + byteCount > MAX_ORGANISATION_TEMPLATE_TOTAL_BYTES) {
        throw new HttpError(
          413,
          "PAYLOAD_TOO_LARGE",
          "The organisation template storage limit was reached.",
        );
      }
      this.#sql.exec(
        `INSERT INTO templates(
          template_id, name, description, items_json, byte_count,
          created_by, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        templateId,
        name,
        description,
        itemsJson,
        byteCount,
        createdBy,
        now,
        now,
      );
    });
    return Response.json(
      {
        id: templateId,
        name,
        description,
        items,
        createdBy,
        createdAt: now,
        updatedAt: now,
      } satisfies OrganisationTemplate,
      { status: 201 },
    );
  }

  private deleteTemplate(templateId: string): Response {
    const deleted = this.#sql.exec("DELETE FROM templates WHERE template_id = ?", templateId);
    if (deleted.rowsWritten === 0) {
      throw new HttpError(404, "NOT_FOUND", "Template not found.");
    }
    return new Response(null, { status: 204 });
  }
}
function spaceFromRow(row: SpaceRow): OrganisationAdminSpace {
  let rawMembers: unknown;
  let rawSettings: unknown;
  try {
    rawMembers = JSON.parse(row.members_json);
    rawSettings = JSON.parse(row.settings_json);
  } catch {
    throw new Error("Stored Organisation Space JSON is invalid.");
  }
  if (
    !BOARD_ID_PATTERN.test(row.board_id) ||
    typeof row.space_id !== "string" ||
    typeof row.title !== "string" ||
    (row.archived !== 0 && row.archived !== 1) ||
    !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < 0 ||
    !Array.isArray(rawMembers) ||
    !isRecord(rawSettings)
  ) {
    throw new Error("Stored Organisation Space metadata is invalid.");
  }

  const members = rawMembers.map((member): OrganisationAdminMember => {
    if (
      !isRecord(member) ||
      typeof member.id !== "string" ||
      !ACTOR_ID_PATTERN.test(member.id) ||
      typeof member.displayName !== "string" ||
      (member.role !== "owner" && member.role !== "editor" && member.role !== "viewer") ||
      typeof member.identifierHash !== "string" ||
      !ACTOR_ID_PATTERN.test(member.identifierHash)
    ) {
      throw new Error("Stored Organisation Space member is invalid.");
    }
    return {
      id: member.id,
      displayName: member.displayName,
      role: member.role,
      identifierHash: member.identifierHash,
    };
  });

  if (
    (rawSettings.accessMode !== "private" && rawSettings.accessMode !== "link_view") ||
    (rawSettings.drawingPolicy !== "editors_enabled" &&
      rawSettings.drawingPolicy !== "owner_only" &&
      rawSettings.drawingPolicy !== "locked") ||
    !Number.isSafeInteger(rawSettings.aclVersion) ||
    (rawSettings.aclVersion as number) < 1
  ) {
    throw new Error("Stored Organisation Space settings are invalid.");
  }

  let features: BoardFeatures;
  try {
    features = normalizeBoardFeatures(rawSettings.features);
  } catch {
    throw new Error("Stored Organisation Space features are invalid.");
  }
  const settings: OrganisationAdminBoardSettings = {
    accessMode: rawSettings.accessMode,
    drawingPolicy: rawSettings.drawingPolicy,
    features,
    aclVersion: rawSettings.aclVersion as number,
  };

  return {
    boardId: row.board_id,
    spaceId: row.space_id,
    title: row.title,
    archived: row.archived === 1,
    owners: members.filter((member) => member.role === "owner"),
    participants: members.filter((member) => member.role !== "owner"),
    settings,
    updatedAt: row.updated_at_ms,
  };
}

function templateFromRow(row: TemplateRow): OrganisationTemplate {
  let rawItems: unknown;
  try {
    rawItems = JSON.parse(row.items_json);
  } catch {
    throw new Error("Stored organisation template JSON is invalid.");
  }
  const items = normalizeTemplateItems(rawItems);
  if (
    !TEMPLATE_ID_PATTERN.test(row.template_id) ||
    !ACTOR_ID_PATTERN.test(row.created_by) ||
    new TextEncoder().encode(row.items_json).byteLength !== row.byte_count
  ) {
    throw new Error("Stored organisation template metadata is invalid.");
  }
  return {
    id: row.template_id,
    name: requireTemplateName(row.name),
    description: optionalTemplateDescription(row.description),
    items,
    createdBy: row.created_by,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

export function normalizeTemplateItems(value: unknown): BoardItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ORGANISATION_TEMPLATE_ITEMS) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `A template must contain 1 to ${MAX_ORGANISATION_TEMPLATE_ITEMS} objects.`,
    );
  }
  const itemIds = new Set<string>();
  const zOrders = new Set<number>();
  const items = value.map((raw) => {
    let item: BoardItem;
    try {
      item = canonicalItemFromUnknown(raw);
    } catch (error) {
      if (error instanceof BoardDomainError || error instanceof ProtocolValidationError) {
        throw new HttpError(400, "BAD_REQUEST", error.message);
      }
      throw error;
    }
    if ((item as unknown as ProtocolBoardItem).kind === "image") {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "Image objects cannot be stored in organisation templates.",
      );
    }
    if (itemIds.has(item.id) || zOrders.has(item.z)) {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "Template object IDs and paint order must be unique.",
      );
    }
    itemIds.add(item.id);
    zOrders.add(item.z);
    return item;
  });
  return items.sort((left, right) => left.z - right.z);
}

function requireOrganisationId(value: unknown): string {
  if (typeof value !== "string" || !ORGANISATION_ID_PATTERN.test(value)) {
    throw new HttpError(400, "BAD_REQUEST", "The organisation ID is invalid.");
  }
  return value;
}

function requireBoardId(value: unknown): string {
  if (typeof value !== "string" || !BOARD_ID_PATTERN.test(value)) {
    throw new HttpError(404, "NOT_FOUND", "Space not found.");
  }
  return value;
}

export function normalizeOrganisationWebhookUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "The organisation webhook URL is invalid.");
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || new TextEncoder().encode(trimmed).byteLength > MAX_WEBHOOK_URL_BYTES) {
    throw new HttpError(400, "BAD_REQUEST", "The organisation webhook URL is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "The organisation webhook URL is invalid.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const forbiddenSuffixes = [
    "localhost",
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".home.arpa",
    ".onion",
    ".test",
    ".invalid",
  ];
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    (parsed.port !== "" && parsed.port !== "443") ||
    hostname.length < 1 ||
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    hostname.startsWith("[") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) ||
    forbiddenSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(suffix))
  ) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      "The organisation webhook must use a public HTTPS hostname on port 443.",
    );
  }
  return parsed.toString();
}

function requireTemplateId(value: unknown): string {
  if (typeof value !== "string" || !TEMPLATE_ID_PATTERN.test(value)) {
    throw new HttpError(404, "NOT_FOUND", "Template not found.");
  }
  return value;
}

function requireCreatedBy(value: unknown): string {
  if (typeof value !== "string" || !ACTOR_ID_PATTERN.test(value)) {
    throw new HttpError(400, "BAD_REQUEST", "The template creator is invalid.");
  }
  return value;
}

function requireTemplateName(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "The template name is required.");
  }
  return requireVisibleText(value, "template name", 1, MAX_TEMPLATE_NAME_CODE_POINTS);
}

function optionalTemplateDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "The template description is invalid.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return requireVisibleText(
    trimmed,
    "template description",
    1,
    MAX_TEMPLATE_DESCRIPTION_CODE_POINTS,
  );
}

function requireVisibleText(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = value.normalize("NFC").trim();
  try {
    validatePlainText(normalized, field);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new HttpError(400, "BAD_REQUEST", `The ${field} contains invalid Unicode.`);
    }
    throw error;
  }
  if (
    [...normalized].length < minimum ||
    [...normalized].length > maximum ||
    /[\p{Cc}\p{Cs}]/u.test(normalized)
  ) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `The ${field} must be ${minimum} to ${maximum} visible characters.`,
    );
  }
  return normalized;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: { code: "METHOD_NOT_ALLOWED", message: "The method is not allowed." } },
    { status: 405, headers: { Allow: allow } },
  );
}

function mapOrganisationRoomError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof BoardDomainError || error instanceof ProtocolValidationError) {
    return new HttpError(400, "BAD_REQUEST", error.message);
  }
  return new HttpError(500, "INTERNAL_ERROR", "The organisation request failed.");
}
