import { describe, expect, it } from "vitest";
import type { Matrix } from "../types";
import {
  buildCapturedDeleteOperations,
  buildCapturedMoveOperations,
  buildCapturedTextUpdate,
  buildImageCreateOperation,
  buildStampCreateOperation,
  buildStickyCreateOperation,
  buildTableCreateOperation,
  buildZoneCreateOperation,
  type CapturedMoveItem,
  defaultImageCardSize,
  stickyTapMoveThreshold,
  tableCellAtPoint,
  tapAdjustedMovePoint,
  toolFromShortcut,
} from "./controller";

const ITEM_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abd";

describe("captured gesture operations", () => {
  it("uses a finger-friendly CSS-pixel tolerance for sticky double taps", () => {
    expect(stickyTapMoveThreshold("touch", 1)).toBe(10);
    expect(stickyTapMoveThreshold("touch", 2)).toBe(5);
    expect(stickyTapMoveThreshold("mouse", 1)).toBe(3);
  });

  it("suppresses mouse tap jitter before move finalization", () => {
    const start = [20, 30] as const;
    expect(tapAdjustedMovePoint(start, [22.9, 30], "mouse", 1)).toBe(start);
    expect(tapAdjustedMovePoint(start, [23.1, 30], "mouse", 1)).toEqual([23.1, 30]);
  });

  it("distinguishes a touch stamp tap from a drag at the current zoom", () => {
    const start = [40, 50] as const;
    expect(tapAdjustedMovePoint(start, [44.9, 50], "touch", 2)).toBe(start);
    expect(tapAdjustedMovePoint(start, [45.1, 50], "touch", 2)).toEqual([45.1, 50]);
  });

  it("does not activate editing shortcuts while drawing is read only", () => {
    expect(toolFromShortcut("n", false)).toBeUndefined();
    expect(toolFromShortcut("N", true)).toBe("sticky");
    expect(toolFromShortcut("k", false)).toBeUndefined();
    expect(toolFromShortcut("K", true)).toBe("stamp");
    expect(toolFromShortcut("i", false)).toBeUndefined();
    expect(toolFromShortcut("I", true)).toBe("image");
    expect(toolFromShortcut("g", false)).toBeUndefined();
    expect(toolFromShortcut("G", true)).toBe("table");
    expect(toolFromShortcut("z", false)).toBeUndefined();
    expect(toolFromShortcut("Z", true)).toBe("zone");
    expect(toolFromShortcut("v", false)).toBe("select");
    expect(toolFromShortcut("h", false)).toBe("pan");
  });

  it("uses the move version and transform captured at pointer down", () => {
    const transform: Matrix = [1, 0, 0, 1, 4, 7];
    const captured = new Map<string, CapturedMoveItem>([
      [ITEM_ID, { transform, expectedVersion: 3 }],
    ]);

    expect(buildCapturedMoveOperations(captured, { x: 10, y: -2 })).toEqual([
      {
        kind: "item.update",
        itemId: ITEM_ID,
        expectedVersion: 3,
        patch: { transform: [1, 0, 0, 1, 14, 5] },
      },
    ]);
  });

  it("uses the first version captured by the eraser", () => {
    const captured = new Map([[ITEM_ID, 8]]);

    expect(buildCapturedDeleteOperations(captured)).toEqual([
      { kind: "item.delete", itemId: ITEM_ID, expectedVersion: 8 },
    ]);
  });

  it("uses the text version and geometry captured when editing opened", () => {
    expect(
      buildCapturedTextUpdate(
        {
          itemId: ITEM_ID,
          expectedVersion: 13,
          geometry: { x: 20, y: 30, text: "before" },
        },
        "after",
      ),
    ).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 13,
      patch: { geometry: { x: 20, y: 30, text: "after" } },
    });
  });

  it("creates a default-sized sticky and updates its captured text geometry", () => {
    const create = buildStickyCreateOperation(
      ITEM_ID,
      [12, 34],
      {
        stickyFill: "#fecdd3",
        stickyTextColor: "#292524",
        stickyFontSize: 20,
        stickyOpacity: 1,
      },
      "",
    );
    expect(create).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "sticky",
        style: {
          kind: "sticky",
          fill: "#fecdd3",
          textColor: "#292524",
          fontSize: 20,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 12, y: 34, width: 180, height: 140, text: "" },
      },
    });
    expect(
      buildCapturedTextUpdate(
        {
          itemId: ITEM_ID,
          expectedVersion: 9,
          geometry: { x: 12, y: 34, width: 180, height: 140, text: "" },
        },
        "group idea",
      ),
    ).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 9,
      patch: {
        geometry: { x: 12, y: 34, width: 180, height: 140, text: "group idea" },
      },
    });
  });

  it("creates a centered default-sized stamp with the selected design and colour", () => {
    expect(
      buildStampCreateOperation(ITEM_ID, [72, 96], {
        stampKind: "sparkle",
        stampColor: "#8e4ec6",
        stampOpacity: 0.75,
      }),
    ).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "stamp",
        style: { kind: "stamp", color: "#8e4ec6", opacity: 0.75 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 72, y: 96, size: 72, stamp: "sparkle" },
      },
    });
  });

  it("creates an aspect-preserving image card with metadata only", () => {
    expect(defaultImageCardSize(1_200, 800)).toEqual({ width: 360, height: 240 });
    expect(defaultImageCardSize(800, 1_600)).toEqual({ width: 140, height: 280 });

    const operation = buildImageCreateOperation(ITEM_ID, [400, 300], {
      assetId: `asset_${"a".repeat(43)}`,
      mimeType: "image/webp",
      intrinsicWidth: 1_200,
      intrinsicHeight: 800,
    });

    expect(operation).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "image",
        style: { kind: "image", opacity: 1, radius: 12 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: 220,
          y: 180,
          width: 360,
          height: 240,
          assetId: `asset_${"a".repeat(43)}`,
          mimeType: "image/webp",
          intrinsicWidth: 1_200,
          intrinsicHeight: 800,
        },
      },
    });
    expect(JSON.stringify(operation)).not.toMatch(/data:|blob:|base64|ArrayBuffer/u);
  });

  it("creates a centered, readable 3 by 3 table and clamps the classroom size", () => {
    expect(buildTableCreateOperation(ITEM_ID, [400, 300], 3, 3, true)).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "table",
        style: {
          kind: "table",
          borderColor: "#a8a59d",
          fill: "#fffefa",
          headerFill: "#e8edff",
          textColor: "#20201e",
          fontSize: 16,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: 220,
          y: 228,
          columnWidths: [120, 120, 120],
          rowHeights: [48, 48, 48],
          cells: [
            ["", "", ""],
            ["", "", ""],
            ["", "", ""],
          ],
          headerRow: true,
        },
      },
    });

    const capped = buildTableCreateOperation(ITEM_ID, [0, 0], 20, 0);
    if (capped.kind !== "item.create") throw new Error("Expected a table create.");
    expect(capped.item.kind).toBe("table");
    if (capped.item.kind !== "table") throw new Error("Expected a table create.");
    expect(capped.item.geometry.rowHeights).toHaveLength(8);
    expect(capped.item.geometry.columnWidths).toHaveLength(1);
    expect(capped.item.geometry.headerRow).toBeUndefined();
  });

  it("finds a table cell through the item's affine transform", () => {
    const item = {
      transform: [0, 1, -1, 0, 300, 10] as Matrix,
      geometry: {
        x: 10,
        y: 20,
        columnWidths: [100, 120],
        rowHeights: [40, 50],
        cells: [
          ["a", "b"],
          ["c", "d"],
        ],
      },
    };

    expect(tableCellAtPoint(item, [220, 170])).toEqual({ row: 1, column: 1 });
    expect(tableCellAtPoint(item, [400, 170])).toBeNull();
  });

  it("creates a centered classroom zone with a readable default title", () => {
    expect(buildZoneCreateOperation(ITEM_ID, [400, 300])).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "zone",
        style: {
          kind: "zone",
          borderColor: "#a8a59d",
          fill: "#e8edff",
          textColor: "#4f5b75",
          fontSize: 18,
          opacity: 0.18,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 140, y: 140, width: 520, height: 320, title: "Zone" },
      },
    });
  });
});
