import type { ImageGeometry, ItemEffect } from "@collab/protocol";
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
  cloneBoardItem,
  createBoardState,
  liveItemsInPaintOrder,
  serializeCanonicalSnapshot,
} from "./index.js";

const ALICE = "018f0000-0000-7000-8000-0000000000a1";
const BOB = "018f0000-0000-7000-8000-0000000000b1";
const RECTANGLE_ID = "018f0000-0000-7000-8000-000000000001";
const COPY_ID = "018f0000-0000-7000-8000-000000000002";
const ASSET_ID = "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_ASSET_ID = "asset_CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
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

function stamp(id = RECTANGLE_ID) {
  return {
    id,
    kind: "stamp" as const,
    style: { kind: "stamp" as const, color: "#e11d48", opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x: 40, y: 50, size: 72, stamp: "heart" as const },
  };
}

function image(id = RECTANGLE_ID) {
  return {
    id,
    kind: "image" as const,
    style: { kind: "image" as const, opacity: 1, radius: 12 },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: {
      x: 10,
      y: 20,
      width: 240,
      height: 160,
      assetId: ASSET_ID,
      alt: "Cell diagram",
      mimeType: "image/png" as const,
      intrinsicWidth: 1200,
      intrinsicHeight: 800,
    },
  };
}

function table(id = RECTANGLE_ID) {
  return {
    id,
    kind: "table" as const,
    style: {
      kind: "table" as const,
      borderColor: "#94a3b8",
      fill: "#ffffff",
      headerFill: "#e2e8f0",
      textColor: "#0f172a",
      fontSize: 16,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: {
      x: 10,
      y: 20,
      columnWidths: [120, 120, 120],
      rowHeights: [48, 48, 48],
      cells: [
        ["Term", "Meaning", "Example"],
        ["Atom", "Small unit", "Carbon"],
        ["", "", ""],
      ],
      headerRow: true,
    },
  };
}

function zone(id = RECTANGLE_ID) {
  return {
    id,
    kind: "zone" as const,
    style: {
      kind: "zone" as const,
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18,
      opacity: 0.18,
    },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x: 10, y: 20, width: 520, height: 320, title: "Evidence" },
  };
}

function corruptImageEffect(
  effects: readonly ItemEffect[],
  stateKey: "before" | "after",
  change: Partial<
    Pick<ImageGeometry, "assetId" | "mimeType" | "intrinsicWidth" | "intrinsicHeight">
  >,
): ItemEffect[] {
  const corrupted = structuredClone(effects) as ItemEffect[];
  const logicalState = corrupted[0]?.[stateKey];
  if (logicalState?.exists !== true || logicalState.item.kind !== "image") {
    throw new Error(`Expected ${stateKey} image effect state`);
  }
  logicalState.item.geometry = {
    ...logicalState.item.geometry,
    ...change,
  };
  return corrupted;
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

  it("persists stamp create, update, copy, delete, history, and snapshots", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: stamp() },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: { kind: "stamp", color: "#2563eb", opacity: 0.8 },
          geometry: { x: 42, y: 54, size: 80, stamp: "sparkle" },
        },
      },
      { seq: 2, actorId: ALICE },
    );
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "stamp",
      version: 2,
      style: { kind: "stamp", color: "#2563eb", opacity: 0.8 },
      geometry: { x: 42, y: 54, size: 80, stamp: "sparkle" },
    });

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Stamp check-in" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "stamp",
        style: { kind: "stamp", color: "#2563eb", opacity: 0.8 },
        geometry: { x: 42, y: 54, size: 80, stamp: "sparkle" },
      }),
    ]);

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 10, y: -5 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "stamp",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 10, -5],
      geometry: { stamp: "sparkle" },
    });

    const deleted = applyDurableOperation(
      copied.state,
      { kind: "item.delete", itemId: RECTANGLE_ID, expectedVersion: 2 },
      { seq: 4, actorId: ALICE },
    );
    expect(deleted.state.items.get(RECTANGLE_ID)?.exists).toBe(false);
    const undone = applyUndoEffects(deleted.state, deleted.effects, {
      seq: 5,
      targetActionId: ACTION_2,
    });
    expect(undone.state.items.get(RECTANGLE_ID)).toMatchObject({
      exists: true,
      item: { kind: "stamp", version: 5, geometry: { stamp: "sparkle" } },
    });
    const redone = applyRedoEffects(undone.state, deleted.effects, {
      seq: 6,
      targetActionId: ACTION_2,
    });
    expect(redone.state.items.get(RECTANGLE_ID)).toMatchObject({ exists: false });

    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { style: { kind: "text", color: "#123456", fontSize: 16, opacity: 1 } },
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
          patch: { geometry: { x: 1, y: 2, text: "wrong geometry" } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("persists, clones, copies, snapshots, and restores whole table grids", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: table() },
      { seq: 1, actorId: ALICE },
    );
    const revisedGeometry = {
      ...table().geometry,
      cells: [
        ["Word", "Definition", "Example"],
        ["Atom", "Small unit of matter", "Carbon"],
        ["Molecule", "Two or more atoms", "Water"],
      ],
    };
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: {
            ...table().style,
            headerFill: "#dbeafe",
            opacity: 0.9,
          },
          geometry: revisedGeometry,
        },
      },
      { seq: 2, actorId: ALICE },
    );
    const stored = updated.state.items.get(RECTANGLE_ID)?.item;
    expect(stored).toMatchObject({
      kind: "table",
      version: 2,
      style: { kind: "table", headerFill: "#dbeafe", opacity: 0.9 },
      geometry: { headerRow: true, cells: revisedGeometry.cells },
    });
    if (stored?.kind !== "table") throw new Error("Expected stored table fixture");
    const cloned = cloneBoardItem(stored);
    if (cloned.kind !== "table") throw new Error("Expected cloned table fixture");
    cloned.geometry.columnWidths[0] = 999;
    cloned.geometry.rowHeights[0] = 999;
    const firstClonedRow = cloned.geometry.cells[0];
    if (firstClonedRow === undefined) throw new Error("Expected cloned table row");
    firstClonedRow[0] = "Mutated";
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      geometry: {
        columnWidths: [120, 120, 120],
        rowHeights: [48, 48, 48],
        cells: revisedGeometry.cells,
      },
    });

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 25, y: -10 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "table",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 25, -10],
      geometry: { cells: revisedGeometry.cells },
    });

    const undone = applyUndoEffects(updated.state, updated.effects, {
      seq: 3,
      targetActionId: ACTION_2,
    });
    expect(undone.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "table",
      version: 3,
      style: { headerFill: "#e2e8f0", opacity: 1 },
      geometry: { cells: table().geometry.cells },
    });
    const redone = applyRedoEffects(undone.state, updated.effects, {
      seq: 4,
      targetActionId: ACTION_2,
    });
    expect(redone.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "table",
      version: 4,
      geometry: { cells: revisedGeometry.cells },
    });

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Vocabulary grid" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "table",
        style: {
          kind: "table",
          borderColor: "#94a3b8",
          fill: "#ffffff",
          headerFill: "#dbeafe",
          textColor: "#0f172a",
          fontSize: 16,
          opacity: 0.9,
        },
        geometry: {
          x: 10,
          y: 20,
          columnWidths: [120, 120, 120],
          rowHeights: [48, 48, 48],
          cells: revisedGeometry.cells,
          headerRow: true,
        },
      }),
    ]);

    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { style: { kind: "stamp", color: "#123456", opacity: 1 } },
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
          patch: { geometry: { x: 0, y: 0, width: 100, height: 100 } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("persists zone titles through copy, history, delete, and canonical snapshots", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: zone() },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: { ...zone().style, opacity: 0.25 },
          geometry: { ...zone().geometry, title: "Finished examples" },
        },
      },
      { seq: 2, actorId: ALICE },
    );
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "zone",
      version: 2,
      style: { kind: "zone", opacity: 0.25 },
      geometry: { title: "Finished examples" },
    });
    const stored = updated.state.items.get(RECTANGLE_ID)?.item;
    if (stored?.kind !== "zone") throw new Error("Expected stored zone fixture");
    const cloned = cloneBoardItem(stored);
    if (cloned.kind !== "zone") throw new Error("Expected cloned zone fixture");
    cloned.geometry.title = "Changed clone";
    cloned.style.fill = "#ffffff";
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      style: { fill: "#e8edff" },
      geometry: { title: "Finished examples" },
    });

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 40, y: -15 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "zone",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 40, -15],
      geometry: { title: "Finished examples" },
    });
    const deleted = applyDurableOperation(
      copied.state,
      { kind: "item.delete", itemId: COPY_ID, expectedVersion: 3 },
      { seq: 4, actorId: BOB },
    );
    expect(deleted.state.items.get(COPY_ID)?.exists).toBe(false);
    const undoneDelete = applyUndoEffects(deleted.state, deleted.effects, {
      seq: 5,
      targetActionId: ACTION_2,
    });
    expect(undoneDelete.state.items.get(COPY_ID)).toMatchObject({
      exists: true,
      item: { kind: "zone", version: 5, geometry: { title: "Finished examples" } },
    });
    const redoneDelete = applyRedoEffects(undoneDelete.state, deleted.effects, {
      seq: 6,
      targetActionId: ACTION_2,
    });
    expect(redoneDelete.state.items.get(COPY_ID)?.exists).toBe(false);

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Group work" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "zone",
        style: {
          kind: "zone",
          borderColor: "#a8a59d",
          fill: "#e8edff",
          textColor: "#4f5b75",
          fontSize: 18,
          opacity: 0.25,
        },
        geometry: {
          x: 10,
          y: 20,
          width: 520,
          height: 320,
          title: "Finished examples",
        },
      }),
    ]);

    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { geometry: { x: 0, y: 0, width: 100, height: 100 } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("persists image cards while keeping uploaded asset metadata immutable", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: image() },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: { kind: "image", opacity: 0.8, radius: 18 },
          geometry: {
            ...image().geometry,
            x: 30,
            y: 40,
            width: 300,
            height: 200,
            alt: "Labeled cell diagram",
          },
        },
      },
      { seq: 2, actorId: ALICE },
    );
    const stored = updated.state.items.get(RECTANGLE_ID)?.item;
    expect(stored).toMatchObject({
      kind: "image",
      version: 2,
      style: { kind: "image", opacity: 0.8, radius: 18 },
      geometry: {
        x: 30,
        y: 40,
        width: 300,
        height: 200,
        assetId: ASSET_ID,
        alt: "Labeled cell diagram",
        mimeType: "image/png",
        intrinsicWidth: 1200,
        intrinsicHeight: 800,
      },
    });

    const undone = applyUndoEffects(updated.state, updated.effects, {
      seq: 3,
      targetActionId: ACTION_2,
    });
    expect(undone.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "image",
      version: 3,
      style: { opacity: 1, radius: 12 },
      geometry: {
        assetId: ASSET_ID,
        alt: "Cell diagram",
        mimeType: "image/png",
        intrinsicWidth: 1200,
        intrinsicHeight: 800,
      },
    });
    const redone = applyRedoEffects(undone.state, updated.effects, {
      seq: 4,
      targetActionId: ACTION_2,
    });
    expect(redone.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "image",
      version: 4,
      geometry: { assetId: ASSET_ID, alt: "Labeled cell diagram" },
    });

    if (stored === undefined) throw new Error("Expected stored image fixture");
    const cloned = cloneBoardItem(stored);
    cloned.transform[4] = 999;
    cloned.style = { kind: "image", opacity: 0.5, radius: 4 };
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      transform: [1, 0, 0, 1, 0, 0],
      style: { opacity: 0.8, radius: 18 },
    });

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Image source analysis" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "image",
        style: { kind: "image", opacity: 0.8, radius: 18 },
        geometry: {
          x: 30,
          y: 40,
          width: 300,
          height: 200,
          assetId: ASSET_ID,
          alt: "Labeled cell diagram",
          mimeType: "image/png",
          intrinsicWidth: 1200,
          intrinsicHeight: 800,
        },
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/data:image|base64|https?:\/\//u);

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 15, y: -10 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "image",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 15, -10],
      geometry: { assetId: ASSET_ID, mimeType: "image/png" },
    });

    const immutableChanges = [
      { assetId: OTHER_ASSET_ID },
      { mimeType: "image/webp" as const },
      { intrinsicWidth: 1199 },
      { intrinsicHeight: 799 },
    ];
    for (const change of immutableChanges) {
      expect(() =>
        applyDurableOperation(
          updated.state,
          {
            kind: "item.update",
            itemId: RECTANGLE_ID,
            expectedVersion: 2,
            patch: { geometry: { ...image().geometry, ...change } },
          },
          { seq: 3, actorId: ALICE },
        ),
      ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));

      expect(() =>
        applyUndoEffects(updated.state, corruptImageEffect(updated.effects, "before", change), {
          seq: 3,
          targetActionId: ACTION_2,
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
      expect(() =>
        applyRedoEffects(undone.state, corruptImageEffect(updated.effects, "after", change), {
          seq: 4,
          targetActionId: ACTION_2,
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
    }

    const consistentlyCorruptedEffects = corruptImageEffect(
      corruptImageEffect(updated.effects, "before", { assetId: OTHER_ASSET_ID }),
      "after",
      { assetId: OTHER_ASSET_ID },
    );
    expect(() =>
      applyUndoEffects(updated.state, consistentlyCorruptedEffects, {
        seq: 3,
        targetActionId: ACTION_2,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));

    expect(() =>
      applyDurableOperation(
        updated.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 2,
          patch: { style: { kind: "stroke", color: "#123456", width: 2, opacity: 1 } },
        },
        { seq: 3, actorId: ALICE },
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
