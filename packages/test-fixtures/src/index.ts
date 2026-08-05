import { type BoardState, createBoardState } from "@collab/board-core";
import type {
  BoardItem,
  ClientCommitFrame,
  NewBoardItem,
  ServerActionFrame,
  StrokeStyle,
  TextStyle,
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

export function textStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    kind: "text",
    color: "#112233",
    fontSize: 24,
    opacity: 1,
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
