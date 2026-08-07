import type { BatchItemOperation, BoardItem, Point, TableGeometry, ZoneGeometry } from "../types";
import { roundBoard } from "../types";

export const MIN_RESIZED_TABLE_COLUMN_WIDTH = 64;
export const MIN_RESIZED_TABLE_ROW_HEIGHT = 36;
export const MIN_RESIZED_ZONE_WIDTH = 160;
export const MIN_RESIZED_ZONE_HEIGHT = 100;

export type StructuredResizeItem = Extract<BoardItem, { kind: "table" | "zone" }>;
export type StructuredResizeHandle =
  | { kind: "southeast" }
  | { kind: "table-column"; index: number }
  | { kind: "table-row"; index: number };

export type CapturedStructuredResize = {
  item: StructuredResizeItem;
  expectedVersion: number;
  handle: StructuredResizeHandle;
};

export function structuredResizeTarget(
  item: StructuredResizeItem,
  handle: StructuredResizeHandle,
): Point {
  if (item.kind === "zone") {
    return [item.geometry.x + item.geometry.width, item.geometry.y + item.geometry.height];
  }
  if (handle.kind === "table-column") {
    return [
      item.geometry.x + sumThrough(item.geometry.columnWidths, handle.index),
      item.geometry.y,
    ];
  }
  if (handle.kind === "table-row") {
    return [item.geometry.x, item.geometry.y + sumThrough(item.geometry.rowHeights, handle.index)];
  }
  return [
    item.geometry.x + sum(item.geometry.columnWidths),
    item.geometry.y + sum(item.geometry.rowHeights),
  ];
}

export function structuredResizeGrabOffset(
  item: StructuredResizeItem,
  handle: StructuredResizeHandle,
  localPointer: Point,
): Point {
  const target = structuredResizeTarget(item, handle);
  return [localPointer[0] - target[0], localPointer[1] - target[1]];
}

export function resizedStructuredGeometry(
  item: Extract<StructuredResizeItem, { kind: "zone" }>,
  handle: StructuredResizeHandle,
  localPointer: Point,
  grabOffset?: Point,
): ZoneGeometry;
export function resizedStructuredGeometry(
  item: Extract<StructuredResizeItem, { kind: "table" }>,
  handle: StructuredResizeHandle,
  localPointer: Point,
  grabOffset?: Point,
): TableGeometry;
export function resizedStructuredGeometry(
  item: StructuredResizeItem,
  handle: StructuredResizeHandle,
  localPointer: Point,
  grabOffset?: Point,
): TableGeometry | ZoneGeometry;
export function resizedStructuredGeometry(
  item: StructuredResizeItem,
  handle: StructuredResizeHandle,
  localPointer: Point,
  grabOffset: Point = [0, 0],
): TableGeometry | ZoneGeometry {
  const pointer: Point = [localPointer[0] - grabOffset[0], localPointer[1] - grabOffset[1]];
  if (item.kind === "zone") {
    return {
      ...item.geometry,
      width: roundBoard(Math.max(MIN_RESIZED_ZONE_WIDTH, pointer[0] - item.geometry.x)),
      height: roundBoard(Math.max(MIN_RESIZED_ZONE_HEIGHT, pointer[1] - item.geometry.y)),
    };
  }

  const geometry = item.geometry;
  if (handle.kind === "table-column") {
    if (handle.index < 0 || handle.index >= geometry.columnWidths.length) return geometry;
    const columnStart = geometry.x + sumBefore(geometry.columnWidths, handle.index);
    const columnWidths = [...geometry.columnWidths];
    columnWidths[handle.index] = roundBoard(
      Math.max(MIN_RESIZED_TABLE_COLUMN_WIDTH, pointer[0] - columnStart),
    );
    return { ...geometry, columnWidths };
  }
  if (handle.kind === "table-row") {
    if (handle.index < 0 || handle.index >= geometry.rowHeights.length) return geometry;
    const rowStart = geometry.y + sumBefore(geometry.rowHeights, handle.index);
    const rowHeights = [...geometry.rowHeights];
    rowHeights[handle.index] = roundBoard(
      Math.max(MIN_RESIZED_TABLE_ROW_HEIGHT, pointer[1] - rowStart),
    );
    return { ...geometry, rowHeights };
  }

  const targetWidth = Math.max(
    MIN_RESIZED_TABLE_COLUMN_WIDTH * geometry.columnWidths.length,
    pointer[0] - geometry.x,
  );
  const targetHeight = Math.max(
    MIN_RESIZED_TABLE_ROW_HEIGHT * geometry.rowHeights.length,
    pointer[1] - geometry.y,
  );
  return {
    ...geometry,
    columnWidths: scaleSizes(geometry.columnWidths, targetWidth, MIN_RESIZED_TABLE_COLUMN_WIDTH),
    rowHeights: scaleSizes(geometry.rowHeights, targetHeight, MIN_RESIZED_TABLE_ROW_HEIGHT),
  };
}

export function buildCapturedStructuredResizeOperation(
  capture: CapturedStructuredResize,
  geometry: TableGeometry | ZoneGeometry,
): BatchItemOperation {
  return {
    kind: "item.update",
    itemId: capture.item.id,
    expectedVersion: capture.expectedVersion,
    patch: { geometry },
  };
}

function scaleSizes(sizes: readonly number[], targetTotal: number, minimum: number): number[] {
  const total = roundBoard(Math.max(minimum * sizes.length, targetTotal));
  const weights = sizes.map((size) => Math.max(Number.EPSILON, size));
  const result = Array.from({ length: sizes.length }, () => 0);
  const active = new Set(sizes.map((_size, index) => index));
  let remainingTotal = total;
  let remainingWeight = sum(weights);

  while (active.size > 0 && remainingWeight > 0) {
    const newlyClamped = [...active].filter(
      (index) => (remainingTotal * (weights[index] ?? 0)) / remainingWeight < minimum,
    );
    if (newlyClamped.length === 0) break;
    for (const index of newlyClamped) {
      result[index] = minimum;
      remainingTotal -= minimum;
      remainingWeight -= weights[index] ?? 0;
      active.delete(index);
    }
  }

  if (active.size > 0 && remainingWeight > 0) {
    for (const index of active) {
      result[index] = roundBoard((remainingTotal * (weights[index] ?? 0)) / remainingWeight);
    }
    const residual = roundBoard(total - sum(result));
    if (residual !== 0) {
      const adjustmentIndex = [...active].reduce((largest, index) =>
        (result[index] ?? 0) > (result[largest] ?? 0) ? index : largest,
      );
      result[adjustmentIndex] = roundBoard((result[adjustmentIndex] ?? minimum) + residual);
    }
  }
  return result;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumBefore(values: readonly number[], index: number): number {
  return sum(values.slice(0, index));
}

function sumThrough(values: readonly number[], index: number): number {
  return sum(values.slice(0, index + 1));
}
