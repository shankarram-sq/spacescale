import { describe, expect, it } from "vitest";
import type { BoardItem, Matrix, StickyItem } from "../types";
import { buildArrangeUpdates } from "./arrange";

const identity: Matrix = [1, 0, 0, 1, 0, 0];

function rectangle(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  transform: Matrix = identity,
  version = 1,
): BoardItem {
  return {
    id,
    kind: "rectangle",
    z: 1,
    version,
    createdBy: "actor",
    transform,
    style: { kind: "stroke", color: "#20201e", width: 2, opacity: 1 },
    geometry: { x, y, width, height },
  };
}

function sticky(id: string, x: number, y: number, width = 100, height = 80): StickyItem {
  return {
    id,
    kind: "sticky",
    z: 1,
    version: 2,
    createdBy: "actor",
    transform: identity,
    style: { kind: "sticky", fill: "#fde68a", textColor: "#20201e", fontSize: 18, opacity: 1 },
    geometry: { x, y, width, height, text: id },
  };
}

function translation(update: ReturnType<typeof buildArrangeUpdates>[number]): [number, number] {
  const transform = update.patch.transform;
  if (!transform) throw new Error("Expected a transform patch.");
  return [transform[4], transform[5]];
}

describe("buildArrangeUpdates", () => {
  it("aligns left in world space, preserves the linear matrix, and guards every participant", () => {
    const items = [
      rectangle("b", 20, 0, 10, 10, [0, 1, -1, 0, 40, 5], 4),
      rectangle("a", 0, 0, 10, 10, [1, 0, 0, 1, 5, 7], 3),
    ];
    const updates = buildArrangeUpdates("align-left", items);
    expect(updates.map(({ itemId }) => itemId)).toEqual(["a", "b"]);
    expect(updates.map(({ expectedVersion }) => expectedVersion)).toEqual([3, 4]);
    expect(updates[0]?.patch.transform?.slice(0, 4)).toEqual([1, 0, 0, 1]);
    expect(updates[1]?.patch.transform?.slice(0, 4)).toEqual([0, 1, -1, 0]);
  });

  it("aligns horizontal centers at the selection union center with two-decimal transforms", () => {
    const updates = buildArrangeUpdates("align-horizontal-center", [
      rectangle("a", 0, 0, 10, 10),
      rectangle("b", 20.006, 0, 20, 10),
    ]);
    expect(updates).toHaveLength(2);
    expect(translation(updates[0] as (typeof updates)[number])).toEqual([15, 0]);
    expect(translation(updates[1] as (typeof updates)[number])).toEqual([-10, 0]);
  });

  it("distributes variable widths with equal horizontal gaps and stable spatial ordering", () => {
    const updates = buildArrangeUpdates("distribute-horizontal", [
      rectangle("last", 90, 10, 30, 10),
      rectangle("first", 0, 20, 10, 10),
      rectangle("middle", 25, 0, 20, 10),
    ]);
    expect(updates.map(({ itemId }) => itemId)).toEqual(["first", "middle", "last"]);
    expect(updates.map(translation)).toEqual([
      [0, 0],
      [15, 0],
      [0, 0],
    ]);
  });

  it("distributes vertically and includes unchanged anchors when another item moves", () => {
    const updates = buildArrangeUpdates("distribute-vertical", [
      rectangle("top", 0, 0, 10, 10),
      rectangle("middle", 0, 20, 10, 20),
      rectangle("bottom", 0, 90, 10, 10),
    ]);
    expect(updates.map(translation)).toEqual([
      [0, 0],
      [0, 20],
      [0, 0],
    ]);
  });

  it("tidies selected stickies into a deterministic variable-size grid and ignores other kinds", () => {
    const updates = buildArrangeUpdates("tidy-stickies", [
      sticky("d", 500, 300, 80, 40),
      rectangle("shape", -200, -200, 20, 20),
      sticky("b", 200, 0, 120, 60),
      sticky("a", 0, 0, 100, 80),
      sticky("c", 0, 300, 90, 50),
    ]);
    expect(updates.map(({ itemId }) => itemId)).toEqual(["a", "b", "c", "d"]);
    expect(updates.map(translation)).toEqual([
      [0, 0],
      [-76, 0],
      [0, -196],
      [-376, -196],
    ]);
  });

  it("returns no batch for insufficient, pending, duplicate, or already-arranged selections", () => {
    expect(buildArrangeUpdates("align-left", [rectangle("a", 0, 0, 10, 10)])).toEqual([]);
    expect(
      buildArrangeUpdates("align-top", [
        rectangle("a", 0, 0, 10, 10),
        rectangle("b", 0, 10, 10, 10, identity, 0),
      ]),
    ).toEqual([]);
    expect(
      buildArrangeUpdates("align-left", [
        rectangle("same", 0, 0, 10, 10),
        rectangle("same", 20, 0, 10, 10),
      ]),
    ).toEqual([]);
    expect(
      buildArrangeUpdates("align-top", [
        rectangle("a", 0, 5, 10, 10),
        rectangle("b", 20, 5, 10, 10),
      ]),
    ).toEqual([]);
  });
});
