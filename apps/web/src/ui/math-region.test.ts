import { describe, expect, it } from "vitest";

import { mathRegionAtCaret, shouldCloseDelimiter } from "./math-region";

describe("mathRegionAtCaret", () => {
  it("finds the formula the caret is inside", () => {
    const value = "Solve $$x^2$$ now";
    expect(mathRegionAtCaret(value, 8)).toEqual({ start: 8, end: 11, closed: true });
    expect(mathRegionAtCaret(value, 11)).toEqual({ start: 8, end: 11, closed: true });
  });

  it("reports no formula when the caret is in the prose around it", () => {
    const value = "Solve $$x^2$$ now";
    expect(mathRegionAtCaret(value, 0)).toBeNull();
    expect(mathRegionAtCaret(value, 5)).toBeNull();
    expect(mathRegionAtCaret(value, 15)).toBeNull();
  });

  it("treats an unclosed opening as a formula running to the end", () => {
    expect(mathRegionAtCaret("Solve $$x^2", 11)).toEqual({ start: 8, end: 11, closed: false });
    expect(mathRegionAtCaret("Solve $$", 8)).toEqual({ start: 8, end: 8, closed: false });
  });

  it("leaves prices alone", () => {
    // Single dollars are never delimiters, so a price cannot open a formula.
    expect(mathRegionAtCaret("Kits cost $12 to $20", 14)).toBeNull();
    expect(mathRegionAtCaret("The total is \\$12", 16)).toBeNull();
  });

  it("pairs delimiters left to right across several formulas", () => {
    const value = "$$a$$ and $$b$$";
    expect(mathRegionAtCaret(value, 3)).toEqual({ start: 2, end: 3, closed: true });
    expect(mathRegionAtCaret(value, 7)).toBeNull();
    expect(mathRegionAtCaret(value, 12)).toEqual({ start: 12, end: 13, closed: true });
  });

  it("ignores an escaped dollar pair", () => {
    expect(mathRegionAtCaret("Costs \\$$5", 9)).toBeNull();
  });
});

describe("shouldCloseDelimiter", () => {
  it("closes a fresh opening", () => {
    expect(shouldCloseDelimiter("Solve $$", 8)).toBe(true);
  });

  it("does not close when the caret is not just past a delimiter", () => {
    expect(shouldCloseDelimiter("Solve $$x", 9)).toBe(false);
    expect(shouldCloseDelimiter("Solve $", 7)).toBe(false);
    expect(shouldCloseDelimiter("", 0)).toBe(false);
  });

  it("does not close the closing half of a pair", () => {
    expect(shouldCloseDelimiter("$$x$$", 5)).toBe(false);
  });

  it("does not close an escaped pair", () => {
    expect(shouldCloseDelimiter("Costs \\$$", 9)).toBe(false);
  });
});
