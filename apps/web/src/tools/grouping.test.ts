import { describe, expect, it } from "vitest";

import type { BoardItem, Matrix } from "../types";
import {
  buildGroupBatch,
  buildGroupedSectionCopyBatch,
  buildUngroupBatch,
  effectiveMoveCopyClosure,
  explicitGroupClosure,
  type GroupedBoardItem,
  GroupingError,
  sectionMemberExpansion,
} from "./grouping";

const identity: Matrix = [1, 0, 0, 1, 0, 0];

function rectangle(
  id: string,
  z: number,
  relationships: { groupId?: string; sectionId?: string } = {},
  version = 1,
): GroupedBoardItem {
  return {
    id,
    kind: "rectangle",
    z,
    version,
    createdBy: "actor",
    transform: identity,
    style: { kind: "stroke", color: "#20201e", width: 2, opacity: 1 },
    geometry: { x: z * 10, y: 0, width: 8, height: 8, shape: "rectangle" },
    ...relationships,
  } as BoardItem & typeof relationships;
}

function section(id: string, z: number, groupId?: string): GroupedBoardItem {
  return {
    id,
    kind: "zone",
    z,
    version: 3,
    createdBy: "actor",
    transform: identity,
    style: {
      kind: "zone",
      borderColor: "#60a5fa",
      fill: "#eff6ff",
      textColor: "#1e3a8a",
      fontSize: 20,
      opacity: 0.8,
    },
    geometry: { x: 0, y: 0, width: 200, height: 120, title: id },
    ...(groupId ? { groupId } : {}),
  } as GroupedBoardItem;
}

describe("group closures", () => {
  const items = [
    section("section-a", 1),
    rectangle("inside-a", 2, { sectionId: "section-a", groupId: "group-a" }),
    rectangle("group-peer", 3, { groupId: "group-a" }),
    rectangle("other", 4, { groupId: "group-b" }),
  ];

  it("expands an explicit group but does not pull in a member's Section", () => {
    expect(explicitGroupClosure(items, ["inside-a"]).map((item) => item.id)).toEqual([
      "inside-a",
      "group-peer",
    ]);
  });

  it("expands a selected Section to its members without unrelated items", () => {
    expect(sectionMemberExpansion(items, ["section-a"]).map((item) => item.id)).toEqual([
      "section-a",
      "inside-a",
    ]);
  });

  it("takes the fixed-point closure across Section membership and explicit groups", () => {
    expect(effectiveMoveCopyClosure(items, ["section-a"]).map((item) => item.id)).toEqual([
      "section-a",
      "inside-a",
      "group-peer",
    ]);
    expect(effectiveMoveCopyClosure(items, ["inside-a"]).map((item) => item.id)).toEqual([
      "inside-a",
      "group-peer",
    ]);
  });

  it("ignores missing seeds and rejects duplicate source IDs", () => {
    expect(effectiveMoveCopyClosure(items, ["missing"])).toEqual([]);
    const duplicate = items[0];
    expect(duplicate).toBeDefined();
    if (!duplicate) return;
    expect(() => explicitGroupClosure([duplicate, duplicate], ["section-a"])).toThrow(
      GroupingError,
    );
  });
});

describe("group mutation batches", () => {
  it("builds version-guarded group and ungroup updates in paint order", () => {
    const later = rectangle("later", 8, {}, 4);
    const earlier = rectangle("earlier", 2, {}, 7);
    const grouped = buildGroupBatch([later, earlier], "fresh-group");
    expect(grouped?.operations).toEqual([
      {
        kind: "item.update",
        itemId: "earlier",
        expectedVersion: 7,
        patch: { groupId: "fresh-group" },
      },
      {
        kind: "item.update",
        itemId: "later",
        expectedVersion: 4,
        patch: { groupId: "fresh-group" },
      },
    ]);
    expect(buildUngroupBatch([{ ...earlier, groupId: "fresh-group" }, later])?.operations).toEqual([
      {
        kind: "item.update",
        itemId: "earlier",
        expectedVersion: 7,
        patch: { groupId: null },
      },
    ]);
  });

  it("does not emit empty/no-op batches and rejects pending items", () => {
    expect(buildGroupBatch([rectangle("one", 1)], "group")).toBeNull();
    expect(
      buildGroupBatch(
        [rectangle("a", 1, { groupId: "same" }), rectangle("b", 2, { groupId: "same" })],
        "same",
      ),
    ).toBeNull();
    expect(buildUngroupBatch([rectangle("plain", 1)])).toBeNull();
    expect(() =>
      buildGroupBatch([rectangle("saved", 1), rectangle("pending", 2, {}, 0)], "group"),
    ).toThrow(/finish saving/u);
  });
});

describe("buildGroupedSectionCopyBatch", () => {
  it("copies the closure in paint order and remaps group and Section relationships", () => {
    const items = [
      section("section-a", 1),
      rectangle("inside", 2, { sectionId: "section-a", groupId: "group-a" }, 5),
      rectangle("peer", 3, { groupId: "group-a" }, 6),
      rectangle("untouched", 4),
    ];
    const itemIds = ["copy-section", "copy-inside", "copy-peer"];
    const result = buildGroupedSectionCopyBatch(items, ["section-a"], {
      createItemId: () => itemIds.shift() ?? "unexpected",
      createGroupId: () => "copy-group",
      translate: { x: 30, y: -10 },
    });

    expect(result.itemIds).toEqual(["copy-section", "copy-inside", "copy-peer"]);
    expect([...result.itemIdMap]).toEqual([
      ["section-a", "copy-section"],
      ["inside", "copy-inside"],
      ["peer", "copy-peer"],
    ]);
    expect([...result.groupIdMap]).toEqual([["group-a", "copy-group"]]);
    expect(result.operation.operations).toEqual([
      {
        kind: "item.copy",
        sourceItemId: "section-a",
        expectedVersion: 3,
        newItemId: "copy-section",
        translate: { x: 30, y: -10 },
        newSectionId: null,
      },
      {
        kind: "item.copy",
        sourceItemId: "inside",
        expectedVersion: 5,
        newItemId: "copy-inside",
        translate: { x: 30, y: -10 },
        newGroupId: "copy-group",
        newSectionId: "copy-section",
      },
      {
        kind: "item.copy",
        sourceItemId: "peer",
        expectedVersion: 6,
        newItemId: "copy-peer",
        translate: { x: 30, y: -10 },
        newGroupId: "copy-group",
        newSectionId: null,
      },
    ]);
  });

  it("recomputes an uncopied Section relationship after translation", () => {
    const member = rectangle("member", 2, { sectionId: "section-a" });
    const result = buildGroupedSectionCopyBatch([section("section-a", 1), member], ["member"], {
      createItemId: () => "member-copy",
    });

    expect(result.operation.operations[0]).toEqual({
      kind: "item.copy",
      sourceItemId: "member",
      expectedVersion: 1,
      newItemId: "member-copy",
      translate: { x: 20, y: 20 },
      newSectionId: "section-a",
    });
  });
  it("assigns an unsectioned source translated into a Section", () => {
    const targetSection = {
      ...section("section-a", 5),
      transform: [1, 0, 0, 1, 20, 0],
    } as GroupedBoardItem;
    const source = {
      ...rectangle("source", 2),
      geometry: { x: 10, y: 20, width: 8, height: 8, shape: "rectangle" },
    } as GroupedBoardItem;
    const result = buildGroupedSectionCopyBatch([targetSection, source], ["source"], {
      createItemId: () => "source-copy",
      translate: { x: 20, y: 0 },
    });

    expect(result.operation.operations[0]).toEqual({
      kind: "item.copy",
      sourceItemId: "source",
      expectedVersion: 1,
      newItemId: "source-copy",
      translate: { x: 20, y: 0 },
      newSectionId: "section-a",
    });
  });

  it("assigns an unsectioned copied item to a copied containing Section", () => {
    const source = {
      ...rectangle("source", 2),
      geometry: { x: 10, y: 20, width: 8, height: 8, shape: "rectangle" },
    } as GroupedBoardItem;
    const itemIds = ["copy-section", "copy-source"];
    const result = buildGroupedSectionCopyBatch(
      [section("section-a", 1), source],
      ["section-a", "source"],
      {
        createItemId: () => itemIds.shift() ?? "unexpected",
        translate: { x: 20, y: 0 },
      },
    );

    expect(result.operation.operations[1]).toEqual({
      kind: "item.copy",
      sourceItemId: "source",
      expectedVersion: 1,
      newItemId: "copy-source",
      translate: { x: 20, y: 0 },
      newSectionId: "copy-section",
    });
  });

  it("explicitly clears membership when the translated copy leaves its Section", () => {
    const member = {
      ...rectangle("member", 2, { sectionId: "section-a" }),
      geometry: { x: 190, y: 20, width: 8, height: 8, shape: "rectangle" },
    } as GroupedBoardItem;
    const result = buildGroupedSectionCopyBatch([section("section-a", 1), member], ["member"], {
      createItemId: () => "member-copy",
      translate: { x: 20, y: 0 },
    });

    expect(result.operation.operations[0]).toEqual({
      kind: "item.copy",
      sourceItemId: "member",
      expectedVersion: 1,
      newItemId: "member-copy",
      translate: { x: 20, y: 0 },
      newSectionId: null,
    });
  });

  it("chooses the topmost Section containing the translated copy", () => {
    const higherSection = {
      ...section("section-b", 10),
      transform: [1, 0, 0, 1, 20, 0],
    } as GroupedBoardItem;
    const member = {
      ...rectangle("member", 2, { sectionId: "section-a" }),
      geometry: { x: 10, y: 20, width: 8, height: 8, shape: "rectangle" },
    } as GroupedBoardItem;
    const result = buildGroupedSectionCopyBatch(
      [section("section-a", 1), higherSection, member],
      ["member"],
      {
        createItemId: () => "member-copy",
        translate: { x: 20, y: 0 },
      },
    );

    expect(result.operation.operations[0]).toEqual({
      kind: "item.copy",
      sourceItemId: "member",
      expectedVersion: 1,
      newItemId: "member-copy",
      translate: { x: 20, y: 0 },
      newSectionId: "section-b",
    });
  });

  it("rejects missing selections, pending items, duplicate allocations, and non-finite offsets", () => {
    expect(() =>
      buildGroupedSectionCopyBatch([rectangle("a", 1)], ["missing"], {
        createItemId: () => "copy",
      }),
    ).toThrow(/Select at least one/u);
    expect(() =>
      buildGroupedSectionCopyBatch([rectangle("pending", 1, {}, 0)], ["pending"], {
        createItemId: () => "copy",
      }),
    ).toThrow(/finish saving/u);
    expect(() =>
      buildGroupedSectionCopyBatch([rectangle("a", 1), rectangle("b", 2)], ["a", "b"], {
        createItemId: () => "same-copy",
      }),
    ).toThrow(/unique item ID/u);
    expect(() =>
      buildGroupedSectionCopyBatch([rectangle("a", 1)], ["a"], {
        createItemId: () => "copy",
        translate: { x: Number.NaN, y: 0 },
      }),
    ).toThrow(/finite/u);
  });
});

describe("buildGroupBatch against the full board", () => {
  it("folds in every member of a group the selection only partly covers", () => {
    const x = rectangle("x", 1, { groupId: "g" });
    const y = rectangle("y", 2, { groupId: "g" });
    const z = rectangle("z", 3, { groupId: "g" });
    const w = rectangle("w", 4);

    const batch = buildGroupBatch([x, y, w], "fresh", [x, y, z, w]);

    expect(batch).not.toBeNull();
    const updated = (batch?.operations ?? []).flatMap((operation) =>
      operation.kind === "item.update"
        ? [{ itemId: operation.itemId, groupId: (operation.patch as { groupId?: string }).groupId }]
        : [],
    );
    expect(updated.map((entry) => entry.itemId).sort()).toEqual(["w", "x", "y", "z"]);
    expect(updated.every((entry) => entry.groupId === "fresh")).toBe(true);
  });

  it("keeps the two-argument form unchanged for callers that pass a closed set", () => {
    const x = rectangle("x", 1, { groupId: "g" });
    const y = rectangle("y", 2, { groupId: "g" });
    const w = rectangle("w", 4);
    const batch = buildGroupBatch([x, y, w], "fresh");
    expect(
      (batch?.operations ?? [])
        .flatMap((operation) => (operation.kind === "item.update" ? [operation.itemId] : []))
        .sort(),
    ).toEqual(["w", "x", "y"]);
  });
});
