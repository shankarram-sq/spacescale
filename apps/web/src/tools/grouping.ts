import { boundsContain } from "@collab/geometry";
import { MAX_BATCH_OPERATIONS } from "@collab/protocol";

import { itemBounds, translateMatrix } from "../board/model";
import type { BatchItemOperation, BoardItem, DurableOperation } from "../types";

export type GroupedBoardItem = BoardItem;

export type GroupingBatch = Extract<DurableOperation, { kind: "items.batch" }>;

export type GroupedCopyBatch = {
  operation: GroupingBatch;
  itemIds: string[];
  itemIdMap: ReadonlyMap<string, string>;
  groupIdMap: ReadonlyMap<string, string>;
};

export class GroupingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupingError";
  }
}

/** Expands seed items to every live item sharing one of their explicit group IDs. */
export function explicitGroupClosure(
  items: Iterable<GroupedBoardItem>,
  seedIds: Iterable<string>,
): GroupedBoardItem[] {
  const index = indexItems(items);
  const selected = existingSeedIds(index, seedIds);
  const groupIds = new Set<string>();
  for (const id of selected) {
    const groupId = index.get(id)?.groupId;
    if (groupId) groupIds.add(groupId);
  }
  if (groupIds.size > 0) {
    for (const item of index.values()) {
      if (item.groupId && groupIds.has(item.groupId)) selected.add(item.id);
    }
  }
  return selectedItems(index, selected);
}

/** Expands selected Sections to their durable members without selecting a member's Section. */
export function sectionMemberExpansion(
  items: Iterable<GroupedBoardItem>,
  seedIds: Iterable<string>,
): GroupedBoardItem[] {
  const index = indexItems(items);
  const selected = existingSeedIds(index, seedIds);
  const sectionIds = new Set([...selected].filter((id) => index.get(id)?.kind === "zone"));
  if (sectionIds.size > 0) {
    for (const item of index.values()) {
      if (item.sectionId && sectionIds.has(item.sectionId)) selected.add(item.id);
    }
  }
  return selectedItems(index, selected);
}

/**
 * Computes the fixed-point closure used by move and copy. Explicit groups expand
 * symmetrically; a selected Section expands down to its members. A member never
 * pulls its containing Section into the selection.
 */
export function effectiveMoveCopyClosure(
  items: Iterable<GroupedBoardItem>,
  seedIds: Iterable<string>,
): GroupedBoardItem[] {
  const index = indexItems(items);
  const selected = existingSeedIds(index, seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    const groupIds = new Set<string>();
    const sectionIds = new Set<string>();
    for (const id of selected) {
      const item = index.get(id);
      if (!item) continue;
      if (item.groupId) groupIds.add(item.groupId);
      if (item.kind === "zone") sectionIds.add(item.id);
    }
    for (const item of index.values()) {
      if (
        (item.groupId !== undefined && item.groupId !== null && groupIds.has(item.groupId)) ||
        (item.sectionId !== undefined && item.sectionId !== null && sectionIds.has(item.sectionId))
      ) {
        const size = selected.size;
        selected.add(item.id);
        if (selected.size !== size) changed = true;
      }
    }
  }
  return selectedItems(index, selected);
}

/**
 * Builds the batch that places `items` in `groupId`. When the full board is
 * supplied, every current member of any group the selection touches is folded
 * in, so grouping a partial selection can never strand the rest of an existing
 * group.
 */
export function buildGroupBatch(
  items: readonly GroupedBoardItem[],
  groupId: string,
  allItems?: Iterable<GroupedBoardItem>,
): GroupingBatch | null {
  requireRelationshipId(groupId, "group ID");
  const members =
    allItems === undefined
      ? items
      : explicitGroupClosure(
          allItems,
          items.map((item) => item.id),
        );
  const source = validMutationItems(members, 2);
  const operations = source
    .filter((item) => item.groupId !== groupId)
    .map((item) => relationshipUpdate(item, { groupId }));
  return batchOrNull(operations);
}

export function buildUngroupBatch(items: readonly GroupedBoardItem[]): GroupingBatch | null {
  const source = validMutationItems(items, 1);
  const operations = source
    .filter((item) => item.groupId !== undefined && item.groupId !== null)
    .map((item) => relationshipUpdate(item, { groupId: null }));
  return batchOrNull(operations);
}

/**
 * Copies the complete explicit-group/Section closure. Explicit group IDs are
 * always fresh. A copied member points at the copied Section when that Section
 * is part of the closure; otherwise containment is recomputed after translation.
 */
export function buildGroupedSectionCopyBatch(
  items: Iterable<GroupedBoardItem>,
  seedIds: Iterable<string>,
  options: {
    createItemId: () => string;
    createGroupId?: () => string;
    translate?: { x: number; y: number };
  },
): GroupedCopyBatch {
  const allItems = [...items];
  const source = effectiveMoveCopyClosure(allItems, seedIds);
  if (source.length === 0) throw new GroupingError("Select at least one saved item to copy.");
  if (source.length > MAX_BATCH_OPERATIONS) {
    throw new GroupingError(`A grouped copy may contain at most ${MAX_BATCH_OPERATIONS} items.`);
  }
  if (source.some((item) => item.version < 1)) {
    throw new GroupingError("Wait for every grouped item to finish saving before copying.");
  }

  const reserved = new Set<string>();
  for (const item of allItems) {
    reserved.add(item.id);
    if (item.groupId) reserved.add(item.groupId);
  }
  const itemIdMap = new Map<string, string>();
  for (const item of source) {
    const nextId = options.createItemId();
    requireFreshId(nextId, reserved, "item ID");
    reserved.add(nextId);
    itemIdMap.set(item.id, nextId);
  }

  const createGroupId = options.createGroupId ?? options.createItemId;
  const groupIdMap = new Map<string, string>();
  const sourceGroupIds = [
    ...new Set(source.flatMap((item) => (item.groupId ? [item.groupId] : []))),
  ].sort((left, right) => left.localeCompare(right));
  for (const sourceGroupId of sourceGroupIds) {
    const nextGroupId = createGroupId();
    requireFreshId(nextGroupId, reserved, "group ID");
    reserved.add(nextGroupId);
    groupIdMap.set(sourceGroupId, nextGroupId);
  }

  const translate = options.translate ?? { x: 20, y: 20 };
  if (!Number.isFinite(translate.x) || !Number.isFinite(translate.y)) {
    throw new GroupingError("Grouped copy translation must be finite.");
  }
  const operations = source.map((item) => {
    const newItemId = itemIdMap.get(item.id);
    if (!newItemId) throw new GroupingError("Could not allocate a copied item ID.");
    const newGroupId = item.groupId ? groupIdMap.get(item.groupId) : undefined;
    const copiedSectionId = item.sectionId ? itemIdMap.get(item.sectionId) : undefined;
    const newSectionId =
      item.kind === "zone"
        ? null
        : (copiedSectionId ??
          translatedContainingSectionId(allItems, itemIdMap, item, translate) ??
          null);
    return {
      kind: "item.copy" as const,
      sourceItemId: item.id,
      expectedVersion: item.version,
      newItemId,
      translate: { ...translate },
      ...(newGroupId === undefined ? {} : { newGroupId }),
      ...(newSectionId === undefined ? {} : { newSectionId }),
    };
  });

  return {
    operation: { kind: "items.batch", operations } as unknown as GroupingBatch,
    itemIds: operations.map((operation) => operation.newItemId),
    itemIdMap,
    groupIdMap,
  };
}

function translatedContainingSectionId(
  items: readonly GroupedBoardItem[],
  copiedItemIds: ReadonlyMap<string, string>,
  item: GroupedBoardItem,
  translate: { x: number; y: number },
): string | undefined {
  const translatedItem = {
    ...item,
    transform: translateMatrix(item.transform, translate.x, translate.y),
  } as GroupedBoardItem;
  const candidateBounds = itemBounds(translatedItem);
  return items
    .flatMap((candidate) => {
      if (candidate.kind !== "zone") return [];
      const copiedId = copiedItemIds.get(candidate.id);
      return [
        { id: candidate.id, section: candidate, copied: false },
        ...(copiedId
          ? [
              {
                id: copiedId,
                section: {
                  ...candidate,
                  transform: translateMatrix(candidate.transform, translate.x, translate.y),
                },
                copied: true,
              },
            ]
          : []),
      ];
    })
    .filter(({ section }) => boundsContain(itemBounds(section), candidateBounds))
    .sort(
      (left, right) =>
        Number(right.copied) - Number(left.copied) ||
        right.section.z - left.section.z ||
        left.id.localeCompare(right.id),
    )[0]?.id;
}

function indexItems(items: Iterable<GroupedBoardItem>): Map<string, GroupedBoardItem> {
  const index = new Map<string, GroupedBoardItem>();
  for (const item of items) {
    if (index.has(item.id)) throw new GroupingError(`Duplicate item ID ${item.id}.`);
    index.set(item.id, item);
  }
  return index;
}

function existingSeedIds(
  index: ReadonlyMap<string, GroupedBoardItem>,
  seedIds: Iterable<string>,
): Set<string> {
  const selected = new Set<string>();
  for (const id of seedIds) if (index.has(id)) selected.add(id);
  return selected;
}

function selectedItems(
  index: ReadonlyMap<string, GroupedBoardItem>,
  selected: ReadonlySet<string>,
): GroupedBoardItem[] {
  return [...selected]
    .flatMap((id) => {
      const item = index.get(id);
      return item ? [item] : [];
    })
    .sort(comparePaintOrder);
}

function validMutationItems(
  items: readonly GroupedBoardItem[],
  minimum: number,
): GroupedBoardItem[] {
  if (items.length < minimum) return [];
  if (items.length > MAX_BATCH_OPERATIONS) {
    throw new GroupingError(`A group may contain at most ${MAX_BATCH_OPERATIONS} items.`);
  }
  if (items.some((item) => item.version < 1)) {
    throw new GroupingError("Wait for every selected item to finish saving.");
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new GroupingError("A group cannot contain duplicate items.");
  }
  return [...items].sort(comparePaintOrder);
}

function relationshipUpdate(
  item: GroupedBoardItem,
  patch: { groupId: string | null },
): BatchItemOperation {
  return {
    kind: "item.update",
    itemId: item.id,
    expectedVersion: item.version,
    patch,
  } as unknown as BatchItemOperation;
}

function batchOrNull(operations: BatchItemOperation[]): GroupingBatch | null {
  return operations.length === 0 ? null : { kind: "items.batch", operations };
}

function requireRelationshipId(value: string, label: string): void {
  if (value.trim() === "") throw new GroupingError(`The ${label} is required.`);
}

function requireFreshId(value: string, reserved: ReadonlySet<string>, label: string): void {
  requireRelationshipId(value, label);
  if (reserved.has(value)) throw new GroupingError(`Could not allocate a unique ${label}.`);
}

function comparePaintOrder(left: GroupedBoardItem, right: GroupedBoardItem): number {
  return left.z - right.z || left.id.localeCompare(right.id);
}
