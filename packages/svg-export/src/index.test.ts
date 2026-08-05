import type { BoardItem } from "@collab/protocol";
import { describe, expect, it } from "vitest";
import { createSvgExport, SvgExportError, serializeSvg, svgDownloadHeaders } from "./index.js";

const ACTOR = "018f0000-0000-7000-8000-0000000000a1";
const BOARD = "018f0000-0000-7000-8000-0000000000ff";

function rectangle(id: string, z: number): BoardItem {
  return {
    id,
    kind: "rectangle",
    z,
    version: 1,
    createdBy: ACTOR,
    style: { kind: "stroke", color: "#123456", width: 2, opacity: 0.75 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 10, height: 20 },
  };
}

describe("safe SVG serialization", () => {
  it("escapes text, title, attributes, and never emits user markup", () => {
    const text: BoardItem = {
      id: "018f0000-0000-7000-8000-000000000001",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: ACTOR,
      style: { kind: "text", color: "#000000", fontSize: 16, opacity: 1 },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 4, y: 8, text: `<script>alert("x")</script> & 'ok'` },
    };
    const svg = serializeSvg({
      boardId: BOARD,
      seq: 3,
      title: `"><script>title</script>`,
      items: [text],
    });
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("onload=");
    expect(svg).toContain("&lt;script&gt;alert(\"x\")&lt;/script&gt; &amp; 'ok'");
    expect(svg).toContain('<title>"&gt;&lt;script&gt;title&lt;/script&gt;</title>');
    expect(svg).not.toContain("foreignObject");
  });

  it("derives a padded viewBox from canonical transformed stroke bounds", () => {
    const result = createSvgExport({
      boardId: BOARD,
      seq: 1,
      padding: 10,
      items: [rectangle("018f0000-0000-7000-8000-000000000001", 1)],
    });
    expect(result.viewBox).toEqual({ minX: -11, minY: -11, maxX: 21, maxY: 31 });
    expect(result.svg).toContain('viewBox="-11 -11 32 42"');
    expect(result.svg).toContain('data-format="cf-whiteboard-svg"');
    expect(result.svg).toContain('data-seq="1"');
  });

  it("sorts paint order and supports multiline plain text with tspans", () => {
    const later = rectangle("018f0000-0000-7000-8000-000000000002", 2);
    const earlier = rectangle("018f0000-0000-7000-8000-000000000001", 1);
    const svg = serializeSvg({ boardId: BOARD, seq: 2, items: [later, earlier] });
    expect(svg.indexOf(earlier.id)).toBeLessThan(svg.indexOf(later.id));

    const text: BoardItem = {
      id: "018f0000-0000-7000-8000-000000000003",
      kind: "text",
      z: 3,
      version: 2,
      createdBy: ACTOR,
      style: { kind: "text", color: "#112233", fontSize: 10, opacity: 1 },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 1, y: 2, text: "one\ntwo" },
    };
    expect(serializeSvg({ boardId: BOARD, seq: 2, items: [text] })).toContain(
      '<tspan x="1" dy="12">two</tspan>',
    );
  });

  it("rejects unrecognized/non-canonical items rather than serializing arbitrary data", () => {
    expect(() =>
      serializeSvg({
        boardId: BOARD,
        seq: 1,
        items: [
          {
            ...rectangle("018f0000-0000-7000-8000-000000000001", 1),
            kind: "image",
            href: "https://bad",
          } as never,
        ],
      }),
    ).toThrow(SvgExportError);
  });

  it("returns hardened download headers", () => {
    expect(svgDownloadHeaders("../bad\r\nX-Evil: yes.svg")).toEqual({
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="_bad__X-Evil__yes.svg"',
    });
  });
});
