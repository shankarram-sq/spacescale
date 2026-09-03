import { transformPoint } from "@collab/geometry";
import { describe, expect, it } from "vitest";
import type { BoardItem, Matrix } from "../types";
import {
  buildCapturedObjectTransformOperation,
  MIN_SCALED_IMAGE_SIDE,
  objectLocalCenter,
  objectScaleGrabOffset,
  rotatedMatrixAroundLocalPoint,
  scaledObjectMatrix,
} from "./transform";

const SHAPE_ID = "019fd0b4-f8ae-7000-8000-000000000501";
const IMAGE_ID = "019fd0b4-f8ae-7000-8000-000000000502";

function rectangle(
  transform: Matrix = [1, 0, 0, 1, 0, 0],
): Extract<BoardItem, { kind: "rectangle" }> {
  return {
    id: SHAPE_ID,
    kind: "rectangle",
    z: 1,
    version: 4,
    createdBy: "019fd0b4-f8ae-7000-8000-000000000503",
    transform,
    style: { kind: "stroke", color: "#20201e", width: 4, opacity: 1 },
    geometry: { x: 10, y: 20, width: 100, height: 60, shape: "rectangle" },
  };
}

function image(transform: Matrix = [1, 0, 0, 1, 0, 0]): Extract<BoardItem, { kind: "image" }> {
  return {
    id: IMAGE_ID,
    kind: "image",
    z: 2,
    version: 7,
    createdBy: "019fd0b4-f8ae-7000-8000-000000000503",
    transform,
    style: { kind: "image", opacity: 1, radius: 12 },
    geometry: {
      x: 40,
      y: 50,
      width: 200,
      height: 100,
      assetId: "asset_0123456789abcdefghjkmnpqrs",
      mimeType: "image/png",
      intrinsicWidth: 800,
      intrinsicHeight: 400,
    },
  };
}

describe("object transforms", () => {
  it("uniformly scales a shape around its opposite corner", () => {
    const item = rectangle([0, 1, -1, 0, 240, 10]);
    const pivot = transformPoint([10, 20], item.transform);
    const corner = transformPoint([110, 80], item.transform);
    const pointer = [
      pivot[0] + (corner[0] - pivot[0]) * 1.5,
      pivot[1] + (corner[1] - pivot[1]) * 1.5,
    ] as const;

    const next = scaledObjectMatrix(item, pointer);

    expect(transformPoint([10, 20], next)).toEqual(pivot);
    expect(Math.hypot(next[0], next[1])).toBeCloseTo(1.5, 5);
    expect(Math.hypot(next[2], next[3])).toBeCloseTo(1.5, 5);
    expect(item.geometry).toEqual({ x: 10, y: 20, width: 100, height: 60, shape: "rectangle" });
  });

  it("preserves an off-centre grab and enforces the minimum image side", () => {
    const item = image();
    const grabOffset = objectScaleGrabOffset(item, [245, 154]);
    expect(grabOffset).toEqual([5, 4]);
    expect(scaledObjectMatrix(item, [245, 154], grabOffset)).toEqual(item.transform);

    const minimum = scaledObjectMatrix(item, [40, 50]);
    expect(Math.hypot(minimum[2], minimum[3]) * item.geometry.height).toBe(MIN_SCALED_IMAGE_SIDE);
  });

  it("rotates translated shapes and images around their visual center", () => {
    for (const item of [rectangle([1, 0, 0, 1, 30, -10]), image([0.5, 0, 0, 0.5, 12, 18])]) {
      const localPivot = objectLocalCenter(item);
      const before = transformPoint(localPivot, item.transform);
      const next = rotatedMatrixAroundLocalPoint(item.transform, Math.PI / 2, localPivot);
      expect(transformPoint(localPivot, next)).toEqual(before);
    }
  });

  it("builds a normal version-checked transform update", () => {
    const item = rectangle();
    expect(
      buildCapturedObjectTransformOperation(
        { item, expectedVersion: item.version },
        [0, 1, -1, 0, 200, 20],
      ),
    ).toEqual({
      kind: "item.update",
      itemId: SHAPE_ID,
      expectedVersion: 4,
      patch: { transform: [0, 1, -1, 0, 200, 20] },
    });
  });
});
