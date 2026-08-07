import { DurableObject } from "cloudflare:workers";
import {
  type BoardItem as ProtocolBoardItem,
  ProtocolValidationError,
  validatePlainText,
} from "@collab/protocol";
import { randomOpaqueId } from "./crypto";
import { BoardDomainError, canonicalItemFromUnknown } from "./domain";
import { assertExactKeys, readJsonBody } from "./http/body";
import { errorResponse, HttpError } from "./http/errors";
import { applyOrganisationMigrations } from "./migrations";
import type { BoardItem, Env } from "./types";
import { ACTOR_ID_PATTERN } from "./validation";

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

export type OrganisationTemplate = {
  id: string;
  name: string;
  description: string | null;
  items: BoardItem[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
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
  return new HttpError(500, "INTERNAL_ERROR", "The organisation template request failed.");
}
