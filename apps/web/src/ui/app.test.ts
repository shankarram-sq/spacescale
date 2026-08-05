import { describe, expect, it } from "vitest";

import { boardIdFromPath } from "./app";

const boardId = "b_1234567890123456789012";

describe("board path routing", () => {
  it("accepts normal and classroom embed board paths", () => {
    expect(boardIdFromPath(`/b/${boardId}`)).toBe(boardId);
    expect(boardIdFromPath(`/b/${boardId}/`)).toBe(boardId);
    expect(boardIdFromPath(`/embed/b/${boardId}`)).toBe(boardId);
    expect(boardIdFromPath(`/embed/b/${boardId}/`)).toBe(boardId);
  });

  it("rejects launch and malformed paths", () => {
    expect(boardIdFromPath("/embed")).toBeNull();
    expect(boardIdFromPath(`/other/b/${boardId}`)).toBeNull();
    expect(boardIdFromPath("/embed/b/not-a-board")).toBeNull();
  });
});
