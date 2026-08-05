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
