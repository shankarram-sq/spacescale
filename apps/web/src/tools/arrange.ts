import { type Bounds, itemBounds } from "../board/model";
import type { BatchItemOperation, BoardItem, Matrix } from "../types";
import { roundBoard } from "../types";

export type ArrangeKind =
  | "align-left"
  | "align-top"
  | "align-horizontal-center"
  | "distribute-horizontal"
  | "distribute-vertical"
  | "tidy-stickies";

export type ArrangeUpdate = Extract<BatchItemOperation, { kind: "item.update" }>;

type ArrangementUnit = {
  id: string;
  items: BoardItem[];
  bounds: Bounds;
};

type Participant = {
  id: string;
  items: BoardItem[];
  bounds: Bounds;
  dx: number;
  dy: number;
};

const TIDY_GAP = 24;

export function buildArrangeUpdates(
  kind: ArrangeKind,
  selectedItems: readonly BoardItem[],
  groupingEnabled = true,
): ArrangeUpdate[] {
  const units = arrangementUnits(kind, selectedItems, groupingEnabled);
  const source = units.flatMap((unit) => unit.items);
  const minimum = kind.startsWith("distribute-") ? 3 : 2;
  if (
    units.length < minimum ||
    source.some((item) => item.version < 1) ||
    new Set(source.map((item) => item.id)).size !== source.length
  ) {
    return [];
  }

  const participants = units.map((unit) => ({
    ...unit,
    dx: 0,
    dy: 0,
  }));
  switch (kind) {
    case "align-left":
      alignLeft(participants);
      participants.sort(compareId);
      break;
    case "align-top":
      alignTop(participants);
      participants.sort(compareId);
      break;
    case "align-horizontal-center":
      alignHorizontalCenter(participants);
      participants.sort(compareId);
      break;
    case "distribute-horizontal":
      distribute(participants, "horizontal");
      break;
    case "distribute-vertical":
      distribute(participants, "vertical");
      break;
    case "tidy-stickies":
      tidyStickies(participants);
      break;
  }

  for (const participant of participants) {
    participant.dx = roundBoard(participant.dx);
    participant.dy = roundBoard(participant.dy);
  }
  if (participants.every(({ dx, dy }) => dx === 0 && dy === 0)) return [];
  return participants.flatMap(({ items, dx, dy }) =>
    items.map((item) => ({
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { transform: translated(item.transform, dx, dy) },
    })),
  );
}

function arrangementUnits(
  kind: ArrangeKind,
  selectedItems: readonly BoardItem[],
  groupingEnabled: boolean,
): ArrangementUnit[] {
  const units: ArrangementUnit[] = [];
  const explicitGroups = new Map<string, BoardItem[]>();
  for (const item of selectedItems) {
    if (groupingEnabled && item.groupId) {
      const members = explicitGroups.get(item.groupId) ?? [];
      members.push(item);
      explicitGroups.set(item.groupId, members);
      continue;
    }
    if (kind === "tidy-stickies" && item.kind !== "sticky") continue;
    units.push({ id: item.id, items: [item], bounds: itemBounds(item) });
  }
  for (const members of explicitGroups.values()) {
    if (kind === "tidy-stickies" && !members.some((item) => item.kind === "sticky")) continue;
    members.sort((left, right) => left.id.localeCompare(right.id));
    const first = members[0];
    if (!first) continue;
    units.push({
      id: first.id,
      items: members,
      bounds: members.map(itemBounds).reduce(unionBounds),
    });
  }
  return units;
}

function unionBounds(left: Bounds, right: Bounds): Bounds {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

function alignLeft(participants: Participant[]): void {
  const left = Math.min(...participants.map(({ bounds }) => bounds.minX));
  for (const participant of participants) participant.dx = left - participant.bounds.minX;
}

function alignTop(participants: Participant[]): void {
  const top = Math.min(...participants.map(({ bounds }) => bounds.minY));
  for (const participant of participants) participant.dy = top - participant.bounds.minY;
}

function alignHorizontalCenter(participants: Participant[]): void {
  const left = Math.min(...participants.map(({ bounds }) => bounds.minX));
  const right = Math.max(...participants.map(({ bounds }) => bounds.maxX));
  const center = (left + right) / 2;
  for (const participant of participants) {
    participant.dx = center - (participant.bounds.minX + participant.bounds.maxX) / 2;
  }
}

function distribute(participants: Participant[], axis: "horizontal" | "vertical"): void {
  const horizontal = axis === "horizontal";
  participants.sort((left, right) => {
    const primary = horizontal
      ? left.bounds.minX - right.bounds.minX
      : left.bounds.minY - right.bounds.minY;
    if (primary !== 0) return primary;
    const secondary = horizontal
      ? left.bounds.minY - right.bounds.minY
      : left.bounds.minX - right.bounds.minX;
    return secondary || left.id.localeCompare(right.id);
  });
  const first = participants[0];
  const last = participants.at(-1);
  if (!first || !last) return;
  const start = horizontal ? first.bounds.minX : first.bounds.minY;
  const end = horizontal ? last.bounds.maxX : last.bounds.maxY;
  const sizes = participants.map(({ bounds }) =>
    horizontal ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY,
  );
  const occupied = sizes.reduce((total, size) => total + size, 0);
  const gap = (end - start - occupied) / (participants.length - 1);
  let cursor = start;
  participants.forEach((participant, index) => {
    if (horizontal) participant.dx = cursor - participant.bounds.minX;
    else participant.dy = cursor - participant.bounds.minY;
    cursor += (sizes[index] ?? 0) + gap;
  });
}

function tidyStickies(participants: Participant[]): void {
  participants.sort(
    (left, right) =>
      left.bounds.minY - right.bounds.minY ||
      left.bounds.minX - right.bounds.minX ||
      left.id.localeCompare(right.id),
  );
  const columns = Math.ceil(Math.sqrt(participants.length));
  const rows = Math.ceil(participants.length / columns);
  const columnWidths = Array.from({ length: columns }, () => 0);
  const rowHeights = Array.from({ length: rows }, () => 0);
  participants.forEach(({ bounds }, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, bounds.maxX - bounds.minX);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, bounds.maxY - bounds.minY);
  });
  const originX = Math.min(...participants.map(({ bounds }) => bounds.minX));
  const originY = Math.min(...participants.map(({ bounds }) => bounds.minY));
  const columnOffsets = cumulativeOffsets(columnWidths);
  const rowOffsets = cumulativeOffsets(rowHeights);
  participants.forEach((participant, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    participant.dx = originX + (columnOffsets[column] ?? 0) - participant.bounds.minX;
    participant.dy = originY + (rowOffsets[row] ?? 0) - participant.bounds.minY;
  });
}

function cumulativeOffsets(sizes: readonly number[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const size of sizes) {
    offsets.push(cursor);
    cursor += size + TIDY_GAP;
  }
  return offsets;
}

function translated(transform: Matrix, dx: number, dy: number): Matrix {
  return [
    transform[0],
    transform[1],
    transform[2],
    transform[3],
    roundBoard(transform[4] + dx),
    roundBoard(transform[5] + dy),
  ];
}

function compareId(left: Participant, right: Participant): number {
  return left.id.localeCompare(right.id);
}
