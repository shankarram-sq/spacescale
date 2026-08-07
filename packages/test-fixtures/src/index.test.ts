import { validateClientFrame } from "@collab/protocol";
import { describe, expect, it } from "vitest";
import {
  boardItem,
  boardState,
  createCommitFrame,
  FIXTURE_IDS,
  newImageItem,
  newPencilItem,
  newRectangleItem,
  newStampItem,
  newStickyItem,
  serverCreateAction,
} from "./index.js";

describe("deterministic shared fixtures", () => {
  it("builds protocol-valid commands", () => {
    expect(validateClientFrame(createCommitFrame())).toEqual(createCommitFrame());
    expect(validateClientFrame(createCommitFrame(newPencilItem())).t).toBe("client.commit");
    expect(validateClientFrame(createCommitFrame(newStickyItem()))).toEqual(
      createCommitFrame(newStickyItem()),
    );
    expect(validateClientFrame(createCommitFrame(newStampItem()))).toEqual(
      createCommitFrame(newStampItem()),
    );
    expect(validateClientFrame(createCommitFrame(newImageItem()))).toEqual(
      createCommitFrame(newImageItem()),
    );
  });

  it("builds canonical server actions and states without mutable globals", () => {
    const first = boardItem(newRectangleItem());
    const action = serverCreateAction(first);
    expect(action.op).toEqual({ kind: "item.create", item: first });
    expect(boardState([first]).items.get(FIXTURE_IDS.rectangle)?.item).toEqual(first);
    expect(boardState().items).not.toBe(boardState().items);
  });
});
