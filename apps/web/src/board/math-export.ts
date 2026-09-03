import type { SvgItemOptions } from "@collab/svg-export";

import { mathExpressionsIn, mathSvgRenderer, typesetMathSvg } from "../mathjax";
import type { BoardItem } from "../types";

/** Every place a board item holds text, with the size that text is drawn at. */
function textSurfaces(items: readonly BoardItem[]): Array<{ text: string; fontSize: number }> {
  const surfaces: Array<{ text: string; fontSize: number }> = [];
  for (const item of items) {
    if (item.kind === "text") {
      surfaces.push({ text: item.geometry.text, fontSize: item.style.fontSize });
    } else if (item.kind === "sticky") {
      surfaces.push({ text: item.geometry.text, fontSize: item.style.fontSize });
    } else if (item.kind === "zone") {
      surfaces.push({ text: item.geometry.title, fontSize: item.style.fontSize });
    } else if (item.kind === "table") {
      for (const row of item.geometry.cells) {
        for (const cell of row) surfaces.push({ text: cell, fontSize: item.style.fontSize });
      }
    }
  }
  return surfaces;
}

/**
 * Typesets every formula these items hold so a picture of them can draw math instead of writing
 * its source. A board with no formulas costs nothing, and a browser where MathJax will not load
 * falls back to the source rather than to a gap.
 */
export async function mathExportOptions(items: readonly BoardItem[]): Promise<SvgItemOptions> {
  const expressions = mathExpressionsIn(textSurfaces(items));
  if (expressions.length === 0) return {};
  const rendered = await typesetMathSvg(expressions);
  if (rendered.size === 0) return {};
  return { renderMath: mathSvgRenderer(rendered) };
}
