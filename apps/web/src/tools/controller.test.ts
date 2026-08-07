import { describe, expect, it } from "vitest";
import type { Matrix } from "../types";
import {
  buildCapturedDeleteOperations,
  buildCapturedMoveOperations,
  buildCapturedTextUpdate,
  buildStampCreateOperation,
  buildStickyCreateOperation,
  type CapturedMoveItem,
  stickyTapMoveThreshold,
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
});
