import {
  applyDurableOperation,
  BoardCoreError,
  type ItemRecord as CoreItemRecord,
  createBoardState,
} from "@collab/board-core";
import {
  type Bounds,
  canonicalNumber,
  GeometryValidationError,
  itemBounds,
} from "@collab/geometry";
import {
  type ClientCommitFrame,
  type DurableOperation,
  normalizeBoardItem,
  type BoardItem as ProtocolBoardItem,
  ProtocolValidationError,
  validateClientFrame,
} from "@collab/protocol";
import type {
  BoardItem,
  BoardItemKind,
  ItemEffect,
  ItemGeometry,
  ItemStyle,
  Matrix,
} from "./types";
import { OPAQUE_ID_PATTERN } from "./validation";

export const MAX_ITEMS = 10_000;
export const MAX_BATCH_ITEMS = 100;
export const MAX_PUBLIC_RESULT_BYTES = 512 * 1_024;
export const MAX_ACTION_PAYLOAD_BYTES = 1_500 * 1_024;

export type ItemPatch = {
  style?: ItemStyle;
  transform?: Matrix;
  geometry?: ItemGeometry;
};

export type ParsedItemOperation =
  | { kind: "item.create"; item: NewItem }
  | { kind: "item.update"; itemId: string; expectedVersion: number; patch: RawPatch }
  | { kind: "item.delete"; itemId: string; expectedVersion: number }
  | {
      kind: "item.copy";
      sourceItemId: string;
      expectedVersion: number;
      newItemId: string;
      translate: { x: number; y: number };
    };

export type ParsedOperation =
  | ParsedItemOperation
  | { kind: "items.batch"; operations: ParsedItemOperation[] }
  | { kind: "history.undo"; expectedHistoryVersion: number; targetActionId?: string }
  | { kind: "history.redo"; expectedHistoryVersion: number; targetActionId?: string }
  | { kind: "board.clear"; expectedBoardSeq: number };

export interface ParsedCommit {
  v: 1;
  t: "client.commit";
  commandId: string;
  actionId: string;
  baseSeq: number;
  op: ParsedOperation;
}

export interface ItemRecord {
  item: BoardItem;
  deleted: boolean;
  stateToken: string;
}

export interface ItemWrite extends ItemRecord {
  bounds: Bounds;
}

export interface PreparedOperation {
  publicOperation: Record<string, unknown>;
  effects: ItemEffect[];
  writes: Map<string, ItemWrite>;
  affectedItemIds: string[];
  nextZ: number;
  liveCount: number;
}

export interface NewItem {
  id: string;
  kind: BoardItemKind;
  style: unknown;
  transform: unknown;
  geometry: unknown;
}

interface RawPatch {
  style?: unknown;
  transform?: unknown;
  geometry?: unknown;
}

export class BoardDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BoardDomainError";
  }
}

export function parseCommitFrame(value: unknown): ParsedCommit {
  try {
    const validated = validateClientFrame(value);
    if (validated.t !== "client.commit") {
      throw new BoardDomainError("INVALID_FRAME", "Invalid commit frame.");
    }
    return validated as ClientCommitFrame as unknown as ParsedCommit;
  } catch (error) {
    if (error instanceof BoardDomainError) throw error;
    if (error instanceof ProtocolValidationError) {
      throw new BoardDomainError(error.code, error.message, error.details);
    }
    throw error;
  }
}

export function parseOperation(value: unknown): ParsedOperation {
  const operation = record(value, "op");
  if (typeof operation.kind !== "string")
    throw new BoardDomainError("INVALID_FRAME", "Missing operation kind.");
  switch (operation.kind) {
    case "item.create": {
      exact(operation, ["kind", "item"], "op");
      return { kind: operation.kind, item: parseNewItem(operation.item) };
    }
    case "item.update": {
      exact(operation, ["kind", "itemId", "expectedVersion", "patch"], "op");
      const patch = record(operation.patch, "op.patch");
      optionalOnly(patch, ["style", "transform", "geometry"], "op.patch");
      if (Object.keys(patch).length === 0)
        throw new BoardDomainError("INVALID_FRAME", "An update patch is empty.");
      return {
        kind: operation.kind,
        itemId: opaqueId(operation.itemId, "itemId"),
        expectedVersion: safeInteger(
          operation.expectedVersion,
          "expectedVersion",
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        patch,
      };
    }
    case "item.delete": {
      exact(operation, ["kind", "itemId", "expectedVersion"], "op");
      return {
        kind: operation.kind,
        itemId: opaqueId(operation.itemId, "itemId"),
        expectedVersion: safeInteger(
          operation.expectedVersion,
          "expectedVersion",
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      };
    }
    case "item.copy": {
      exact(operation, ["kind", "sourceItemId", "expectedVersion", "newItemId", "translate"], "op");
      const translate = record(operation.translate, "op.translate");
      exact(translate, ["x", "y"], "op.translate");
      return {
        kind: operation.kind,
        sourceItemId: opaqueId(operation.sourceItemId, "sourceItemId"),
        expectedVersion: safeInteger(
          operation.expectedVersion,
          "expectedVersion",
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        newItemId: opaqueId(operation.newItemId, "newItemId"),
        translate: {
          x: finiteCoordinate(translate.x, "translate.x"),
          y: finiteCoordinate(translate.y, "translate.y"),
        },
      };
    }
    case "items.batch": {
      exact(operation, ["kind", "operations"], "op");
      if (
        !Array.isArray(operation.operations) ||
        operation.operations.length < 1 ||
        operation.operations.length > MAX_BATCH_ITEMS
      ) {
        throw new BoardDomainError(
          "INVALID_FRAME",
          `A batch must contain 1 to ${MAX_BATCH_ITEMS} operations.`,
        );
      }
      const operations = operation.operations.map((child) => {
        const parsed = parseOperation(child);
        if (
          parsed.kind === "items.batch" ||
          parsed.kind.startsWith("history.") ||
          parsed.kind === "board.clear"
        ) {
          throw new BoardDomainError(
            "INVALID_FRAME",
            "Nested or non-item batch operations are not allowed.",
          );
        }
        return parsed as ParsedItemOperation;
      });
      return { kind: operation.kind, operations };
    }
    case "history.undo":
    case "history.redo": {
      optionalOnly(operation, ["kind", "expectedHistoryVersion", "targetActionId"], "op");
      if (!Object.hasOwn(operation, "expectedHistoryVersion")) {
        throw new BoardDomainError("INVALID_FRAME", "expectedHistoryVersion is required.");
      }
      const targetActionId =
        operation.targetActionId === undefined
          ? undefined
          : opaqueId(operation.targetActionId, "targetActionId");
      return {
        kind: operation.kind,
        expectedHistoryVersion: safeInteger(
          operation.expectedHistoryVersion,
          "expectedHistoryVersion",
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        ...(targetActionId === undefined ? {} : { targetActionId }),
      };
    }
    case "board.clear": {
      exact(operation, ["kind", "expectedBoardSeq"], "op");
      return {
        kind: operation.kind,
        expectedBoardSeq: safeInteger(
          operation.expectedBoardSeq,
          "expectedBoardSeq",
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      };
    }
    default:
      throw new BoardDomainError("INVALID_FRAME", "Unknown operation kind.");
  }
}

export function affectedIds(operation: ParsedOperation): string[] {
  if (operation.kind === "item.create") return [operation.item.id];
  if (operation.kind === "item.update" || operation.kind === "item.delete")
    return [operation.itemId];
  if (operation.kind === "item.copy") return [operation.sourceItemId, operation.newItemId];
  if (operation.kind === "items.batch")
    return [...new Set(operation.operations.flatMap(affectedIds))];
  return [];
}

export function prepareItemOperation(
  operation: ParsedItemOperation | { kind: "items.batch"; operations: ParsedItemOperation[] },
  initialRecords: ReadonlyMap<string, ItemRecord>,
  options: {
    seq: number;
    actorId: string;
    nextZ: number;
    liveCount: number;
    tokenFactory?: () => string;
  },
): PreparedOperation {
  const makeToken = options.tokenFactory ?? (() => crypto.randomUUID());
  const coreRecords = new Map<string, CoreItemRecord>();
  for (const [itemId, record] of initialRecords) {
    coreRecords.set(itemId, {
      exists: !record.deleted,
      item: record.item as unknown as ProtocolBoardItem,
      stateToken: record.stateToken,
    });
  }

  let result: ReturnType<typeof applyDurableOperation>;
  try {
    const state = createBoardState({
      seq: options.seq - 1,
      nextZ: options.nextZ,
      records: coreRecords,
      usedItemIds: initialRecords.keys(),
    });
    result = applyDurableOperation(state, operation as unknown as DurableOperation, {
      seq: options.seq,
      actorId: options.actorId,
      tokenFactory: () => makeToken(),
    });
  } catch (error) {
    if (error instanceof BoardCoreError) {
      throw new BoardDomainError(
        error.code,
        error.message,
        error.details as Record<string, unknown>,
      );
    }
    throw error;
  }

  const writes = new Map<string, ItemWrite>();
  for (const itemId of result.affectedItemIds) {
    const record = result.state.items.get(itemId);
    if (record === undefined) {
      throw new BoardDomainError("INTERNAL_ERROR", "The shared reducer omitted an item write.");
    }
    writes.set(
      itemId,
      makeWrite(record.item as unknown as BoardItem, !record.exists, record.stateToken),
    );
  }

  const liveDelta = result.effects.reduce((delta, effectValue) => {
    if (!effectValue.before.exists && effectValue.after.exists) return delta + 1;
    if (effectValue.before.exists && !effectValue.after.exists) return delta - 1;
    return delta;
  }, 0);
  const liveCount = options.liveCount + liveDelta;
  if (liveCount > MAX_ITEMS) {
    throw new BoardDomainError("BOARD_LIMIT_REACHED", "The board item limit was reached.");
  }
  return {
    publicOperation: result.operation as unknown as Record<string, unknown>,
    effects: result.effects as unknown as ItemEffect[],
    writes,
    affectedItemIds: [...result.affectedItemIds],
    nextZ: result.state.nextZ,
    liveCount,
  };
}

export function canonicalItemFromUnknown(value: unknown): BoardItem {
  try {
    return normalizeBoardItem(value, "$item") as unknown as BoardItem;
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new BoardDomainError(
        error.code,
        error.message,
        error.details as Record<string, unknown>,
      );
    }
    throw error;
  }
}

export function itemWriteFromState(
  item: BoardItem,
  deleted: boolean,
  stateToken: string,
): ItemWrite {
  return makeWrite(item, deleted, stateToken);
}

function parseNewItem(value: unknown): NewItem {
  const item = record(value, "op.item");
  exact(item, ["id", "kind", "style", "transform", "geometry"], "op.item");
  return {
    id: opaqueId(item.id, "item.id"),
    kind: itemKind(item.kind),
    style: item.style,
    transform: item.transform,
    geometry: item.geometry,
  };
}

function makeWrite(item: BoardItem, deleted: boolean, stateToken: string): ItemWrite {
  try {
    const bounds = itemBounds(item);
    return { item, deleted, stateToken, bounds };
  } catch (error) {
    if (error instanceof GeometryValidationError) {
      throw new BoardDomainError("INVALID_FRAME", error.message);
    }
    throw error;
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BoardDomainError("INVALID_FRAME", `${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BoardDomainError("INVALID_FRAME", `${path} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  optionalOnly(value, fields, path);
  for (const field of fields) {
    if (!Object.hasOwn(value, field))
      throw new BoardDomainError("INVALID_FRAME", `${path}.${field} is required.`);
  }
}

function optionalOnly(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new BoardDomainError("INVALID_FRAME", `${path}.${key} is not allowed.`);
    }
  }
}

function itemKind(value: unknown): BoardItemKind {
  if (
    value === "pencil" ||
    value === "line" ||
    value === "rectangle" ||
    value === "ellipse" ||
    value === "text" ||
    value === "sticky" ||
    value === "stamp" ||
    value === "table"
  ) {
    return value;
  }
  throw new BoardDomainError("INVALID_FRAME", "Unknown item kind.");
}

function opaqueId(value: unknown, path: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new BoardDomainError("INVALID_FRAME", `${path} is invalid.`);
  }
  return value;
}

function safeInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new BoardDomainError("INVALID_FRAME", `${path} is invalid.`);
  }
  return value as number;
}

function finiteCoordinate(value: unknown, path: string): number {
  const result = finiteRange(value, path, -1_000_000, 1_000_000);
  return canonicalNumber(result, 2);
}

function finiteRange(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new BoardDomainError("INVALID_FRAME", `${path} is out of range.`);
  }
  return canonicalNumber(value, 4);
}
