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

const STICKY_PADDING = 14;
const STICKY_CORNER_RADIUS = 12;
const STICKY_LINE_HEIGHT = 1.2;
const STICKY_CODE_POINT_WIDTH = 0.56;
const STICKY_WHITESPACE = /\s/u;

export const STAMP_SVG_PATHS = {
  star: "M12 2.5 14.9 8.6 21.5 9.5 16.7 14.1 17.9 20.7 12 17.5 6.1 20.7 7.3 14.1 2.5 9.5 9.1 8.6Z",
  heart: "M12 21S3 15.5 3 9.5C3 5 8.5 3 12 7c3.5-4 9-2 9 2.5C21 15.5 12 21 12 21Z",
  check: "M4 12.5 9.2 17.5 20 6.5",
  question: "M9.4 8.2a2.8 2.8 0 1 1 4.9 1.9c-.9.9-2.3 1.5-2.3 3.1",
  smileMouth: "M8 14.2c1.1 2 2.4 2.8 4 2.8s2.9-.8 4-2.8",
  sparkle:
    "M12 2 14.2 8.2 20.5 10.5 14.2 12.8 12 19 9.8 12.8 3.5 10.5 9.8 8.2Z M19 15.5 20 18 22.5 19 20 20 19 22.5 18 20 15.5 19 18 18Z",
} as const;

type StrokeBoardItem = Extract<BoardItem, { kind: "pencil" | "line" | "rectangle" | "ellipse" }>;
type StickyBoardItem = Extract<BoardItem, { kind: "sticky" }>;
type StampBoardItem = Extract<BoardItem, { kind: "stamp" }>;

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

function commonStrokeAttributes(item: StrokeBoardItem): string {
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

function codePointWidthAt(value: string, index: number): number {
  return (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

function isStickyWhitespaceAt(value: string, index: number): boolean {
  return STICKY_WHITESPACE.test(value[index] ?? "");
}

function isStickyLineBreakAt(value: string, index: number): boolean {
  const codeUnit = value.charCodeAt(index);
  return codeUnit === 0x0a || codeUnit === 0x0d;
}

interface StickyWordChunk {
  end: number;
  codePoints: number;
  hasMore: boolean;
}

function scanStickyWordChunk(value: string, start: number, maxCharacters: number): StickyWordChunk {
  let end = start;
  let codePoints = 0;
  while (end < value.length && codePoints < maxCharacters && !isStickyWhitespaceAt(value, end)) {
    end += codePointWidthAt(value, end);
    codePoints += 1;
  }
  return {
    end,
    codePoints,
    hasMore: end < value.length && !isStickyWhitespaceAt(value, end),
  };
}

function appendStickyLine(lines: string[], line: string, maxLines: number): boolean {
  lines.push(line);
  return lines.length >= maxLines;
}

function appendStickyParagraphLines(
  value: string,
  start: number,
  maxCharacters: number,
  maxLines: number,
  lines: string[],
): number | null {
  let index = start;
  let sawWord = false;
  let currentWords: string[] = [];
  let currentCodePoints = 0;

  while (index < value.length && !isStickyLineBreakAt(value, index)) {
    while (
      index < value.length &&
      !isStickyLineBreakAt(value, index) &&
      isStickyWhitespaceAt(value, index)
    ) {
      index += codePointWidthAt(value, index);
    }
    if (index >= value.length || isStickyLineBreakAt(value, index)) break;

    sawWord = true;
    const wordStart = index;
    let chunk = scanStickyWordChunk(value, wordStart, maxCharacters);
    if (!chunk.hasMore) {
      const word = value.slice(wordStart, chunk.end);
      if (currentWords.length === 0) {
        currentWords.push(word);
        currentCodePoints = chunk.codePoints;
      } else if (currentCodePoints + 1 + chunk.codePoints <= maxCharacters) {
        currentWords.push(word);
        currentCodePoints += 1 + chunk.codePoints;
      } else {
        if (appendStickyLine(lines, currentWords.join(" "), maxLines)) return null;
        currentWords = [word];
        currentCodePoints = chunk.codePoints;
      }
      index = chunk.end;
      continue;
    }

    if (currentWords.length > 0) {
      if (appendStickyLine(lines, currentWords.join(" "), maxLines)) return null;
      currentWords = [];
      currentCodePoints = 0;
    }
    let chunkStart = wordStart;
    while (chunk.hasMore) {
      if (appendStickyLine(lines, value.slice(chunkStart, chunk.end), maxLines)) return null;
      chunkStart = chunk.end;
      chunk = scanStickyWordChunk(value, chunkStart, maxCharacters);
    }
    currentWords = [value.slice(chunkStart, chunk.end)];
    currentCodePoints = chunk.codePoints;
    index = chunk.end;
  }

  if (appendStickyLine(lines, sawWord ? currentWords.join(" ") : "", maxLines)) return null;
  if (index >= value.length) return value.length + 1;
  return value.charCodeAt(index) === 0x0d && value.charCodeAt(index + 1) === 0x0a
    ? index + 2
    : index + 1;
}

function stickyTextLines(item: StickyBoardItem): string[] {
  const contentWidth = Math.max(0, item.geometry.width - STICKY_PADDING * 2);
  const contentHeight = Math.max(0, item.geometry.height - STICKY_PADDING * 2);
  const maxCharacters = Math.max(
    1,
    Math.floor(contentWidth / (item.style.fontSize * STICKY_CODE_POINT_WIDTH)),
  );
  const maxLines = Math.max(
    1,
    Math.floor(contentHeight / (item.style.fontSize * STICKY_LINE_HEIGHT)),
  );
  const lines: string[] = [];
  let paragraphStart = 0;
  while (paragraphStart <= item.geometry.text.length && lines.length < maxLines) {
    const nextParagraph = appendStickyParagraphLines(
      item.geometry.text,
      paragraphStart,
      maxCharacters,
      maxLines,
      lines,
    );
    if (nextParagraph === null) break;
    paragraphStart = nextParagraph;
  }
  return lines;
}

function renderSticky(item: StickyBoardItem): string {
  const { x, y, width, height, text } = item.geometry;
  const clipId = `sticky-clip-${item.id}`;
  const attributes = [
    `transform="${transformAttribute(item)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
  ].join(" ");
  const rectangle = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="${number(STICKY_CORNER_RADIUS)}" fill="${escapeXmlAttribute(item.style.fill)}" />`;
  if (text.length === 0) return `<g ${attributes}>${rectangle}</g>`;

  const contentX = x + STICKY_PADDING;
  const contentY = y + STICKY_PADDING;
  const contentWidth = Math.max(0, width - STICKY_PADDING * 2);
  const contentHeight = Math.max(0, height - STICKY_PADDING * 2);
  const lineHeight = number(item.style.fontSize * STICKY_LINE_HEIGHT);
  const spans = stickyTextLines(item)
    .map(
      (line, index) =>
        `<tspan x="${number(contentX)}" dy="${index === 0 ? "0" : lineHeight}">${escapeXmlText(line || " ")}</tspan>`,
    )
    .join("");
  const clip = `<defs><clipPath id="${escapeXmlAttribute(clipId)}" clipPathUnits="userSpaceOnUse"><rect x="${number(contentX)}" y="${number(contentY)}" width="${number(contentWidth)}" height="${number(contentHeight)}" /></clipPath></defs>`;
  const renderedText = `<text x="${number(contentX)}" y="${number(contentY + item.style.fontSize)}" fill="${escapeXmlAttribute(item.style.textColor)}" font-size="${number(item.style.fontSize)}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" xml:space="preserve" clip-path="url(#${escapeXmlAttribute(clipId)})">${spans}</text>`;
  return `<g ${attributes}>${clip}${rectangle}${renderedText}</g>`;
}

function renderStamp(item: StampBoardItem): string {
  const { x, y, size, stamp } = item.geometry;
  const color = escapeXmlAttribute(item.style.color);
  const symbolTransform = `translate(${number(x - size / 2)} ${number(y - size / 2)}) scale(${number(size / 24)})`;
  let symbol: string;
  switch (stamp) {
    case "star":
      symbol = `<path d="${STAMP_SVG_PATHS.star}" fill="${color}" />`;
      break;
    case "heart":
      symbol = `<path d="${STAMP_SVG_PATHS.heart}" fill="${color}" />`;
      break;
    case "check":
      symbol = `<path d="${STAMP_SVG_PATHS.check}" fill="none" stroke="${color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" />`;
      break;
    case "question":
      symbol = `<path d="${STAMP_SVG_PATHS.question}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" /><circle cx="12" cy="17.6" r="1.2" fill="${color}" />`;
      break;
    case "smile":
      symbol = `<circle cx="12" cy="12" r="9" fill="none" stroke="${color}" stroke-width="2" /><circle cx="8.5" cy="10" r="1.2" fill="${color}" /><circle cx="15.5" cy="10" r="1.2" fill="${color}" /><path d="${STAMP_SVG_PATHS.smileMouth}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" />`;
      break;
    case "sparkle":
      symbol = `<path d="${STAMP_SVG_PATHS.sparkle}" fill="${color}" />`;
      break;
  }
  const attributes = [
    `transform="${transformAttribute(item)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
  ].join(" ");
  return `<g ${attributes}><g transform="${symbolTransform}">${symbol}</g></g>`;
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
    case "sticky":
      return renderSticky(item);
    case "stamp":
      return renderStamp(item);
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
