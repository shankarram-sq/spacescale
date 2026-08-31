import type { BatchItemOperation, BoardItem, Matrix, Point } from "../types";
import { roundBoard } from "../types";

export const MIN_SCALED_SHAPE_SIDE = 24;
export const MIN_SCALED_IMAGE_SIDE = 72;
const MAX_TRANSFORM_LINEAR_COMPONENT = 1_000_000;

export type ScalableObjectItem = Extract<
  BoardItem,
  { kind: "rectangle" | "ellipse" | "polygon" | "image" }
>;

export type RotatableObjectItem = Extract<
  BoardItem,
  { kind: "rectangle" | "ellipse" | "polygon" | "image" | "protractor" }
>;

export type CapturedObjectTransform = {
  item: ScalableObjectItem | RotatableObjectItem;
  expectedVersion: number;
};

export type LocalObjectBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function isScalableObjectItem(item: BoardItem): item is ScalableObjectItem {
  return (
    item.kind === "rectangle" ||
    item.kind === "ellipse" ||
    item.kind === "polygon" ||
    item.kind === "image"
  );
}

export function isRotatableObjectItem(item: BoardItem): item is RotatableObjectItem {
  return isScalableObjectItem(item) || item.kind === "protractor";
}

export function objectLocalBounds(item: RotatableObjectItem): LocalObjectBounds {
  if (item.kind === "protractor") {
    return {
      minX: -item.geometry.radius,
      minY: -item.geometry.radius,
      maxX: item.geometry.radius,
      maxY: 0,
    };
  }
  return {
    minX: item.geometry.x,
    minY: item.geometry.y,
    maxX: item.geometry.x + item.geometry.width,
    maxY: item.geometry.y + item.geometry.height,
  };
}

export function objectLocalCenter(item: RotatableObjectItem): Point {
  if (item.kind === "protractor") return [0, 0];
  const bounds = objectLocalBounds(item);
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

export function objectScaleCorner(item: ScalableObjectItem): Point {
  const bounds = objectLocalBounds(item);
  return [bounds.maxX, bounds.maxY];
}

export function objectScalePivot(item: ScalableObjectItem): Point {
  const bounds = objectLocalBounds(item);
  return [bounds.minX, bounds.minY];
}

export function transformedPoint(matrix: Matrix, point: Point): Point {
  return [
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  ];
}

export function objectScaleGrabOffset(item: ScalableObjectItem, pointer: Point): Point {
  const handle = transformedPoint(item.transform, objectScaleCorner(item));
  return [pointer[0] - handle[0], pointer[1] - handle[1]];
}

export function scaledObjectMatrix(
  item: ScalableObjectItem,
  pointer: Point,
  grabOffset: Point = [0, 0],
): Matrix {
  const localPivot = objectScalePivot(item);
  const pivot = transformedPoint(item.transform, localPivot);
  const corner = transformedPoint(item.transform, objectScaleCorner(item));
  const baseline: Point = [corner[0] - pivot[0], corner[1] - pivot[1]];
  const target: Point = [
    pointer[0] - grabOffset[0] - pivot[0],
    pointer[1] - grabOffset[1] - pivot[1],
  ];
  const squaredLength = baseline[0] ** 2 + baseline[1] ** 2;
  if (squaredLength < 1e-12) return item.transform;

  const projectedScale = (target[0] * baseline[0] + target[1] * baseline[1]) / squaredLength;
  const bounds = objectLocalBounds(item);
  const width = Math.max(Number.EPSILON, bounds.maxX - bounds.minX);
  const height = Math.max(Number.EPSILON, bounds.maxY - bounds.minY);
  const worldWidth = Math.hypot(item.transform[0] * width, item.transform[1] * width);
  const worldHeight = Math.hypot(item.transform[2] * height, item.transform[3] * height);
  const minimumSide = item.kind === "image" ? MIN_SCALED_IMAGE_SIDE : MIN_SCALED_SHAPE_SIDE;
  const minimumScale = minimumSide / Math.max(Number.EPSILON, Math.min(worldWidth, worldHeight));
  const currentLargestComponent = Math.max(
    Number.EPSILON,
    ...item.transform.slice(0, 4).map((component) => Math.abs(component)),
  );
  const maximumScale = MAX_TRANSFORM_LINEAR_COMPONENT / currentLargestComponent;
  const scale = Math.min(maximumScale, Math.max(minimumScale, projectedScale));
  return scaledMatrixAroundLocalPoint(item.transform, scale, localPivot);
}

export function scaledMatrixAroundLocalPoint(
  matrix: Matrix,
  scale: number,
  localPivot: Point,
): Matrix {
  const [a, b, c, d] = matrix;
  const nextA = a * scale;
  const nextB = b * scale;
  const nextC = c * scale;
  const nextD = d * scale;
  const worldPivot = transformedPoint(matrix, localPivot);
  return [
    roundTransformLinear(nextA),
    roundTransformLinear(nextB),
    roundTransformLinear(nextC),
    roundTransformLinear(nextD),
    roundBoard(worldPivot[0] - nextA * localPivot[0] - nextC * localPivot[1]),
    roundBoard(worldPivot[1] - nextB * localPivot[0] - nextD * localPivot[1]),
  ];
}

export function rotatedMatrixAroundLocalPoint(
  matrix: Matrix,
  radians: number,
  localPivot: Point,
): Matrix {
  const [a, b, c, d] = matrix;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const nextA = cosine * a - sine * b;
  const nextB = sine * a + cosine * b;
  const nextC = cosine * c - sine * d;
  const nextD = sine * c + cosine * d;
  const worldPivot = transformedPoint(matrix, localPivot);
  return [
    roundTransformLinear(nextA),
    roundTransformLinear(nextB),
    roundTransformLinear(nextC),
    roundTransformLinear(nextD),
    roundBoard(worldPivot[0] - nextA * localPivot[0] - nextC * localPivot[1]),
    roundBoard(worldPivot[1] - nextB * localPivot[0] - nextD * localPivot[1]),
  ];
}

export function buildCapturedObjectTransformOperation(
  capture: CapturedObjectTransform,
  transform: Matrix,
): Extract<BatchItemOperation, { kind: "item.update" }> {
  return {
    kind: "item.update",
    itemId: capture.item.id,
    expectedVersion: capture.expectedVersion,
    patch: { transform },
  };
}

function roundTransformLinear(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
