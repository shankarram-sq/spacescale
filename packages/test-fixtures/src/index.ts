import { type BoardState, createBoardState } from "@collab/board-core";
import type {
  BoardItem,
  ClientCommitFrame,
  LineStyle,
  NewBoardItem,
  ServerActionFrame,
  StrokeStyle,
  TableStyle,
  TextStyle,
  ZoneStyle,
} from "@collab/protocol";

export const FIXTURE_IDS = {
  board: "018f0000-0000-7000-8000-0000000000ff",
  alice: "018f0000-0000-7000-8000-0000000000a1",
  bob: "018f0000-0000-7000-8000-0000000000b1",
  command1: "018f0000-0000-7000-8000-000000000c01",
  command2: "018f0000-0000-7000-8000-000000000c02",
  action1: "018f0000-0000-7000-8000-000000000a01",
  action2: "018f0000-0000-7000-8000-000000000a02",
  pencil: "018f0000-0000-7000-8000-000000000001",
  line: "018f0000-0000-7000-8000-000000000002",
  rectangle: "018f0000-0000-7000-8000-000000000003",
  ellipse: "018f0000-0000-7000-8000-000000000004",
  text: "018f0000-0000-7000-8000-000000000005",
  copy: "018f0000-0000-7000-8000-000000000006",
  sticky: "018f0000-0000-7000-8000-000000000007",
  stamp: "018f0000-0000-7000-8000-000000000008",
  image: "018f0000-0000-7000-8000-000000000009",
  table: "018f0000-0000-7000-8000-00000000000a",
  zone: "018f0000-0000-7000-8000-00000000000b",
  asset: "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
} as const;

export const FIXTURE_TIME = 1_785_840_000_000;

export function strokeStyle(overrides: Partial<StrokeStyle> = {}): StrokeStyle {
  return {
    kind: "stroke",
    color: "#336699",
    width: 4,
    opacity: 0.8,
    ...overrides,
  };
}

export function lineStyle(overrides: Partial<LineStyle> = {}): LineStyle {
  return {
    kind: "line",
    color: "#336699",
    width: 4,
    opacity: 0.8,
    arrowhead: "none",
    ...overrides,
  };
}

export function textStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    kind: "text",
    color: "#112233",
    fontSize: 24,
    fontFamily: "sans",
    opacity: 1,
    ...overrides,
  };
}

export function tableStyle(overrides: Partial<TableStyle> = {}): TableStyle {
  return {
    kind: "table",
    borderColor: "#94a3b8",
    fill: "#ffffff",
    headerFill: "#e2e8f0",
    textColor: "#0f172a",
    fontSize: 16,
    opacity: 1,
    ...overrides,
  };
}

export function zoneStyle(overrides: Partial<ZoneStyle> = {}): ZoneStyle {
  return {
    kind: "zone",
    borderColor: "#a8a59d",
    fill: "#e8edff",
    textColor: "#4f5b75",
    fontSize: 18,
    opacity: 0.18,
    ...overrides,
  };
}

export function newRectangleItem(overrides: Partial<NewBoardItem> = {}): NewBoardItem {
  return {
    id: FIXTURE_IDS.rectangle,
    kind: "rectangle",
    style: strokeStyle(),
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 10, y: 20, width: 100, height: 60 },
    ...overrides,
  } as NewBoardItem;
}

export function newPencilItem(overrides: Partial<NewBoardItem> = {}): NewBoardItem {
  return {
    id: FIXTURE_IDS.pencil,
    kind: "pencil",
    style: strokeStyle({ width: 3 }),
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      points: [
        [0, 0],
        [10, 4],
        [20, 12],
      ],
    },
    ...overrides,
  } as NewBoardItem;
}

export function newLineItem(overrides: Partial<NewBoardItem> = {}): NewBoardItem {
  return {
    id: FIXTURE_IDS.line,
    kind: "line",
    style: lineStyle({ arrowhead: "arrow" }),
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x1: 10, y1: 20, x2: 130, y2: 80 },
    ...overrides,
  } as NewBoardItem;
}

export function newTextItem(overrides: Partial<NewBoardItem> = {}): NewBoardItem {
  return {
    id: FIXTURE_IDS.text,
    kind: "text",
    style: textStyle(),
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 25, y: 40, text: "Fixture text" },
    ...overrides,
  } as NewBoardItem;
}

export function newStickyItem(overrides: Partial<NewBoardItem> = {}): NewBoardItem {
  return {
    id: FIXTURE_IDS.sticky,
    kind: "sticky",
    style: {
      kind: "sticky",
      fill: "#fff2a8",
      textColor: "#27231b",
      fontSize: 20,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 10, y: 20, width: 180, height: 140, text: "Fixture sticky" },
    ...overrides,
  } as NewBoardItem;
}

export function newStampItem(overrides: Partial<NewBoardItem> = {}): NewBoardItem {
  return {
    id: FIXTURE_IDS.stamp,
    kind: "stamp",
    style: { kind: "stamp", color: "#e11d48", opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 60, y: 70, size: 72, stamp: "heart" },
    ...overrides,
  } as NewBoardItem;
}

export function newImageItem(overrides: Partial<NewBoardItem> = {}): NewBoardItem {
  return {
    id: FIXTURE_IDS.image,
    kind: "image",
    style: { kind: "image", opacity: 1, radius: 12 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: 10,
      y: 20,
      width: 240,
      height: 160,
      assetId: FIXTURE_IDS.asset,
      alt: "Fixture image",
      mimeType: "image/png",
      intrinsicWidth: 1200,
      intrinsicHeight: 800,
    },
    ...overrides,
  } as NewBoardItem;
}

export function newTableItem(overrides: Partial<NewBoardItem> = {}): NewBoardItem {
  return {
    id: FIXTURE_IDS.table,
    kind: "table",
    style: tableStyle(),
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: 10,
      y: 20,
      columnWidths: [120, 120, 120],
      rowHeights: [48, 48, 48],
      cells: [
        ["Term", "Meaning", "Example"],
        ["", "", ""],
        ["", "", ""],
      ],
      headerRow: true,
    },
    ...overrides,
  } as NewBoardItem;
}

export function newZoneItem(overrides: Partial<NewBoardItem> = {}): NewBoardItem {
  return {
    id: FIXTURE_IDS.zone,
    kind: "zone",
    style: zoneStyle(),
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 10, y: 20, width: 520, height: 320, title: "Fixture zone" },
    ...overrides,
  } as NewBoardItem;
}

export function boardItem(
  item: NewBoardItem = newRectangleItem(),
  overrides: Partial<Pick<BoardItem, "z" | "version" | "createdBy">> = {},
): BoardItem {
  return {
    ...item,
    z: overrides.z ?? 1,
    version: overrides.version ?? 1,
    createdBy: overrides.createdBy ?? FIXTURE_IDS.alice,
  } as BoardItem;
}

export function boardState(items: readonly BoardItem[] = [boardItem()]): BoardState {
  const seq = items.reduce((maximum, item) => Math.max(maximum, item.version), 0);
  return createBoardState({ seq, items });
}

export function createCommitFrame(
  item: NewBoardItem = newRectangleItem(),
  overrides: Partial<Pick<ClientCommitFrame, "commandId" | "actionId" | "baseSeq">> = {},
): ClientCommitFrame {
  return {
    v: 1,
    t: "client.commit",
    commandId: overrides.commandId ?? FIXTURE_IDS.command1,
    actionId: overrides.actionId ?? FIXTURE_IDS.action1,
    baseSeq: overrides.baseSeq ?? 0,
    op: { kind: "item.create", item },
  };
}

export function serverCreateAction(
  item: BoardItem = boardItem(),
  overrides: Partial<Pick<ServerActionFrame, "seq" | "acceptedAt" | "commandId" | "actionId">> = {},
): ServerActionFrame {
  return {
    v: 1,
    t: "server.action",
    seq: overrides.seq ?? item.version,
    acceptedAt: overrides.acceptedAt ?? FIXTURE_TIME,
    actor: { id: item.createdBy, displayName: "Alice" },
    commandId: overrides.commandId ?? FIXTURE_IDS.command1,
    actionId: overrides.actionId ?? FIXTURE_IDS.action1,
    op: { kind: "item.create", item },
  };
}
