import { describe, expect, it } from "vitest";

import { wrapStickyText, wrapTableCellText } from "./renderer";

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
