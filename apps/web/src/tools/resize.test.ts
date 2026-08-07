import { describe, expect, it } from "vitest";
import type { BoardItem } from "../types";
import {
  buildCapturedStructuredResizeOperation,
  MIN_RESIZED_TABLE_COLUMN_WIDTH,
  MIN_RESIZED_TABLE_ROW_HEIGHT,
  MIN_RESIZED_ZONE_HEIGHT,
  MIN_RESIZED_ZONE_WIDTH,
  resizedStructuredGeometry,
  structuredResizeGrabOffset,
  structuredResizeTarget,
} from "./resize";

const TABLE_ID = "019fd0b4-f8ae-7000-8000-000000000401";
const ZONE_ID = "019fd0b4-f8ae-7000-8000-000000000402";

function tableItem(): Extract<BoardItem, { kind: "table" }> {
  return {
    id: TABLE_ID,
    kind: "table",
    z: 4,
    version: 7,
    createdBy: "student-a",
    transform: [1, 0, 0, 1, 12, 18],
    style: {
      kind: "table",
      borderColor: "#a8a59d",
      fill: "#fffefa",
      headerFill: "#e8edff",
      textColor: "#20201e",
      fontSize: 16,
      opacity: 1,
    },
    geometry: {
      x: 10,
      y: 20,
      columnWidths: [100, 140, 160],
      rowHeights: [40, 50],
      cells: [
        ["A", "B", "C"],
        ["D", "E", "F"],
      ],
      headerRow: true,
    },
  };
}

function zoneItem(): Extract<BoardItem, { kind: "zone" }> {
  return {
    id: ZONE_ID,
    kind: "zone",
    z: 2,
    version: 3,
    createdBy: "coach-a",
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "zone",
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18,
      opacity: 0.18,
    },
    geometry: { x: 20, y: 30, width: 520, height: 320, title: "Evidence" },
  };
}

describe("structured item resizing", () => {
  it("resizes zones from an off-centre southeast grab and enforces readable minimums", () => {
    const item = zoneItem();
    const handle = { kind: "southeast" } as const;
    expect(structuredResizeTarget(item, handle)).toEqual([540, 350]);
    const grabOffset = structuredResizeGrabOffset(item, handle, [532, 344]);
    expect(grabOffset).toEqual([-8, -6]);
    expect(resizedStructuredGeometry(item, handle, [532, 344], grabOffset)).toEqual(item.geometry);
    expect(resizedStructuredGeometry(item, handle, [650, 420], grabOffset)).toEqual({
      ...item.geometry,
      width: 638,
      height: 396,
    });
    expect(resizedStructuredGeometry(item, handle, [0, 0])).toEqual({
      ...item.geometry,
      width: MIN_RESIZED_ZONE_WIDTH,
      height: MIN_RESIZED_ZONE_HEIGHT,
    });
  });

  it("resizes a whole table proportionally without changing cells or header state", () => {
    const item = tableItem();
    const geometry = resizedStructuredGeometry(item, { kind: "southeast" }, [810, 200]);
    expect(geometry.columnWidths).toEqual([200, 280, 320]);
    expect(geometry.rowHeights).toEqual([80, 100]);
    expect(geometry.cells).toEqual(item.geometry.cells);
    expect(geometry.headerRow).toBe(true);

    const minimum = resizedStructuredGeometry(item, { kind: "southeast" }, [0, 0]);
    expect(minimum.columnWidths).toEqual([
      MIN_RESIZED_TABLE_COLUMN_WIDTH,
      MIN_RESIZED_TABLE_COLUMN_WIDTH,
      MIN_RESIZED_TABLE_COLUMN_WIDTH,
    ]);
    expect(minimum.rowHeights).toEqual([
      MIN_RESIZED_TABLE_ROW_HEIGHT,
      MIN_RESIZED_TABLE_ROW_HEIGHT,
    ]);

    const uneven = tableItem();
    uneven.geometry.columnWidths = [10, 100, 100];
    const clamped = resizedStructuredGeometry(uneven, { kind: "southeast" }, [240, 110]);
    expect(clamped.columnWidths).toEqual([64, 83, 83]);
    expect(clamped.columnWidths.reduce((total, width) => total + width, 0)).toBe(230);
  });

  it("resizes one table column or row while preserving every sibling size", () => {
    const item = tableItem();
    const columnHandle = { kind: "table-column", index: 1 } as const;
    expect(structuredResizeTarget(item, columnHandle)).toEqual([250, 20]);
    const columnOffset = structuredResizeGrabOffset(item, columnHandle, [246, 70]);
    expect(columnOffset).toEqual([-4, 50]);
    expect(resizedStructuredGeometry(item, columnHandle, [306, 999], columnOffset)).toEqual({
      ...item.geometry,
      columnWidths: [100, 200, 160],
    });
    expect(resizedStructuredGeometry(item, columnHandle, [0, 0]).columnWidths).toEqual([
      100,
      MIN_RESIZED_TABLE_COLUMN_WIDTH,
      160,
    ]);

    const rowHandle = { kind: "table-row", index: 0 } as const;
    expect(structuredResizeTarget(item, rowHandle)).toEqual([10, 60]);
    const rowOffset = structuredResizeGrabOffset(item, rowHandle, [80, 55]);
    expect(rowOffset).toEqual([70, -5]);
    expect(resizedStructuredGeometry(item, rowHandle, [999, 105], rowOffset)).toEqual({
      ...item.geometry,
      rowHeights: [90, 50],
    });
    expect(resizedStructuredGeometry(item, rowHandle, [0, 0]).rowHeights).toEqual([
      MIN_RESIZED_TABLE_ROW_HEIGHT,
      50,
    ]);
  });

  it("builds one normal version-checked item update for collaboration and attribution", () => {
    const item = zoneItem();
    const geometry = { ...item.geometry, width: 640, height: 420 };
    expect(
      buildCapturedStructuredResizeOperation(
        { item, expectedVersion: item.version, handle: { kind: "southeast" } },
        geometry,
      ),
    ).toEqual({
      kind: "item.update",
      itemId: ZONE_ID,
      expectedVersion: 3,
      patch: { geometry },
    });
  });
});
