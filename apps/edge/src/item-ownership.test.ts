import { describe, expect, it } from "vitest";
import { BoardDomainError, type ItemRecord, type ParsedItemOperation } from "./domain";
import { assertItemMutationOwnership, prepareOwnedItemOperation } from "./item-ownership";

const ownerId = "a_AAAAAAAAAAAAAAAAAAAAAA";
const editorId = "a_BBBBBBBBBBBBBBBBBBBBBB";
const otherEditorId = "a_CCCCCCCCCCCCCCCCCCCCCC";
const ownItemId = "018f0000-0000-7000-8000-000000000001";
const foreignItemId = "018f0000-0000-7000-8000-000000000002";
const copyItemId = "018f0000-0000-7000-8000-000000000003";
const sectionId = "018f0000-0000-7000-8000-000000000004";

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

function sectionRecord(locked: boolean): ItemRecord {
  return {
    deleted: false,
    stateToken: "state:section",
    item: {
      id: sectionId,
      kind: "zone",
      z: 2,
      version: 4,
      createdBy: ownerId,
      style: {
        kind: "zone",
        borderColor: "#60a5fa",
        fill: "#eff6ff",
        textColor: "#1e3a8a",
        fontSize: 20,
        opacity: 0.8,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 0, y: 0, width: 600, height: 400, title: "Review", locked },
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

  it("lets a Section's creator detach a foreign surviving member while deleting it", () => {
    const section = sectionRecord(false);
    section.item.createdBy = editorId;
    const foreignMember = itemRecord(foreignItemId, otherEditorId);
    foreignMember.item.sectionId = sectionId;
    const sectionRecords = new Map([
      [sectionId, section],
      [foreignItemId, foreignMember],
    ]);
    const deleteWithDetach = {
      kind: "items.batch" as const,
      operations: [
        { kind: "item.delete" as const, itemId: sectionId, expectedVersion: 4 },
        {
          kind: "item.update" as const,
          itemId: foreignItemId,
          expectedVersion: 4,
          patch: { sectionId: null },
        },
      ],
    };

    // Membership was assigned by geometry, so the Section's creator may
    // reverse it even though they cannot otherwise edit the member.
    expect(() =>
      assertItemMutationOwnership(deleteWithDetach, sectionRecords, {
        actorId: editorId,
        role: "editor",
      }),
    ).not.toThrow();

    // A different editor has no such right over the member.
    const [, detachOnly] = deleteWithDetach.operations;
    if (detachOnly === undefined) throw new Error("expected the detach operation");
    expectForbidden(
      () =>
        assertItemMutationOwnership(detachOnly, sectionRecords, {
          actorId: "editor-c",
          role: "editor",
        }),
      foreignItemId,
    );
  });

  it("rejects Section deletion before reduction when the member patch does more than detach", () => {
    const section = sectionRecord(false);
    section.item.createdBy = editorId;
    const foreignMember = itemRecord(foreignItemId, otherEditorId);
    foreignMember.item.sectionId = sectionId;
    const sectionRecords = new Map([
      [sectionId, section],
      [foreignItemId, foreignMember],
    ]);
    const before = structuredClone(sectionRecords);
    let tokenAllocations = 0;

    expectForbidden(
      () =>
        prepareOwnedItemOperation(
          {
            kind: "items.batch",
            operations: [
              { kind: "item.delete", itemId: sectionId, expectedVersion: 4 },
              {
                kind: "item.update",
                itemId: foreignItemId,
                expectedVersion: 4,
                patch: { sectionId: null, transform: [1, 0, 0, 1, 5, 5] },
              },
            ],
          },
          sectionRecords,
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
    expect(sectionRecords).toEqual(before);
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

  it("freezes owner and editor mutations inside a locked Section until an owner unlocks it", () => {
    const member = itemRecord(foreignItemId, otherEditorId);
    member.item.sectionId = sectionId;
    const lockedRecords = new Map([
      [sectionId, sectionRecord(true)],
      [foreignItemId, member],
    ]);

    expectForbidden(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), lockedRecords, {
        actorId: ownerId,
        role: "owner",
      }),
    );
    expectForbidden(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), lockedRecords, {
        actorId: otherEditorId,
        role: "editor",
      }),
    );
    expectForbidden(() =>
      assertItemMutationOwnership(
        {
          kind: "item.copy",
          sourceItemId: foreignItemId,
          expectedVersion: 4,
          newItemId: copyItemId,
          translate: { x: 24, y: 24 },
        },
        lockedRecords,
        { actorId: ownerId, role: "owner" },
      ),
    );
    expectForbidden(() =>
      assertItemMutationOwnership(
        {
          kind: "item.create",
          item: {
            id: copyItemId,
            sectionId,
            kind: "sticky",
            style: {
              kind: "sticky",
              fill: "#fff2a8",
              textColor: "#2f2a1f",
              fontSize: 20,
              opacity: 1,
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: { x: 10, y: 20, width: 180, height: 140, text: "Blocked" },
          },
        },
        lockedRecords,
        { actorId: ownerId, role: "owner" },
      ),
    );

    expect(() =>
      assertItemMutationOwnership(
        {
          kind: "item.update",
          itemId: sectionId,
          expectedVersion: 4,
          patch: {
            geometry: {
              x: 0,
              y: 0,
              width: 600,
              height: 400,
              title: "Review",
              locked: false,
            },
          },
        },
        lockedRecords,
        { actorId: ownerId, role: "owner" },
      ),
    ).not.toThrow();
    expectForbidden(() =>
      assertItemMutationOwnership(
        {
          kind: "item.update",
          itemId: sectionId,
          expectedVersion: 4,
          patch: {
            geometry: {
              x: 0,
              y: 0,
              width: 600,
              height: 400,
              title: "Review",
              locked: false,
            },
          },
        },
        lockedRecords,
        { actorId: otherEditorId, role: "editor" },
      ),
    );
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
