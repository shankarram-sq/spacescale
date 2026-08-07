export const COORDINATE_LIMIT = 1_000_000;
export const DIMENSION_LIMIT = 2_000_000;
export const TRANSFORM_LINEAR_COMPONENT_LIMIT = COORDINATE_LIMIT;
export const WORLD_COORDINATE_LIMIT = DIMENSION_LIMIT;
export const MAX_PENCIL_POINTS = 10_000;
export const MIN_PENCIL_POINTS = 2;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_IMAGE_ALT_CODE_POINTS = 500;
export const MAX_IMAGE_INTRINSIC_DIMENSION = 4_096;
export const MAX_IMAGE_INTRINSIC_PIXELS = 16_000_000;
export const MAX_TABLE_COLUMNS = 6;
export const MAX_TABLE_ROWS = 8;
export const ZONE_TITLE_PADDING = 12;
export const ZONE_BORDER_HIT_WIDTH = 6;

const IMAGE_ASSET_ID_PATTERN = /^asset_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

export type Point = [number, number];
export type Transform = [number, number, number, number, number, number];

export interface PencilGeometry {
  points: Point[];
}

export interface LineGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextGeometry {
  x: number;
  y: number;
  text: string;
}

export interface StickyGeometry extends BoxGeometry {
  text: string;
}

export interface ZoneGeometry extends BoxGeometry {
  title: string;
}

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export interface ImageGeometry extends BoxGeometry {
  assetId: string;
  alt?: string;
  mimeType: ImageMimeType;
  intrinsicWidth: number;
  intrinsicHeight: number;
}

export const STAMP_KINDS = ["star", "check", "heart", "question", "smile", "sparkle"] as const;
export type StampKind = (typeof STAMP_KINDS)[number];

export interface StampGeometry {
  x: number;
  y: number;
  size: number;
  stamp: StampKind;
}

export interface TableGeometry {
  x: number;
  y: number;
  columnWidths: number[];
  rowHeights: number[];
  cells: string[][];
  headerRow?: boolean;
}

export type ItemGeometry =
  | PencilGeometry
  | LineGeometry
  | BoxGeometry
  | TextGeometry
  | StickyGeometry
  | ZoneGeometry
  | ImageGeometry
  | StampGeometry
  | TableGeometry;

export type GeometryKind =
  | "pencil"
  | "line"
  | "rectangle"
  | "ellipse"
  | "text"
  | "sticky"
  | "zone"
  | "image"
  | "stamp"
  | "table";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BoundsItem {
  kind: GeometryKind;
  geometry: ItemGeometry;
  transform: Transform;
  style:
    | { kind: "stroke"; width: number }
    | { kind: "text"; fontSize: number }
    | { kind: "sticky"; fontSize: number }
    | { kind: "zone"; fontSize: number }
    | { kind: "image" }
    | { kind: "stamp" }
    | { kind: "table"; fontSize: number };
}

export class GeometryValidationError extends Error {
  readonly code = "INVALID_GEOMETRY" as const;

  constructor(
    readonly reason: string,
    readonly path = "$",
  ) {
    super(path === "$" ? reason : `${reason} at ${path}`);
    this.name = "GeometryValidationError";
  }
}

const own = Object.prototype.hasOwnProperty;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GeometryValidationError("Expected an object", path);
  }
  return value;
}

function expectOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new GeometryValidationError(`Unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
  for (const key of allowed) {
    if (!own.call(value, key)) {
      throw new GeometryValidationError(`Missing field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
}

export function canonicalNumber(value: number, decimalPlaces: number): number {
  if (!Number.isFinite(value)) {
    throw new GeometryValidationError("Expected a finite number");
  }
  const scale = 10 ** decimalPlaces;
  const magnitude = Math.abs(value);
  const scaled = (magnitude + Number.EPSILON * Math.max(1, magnitude) * 2) * scale;
  const roundedMagnitude = Number.isFinite(scaled) ? Math.round(scaled) / scale : magnitude;
  // Decimal ties round away from zero. This avoids the surprising asymmetry of
  // Math.round for negative halves and gives one canonical policy everywhere.
  const rounded = Math.sign(value) * roundedMagnitude;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function normalizeCoordinate(value: unknown, path = "$", decimalPlaces = 2): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GeometryValidationError("Expected a finite coordinate", path);
  }
  const normalized = canonicalNumber(value, decimalPlaces);
  if (Math.abs(normalized) > COORDINATE_LIMIT) {
    throw new GeometryValidationError(
      `Coordinate must be between -${COORDINATE_LIMIT} and ${COORDINATE_LIMIT}`,
      path,
    );
  }
  return normalized;
}

export function normalizeDimension(value: unknown, path = "$", decimalPlaces = 2): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GeometryValidationError("Expected a finite dimension", path);
  }
  const normalized = canonicalNumber(value, decimalPlaces);
  if (normalized < 0 || normalized > DIMENSION_LIMIT) {
    throw new GeometryValidationError(`Dimension must be between 0 and ${DIMENSION_LIMIT}`, path);
  }
  return normalized;
}

export function normalizePoint(value: unknown, path = "$point"): Point {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new GeometryValidationError("Expected a two-coordinate point", path);
  }
  return [normalizeCoordinate(value[0], `${path}[0]`), normalizeCoordinate(value[1], `${path}[1]`)];
}

export function normalizeTransform(value: unknown, path = "$transform"): Transform {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new GeometryValidationError("Expected a six-component affine transform", path);
  }
  const normalizeLinearComponent = (component: unknown, index: number): number => {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new GeometryValidationError(
        "Expected a finite transform component",
        `${path}[${index}]`,
      );
    }
    const normalized = canonicalNumber(component, 6);
    if (Math.abs(normalized) > TRANSFORM_LINEAR_COMPONENT_LIMIT) {
      throw new GeometryValidationError(
        `Transform component must be between -${TRANSFORM_LINEAR_COMPONENT_LIMIT} and ${TRANSFORM_LINEAR_COMPONENT_LIMIT}`,
        `${path}[${index}]`,
      );
    }
    return normalized;
  };
  return [
    normalizeLinearComponent(value[0], 0),
    normalizeLinearComponent(value[1], 1),
    normalizeLinearComponent(value[2], 2),
    normalizeLinearComponent(value[3], 3),
    normalizeCoordinate(value[4], `${path}[4]`),
    normalizeCoordinate(value[5], `${path}[5]`),
  ];
}

export function normalizePencilGeometry(value: unknown, path = "$geometry"): PencilGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["points"], path);
  if (!Array.isArray(object.points)) {
    throw new GeometryValidationError("Expected an array of points", `${path}.points`);
  }

  const points: Point[] = [];
  for (let index = 0; index < object.points.length; index += 1) {
    const point = normalizePoint(object.points[index], `${path}.points[${index}]`);
    const previous = points.at(-1);
    if (previous === undefined || previous[0] !== point[0] || previous[1] !== point[1]) {
      points.push(point);
      if (points.length > MAX_PENCIL_POINTS) {
        throw new GeometryValidationError(
          `Pencil geometry may contain at most ${MAX_PENCIL_POINTS} simplified points`,
          `${path}.points`,
        );
      }
    }
  }

  if (points.length < MIN_PENCIL_POINTS) {
    throw new GeometryValidationError(
      `Pencil geometry requires at least ${MIN_PENCIL_POINTS} distinct adjacent points`,
      `${path}.points`,
    );
  }
  return { points };
}

export function normalizeLineGeometry(value: unknown, path = "$geometry"): LineGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["x1", "y1", "x2", "y2"], path);
  return {
    x1: normalizeCoordinate(object.x1, `${path}.x1`),
    y1: normalizeCoordinate(object.y1, `${path}.y1`),
    x2: normalizeCoordinate(object.x2, `${path}.x2`),
    y2: normalizeCoordinate(object.y2, `${path}.y2`),
  };
}

export function normalizeBoxGeometry(value: unknown, path = "$geometry"): BoxGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["x", "y", "width", "height"], path);
  const rawX = normalizeCoordinate(object.x, `${path}.x`);
  const rawY = normalizeCoordinate(object.y, `${path}.y`);
  if (typeof object.width !== "number" || !Number.isFinite(object.width)) {
    throw new GeometryValidationError("Expected a finite dimension", `${path}.width`);
  }
  if (typeof object.height !== "number" || !Number.isFinite(object.height)) {
    throw new GeometryValidationError("Expected a finite dimension", `${path}.height`);
  }

  // Negative drag extents are accepted as input and canonicalized. Canonical
  // geometry always has a non-negative width and height.
  const rawWidth = canonicalNumber(object.width, 2);
  const rawHeight = canonicalNumber(object.height, 2);
  const x = normalizeCoordinate(rawWidth < 0 ? rawX + rawWidth : rawX, `${path}.x`);
  const y = normalizeCoordinate(rawHeight < 0 ? rawY + rawHeight : rawY, `${path}.y`);
  const width = normalizeDimension(Math.abs(rawWidth), `${path}.width`);
  const height = normalizeDimension(Math.abs(rawHeight), `${path}.height`);
  normalizeCoordinate(x + width, `${path}.x+width`);
  normalizeCoordinate(y + height, `${path}.y+height`);
  return { x, y, width, height };
}

export function normalizeTextGeometry(value: unknown, path = "$geometry"): TextGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["x", "y", "text"], path);
  if (typeof object.text !== "string") {
    throw new GeometryValidationError("Expected text to be a string", `${path}.text`);
  }
  return {
    x: normalizeCoordinate(object.x, `${path}.x`),
    y: normalizeCoordinate(object.y, `${path}.y`),
    text: object.text,
  };
}

export function normalizeStickyGeometry(value: unknown, path = "$geometry"): StickyGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["x", "y", "width", "height", "text"], path);
  if (typeof object.text !== "string") {
    throw new GeometryValidationError("Expected text to be a string", `${path}.text`);
  }
  const box = normalizeBoxGeometry(
    {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
    },
    path,
  );
  if (box.width === 0) {
    throw new GeometryValidationError("Sticky width must be greater than 0", `${path}.width`);
  }
  if (box.height === 0) {
    throw new GeometryValidationError("Sticky height must be greater than 0", `${path}.height`);
  }
  return { ...box, text: object.text };
}

export function normalizeZoneGeometry(value: unknown, path = "$geometry"): ZoneGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["x", "y", "width", "height", "title"], path);
  if (typeof object.title !== "string") {
    throw new GeometryValidationError("Expected zone title to be a string", `${path}.title`);
  }
  const box = normalizeBoxGeometry(
    { x: object.x, y: object.y, width: object.width, height: object.height },
    path,
  );
  if (box.width === 0) {
    throw new GeometryValidationError("Zone width must be greater than 0", `${path}.width`);
  }
  if (box.height === 0) {
    throw new GeometryValidationError("Zone height must be greater than 0", `${path}.height`);
  }
  return { ...box, title: object.title };
}

export function isCanonicalImageAssetId(value: unknown): value is string {
  return typeof value === "string" && IMAGE_ASSET_ID_PATTERN.test(value);
}

function normalizeImageAlt(value: unknown, path: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") {
    throw new GeometryValidationError("Expected image alt text to be a string", path);
  }
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!Number.isInteger(second) || second < 0xdc00 || second > 0xdfff) {
        throw new GeometryValidationError("Image alt text contains an unpaired surrogate", path);
      }
      codePoint = (first - 0xd800) * 0x400 + second - 0xdc00 + 0x10000;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new GeometryValidationError("Image alt text contains an unpaired surrogate", path);
    }
    const validXmlCodePoint =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0xa0 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!validXmlCodePoint) {
      throw new GeometryValidationError(
        "Image alt text contains a disallowed control character",
        path,
      );
    }
    count += 1;
    if (count > MAX_IMAGE_ALT_CODE_POINTS) {
      throw new GeometryValidationError(
        `Image alt text may contain at most ${MAX_IMAGE_ALT_CODE_POINTS} Unicode code points`,
        path,
      );
    }
  }
  return value;
}

function normalizeIntrinsicDimension(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new GeometryValidationError("Expected a positive integer image dimension", path);
  }
  if ((value as number) > MAX_IMAGE_INTRINSIC_DIMENSION) {
    throw new GeometryValidationError(
      `Image dimension must be at most ${MAX_IMAGE_INTRINSIC_DIMENSION} pixels`,
      path,
    );
  }
  return value as number;
}

export function normalizeImageGeometry(value: unknown, path = "$geometry"): ImageGeometry {
  const object = expectRecord(value, path);
  const required = [
    "x",
    "y",
    "width",
    "height",
    "assetId",
    "mimeType",
    "intrinsicWidth",
    "intrinsicHeight",
  ] as const;
  const allowed = new Set<string>([...required, "alt"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new GeometryValidationError(`Unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
  for (const key of required) {
    if (!own.call(object, key)) {
      throw new GeometryValidationError(`Missing field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }

  const box = normalizeBoxGeometry(
    { x: object.x, y: object.y, width: object.width, height: object.height },
    path,
  );
  if (box.width === 0) {
    throw new GeometryValidationError("Image width must be greater than 0", `${path}.width`);
  }
  if (box.height === 0) {
    throw new GeometryValidationError("Image height must be greater than 0", `${path}.height`);
  }
  if (!isCanonicalImageAssetId(object.assetId)) {
    throw new GeometryValidationError(
      "Expected asset_ followed by a canonical 43-character base64url SHA-256 digest",
      `${path}.assetId`,
    );
  }
  if (
    typeof object.mimeType !== "string" ||
    !IMAGE_MIME_TYPES.includes(object.mimeType as ImageMimeType)
  ) {
    throw new GeometryValidationError(
      `Image MIME type must be one of ${IMAGE_MIME_TYPES.map((mimeType) => JSON.stringify(mimeType)).join(", ")}`,
      `${path}.mimeType`,
    );
  }
  const intrinsicWidth = normalizeIntrinsicDimension(
    object.intrinsicWidth,
    `${path}.intrinsicWidth`,
  );
  const intrinsicHeight = normalizeIntrinsicDimension(
    object.intrinsicHeight,
    `${path}.intrinsicHeight`,
  );
  if (intrinsicWidth * intrinsicHeight > MAX_IMAGE_INTRINSIC_PIXELS) {
    throw new GeometryValidationError(
      `Image dimensions may contain at most ${MAX_IMAGE_INTRINSIC_PIXELS} pixels`,
      path,
    );
  }
  const alt = own.call(object, "alt") ? normalizeImageAlt(object.alt, `${path}.alt`) : undefined;
  return {
    ...box,
    assetId: object.assetId,
    ...(alt === undefined ? {} : { alt }),
    mimeType: object.mimeType as ImageMimeType,
    intrinsicWidth,
    intrinsicHeight,
  };
}

export function normalizeStampGeometry(value: unknown, path = "$geometry"): StampGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["x", "y", "size", "stamp"], path);
  const x = normalizeCoordinate(object.x, `${path}.x`);
  const y = normalizeCoordinate(object.y, `${path}.y`);
  const size = normalizeDimension(object.size, `${path}.size`);
  if (size === 0) {
    throw new GeometryValidationError("Stamp size must be greater than 0", `${path}.size`);
  }
  if (typeof object.stamp !== "string" || !STAMP_KINDS.includes(object.stamp as StampKind)) {
    throw new GeometryValidationError(
      `Stamp must be one of ${STAMP_KINDS.map((stamp) => JSON.stringify(stamp)).join(", ")}`,
      `${path}.stamp`,
    );
  }
  const halfSize = size / 2;
  normalizeCoordinate(x - halfSize, `${path}.x-size/2`);
  normalizeCoordinate(x + halfSize, `${path}.x+size/2`);
  normalizeCoordinate(y - halfSize, `${path}.y-size/2`);
  normalizeCoordinate(y + halfSize, `${path}.y+size/2`);
  return { x, y, size, stamp: object.stamp as StampKind };
}

function normalizeTableSizes(
  value: unknown,
  minimum: number,
  maximum: number,
  label: "column" | "row",
  path: string,
): number[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new GeometryValidationError(
      `Table must contain between ${minimum} and ${maximum} ${label}${maximum === 1 ? "" : "s"}`,
      path,
    );
  }
  return value.map((entry, index) => {
    const normalized = normalizeDimension(entry, `${path}[${index}]`);
    if (normalized === 0) {
      throw new GeometryValidationError(
        `Table ${label} size must be greater than 0`,
        `${path}[${index}]`,
      );
    }
    return normalized;
  });
}

export function tableGeometrySize(geometry: Pick<TableGeometry, "columnWidths" | "rowHeights">): {
  width: number;
  height: number;
} {
  return {
    width: canonicalNumber(
      geometry.columnWidths.reduce((total, width) => total + width, 0),
      2,
    ),
    height: canonicalNumber(
      geometry.rowHeights.reduce((total, height) => total + height, 0),
      2,
    ),
  };
}

export function normalizeTableGeometry(value: unknown, path = "$geometry"): TableGeometry {
  const object = expectRecord(value, path);
  const required = ["x", "y", "columnWidths", "rowHeights", "cells"] as const;
  const allowed = new Set<string>([...required, "headerRow"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new GeometryValidationError(`Unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
  for (const key of required) {
    if (!own.call(object, key)) {
      throw new GeometryValidationError(`Missing field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }

  const x = normalizeCoordinate(object.x, `${path}.x`);
  const y = normalizeCoordinate(object.y, `${path}.y`);
  const columnWidths = normalizeTableSizes(
    object.columnWidths,
    1,
    MAX_TABLE_COLUMNS,
    "column",
    `${path}.columnWidths`,
  );
  const rowHeights = normalizeTableSizes(
    object.rowHeights,
    1,
    MAX_TABLE_ROWS,
    "row",
    `${path}.rowHeights`,
  );
  if (!Array.isArray(object.cells) || object.cells.length !== rowHeights.length) {
    throw new GeometryValidationError(
      "Table cells must contain exactly one array per row height",
      `${path}.cells`,
    );
  }
  const cells = object.cells.map((rawRow, rowIndex) => {
    if (!Array.isArray(rawRow) || rawRow.length !== columnWidths.length) {
      throw new GeometryValidationError(
        "Every table cell row must contain exactly one string per column width",
        `${path}.cells[${rowIndex}]`,
      );
    }
    return rawRow.map((cell, columnIndex) => {
      if (typeof cell !== "string") {
        throw new GeometryValidationError(
          "Expected table cell text to be a string",
          `${path}.cells[${rowIndex}][${columnIndex}]`,
        );
      }
      return cell;
    });
  });
  if (own.call(object, "headerRow") && typeof object.headerRow !== "boolean") {
    throw new GeometryValidationError("Table headerRow must be a boolean", `${path}.headerRow`);
  }
  const { width, height } = tableGeometrySize({ columnWidths, rowHeights });
  normalizeDimension(width, `${path}.columnWidths`);
  normalizeDimension(height, `${path}.rowHeights`);
  normalizeCoordinate(x + width, `${path}.x+width`);
  normalizeCoordinate(y + height, `${path}.y+height`);
  return {
    x,
    y,
    columnWidths,
    rowHeights,
    cells,
    ...(own.call(object, "headerRow") ? { headerRow: object.headerRow as boolean } : {}),
  };
}

export function normalizeGeometry(kind: "pencil", value: unknown, path?: string): PencilGeometry;
export function normalizeGeometry(kind: "line", value: unknown, path?: string): LineGeometry;
export function normalizeGeometry(
  kind: "rectangle" | "ellipse",
  value: unknown,
  path?: string,
): BoxGeometry;
export function normalizeGeometry(kind: "text", value: unknown, path?: string): TextGeometry;
export function normalizeGeometry(kind: "sticky", value: unknown, path?: string): StickyGeometry;
export function normalizeGeometry(kind: "zone", value: unknown, path?: string): ZoneGeometry;
export function normalizeGeometry(kind: "image", value: unknown, path?: string): ImageGeometry;
export function normalizeGeometry(kind: "stamp", value: unknown, path?: string): StampGeometry;
export function normalizeGeometry(kind: "table", value: unknown, path?: string): TableGeometry;
export function normalizeGeometry(kind: GeometryKind, value: unknown, path?: string): ItemGeometry;
export function normalizeGeometry(
  kind: GeometryKind,
  value: unknown,
  path = "$geometry",
): ItemGeometry {
  switch (kind) {
    case "pencil":
      return normalizePencilGeometry(value, path);
    case "line":
      return normalizeLineGeometry(value, path);
    case "rectangle":
    case "ellipse":
      return normalizeBoxGeometry(value, path);
    case "text":
      return normalizeTextGeometry(value, path);
    case "sticky":
      return normalizeStickyGeometry(value, path);
    case "zone":
      return normalizeZoneGeometry(value, path);
    case "image":
      return normalizeImageGeometry(value, path);
    case "stamp":
      return normalizeStampGeometry(value, path);
    case "table":
      return normalizeTableGeometry(value, path);
  }
}

export function inferAndNormalizeGeometry(value: unknown, path = "$geometry"): ItemGeometry {
  const object = expectRecord(value, path);
  if (own.call(object, "points")) return normalizePencilGeometry(object, path);
  if (own.call(object, "x1")) return normalizeLineGeometry(object, path);
  if (own.call(object, "stamp")) return normalizeStampGeometry(object, path);
  if (own.call(object, "assetId")) return normalizeImageGeometry(object, path);
  if (own.call(object, "cells")) return normalizeTableGeometry(object, path);
  if (own.call(object, "title")) return normalizeZoneGeometry(object, path);
  if (own.call(object, "width") && own.call(object, "text")) {
    return normalizeStickyGeometry(object, path);
  }
  if (own.call(object, "width")) return normalizeBoxGeometry(object, path);
  if (own.call(object, "text")) return normalizeTextGeometry(object, path);
  throw new GeometryValidationError("Unrecognized geometry shape", path);
}

export function transformPoint(point: Point, transform: Transform): Point {
  const [x, y] = point;
  const [a, b, c, d, e, f] = transform;
  return [a * x + c * y + e, b * x + d * y + f];
}

export function translateTransform(transform: Transform, x: unknown, y: unknown): Transform {
  const dx = normalizeCoordinate(x, "$translate.x");
  const dy = normalizeCoordinate(y, "$translate.y");
  return normalizeTransform(
    [transform[0], transform[1], transform[2], transform[3], transform[4] + dx, transform[5] + dy],
    "$transform",
  );
}

export function transformBounds(bounds: Bounds, transform: Transform): Bounds {
  const corners: Point[] = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
  return boundsFromPoints(corners.map((point) => transformPoint(point, transform)));
}

export function boundsFromPoints(points: readonly Point[]): Bounds {
  if (points.length === 0) {
    throw new GeometryValidationError("Cannot calculate bounds for an empty point set");
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function geometryBounds(
  kind: GeometryKind,
  geometry: ItemGeometry,
  textFontSize = 16,
): Bounds {
  switch (kind) {
    case "pencil":
      return boundsFromPoints((geometry as PencilGeometry).points);
    case "line": {
      const line = geometry as LineGeometry;
      return boundsFromPoints([
        [line.x1, line.y1],
        [line.x2, line.y2],
      ]);
    }
    case "rectangle":
    case "ellipse":
    case "sticky":
    case "zone":
    case "image":
    case "table": {
      const box =
        kind === "table"
          ? {
              x: (geometry as TableGeometry).x,
              y: (geometry as TableGeometry).y,
              ...tableGeometrySize(geometry as TableGeometry),
            }
          : (geometry as BoxGeometry);
      return {
        minX: box.x,
        minY: box.y,
        maxX: box.x + box.width,
        maxY: box.y + box.height,
      };
    }
    case "stamp": {
      const stamp = geometry as StampGeometry;
      const halfSize = stamp.size / 2;
      return {
        minX: stamp.x - halfSize,
        minY: stamp.y - halfSize,
        maxX: stamp.x + halfSize,
        maxY: stamp.y + halfSize,
      };
    }
    case "text": {
      const text = geometry as TextGeometry;
      const lines = text.text.split(/\r\n?|\n/u);
      const lineHeight = textFontSize * 1.2;
      const width = Math.max(...lines.map((line) => codePointLength(line) * textFontSize * 0.6));
      return {
        minX: text.x,
        minY: text.y - textFontSize,
        maxX: text.x + width,
        maxY: text.y - textFontSize + Math.max(1, lines.length) * lineHeight,
      };
    }
  }
}

export function imageGeometryContainsPoint(
  geometry: ImageGeometry,
  point: Point,
  padding = 0,
): boolean {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GeometryValidationError(
      "Image hit-test padding must be a finite non-negative number",
      "$padding",
    );
  }
  return (
    point[0] >= geometry.x - padding &&
    point[0] <= geometry.x + geometry.width + padding &&
    point[1] >= geometry.y - padding &&
    point[1] <= geometry.y + geometry.height + padding
  );
}

export function tableGeometryContainsPoint(
  geometry: TableGeometry,
  point: Point,
  padding = 0,
): boolean {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GeometryValidationError(
      "Table hit-test padding must be a finite non-negative number",
      "$padding",
    );
  }
  const { width, height } = tableGeometrySize(geometry);
  return (
    point[0] >= geometry.x - padding &&
    point[0] <= geometry.x + width + padding &&
    point[1] >= geometry.y - padding &&
    point[1] <= geometry.y + height + padding
  );
}

export function zoneTitleBandHeight(fontSize: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new GeometryValidationError(
      "Zone title font size must be a finite positive number",
      "$fontSize",
    );
  }
  return canonicalNumber(fontSize * 1.2 + ZONE_TITLE_PADDING * 2, 2);
}

export function zoneGeometryContainsPoint(
  geometry: ZoneGeometry,
  point: Point,
  fontSize: number,
  padding = 0,
): boolean {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GeometryValidationError(
      "Zone hit-test padding must be a finite non-negative number",
      "$padding",
    );
  }
  const [pointX, pointY] = point;
  const outerLeft = geometry.x - padding;
  const outerTop = geometry.y - padding;
  const outerRight = geometry.x + geometry.width + padding;
  const outerBottom = geometry.y + geometry.height + padding;
  if (pointX < outerLeft || pointX > outerRight || pointY < outerTop || pointY > outerBottom) {
    return false;
  }

  const titleBottom = Math.min(
    geometry.y + geometry.height,
    geometry.y + zoneTitleBandHeight(fontSize),
  );
  const inTitle = pointY <= titleBottom + padding;
  const borderWidth = ZONE_BORDER_HIT_WIDTH + padding;
  const inInterior =
    pointX > geometry.x + borderWidth &&
    pointX < geometry.x + geometry.width - borderWidth &&
    pointY > geometry.y + borderWidth &&
    pointY < geometry.y + geometry.height - borderWidth;
  return inTitle || !inInterior;
}

function maximumLinearScale(transform: Transform): number {
  const [a, b, c, d] = transform;
  // Largest singular value of the 2x2 linear part. This is a conservative,
  // rotation-aware expansion for transformed SVG strokes.
  const sum = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  const discriminant = Math.max(0, sum * sum - 4 * determinant * determinant);
  return Math.sqrt((sum + Math.sqrt(discriminant)) / 2);
}

export function expandBounds(bounds: Bounds, padding: number): Bounds {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GeometryValidationError("Padding must be a finite non-negative number", "$padding");
  }
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

export function itemBounds(item: BoundsItem): Bounds {
  const local = geometryBounds(
    item.kind,
    item.geometry,
    item.style.kind === "text" ? item.style.fontSize : 16,
  );
  const transformed = transformBounds(local, item.transform);
  const result =
    item.style.kind === "stroke"
      ? expandBounds(transformed, (item.style.width / 2) * maximumLinearScale(item.transform))
      : transformed;
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || Math.abs(value) > WORLD_COORDINATE_LIMIT) {
      throw new GeometryValidationError(
        `Transformed item bounds must remain between -${WORLD_COORDINATE_LIMIT} and ${WORLD_COORDINATE_LIMIT}`,
        `$bounds.${name}`,
      );
    }
  }
  return result;
}

export function unionBounds(left: Bounds, right: Bounds): Bounds {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

export function boundsForItems(items: readonly BoundsItem[]): Bounds | null {
  let bounds: Bounds | null = null;
  for (const item of items) {
    const next = itemBounds(item);
    bounds = bounds === null ? next : unionBounds(bounds, next);
  }
  return bounds;
}

export function boundsWidth(bounds: Bounds): number {
  return bounds.maxX - bounds.minX;
}

export function boundsHeight(bounds: Bounds): number {
  return bounds.maxY - bounds.minY;
}

export function formatCanonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new GeometryValidationError("Cannot format a non-finite number");
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  const rendered = normalized.toString();
  if (!/[eE]/u.test(rendered)) return rendered;

  const [coefficient = "0", exponentText = "0"] = rendered.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length + exponent;
  let expanded: string;
  if (decimalPosition <= 0) {
    expanded = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    expanded = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }
  if (expanded.includes(".")) {
    expanded = expanded.replace(/0+$/u, "").replace(/\.$/u, "");
  }
  if (expanded === "" || expanded === "-0") expanded = "0";
  return negative && expanded !== "0" ? `-${expanded}` : expanded;
}
