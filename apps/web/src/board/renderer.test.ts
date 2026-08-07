import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasViewport, wrapStickyText, wrapTableCellText } from "./renderer";

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
