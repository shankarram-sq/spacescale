export type BoardRole = "viewer" | "editor" | "owner";
export type AccessMode = "private" | "link_view";
export type DrawingPolicy = "editors_enabled" | "owner_only" | "locked";

export interface Env {
  ASSETS: Fetcher;
  BOARD_ROOMS: DurableObjectNamespace;
  BOARD_SNAPSHOTS: R2Bucket;
  WORKER_VERSION: WorkerVersionMetadata;
  APP_HOSTNAME: string;
  ENVIRONMENT?: string;
  SESSION_SIGNING_KEY_CURRENT: string;
  SESSION_SIGNING_KEY_PREVIOUS?: string;
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  BOARD_CREATION_ENABLED?: string;
}

export interface DeviceSession {
  actorId: string;
  issuedAt: number;
  expiresAt: number;
  keyVersion: "current" | "previous";
}

export interface InternalActorContext {
  actorId: string;
  sessionExpiresAt: number;
  requestId: string;
}

export interface SocketAttachment {
  v: 1;
  connectionId: string;
  actorId: string;
  displayName: string;
  role: BoardRole;
  aclVersion: number;
  sessionExpiresAt: number;
  clientInstanceId: string;
  connectedAt: number;
  state: "syncing" | "live";
}

export interface BoardRow {
  [key: string]: SqlStorageValue;
  public_id: string;
  title: string;
  access_mode: AccessMode;
  drawing_policy: DrawingPolicy;
  owner_actor_id: string;
  latest_seq: number;
  next_z: number;
  acl_version: number;
  min_replay_seq: number;
  latest_snapshot_seq: number;
  dirty_since_seq: number | null;
  dirty_since_at_ms: number | null;
  snapshot_live_item_count: number;
  snapshot_live_item_bytes: number;
  usage_checkpoint_seq: number;
  created_at_ms: number;
  updated_at_ms: number;
  archived_at_ms: number | null;
}

export interface MemberRow {
  [key: string]: SqlStorageValue;
  actor_id: string;
  role: BoardRole;
  display_name: string;
  revoked_at_ms: number | null;
}

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

export type ItemStyle = StrokeStyle | TextStyle;
export type Matrix = [number, number, number, number, number, number];

export type PencilGeometry = { points: Array<[number, number]> };
export type LineGeometry = { x1: number; y1: number; x2: number; y2: number };
export type BoxGeometry = { x: number; y: number; width: number; height: number };
export type TextGeometry = { x: number; y: number; text: string };
export type ItemGeometry = PencilGeometry | LineGeometry | BoxGeometry | TextGeometry;
export type BoardItemKind = "pencil" | "line" | "rectangle" | "ellipse" | "text";

export interface BoardItem {
  id: string;
  kind: BoardItemKind;
  z: number;
  version: number;
  createdBy: string;
  style: ItemStyle;
  transform: Matrix;
  geometry: ItemGeometry;
}

export type LogicalItemState = { exists: false } | { exists: true; item: BoardItem };

export interface ItemEffect {
  itemId: string;
  before: LogicalItemState;
  after: LogicalItemState;
  beforeStateToken: string;
  afterStateToken: string;
}

export interface StoredActionPayload {
  publicResult: ServerAction;
  effects: ItemEffect[];
}

export interface ServerAction {
  v: 1;
  t: "server.action";
  seq: number;
  acceptedAt: number;
  actor: { id: string; displayName: string };
  commandId: string;
  actionId: string;
  op: Record<string, unknown>;
}

export interface CanonicalSnapshot {
  format: "cf-whiteboard-json";
  version: 1;
  boardId: string;
  seq: number;
  createdAt: number;
  settings: { title: string };
  items: BoardItem[];
}

export interface ResolvedAccess {
  role: BoardRole;
  displayName: string;
  canView: boolean;
}
