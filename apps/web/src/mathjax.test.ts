import { describe, expect, it, vi } from "vitest";
import {
  containsMathMarkup,
  normalizeSingleDollarMath,
  splitMathMarkup,
  typesetMath,
} from "./mathjax";

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
    expect(containsMathMarkup("Scale by $2x$ before continuing.")).toBe(true);
    expect(containsMathMarkup("Use \\(2+2=4\\) when a formula starts with a number.")).toBe(true);
    expect(normalizeSingleDollarMath("Budget: $100; rate: $r=0.05$ and $p$.")).toBe(
      "Budget: $100; rate: \\(r=0.05\\) and \\(p\\).",
    );
    expect(normalizeSingleDollarMath("Budget: $100 materials, $50 travel")).toBe(
      "Budget: $100 materials, $50 travel",
    );
    expect(normalizeSingleDollarMath("$$a^2+b^2=c^2$$")).toBe("$$a^2+b^2=c^2$$");
    expect(normalizeSingleDollarMath("Check $2+2=4$.")).toBe("Check \\(2+2=4\\).");
    expect(normalizeSingleDollarMath("Use $2x$, but $100$ remains currency.")).toBe(
      "Use \\(2x\\), but $100$ remains currency.",
    );
  });

  it("segments normalized math before surrounding prose is linkified", () => {
    expect(
      splitMathMarkup(
        "Read $\\text{https://inside.example }$ then https://outside.example and $$x=1$$.",
      ),
    ).toEqual([
      { kind: "text", text: "Read " },
      { kind: "math", text: "\\(\\text{https://inside.example }\\)" },
      { kind: "text", text: " then https://outside.example and " },
      { kind: "math", text: "$$x=1$$" },
      { kind: "text", text: "." },
    ]);
  });
});

describe("typesetMath", () => {
  /** MathJax cannot load in this environment, so every typeset attempt takes the failure path. */
  function failingContainer(text: string) {
    return {
      childNodes: [] as Node[],
      dataset: {} as Record<string, string>,
      isConnected: true,
      textContent: text,
      title: "",
    };
  }

  async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("rebuilds the container through the caller's hook instead of flattening it to text", async () => {
    const container = failingContainer("Energy: $$E=mc^2$$");
    const restore = vi.fn();
    const onReady = vi.fn();

    typesetMath(container as unknown as HTMLElement, { restore, onReady });
    await settle();

    // Assigning textContent would destroy the safe-link anchors the caller built.
    expect(restore).toHaveBeenCalledWith(container);
    expect(container.textContent).toBe("Energy: $$E=mc^2$$");
    expect(container.dataset.mathState).toBe("error");
    expect(container.title).toBe("Math could not be rendered.");
    expect(onReady).not.toHaveBeenCalled();
  });

  it("still falls back to plain source when the caller supplies no hook", async () => {
    const container = failingContainer("Energy: $$E=mc^2$$");

    typesetMath(container as unknown as HTMLElement);
    await settle();

    expect(container.dataset.mathState).toBe("error");
    expect(container.textContent).toBe("Energy: $$E=mc^2$$");
  });
});
