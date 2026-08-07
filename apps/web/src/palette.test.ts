import { describe, expect, it } from "vitest";

import {
  DRAWING_COLOR_VALUES,
  DRAWING_COLORS,
  STICKY_COLOR_VALUES,
  STICKY_COLORS,
  UI_COLORS,
} from "./palette";

describe("SpaceScale board palette", () => {
  it("uses the sampled drawing swatches in reference order", () => {
    expect(DRAWING_COLORS.map(({ name, value }) => [name, value])).toEqual([
      ["Ink", "#1e1e1e"],
      ["Red", "#f24822"],
      ["Orange", "#ff9e42"],
      ["Yellow", "#ffc943"],
      ["Green", "#66d575"],
      ["Blue", "#3dadff"],
      ["Purple", "#874fff"],
      ["White", "#ffffff"],
    ]);
    expect(DRAWING_COLOR_VALUES.ink).toBe(UI_COLORS.ink);
    expect(DRAWING_COLOR_VALUES.white).toBe(UI_COLORS.surface);
  });

  it("uses the sampled sticky-note fills in reference order", () => {
    expect(STICKY_COLORS.map(({ name, value }) => [name, value])).toEqual([
      ["Yellow", "#ffe299"],
      ["Coral", "#ffafa3"],
      ["Lavender", "#d3bdff"],
      ["Mint", "#b3efbd"],
      ["Sky", "#a8daff"],
      ["Slate", "#afbccf"],
    ]);
    expect(STICKY_COLORS.map(({ value }) => value)).toEqual(Object.values(STICKY_COLOR_VALUES));
  });

  it("keeps sampled canvas interaction colors explicit", () => {
    expect(UI_COLORS).toEqual({
      canvas: "#f5f5f5",
      surface: "#ffffff",
      ink: "#1e1e1e",
      border: "#ebebeb",
      borderStrong: "#d4d4d4",
      toolActive: "#9747ff",
      selection: "#0d99ff",
    });
  });
});
