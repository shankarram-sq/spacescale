import { describe, expect, it } from "vitest";
import { BoardDomainError, type ItemRecord, type ParsedItemOperation } from "./domain";
import { assertItemMutationOwnership, prepareOwnedItemOperation } from "./item-ownership";

const ownerId = "a_AAAAAAAAAAAAAAAAAAAAAA";
const editorId = "a_BBBBBBBBBBBBBBBBBBBBBB";
const otherEditorId = "a_CCCCCCCCCCCCCCCCCCCCCC";
const ownItemId = "018f0000-0000-7000-8000-000000000001";
const foreignItemId = "018f0000-0000-7000-8000-000000000002";
const copyItemId = "018f0000-0000-7000-8000-000000000003";

function itemRecord(id: string, createdBy: string, deleted = false): ItemRecord {
  return {
    deleted,
    stateToken: `state:${id}`,
    item: {
      id,
      kind: "sticky",
      z: 1,
      version: 4,
      createdBy,
      style: {
        kind: "sticky",
        fill: "#fff2a8",
        textColor: "#2f2a1f",
        fontSize: 20,
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "Question" },
    },
  };
}

function update(itemId: string, patch: "text" | "design"): ParsedItemOperation {
  return {
    kind: "item.update",
    itemId,
    expectedVersion: 4,
    patch:
      patch === "text"
        ? { geometry: { x: 10, y: 20, width: 180, height: 140, text: "Changed" } }
        : {
            style: {
              kind: "sticky",
              fill: "#ffd6e7",
              textColor: "#2f2a1f",
              fontSize: 20,
              opacity: 1,
            },
          },
  };
}

function expectForbidden(run: () => void, itemId?: string): void {
  try {
    run();
    throw new Error("Expected ownership authorization to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(BoardDomainError);
    expect(error).toMatchObject({ code: "FORBIDDEN" });
    if (itemId !== undefined) {
      expect(error).toMatchObject({ details: { itemId } });
    }
  }
}

describe("classroom item ownership", () => {
  const records = new Map([
    [ownItemId, itemRecord(ownItemId, editorId)],
    [foreignItemId, itemRecord(foreignItemId, otherEditorId)],
  ]);

  it("lets owners and co-owners modify another actor's text or design", () => {
    expect(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), records, {
        actorId: ownerId,
        role: "owner",
      }),
    ).not.toThrow();
    expect(() =>
      assertItemMutationOwnership(update(foreignItemId, "design"), records, {
        actorId: ownerId,
        role: "owner",
      }),
    ).not.toThrow();
  });

  it("lets editors update and delete only items they created", () => {
    expect(() =>
      assertItemMutationOwnership(update(ownItemId, "text"), records, {
        actorId: editorId,
        role: "editor",
      }),
    ).not.toThrow();
    expect(() =>
      assertItemMutationOwnership(
        { kind: "item.delete", itemId: ownItemId, expectedVersion: 4 },
        records,
        { actorId: editorId, role: "editor" },
      ),
    ).not.toThrow();

    for (const operation of [
      update(foreignItemId, "text"),
      update(foreignItemId, "design"),
      { kind: "item.delete", itemId: foreignItemId, expectedVersion: 4 } as const,
    ]) {
      expectForbidden(
        () =>
          assertItemMutationOwnership(operation, records, {
            actorId: editorId,
            role: "editor",
          }),
        foreignItemId,
      );
    }
  });

  it("allows editors to create and to copy another actor's item into their own new item", () => {
    expect(() =>
      assertItemMutationOwnership(
        {
          kind: "item.create",
          item: {
            id: copyItemId,
            kind: "sticky",
            style: {
              kind: "sticky",
              fill: "#fff2a8",
              textColor: "#2f2a1f",
              fontSize: 20,
              opacity: 1,
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: { x: 10, y: 20, width: 180, height: 140, text: "Mine" },
          },
        },
        records,
        { actorId: editorId, role: "editor" },
      ),
    ).not.toThrow();
    expect(() =>
      assertItemMutationOwnership(
        {
          kind: "item.copy",
          sourceItemId: foreignItemId,
          expectedVersion: 4,
          newItemId: copyItemId,
          translate: { x: 24, y: 24 },
        },
        records,
        { actorId: editorId, role: "editor" },
      ),
    ).not.toThrow();
  });

  it("preflights every batch child before reduction so a forbidden child is atomic", () => {
    let tokenAllocations = 0;
    const before = structuredClone(records.get(ownItemId));
    expectForbidden(
      () =>
        prepareOwnedItemOperation(
          {
            kind: "items.batch",
            operations: [
              update(ownItemId, "design"),
              { kind: "item.delete", itemId: foreignItemId, expectedVersion: 4 },
            ],
          },
          records,
          {
            seq: 5,
            actorId: editorId,
            role: "editor",
            nextZ: 3,
            liveCount: 2,
            tokenFactory: () => {
              tokenAllocations += 1;
              return `next:${tokenAllocations}`;
            },
          },
        ),
      foreignItemId,
    );
    expect(tokenAllocations).toBe(0);
    expect(records.get(ownItemId)).toEqual(before);
  });

  it("leaves missing or deleted item errors to the authoritative reducer", () => {
    const deleted = new Map([[foreignItemId, itemRecord(foreignItemId, otherEditorId, true)]]);
    expect(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), deleted, {
        actorId: editorId,
        role: "editor",
      }),
    ).not.toThrow();
    expect(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), new Map(), {
        actorId: editorId,
        role: "editor",
      }),
    ).not.toThrow();
  });

  it("rejects viewer mutations at the same authorization boundary", () => {
    expectForbidden(() =>
      assertItemMutationOwnership(update(ownItemId, "text"), records, {
        actorId: editorId,
        role: "viewer",
      }),
    );
  });
});
