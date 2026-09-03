import { describe, expect, it } from "vitest";
import { containsMathMarkup } from "./mathjax";

describe("containsMathMarkup", () => {
  it("recognizes supported inline and display delimiters", () => {
    expect(containsMathMarkup("Energy: $E=mc^2$")).toBe(true);
    expect(containsMathMarkup("Area: \\(\\pi r^2\\)")).toBe(true);
    expect(containsMathMarkup("\\[x = \\frac{-b}{2a}\\]")).toBe(true);
    expect(containsMathMarkup("$$a^2+b^2=c^2$$")).toBe(true);
  });

  it("does not interpret ordinary currency or escaped dollars as math", () => {
    expect(containsMathMarkup("The total is $ 12.00 today.")).toBe(false);
    expect(containsMathMarkup("The total is \\$12.00 today.")).toBe(false);
    expect(containsMathMarkup("No formula here")).toBe(false);
  });
});
