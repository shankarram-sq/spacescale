import { describe, expect, it } from "vitest";
import { parseImageAsset, requireImageAssetMimeType } from "./image-assets";

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function jpeg(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff,
    0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
  ]);
}

function extendedWebpWithFrameSize(width: number, height: number): Uint8Array {
  const simple = decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89");
  const frameChunk = simple.slice(12);
  frameChunk[14] = width & 0xff;
  frameChunk[15] = (width >>> 8) & 0x3f;
  frameChunk[16] = height & 0xff;
  frameChunk[17] = (height >>> 8) & 0x3f;
  const extendedHeader = Uint8Array.from([
    0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const bytes = new Uint8Array(12 + extendedHeader.byteLength + frameChunk.byteLength);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  const containerLength = bytes.byteLength - 8;
  bytes.set(
    [
      containerLength & 0xff,
      (containerLength >>> 8) & 0xff,
      (containerLength >>> 16) & 0xff,
      (containerLength >>> 24) & 0xff,
    ],
    4,
  );
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set(extendedHeader, 12);
  bytes.set(frameChunk, 12 + extendedHeader.byteLength);
  return bytes;
}

describe("strict image asset inspection", () => {
  it("reads dimensions from each supported magic-byte format", () => {
    const fixtures = [
      {
        bytes: decode(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        ),
        mimeType: "image/png" as const,
      },
      { bytes: jpeg(), mimeType: "image/jpeg" as const },
      {
        bytes: decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89"),
        mimeType: "image/webp" as const,
      },
      {
        bytes: decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs="),
        mimeType: "image/gif" as const,
      },
    ];

    for (const fixture of fixtures) {
      expect(parseImageAsset(fixture.bytes, fixture.mimeType)).toEqual({
        mimeType: fixture.mimeType,
        intrinsicWidth: 1,
        intrinsicHeight: 1,
      });
    }
  });

  it("rejects MIME parameters, mismatches, truncation, and trailing polyglot data", () => {
    const gif = decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=");
    expect(() => requireImageAssetMimeType("image/gif; charset=utf-8")).toThrow();
    expect(() => parseImageAsset(gif, "image/png")).toThrow();
    expect(() => parseImageAsset(gif.subarray(0, gif.byteLength - 1), "image/gif")).toThrow();
    expect(() =>
      parseImageAsset(Uint8Array.from([...gif, 0x3c, 0x73, 0x76, 0x67]), "image/gif"),
    ).toThrow();
    expect(() =>
      parseImageAsset(Uint8Array.from([...jpeg(), 0x3c, 0x68, 0x74, 0x6d, 0x6c]), "image/jpeg"),
    ).toThrow();
  });

  it("rejects animated GIF and WebP containers", () => {
    const gif = decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=");
    const imageBlock = gif.subarray(19, gif.byteLength - 1);
    expect(() =>
      parseImageAsset(
        Uint8Array.from([...gif.subarray(0, gif.byteLength - 1), ...imageBlock, 0x3b]),
        "image/gif",
      ),
    ).toThrow();

    const animatedWebp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
      0x58, 0x0a, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(() => parseImageAsset(animatedWebp, "image/webp")).toThrow();
  });

  it("rejects oversized or mismatched WebP frames hidden behind a small VP8X canvas", () => {
    expect(() => parseImageAsset(extendedWebpWithFrameSize(5_000, 5_000), "image/webp")).toThrow(
      /dimensions/u,
    );
    expect(() => parseImageAsset(extendedWebpWithFrameSize(2, 1), "image/webp")).toThrow(
      /do not match/u,
    );
  });

  it("rejects embedded identity and location metadata across supported formats", () => {
    const png = decode(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );
    const pngMetadata = Uint8Array.from([
      ...png.subarray(0, 33),
      0,
      0,
      0,
      1,
      0x74,
      0x45,
      0x58,
      0x74,
      0x41,
      0,
      0,
      0,
      0,
      ...png.subarray(33),
    ]);
    const jpegMetadata = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe1,
      0x00,
      0x08,
      0x45,
      0x78,
      0x69,
      0x66,
      0x00,
      0x00,
      ...jpeg().subarray(2),
    ]);
    const gif = decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=");
    const gifMetadata = Uint8Array.from([
      ...gif.subarray(0, 19),
      0x21,
      0xfe,
      0x01,
      0x41,
      0x00,
      ...gif.subarray(19),
    ]);

    expect(() => parseImageAsset(pngMetadata, "image/png")).toThrow(/metadata/u);
    expect(() => parseImageAsset(jpegMetadata, "image/jpeg")).toThrow(/metadata/u);
    expect(() => parseImageAsset(gifMetadata, "image/gif")).toThrow(/metadata/u);
  });

  it("rejects GIF image data without a complete LZW ending", () => {
    const missingEndCode = decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
    expect(() => parseImageAsset(missingEndCode, "image/gif")).toThrow();
  });
});
