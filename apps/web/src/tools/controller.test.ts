import { describe, expect, it } from "vitest";
import type { BoardItem, Matrix } from "../types";
import {
  buildCapturedCardResizeOperation,
  buildCapturedDeleteOperations,
  buildCapturedMoveOperations,
  buildCapturedTextUpdate,
  buildImageCreateOperation,
  buildShapeCreateOperation,
  buildStampCreateOperation,
  buildStickyCreateOperation,
  buildTableCreateOperation,
  buildZoneCreateOperation,
  type CapturedMoveItem,
  cardResizeGrabOffset,
  defaultImageCardSize,
  lineCreationReleaseAction,
  resizedCardGeometry,
  resolveConnectorEndpoint,
  resolveProtractorCenterMove,
  resolveShapePointerState,
  selectionHitPadding,
  shapeGeometry,
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

  it("arms a first line click for mouse and touch, then commits the second click", () => {
    expect(lineCreationReleaseAction("first", [20, 30], [22.9, 30], "mouse", 1)).toBe("arm");
    expect(lineCreationReleaseAction("first", [20, 30], [24.9, 30], "touch", 2)).toBe("arm");
    expect(lineCreationReleaseAction("first", [20, 30], [23.1, 30], "mouse", 1)).toBe("commit");
    expect(lineCreationReleaseAction("second", [20, 30], [20, 30], "touch", 1)).toBe("commit");
  });

  it("keeps selection padding comfortable in CSS pixels across zoom levels", () => {
    expect(selectionHitPadding("mouse", 1)).toBe(5);
    expect(selectionHitPadding("mouse", 2)).toBe(2.5);
    expect(selectionHitPadding("touch", 1)).toBe(16);
    expect(selectionHitPadding("touch", 0.5)).toBe(32);
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

  it("resolves connector snapping in CSS pixels at the current zoom", () => {
    let receivedThreshold = 0;
    const anchor = {
      itemId: ITEM_ID,
      point: [100, 50] as const,
      z: 4,
      distance: 7,
    };
    const model = {
      nearestConnectorAnchor: (_point: readonly [number, number], threshold: number) => {
        receivedThreshold = threshold;
        return anchor;
      },
    };

    expect(resolveConnectorEndpoint(model, [94, 53], 2)).toEqual({ point: [100, 50], anchor });
    expect(receivedThreshold).toBe(8);
  });

  it("keeps an acquired line-edge snap locked through small release jitter", () => {
    const anchor = {
      itemId: ITEM_ID,
      point: [100, 50] as const,
      z: 4,
      distance: 1,
      source: "edge" as const,
    };
    const model = { nearestConnectorAnchor: () => undefined };

    const retained = resolveShapePointerState("line", [119, 50], false, model, 1, true, anchor);
    expect(retained).toEqual({ current: [100, 50], constrained: false, endAnchor: anchor });

    const released = resolveShapePointerState("line", [125, 50], false, model, 1, true, anchor);
    expect(released).toEqual({ current: [125, 50], constrained: false });
  });

  it("snaps a moved protractor center while excluding the protractor itself", () => {
    let excluded: ReadonlySet<string> | undefined;
    const anchor = {
      itemId: "018f47a1-7a2b-7c3d-8e4f-123456789abe",
      point: [130, 100] as const,
      z: 3,
      distance: 2,
      source: "edge" as const,
    };
    const model = {
      nearestConnectorAnchor: (
        _point: readonly [number, number],
        _threshold: number,
        excludedItemIds?: ReadonlySet<string>,
      ) => {
        excluded = excludedItemIds;
        return anchor;
      },
    };

    const resolved = resolveProtractorCenterMove(
      [150, 150],
      [182, 148],
      [100, 100],
      ITEM_ID,
      model,
      1,
    );

    expect(resolved).toEqual({
      current: [180, 150],
      center: [130, 100],
      anchor,
    });
    expect(excluded?.has(ITEM_ID)).toBe(true);
  });

  it("uses a pointerup-only final coordinate when resolving a connector snap", () => {
    const anchor = {
      itemId: ITEM_ID,
      point: [120, 80] as const,
      z: 4,
      distance: 5,
    };
    const release = resolveShapePointerState(
      "line",
      [116, 77],
      false,
      { nearestConnectorAnchor: () => anchor },
      1,
    );

    expect(release).toEqual({ current: [120, 80], constrained: false, endAnchor: anchor });
    expect(
      shapeGeometry("line", [10, 20], release.current, release.constrained, !!release.endAnchor),
    ).toEqual({ x1: 10, y1: 20, x2: 120, y2: 80 });
  });

  it("uses final pointerup Shift state while snapped endpoints retain precedence", () => {
    const noAnchor = { nearestConnectorAnchor: () => undefined };
    const shiftedRelease = resolveShapePointerState("line", [10, 3], true, noAnchor, 1);
    const unconstrainedRelease = resolveShapePointerState("line", [10, 3], false, noAnchor, 1);
    const shiftedGeometry = shapeGeometry(
      "line",
      [0, 0],
      shiftedRelease.current,
      shiftedRelease.constrained,
      !!shiftedRelease.endAnchor,
    );
    const unconstrainedGeometry = shapeGeometry(
      "line",
      [0, 0],
      unconstrainedRelease.current,
      unconstrainedRelease.constrained,
      !!unconstrainedRelease.endAnchor,
    );
    expect(shiftedGeometry).not.toEqual(unconstrainedGeometry);
    expect(unconstrainedGeometry).toEqual({ x1: 0, y1: 0, x2: 10, y2: 3 });

    const anchor = { itemId: ITEM_ID, point: [10, 3] as const, z: 4, distance: 1 };
    const snappedRelease = resolveShapePointerState(
      "line",
      [9, 3],
      true,
      { nearestConnectorAnchor: () => anchor },
      1,
    );
    expect(
      shapeGeometry(
        "line",
        [0, 0],
        snappedRelease.current,
        snappedRelease.constrained,
        !!snappedRelease.endAnchor,
      ),
    ).toEqual({ x1: 0, y1: 0, x2: 10, y2: 3 });
  });

  it("preserves square and rectangle subtypes in local and remote geometry", () => {
    expect(shapeGeometry("rectangle", [10, 20], [90, 55], true, false, "square")).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 80,
      shape: "square",
    });
    expect(shapeGeometry("rectangle", [10, 20], [90, 55], false, false, "rectangle")).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 35,
      shape: "rectangle",
    });
  });

  it("persists connector endpoints as absolute geometry with its arrow variant", () => {
    expect(
      buildShapeCreateOperation(
        ITEM_ID,
        "line",
        { x1: 12, y1: 34, x2: 156, y2: 78 },
        { kind: "line", color: "#20201e", width: 4, opacity: 1, arrowhead: "arrow" },
      ),
    ).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "line",
        style: { kind: "line", color: "#20201e", width: 4, opacity: 1, arrowhead: "arrow" },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x1: 12, y1: 34, x2: 156, y2: 78 },
      },
    });
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
        geometry: { x: 72, y: 96, size: 36, stamp: "sparkle" },
      },
    });
  });

  it("freely resizes sticky cards from the southeast corner with classroom-safe minimums", () => {
    const item: Extract<BoardItem, { kind: "sticky" }> = {
      id: ITEM_ID,
      kind: "sticky",
      z: 2,
      version: 7,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "sticky",
        fill: "#fde68a",
        textColor: "#292524",
        fontSize: 20,
        opacity: 1,
      },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "An idea" },
    };

    const offCenterGrab: [number, number] = [174, 149];
    const grabOffset = cardResizeGrabOffset(item, offCenterGrab);
    expect(grabOffset).toEqual([-16, -11]);
    expect(resizedCardGeometry(item, offCenterGrab, grabOffset)).toEqual(item.geometry);
    expect(resizedCardGeometry(item, [204, 164], grabOffset)).toEqual({
      ...item.geometry,
      width: 210,
      height: 155,
    });

    expect(resizedCardGeometry(item, [260, 220])).toEqual({
      ...item.geometry,
      width: 250,
      height: 200,
    });
    const minimum = resizedCardGeometry(item, [20, 30]);
    expect(minimum).toEqual({ ...item.geometry, width: 96, height: 72 });
    expect(buildCapturedCardResizeOperation({ item, expectedVersion: 7 }, minimum)).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 7,
      patch: { geometry: { ...item.geometry, width: 96, height: 72 } },
    });
  });

  it("preserves image card aspect ratio and immutable metadata while resizing", () => {
    const item: Extract<BoardItem, { kind: "image" }> = {
      id: ITEM_ID,
      kind: "image",
      z: 3,
      version: 11,
      createdBy: "coach-a",
      transform: [1, 0, 0, 1, 12, 18],
      style: { kind: "image", opacity: 1, radius: 12 },
      geometry: {
        x: 10,
        y: 20,
        width: 200,
        height: 100,
        assetId: `asset_${"a".repeat(43)}`,
        alt: "Classroom diagram",
        mimeType: "image/webp",
        intrinsicWidth: 1_200,
        intrinsicHeight: 600,
      },
    };

    expect(resizedCardGeometry(item, [410, 220])).toEqual({
      ...item.geometry,
      width: 400,
      height: 200,
    });
    expect(resizedCardGeometry(item, [10, 20])).toEqual({
      ...item.geometry,
      width: 144,
      height: 72,
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
          borderColor: "#d4d4d4",
          fill: "#ffffff",
          headerFill: "#d3bdff",
          textColor: "#1e1e1e",
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
          borderColor: "#d4d4d4",
          fill: "#a8daff",
          textColor: "#1e1e1e",
          fontSize: 18,
          opacity: 0.18,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 140, y: 140, width: 520, height: 320, title: "Section" },
      },
    });
  });
});
