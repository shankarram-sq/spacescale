import { MAX_BATCH_OPERATIONS } from "@collab/protocol";
import { describe, expect, it } from "vitest";

import type { BoardItem } from "../types";
import {
  buildOrganisationTemplateBatch,
  OrganisationTemplateError,
  organisationTemplateSelectionIssue,
} from "./organisation-templates";

const actorId = `a_${"A".repeat(22)}`;

function sticky(id: string, x: number): BoardItem {
  return {
    id,
    kind: "sticky",
    z: x + 1,
    version: 7,
    createdBy: actorId,
    transform: [1, 0, 0, 1, 10, 20],
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#20201e",
      fontSize: 20,
      opacity: 1,
    },
    geometry: { x, y: 0, width: 180, height: 120, text: `Card ${x}` },
  };
}

describe("organisation template insertion", () => {
  it("remaps IDs, drops server metadata, and centres one valid atomic create batch", () => {
    const source = [
      sticky("018f0000-0000-7000-8000-000000000001", 0),
      sticky("018f0000-0000-7000-8000-000000000002", 220),
    ];
    const ids = ["018f0000-0000-7000-8000-000000000101", "018f0000-0000-7000-8000-000000000102"];
    const batch = buildOrganisationTemplateBatch({ items: source }, [500, 300], () => {
      const id = ids.shift();
      if (!id) throw new Error("No deterministic ID remains.");
      return id;
    });

    expect(batch.itemIds).toEqual([
      "018f0000-0000-7000-8000-000000000101",
      "018f0000-0000-7000-8000-000000000102",
    ]);
    expect(batch.operation.operations).toHaveLength(2);
    expect(batch.operation.operations[0]).toMatchObject({
      kind: "item.create",
      item: {
        id: "018f0000-0000-7000-8000-000000000101",
        transform: [1, 0, 0, 1, 300, 240],
      },
    });
    const created = batch.operation.operations.flatMap((operation) =>
      operation.kind === "item.create"
        ? [operation.item as unknown as Record<string, unknown>]
        : [],
    );
    expect(
      created.every((item) => !("z" in item || "version" in item || "createdBy" in item)),
    ).toBe(true);
  });

  it("rejects images, empty templates, oversized templates, and duplicate generated IDs", () => {
    const image = {
      ...sticky("018f0000-0000-7000-8000-000000000003", 0),
      kind: "image",
      style: { kind: "image", opacity: 1, radius: 4 },
      geometry: {
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        assetId: `asset_${"d".repeat(43)}`,
        mimeType: "image/png",
        intrinsicWidth: 200,
        intrinsicHeight: 100,
      },
    } as BoardItem;
    expect(() => buildOrganisationTemplateBatch({ items: [] }, [0, 0], crypto.randomUUID)).toThrow(
      OrganisationTemplateError,
    );
    expect(() =>
      buildOrganisationTemplateBatch({ items: [image] }, [0, 0], crypto.randomUUID),
    ).toThrow(/Image cards/u);
    expect(() =>
      buildOrganisationTemplateBatch(
        {
          items: Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, index) =>
            sticky(`018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`, index),
          ),
        },
        [0, 0],
        crypto.randomUUID,
      ),
    ).toThrow(/at most 100/u);
    expect(() =>
      buildOrganisationTemplateBatch(
        {
          items: [
            sticky("018f0000-0000-7000-8000-000000000011", 0),
            sticky("018f0000-0000-7000-8000-000000000012", 1),
          ],
        },
        [0, 0],
        () => "018f0000-0000-7000-8000-000000000099",
      ),
    ).toThrow(/unique IDs/u);
  });
});

describe("organisation template selection", () => {
  it("requires a bounded saved selection without image cards", () => {
    expect(organisationTemplateSelectionIssue([])).toMatch(/Select at least one/u);
    expect(organisationTemplateSelectionIssue([sticky("one", 1)], 1)).toBeNull();
    expect(organisationTemplateSelectionIssue([sticky("one", 1), sticky("two", 2)], 1)).toMatch(
      /no more than 1/u,
    );
  });
});
