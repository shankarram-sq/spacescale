import { describe, expect, it } from "vitest";
import type { BoardItem } from "../types";
import { eraseStrokeItem, isPartiallyErasableItem } from "./stroke-erase";

const ACTOR_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abc";
const ITEM_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abd";

function line(overrides: Partial<Extract<BoardItem, { kind: "line" }>> = {}) {
  return {
    id: ITEM_ID,
    kind: "line" as const,
    z: 1,
    version: 1,
    createdBy: ACTOR_ID,
    style: {
      kind: "line" as const,
      color: "#1e1e1e",
      width: 4,
      opacity: 1,
      arrowhead: "none" as const,
    },
    transform: [1, 0, 0, 1, 0, 0] as const,
    geometry: { x1: 0, y1: 0, x2: 100, y2: 0 },
    ...overrides,
  } satisfies Extract<BoardItem, { kind: "line" }>;
}

function rectangle(): Extract<BoardItem, { kind: "rectangle" }> {
  return {
    id: ITEM_ID,
    kind: "rectangle",
    z: 1,
    version: 1,
    createdBy: ACTOR_ID,
    style: { kind: "stroke", color: "#1e1e1e", width: 4, opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 100, height: 50, shape: "rectangle" },
  };
}

describe("partial stroke erasing", () => {
  it("recognizes only line and shape-outline items", () => {
    expect(isPartiallyErasableItem(line())).toBe(true);
    expect(isPartiallyErasableItem(rectangle())).toBe(true);
    expect(
      isPartiallyErasableItem({
        id: ITEM_ID,
        kind: "protractor",
        z: 1,
        version: 1,
        createdBy: ACTOR_ID,
        style: { kind: "protractor", color: "#874fff", opacity: 0.8 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { radius: 120 },
      }),
    ).toBe(false);
  });

  it("splits the middle of a line without changing its identity-bearing geometry", () => {
    const result = eraseStrokeItem(line(), [[50, 0]], 10);

    expect(result).toEqual({
      visiblePaths: [
        [
          [0, 0],
          [38, 0],
        ],
        [
          [62, 0],
          [100, 0],
        ],
      ],
      erased: false,
    });
  });

  it("clips a complete swept capsule rather than sparse pointer samples", () => {
    const result = eraseStrokeItem(
      line(),
      [
        [35, -20],
        [65, 20],
      ],
      3,
    );

    expect(result).not.toBeNull();
    expect(result?.erased).toBe(false);
    expect(result?.visiblePaths).toHaveLength(2);
    const leftEnd = result?.visiblePaths[0]?.at(-1)?.[0] ?? 0;
    const rightStart = result?.visiblePaths[1]?.[0]?.[0] ?? 0;
    expect(leftEnd).toBeLessThan(50);
    expect(rightStart).toBeGreaterThan(50);
  });

  it("returns local visible paths for transformed items", () => {
    const transformed = line({ transform: [0, 2, -2, 0, 200, 100] });
    const result = eraseStrokeItem(transformed, [[200, 200]], 8);

    expect(result).not.toBeNull();
    expect(result?.visiblePaths).toHaveLength(2);
    expect(result?.visiblePaths[0]?.[0]).toEqual([0, 0]);
    expect(result?.visiblePaths[1]?.at(-1)).toEqual([100, 0]);
    expect(result?.visiblePaths[0]?.at(-1)?.[0]).toBeLessThan(50);
    expect(result?.visiblePaths[1]?.[0]?.[0]).toBeGreaterThan(50);
  });

  it("uses an existing visible gap instead of restoring the original line", () => {
    const cut = line({
      geometry: {
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        visiblePaths: [
          [
            [0, 0],
            [30, 0],
          ],
          [
            [70, 0],
            [100, 0],
          ],
        ],
      },
    });

    expect(eraseStrokeItem(cut, [[50, 0]], 5)).toBeNull();
  });

  it("turns a cut closed outline into open surviving paths", () => {
    const result = eraseStrokeItem(
      rectangle(),
      [
        [50, -10],
        [50, 10],
      ],
      5,
    );

    expect(result).not.toBeNull();
    expect(result?.erased).toBe(false);
    expect(result?.visiblePaths.length).toBeGreaterThan(0);
    for (const path of result?.visiblePaths ?? []) {
      expect(path.length).toBeGreaterThanOrEqual(2);
      expect(path[0]).not.toEqual(path.at(-1));
    }
  });

  it("reports full removal so the caller can delete the original item", () => {
    expect(eraseStrokeItem(line(), [[50, 0]], 100)).toEqual({ visiblePaths: [], erased: true });
  });

  it("returns null when the sweep does not touch a visible stroke", () => {
    expect(eraseStrokeItem(line(), [[50, 40]], 5)).toBeNull();
  });
});
