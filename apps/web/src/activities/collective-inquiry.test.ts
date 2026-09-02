import { describe, expect, it } from "vitest";

import { buildCollectiveInquiryMap } from "./collective-inquiry";

describe("collective inquiry map", () => {
  it("builds connections, themes, bridges, and a productive tension as one valid batch", () => {
    let nextId = 1;
    const batch = buildCollectiveInquiryMap(
      {
        selectionToken: "selection-token",
        mapTitle: "Reducing cafeteria waste",
        themes: [
          {
            id: "habits",
            label: "Everyday habits",
            summary: "Small defaults can make low-waste choices easier for everyone.",
            ideaAliases: ["idea_1"],
          },
          {
            id: "systems",
            label: "School systems",
            summary: "Collection and purchasing rules determine which habits can scale.",
            ideaAliases: ["idea_2"],
          },
        ],
        bridges: [
          {
            fromThemeId: "habits",
            toThemeId: "systems",
            insight: "Visible feedback can connect personal choices to school-wide purchasing.",
          },
        ],
        tension: {
          statement: "Convenience can conflict with reducing disposable packaging.",
          nextQuestion: "Which low-waste default could we pilot without slowing lunch service?",
        },
      },
      [
        {
          alias: "idea_1",
          bounds: { minX: 0, minY: 20, maxX: 180, maxY: 160 },
        },
        {
          alias: "idea_2",
          bounds: { minX: 220, minY: 20, maxX: 400, maxY: 160 },
        },
      ],
      () => `018f0000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`,
    );

    expect(batch.operation.kind).toBe("items.batch");
    expect(batch.operation.operations).toHaveLength(12);
    expect(batch.itemIds).toHaveLength(12);
    expect(batch.mapBounds.minX).toBeGreaterThan(400);

    const created = batch.operation.operations.flatMap((operation) =>
      operation.kind === "item.create" ? [operation.item] : [],
    );
    expect(created.every((item) => item.assistedBy === "ai")).toBe(true);
    expect(created.filter((item) => item.kind === "line")).toHaveLength(3);
    expect(
      created.some(
        (item) => item.kind === "text" && item.geometry.text === "Reducing cafeteria waste",
      ),
    ).toBe(true);
    expect(
      created.some(
        (item) => item.kind === "sticky" && item.geometry.text.includes("Productive tension"),
      ),
    ).toBe(true);
  });
});
