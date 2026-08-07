import { MAX_BATCH_OPERATIONS } from "@collab/protocol";

import { DRAWING_COLOR_VALUES, STICKY_COLOR_VALUES, UI_COLORS } from "../palette";
import type { BatchItemOperation, BoardItem, Matrix, Point, TableItem, TableStyle } from "../types";

export const MAX_RENDERED_VOTE_TABLES = 32;
export const VOTE_TABLE_STYLE = {
  kind: "table",
  borderColor: DRAWING_COLOR_VALUES.purple,
  fill: UI_COLORS.surface,
  headerFill: STICKY_COLOR_VALUES.lavender,
  textColor: UI_COLORS.ink,
  fontSize: 16,
  opacity: 1,
} as const satisfies TableStyle;

export type VoteOptionSummary = {
  column: number;
  label: string;
  count: number;
};

export type VoteSummary = {
  tableId: string;
  options: VoteOptionSummary[];
  stampIds: string[];
};

export type RenderedVoteSummary = VoteSummary & { table: TableItem };

export type ClearVoteDeletes = {
  operations: Array<Extract<BatchItemOperation, { kind: "item.delete" }>>;
  total: number;
  remaining: number;
};

export function isVoteTableStyle(style: BoardItem["style"]): style is TableStyle {
  return (
    style.kind === "table" &&
    style.borderColor === VOTE_TABLE_STYLE.borderColor &&
    style.fill === VOTE_TABLE_STYLE.fill &&
    style.headerFill === VOTE_TABLE_STYLE.headerFill &&
    style.textColor === VOTE_TABLE_STYLE.textColor &&
    style.fontSize === VOTE_TABLE_STYLE.fontSize &&
    style.opacity === VOTE_TABLE_STYLE.opacity
  );
}

export function isVoteTable(item: BoardItem): item is TableItem {
  if (item.kind !== "table" || !isVoteTableStyle(item.style)) return false;
  const { cells, columnWidths, headerRow, rowHeights } = item.geometry;
  if (
    headerRow !== true ||
    rowHeights.length !== 2 ||
    cells.length !== 2 ||
    columnWidths.length < 2 ||
    columnWidths.length > 6
  ) {
    return false;
  }
  const headers = cells[0];
  const body = cells[1];
  return (
    headers?.length === columnWidths.length &&
    body?.length === columnWidths.length &&
    headers.every((value) => value.trim().length > 0) &&
    body.every((value) => value.trim().length === 0)
  );
}

export function summarizeVotes(table: BoardItem, items: Iterable<BoardItem>): VoteSummary | null {
  if (!isVoteTable(table)) return null;
  const accumulator = createVoteAccumulator(table);
  for (const item of items) {
    if (item.kind !== "stamp") continue;
    const worldCenter = transformPoint([item.geometry.x, item.geometry.y], item.transform);
    recordStamp(accumulator, item, worldCenter);
  }
  return finishVoteSummary(accumulator);
}

export function summarizeBoardVotes(items: Iterable<BoardItem>): RenderedVoteSummary[] {
  const tables: TableItem[] = [];
  const stamps: Array<Extract<BoardItem, { kind: "stamp" }>> = [];
  for (const item of items) {
    if (item.kind === "stamp") stamps.push(item);
    else if (tables.length < MAX_RENDERED_VOTE_TABLES && isVoteTable(item)) tables.push(item);
  }
  const accumulators = tables.map(createVoteAccumulator);
  for (const stamp of stamps) {
    const worldCenter = transformPoint([stamp.geometry.x, stamp.geometry.y], stamp.transform);
    for (const accumulator of accumulators) recordStamp(accumulator, stamp, worldCenter);
  }
  return accumulators.map((accumulator) => ({
    ...finishVoteSummary(accumulator),
    table: accumulator.table,
  }));
}

export function buildClearVoteDeletes(
  table: BoardItem,
  items: Iterable<BoardItem>,
  limit = MAX_BATCH_OPERATIONS,
): ClearVoteDeletes {
  const boardItems = [...items];
  const summary = summarizeVotes(table, boardItems);
  if (!summary) return { operations: [], total: 0, remaining: 0 };
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : MAX_BATCH_OPERATIONS;
  const cappedLimit = Math.max(1, Math.min(MAX_BATCH_OPERATIONS, requestedLimit));
  const byId = new Map(boardItems.map((item) => [item.id, item]));
  const savedVotes = summary.stampIds.flatMap((id) => {
    const item = byId.get(id);
    return item?.kind === "stamp" && item.version > 0 ? [item] : [];
  });
  const operations = savedVotes.slice(0, cappedLimit).map((item) => ({
    kind: "item.delete" as const,
    itemId: item.id,
    expectedVersion: item.version,
  }));
  return {
    operations,
    total: savedVotes.length,
    remaining: savedVotes.length - operations.length,
  };
}

type VoteStamp = Extract<BoardItem, { kind: "stamp" }>;
type CurrentVote = { column: number; stamp: VoteStamp };
type VoteAccumulator = {
  table: TableItem;
  options: Array<Omit<VoteOptionSummary, "count">>;
  stampIds: string[];
  currentByActor: Map<string, CurrentVote>;
};

function createVoteAccumulator(table: TableItem): VoteAccumulator {
  return {
    table,
    options: (table.geometry.cells[0] ?? []).map((label, column) => ({
      column,
      label: label.trim(),
    })),
    stampIds: [],
    currentByActor: new Map(),
  };
}

function recordStamp(accumulator: VoteAccumulator, stamp: VoteStamp, worldCenter: Point): void {
  const cell = tableCellAtWorldPoint(accumulator.table, worldCenter);
  if (cell?.row !== 1 || !accumulator.options[cell.column]) return;
  accumulator.stampIds.push(stamp.id);
  if (stamp.version <= 0 || stamp.createdBy.length === 0) return;
  const current = accumulator.currentByActor.get(stamp.createdBy);
  if (
    !current ||
    stamp.z > current.stamp.z ||
    (stamp.z === current.stamp.z && stamp.id.localeCompare(current.stamp.id) > 0)
  ) {
    accumulator.currentByActor.set(stamp.createdBy, { column: cell.column, stamp });
  }
}

function finishVoteSummary(accumulator: VoteAccumulator): VoteSummary {
  const options = accumulator.options.map((option) => ({ ...option, count: 0 }));
  for (const vote of accumulator.currentByActor.values()) {
    const option = options[vote.column];
    if (option) option.count += 1;
  }
  return { tableId: accumulator.table.id, options, stampIds: [...accumulator.stampIds] };
}

function tableCellAtWorldPoint(
  table: TableItem,
  point: Point,
): { row: number; column: number } | null {
  const local = inverseTransformPoint(point, table.transform);
  if (!local) return null;
  const column = axisIndex(local[0] - table.geometry.x, table.geometry.columnWidths);
  const row = axisIndex(local[1] - table.geometry.y, table.geometry.rowHeights);
  return row === null || column === null ? null : { row, column };
}

function transformPoint(point: Point, matrix: Matrix): Point {
  return [
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  ];
}

function inverseTransformPoint(point: Point, matrix: Matrix): Point | null {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(determinant) < 1e-12) return null;
  const x = point[0] - matrix[4];
  const y = point[1] - matrix[5];
  return [
    (matrix[3] * x - matrix[2] * y) / determinant,
    (-matrix[1] * x + matrix[0] * y) / determinant,
  ];
}

function axisIndex(position: number, sizes: readonly number[]): number | null {
  if (position < 0) return null;
  let edge = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    edge += sizes[index] ?? 0;
    if (position < edge || (index === sizes.length - 1 && position <= edge)) return index;
  }
  return null;
}
