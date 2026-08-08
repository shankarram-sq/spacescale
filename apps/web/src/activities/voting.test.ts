import { MAX_BATCH_OPERATIONS } from "@collab/protocol";
import { describe, expect, it } from "vitest";

import type { BoardItem, Matrix, StampKind } from "../types";
import {
  buildClearVoteDeletes,
  isVoteTable,
  MAX_RENDERED_VOTE_TABLES,
  summarizeBoardVotes,
  summarizeVotes,
  VOTE_TABLE_STYLE,
} from "./voting";

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function voteTable(transform: Matrix = IDENTITY): BoardItem {
  return {
    id: "vote-table",
    kind: "table",
    z: 1,
    version: 5,
    createdBy: "teacher",
    transform,
    style: { ...VOTE_TABLE_STYLE },
    geometry: {
      x: 0,
      y: 0,
      columnWidths: [100, 100],
      rowHeights: [40, 120],
      cells: [
        ["Yes", "Not yet"],
        ["", ""],
      ],
      headerRow: true,
    },
  };
}

function stamp(
  id: string,
  x: number,
  y: number,
  version = 2,
  transform: Matrix = IDENTITY,
  stampKind: StampKind = "star",
  createdBy = `actor-${id}`,
  z = version,
): BoardItem {
  return {
    id,
    kind: "stamp",
    z,
    version,
    createdBy,
    transform,
    style: { kind: "stamp", color: "#e5484d", opacity: 1 },
    geometry: { x, y, size: 36, stamp: stampKind },
  };
}

describe("convention-based stamp voting", () => {
  it("requires the explicit vote style as well as the two-row labelled layout", () => {
    expect(isVoteTable(voteTable())).toBe(true);
    const copied = { ...structuredClone(voteTable()), id: "copied-vote-table" };
    expect(isVoteTable(copied)).toBe(true);

    const ordinary = structuredClone(voteTable());
    if (ordinary.kind !== "table") throw new Error("Expected a table.");
    ordinary.style = {
      kind: "table",
      borderColor: "#a8a59d",
      fill: "#fffefa",
      headerFill: "#e8edff",
      textColor: "#20201e",
      fontSize: 16,
      opacity: 1,
    };
    expect(isVoteTable(ordinary)).toBe(false);

    const kwl = structuredClone(voteTable());
    if (kwl.kind !== "table") throw new Error("Expected a table.");
    kwl.geometry.rowHeights.push(80);
    kwl.geometry.cells.push(["", ""]);
    expect(isVoteTable(kwl)).toBe(false);

    const filled = structuredClone(voteTable());
    if (filled.kind !== "table") throw new Error("Expected a table.");
    filled.geometry.cells[1] = ["written answer", ""];
    expect(isVoteTable(filled)).toBe(false);
  });

  it("counts only each actor's highest-z authoritative stamp but retains every inside ID", () => {
    const table = voteTable();
    const oldVote = stamp("old-vote", 50, 80, 2, IDENTITY, "star", "student-a", 10);
    const currentVote = stamp("current-vote", 150, 80, 3, IDENTITY, "check", "student-a", 12);
    const otherVote = stamp("other-vote", 50, 80, 4, IDENTITY, "heart", "student-b", 11);
    const optimistic = stamp("optimistic", 150, 80, 0, IDENTITY, "star", "student-c", 20);
    const items = [table, oldVote, currentVote, otherVote, optimistic];

    expect(summarizeVotes(table, items)).toEqual({
      tableId: "vote-table",
      options: [
        { column: 0, label: "Yes", count: 1 },
        { column: 1, label: "Not yet", count: 1 },
      ],
      stampIds: ["old-vote", "current-vote", "other-vote", "optimistic"],
    });
    const clear = buildClearVoteDeletes(table, items);
    expect(clear.operations.map(({ itemId }) => itemId)).toEqual([
      "old-vote",
      "current-vote",
      "other-vote",
    ]);
  });

  it("counts transformed stamp centers in body columns and ignores headers and outsiders", () => {
    const table = voteTable([0, 1, -1, 0, 500, 100]);
    const first = stamp("first", 0, 0, 2, [1, 0, 0, 1, 400, 150]);
    const second = stamp("second", 0, 0, 3, [1, 0, 0, 1, 400, 250]);
    const header = stamp("header", 0, 0, 4, [1, 0, 0, 1, 480, 150]);
    const outside = stamp("outside", 0, 0, 5, [1, 0, 0, 1, 400, 350]);
    const rectangle: BoardItem = {
      id: "not-a-stamp",
      kind: "rectangle",
      z: 6,
      version: 6,
      createdBy: "student",
      transform: IDENTITY,
      style: { kind: "stroke", color: "#20201e", width: 2, opacity: 1 },
      geometry: { x: 400, y: 150, width: 20, height: 20, shape: "rectangle" },
    };

    expect(summarizeVotes(table, [table, first, second, header, outside, rectangle])).toEqual({
      tableId: "vote-table",
      options: [
        { column: 0, label: "Yes", count: 1 },
        { column: 1, label: "Not yet", count: 1 },
      ],
      stampIds: ["first", "second"],
    });
  });

  it("builds capped versioned deletes and ignores optimistic votes", () => {
    const table = voteTable();
    const saved = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, index) =>
      stamp(`saved-${index}`, index % 2 === 0 ? 50 : 150, 80, index + 1),
    );
    const optimistic = stamp("optimistic", 50, 80, 0);
    const result = buildClearVoteDeletes(table, [table, ...saved, optimistic], 1_000);

    expect(result.operations).toHaveLength(MAX_BATCH_OPERATIONS);
    expect(result.total).toBe(MAX_BATCH_OPERATIONS + 1);
    expect(result.remaining).toBe(1);
    expect(result.operations[0]).toEqual({
      kind: "item.delete",
      itemId: "saved-0",
      expectedVersion: 1,
    });
    expect(result.operations.some(({ itemId }) => itemId === "optimistic")).toBe(false);
  });

  it("caps board-wide recognition before scanning stamps", () => {
    const tables = Array.from({ length: MAX_RENDERED_VOTE_TABLES + 1 }, (_, index) => ({
      ...structuredClone(voteTable()),
      id: `vote-table-${index}`,
      transform: [1, 0, 0, 1, index * 300, 0] as Matrix,
    }));
    const summaries = summarizeBoardVotes(tables);

    expect(summaries).toHaveLength(MAX_RENDERED_VOTE_TABLES);
    expect(summaries.at(-1)?.tableId).toBe(`vote-table-${MAX_RENDERED_VOTE_TABLES - 1}`);
    expect(
      summaries.some(({ tableId }) => tableId === `vote-table-${MAX_RENDERED_VOTE_TABLES}`),
    ).toBe(false);
  });
});
