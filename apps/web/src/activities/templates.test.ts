import {
  MAX_BATCH_OPERATIONS,
  PROTOCOL_VERSION,
  validateClientFrame,
  validateDurableOperation,
} from "@collab/protocol";
import { describe, expect, it } from "vitest";

import type { BoardItem } from "../types";
import { ACTIVITY_TEMPLATES, type ActivityTemplateId, buildActivityBatch } from "./templates";
import { isVoteTable } from "./voting";

function deterministicIds(): () => string {
  let next = 1;
  return () => `018f0000-0000-7000-8000-${(next++).toString(16).padStart(12, "0")}`;
}

describe("classroom templates", () => {
  it("builds all six templates as small valid ordinary-item batches", () => {
    const expectedCounts: Record<ActivityTemplateId, number> = {
      "collective-inquiry-demo": 13,
      "exit-ticket": 7,
      kwl: 2,
      "sort-it": 12,
      "pair-share": 7,
      "vote-with-stamps": 4,
    };

    expect(ACTIVITY_TEMPLATES.map(({ id }) => id)).toEqual(Object.keys(expectedCounts));
    for (const template of ACTIVITY_TEMPLATES) {
      const result = buildActivityBatch(template.id, [12.345, -9.876], deterministicIds());
      expect(result.operation.operations).toHaveLength(expectedCounts[template.id]);
      expect(result.operation.operations.length).toBeLessThanOrEqual(MAX_BATCH_OPERATIONS);
      expect(new Set(result.itemIds).size).toBe(result.itemIds.length);
      expect(
        result.operation.operations.every(
          (operation) =>
            operation.kind === "item.create" &&
            operation.item.transform.join(",") === "1,0,0,1,12.35,-9.88",
        ),
      ).toBe(true);
      expect(() => validateDurableOperation(result.operation)).not.toThrow();
      expect(() =>
        validateClientFrame({
          v: PROTOCOL_VERSION,
          t: "client.commit",
          commandId: "018f0000-0000-7000-8000-000000000101",
          actionId: "018f0000-0000-7000-8000-000000000102",
          baseSeq: 0,
          op: result.operation,
        }),
      ).not.toThrow();
    }
  });

  it("keeps the starter layouts focused on their intended primitives", () => {
    const byId = new Map(ACTIVITY_TEMPLATES.map((template) => [template.id, template]));
    expect(byId.get("exit-ticket")?.items.filter(({ kind }) => kind === "sticky")).toHaveLength(3);
    expect(byId.get("sort-it")?.items.filter(({ kind }) => kind === "sticky")).toHaveLength(6);
    expect(byId.get("pair-share")?.items.filter(({ kind }) => kind === "rectangle")).toHaveLength(
      2,
    );

    const kwl = byId.get("kwl")?.items.find(({ kind }) => kind === "table");
    expect(kwl?.kind).toBe("table");
    if (kwl?.kind !== "table") throw new Error("K-W-L table missing.");
    expect(kwl.geometry.cells[0]).toEqual(["What I know", "What I want to know", "What I learned"]);
    expect(kwl.geometry.rowHeights).toHaveLength(4);

    const voteBatch = buildActivityBatch("vote-with-stamps", [0, 0], deterministicIds());
    expect(
      voteBatch.operation.operations.some(
        (operation) =>
          operation.kind === "item.create" &&
          operation.item.kind === "text" &&
          operation.item.geometry.text.includes("one vote per participant"),
      ),
    ).toBe(false);
    const voteCreate = voteBatch.operation.operations.find(
      (operation) => operation.kind === "item.create" && operation.item.kind === "table",
    );
    if (voteCreate?.kind !== "item.create" || voteCreate.item.kind !== "table") {
      throw new Error("Vote table missing.");
    }
    const voteTable: BoardItem = {
      ...voteCreate.item,
      z: 1,
      version: 1,
      createdBy: "teacher",
    };
    expect(isVoteTable(voteTable)).toBe(true);
  });
});
