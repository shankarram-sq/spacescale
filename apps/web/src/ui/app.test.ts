import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "../types";
import { boardIdFromPath, clampStickyText, localSvg, STICKY_COLORS } from "./app";

const boardId = "b_1234567890123456789012";

describe("board path routing", () => {
  it("accepts normal and classroom embed board paths", () => {
    expect(boardIdFromPath(`/b/${boardId}`)).toBe(boardId);
    expect(boardIdFromPath(`/b/${boardId}/`)).toBe(boardId);
    expect(boardIdFromPath(`/embed/b/${boardId}`)).toBe(boardId);
    expect(boardIdFromPath(`/embed/b/${boardId}/`)).toBe(boardId);
  });

  it("rejects launch and malformed paths", () => {
    expect(boardIdFromPath("/embed")).toBeNull();
    expect(boardIdFromPath(`/other/b/${boardId}`)).toBeNull();
    expect(boardIdFromPath("/embed/b/not-a-board")).toBeNull();
  });
});

describe("sticky note UI configuration", () => {
  it("offers the six classroom palette colours", () => {
    expect(STICKY_COLORS.map(({ name }) => name)).toEqual([
      "Yellow",
      "Pink",
      "Blue",
      "Green",
      "Purple",
      "Orange",
    ]);
    expect(STICKY_COLORS.every(({ value }) => /^#[0-9a-f]{6}$/.test(value))).toBe(true);
  });

  it("limits input by Unicode code point rather than UTF-16 length", () => {
    const value = `${"😀".repeat(1_000)}overflow`;
    const clamped = clampStickyText(value);
    expect([...clamped]).toHaveLength(1_000);
    expect(clamped).toBe("😀".repeat(1_000));
  });

  it("escapes the accessible title and wraps escaped sticky text in local SVG", () => {
    const snapshot: BoardSnapshot = {
      format: "cf-whiteboard-json",
      version: 1,
      seq: 4,
      items: [
        {
          id: "018f47a1-7a2b-7c3d-8e4f-123456789abd",
          kind: "sticky",
          z: 1,
          version: 4,
          createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
          transform: [1, 0, 0, 1, 0, 0],
          style: {
            kind: "sticky",
            fill: "#fde68a",
            textColor: "#292524",
            fontSize: 20,
            opacity: 1,
          },
          geometry: {
            x: 10,
            y: 20,
            width: 180,
            height: 140,
            text: "one <tag> & two three four",
          },
        },
      ],
    };

    const svg = localSvg(snapshot, `Class "<ideas>" & 'notes'`);

    expect(svg).toContain('aria-label="Class &quot;&lt;ideas&gt;&quot; &amp; &apos;notes&apos;"');
    expect(svg).toContain('<tspan x="24" dy="0">one &lt;tag&gt; &amp;</tspan>');
    expect(svg).toContain('<tspan x="24" dy="24">two three</tspan>');
    expect(svg).not.toContain("<tag>");
  });

  it("frames a sticky using its complete affine transform", () => {
    const snapshot: BoardSnapshot = {
      format: "cf-whiteboard-json",
      version: 1,
      seq: 1,
      items: [
        {
          id: "018f47a1-7a2b-7c3d-8e4f-123456789abe",
          kind: "sticky",
          z: 1,
          version: 1,
          createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
          transform: [0, 1, -1, 0, 200, 10],
          style: {
            kind: "sticky",
            fill: "#fde68a",
            textColor: "#292524",
            fontSize: 20,
            opacity: 1,
          },
          geometry: { x: 0, y: 0, width: 100, height: 50, text: "Rotated" },
        },
      ],
    };

    expect(localSvg(snapshot, "Rotated sticky")).toContain('viewBox="118 -22 114 164"');
  });
});
