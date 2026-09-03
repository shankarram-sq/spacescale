import { boundsForItems } from "@collab/geometry";
import { MAX_BATCH_OPERATIONS, validateDurableOperation } from "@collab/protocol";

import type { OrganisationTemplate } from "../transport/api";
import type { BoardItem, DurableOperation, NewBoardItem, Point } from "../types";

export type OrganisationTemplateBatch = {
  operation: Extract<DurableOperation, { kind: "items.batch" }>;
  itemIds: string[];
};

export class OrganisationTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganisationTemplateError";
  }
}

/**
 * Turns a stored, authoritative template into one atomic create batch.
 *
 * Template objects carry their original server metadata for inspection and
 * attribution. Insertion deliberately gives every object a fresh ID and lets
 * the destination Space assign paint order, version, and creator metadata.
 */
export function buildOrganisationTemplateBatch(
  template: Pick<OrganisationTemplate, "items">,
  center: Point,
  idFactory: () => string,
  groupingEnabled = true,
): OrganisationTemplateBatch {
  if (template.items.length === 0) {
    throw new OrganisationTemplateError("This organisation template has no objects to add.");
  }
  if (template.items.length > MAX_BATCH_OPERATIONS) {
    throw new OrganisationTemplateError(
      `Organisation templates may contain at most ${MAX_BATCH_OPERATIONS} objects.`,
    );
  }
  if (template.items.some((item) => item.kind === "image")) {
    throw new OrganisationTemplateError(
      "Image cards cannot be inserted from organisation templates yet.",
    );
  }

  const sourceItems = new Map<string, BoardItem>();
  const idMap = new Map<string, string>();
  const allocatedIds = new Set<string>();
  const allocateId = (): string => {
    const nextId = idFactory();
    if (allocatedIds.has(nextId)) {
      throw new OrganisationTemplateError("Could not allocate unique IDs for this template.");
    }
    allocatedIds.add(nextId);
    return nextId;
  };
  for (const item of template.items) {
    if (sourceItems.has(item.id)) {
      throw new OrganisationTemplateError("This organisation template contains duplicate IDs.");
    }
    sourceItems.set(item.id, item);
    idMap.set(item.id, allocateId());
  }

  const groupIdMap = new Map<string, string>();
  for (const item of groupingEnabled ? template.items : []) {
    if (item.groupId && !groupIdMap.has(item.groupId)) {
      groupIdMap.set(item.groupId, allocateId());
    }
  }

  const bounds = boundsForItems(template.items as unknown as Parameters<typeof boundsForItems>[0]);
  const offset = bounds
    ? {
        x: center[0] - (bounds.minX + bounds.maxX) / 2,
        y: center[1] - (bounds.minY + bounds.maxY) / 2,
      }
    : { x: center[0], y: center[1] };

  const itemIds: string[] = [];
  const operations = template.items.map((source): { kind: "item.create"; item: NewBoardItem } => {
    const remapped = remapExactItemReferences(source, idMap);
    const {
      z: _z,
      version: _version,
      createdBy: _createdBy,
      groupId: _groupId,
      sectionId: _sectionId,
      ...withoutServerFields
    } = remapped;
    const nextId = idMap.get(source.id);
    if (!nextId)
      throw new OrganisationTemplateError("This template contains an invalid object ID.");
    const nextGroupId =
      groupingEnabled && source.groupId ? groupIdMap.get(source.groupId) : undefined;
    const sectionTarget = source.sectionId ? sourceItems.get(source.sectionId) : undefined;
    const nextSectionId =
      groupingEnabled && source.sectionId && sectionTarget?.kind === "zone"
        ? idMap.get(source.sectionId)
        : undefined;
    const transform = withoutServerFields.transform;
    const geometry =
      withoutServerFields.kind === "zone" && withoutServerFields.geometry.locked === true
        ? { ...withoutServerFields.geometry, locked: false }
        : withoutServerFields.geometry;
    const item = {
      ...withoutServerFields,
      id: nextId,
      geometry,
      ...(nextGroupId ? { groupId: nextGroupId } : {}),
      ...(nextSectionId ? { sectionId: nextSectionId } : {}),
      transform: [
        transform[0],
        transform[1],
        transform[2],
        transform[3],
        transform[4] + offset.x,
        transform[5] + offset.y,
      ],
    } as NewBoardItem;
    itemIds.push(nextId);
    return { kind: "item.create", item };
  });

  const operation = validateDurableOperation({
    kind: "items.batch",
    operations,
  }) as OrganisationTemplateBatch["operation"];
  return { operation, itemIds };
}

export function organisationTemplateSelectionIssue(
  items: readonly BoardItem[],
  maxItems = MAX_BATCH_OPERATIONS,
): string | null {
  if (items.length === 0) return "Select at least one saved object first.";
  const limit = Math.max(1, Math.min(MAX_BATCH_OPERATIONS, Math.floor(maxItems)));
  if (items.length > limit) return `Select no more than ${limit} objects.`;
  if (items.some((item) => item.kind === "image")) {
    return "Image cards cannot be saved in organisation templates yet.";
  }
  return null;
}

/** Remap exact ID-valued fields, including connector references added by newer protocols. */
function remapExactItemReferences(item: BoardItem, idMap: ReadonlyMap<string, string>): BoardItem {
  return remapExactStrings(structuredClone(item), idMap) as BoardItem;
}

function remapExactStrings(value: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return idMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => remapExactStrings(entry, idMap));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, remapExactStrings(entry, idMap)]),
  );
}
