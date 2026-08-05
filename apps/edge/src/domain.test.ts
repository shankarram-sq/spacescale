import { describe, expect, it } from "vitest";
import { BoardDomainError, parseCommitFrame, prepareItemOperation } from "./domain";
import { serializeAuthoritativeSvg } from "./svg";

const actorId = "a_AAAAAAAAAAAAAAAAAAAAAA";
const itemId = "018f0000-0000-7000-8000-000000000001";

function createFrame() {
  return {
    v: 1,
    t: "client.commit",
    commandId: "018f0000-0000-7000-8000-000000000010",
    actionId: "018f0000-0000-7000-8000-000000000011",
    baseSeq: 0,
    op: {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "rectangle",
        style: { kind: "stroke", color: "#112233", width: 2, opacity: 0.5 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 10, y: 20, width: -5, height: 8 },
      },
    },
  };
}

describe("edge domain admission", () => {
  it("normalizes and prepares a canonical create with private lineage", () => {
    const parsed = parseCommitFrame(createFrame());
    if (parsed.op.kind !== "item.create") throw new Error("unexpected operation");
    const tokens = ["after"];
    const prepared = prepareItemOperation(parsed.op, new Map(), {
      seq: 1,
      actorId,
      nextZ: 1,
      liveCount: 0,
      tokenFactory: () => tokens.shift() ?? "extra",
    });
    const write = prepared.writes.get(itemId);
    expect(write?.item).toMatchObject({ z: 1, version: 1, createdBy: actorId });
    expect(write?.item.geometry).toEqual({ x: 5, y: 20, width: 5, height: 8 });
    expect(prepared.effects[0]).toMatchObject({
      itemId,
      beforeStateToken: `absent:${itemId}`,
      afterStateToken: "after",
    });
  });

  it("rejects server-owned create fields and unsafe/unknown input", () => {
    const frame = createFrame();
    Object.assign(frame.op.item, { createdBy: actorId });
    expect(() => parseCommitFrame(frame)).toThrow(BoardDomainError);
  });

  it("escapes all user text in authoritative SVG", () => {
    const svg = serializeAuthoritativeSvg({
      boardId: "b_AAAAAAAAAAAAAAAAAAAAAA",
      seq: 1,
      title: "<unsafe>",
      items: [
        {
          id: itemId,
          kind: "text",
          z: 1,
          version: 1,
          createdBy: actorId,
          style: { kind: "text", color: "#112233", fontSize: 20, opacity: 1 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 0, y: 0, text: '<script>alert("x")</script>' },
        },
      ],
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("foreignObject");
  });
});
