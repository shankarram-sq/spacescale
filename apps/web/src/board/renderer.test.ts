import { describe, expect, it } from "vitest";

import { wrapStickyText } from "./renderer";

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
