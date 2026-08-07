export const COORDINATE_LIMIT = 1_000_000;
export const DIMENSION_LIMIT = 2_000_000;
export const TRANSFORM_LINEAR_COMPONENT_LIMIT = COORDINATE_LIMIT;
export const WORLD_COORDINATE_LIMIT = DIMENSION_LIMIT;
export const MAX_PENCIL_POINTS = 10_000;
export const MIN_PENCIL_POINTS = 2;

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

export type ItemGeometry =
  | PencilGeometry
  | LineGeometry
  | BoxGeometry
  | TextGeometry
  | StickyGeometry;

export type GeometryKind = "pencil" | "line" | "rectangle" | "ellipse" | "text" | "sticky";

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
    | { kind: "sticky"; fontSize: number };
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

export function normalizeGeometry(kind: "pencil", value: unknown, path?: string): PencilGeometry;
export function normalizeGeometry(kind: "line", value: unknown, path?: string): LineGeometry;
export function normalizeGeometry(
  kind: "rectangle" | "ellipse",
  value: unknown,
  path?: string,
): BoxGeometry;
export function normalizeGeometry(kind: "text", value: unknown, path?: string): TextGeometry;
export function normalizeGeometry(kind: "sticky", value: unknown, path?: string): StickyGeometry;
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
  }
}

export function inferAndNormalizeGeometry(value: unknown, path = "$geometry"): ItemGeometry {
  const object = expectRecord(value, path);
  if (own.call(object, "points")) return normalizePencilGeometry(object, path);
  if (own.call(object, "x1")) return normalizeLineGeometry(object, path);
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
    case "sticky": {
      const box = geometry as BoxGeometry;
      return {
        minX: box.x,
        minY: box.y,
        maxX: box.x + box.width,
        maxY: box.y + box.height,
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
