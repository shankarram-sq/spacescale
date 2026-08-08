import {
  MAX_VISIBLE_PATH_POINTS,
  MAX_VISIBLE_PATHS,
  type OutlineGeometry,
  type OutlineGeometryKind,
  visibleOutlinePaths,
} from "@collab/geometry";
import type { BoardItem, Matrix, Point, VisiblePaths } from "../types";
import { roundBoard } from "../types";

const EPSILON = 1e-9;
const MIN_VISIBLE_SEGMENT_LENGTH = 0.01;

export type PartiallyErasableItem = Extract<
  BoardItem,
  { kind: "pencil" | "line" | "rectangle" | "ellipse" | "polygon" }
>;

export type StrokeEraseResult = {
  visiblePaths: VisiblePaths;
  /** True when the complete visible outline was removed and the caller should delete the item. */
  erased: boolean;
};

type Interval = readonly [start: number, end: number];

export function isPartiallyErasableItem(item: BoardItem): item is PartiallyErasableItem {
  return (
    item.kind === "pencil" ||
    item.kind === "line" ||
    item.kind === "rectangle" ||
    item.kind === "ellipse" ||
    item.kind === "polygon"
  );
}

/**
 * Clips a stroked item's visible centreline against a world-space swept circular eraser.
 *
 * The result remains in the item's local coordinate system, so callers can persist it as
 * `geometry.visiblePaths` without changing item identity, ownership, z-order, or transform.
 */
export function eraseStrokeItem(
  item: BoardItem,
  worldEraserPath: readonly Point[],
  radius: number,
): StrokeEraseResult | null {
  if (!isPartiallyErasableItem(item)) return null;
  if (!Number.isFinite(radius) || radius < 0) {
    throw new RangeError("Eraser radius must be a finite non-negative number.");
  }
  if (worldEraserPath.length === 0) return null;
  for (const point of worldEraserPath) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      throw new RangeError("Eraser path points must contain finite coordinates.");
    }
  }

  const inverse = inverseMatrix(item.transform);
  if (inverse === null) return null;
  const localPaths = visibleOutlinePaths(
    item.kind as OutlineGeometryKind,
    item.geometry as OutlineGeometry,
  );
  const effectiveRadius = radius + (item.style.width / 2) * maximumLinearScale(item.transform);
  let changed = false;
  const survivingWorldPaths: Point[][] = [];

  for (const localPath of localPaths) {
    const worldPath = localPath.map((point) => transformPoint(point, item.transform));
    const clipped = clipWorldPath(worldPath, worldEraserPath, effectiveRadius);
    changed ||= clipped.changed;
    survivingWorldPaths.push(...clipped.paths);
  }

  if (!changed) return null;
  let visiblePaths = survivingWorldPaths
    .map((path) => canonicalLocalPath(path.map((point) => transformPoint(point, inverse))))
    .filter((path): path is Point[] => path !== null);
  visiblePaths = enforceVisiblePathLimits(visiblePaths);
  return { visiblePaths, erased: visiblePaths.length === 0 };
}

function clipWorldPath(
  source: readonly Point[],
  eraser: readonly Point[],
  radius: number,
): { paths: Point[][]; changed: boolean } {
  const paths: Point[][] = [];
  let current: Point[] | null = null;
  let changed = false;

  for (let index = 1; index < source.length; index += 1) {
    const start = source[index - 1];
    const end = source[index];
    if (!start || !end) continue;
    const segmentLength = pointDistance(start, end);
    if (segmentLength <= EPSILON) continue;
    const erased = erasedIntervals(start, end, eraser, radius);
    const surviving = complementIntervals(erased);
    if (erased.some(([from, to]) => (to - from) * segmentLength > MIN_VISIBLE_SEGMENT_LENGTH)) {
      changed = true;
    }

    for (const [from, to] of surviving) {
      if ((to - from) * segmentLength < MIN_VISIBLE_SEGMENT_LENGTH) continue;
      const visibleStart = interpolate(start, end, from);
      const visibleEnd = interpolate(start, end, to);
      if (current && pointsNear(current.at(-1), visibleStart)) {
        appendDistinct(current, visibleEnd);
      } else {
        flushPath(paths, current);
        current = [visibleStart, visibleEnd];
      }
      if (to < 1 - EPSILON) {
        flushPath(paths, current);
        current = null;
      }
    }

    if (surviving.length === 0 || (surviving.at(-1)?.[1] ?? 0) < 1 - EPSILON) {
      flushPath(paths, current);
      current = null;
    }
  }
  flushPath(paths, current);
  if (
    paths.length > 1 &&
    pointsNear(source[0], source.at(-1) as Point) &&
    pointsNear(paths.at(-1)?.at(-1), paths[0]?.[0] as Point)
  ) {
    const first = paths.shift();
    const last = paths.pop();
    if (first && last) paths.unshift([...last, ...first.slice(1)]);
  }
  return { paths, changed };
}

function erasedIntervals(
  sourceStart: Point,
  sourceEnd: Point,
  eraser: readonly Point[],
  radius: number,
): Interval[] {
  const intervals: Interval[] = [];
  if (eraser.length === 1 && eraser[0]) {
    intervals.push(...segmentCircleInterval(sourceStart, sourceEnd, eraser[0], radius));
  } else {
    for (let index = 1; index < eraser.length; index += 1) {
      const start = eraser[index - 1];
      const end = eraser[index];
      if (start && end)
        intervals.push(...segmentCapsuleIntervals(sourceStart, sourceEnd, start, end, radius));
    }
  }
  return mergeIntervals(intervals);
}

function segmentCapsuleIntervals(
  sourceStart: Point,
  sourceEnd: Point,
  eraseStart: Point,
  eraseEnd: Point,
  radius: number,
): Interval[] {
  const vx = eraseEnd[0] - eraseStart[0];
  const vy = eraseEnd[1] - eraseStart[1];
  const length = Math.hypot(vx, vy);
  if (length <= EPSILON) return segmentCircleInterval(sourceStart, sourceEnd, eraseStart, radius);

  const unitX = vx / length;
  const unitY = vy / length;
  const normalX = -unitY;
  const normalY = unitX;
  const sourceDx = sourceEnd[0] - sourceStart[0];
  const sourceDy = sourceEnd[1] - sourceStart[1];
  const relativeX = sourceStart[0] - eraseStart[0];
  const relativeY = sourceStart[1] - eraseStart[1];
  let body: Interval | null = [0, 1];
  body = intersectLinearRange(
    body,
    relativeX * unitX + relativeY * unitY,
    sourceDx * unitX + sourceDy * unitY,
    0,
    length,
  );
  body = intersectLinearRange(
    body,
    relativeX * normalX + relativeY * normalY,
    sourceDx * normalX + sourceDy * normalY,
    -radius,
    radius,
  );

  return [
    ...(body ? [body] : []),
    ...segmentCircleInterval(sourceStart, sourceEnd, eraseStart, radius),
    ...segmentCircleInterval(sourceStart, sourceEnd, eraseEnd, radius),
  ];
}

function segmentCircleInterval(
  start: Point,
  end: Point,
  center: Point,
  radius: number,
): Interval[] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const fx = start[0] - center[0];
  const fy = start[1] - center[1];
  const a = dx * dx + dy * dy;
  if (a <= EPSILON) return Math.hypot(fx, fy) <= radius ? [[0, 1]] : [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -EPSILON) return c <= 0 ? [[0, 1]] : [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const from = Math.max(0, (-b - root) / (2 * a));
  const to = Math.min(1, (-b + root) / (2 * a));
  return from <= to + EPSILON ? [[from, to]] : [];
}

function intersectLinearRange(
  interval: Interval | null,
  origin: number,
  delta: number,
  minimum: number,
  maximum: number,
): Interval | null {
  if (interval === null) return null;
  if (Math.abs(delta) <= EPSILON) {
    return origin >= minimum - EPSILON && origin <= maximum + EPSILON ? interval : null;
  }
  const first = (minimum - origin) / delta;
  const second = (maximum - origin) / delta;
  const lower = Math.min(first, second);
  const upper = Math.max(first, second);
  const from = Math.max(interval[0], lower);
  const to = Math.min(interval[1], upper);
  return from <= to + EPSILON ? [from, to] : null;
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .map(([from, to]) => [Math.max(0, from), Math.min(1, to)] as Interval)
    .filter(([from, to]) => from <= to + EPSILON)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval[0] > previous[1] + EPSILON) {
      merged.push(interval);
      continue;
    }
    merged[merged.length - 1] = [previous[0], Math.max(previous[1], interval[1])];
  }
  return merged;
}

function complementIntervals(erased: readonly Interval[]): Interval[] {
  if (erased.length === 0) return [[0, 1]];
  const visible: Interval[] = [];
  let start = 0;
  for (const [from, to] of erased) {
    if (from > start + EPSILON) visible.push([start, from]);
    start = Math.max(start, to);
  }
  if (start < 1 - EPSILON) visible.push([start, 1]);
  return visible;
}

function canonicalLocalPath(points: readonly Point[]): Point[] | null {
  const canonical: Point[] = [];
  for (const point of points) {
    appendDistinct(canonical, [roundBoard(point[0]), roundBoard(point[1])]);
  }
  if (canonical.length < 2 || pathLength(canonical) < MIN_VISIBLE_SEGMENT_LENGTH) return null;
  return removeCollinearPoints(canonical);
}

function removeCollinearPoints(points: readonly Point[]): Point[] {
  if (points.length <= 2) return points.map(clonePoint);
  const result: Point[] = [clonePoint(points[0] as Point)];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = result.at(-1);
    const current = points[index];
    const next = points[index + 1];
    if (!previous || !current || !next) continue;
    const cross =
      (current[0] - previous[0]) * (next[1] - current[1]) -
      (current[1] - previous[1]) * (next[0] - current[0]);
    if (Math.abs(cross) > EPSILON) result.push(clonePoint(current));
  }
  appendDistinct(result, clonePoint(points.at(-1) as Point));
  return result;
}

function enforceVisiblePathLimits(paths: Point[][]): Point[][] {
  let limited = paths;
  if (limited.length > MAX_VISIBLE_PATHS) {
    const retained = new Set(
      [...limited]
        .map((path, index) => ({ index, length: pathLength(path) }))
        .sort((left, right) => right.length - left.length || left.index - right.index)
        .slice(0, MAX_VISIBLE_PATHS)
        .map(({ index }) => index),
    );
    limited = limited.filter((_, index) => retained.has(index));
  }
  let pointCount = limited.reduce((total, path) => total + path.length, 0);
  if (pointCount <= MAX_VISIBLE_PATH_POINTS) return limited;

  // Preserve every fragment's endpoints and deterministically thin interior points only when a
  // pathological erase would exceed the canonical protocol budget.
  let stride = 2;
  while (pointCount > MAX_VISIBLE_PATH_POINTS) {
    limited = limited.map((path) => [
      path[0] as Point,
      ...path.slice(1, -1).filter((_, index) => index % stride === 0),
      path.at(-1) as Point,
    ]);
    pointCount = limited.reduce((total, path) => total + path.length, 0);
    stride += 1;
  }
  return limited;
}

function inverseMatrix(matrix: Matrix): Matrix | null {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(determinant) <= EPSILON) return null;
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant,
  ];
}

function maximumLinearScale(matrix: Matrix): number {
  const [a, b, c, d] = matrix;
  const sum = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  const discriminant = Math.max(0, sum * sum - 4 * determinant * determinant);
  return Math.sqrt((sum + Math.sqrt(discriminant)) / 2);
}

function transformPoint(point: Point, matrix: Matrix): Point {
  return [
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  ];
}

function interpolate(start: Point, end: Point, amount: number): Point {
  return [start[0] + (end[0] - start[0]) * amount, start[1] + (end[1] - start[1]) * amount];
}

function appendDistinct(points: Point[], point: Point): void {
  if (!pointsNear(points.at(-1), point)) points.push(point);
}

function flushPath(paths: Point[][], path: Point[] | null): void {
  if (path && path.length >= 2 && pathLength(path) >= MIN_VISIBLE_SEGMENT_LENGTH) paths.push(path);
}

function pointsNear(left: Point | undefined, right: Point, epsilon = 1e-7): boolean {
  return Boolean(
    left && Math.abs(left[0] - right[0]) <= epsilon && Math.abs(left[1] - right[1]) <= epsilon,
  );
}

function pointDistance(left: Point, right: Point): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function pathLength(path: readonly Point[]): number {
  let length = 0;
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1];
    const end = path[index];
    if (start && end) length += pointDistance(start, end);
  }
  return length;
}

function clonePoint(point: Point): Point {
  return [point[0], point[1]];
}
