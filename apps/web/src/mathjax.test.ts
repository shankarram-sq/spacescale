import { describe, expect, it } from "vitest";
import { containsMathMarkup, normalizeSingleDollarMath } from "./mathjax";

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
    expect(containsMathMarkup("Budget: $100 materials, $50 travel")).toBe(false);
    expect(containsMathMarkup("Prices changed from $100 to $50.")).toBe(false);
    expect(containsMathMarkup("No formula here")).toBe(false);
  });

  it("still recognizes single-dollar variables alongside currency", () => {
    expect(containsMathMarkup("Budget: $100; rate: $r=0.05$")).toBe(true);
    expect(containsMathMarkup("Check $2+2=4$ before continuing.")).toBe(true);
    expect(containsMathMarkup("Use \\(2+2=4\\) when a formula starts with a number.")).toBe(true);
    expect(normalizeSingleDollarMath("Budget: $100; rate: $r=0.05$ and $p$.")).toBe(
      "Budget: $100; rate: \\(r=0.05\\) and \\(p\\).",
    );
    expect(normalizeSingleDollarMath("Budget: $100 materials, $50 travel")).toBe(
      "Budget: $100 materials, $50 travel",
    );
    expect(normalizeSingleDollarMath("$$a^2+b^2=c^2$$")).toBe("$$a^2+b^2=c^2$$");
    expect(normalizeSingleDollarMath("Check $2+2=4$.")).toBe("Check \\(2+2=4\\).");
  });
});
