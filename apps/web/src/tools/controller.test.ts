import { describe, expect, it } from "vitest";
import type { Matrix } from "../types";
import {
  buildCapturedDeleteOperations,
  buildCapturedMoveOperations,
  buildCapturedTextUpdate,
  type CapturedMoveItem,
} from "./controller";

const ITEM_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abd";

describe("captured gesture operations", () => {
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
});
