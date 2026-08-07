import { describe, expect, it } from "vitest";

import {
  boundsForItems,
  formatCanonicalNumber,
  GeometryValidationError,
  itemBounds,
  normalizeBoxGeometry,
  normalizePencilGeometry,
  normalizeStickyGeometry,
  normalizeTransform,
  transformBounds,
  translateTransform,
} from "./index.js";

describe("geometry normalization", () => {
  it("rounds coordinates, removes adjacent duplicate points, and preserves order", () => {
    expect(
      normalizePencilGeometry({
        points: [
          [1.234, -0],
          [1.231, 0],
          [2.999, 4.004],
        ],
      }),
    ).toEqual({
      points: [
        [1.23, 0],
        [3, 4],
      ],
    });
  });

  it("canonicalizes boxes dragged in any direction", () => {
    expect(normalizeBoxGeometry({ x: 10, y: 20, width: -4.555, height: -8 })).toEqual({
      x: 5.44,
      y: 12,
      width: 4.56,
      height: 8,
    });
  });

  it("canonicalizes sticky extents while preserving text", () => {
    expect(
      normalizeStickyGeometry({ x: 10, y: 20, width: -4.555, height: -8, text: "Plan" }),
    ).toEqual({
      x: 5.44,
      y: 12,
      width: 4.56,
      height: 8,
      text: "Plan",
    });
  });

  it("requires positive, exact-key sticky geometry", () => {
    expect(() => normalizeStickyGeometry({ x: 0, y: 0, width: 0, height: 10, text: "" })).toThrow(
      /greater than 0/,
    );
    expect(() =>
      normalizeStickyGeometry({ x: 0, y: 0, width: 10, height: 10, text: "", extra: true }),
    ).toThrow(/Unknown field/);
  });

  it("rejects non-finite, out-of-range, and unknown input", () => {
    expect(() => normalizeTransform([1, 0, 0, 1, Number.NaN, 0])).toThrow(GeometryValidationError);
    expect(() => normalizeTransform([1_000_001, 0, 0, 1, 0, 0])).toThrow(/Transform component/);
    expect(() => normalizeBoxGeometry({ x: 1_000_001, y: 0, width: 1, height: 1 })).toThrow(
      /Coordinate/,
    );
    expect(() => normalizeBoxGeometry({ x: 0, y: 0, width: 1, height: 1, onclick: "bad" })).toThrow(
      /Unknown field/,
    );
  });
});

describe("bounds and transforms", () => {
  it("uses all transformed corners for an affine transform", () => {
    expect(transformBounds({ minX: 0, minY: 0, maxX: 10, maxY: 5 }, [0, 1, -1, 0, 20, 30])).toEqual(
      { minX: 15, minY: 30, maxX: 20, maxY: 40 },
    );
  });

  it("includes transformed stroke extents", () => {
    expect(
      itemBounds({
        kind: "line",
        geometry: { x1: 0, y1: 0, x2: 10, y2: 0 },
        transform: [2, 0, 0, 2, 5, 7],
        style: { kind: "stroke", width: 4 },
      }),
    ).toEqual({ minX: 1, minY: 3, maxX: 29, maxY: 11 });
  });

  it("uses the full transformed sticky rectangle", () => {
    expect(
      itemBounds({
        kind: "sticky",
        geometry: { x: 2, y: 3, width: 20, height: 10, text: "Wrapped note" },
        transform: [1, 0, 0, 1, 5, 7],
        style: { kind: "sticky", fontSize: 16 },
      }),
    ).toEqual({ minX: 7, minY: 10, maxX: 27, maxY: 20 });
  });

  it("rejects transformed sticky bounds outside the finite world envelope", () => {
    expect(() =>
      itemBounds({
        kind: "sticky",
        geometry: { x: 1_000_000, y: 0, width: 1, height: 1, text: "Bounded" },
        transform: [2, 0, 0, 1, 0, 0],
        style: { kind: "sticky", fontSize: 16 },
      }),
    ).toThrow(/Transformed item bounds/);
  });

  it("unions item bounds and translates only the affine offset", () => {
    const transform = translateTransform([1, 0, 0, 1, 2, 3], 4.126, -5.555);
    expect(transform).toEqual([1, 0, 0, 1, 6.13, -2.56]);
    expect(
      boundsForItems([
        {
          kind: "rectangle",
          geometry: { x: 0, y: 0, width: 10, height: 10 },
          transform: [1, 0, 0, 1, 0, 0],
          style: { kind: "stroke", width: 2 },
        },
        {
          kind: "rectangle",
          geometry: { x: 20, y: 30, width: 5, height: 5 },
          transform: [1, 0, 0, 1, 0, 0],
          style: { kind: "stroke", width: 2 },
        },
      ]),
    ).toEqual({ minX: -1, minY: -1, maxX: 26, maxY: 36 });
  });
});

describe("canonical number formatting", () => {
  it("normalizes negative zero and exponent notation", () => {
    expect(formatCanonicalNumber(-0)).toBe("0");
    expect(formatCanonicalNumber(1e-7)).toBe("0.0000001");
    expect(formatCanonicalNumber(1.2e21)).toBe("1200000000000000000000");
  });
});
