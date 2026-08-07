import { describe, expect, it } from "vitest";

import {
  boundsForItems,
  formatCanonicalNumber,
  GeometryValidationError,
  imageGeometryContainsPoint,
  isCanonicalImageAssetId,
  itemBounds,
  normalizeBoxGeometry,
  normalizeImageGeometry,
  normalizePencilGeometry,
  normalizeStampGeometry,
  normalizeStickyGeometry,
  normalizeTransform,
  transformBounds,
  translateTransform,
} from "./index.js";

const ASSET_ID = "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

  it("canonicalizes every stamp kind and rejects unsafe centered extents", () => {
    for (const stamp of ["star", "check", "heart", "question", "smile", "sparkle"] as const) {
      expect(normalizeStampGeometry({ x: 1.234, y: -2.345, size: 71.999, stamp })).toEqual({
        x: 1.23,
        y: -2.35,
        size: 72,
        stamp,
      });
    }
    expect(() => normalizeStampGeometry({ x: 0, y: 0, size: 0, stamp: "star" })).toThrow(
      /greater than 0/,
    );
    expect(() => normalizeStampGeometry({ x: 0, y: 0, size: 72, stamp: "award" })).toThrow(
      /Stamp must be one of/,
    );
    expect(() =>
      normalizeStampGeometry({ x: 0, y: 0, size: 72, stamp: "star", extra: true }),
    ).toThrow(/Unknown field/);
    expect(() => normalizeStampGeometry({ x: 1_000_000, y: 0, size: 2, stamp: "star" })).toThrow(
      /Coordinate/,
    );
  });

  it("canonicalizes bounded image cards and omits empty alt text", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif"] as const) {
      expect(
        normalizeImageGeometry({
          x: 10,
          y: 20,
          width: -100.555,
          height: -50.444,
          assetId: ASSET_ID,
          alt: "",
          mimeType,
          intrinsicWidth: 1200,
          intrinsicHeight: 800,
        }),
      ).toEqual({
        x: -90.56,
        y: -30.44,
        width: 100.56,
        height: 50.44,
        assetId: ASSET_ID,
        mimeType,
        intrinsicWidth: 1200,
        intrinsicHeight: 800,
      });
    }
  });

  it("enforces canonical SHA-256 base64url trailing bits in image asset IDs", () => {
    const prefix = `asset_${"A".repeat(42)}`;
    for (const last of ["A", "E", "8"]) {
      expect(isCanonicalImageAssetId(`${prefix}${last}`)).toBe(true);
    }
    for (const last of ["B", "-", "_"]) {
      expect(isCanonicalImageAssetId(`${prefix}${last}`)).toBe(false);
    }
  });

  it("rejects non-canonical image assets, unsupported MIME types, and raw content", () => {
    const valid = {
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      assetId: ASSET_ID,
      mimeType: "image/png",
      intrinsicWidth: 100,
      intrinsicHeight: 80,
    };
    for (const assetId of [
      "https://assets.example/image.png",
      "data:image/png;base64,AAAA",
      "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    ]) {
      expect(() => normalizeImageGeometry({ ...valid, assetId })).toThrow(/base64url SHA-256/);
    }
    expect(() => normalizeImageGeometry({ ...valid, mimeType: "image/svg+xml" })).toThrow(
      /MIME type/,
    );
    expect(() => normalizeImageGeometry({ ...valid, bytes: "AAAA" })).toThrow(/Unknown field/);
    expect(() => normalizeImageGeometry({ ...valid, href: "https://bad.example" })).toThrow(
      /Unknown field/,
    );
  });

  it("enforces positive card/intrinsic dimensions, pixel budget, and safe alt text", () => {
    const valid = {
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      assetId: ASSET_ID,
      mimeType: "image/webp",
      intrinsicWidth: 100,
      intrinsicHeight: 80,
    };
    expect(() => normalizeImageGeometry({ ...valid, width: 0 })).toThrow(/greater than 0/);
    expect(() => normalizeImageGeometry({ ...valid, height: 0 })).toThrow(/greater than 0/);
    expect(() => normalizeImageGeometry({ ...valid, intrinsicWidth: 1.5 })).toThrow(
      /positive integer/,
    );
    expect(() => normalizeImageGeometry({ ...valid, intrinsicHeight: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => normalizeImageGeometry({ ...valid, intrinsicWidth: 4097 })).toThrow(
      /at most 4096/,
    );
    expect(() =>
      normalizeImageGeometry({ ...valid, intrinsicWidth: 4001, intrinsicHeight: 4000 }),
    ).toThrow(/16000000 pixels/);
    expect(() => normalizeImageGeometry({ ...valid, alt: "😀".repeat(501) })).toThrow(
      /at most 500/,
    );
    expect(() => normalizeImageGeometry({ ...valid, alt: "bad\u0000alt" })).toThrow(/control/);
    expect(() => normalizeImageGeometry({ ...valid, alt: "bad\ud800alt" })).toThrow(/surrogate/);
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

  it("uses the transformed square centered on the stamp anchor", () => {
    expect(
      itemBounds({
        kind: "stamp",
        geometry: { x: 10, y: 20, size: 8, stamp: "star" },
        transform: [0, 1, -1, 0, 100, 0],
        style: { kind: "stamp" },
      }),
    ).toEqual({ minX: 76, minY: 6, maxX: 84, maxY: 14 });
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

  it("uses the full transformed image card and inclusive local hit testing", () => {
    const geometry = {
      x: 2,
      y: 3,
      width: 20,
      height: 10,
      assetId: ASSET_ID,
      alt: "Source diagram",
      mimeType: "image/png" as const,
      intrinsicWidth: 200,
      intrinsicHeight: 100,
    };
    expect(
      itemBounds({
        kind: "image",
        geometry,
        transform: [0, 1, -1, 0, 100, 0],
        style: { kind: "image" },
      }),
    ).toEqual({ minX: 87, minY: 2, maxX: 97, maxY: 22 });
    expect(imageGeometryContainsPoint(geometry, [2, 3])).toBe(true);
    expect(imageGeometryContainsPoint(geometry, [22, 13])).toBe(true);
    expect(imageGeometryContainsPoint(geometry, [1.5, 2.5])).toBe(false);
    expect(imageGeometryContainsPoint(geometry, [1.5, 2.5], 0.5)).toBe(true);
    expect(() => imageGeometryContainsPoint(geometry, [5, 5], Number.NaN)).toThrow(/padding/);
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
