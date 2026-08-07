import { describe, expect, it } from "vitest";

import {
  applyAuthoritativeOperation,
  applyDurableOperation,
  applyRedoEffects,
  applyUndoEffects,
  BoardCoreError,
  canonicalSnapshotByteLengthFromParts,
  canonicalSnapshotBytes,
  canonicalSnapshotItemByteLength,
  createBoardState,
  liveItemsInPaintOrder,
  serializeCanonicalSnapshot,
} from "./index.js";

const ALICE = "018f0000-0000-7000-8000-0000000000a1";
const BOB = "018f0000-0000-7000-8000-0000000000b1";
const RECTANGLE_ID = "018f0000-0000-7000-8000-000000000001";
const COPY_ID = "018f0000-0000-7000-8000-000000000002";
const ACTION_1 = "018f0000-0000-7000-8000-000000000101";
const ACTION_2 = "018f0000-0000-7000-8000-000000000102";

function rectangle(id = RECTANGLE_ID) {
  return {
    id,
    kind: "rectangle" as const,
    style: { kind: "stroke" as const, color: "#123456", width: 2, opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x: 10, y: 20, width: 30, height: 40 },
  };
}

function sticky(id = RECTANGLE_ID) {
  return {
    id,
    kind: "sticky" as const,
    style: {
      kind: "sticky" as const,
      fill: "#ffeb3b",
      textColor: "#212121",
      fontSize: 16,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x: 10, y: 20, width: 180, height: 140, text: "" },
  };
}

describe("normal board reductions", () => {
  it("assigns paint order/server fields and emits complete before/after effects", () => {
    const original = createBoardState();
    const result = applyDurableOperation(
      original,
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    );
    expect(original.items.size).toBe(0);
    expect(result.state.items.get(RECTANGLE_ID)).toMatchObject({
      exists: true,
      item: { z: 1, version: 1, createdBy: ALICE },
    });
    expect(result.effects).toEqual([
      {
        itemId: RECTANGLE_ID,
        before: { exists: false },
        after: {
          exists: true,
          item: expect.objectContaining({ id: RECTANGLE_ID, z: 1, version: 1 }),
        },
        beforeStateToken: `absent:${RECTANGLE_ID}`,
        afterStateToken: `state:1:0:${RECTANGLE_ID}`,
      },
    ]);
  });

  it("guards expected versions and item-specific patch schemas", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    expect(() =>
      applyDurableOperation(
        created,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 0,
          patch: { transform: [1, 0, 0, 1, 1, 1] },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_ITEM" }));
    expect(() =>
      applyDurableOperation(
        created,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { geometry: { x: 1, y: 2, text: "wrong kind" } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("applies a copy/delete batch atomically and allocates consecutive z values", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    const result = applyDurableOperation(
      created,
      {
        kind: "items.batch",
        operations: [
          {
            kind: "item.copy",
            sourceItemId: RECTANGLE_ID,
            expectedVersion: 1,
            newItemId: COPY_ID,
            translate: { x: 5.126, y: -2 },
          },
        ],
      },
      { seq: 2, actorId: BOB },
    );
    expect(result.state.items.get(COPY_ID)?.item).toMatchObject({
      z: 2,
      version: 2,
      createdBy: BOB,
      transform: [1, 0, 0, 1, 5.13, -2],
    });

    const beforeFailure = result.state;
    expect(() =>
      applyDurableOperation(
        beforeFailure,
        {
          kind: "items.batch",
          operations: [
            { kind: "item.delete", itemId: RECTANGLE_ID, expectedVersion: 1 },
            { kind: "item.delete", itemId: COPY_ID, expectedVersion: 999 },
          ],
        },
        { seq: 3, actorId: ALICE },
      ),
    ).toThrow(BoardCoreError);
    expect(beforeFailure.items.get(RECTANGLE_ID)?.exists).toBe(true);
    expect(beforeFailure.items.get(COPY_ID)?.exists).toBe(true);
  });

  it("commits successful multi-item batches, tombstones deletes, and never reuses IDs", () => {
    const batchedCreate = applyDurableOperation(
      createBoardState(),
      {
        kind: "items.batch",
        operations: [
          { kind: "item.create", item: rectangle(RECTANGLE_ID) },
          { kind: "item.create", item: rectangle(COPY_ID) },
        ],
      },
      { seq: 1, actorId: ALICE },
    );
    expect(liveItemsInPaintOrder(batchedCreate.state).map((item) => item.z)).toEqual([1, 2]);

    const changed = applyDurableOperation(
      batchedCreate.state,
      {
        kind: "items.batch",
        operations: [
          { kind: "item.delete", itemId: RECTANGLE_ID, expectedVersion: 1 },
          {
            kind: "item.update",
            itemId: COPY_ID,
            expectedVersion: 1,
            patch: { transform: [1, 0, 0, 1, 12, 14] },
          },
        ],
      },
      { seq: 2, actorId: ALICE },
    );
    expect(changed.state.items.get(RECTANGLE_ID)).toMatchObject({
      exists: false,
      item: { version: 2 },
    });
    expect(changed.state.items.get(COPY_ID)).toMatchObject({
      exists: true,
      item: { version: 2, transform: [1, 0, 0, 1, 12, 14] },
    });
    expect(() =>
      applyDurableOperation(
        changed.state,
        { kind: "item.create", item: rectangle(RECTANGLE_ID) },
        { seq: 3, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ITEM_ID" }));
  });

  it("creates, edits, copies, and deletes sticky notes with matching schemas", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: sticky() },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: {
            kind: "sticky",
            fill: "#f8bbd0",
            textColor: "#212121",
            fontSize: 18,
            opacity: 0.9,
          },
          geometry: { x: 10, y: 20, width: 180, height: 140, text: "Group idea" },
        },
      },
      { seq: 2, actorId: ALICE },
    );
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "sticky",
      version: 2,
      style: { fill: "#f8bbd0", fontSize: 18, opacity: 0.9 },
      geometry: { text: "Group idea" },
    });
    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Sticky ideas" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items[0]).toMatchObject({
      kind: "sticky",
      style: {
        kind: "sticky",
        fill: "#f8bbd0",
        textColor: "#212121",
        fontSize: 18,
        opacity: 0.9,
      },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "Group idea" },
    });

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 20, y: 30 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "sticky",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 20, 30],
      geometry: { text: "Group idea" },
    });

    const deleted = applyDurableOperation(
      copied.state,
      { kind: "item.delete", itemId: RECTANGLE_ID, expectedVersion: 2 },
      { seq: 4, actorId: ALICE },
    );
    expect(deleted.state.items.get(RECTANGLE_ID)?.exists).toBe(false);
    expect(deleted.state.items.get(COPY_ID)?.exists).toBe(true);

    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: {
            style: { kind: "text", color: "#123456", fontSize: 16, opacity: 1 },
          },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { geometry: { x: 1, y: 2, text: "ordinary text" } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("clears all live items only at the exact expected board sequence", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    expect(() =>
      applyDurableOperation(
        created,
        { kind: "board.clear", expectedBoardSeq: 0 },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_BOARD" }));
    const cleared = applyDurableOperation(
      created,
      { kind: "board.clear", expectedBoardSeq: 1 },
      { seq: 2, actorId: ALICE },
    );
    expect(cleared.operation).toEqual({
      kind: "board.clear",
      removed: [{ itemId: RECTANGLE_ID, version: 2 }],
    });
    expect(liveItemsInPaintOrder(cleared.state)).toEqual([]);
    expect(cleared.state.items.get(RECTANGLE_ID)?.exists).toBe(false);
  });
});

describe("lineage-aware undo and redo", () => {
  it("supports create → move → undo move → undo create without rewinding public versions", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    );
    const moved = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: { transform: [1, 0, 0, 1, 50, 60] },
      },
      { seq: 2, actorId: ALICE },
    );
    const undoMove = applyUndoEffects(moved.state, moved.effects, {
      seq: 3,
      targetActionId: ACTION_2,
    });
    expect(undoMove.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      version: 3,
      transform: [1, 0, 0, 1, 0, 0],
    });
    expect(undoMove.state.items.get(RECTANGLE_ID)?.stateToken).toBe(
      created.state.items.get(RECTANGLE_ID)?.stateToken,
    );

    const undoCreate = applyUndoEffects(undoMove.state, created.effects, {
      seq: 4,
      targetActionId: ACTION_1,
    });
    expect(undoCreate.state.items.get(RECTANGLE_ID)).toMatchObject({ exists: false });

    const redoCreate = applyRedoEffects(undoCreate.state, created.effects, {
      seq: 5,
      targetActionId: ACTION_1,
    });
    expect(redoCreate.state.items.get(RECTANGLE_ID)).toMatchObject({
      exists: true,
      item: { version: 5 },
    });
  });

  it("rejects undo after a collaborator changes the item without partial writes", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    );
    const collaboratorEdit = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: { transform: [1, 0, 0, 1, 7, 9] },
      },
      { seq: 2, actorId: BOB },
    );
    expect(() =>
      applyUndoEffects(collaboratorEdit.state, created.effects, {
        seq: 3,
        targetActionId: ACTION_1,
      }),
    ).toThrowError(expect.objectContaining({ code: "UNDO_CONFLICT" }));
    expect(collaboratorEdit.state.items.get(RECTANGLE_ID)?.item.transform).toEqual([
      1, 0, 0, 1, 7, 9,
    ]);
  });
});

describe("authoritative replay and snapshots", () => {
  it("applies canonical deltas without computing inverses", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    );
    const clientItems = applyAuthoritativeOperation(new Map(), created.operation);
    expect(clientItems.get(RECTANGLE_ID)).toEqual(created.state.items.get(RECTANGLE_ID)?.item);
    const removed = applyAuthoritativeOperation(clientItems, {
      kind: "history.undo",
      targetActionId: ACTION_1,
      changes: [{ kind: "item.remove", itemId: RECTANGLE_ID, version: 2 }],
    });
    expect(removed.size).toBe(0);
  });

  it("serializes stable top-level/item order and paint order", () => {
    const first = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    const second = applyDurableOperation(
      first,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 1,
        newItemId: COPY_ID,
        translate: { x: 5, y: 5 },
      },
      { seq: 2, actorId: ALICE },
    ).state;
    const items = liveItemsInPaintOrder(second).reverse();
    const input = {
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 2,
      createdAt: 1_785_840_000_000,
      settings: { title: "Algebra group" },
      items,
    };
    const one = serializeCanonicalSnapshot(input);
    const two = serializeCanonicalSnapshot({ ...input, items: [...items].reverse() });
    expect(one).toBe(two);
    expect(one.startsWith('{"format":"cf-whiteboard-json","version":1,"boardId":')).toBe(true);
    expect(JSON.parse(one).items.map((item: { z: number }) => item.z)).toEqual([1, 2]);
    expect(canonicalSnapshotBytes(input)).toEqual(new TextEncoder().encode(one));
  });

  it("decomposes canonical snapshot bytes exactly, including UTF-8 and commas", () => {
    const first = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    const second = applyDurableOperation(
      first,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 1,
        newItemId: COPY_ID,
        translate: { x: 5, y: 5 },
      },
      { seq: 2, actorId: ALICE },
    ).state;
    const items = liveItemsInPaintOrder(second);
    const metadata = {
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 10,
      createdAt: 1_785_840_000_000,
      settings: { title: 'π algebra "group"\n第二行' },
    };
    const serialized = serializeCanonicalSnapshot({ ...metadata, items });
    const itemBytes = items.reduce(
      (total, item) => total + canonicalSnapshotItemByteLength(item),
      0,
    );
    expect(
      canonicalSnapshotByteLengthFromParts({
        ...metadata,
        itemCount: items.length,
        itemBytes,
      }),
    ).toBe(new TextEncoder().encode(serialized).byteLength);
  });

  it("accounts for the exact 20 MiB boundary without allocating a full snapshot", () => {
    const metadata = {
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 99,
      createdAt: 1_785_840_000_000,
      settings: { title: "Boundary" },
      itemCount: 1,
    };
    const maximum = 20 * 1024 * 1024;
    const envelope = canonicalSnapshotByteLengthFromParts({ ...metadata, itemBytes: 0 });
    expect(
      canonicalSnapshotByteLengthFromParts({
        ...metadata,
        itemBytes: maximum - envelope,
      }),
    ).toBe(maximum);
    expect(
      canonicalSnapshotByteLengthFromParts({
        ...metadata,
        itemBytes: maximum - envelope + 1,
      }),
    ).toBe(maximum + 1);
  });
});
