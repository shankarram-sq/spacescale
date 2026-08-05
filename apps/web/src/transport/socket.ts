import type {
  CommitFrame,
  ConnectionPhase,
  DrawingPolicy,
  HistoryState,
  Presence,
  RemotePreview,
  Role,
  ServerAction,
  ServerFrame,
  ToolName,
} from "../types";
import { PROTOCOL_VERSION } from "../types";

type WelcomeState = {
  role: Role;
  drawingPolicy: DrawingPolicy;
  aclVersion: number;
  historyVersion: number;
  sessionExpiresAt: number;
  canUndo: boolean;
  canRedo: boolean;
};

export type SocketHooks = {
  getSequence: () => number;
  onPhase: (phase: ConnectionPhase) => void;
  onWelcome: (state: WelcomeState) => void;
  onAction: (action: ServerAction, replay: boolean) => void;
  onReady: () => void;
  onRejected: (frame: ServerFrame) => void;
  onHistory: (state: HistoryState) => void;
  onAccessChanged: (frame: ServerFrame) => void;
  onOwnerRecovery: (token: string, aclVersion: number) => void;
  onPreview: (preview: RemotePreview | null, cancelKey?: string) => void;
  onPresence: (presences: Presence[], replace: boolean) => void;
  onResync: (reason: string) => Promise<void>;
  onNotice: (message: string, kind?: "info" | "warning" | "error") => void;
  refreshSession: () => Promise<void>;
};

const BACKOFF_MS = [0, 250, 500, 1_000, 2_000, 5_000];
export const PROTOCOL_RELOAD_NOTICE =
  "This board was updated and this tab is no longer compatible. Reload the page to continue.";

export class BoardSocket {
  readonly clientInstanceId = crypto.randomUUID();

  private socket: WebSocket | null = null;
  private phaseValue: ConnectionPhase = "idle";
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private syncTimer: number | null = null;
  private expiryTimer: number | null = null;
  private stableConnectionTimer: number | null = null;
  private stopped = false;
  private resyncing = false;
  private generation = 0;
  private lastPresenceCursor: { x: number; y: number } | null = null;

  constructor(
    private readonly boardId: string,
    private readonly hooks: SocketHooks,
    private readonly authorizationToken: string | null = null,
  ) {
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  get phase(): ConnectionPhase {
    return this.phaseValue;
  }

  get ready(): boolean {
    return this.phaseValue === "ready" && this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.stopped || this.resyncing) return;
    this.clearReconnect();
    const generation = ++this.generation;
    this.setPhase("connecting");
    const url = new URL(
      `/api/v1/boards/${encodeURIComponent(this.boardId)}/socket`,
      window.location.href,
    );
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("since", String(this.hooks.getSequence()));
    url.searchParams.set("client", this.clientInstanceId);

    const socket = this.authorizationToken
      ? new WebSocket(url, ["whiteboard.v1", `auth.${this.authorizationToken}`])
      : new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      this.setPhase("syncing");
    });
    socket.addEventListener("message", (event) => {
      if (generation !== this.generation) return;
      this.receive(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.stopSyncChecks();
      this.clearStableConnectionTimer();
      if (this.stopped || this.resyncing) return;
      if (event.code === 1002) {
        this.stop(PROTOCOL_RELOAD_NOTICE, "reload_required");
        return;
      }
      if (event.code === 4009) {
        void this.resync("The server requested an authoritative reload.");
        return;
      }
      if (event.code === 4011) {
        this.stop("This board has been archived.", "archived");
        return;
      }
      if (event.code === 4003 || event.code === 4010) {
        this.stop("Your access to this board was removed.");
        return;
      }
      if (event.code === 4001) {
        void this.refreshAndReconnect();
        return;
      }
      this.setPhase("offline");
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // Browsers intentionally expose no useful WebSocket error detail. The
      // close event drives the reconnect path.
    });
  }

  stop(
    message?: string,
    terminalPhase: "stopped" | "archived" | "reload_required" = "stopped",
  ): void {
    this.stopped = true;
    this.generation += 1;
    this.clearReconnect();
    this.stopSyncChecks();
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.clearStableConnectionTimer();
    this.socket?.close(1000, "client stopped");
    this.socket = null;
    this.setPhase(terminalPhase);
    if (message) this.hooks.onNotice(message, "error");
  }

  destroy(): void {
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  sendCommit(command: CommitFrame): boolean {
    return this.send(command, true);
  }

  sendPreview(
    gestureId: string,
    previewSeq: number,
    kind:
      | "pencil.start"
      | "pencil.segment"
      | "shape.geometry"
      | "selection.transform"
      | "gesture.cancel",
    payload: Record<string, unknown> = {},
  ): boolean {
    return this.send(
      { v: PROTOCOL_VERSION, t: "client.preview", gestureId, previewSeq, kind, payload },
      true,
    );
  }

  sendPresence(cursor: { x: number; y: number } | null, activeTool: ToolName): boolean {
    if (document.hidden) return false;
    if (cursor) this.lastPresenceCursor = cursor;
    if (!this.lastPresenceCursor) return false;
    return this.send(
      { v: PROTOCOL_VERSION, t: "client.presence", cursor: this.lastPresenceCursor, activeTool },
      true,
    );
  }

  resynchronize(reason = "Reloading authoritative board state."): void {
    void this.resync(reason);
  }

  private send(frame: Record<string, unknown>, requireReady: boolean): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (requireReady && this.phaseValue !== "ready") return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") {
      this.socket?.close(1003, "binary frames are unsupported");
      return;
    }
    let frame: ServerFrame;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed) || typeof parsed.t !== "string" || parsed.v !== PROTOCOL_VERSION) {
        throw new Error("Invalid frame envelope.");
      }
      frame = parsed as ServerFrame;
    } catch {
      this.socket?.close(1002, "invalid server frame");
      return;
    }

    switch (frame.t) {
      case "server.welcome": {
        const state = welcomeState(frame);
        if (!state) {
          this.socket?.close(1002, "invalid welcome");
          return;
        }
        this.hooks.onWelcome(state);
        this.scheduleSessionRefresh(state.sessionExpiresAt);
        break;
      }
      case "server.replay": {
        const fromExclusive = number(frame.fromExclusive);
        const toInclusive = number(frame.toInclusive);
        const actions = Array.isArray(frame.actions) ? frame.actions : null;
        if (
          fromExclusive === null ||
          toInclusive === null ||
          !actions ||
          fromExclusive !== this.hooks.getSequence()
        ) {
          void this.resync("The replay stream was not contiguous.");
          return;
        }
        for (const value of actions) {
          const action = asServerAction(value);
          if (!action || action.seq !== this.hooks.getSequence() + 1) {
            void this.resync("The replay stream contained a sequence gap.");
            return;
          }
          this.hooks.onAction(action, true);
        }
        if (this.hooks.getSequence() !== toInclusive) {
          void this.resync("The replay high-water mark did not match its actions.");
        }
        break;
      }
      case "server.action": {
        const action = asServerAction(frame);
        if (!action) {
          void this.resync("The server sent an invalid action.");
          return;
        }
        this.hooks.onAction(action, false);
        break;
      }
      case "server.ready": {
        const latestSeq = number(frame.latestSeq);
        if (latestSeq === null || latestSeq !== this.hooks.getSequence()) {
          void this.resync("The ready high-water mark did not match local board state.");
          return;
        }
        this.setPhase("ready");
        this.startSyncChecks();
        this.clearStableConnectionTimer();
        this.stableConnectionTimer = window.setTimeout(() => {
          this.reconnectAttempt = 0;
          this.stableConnectionTimer = null;
        }, 10_000);
        this.hooks.onReady();
        break;
      }
      case "server.rejected":
        if (frame.reloadRequired === true) {
          this.stop(PROTOCOL_RELOAD_NOTICE, "reload_required");
          return;
        }
        this.hooks.onRejected(frame);
        break;
      case "server.history_state": {
        const historyVersion = number(frame.historyVersion);
        if (historyVersion !== null) {
          this.hooks.onHistory({
            historyVersion,
            canUndo: frame.canUndo === true,
            canRedo: frame.canRedo === true,
          });
        }
        break;
      }
      case "access.changed":
      case "server.access_changed":
        this.hooks.onAccessChanged(frame);
        break;
      case "server.owner_recovery": {
        const token = string(frame.ownerRecoveryToken);
        const aclVersion = number(frame.aclVersion);
        if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token) || aclVersion === null) {
          this.hooks.onNotice("The server sent an invalid owner recovery link.", "error");
          break;
        }
        this.hooks.onOwnerRecovery(token, aclVersion);
        break;
      }
      case "server.preview":
      case "server.gesture_preview":
        this.receivePreview(frame);
        break;
      case "server.presence":
      case "server.presence.joined":
      case "server.presence.left":
      case "server.presence_state":
        this.receivePresence(frame);
        break;
      case "server.previews_cleared":
        if (typeof frame.actorId === "string") this.hooks.onPreview(null, `actor:${frame.actorId}`);
        break;
      case "server.resync_required":
        void this.resync(
          typeof frame.message === "string" ? frame.message : "The board needs to reload.",
        );
        break;
      case "server.in_sync":
        break;
      default:
        // Unknown server frames are ignored for forward compatibility. Client
        // frame types remain strict at the authoritative boundary.
        break;
    }
  }

  private receivePreview(frame: ServerFrame): void {
    const actorValue = isRecord(frame.actor) ? frame.actor : null;
    const actorId = typeof actorValue?.id === "string" ? actorValue.id : string(frame.actorId);
    const actorName =
      typeof actorValue?.displayName === "string"
        ? actorValue.displayName
        : (string(frame.displayName) ?? "Guest");
    const gestureId = string(frame.gestureId);
    const kind = string(frame.kind);
    if (!actorId || !gestureId || !kind) return;
    const key = `${string(frame.connectionId) ?? actorId}:${gestureId}`;
    if (kind === "gesture.cancel") {
      this.hooks.onPreview(null, key);
      return;
    }
    if (!["pencil.start", "pencil.segment", "shape.geometry", "selection.transform"].includes(kind))
      return;
    this.hooks.onPreview({
      key,
      actorId,
      actorName,
      gestureId,
      kind: kind as RemotePreview["kind"],
      payload: isRecord(frame.payload) ? frame.payload : {},
      updatedAt: Date.now(),
    });
  }

  private receivePresence(frame: ServerFrame): void {
    if (Array.isArray(frame.participants)) {
      const values = frame.participants.flatMap((value) => {
        const presence = asPresence(value);
        return presence ? [presence] : [];
      });
      this.hooks.onPresence(values, true);
      return;
    }
    const presence = asPresence(frame.participant ?? frame);
    if (!presence) return;
    if (frame.t === "server.presence.left") presence.cursor = null;
    this.hooks.onPresence([presence], false);
  }

  private setPhase(phase: ConnectionPhase): void {
    if (this.phaseValue === phase) return;
    this.phaseValue = phase;
    this.hooks.onPhase(phase);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.resyncing || this.reconnectTimer !== null) return;
    const base = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)] ?? 5_000;
    const jitter = base === 0 ? 0 : base * (Math.random() * 0.4 - 0.2);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(
      () => {
        this.reconnectTimer = null;
        this.connect();
      },
      Math.max(0, base + jitter),
    );
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startSyncChecks(): void {
    this.stopSyncChecks();
    if (document.hidden) return;
    this.syncTimer = window.setInterval(() => {
      this.send(
        { v: PROTOCOL_VERSION, t: "client.sync_check", latestSeq: this.hooks.getSequence() },
        true,
      );
    }, 30_000);
  }

  private stopSyncChecks(): void {
    if (this.syncTimer !== null) window.clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  private clearStableConnectionTimer(): void {
    if (this.stableConnectionTimer !== null) window.clearTimeout(this.stableConnectionTimer);
    this.stableConnectionTimer = null;
  }

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.stopSyncChecks();
      return;
    }
    if (this.ready) {
      this.startSyncChecks();
      this.send(
        { v: PROTOCOL_VERSION, t: "client.sync_check", latestSeq: this.hooks.getSequence() },
        true,
      );
    }
  };

  private scheduleSessionRefresh(expiresAt: number): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    const delay = Math.max(1_000, Math.min(2_147_000_000, expiresAt - Date.now() - 60_000));
    this.expiryTimer = window.setTimeout(() => void this.refreshAndReconnect(), delay);
  }

  private async refreshAndReconnect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.hooks.refreshSession();
    } catch {
      this.stop("Your session could not be renewed. Reload to try again.");
      return;
    }
    this.socket?.close(1000, "refreshing session");
    this.socket = null;
    this.setPhase("offline");
    this.scheduleReconnect();
  }

  private async resync(reason: string): Promise<void> {
    if (this.resyncing || this.stopped) return;
    this.resyncing = true;
    this.generation += 1;
    this.socket?.close(1000, "resynchronizing");
    this.socket = null;
    this.stopSyncChecks();
    this.setPhase("syncing");
    try {
      await this.hooks.onResync(reason);
      this.resyncing = false;
      this.connect();
    } catch {
      this.resyncing = false;
      this.setPhase("offline");
      this.scheduleReconnect();
    }
  }
}

function welcomeState(frame: ServerFrame): WelcomeState | null {
  const actor = isRecord(frame.actor) ? frame.actor : null;
  const role = frame.role ?? actor?.role;
  const policy = frame.drawingPolicy;
  const aclVersion = number(frame.aclVersion);
  const historyVersion = number(frame.historyVersion);
  const sessionExpiresAt = number(frame.sessionExpiresAt);
  if (
    (role !== "viewer" && role !== "editor" && role !== "owner") ||
    (policy !== "editors_enabled" && policy !== "owner_only" && policy !== "locked") ||
    aclVersion === null ||
    historyVersion === null ||
    sessionExpiresAt === null
  ) {
    return null;
  }
  return {
    role,
    drawingPolicy: policy,
    aclVersion,
    historyVersion,
    sessionExpiresAt,
    canUndo: frame.canUndo === true,
    canRedo: frame.canRedo === true,
  };
}

function asServerAction(value: unknown): ServerAction | null {
  if (!isRecord(value)) return null;
  const seq = number(value.seq);
  if (
    value.v !== PROTOCOL_VERSION ||
    value.t !== "server.action" ||
    seq === null ||
    typeof value.commandId !== "string" ||
    typeof value.actionId !== "string" ||
    !isRecord(value.actor) ||
    typeof value.actor.id !== "string" ||
    typeof value.actor.displayName !== "string" ||
    !isRecord(value.op)
  ) {
    return null;
  }
  return value as unknown as ServerAction;
}

function asPresence(value: unknown): Presence | null {
  if (!isRecord(value)) return null;
  const actor = isRecord(value.actor) ? value.actor : value;
  const id = string(actor.id) ?? string(value.actorId);
  const displayName = string(actor.displayName) ?? string(value.displayName);
  if (!id || !displayName) return null;
  let cursor: Presence["cursor"] = null;
  if (isRecord(value.cursor)) {
    const x = number(value.cursor.x);
    const y = number(value.cursor.y);
    if (x !== null && y !== null) cursor = { x, y };
  }
  const activeTool = string(value.activeTool);
  return {
    id,
    displayName,
    connectionId: string(value.connectionId) ?? undefined,
    role:
      value.role === "owner" || value.role === "editor" || value.role === "viewer"
        ? value.role
        : undefined,
    cursor,
    activeTool:
      activeTool &&
      ["select", "pencil", "line", "rectangle", "ellipse", "text", "eraser", "pan"].includes(
        activeTool,
      )
        ? (activeTool as ToolName)
        : undefined,
    color: string(value.color) ?? undefined,
    updatedAt: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
