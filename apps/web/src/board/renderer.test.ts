import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_RENDERED_VOTE_TABLES, VOTE_TABLE_STYLE } from "../activities/voting";
import type { BoardItem, TableItem } from "../types";
import {
  CanvasViewport,
  lineNode,
  renderVoteCounts,
  wrapStickyText,
  wrapTableCellText,
  zoneNode,
} from "./renderer";

describe("connector rendering", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders a plain connector as one shaft", () => {
    const node = lineNode(
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { kind: "line", color: "#20201e", width: 4, opacity: 1, arrowhead: "none" },
    ) as unknown as FakeSvgNode;

    expect(node.children).toHaveLength(1);
    expect(node.children[0]?.classList.values.has("connector-shaft")).toBe(true);
    expect(node.children[0]?.attributes.get("x2")).toBe("100");
  });

  it("renders a shared-math open arrowhead without closing or filling it", () => {
    const node = lineNode(
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { kind: "line", color: "#20201e", width: 4, opacity: 0.8, arrowhead: "arrow" },
    ) as unknown as FakeSvgNode;

    expect(node.children).toHaveLength(2);
    const arrowhead = node.children[1];
    expect(arrowhead?.classList.values.has("connector-arrowhead")).toBe(true);
    expect(arrowhead?.attributes.get("d")).toBe("M 88 5.4 L 100 0 L 88 -5.4");
    expect(arrowhead?.attributes.get("fill")).toBe("none");
    expect(arrowhead?.attributes.get("stroke-opacity")).toBe("0.8");
  });
});

describe("sticky note text wrapping", () => {
  it("wraps words within the default note and preserves blank paragraphs", () => {
    expect(wrapStickyText("one two three four\n\nsix", 180, 140, 20)).toEqual([
      "one two three",
      "four",
      "",
      "six",
    ]);
  });

  it("hard-wraps long Unicode tokens by code point", () => {
    expect(wrapStickyText("😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", 180, 140, 20)).toEqual([
      "😀😀😀😀😀😀😀😀😀😀😀😀😀",
      "😀😀",
    ]);
  });

  it("normalizes common line endings and clips overflowing lines", () => {
    expect(wrapStickyText("one\r\ntwo\rthree\nfour\nfive", 180, 140, 20)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });
});

describe("table cell text wrapping", () => {
  it("wraps plain text within the cell padding and preserves explicit blank lines", () => {
    expect(wrapTableCellText("one two three four\n\nfive", 120, 120, 16)).toEqual([
      "one two",
      "three four",
      "",
      "five",
    ]);
  });

  it("hard-wraps Unicode by code point and clips to the visible row height", () => {
    expect(wrapTableCellText("😀".repeat(24), 120, 64, 16)).toEqual([
      "😀".repeat(11),
      "😀".repeat(11),
    ]);
    expect(wrapTableCellText("", 120, 48, 16)).toEqual([]);
  });
});

type FakeSvgNode = {
  name: string;
  attributes: Map<string, string>;
  children: FakeSvgNode[];
  dataset: Record<string, string>;
  textContent: string | null;
  classList: { values: Set<string>; add: (...names: string[]) => void };
  setAttribute: (name: string, value: string) => void;
  append: (...children: FakeSvgNode[]) => void;
  replaceChildren: (...children: FakeSvgNode[]) => void;
};

function fakeSvgNode(name: string): FakeSvgNode {
  const node: FakeSvgNode = {
    name,
    attributes: new Map(),
    children: [],
    dataset: {},
    textContent: null,
    classList: {
      values: new Set(),
      add: (...names) => {
        for (const value of names) node.classList.values.add(value);
      },
    },
    setAttribute: (attribute, value) => node.attributes.set(attribute, value),
    append: (...children) => node.children.push(...children),
    replaceChildren: (...children) => {
      node.children = [...children];
    },
  };
  return node;
}

describe("zone rendering", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders a named, accessible zone with fill-only opacity", () => {
    const node = zoneNode(
      "zone/unsafe",
      { x: 20, y: 30, width: 520, height: 320, title: "Evidence <script>" },
      {
        kind: "zone",
        borderColor: "#a8a59d",
        fill: "#e8edff",
        textColor: "#4f5b75",
        fontSize: 18,
        opacity: 0.18,
      },
    ) as unknown as FakeSvgNode;

    expect(node.attributes.get("role")).toBe("group");
    expect(node.attributes.get("aria-label")).toBe("Zone: Evidence <script>");
    expect(node.dataset.zoneTitle).toBe("Evidence <script>");
    const fill = node.children.find((child) => child.classList.values.has("zone-fill"));
    const border = node.children.find((child) => child.classList.values.has("zone-border"));
    const title = node.children.find((child) => child.classList.values.has("zone-title"));
    expect(fill?.attributes.get("fill-opacity")).toBe("0.18");
    expect(border?.attributes.get("stroke")).toBe("#a8a59d");
    expect(border?.attributes.has("opacity")).toBe(false);
    expect(title?.textContent).toBe("Evidence <script>");
    expect(title?.children).toHaveLength(0);
    expect(title?.attributes.get("clip-path")).toBe("url(#zone-title-clip-zone-unsafe)");
  });
});

describe("derived vote counts", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders pointer-free count pills and replaces them when stamp totals change", () => {
    const table: TableItem = {
      id: "vote-table",
      kind: "table",
      z: 1,
      version: 1,
      createdBy: "teacher",
      transform: [1, 0, 0, 1, 40, 60],
      style: { ...VOTE_TABLE_STYLE },
      geometry: {
        x: 0,
        y: 0,
        columnWidths: [160, 160],
        rowHeights: [52, 160],
        cells: [
          ["Yes", "Not yet"],
          ["", ""],
        ],
        headerRow: true,
      },
    };
    const first: BoardItem = {
      id: "first-vote",
      kind: "stamp",
      z: 2,
      version: 2,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 40, 60],
      style: { kind: "stamp", color: "#e5484d", opacity: 1 },
      geometry: { x: 80, y: 100, size: 36, stamp: "star" },
    };
    const second: BoardItem = {
      ...first,
      id: "second-vote",
      z: 3,
      version: 3,
      createdBy: "student-b",
      geometry: { x: 240, y: 100, size: 36, stamp: "check" },
    };
    const layer = fakeSvgNode("g");

    renderVoteCounts(layer as unknown as SVGGElement, [table]);
    expect(layer.children).toHaveLength(1);
    expect(layer.children[0]?.attributes.get("pointer-events")).toBe("none");
    expect(layer.children[0]?.attributes.get("transform")).toBe("matrix(1 0 0 1 40 60)");
    expect(layer.children[0]?.children.map((badge) => badge.dataset.voteCount)).toEqual(["0", "0"]);

    renderVoteCounts(layer as unknown as SVGGElement, [table, first, second]);
    expect(layer.children).toHaveLength(1);
    expect(layer.children[0]?.children.map((badge) => badge.dataset.voteCount)).toEqual(["1", "1"]);
    expect(layer.children[0]?.attributes.get("aria-label")).toContain("Yes, 1 vote");
  });

  it("renders no more than the classroom-safe vote-table cap", () => {
    const source: TableItem = {
      id: "vote-table-source",
      kind: "table",
      z: 1,
      version: 1,
      createdBy: "teacher",
      transform: [1, 0, 0, 1, 0, 0],
      style: { ...VOTE_TABLE_STYLE },
      geometry: {
        x: 0,
        y: 0,
        columnWidths: [160, 160],
        rowHeights: [52, 160],
        cells: [
          ["Yes", "Not yet"],
          ["", ""],
        ],
        headerRow: true,
      },
    };
    const tables = Array.from({ length: MAX_RENDERED_VOTE_TABLES + 1 }, (_, index) => ({
      ...structuredClone(source),
      id: `vote-table-${index}`,
      z: index + 1,
    }));
    const layer = fakeSvgNode("g");

    renderVoteCounts(layer as unknown as SVGGElement, tables);
    expect(layer.children).toHaveLength(MAX_RENDERED_VOTE_TABLES);
    expect(layer.children.at(-1)?.dataset.voteTableId).toBe(
      `vote-table-${MAX_RENDERED_VOTE_TABLES - 1}`,
    );
  });
});

describe("canvas viewport view state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(): void {
          this.callback([], this as unknown as ResizeObserver);
        }
        disconnect(): void {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("gets and sets center plus zoom while retaining zoom-only subscriptions", () => {
    const attributes = new Map<string, string>();
    const svg = {
      dataset: {} as DOMStringMap,
      style: { setProperty: vi.fn() },
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }),
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    } as unknown as SVGSVGElement;
    const viewport = new CanvasViewport(svg);
    const zoomListener = vi.fn();
    const viewListener = vi.fn();
    viewport.subscribe(zoomListener);
    viewport.subscribeView(viewListener);

    expect(viewport.viewState).toEqual({ center: { x: 400, y: 300 }, zoom: 1 });
    viewport.setViewState({ center: { x: 120, y: -30 }, zoom: 2 });

    expect(viewport.viewState).toEqual({ center: { x: 120, y: -30 }, zoom: 2 });
    expect(attributes.get("viewBox")).toBe("-80 -180 400 300");
    expect(zoomListener).toHaveBeenLastCalledWith(2);
    expect(viewListener).toHaveBeenLastCalledWith({ center: { x: 120, y: -30 }, zoom: 2 });

    viewport.panByPixels(20, -10);
    expect(viewport.viewState).toEqual({ center: { x: 110, y: -25 }, zoom: 2 });
    expect(zoomListener).toHaveBeenCalledTimes(1);
    expect(viewListener).toHaveBeenLastCalledWith({ center: { x: 110, y: -25 }, zoom: 2 });
  });

  it("rejects non-finite view state and clamps zoom to the supported range", () => {
    const svg = {
      dataset: {} as DOMStringMap,
      style: { setProperty: vi.fn() },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
      setAttribute: vi.fn(),
    } as unknown as SVGSVGElement;
    const viewport = new CanvasViewport(svg);

    expect(() => viewport.setViewState({ center: { x: Number.NaN, y: 0 }, zoom: 1 })).toThrow(
      RangeError,
    );
    viewport.setViewState({ center: { x: 0, y: 0 }, zoom: 20 });
    expect(viewport.viewState.zoom).toBe(8);
  });
});
