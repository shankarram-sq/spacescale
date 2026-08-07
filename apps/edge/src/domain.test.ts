import { describe, expect, it } from "vitest";
import {
  BoardDomainError,
  canonicalItemFromUnknown,
  parseCommitFrame,
  prepareItemOperation,
} from "./domain";
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

function createStickyFrame(text = "") {
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
        kind: "sticky",
        style: {
          kind: "sticky",
          fill: "#fff2a8",
          textColor: "#2f2a1f",
          fontSize: 20,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 10, y: 20, width: 180, height: 140, text },
      },
    },
  };
}

function createStampFrame(stamp = "check") {
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
        kind: "stamp",
        style: { kind: "stamp", color: "#16a34a", opacity: 0.75 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 60, y: 70, size: 72, stamp },
      },
    },
  };
}

function createTableFrame() {
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
        kind: "table",
        style: {
          kind: "table",
          borderColor: "#64748b",
          fill: "#ffffff",
          headerFill: "#e2e8f0",
          textColor: "#0f172a",
          fontSize: 18,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: 10,
          y: 20,
          columnWidths: [120, 120, 120],
          rowHeights: [48, 48, 48],
          cells: [
            ["Know", "Want", "Learned"],
            ["", "", ""],
            ["", "", ""],
          ],
          headerRow: true,
        },
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

  it("accepts an empty sticky draft and computes its full rectangular bounds", () => {
    const parsed = parseCommitFrame(createStickyFrame());
    if (parsed.op.kind !== "item.create") throw new Error("unexpected operation");
    const prepared = prepareItemOperation(parsed.op, new Map(), {
      seq: 1,
      actorId,
      nextZ: 1,
      liveCount: 0,
      tokenFactory: () => "sticky-state",
    });

    const write = prepared.writes.get(itemId);
    expect(write?.item).toMatchObject({
      kind: "sticky",
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "" },
    });
    expect(write?.bounds).toEqual({ minX: 10, minY: 20, maxX: 190, maxY: 160 });
  });

  it("admits every stamp, stores it canonically, and computes centered square bounds", () => {
    for (const stamp of ["star", "check", "heart", "question", "smile", "sparkle"]) {
      expect(parseCommitFrame(createStampFrame(stamp)).op).toMatchObject({
        kind: "item.create",
        item: { kind: "stamp", geometry: { stamp } },
      });
    }
    const parsed = parseCommitFrame(createStampFrame("check"));
    if (parsed.op.kind !== "item.create") throw new Error("unexpected operation");
    const prepared = prepareItemOperation(parsed.op, new Map(), {
      seq: 1,
      actorId,
      nextZ: 1,
      liveCount: 0,
      tokenFactory: () => "stamp-state",
    });
    const write = prepared.writes.get(itemId);
    expect(write?.item).toMatchObject({
      kind: "stamp",
      style: { kind: "stamp", color: "#16a34a", opacity: 0.75 },
      geometry: { x: 60, y: 70, size: 72, stamp: "check" },
    });
    expect(write?.bounds).toEqual({ minX: 24, minY: 34, maxX: 96, maxY: 106 });
    expect(canonicalItemFromUnknown(JSON.parse(JSON.stringify(write?.item)))).toEqual(write?.item);

    const unknown = createStampFrame("award");
    expect(() => parseCommitFrame(unknown)).toThrow(BoardDomainError);
    const unsafeColor = createStampFrame();
    unsafeColor.op.item.style.color = "#16A34A";
    expect(() => parseCommitFrame(unsafeColor)).toThrow(BoardDomainError);
  });

  it("admits a bounded plain-text table and round-trips its canonical storage form", () => {
    const parsed = parseCommitFrame(createTableFrame());
    if (parsed.op.kind !== "item.create") throw new Error("unexpected operation");
    const prepared = prepareItemOperation(parsed.op, new Map(), {
      seq: 1,
      actorId,
      nextZ: 1,
      liveCount: 0,
      tokenFactory: () => "table-state",
    });

    const write = prepared.writes.get(itemId);
    expect(write?.item).toMatchObject({
      kind: "table",
      z: 1,
      version: 1,
      createdBy: actorId,
      geometry: {
        x: 10,
        y: 20,
        columnWidths: [120, 120, 120],
        rowHeights: [48, 48, 48],
        cells: [
          ["Know", "Want", "Learned"],
          ["", "", ""],
          ["", "", ""],
        ],
        headerRow: true,
      },
    });
    expect(write?.bounds).toEqual({ minX: 10, minY: 20, maxX: 370, maxY: 164 });
    expect(canonicalItemFromUnknown(JSON.parse(JSON.stringify(write?.item)))).toEqual(write?.item);
  });

  it("rejects malformed tables at the edge admission boundary", () => {
    const ragged = createTableFrame();
    ragged.op.item.geometry.cells[1] = ["only one cell"];
    expect(() => parseCommitFrame(ragged)).toThrow(BoardDomainError);

    const mismatchedColumns = createTableFrame();
    mismatchedColumns.op.item.geometry.columnWidths = [120, 120];
    expect(() => parseCommitFrame(mismatchedColumns)).toThrow(BoardDomainError);

    const unsafeText = createTableFrame();
    unsafeText.op.item.geometry.cells[1] = ["", "hidden\u0000control", ""];
    expect(() => parseCommitFrame(unsafeText)).toThrow(BoardDomainError);

    const oversizedCell = createTableFrame();
    oversizedCell.op.item.geometry.cells[1] = ["", "🙂".repeat(501), ""];
    expect(() => parseCommitFrame(oversizedCell)).toThrow(BoardDomainError);

    const tooManyRows = createTableFrame();
    tooManyRows.op.item.geometry.rowHeights = Array.from({ length: 9 }, () => 48);
    tooManyRows.op.item.geometry.cells = Array.from({ length: 9 }, () => ["", "", ""]);
    expect(() => parseCommitFrame(tooManyRows)).toThrow(BoardDomainError);
  });

  it("rejects sticky content beyond its classroom-safe limit", () => {
    expect(() => parseCommitFrame(createStickyFrame("🙂".repeat(1_001)))).toThrow(BoardDomainError);
  });

  it("round-trips protocol-valid sticky text through canonical JSON storage", () => {
    const parsed = parseCommitFrame(createStickyFrame("First\rSecond\t🙂"));
    if (parsed.op.kind !== "item.create") throw new Error("unexpected operation");
    const prepared = prepareItemOperation(parsed.op, new Map(), {
      seq: 1,
      actorId,
      nextZ: 1,
      liveCount: 0,
      tokenFactory: () => "sticky-state",
    });
    const stored = prepared.writes.get(itemId)?.item;
    expect(stored).toBeDefined();
    const reread = canonicalItemFromUnknown(JSON.parse(JSON.stringify(stored)));
    expect(reread).toEqual(stored);
  });

  it("rejects unsafe sticky controls and unpaired surrogates at admission and storage read", () => {
    for (const text of ["hidden\u007fcontrol", "hidden\u0085control", "unpaired\ud800"]) {
      expect(() => parseCommitFrame(createStickyFrame(text))).toThrow(BoardDomainError);
    }

    const parsed = parseCommitFrame(createStickyFrame("safe"));
    if (parsed.op.kind !== "item.create") throw new Error("unexpected operation");
    const prepared = prepareItemOperation(parsed.op, new Map(), {
      seq: 1,
      actorId,
      nextZ: 1,
      liveCount: 0,
      tokenFactory: () => "sticky-state",
    });
    const stored = prepared.writes.get(itemId)?.item;
    expect(stored).toBeDefined();
    expect(() =>
      canonicalItemFromUnknown({
        ...stored,
        geometry: { ...stored?.geometry, text: "unpaired\ud800" },
      }),
    ).toThrow(BoardDomainError);
  });

  it("rejects extreme transforms and derived sticky bounds outside the world envelope", () => {
    const extreme = createStickyFrame("Bounded");
    extreme.op.item.transform = [Number.MAX_VALUE, 0, 0, 1, 0, 0];
    expect(() => parseCommitFrame(extreme)).toThrow(BoardDomainError);

    const oversized = createStickyFrame("Bounded");
    oversized.op.item.transform = [1_000_000, 0, 0, 1, 0, 0];
    const parsed = parseCommitFrame(oversized);
    const operation = parsed.op;
    if (operation.kind !== "item.create") throw new Error("unexpected operation");
    expect(() =>
      prepareItemOperation(operation, new Map(), {
        seq: 1,
        actorId,
        nextZ: 1,
        liveCount: 0,
        tokenFactory: () => "sticky-state",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
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
