import {
  BoardDomainError,
  type ItemRecord,
  type ParsedItemOperation,
  type PreparedOperation,
  prepareItemOperation,
} from "./domain";
import type { BoardItem, BoardRole, ZoneGeometry } from "./types";

type SectionItem = BoardItem & { kind: "zone"; geometry: ZoneGeometry };

export type ItemMutationOperation =
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

function children(operation: ItemMutationOperation): readonly ParsedItemOperation[] {
  return operation.kind === "items.batch" ? operation.operations : [operation];
}

function liveItem(records: ReadonlyMap<string, ItemRecord>, itemId: string): BoardItem | undefined {
  const record = records.get(itemId);
  return record === undefined || record.deleted ? undefined : record.item;
}

function asSection(item: BoardItem | undefined): SectionItem | undefined {
  return item?.kind === "zone" && "title" in item.geometry ? (item as SectionItem) : undefined;
}

function lockedSection(
  records: ReadonlyMap<string, ItemRecord>,
  sectionId: string | undefined,
): SectionItem | undefined {
  if (sectionId === undefined) return undefined;
  const section = asSection(liveItem(records, sectionId));
  return section?.geometry.locked === true ? section : undefined;
}

function mutationSource(
  operation: ParsedItemOperation,
  records: ReadonlyMap<string, ItemRecord>,
): BoardItem | undefined {
  if (operation.kind === "item.create") return undefined;
  return liveItem(
    records,
    operation.kind === "item.copy" ? operation.sourceItemId : operation.itemId,
  );
}

function prospectiveSectionId(operation: ParsedItemOperation): string | undefined {
  if (operation.kind === "item.create") return operation.item.sectionId;
  if (operation.kind === "item.update") {
    return typeof operation.patch.sectionId === "string" ? operation.patch.sectionId : undefined;
  }
  if (operation.kind === "item.copy") {
    return typeof operation.newSectionId === "string" ? operation.newSectionId : undefined;
  }
  return undefined;
}

function zoneLockChange(
  operation: ParsedItemOperation,
  records: ReadonlyMap<string, ItemRecord>,
): { section: SectionItem; locked: boolean } | null {
  if (operation.kind !== "item.update" || operation.patch.geometry === undefined) return null;
  const source = asSection(liveItem(records, operation.itemId));
  if (source === undefined) return null;
  const geometry = operation.patch.geometry as Partial<typeof source.geometry>;
  const locked = geometry.locked === true;
  return locked === (source.geometry.locked === true) ? null : { section: source, locked };
}

function isPureZoneLockChange(operation: ParsedItemOperation, section: SectionItem): boolean {
  if (
    operation.kind !== "item.update" ||
    operation.patch.geometry === undefined ||
    Object.keys(operation.patch).length !== 1
  ) {
    return false;
  }
  const geometry = operation.patch.geometry as Partial<typeof section.geometry>;
  return (
    geometry.x === section.geometry.x &&
    geometry.y === section.geometry.y &&
    geometry.width === section.geometry.width &&
    geometry.height === section.geometry.height &&
    geometry.title === section.geometry.title &&
    (geometry.locked === true) !== (section.geometry.locked === true)
  );
}

function sectionLocked(sectionId: string, itemId?: string): never {
  throw new BoardDomainError(
    "FORBIDDEN",
    "This Section is locked. An owner must unlock it before its contents can change.",
    { sectionId, ...(itemId === undefined ? {} : { itemId }) },
  );
}

export function sectionRecordIdsForItems(items: Iterable<BoardItem>): string[] {
  const ids = new Set<string>();
  for (const item of items) if (item.sectionId !== undefined) ids.add(item.sectionId);
  return [...ids];
}

export function sectionRecordIdsForMutation(
  operation: ItemMutationOperation,
  records: ReadonlyMap<string, ItemRecord>,
): string[] {
  const ids = new Set<string>();
  for (const child of children(operation)) {
    const source = mutationSource(child, records);
    if (source?.sectionId !== undefined) ids.add(source.sectionId);
    const prospective = prospectiveSectionId(child);
    if (prospective !== undefined) ids.add(prospective);
  }
  return [...ids];
}

export function assertItemsOutsideLockedSections(
  items: Iterable<BoardItem>,
  records: ReadonlyMap<string, ItemRecord>,
): void {
  for (const item of items) {
    const sectionItem = asSection(item);
    if (sectionItem?.geometry.locked === true) {
      sectionLocked(sectionItem.id, sectionItem.id);
    }
    const section = lockedSection(records, item.sectionId);
    if (section !== undefined) sectionLocked(section.id, item.id);
  }
}

export function assertSectionLockMutation(
  operation: ItemMutationOperation,
  records: ReadonlyMap<string, ItemRecord>,
  context: ItemOwnershipContext,
): void {
  const operations = children(operation);
  const lockChanges = operations.flatMap((child) => {
    const change = zoneLockChange(child, records);
    return change === null ? [] : [{ operation: child, ...change }];
  });
  const [lockChange] = lockChanges;
  if (
    lockChange !== undefined &&
    (context.role !== "owner" ||
      operations.length !== 1 ||
      lockChanges.length !== 1 ||
      !isPureZoneLockChange(lockChange.operation, lockChange.section))
  ) {
    throw new BoardDomainError("FORBIDDEN", "Only an owner can lock or unlock a Section.");
  }

  for (const child of operations) {
    if (
      child.kind === "item.create" &&
      child.item.kind === "zone" &&
      (child.item.geometry as { locked?: unknown }).locked === true &&
      context.role !== "owner"
    ) {
      throw new BoardDomainError("FORBIDDEN", "Only an owner can create a locked Section.");
    }

    const source = mutationSource(child, records);
    const sourceSection = asSection(source);
    if (sourceSection?.geometry.locked === true) {
      const change = zoneLockChange(child, records);
      if (
        change !== null &&
        context.role === "owner" &&
        change.locked === false &&
        isPureZoneLockChange(child, sourceSection)
      ) {
        continue;
      }
      sectionLocked(sourceSection.id, sourceSection.id);
    }

    const currentSection = lockedSection(records, source?.sectionId);
    if (currentSection !== undefined) sectionLocked(currentSection.id, source?.id);

    const nextSection = lockedSection(records, prospectiveSectionId(child));
    if (nextSection !== undefined) {
      const itemId = child.kind === "item.create" ? child.item.id : source?.id;
      sectionLocked(nextSection.id, itemId);
    }
  }
}

export function assertItemsOwnedByActor(
  items: Iterable<BoardItem>,
  context: ItemOwnershipContext,
): void {
  if (context.role === "owner") return;
  if (context.role !== "editor") {
    throw new BoardDomainError("FORBIDDEN", "Viewers cannot modify board items.");
  }
  for (const item of items) {
    if (item.createdBy === context.actorId) continue;
    throw new BoardDomainError("FORBIDDEN", "You can modify only work that you created.", {
      itemId: item.id,
    });
  }
}

/**
 * Enforces item ownership and Section locks before the reducer performs writes.
 *
 * Owners (including co-owners, which use the same role) may modify every
 * unlocked item. Editors may create new items and copy any unlocked item,
 * because a copy is a new item attributed to the copying actor. Updating or
 * deleting an existing live item is restricted to its creator.
 *
 * Missing and deleted records deliberately fall through to the reducer so its
 * normal not-found/stale errors remain authoritative.
 */
export function assertItemMutationOwnership(
  operation: ItemMutationOperation,
  records: ReadonlyMap<string, ItemRecord>,
  context: ItemOwnershipContext,
): void {
  assertSectionLockMutation(operation, records, context);
  const existingItems = children(operation).flatMap((child) => {
    if (child.kind === "item.create" || child.kind === "item.copy") return [];
    const record = records.get(child.itemId);
    return record === undefined || record.deleted ? [] : [record.item];
  });
  assertItemsOwnedByActor(existingItems, context);
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
