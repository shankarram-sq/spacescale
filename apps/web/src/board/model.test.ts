import { describe, expect, it } from "vitest";
import type { BoardItem, BoardSnapshot, CommitFrame, ServerAction } from "../types";
import { BoardModel, itemBounds, SequenceError } from "./model";

const ACTOR_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abc";
const ITEM_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abd";
const ACTION_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abe";
const PENDING_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abf";
const REMOTE_ID = "018f47a1-7a2b-7c3d-8e4f-123456789ac0";

function rectangle(version = 1): BoardItem {
  return {
    id: ITEM_ID,
    kind: "rectangle",
    z: 1,
    version,
    createdBy: ACTOR_ID,
    style: { kind: "stroke", color: "#20201e", width: 4, opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 10, y: 20, width: 100, height: 60 },
  };
}

function sticky(version = 1): BoardItem {
  return {
    id: ITEM_ID,
    kind: "sticky",
    z: 1,
    version,
    createdBy: ACTOR_ID,
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#292524",
      fontSize: 20,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 30, -5],
    geometry: { x: 10, y: 20, width: 180, height: 140, text: "" },
  };
}

function stamp(version = 1): BoardItem {
  return {
    id: ITEM_ID,
    kind: "stamp",
    z: 2,
    version,
    createdBy: ACTOR_ID,
    style: { kind: "stamp", color: "#e5484d", opacity: 0.8 },
    transform: [1, 0, 0, 1, 10, -5],
    geometry: { x: 100, y: 80, size: 72, stamp: "star" },
  };
}

function image(version = 1): BoardItem {
  return {
    id: ITEM_ID,
    kind: "image",
    z: 3,
    version,
    createdBy: ACTOR_ID,
    style: { kind: "image", opacity: 0.9, radius: 12 },
    transform: [1, 0, 0, 1, 15, -10],
    geometry: {
      x: 40,
      y: 50,
      width: 360,
      height: 240,
      assetId: `asset_${"c".repeat(43)}`,
      alt: "Microscope slide",
      mimeType: "image/png",
      intrinsicWidth: 1_200,
      intrinsicHeight: 800,
    },
  };
}

function zone(version = 1): BoardItem {
  return {
    id: "018f47a1-7a2b-7c3d-8e4f-123456789ac1",
    kind: "zone",
    z: 3,
    version,
    createdBy: ACTOR_ID,
    style: {
      kind: "zone",
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18,
      opacity: 0.18,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 520, height: 320, title: "Evidence" },
  };
}

function snapshot(items: BoardItem[] = [], seq = 0): BoardSnapshot {
  return { format: "cf-whiteboard-json", version: 1, seq, items };
}

describe("BoardModel", () => {
  it("renders an optimistic create and replaces it with the authoritative item", () => {
    const model = new BoardModel();
    model.load(snapshot());
    const command: CommitFrame = {
      v: 1,
      t: "client.commit",
      commandId: ACTION_ID,
      actionId: ACTION_ID,
      baseSeq: 0,
      op: {
        kind: "item.create",
        item: {
          id: ITEM_ID,
          kind: "rectangle",
          style: { kind: "stroke", color: "#20201e", width: 4, opacity: 1 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 10, y: 20, width: 100, height: 60 },
        },
      },
    };
    model.queue(command, ACTOR_ID);
    expect(model.getItem(ITEM_ID)?.version).toBe(0);
    expect(model.pendingCount).toBe(1);

    model.applyAction({
      v: 1,
      t: "server.action",
      seq: 1,
      acceptedAt: 1,
      actor: { id: ACTOR_ID, displayName: "Sam" },
      commandId: ACTION_ID,
      actionId: ACTION_ID,
      op: { kind: "item.create", item: rectangle() },
    } as unknown as ServerAction);

    expect(model.pendingCount).toBe(0);
    expect(model.getItem(ITEM_ID)).toEqual(rectangle());
    expect(model.lastAppliedSeq).toBe(1);
  });

  it("applies shared canonical history changes", () => {
    const model = new BoardModel();
    model.load(snapshot([rectangle()], 1));
    model.applyAction({
      v: 1,
      t: "server.action",
      seq: 2,
      acceptedAt: 2,
      actor: { id: ACTOR_ID, displayName: "Sam" },
      commandId: "018f47a1-7a2b-7c3d-8e4f-123456789abf",
      actionId: "018f47a1-7a2b-7c3d-8e4f-123456789abf",
      op: {
        kind: "history.undo",
        targetActionId: ACTION_ID,
        changes: [{ kind: "item.remove", itemId: ITEM_ID, version: 2 }],
      },
    } as unknown as ServerAction);
    expect(model.getItem(ITEM_ID)).toBeUndefined();
    expect(model.lastAppliedSeq).toBe(2);
  });

  it("rejects a sequence gap before changing content", () => {
    const model = new BoardModel();
    model.load(snapshot([rectangle()], 1));
    expect(() =>
      model.applyAction({
        v: 1,
        t: "server.action",
        seq: 3,
        acceptedAt: 3,
        actor: { id: ACTOR_ID, displayName: "Sam" },
        commandId: ACTION_ID,
        actionId: ACTION_ID,
        op: { kind: "item.delete", itemId: ITEM_ID, version: 3 },
      } as unknown as ServerAction),
    ).toThrow(SequenceError);
    expect(model.getItem(ITEM_ID)).toEqual(rectangle());
  });

  it("caches transformed bounds for selection and hit testing", () => {
    const item = rectangle();
    item.transform = [1, 0, 0, 1, 30, -5];
    expect(itemBounds(item)).toEqual({ minX: 38, minY: 13, maxX: 142, maxY: 77 });
    const model = new BoardModel();
    model.load(snapshot([item], 1));
    expect(model.hitTest([50, 30])?.id).toBe(ITEM_ID);
    expect(model.hitTest([400, 300])).toBeUndefined();
  });

  it("uses the complete sticky rectangle for bounds and hit testing", () => {
    const item = sticky();
    expect(itemBounds(item)).toEqual({ minX: 40, minY: 15, maxX: 220, maxY: 155 });
    const model = new BoardModel();
    model.load(snapshot([item], 1));
    expect(model.hitTest([219, 154], 0)?.id).toBe(ITEM_ID);
    expect(model.hitTest([39, 14], 0)).toBeUndefined();
  });

  it("does not hit the empty corners of a rotated sticky AABB", () => {
    const item = sticky();
    const diagonal = Math.SQRT1_2;
    item.geometry = { x: 0, y: 0, width: 100, height: 100, text: "" };
    item.transform = [diagonal, diagonal, -diagonal, diagonal, 0, 0];
    const model = new BoardModel();
    model.load(snapshot([item], 1));

    expect(model.hitTest([0, 70], 0)?.id).toBe(ITEM_ID);
    expect(model.hitTest([-65, 5], 0)).toBeUndefined();
  });

  it("loads stamps from snapshots and uses their centered square for bounds and hits", () => {
    const item = stamp();
    expect(itemBounds(item)).toEqual({ minX: 74, minY: 39, maxX: 146, maxY: 111 });

    const model = new BoardModel();
    model.load(snapshot([item], 4));

    expect(model.getItem(ITEM_ID)).toEqual(item);
    expect(model.hitTest([75, 40], 0)?.kind).toBe("stamp");
    expect(model.hitTest([73, 38], 0)).toBeUndefined();
  });

  it("uses the full transformed image card for bounds and hit testing", () => {
    const item = image();
    expect(itemBounds(item)).toEqual({ minX: 55, minY: 40, maxX: 415, maxY: 280 });

    const model = new BoardModel();
    model.load(snapshot([item], 5));

    expect(model.getItem(ITEM_ID)).toEqual(item);
    expect(model.hitTest([56, 41], 0)?.kind).toBe("image");
    expect(model.hitTest([54, 39], 0)).toBeUndefined();
  });

  it("selects a zone only by its title or border so inner items remain reachable", () => {
    const inner = rectangle();
    const frame = zone();
    expect(itemBounds(frame)).toEqual({ minX: 0, minY: 0, maxX: 520, maxY: 320 });

    const model = new BoardModel();
    model.load(snapshot([inner, frame], 6));

    expect(model.hitTest([300, 20], 0)?.kind).toBe("zone");
    expect(model.hitTest([2, 180], 0)?.kind).toBe("zone");
    expect(model.hitTest([50, 60], 0)?.kind).toBe("rectangle");
    expect(model.hitTest([300, 180], 0)).toBeUndefined();
  });

  it("requires a marquee to fully contain a zone", () => {
    const frame = zone();
    const model = new BoardModel();
    model.load(snapshot([frame], 7));

    expect(
      model.intersecting({ minX: 0, minY: 0, maxX: 519, maxY: 320 }).map((item) => item.id),
    ).not.toContain(frame.id);
    expect(
      model.intersecting({ minX: -1, minY: -1, maxX: 521, maxY: 321 }).map((item) => item.id),
    ).toContain(frame.id);
  });

  it("retains the optimistic journal when a remote action makes rebase unsafe", () => {
    const model = new BoardModel();
    model.load(snapshot([rectangle()], 1));
    const rebaseStates: boolean[] = [];
    model.subscribeRebase((error) => rebaseStates.push(error !== null));
    const pending: CommitFrame = {
      v: 1,
      t: "client.commit",
      commandId: PENDING_ID,
      actionId: PENDING_ID,
      baseSeq: 1,
      op: {
        kind: "item.update",
        itemId: ITEM_ID,
        expectedVersion: 1,
        patch: { transform: [1, 0, 0, 1, 24, 0] },
      },
    };
    model.queue(pending, ACTOR_ID);

    model.applyAction({
      v: 1,
      t: "server.action",
      seq: 2,
      acceptedAt: 2,
      actor: { id: ACTOR_ID, displayName: "Taylor" },
      commandId: REMOTE_ID,
      actionId: REMOTE_ID,
      op: { kind: "item.delete", itemId: ITEM_ID, version: 2 },
    } as unknown as ServerAction);

    expect(model.getItem(ITEM_ID)).toBeUndefined();
    expect(model.pendingCount).toBe(1);
    expect(model.pendingCommands).toEqual([pending]);
    expect(model.rebaseError).toBeInstanceOf(Error);
    expect(rebaseStates).toEqual([true]);

    expect(model.discardOptimistic()).toEqual([pending]);
    expect(model.pendingCount).toBe(0);
    expect(model.rebaseError).toBeNull();
    expect(rebaseStates).toEqual([true, false]);
  });
});
