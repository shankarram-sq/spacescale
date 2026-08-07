import {
  BoardDomainError,
  type ItemRecord,
  type ParsedItemOperation,
  type PreparedOperation,
  prepareItemOperation,
} from "./domain";
import type { BoardRole } from "./types";

type ItemMutationOperation =
  | ParsedItemOperation
  | { kind: "items.batch"; operations: ParsedItemOperation[] };

export type ItemOwnershipContext = {
  actorId: string;
  role: BoardRole;
};

export type OwnedItemPreparationOptions = ItemOwnershipContext & {
  seq: number;
  nextZ: number;
  liveCount: number;
  tokenFactory?: () => string;
};

/**
 * Enforces classroom item ownership before the reducer performs any writes.
 *
 * Owners (including co-owners, which use the same role) may modify every item.
 * Editors may create new items and copy any item, because a copy is a new item
 * attributed to the copying actor. Updating or deleting an existing live item
 * is restricted to its creator.
 *
 * Missing and deleted records deliberately fall through to the reducer so its
 * normal not-found/stale errors remain authoritative.
 */
export function assertItemMutationOwnership(
  operation: ItemMutationOperation,
  records: ReadonlyMap<string, ItemRecord>,
  context: ItemOwnershipContext,
): void {
  if (context.role === "owner") return;
  if (context.role !== "editor") {
    throw new BoardDomainError("FORBIDDEN", "Viewers cannot modify board items.");
  }

  const operations = operation.kind === "items.batch" ? operation.operations : [operation];
  for (const child of operations) {
    if (child.kind === "item.create" || child.kind === "item.copy") continue;
    const record = records.get(child.itemId);
    if (record === undefined || record.deleted || record.item.createdBy === context.actorId) {
      continue;
    }
    throw new BoardDomainError("FORBIDDEN", "You can modify only work that you created.", {
      itemId: child.itemId,
    });
  }
}

/**
 * Keeps authorization and reduction as one call so a forbidden child makes a
 * batch fail before token allocation or any other reducer work begins.
 */
export function prepareOwnedItemOperation(
  operation: ItemMutationOperation,
  records: ReadonlyMap<string, ItemRecord>,
  options: OwnedItemPreparationOptions,
): PreparedOperation {
  assertItemMutationOwnership(operation, records, options);
  return prepareItemOperation(operation, records, options);
}
