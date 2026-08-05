import {
  type Bounds,
  boundsForItems,
  boundsHeight,
  boundsWidth,
  expandBounds,
  formatCanonicalNumber,
} from "@collab/geometry";
import {
  assertCanonicalId,
  type BoardItem,
  normalizeBoardItem,
  type ProtocolErrorCode,
  ProtocolValidationError,
  utf8Bytes,
  validatePlainText,
} from "@collab/protocol";

export const DEFAULT_SVG_PADDING = 24;

export interface SvgExportInput {
  boardId: string;
  seq: number;
  items: readonly BoardItem[];
  title?: string;
  padding?: number;
}

export interface SvgExportResult {
  svg: string;
  bytes: Uint8Array;
  viewBox: Bounds;
  itemCount: number;
}

export class SvgExportError extends Error {
  constructor(
    readonly code: ProtocolErrorCode | "INVALID_EXPORT",
    message: string,
  ) {
    super(message);
    this.name = "SvgExportError";
  }
}

function exportFail(
  message: string,
  code: ProtocolErrorCode | "INVALID_EXPORT" = "INVALID_EXPORT",
): never {
  throw new SvgExportError(code, message);
}

export function escapeXmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function number(value: number): string {
  try {
    return formatCanonicalNumber(value);
  } catch {
    exportFail("The export contains a non-finite calculated number.");
  }
}

function transformAttribute(item: BoardItem): string {
  return `matrix(${item.transform.map(number).join(" ")})`;
}

function commonStrokeAttributes(item: Exclude<BoardItem, { kind: "text" }>): string {
  return [
    `fill="none"`,
    `stroke="${escapeXmlAttribute(item.style.color)}"`,
    `stroke-width="${number(item.style.width)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `stroke-linecap="round"`,
    `stroke-linejoin="round"`,
    `transform="${transformAttribute(item)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
  ].join(" ");
}

function renderText(item: Extract<BoardItem, { kind: "text" }>): string {
  const lines = item.geometry.text.split(/\r\n?|\n/u);
  const attributes = [
    `x="${number(item.geometry.x)}"`,
    `y="${number(item.geometry.y)}"`,
    `fill="${escapeXmlAttribute(item.style.color)}"`,
    `font-size="${number(item.style.fontSize)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `transform="${transformAttribute(item)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
    `font-family="sans-serif"`,
    `xml:space="preserve"`,
  ].join(" ");
  if (lines.length === 1) return `<text ${attributes}>${escapeXmlText(lines[0] ?? "")}</text>`;
  const lineHeight = number(item.style.fontSize * 1.2);
  const content = lines
    .map((line, index) => {
      const dy = index === 0 ? "0" : lineHeight;
      return `<tspan x="${number(item.geometry.x)}" dy="${dy}">${escapeXmlText(line)}</tspan>`;
    })
    .join("");
  return `<text ${attributes}>${content}</text>`;
}

export function renderSvgItem(item: BoardItem): string {
  switch (item.kind) {
    case "pencil": {
      const [first, ...remaining] = item.geometry.points;
      if (first === undefined) exportFail("A canonical pencil item must contain points.");
      const path = [
        `M ${number(first[0])} ${number(first[1])}`,
        ...remaining.map(([x, y]) => `L ${number(x)} ${number(y)}`),
      ].join(" ");
      return `<path d="${path}" ${commonStrokeAttributes(item)} />`;
    }
    case "line":
      return `<line x1="${number(item.geometry.x1)}" y1="${number(item.geometry.y1)}" x2="${number(item.geometry.x2)}" y2="${number(item.geometry.y2)}" ${commonStrokeAttributes(item)} />`;
    case "rectangle":
      return `<rect x="${number(item.geometry.x)}" y="${number(item.geometry.y)}" width="${number(item.geometry.width)}" height="${number(item.geometry.height)}" ${commonStrokeAttributes(item)} />`;
    case "ellipse":
      return `<ellipse cx="${number(item.geometry.x + item.geometry.width / 2)}" cy="${number(item.geometry.y + item.geometry.height / 2)}" rx="${number(item.geometry.width / 2)}" ry="${number(item.geometry.height / 2)}" ${commonStrokeAttributes(item)} />`;
    case "text":
      return renderText(item);
  }
}

function normalizePadding(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    exportFail("SVG padding must be a finite number between 0 and 1,000,000.");
  }
  return value;
}

function ensureNonDegenerate(bounds: Bounds): Bounds {
  let { minX, minY, maxX, maxY } = bounds;
  if (maxX === minX) {
    minX -= 0.5;
    maxX += 0.5;
  }
  if (maxY === minY) {
    minY -= 0.5;
    maxY += 0.5;
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    exportFail("The calculated SVG viewBox is not finite.");
  }
  return { minX, minY, maxX, maxY };
}

function calculateViewBox(items: readonly BoardItem[], padding: number): Bounds {
  const contentBounds = boundsForItems(items);
  if (contentBounds === null) return { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  return ensureNonDegenerate(expandBounds(contentBounds, padding));
}

export function createSvgExport(input: SvgExportInput): SvgExportResult {
  let boardId: string;
  try {
    boardId = assertCanonicalId(input.boardId, "$export.boardId");
  } catch (error) {
    if (error instanceof ProtocolValidationError)
      throw new SvgExportError(error.code, error.message);
    throw error;
  }
  if (!Number.isSafeInteger(input.seq) || input.seq < 0) {
    exportFail("SVG sequence must be a non-negative safe integer.");
  }
  if (!Array.isArray(input.items)) exportFail("SVG items must be an array.");
  const padding = normalizePadding(input.padding ?? DEFAULT_SVG_PADDING);
  const items = input.items
    .map((item) => {
      try {
        return normalizeBoardItem(item);
      } catch (error) {
        if (error instanceof ProtocolValidationError)
          throw new SvgExportError(error.code, error.message);
        throw error;
      }
    })
    .sort((left, right) => left.z - right.z || left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) exportFail(`The export contains duplicate item ID ${item.id}.`);
    ids.add(item.id);
  }

  let title: string | undefined;
  if (input.title !== undefined) {
    try {
      title = validatePlainText(input.title, "$export.title");
    } catch (error) {
      if (error instanceof ProtocolValidationError)
        throw new SvgExportError(error.code, error.message);
      throw error;
    }
  }
  const viewBox = calculateViewBox(items, padding);
  const metadata = JSON.stringify({
    format: "cf-whiteboard-svg",
    version: 1,
    boardId,
    seq: input.seq,
  });
  const markup = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${number(viewBox.minX)} ${number(viewBox.minY)} ${number(boundsWidth(viewBox))} ${number(boundsHeight(viewBox))}" data-format="cf-whiteboard-svg" data-version="1" data-seq="${input.seq}">`,
    `<metadata>${escapeXmlText(metadata)}</metadata>`,
    ...(title === undefined ? [] : [`<title>${escapeXmlText(title)}</title>`]),
    `<g data-layer="drawing">`,
    ...items.map(renderSvgItem),
    `</g>`,
    `</svg>`,
  ].join("\n");
  return { svg: markup, bytes: utf8Bytes(markup), viewBox, itemCount: items.length };
}

export function serializeSvg(input: SvgExportInput): string {
  return createSvgExport(input).svg;
}

export function svgExportBytes(input: SvgExportInput): Uint8Array {
  return createSvgExport(input).bytes;
}

export function svgDownloadHeaders(filename = "whiteboard.svg"): Readonly<Record<string, string>> {
  const safeFilename =
    filename.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "") || "whiteboard.svg";
  return {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Content-Disposition": `attachment; filename="${safeFilename}"`,
  };
}
