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
  it("builds all nine templates as small valid ordinary-item batches", () => {
    const expectedCounts: Record<ActivityTemplateId, number> = {
      "collective-inquiry-demo": 13,
      "exit-ticket": 7,
      kwl: 2,
      "sort-it": 12,
      "pair-share": 7,
      "vote-with-stamps": 4,
      "product-discovery-lab": 28,
      "incident-response-room": 24,
      "design-critique-studio": 30,
    };

    expect(ACTIVITY_TEMPLATES.map(({ id }) => id)).toEqual(Object.keys(expectedCounts));
    for (const template of ACTIVITY_TEMPLATES) {
      const result = buildActivityBatch(template.id, [12.345, -9.876], deterministicIds());
      expect(result.operation.operations).toHaveLength(expectedCounts[template.id]);
      expect(result.operation.operations.length).toBeLessThanOrEqual(MAX_BATCH_OPERATIONS);
      expect(new Set(result.itemIds).size).toBe(result.itemIds.length);
      for (const [index, operation] of result.operation.operations.entries()) {
        const source = template.items[index];
        if (source === undefined) throw new Error("Template source item missing.");
        const local = source.transform ?? [1, 0, 0, 1, 0, 0];
        const round = (value: number): number => Math.round(value * 100) / 100;
        expect(operation).toMatchObject({
          kind: "item.create",
          item: {
            transform: [
              local[0],
              local[1],
              local[2],
              local[3],
              round(local[4] + 12.35),
              round(local[5] - 9.88),
            ],
          },
        });
      }
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

  it("remaps rich board Sections and groups without leaking template metadata", () => {
    const product = buildActivityBatch("product-discovery-lab", [0, 0], deterministicIds());
    const created = product.operation.operations.flatMap((operation) =>
      operation.kind === "item.create" ? [operation.item] : [],
    );
    const opportunitySection = created.find(
      (item) => item.kind === "zone" && item.geometry.title === "3 · Opportunities",
    );
    const commentTarget = created.find(
      (item) => item.kind === "sticky" && item.geometry.text.includes("COMMENT TARGET"),
    );
    expect(opportunitySection).toBeDefined();
    expect(commentTarget?.sectionId).toBe(opportunitySection?.id);

    const evidenceCluster = created.filter(
      (item) =>
        item.kind === "sticky" &&
        (item.geometry.text.includes("7 of 10") || item.geometry.text.includes("Support tickets")),
    );
    expect(evidenceCluster).toHaveLength(2);
    expect(new Set(evidenceCluster.map((item) => item.groupId)).size).toBe(1);
    expect(evidenceCluster[0]?.groupId).toBeTruthy();
    expect(
      created.every(
        (item) => !("templateKey" in item) && !("groupKey" in item) && !("sectionKey" in item),
      ),
    ).toBe(true);

    const incident = buildActivityBatch("incident-response-room", [0, 0], deterministicIds());
    const rotatedTarget = incident.operation.operations.find(
      (operation) =>
        operation.kind === "item.create" &&
        operation.item.kind === "sticky" &&
        operation.item.geometry.text.includes("COMMENT TARGET"),
    );
    if (rotatedTarget?.kind !== "item.create") throw new Error("Rotated target missing.");
    expect(rotatedTarget.item.transform.slice(0, 4)).not.toEqual([1, 0, 0, 1]);
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
