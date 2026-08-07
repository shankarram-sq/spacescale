import {
  IMAGE_MIME_TYPES,
  type ImageMimeType,
  MAX_IMAGE_INTRINSIC_DIMENSION,
  MAX_IMAGE_INTRINSIC_PIXELS,
} from "@collab/protocol";
import { HttpError } from "./http/errors";

export const MAX_IMAGE_ASSET_BYTES = 5 * 1_024 * 1_024;
export const MAX_IMAGE_ASSET_SIDE = MAX_IMAGE_INTRINSIC_DIMENSION;
export const MAX_IMAGE_ASSET_PIXELS = MAX_IMAGE_INTRINSIC_PIXELS;
export const MAX_IMAGE_ASSETS_PER_BOARD = 25;
export const MAX_IMAGE_ASSET_BYTES_PER_BOARD = 64 * 1_024 * 1_024;

export type ImageAssetMimeType = ImageMimeType;

export interface ParsedImageAsset {
  mimeType: ImageAssetMimeType;
  intrinsicWidth: number;
  intrinsicHeight: number;
}

const ALLOWED_MIME_TYPES = new Set<ImageAssetMimeType>(IMAGE_MIME_TYPES);
const SAFE_PNG_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "sRGB",
  "sBIT",
  "bKGD",
  "hIST",
  "pHYs",
]);
const SAFE_WEBP_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH"]);

export function requireImageAssetMimeType(value: string | null): ImageAssetMimeType {
  const mimeType = value?.trim().toLowerCase();
  if (mimeType === undefined || !ALLOWED_MIME_TYPES.has(mimeType as ImageAssetMimeType)) {
    throw new HttpError(
      415,
      "BAD_REQUEST",
      "Content-Type must be image/png, image/jpeg, image/webp, or image/gif.",
    );
  }
  return mimeType as ImageAssetMimeType;
}

export function parseImageAsset(
  bytes: Uint8Array,
  declaredMimeType: ImageAssetMimeType,
): ParsedImageAsset {
  const parsed = detectAndParse(bytes);
  if (parsed.mimeType !== declaredMimeType) {
    throw invalidImage("The image bytes do not match the declared Content-Type.");
  }
  assertDimensions(parsed.intrinsicWidth, parsed.intrinsicHeight);
  return parsed;
}

function detectAndParse(bytes: Uint8Array): ParsedImageAsset {
  if (hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return parsePng(bytes);
  }
  if (hasBytes(bytes, 0, [0xff, 0xd8])) return parseJpeg(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return parseWebp(bytes);
  }
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return parseGif(bytes);
  }
  throw invalidImage("The upload is not a supported image file.");
}

function parsePng(bytes: Uint8Array): ParsedImageAsset {
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw invalidImage("The PNG file is truncated.");
    const length = readU32Be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!/^[A-Za-z]{4}$/u.test(type) || dataEnd < dataStart || chunkEnd > bytes.byteLength) {
      throw invalidImage("The PNG chunk structure is invalid.");
    }
    if (!SAFE_PNG_CHUNKS.has(type)) throw imageMetadataError();
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== readU32Be(bytes, dataEnd)) {
      throw invalidImage("The PNG checksum is invalid.");
    }

    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw invalidImage("The PNG header is invalid.");
      width = readU32Be(bytes, dataStart);
      height = readU32Be(bytes, dataStart + 4);
      const bitDepth = bytes[dataStart + 8] ?? -1;
      const colorType = bytes[dataStart + 9] ?? -1;
      const validDepths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !validDepths[colorType]?.includes(bitDepth) ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        (bytes[dataStart + 12] !== 0 && bytes[dataStart + 12] !== 1)
      ) {
        throw invalidImage("The PNG header uses unsupported values.");
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      throw invalidImage("The PNG contains more than one header.");
    }

    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw invalidImage("Animated PNG files are not supported.");
    }
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (length !== 0 || !sawData || chunkEnd !== bytes.byteLength) {
        throw invalidImage("The PNG ending is invalid.");
      }
      sawEnd = true;
    }
    offset = chunkEnd;
    if (sawEnd) break;
  }

  if (!sawHeader || !sawData || !sawEnd) throw invalidImage("The PNG file is incomplete.");
  return { mimeType: "image/png", intrinsicWidth: width, intrinsicHeight: height };
}

function parseJpeg(bytes: Uint8Array): ParsedImageAsset {
  if (bytes.byteLength < 4 || !hasBytes(bytes, 0, [0xff, 0xd8])) {
    throw invalidImage("The JPEG header is invalid.");
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let inScan = false;

  while (offset < bytes.byteLength) {
    if (inScan) {
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let markerOffset = offset + 1;
        while (bytes[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= bytes.byteLength) throw invalidImage("The JPEG scan is truncated.");
        const marker = bytes[markerOffset] ?? -1;
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset = markerOffset + 1;
          continue;
        }
        inScan = false;
        break;
      }
      if (inScan) throw invalidImage("The JPEG scan is incomplete.");
    }

    if (bytes[offset] !== 0xff) throw invalidImage("The JPEG marker stream is invalid.");
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) throw invalidImage("The JPEG marker is truncated.");
    const marker = bytes[offset] ?? -1;
    offset += 1;

    if (marker === 0xd9) {
      if (!sawFrame || offset !== bytes.byteLength) {
        throw invalidImage("The JPEG ending is invalid.");
      }
      return { mimeType: "image/jpeg", intrinsicWidth: width, intrinsicHeight: height };
    }
    if (
      marker === 0x00 ||
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      throw invalidImage("The JPEG contains an invalid standalone marker.");
    }
    if (offset + 2 > bytes.byteLength) throw invalidImage("The JPEG segment is truncated.");
    const length = readU16Be(bytes, offset);
    if (length < 2 || offset + length > bytes.byteLength) {
      throw invalidImage("The JPEG segment length is invalid.");
    }
    const dataStart = offset + 2;
    const dataEnd = offset + length;

    if (marker === 0xfe || (marker >= 0xe1 && marker <= 0xef)) {
      throw imageMetadataError();
    }
    if (
      marker === 0xe0 &&
      ascii(bytes, dataStart, Math.min(5, dataEnd - dataStart)) !== "JFIF\0" &&
      ascii(bytes, dataStart, Math.min(5, dataEnd - dataStart)) !== "JFXX\0"
    ) {
      throw imageMetadataError();
    }

    if (isStartOfFrame(marker)) {
      if (sawFrame || length < 8) throw invalidImage("The JPEG frame header is invalid.");
      const components = bytes[dataStart + 5] ?? 0;
      if (components < 1 || length !== 8 + 3 * components) {
        throw invalidImage("The JPEG frame component data is invalid.");
      }
      height = readU16Be(bytes, dataStart + 1);
      width = readU16Be(bytes, dataStart + 3);
      sawFrame = true;
    }
    offset = dataEnd;
    if (marker === 0xda) {
      if (!sawFrame) throw invalidImage("The JPEG scan appears before its frame header.");
      inScan = true;
    }
  }
  throw invalidImage("The JPEG file has no complete ending.");
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function parseWebp(bytes: Uint8Array): ParsedImageAsset {
  if (bytes.byteLength < 20 || readU32Le(bytes, 4) + 8 !== bytes.byteLength) {
    throw invalidImage("The WebP container length is invalid.");
  }
  let offset = 12;
  let width = 0;
  let height = 0;
  let imageChunks = 0;
  let extended = false;

  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw invalidImage("The WebP chunk is truncated.");
    const type = ascii(bytes, offset, 4);
    const length = readU32Le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length % 2);
    if (dataEnd < dataStart || chunkEnd > bytes.byteLength) {
      throw invalidImage("The WebP chunk length is invalid.");
    }
    if (!SAFE_WEBP_CHUNKS.has(type)) {
      throw invalidImage("The WebP file contains an unsupported chunk.");
    }

    if (type === "VP8X") {
      if (offset !== 12 || extended || length !== 10) {
        throw invalidImage("The WebP extended header is invalid.");
      }
      const flags = bytes[dataStart] ?? 0;
      if ((flags & 0x02) !== 0) throw invalidImage("Animated WebP files are not supported.");
      if ((flags & 0x2c) !== 0) throw imageMetadataError();
      if ((flags & 0xc1) !== 0) throw invalidImage("The WebP header uses reserved flags.");
      width = readU24Le(bytes, dataStart + 4) + 1;
      height = readU24Le(bytes, dataStart + 7) + 1;
      extended = true;
    } else if (type === "VP8 ") {
      imageChunks += 1;
      if (
        length < 10 ||
        ((bytes[dataStart] ?? 1) & 1) !== 0 ||
        !hasBytes(bytes, dataStart + 3, [0x9d, 0x01, 0x2a])
      ) {
        throw invalidImage("The WebP VP8 frame header is invalid.");
      }
      const frameWidth = readU16Le(bytes, dataStart + 6) & 0x3fff;
      const frameHeight = readU16Le(bytes, dataStart + 8) & 0x3fff;
      assertDimensions(frameWidth, frameHeight);
      if (extended) {
        if (frameWidth !== width || frameHeight !== height) {
          throw invalidImage("The WebP frame dimensions do not match its canvas.");
        }
      } else {
        width = frameWidth;
        height = frameHeight;
      }
    } else if (type === "VP8L") {
      imageChunks += 1;
      if (length < 5 || bytes[dataStart] !== 0x2f) {
        throw invalidImage("The WebP lossless frame header is invalid.");
      }
      const packed = readU32Le(bytes, dataStart + 1);
      const frameWidth = (packed & 0x3fff) + 1;
      const frameHeight = ((packed >>> 14) & 0x3fff) + 1;
      assertDimensions(frameWidth, frameHeight);
      if (extended) {
        if (frameWidth !== width || frameHeight !== height) {
          throw invalidImage("The WebP frame dimensions do not match its canvas.");
        }
      } else {
        width = frameWidth;
        height = frameHeight;
      }
    }
    offset = chunkEnd;
  }

  if (offset !== bytes.byteLength || imageChunks !== 1) {
    throw invalidImage("The WebP file must contain exactly one static image.");
  }
  return { mimeType: "image/webp", intrinsicWidth: width, intrinsicHeight: height };
}

function parseGif(bytes: Uint8Array): ParsedImageAsset {
  if (bytes.byteLength < 14) throw invalidImage("The GIF header is truncated.");
  const width = readU16Le(bytes, 6);
  const height = readU16Le(bytes, 8);
  const packed = bytes[10] ?? 0;
  const hasGlobalColorTable = (packed & 0x80) !== 0;
  const globalColorTableEntries = hasGlobalColorTable ? 1 << ((packed & 0x07) + 1) : 0;
  let offset = 13;
  if (hasGlobalColorTable) offset += 3 * globalColorTableEntries;
  if (offset > bytes.byteLength) throw invalidImage("The GIF color table is truncated.");
  let images = 0;
  let graphicControlPending = false;

  while (offset < bytes.byteLength) {
    const introducer = bytes[offset] ?? -1;
    offset += 1;
    if (introducer === 0x3b) {
      if (images !== 1 || graphicControlPending || offset !== bytes.byteLength) {
        throw invalidImage("The GIF must contain exactly one static image.");
      }
      return { mimeType: "image/gif", intrinsicWidth: width, intrinsicHeight: height };
    }
    if (introducer === 0x2c) {
      if (images !== 0 || offset + 9 > bytes.byteLength) {
        throw invalidImage("Animated GIF files are not supported.");
      }
      const left = readU16Le(bytes, offset);
      const top = readU16Le(bytes, offset + 2);
      const frameWidth = readU16Le(bytes, offset + 4);
      const frameHeight = readU16Le(bytes, offset + 6);
      const descriptorPacked = bytes[offset + 8] ?? 0;
      if ((descriptorPacked & 0x18) !== 0) {
        throw invalidImage("The GIF image descriptor uses reserved flags.");
      }
      offset += 9;
      assertDimensions(frameWidth, frameHeight);
      if (left + frameWidth > width || top + frameHeight > height) {
        throw invalidImage("The GIF frame falls outside its canvas.");
      }
      const hasLocalColorTable = (descriptorPacked & 0x80) !== 0;
      const localColorTableEntries = hasLocalColorTable ? 1 << ((descriptorPacked & 0x07) + 1) : 0;
      if (!hasGlobalColorTable && !hasLocalColorTable) {
        throw invalidImage("The GIF image has no color table.");
      }
      if (hasLocalColorTable) offset += 3 * localColorTableEntries;
      if (offset >= bytes.byteLength) throw invalidImage("The GIF image data is truncated.");
      const minimumCodeSize = bytes[offset] ?? 0;
      offset += 1;
      if (minimumCodeSize < 2 || minimumCodeSize > 8) {
        throw invalidImage("The GIF LZW code size is invalid.");
      }
      const imageData = readGifSubBlocks(bytes, offset, true, true);
      validateGifLzw(
        imageData.data,
        minimumCodeSize,
        frameWidth * frameHeight,
        localColorTableEntries || globalColorTableEntries,
      );
      offset = imageData.offset;
      images += 1;
      graphicControlPending = false;
      continue;
    }
    if (introducer !== 0x21 || offset >= bytes.byteLength) {
      throw invalidImage("The GIF block structure is invalid.");
    }
    const label = bytes[offset] ?? -1;
    offset += 1;
    if (label === 0xf9) {
      if (graphicControlPending || offset + 6 > bytes.byteLength || bytes[offset] !== 4) {
        throw invalidImage("The GIF graphic control block is invalid.");
      }
      offset += 5;
      if (bytes[offset] !== 0) throw invalidImage("The GIF extension is not terminated.");
      offset += 1;
      graphicControlPending = true;
    } else if (label === 0xfe) {
      throw imageMetadataError();
    } else {
      // Application and plain-text extensions can alter playback/rendering.
      throw invalidImage("The GIF contains an unsupported extension.");
    }
  }
  throw invalidImage("The GIF file has no complete ending.");
}

function readGifSubBlocks(
  bytes: Uint8Array,
  offset: number,
  requireData: boolean,
  collectData: boolean,
): { offset: number; data: Uint8Array } {
  const chunks: Uint8Array[] = [];
  let dataBytes = 0;
  while (offset < bytes.byteLength) {
    const length = bytes[offset] ?? 0;
    offset += 1;
    if (length === 0) {
      if (requireData && dataBytes === 0) throw invalidImage("The GIF image data is empty.");
      const data = new Uint8Array(collectData ? dataBytes : 0);
      if (collectData) {
        let dataOffset = 0;
        for (const chunk of chunks) {
          data.set(chunk, dataOffset);
          dataOffset += chunk.byteLength;
        }
      }
      return { offset, data };
    }
    if (offset + length > bytes.byteLength) throw invalidImage("The GIF sub-block is truncated.");
    if (collectData) chunks.push(bytes.subarray(offset, offset + length));
    dataBytes += length;
    offset += length;
  }
  throw invalidImage("The GIF sub-block is not terminated.");
}

function validateGifLzw(
  data: Uint8Array,
  minimumCodeSize: number,
  expectedPixels: number,
  colorTableEntries: number,
): void {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const entryLengths = new Uint32Array(4_096);
  for (let literal = 0; literal < clearCode; literal += 1) {
    entryLengths[literal] = 1;
  }

  let bitOffset = 0;
  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let previousCode: number | null = null;
  let decodedPixels = 0;
  let sawClear = false;

  while (bitOffset + codeSize <= data.byteLength * 8) {
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const absoluteBit = bitOffset + bit;
      code |= (((data[absoluteBit >>> 3] ?? 0) >>> (absoluteBit & 7)) & 1) << bit;
    }
    bitOffset += codeSize;

    if (code === clearCode) {
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
      previousCode = null;
      sawClear = true;
      continue;
    }
    if (!sawClear) throw invalidImage("The GIF LZW stream has no initial clear code.");
    if (code === endCode) {
      if (decodedPixels !== expectedPixels) {
        throw invalidImage("The GIF LZW stream has the wrong pixel count.");
      }
      return;
    }

    let entryLength: number;
    if (code < clearCode) {
      if (code >= colorTableEntries) {
        throw invalidImage("The GIF image references a missing color-table entry.");
      }
      entryLength = 1;
    } else if (code < nextCode && entryLengths[code] !== 0) {
      entryLength = entryLengths[code] ?? 0;
    } else if (code === nextCode && previousCode !== null) {
      entryLength = (entryLengths[previousCode] ?? 0) + 1;
    } else {
      throw invalidImage("The GIF LZW stream contains an invalid dictionary code.");
    }

    decodedPixels += entryLength;
    if (decodedPixels > expectedPixels) {
      throw invalidImage("The GIF LZW stream contains too many pixels.");
    }

    if (previousCode !== null && nextCode < 4_096) {
      entryLengths[nextCode] = (entryLengths[previousCode] ?? 0) + 1;
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previousCode = code;
  }

  throw invalidImage("The GIF LZW stream has no complete ending.");
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_ASSET_SIDE ||
    height > MAX_IMAGE_ASSET_SIDE ||
    width * height > MAX_IMAGE_ASSET_PIXELS
  ) {
    throw invalidImage(
      `Image dimensions must be at most ${MAX_IMAGE_ASSET_SIDE} pixels per side and ${MAX_IMAGE_ASSET_PIXELS} pixels total.`,
    );
  }
}

function invalidImage(message: string): HttpError {
  return new HttpError(400, "BAD_REQUEST", message);
}

function imageMetadataError(): HttpError {
  return invalidImage("Image metadata must be removed before upload.");
}

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return "";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function readU16Be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU24Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readU32Be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1_000_000 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readU32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (bytes[offset + 3] ?? 0) * 0x1_000_000
  );
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
