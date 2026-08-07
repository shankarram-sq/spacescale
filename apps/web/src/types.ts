import { PROTOCOL_VERSION as SHARED_PROTOCOL_VERSION } from "@collab/protocol";

export const PROTOCOL_VERSION = SHARED_PROTOCOL_VERSION;

export type Role = "viewer" | "editor" | "owner";
export type DrawingPolicy = "editors_enabled" | "owner_only" | "locked";
export type AccessMode = "private" | "link_view";
export type ToolName =
  | "select"
  | "pencil"
  | "line"
  | "rectangle"
  | "ellipse"
  | "text"
  | "sticky"
  | "stamp"
  | "image"
  | "table"
  | "eraser"
  | "pan";

export type Point = readonly [number, number];
export type Matrix = readonly [number, number, number, number, number, number];

export type StrokeStyle = {
  kind: "stroke";
  color: string;
  width: number;
  opacity: number;
};

export type TextStyle = {
  kind: "text";
  color: string;
  fontSize: number;
  opacity: number;
};

export type StickyStyle = {
  kind: "sticky";
  fill: string;
  textColor: string;
  fontSize: number;
  opacity: number;
};

export type StampKind = "star" | "check" | "heart" | "question" | "smile" | "sparkle";

export type StampStyle = {
  kind: "stamp";
  color: string;
  opacity: number;
};

export type ImageStyle = {
  kind: "image";
  opacity: number;
  radius: number;
};

export type TableStyle = {
  kind: "table";
  borderColor: string;
  fill: string;
  headerFill: string;
  textColor: string;
  fontSize: number;
  opacity: number;
};

export type ItemStyle =
  | StrokeStyle
  | TextStyle
  | StickyStyle
  | StampStyle
  | ImageStyle
  | TableStyle;
export type PencilGeometry = { points: Point[] };
export type LineGeometry = { x1: number; y1: number; x2: number; y2: number };
export type BoxGeometry = { x: number; y: number; width: number; height: number };
export type TextGeometry = { x: number; y: number; text: string };
export type StickyGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
};
export type StampGeometry = { x: number; y: number; size: number; stamp: StampKind };

export type ImageGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  assetId: string;
  alt?: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  intrinsicWidth: number;
  intrinsicHeight: number;
};

export type TableGeometry = {
  x: number;
  y: number;
  columnWidths: number[];
  rowHeights: number[];
  cells: string[][];
  headerRow?: boolean;
};

type ItemBase = {
  id: string;
  z: number;
  version: number;
  createdBy: string;
  transform: Matrix;
};

export type PencilItem = ItemBase & {
  kind: "pencil";
  style: StrokeStyle;
  geometry: PencilGeometry;
};
export type LineItem = ItemBase & {
  kind: "line";
  style: StrokeStyle;
  geometry: LineGeometry;
};
export type RectangleItem = ItemBase & {
  kind: "rectangle";
  style: StrokeStyle;
  geometry: BoxGeometry;
};
export type EllipseItem = ItemBase & {
  kind: "ellipse";
  style: StrokeStyle;
  geometry: BoxGeometry;
};
export type TextItem = ItemBase & {
  kind: "text";
  style: TextStyle;
  geometry: TextGeometry;
};
export type StickyItem = ItemBase & {
  kind: "sticky";
  style: StickyStyle;
  geometry: StickyGeometry;
};
export type StampItem = ItemBase & {
  kind: "stamp";
  style: StampStyle;
  geometry: StampGeometry;
};
export type ImageItem = ItemBase & {
  kind: "image";
  style: ImageStyle;
  geometry: ImageGeometry;
};
export type TableItem = ItemBase & {
  kind: "table";
  style: TableStyle;
  geometry: TableGeometry;
};
export type BoardItem =
  | PencilItem
  | LineItem
  | RectangleItem
  | EllipseItem
  | TextItem
  | StickyItem
  | StampItem
  | ImageItem
  | TableItem;

type WithoutServerFields<T> = T extends BoardItem ? Omit<T, "z" | "version" | "createdBy"> : never;
export type NewBoardItem = WithoutServerFields<BoardItem>;
export type ItemPatch = {
  style?: ItemStyle;
  transform?: Matrix;
  geometry?:
    | PencilGeometry
    | LineGeometry
    | BoxGeometry
    | TextGeometry
    | StickyGeometry
    | StampGeometry
    | ImageGeometry
    | TableGeometry;
};

export type BatchItemOperation =
  | { kind: "item.create"; item: NewBoardItem }
  | { kind: "item.update"; itemId: string; expectedVersion: number; patch: ItemPatch }
  | { kind: "item.delete"; itemId: string; expectedVersion: number }
  | {
      kind: "item.copy";
      sourceItemId: string;
      expectedVersion: number;
      newItemId: string;
      translate: { x: number; y: number };
    };

export type DurableOperation =
  | BatchItemOperation
  | { kind: "items.batch"; operations: BatchItemOperation[] }
  | { kind: "history.undo"; expectedHistoryVersion: number; targetActionId?: string }
  | { kind: "history.redo"; expectedHistoryVersion: number; targetActionId?: string }
  | { kind: "board.clear"; expectedBoardSeq: number };

export type CommitFrame = {
  v: typeof PROTOCOL_VERSION;
  t: "client.commit";
  commandId: string;
  actionId: string;
  baseSeq: number;
  op: DurableOperation;
};

export type Actor = { id: string; displayName: string };

export type CanonicalOperation = DurableOperation & {
  item?: BoardItem;
  items?: BoardItem[];
  replacements?: BoardItem[];
  removedItemIds?: string[];
};

export type ServerAction = {
  v: typeof PROTOCOL_VERSION;
  t: "server.action";
  seq: number;
  acceptedAt: number;
  actor: Actor;
  commandId: string;
  actionId: string;
  op: CanonicalOperation;
};

export type BoardSnapshot = {
  format: "cf-whiteboard-json";
  version: 1;
  boardId?: string;
  seq: number;
  createdAt?: number;
  settings?: { title?: string };
  items: BoardItem[];
};

export type Bootstrap = {
  protocolVersion: 1;
  board: {
    id: string;
    title: string;
    accessMode: AccessMode;
    drawingPolicy: DrawingPolicy;
    imagesEnabled: boolean;
    aclVersion: number;
    latestSeq: number;
    snapshotSeq: number;
  };
  actor: Actor & {
    role: Role;
    historyVersion: number;
    sessionExpiresAt: number;
    canUndo?: boolean;
    canRedo?: boolean;
  };
  limits: {
    maxConnections: number;
    maxItems: number;
    maxBatchItems: number;
    maxStrokePoints: number;
    previewHz: number;
  };
  snapshot: BoardSnapshot | { url: string; seq: number; format?: string; version?: number };
};

export type Member = Actor & { role: Role; connected?: boolean; primaryOwner?: boolean };
export type Presence = Actor & {
  connectionId?: string;
  role?: Role;
  cursor?: { x: number; y: number } | null;
  activeTool?: ToolName;
  color?: string;
  updatedAt: number;
};

export type SpotlightViewState = {
  center: { x: number; y: number };
  zoom: number;
};

export type ClientSpotlightFrame =
  | {
      v: typeof PROTOCOL_VERSION;
      t: "client.facilitation.spotlight";
      spotlightId: string;
      active: true;
      viewport: SpotlightViewState;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      t: "client.facilitation.spotlight";
      spotlightId: string;
      active: false;
    };

type SpotlightFrameBase = {
  v: typeof PROTOCOL_VERSION;
  t: "server.facilitation.spotlight";
  spotlightId: string;
  actor: Actor;
  connectionId: string;
};

export type SpotlightFrame =
  | (SpotlightFrameBase & { active: true; viewport: SpotlightViewState })
  | (SpotlightFrameBase & { active: false });

export type HistoryState = {
  historyVersion: number;
  canUndo: boolean;
  canRedo: boolean;
};

export type RemotePreview = {
  key: string;
  actorId: string;
  actorName: string;
  gestureId: string;
  kind: "pencil.start" | "pencil.segment" | "shape.geometry" | "selection.transform";
  payload: Record<string, unknown>;
  updatedAt: number;
};

export type ConnectionPhase =
  | "idle"
  | "connecting"
  | "syncing"
  | "ready"
  | "offline"
  | "stopped"
  | "archived"
  | "reload_required";

export type ServerFrame = { v: number; t: string; [key: string]: unknown };

export function canRoleDraw(role: Role, policy: DrawingPolicy): boolean {
  if (policy === "locked" || role === "viewer") return false;
  if (policy === "owner_only") return role === "owner";
  return role === "owner" || role === "editor";
}

export function createId(): string {
  return crypto.randomUUID();
}

export function roundBoard(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isBoardItem(value: unknown): value is BoardItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BoardItem>;
  return (
    typeof item.id === "string" &&
    typeof item.kind === "string" &&
    [
      "pencil",
      "line",
      "rectangle",
      "ellipse",
      "text",
      "sticky",
      "stamp",
      "image",
      "table",
    ].includes(item.kind) &&
    typeof item.z === "number" &&
    typeof item.version === "number" &&
    Array.isArray(item.transform) &&
    item.transform.length === 6 &&
    !!item.style &&
    !!item.geometry
  );
}
