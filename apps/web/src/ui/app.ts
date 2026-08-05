import { validateClientFrame, validateDurableOperation } from "@collab/protocol";
import { BoardModel, SequenceError } from "../board/model";
import { BoardRenderer } from "../board/renderer";
import { DurableOutbox, type OutboxEntry, OutboxLimitError } from "../persistence/outbox";
import {
  buildCapturedTextUpdate,
  type CapturedTextEdit,
  ToolController,
} from "../tools/controller";
import {
  type ApiClient,
  ApiError,
  type FragmentClaim,
  type ManagedInvitation,
  type RecoverySnapshot,
} from "../transport/api";
import { BoardSocket } from "../transport/socket";
import type {
  AccessMode,
  BoardItem,
  BoardSnapshot,
  Bootstrap,
  CommitFrame,
  ConnectionPhase,
  DrawingPolicy,
  DurableOperation,
  HistoryState,
  Member,
  Point,
  Presence,
  RemotePreview,
  ServerAction,
  ServerFrame,
  ToolName,
} from "../types";
import { canRoleDraw, createId, PROTOCOL_VERSION } from "../types";

const TOOL_DEFINITIONS: Array<{ name: ToolName; label: string; shortcut: string; glyph: string }> =
  [
    { name: "select", label: "Select and move", shortcut: "V", glyph: "↖" },
    { name: "pencil", label: "Pencil", shortcut: "P", glyph: "✎" },
    { name: "line", label: "Straight line", shortcut: "L", glyph: "╱" },
    { name: "rectangle", label: "Rectangle", shortcut: "R", glyph: "□" },
    { name: "ellipse", label: "Ellipse", shortcut: "O", glyph: "○" },
    { name: "text", label: "Text", shortcut: "T", glyph: "T" },
    { name: "eraser", label: "Eraser", shortcut: "E", glyph: "◇" },
    { name: "pan", label: "Pan canvas", shortcut: "H", glyph: "✋" },
  ];

const DRAW_TOOLS = new Set<ToolName>(["pencil", "line", "rectangle", "ellipse", "text", "eraser"]);

type StyleState = { color: string; width: number; opacity: number; fontSize: number };

export class BoardApp {
  private readonly model = new BoardModel();
  private readonly outbox = new DurableOutbox();
  private readonly renderer: BoardRenderer;
  private readonly tools: ToolController;
  private readonly socket: BoardSocket;
  private bootstrap: Bootstrap;
  private phase: ConnectionPhase = "idle";
  private history: HistoryState;
  private style: StyleState = { color: "#20201e", width: 4, opacity: 1, fontSize: 28 };
  private readonly remotePreviews = new Map<string, RemotePreview>();
  private readonly presences = new Map<string, Presence>();
  private expiredRecovery: OutboxEntry[] = [];
  private previewExpiryTimer: number;
  private textEditor: HTMLTextAreaElement | null = null;
  private textEditorTimer: number | null = null;
  private textEditContext: CapturedTextEdit | null = null;
  private accessMembers: Member[] = [];
  private managedInvitations: ManagedInvitation[];
  private recoverySnapshots: RecoverySnapshot[] = [];
  private outboxAvailable = true;
  private optimisticRecovery = false;
  private archivePending = false;

  private readonly titleInput: HTMLInputElement;
  private readonly saveStatus: HTMLElement;
  private readonly saveStatusText: HTMLElement;
  private readonly participantCount: HTMLElement;
  private readonly participantDrawer: HTMLElement;
  private readonly participantList: HTMLElement;
  private readonly accessButton: HTMLButtonElement;
  private readonly accessDrawer: HTMLElement;
  private readonly accessBody: HTMLElement;
  private readonly stylePopover: HTMLElement;
  private readonly exportMenu: HTMLElement;
  private readonly selectionActions: HTMLElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly archivedBanner: HTMLElement;
  private readonly recoveryBanner: HTMLElement;
  private readonly toastRegion: HTMLElement;
  private readonly liveRegion: HTMLElement;
  private readonly zoomLabel: HTMLElement;

  private constructor(
    private readonly root: HTMLElement,
    private readonly api: ApiClient,
    bootstrap: Bootstrap,
  ) {
    this.bootstrap = bootstrap;
    this.managedInvitations = loadManagedInvitations(bootstrap.board.id);
    this.history = {
      historyVersion: bootstrap.actor.historyVersion,
      canUndo: bootstrap.actor.canUndo ?? false,
      canRedo: bootstrap.actor.canRedo ?? false,
    };
    const snapshot = bootstrap.snapshot as BoardSnapshot;
    this.model.load(snapshot);
    this.buildShell();

    this.titleInput = query(this.root, "[data-testid='board-title']", HTMLInputElement);
    this.saveStatus = query(this.root, "[data-testid='save-status']", HTMLElement);
    this.saveStatusText = query(this.root, "[data-save-status-text]", HTMLElement);
    this.participantCount = query(this.root, "[data-participant-count]", HTMLElement);
    this.participantDrawer = query(this.root, "[data-testid='participant-drawer']", HTMLElement);
    this.participantList = query(this.root, "[data-participant-list]", HTMLElement);
    this.accessButton = query(this.root, "[data-testid='access-button']", HTMLButtonElement);
    this.accessDrawer = query(this.root, "[data-testid='access-drawer']", HTMLElement);
    this.accessBody = query(this.root, "[data-access-body]", HTMLElement);
    this.stylePopover = query(this.root, "[data-testid='style-popover']", HTMLElement);
    this.exportMenu = query(this.root, "[data-testid='export-menu']", HTMLElement);
    this.selectionActions = query(this.root, "[data-testid='selection-actions']", HTMLElement);
    this.undoButton = query(this.root, "[data-testid='undo-button']", HTMLButtonElement);
    this.redoButton = query(this.root, "[data-testid='redo-button']", HTMLButtonElement);
    this.archivedBanner = query(this.root, "[data-testid='archived-banner']", HTMLElement);
    this.recoveryBanner = query(this.root, "[data-testid='recovery-banner']", HTMLElement);
    this.toastRegion = query(this.root, "[data-testid='toast-region']", HTMLElement);
    this.liveRegion = query(this.root, "[data-testid='live-region']", HTMLElement);
    this.zoomLabel = query(this.root, "[data-zoom-label]", HTMLElement);

    this.titleInput.value = bootstrap.board.title;
    this.renderer = new BoardRenderer(
      query(this.root, "[data-canvas-host]", HTMLElement),
      this.model,
    );
    this.renderer.viewport.subscribe((zoom) => {
      this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    });
    this.tools = new ToolController({
      model: this.model,
      renderer: this.renderer,
      canDraw: () => this.canCommit(),
      getStyle: () => this.style,
      commit: (operation, actionId) => this.commit(operation, actionId),
      preview: (gestureId, previewSeq, kind, payload) =>
        this.socket.sendPreview(gestureId, previewSeq, kind, payload),
      presence: (cursor, tool) => {
        this.socket.sendPresence(cursor, tool);
      },
      editText: (point, item) => this.openTextEditor(point, item),
      onToolChanged: (tool) => this.setActiveToolButton(tool),
      onSelectionChanged: (ids) => this.updateSelectionActions(ids),
      notify: (message, kind) => this.notify(message, kind),
    });

    this.socket = new BoardSocket(bootstrap.board.id, {
      getSequence: () => this.model.lastAppliedSeq,
      onPhase: (phase) => {
        this.phase = phase;
        if (phase === "archived") this.enterArchivedState();
        this.updatePermissions();
      },
      onWelcome: (state) => {
        this.bootstrap.actor.role = state.role;
        this.bootstrap.actor.sessionExpiresAt = state.sessionExpiresAt;
        this.bootstrap.board.drawingPolicy = state.drawingPolicy;
        this.bootstrap.board.aclVersion = state.aclVersion;
        this.history.historyVersion = state.historyVersion;
        this.history.canUndo = state.canUndo;
        this.history.canRedo = state.canRedo;
        this.updatePermissions();
      },
      onAction: (action, replay) => this.handleAction(action, replay),
      onReady: () => {
        this.flushOutbox();
        this.socket.sendPresence(null, this.tools.tool);
      },
      onRejected: (frame) => this.handleRejection(frame),
      onHistory: (state) => {
        this.history = state;
        this.updateHistoryControls();
      },
      onAccessChanged: (frame) => this.handleAccessChanged(frame),
      onOwnerRecovery: (token, aclVersion) => this.handleOwnerRecovery(token, aclVersion),
      onPreview: (preview, cancelKey) => this.handlePreview(preview, cancelKey),
      onPresence: (presences, replace) => this.handlePresence(presences, replace),
      onResync: (reason) => this.resync(reason),
      onNotice: (message, kind) => this.notify(message, kind),
      refreshSession: () => this.api.ensureSession(),
    });

    this.bindShellEvents();
    this.model.subscribe(() => this.updateStatus());
    this.model.subscribeRebase((error) => this.handleRebaseState(error));
    this.presences.set(bootstrap.actor.id, {
      ...bootstrap.actor,
      role: bootstrap.actor.role,
      updatedAt: Date.now(),
    });
    this.previewExpiryTimer = window.setInterval(() => this.expireEphemeralState(), 1_000);
  }

  static async mount(root: HTMLElement, api: ApiClient, bootstrap: Bootstrap): Promise<BoardApp> {
    const app = new BoardApp(root, api, bootstrap);
    await app.restoreOutbox();
    app.updateAll();
    app.socket.connect();
    return app;
  }

  destroy(): void {
    window.clearInterval(this.previewExpiryTimer);
    if (this.textEditorTimer !== null) window.clearTimeout(this.textEditorTimer);
    this.socket.destroy();
    this.tools.destroy();
    this.renderer.destroy();
    window.removeEventListener("keydown", this.onGlobalKeyDown);
  }

  private buildShell(): void {
    this.root.innerHTML = `
      <div class="workspace" data-testid="board-shell">
        <header class="topbar">
          <a class="wordmark" href="/" aria-label="Commonspace home">
            <span class="brand-mark" aria-hidden="true">C</span>
            <span class="wordmark-text">Commonspace</span>
          </a>
          <label class="board-title-wrap">
            <span class="sr-only">Board title</span>
            <input class="board-title" data-testid="board-title" maxlength="100" autocomplete="off" />
          </label>
          <div class="topbar-actions">
            <div class="history-controls" aria-label="Board history">
              <button class="icon-button" type="button" data-testid="undo-button" aria-label="Undo (Control or Command Z)" title="Undo · Ctrl/⌘ Z">↶</button>
              <button class="icon-button" type="button" data-testid="redo-button" aria-label="Redo (Control or Command Shift Z)" title="Redo · Ctrl/⌘ Shift Z">↷</button>
            </div>
            <div class="save-status" data-testid="save-status" role="status" aria-live="polite">
              <span class="status-dot" aria-hidden="true"></span>
              <span data-save-status-text>Connecting…</span>
            </div>
            <button class="topbar-button people-button" type="button" data-testid="participants-button" aria-controls="participant-drawer" aria-expanded="false">
              <span class="avatar-stack" aria-hidden="true"><i></i><i></i></span>
              <span data-participant-count>1</span>
              <span class="wide-label">here</span>
            </button>
            <button class="topbar-button" type="button" data-testid="access-button" aria-controls="access-drawer" aria-expanded="false">Share</button>
            <div class="menu-wrap">
              <button class="icon-button" type="button" data-testid="export-button" aria-label="Export board" aria-controls="export-menu" aria-expanded="false" title="Export">↓</button>
              <div class="floating-menu export-menu" data-testid="export-menu" id="export-menu" hidden>
                <p class="menu-eyebrow">Download current board</p>
                <a data-export-svg download href="/api/v1/boards/${encodeURIComponent(this.bootstrap.board.id)}/export.svg">SVG image <span>authoritative</span></a>
                <a data-export-json download href="/api/v1/boards/${encodeURIComponent(this.bootstrap.board.id)}/export.json">Canonical JSON <span>authoritative</span></a>
                <button type="button" data-local-svg>Local SVG <span>includes pending edits</span></button>
                <button type="button" data-local-json>Local recovery JSON <span>includes outbox</span></button>
              </div>
            </div>
          </div>
        </header>

        <div class="archived-banner" data-testid="archived-banner" role="status" aria-live="polite" hidden>
          <strong>Board archived</strong>
          <span>This board is permanently read only. Existing access and invitation links can no longer open it.</span>
        </div>

        <main class="board-stage">
          <nav class="tool-rail" aria-label="Drawing tools" data-testid="tool-rail"></nav>
          <section class="canvas-wrap" data-canvas-host>
            <p class="sr-only" id="canvas-help">Use the tool rail to draw. Hold Space to pan. Scroll or pinch to zoom.</p>
            <div class="canvas-hint" data-canvas-hint aria-hidden="true">Drag anywhere to begin</div>
            <div class="selection-actions" data-testid="selection-actions" hidden>
              <button type="button" data-selection-copy aria-label="Copy selected items">Copy</button>
              <button type="button" data-selection-delete aria-label="Delete selected items">Delete</button>
            </div>
            <div class="zoom-controls" aria-label="Canvas zoom">
              <button type="button" data-zoom-out aria-label="Zoom out">−</button>
              <button type="button" data-zoom-reset aria-label="Reset zoom"><span data-zoom-label>100%</span></button>
              <button type="button" data-zoom-in aria-label="Zoom in">+</button>
              <button type="button" data-zoom-fit aria-label="Fit drawing to view" title="Fit drawing">⌗</button>
            </div>
          </section>
        </main>

        <div class="style-wrap">
          <button class="style-trigger" type="button" data-testid="style-button" aria-label="Open drawing style" aria-controls="style-popover" aria-expanded="false">
            <span class="style-swatch" data-style-swatch aria-hidden="true"></span>
            <span class="style-width" data-style-width aria-hidden="true"></span>
          </button>
          <section class="style-popover" data-testid="style-popover" id="style-popover" aria-label="Drawing style" hidden>
            <div class="popover-heading"><strong>Style</strong><span>New marks</span></div>
            <fieldset class="color-fieldset">
              <legend>Colour</legend>
              <div class="color-grid" data-color-grid></div>
              <label class="custom-color" title="Custom colour"><span class="sr-only">Custom colour</span><input type="color" value="#20201e" data-style-color /></label>
            </fieldset>
            <label class="range-row"><span>Stroke</span><output data-width-output>4</output><input type="range" min="1" max="32" value="4" step="1" data-style-stroke /></label>
            <label class="range-row"><span>Opacity</span><output data-opacity-output>100%</output><input type="range" min="10" max="100" value="100" step="5" data-style-opacity /></label>
            <label class="range-row"><span>Text</span><output data-font-output>28</output><input type="range" min="8" max="96" value="28" step="1" data-style-font /></label>
          </section>
        </div>

        <aside class="side-drawer participant-drawer" id="participant-drawer" data-testid="participant-drawer" aria-label="Participants" hidden>
          <div class="drawer-heading"><div><span class="eyebrow">Live room</span><h2>Participants</h2></div><button type="button" data-close-drawer aria-label="Close participants">×</button></div>
          <div class="participant-list" data-participant-list></div>
        </aside>

        <aside class="side-drawer access-drawer" id="access-drawer" data-testid="access-drawer" aria-label="Board access" hidden>
          <div class="drawer-heading"><div><span class="eyebrow">Owner controls</span><h2>Share & access</h2></div><button type="button" data-close-drawer aria-label="Close access panel">×</button></div>
          <div data-access-body></div>
        </aside>

        <div class="recovery-banner" data-testid="recovery-banner" hidden>
          <div><strong data-recovery-title>Unsaved recovery data</strong><span data-recovery-message>Some commands are too old to resend safely.</span></div>
          <button type="button" data-recovery-download>Download JSON</button>
          <button type="button" data-recovery-discard hidden>Discard unsaved edits</button>
          <button type="button" data-recovery-dismiss aria-label="Dismiss recovery notice">×</button>
        </div>

        <div class="toast-region" data-testid="toast-region" aria-label="Notifications"></div>
        <div class="sr-only" data-testid="live-region" aria-live="assertive"></div>
      </div>
    `;

    const rail = query(this.root, "[data-testid='tool-rail']", HTMLElement);
    for (const definition of TOOL_DEFINITIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tool = definition.name;
      button.dataset.testid = `tool-${definition.name}`;
      button.setAttribute("aria-label", `${definition.label} (${definition.shortcut})`);
      button.setAttribute("aria-pressed", definition.name === "pencil" ? "true" : "false");
      button.title = `${definition.label} · ${definition.shortcut}`;
      const glyph = document.createElement("span");
      glyph.className = `tool-glyph tool-glyph-${definition.name}`;
      glyph.textContent = definition.glyph;
      const key = document.createElement("kbd");
      key.textContent = definition.shortcut;
      button.append(glyph, key);
      rail.append(button);
    }
    const divider = document.createElement("span");
    divider.className = "tool-divider";
    divider.setAttribute("aria-hidden", "true");
    rail.append(divider);
    const styleShortcut = document.createElement("button");
    styleShortcut.type = "button";
    styleShortcut.dataset.openStyle = "true";
    styleShortcut.setAttribute("aria-label", "Drawing style");
    styleShortcut.innerHTML = '<span class="rail-color-dot" aria-hidden="true"></span><kbd>S</kbd>';
    rail.append(styleShortcut);

    const palette = [
      "#20201e",
      "#e5484d",
      "#f97316",
      "#d4a72c",
      "#30a46c",
      "#0d9488",
      "#3e63dd",
      "#8e4ec6",
    ];
    const colorGrid = query(this.root, "[data-color-grid]", HTMLElement);
    palette.forEach((color) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "color-choice";
      button.dataset.color = color;
      button.setAttribute("aria-label", `Use ${color}`);
      button.setAttribute("aria-pressed", String(color === this.style.color));
      button.style.setProperty("--choice-color", color);
      colorGrid.append(button);
    });
  }

  private bindShellEvents(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      button.addEventListener("click", () => this.tools.setTool(button.dataset.tool as ToolName));
    }
    const toggleStyle = (): void =>
      this.togglePopover(
        this.stylePopover,
        query(this.root, "[data-testid='style-button']", HTMLButtonElement),
      );
    query(this.root, "[data-testid='style-button']", HTMLButtonElement).addEventListener(
      "click",
      toggleStyle,
    );
    query(this.root, "[data-open-style]", HTMLButtonElement).addEventListener("click", toggleStyle);

    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      button.addEventListener("click", () => {
        this.style.color = button.dataset.color ?? this.style.color;
        this.updateStyleControls();
      });
    }
    const color = query(this.root, "[data-style-color]", HTMLInputElement);
    color.addEventListener("input", () => {
      this.style.color = color.value.toLowerCase();
      this.updateStyleControls();
    });
    const stroke = query(this.root, "[data-style-stroke]", HTMLInputElement);
    stroke.addEventListener("input", () => {
      this.style.width = Number(stroke.value);
      this.updateStyleControls();
    });
    const opacity = query(this.root, "[data-style-opacity]", HTMLInputElement);
    opacity.addEventListener("input", () => {
      this.style.opacity = Number(opacity.value) / 100;
      this.updateStyleControls();
    });
    const font = query(this.root, "[data-style-font]", HTMLInputElement);
    font.addEventListener("input", () => {
      this.style.fontSize = Number(font.value);
      this.updateStyleControls();
    });

    this.undoButton.addEventListener("click", () => void this.undo());
    this.redoButton.addEventListener("click", () => void this.redo());
    query(this.root, "[data-selection-copy]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.tools.copySelection(),
    );
    query(this.root, "[data-selection-delete]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.tools.deleteSelection(),
    );

    query(this.root, "[data-testid='participants-button']", HTMLButtonElement).addEventListener(
      "click",
      (event) => {
        this.toggleDrawer(this.participantDrawer, event.currentTarget as HTMLButtonElement);
        this.renderParticipants();
      },
    );
    this.accessButton.addEventListener("click", () => {
      this.toggleDrawer(this.accessDrawer, this.accessButton);
      if (!this.accessDrawer.hidden) void this.loadAccessPanel();
    });
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-close-drawer]")) {
      button.addEventListener("click", () => this.closeDrawers());
    }

    const exportButton = query(this.root, "[data-testid='export-button']", HTMLButtonElement);
    exportButton.addEventListener("click", () => this.togglePopover(this.exportMenu, exportButton));
    query(this.root, "[data-local-json]", HTMLButtonElement).addEventListener("click", () =>
      this.downloadLocalJson(),
    );
    query(this.root, "[data-local-svg]", HTMLButtonElement).addEventListener("click", () =>
      this.downloadLocalSvg(),
    );

    query(this.root, "[data-zoom-out]", HTMLButtonElement).addEventListener("click", () =>
      this.zoomBy(0.8),
    );
    query(this.root, "[data-zoom-in]", HTMLButtonElement).addEventListener("click", () =>
      this.zoomBy(1.25),
    );
    query(this.root, "[data-zoom-reset]", HTMLButtonElement).addEventListener("click", () =>
      this.renderer.viewport.reset(),
    );
    query(this.root, "[data-zoom-fit]", HTMLButtonElement).addEventListener("click", () =>
      this.renderer.viewport.fit(this.model.boundsFor(this.model.items.keys())),
    );

    this.titleInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.titleInput.blur();
      }
      if (event.key === "Escape") {
        this.titleInput.value = this.bootstrap.board.title;
        this.titleInput.blur();
      }
    });
    this.titleInput.addEventListener("change", () => void this.updateTitle());

    query(this.root, "[data-recovery-download]", HTMLButtonElement).addEventListener("click", () =>
      this.downloadLocalJson(),
    );
    query(this.root, "[data-recovery-discard]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.discardFailedOptimisticEdits(),
    );
    query(this.root, "[data-recovery-dismiss]", HTMLButtonElement).addEventListener("click", () => {
      if (!this.optimisticRecovery) this.recoveryBanner.hidden = true;
    });
    window.addEventListener("keydown", this.onGlobalKeyDown);
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (
        !this.stylePopover.hidden &&
        !this.stylePopover.contains(target) &&
        !query(this.root, "[data-testid='style-button']", HTMLElement).contains(target)
      ) {
        this.stylePopover.hidden = true;
      }
      if (
        !this.exportMenu.hidden &&
        !this.exportMenu.contains(target) &&
        !exportButton.contains(target)
      ) {
        this.exportMenu.hidden = true;
        exportButton.setAttribute("aria-expanded", "false");
      }
    });
  }

  private async restoreOutbox(): Promise<void> {
    try {
      const contents = await this.outbox.contents(this.bootstrap.board.id);
      this.expiredRecovery = contents.expired;
      for (const entry of contents.active) {
        try {
          const frame = validateClientFrame(entry.command);
          if (frame.t !== "client.commit") throw new Error("Outbox entry is not a commit.");
          this.model.restoreQueued(frame as CommitFrame, this.bootstrap.actor.id);
        } catch {
          this.expiredRecovery.push(entry);
        }
      }
      this.syncRecoveryBanner();
    } catch {
      this.outboxAvailable = false;
      this.notify(
        "This browser could not open its recovery queue. Editing is disabled for safety.",
        "error",
      );
      this.phase = "stopped";
    }
  }

  private handleRebaseState(error: Error | null): void {
    const wasRecovering = this.optimisticRecovery;
    this.optimisticRecovery = error !== null;
    this.syncRecoveryBanner();
    this.updatePermissions();
    if (error && !wasRecovering) {
      this.notify(
        "Unsaved edits no longer apply cleanly to the shared board. They remain in this browser’s recovery queue.",
        "error",
      );
      this.socket.resynchronize("Refreshing the board before recovering unsaved edits.");
    }
  }

  private syncRecoveryBanner(): void {
    const title = query(this.recoveryBanner, "[data-recovery-title]", HTMLElement);
    const message = query(this.recoveryBanner, "[data-recovery-message]", HTMLElement);
    const discard = query(this.recoveryBanner, "[data-recovery-discard]", HTMLButtonElement);
    const dismiss = query(this.recoveryBanner, "[data-recovery-dismiss]", HTMLButtonElement);
    if (this.optimisticRecovery) {
      title.textContent = "Unsaved edits need recovery";
      message.textContent =
        "They are still stored locally. Download a copy, or explicitly discard all unsaved edits.";
      discard.hidden = false;
      dismiss.hidden = true;
    } else {
      title.textContent = "Unsaved recovery data";
      message.textContent = "Some commands are too old to resend safely.";
      discard.hidden = true;
      dismiss.hidden = false;
    }
    this.recoveryBanner.hidden = !this.optimisticRecovery && this.expiredRecovery.length === 0;
  }

  private async discardFailedOptimisticEdits(): Promise<void> {
    if (!this.optimisticRecovery) return;
    const commands = this.model.pendingCommands;
    if (commands.length === 0) return;
    if (
      !confirm(
        `Discard all ${commands.length} unsaved edit${commands.length === 1 ? "" : "s"}? Download recovery JSON first if you may need them.`,
      )
    ) {
      return;
    }
    try {
      await this.outbox.removeMany(commands.map((command) => command.commandId));
      this.model.discardOptimistic();
      this.notify("Unsaved edits were discarded. The shared board is unchanged.", "info");
    } catch {
      this.notify(
        "The recovery queue could not be cleared, so no unsaved edits were discarded.",
        "error",
      );
    }
  }

  private async commit(operation: DurableOperation, actionId = createId()): Promise<boolean> {
    if (!this.canCommit()) {
      this.notify(
        this.phase === "ready"
          ? "Drawing is read only."
          : "Wait for the board to reconnect before editing.",
        "warning",
      );
      return false;
    }
    const commandId = createId();
    let normalizedOperation: DurableOperation;
    try {
      normalizedOperation = validateDurableOperation(operation) as DurableOperation;
    } catch {
      this.notify("That gesture could not be converted into a valid board edit.", "error");
      return false;
    }
    const command: CommitFrame = {
      v: PROTOCOL_VERSION,
      t: "client.commit",
      commandId,
      actionId,
      baseSeq: this.model.lastAppliedSeq,
      op: normalizedOperation,
    };
    try {
      await this.outbox.put(this.bootstrap.board.id, command);
    } catch (error) {
      if (error instanceof OutboxLimitError) {
        this.recoveryBanner.hidden = false;
        this.notify(`${error.message} Download a recovery copy before continuing.`, "error");
      } else {
        this.notify("The edit could not be added to the durable recovery queue.", "error");
      }
      return false;
    }
    this.model.queue(command, this.bootstrap.actor.id);
    this.updateStatus();
    this.socket.sendCommit(command);
    return true;
  }

  private handleAction(action: ServerAction, replay: boolean): void {
    this.clearPreviewForGesture(action.actionId);
    if (action.seq <= this.model.lastAppliedSeq) {
      const pending = this.model.pendingCommands.some(
        (command) => command.commandId === action.commandId,
      );
      if (pending) {
        this.model.reject(action.commandId);
        void this.outbox.remove(action.commandId);
        this.updateStatus();
        return;
      }
      if (this.model.hasSeenAction(action.seq, action.commandId)) return;
      this.socket.resynchronize("A duplicate authoritative sequence did not match local history.");
      return;
    }
    try {
      const result = this.model.applyAction(action);
      this.bootstrap.board.latestSeq = action.seq;
      if (result.acknowledged) void this.outbox.remove(action.commandId);
      if (!replay && action.actor.id !== this.bootstrap.actor.id) {
        this.liveRegion.textContent = `${action.actor.displayName} updated the board.`;
      }
      query(this.root, "[data-canvas-hint]", HTMLElement).hidden = this.model.items.size > 0;
      this.updateStatus();
    } catch (error) {
      if (error instanceof SequenceError) {
        this.socket.resynchronize(error.message);
      } else {
        this.socket.resynchronize("The board could not apply an authoritative action.");
      }
    }
  }

  private handleRejection(frame: ServerFrame): void {
    const commandId = typeof frame.commandId === "string" ? frame.commandId : null;
    const code = typeof frame.code === "string" ? frame.code : "REJECTED";
    if (commandId) {
      this.model.reject(commandId);
      void this.outbox.remove(commandId);
    }
    if (code === "STALE_HISTORY" && typeof frame.historyVersion === "number") {
      this.history = {
        historyVersion: frame.historyVersion,
        canUndo: frame.canUndo === true,
        canRedo: frame.canRedo === true,
      };
      this.updateHistoryControls();
    }
    if (code === "REPLAY_UNAVAILABLE" || code === "STALE_BOARD") {
      this.socket.resynchronize(
        typeof frame.message === "string" ? frame.message : "The board changed; reloading it.",
      );
      return;
    }
    const friendly: Record<string, string> = {
      STALE_ITEM: "That item changed before your edit was saved.",
      UNDO_CONFLICT: "Undo stopped because a collaborator changed that item.",
      UNDO_EMPTY: "There is nothing left to undo.",
      REDO_EMPTY: "There is nothing to redo.",
      RATE_LIMITED: "You’re drawing a little too quickly. Try again in a moment.",
      TEMPORARILY_UNAVAILABLE: "The room is busy, so that edit was not saved.",
      FORBIDDEN: "Your drawing permission changed before that edit was saved.",
    };
    this.notify(
      friendly[code] ??
        (typeof frame.message === "string" ? frame.message : "The edit was not saved."),
      code === "UNDO_EMPTY" || code === "REDO_EMPTY" ? "info" : "warning",
    );
    this.updateStatus();
  }

  private handleAccessChanged(frame: ServerFrame): void {
    const access = isRecord(frame.access) ? frame.access : frame;
    if (access.role === "viewer" || access.role === "editor" || access.role === "owner")
      this.bootstrap.actor.role = access.role;
    if (
      access.drawingPolicy === "locked" ||
      access.drawingPolicy === "owner_only" ||
      access.drawingPolicy === "editors_enabled"
    ) {
      this.bootstrap.board.drawingPolicy = access.drawingPolicy;
    }
    if (access.accessMode === "private" || access.accessMode === "link_view")
      this.bootstrap.board.accessMode = access.accessMode;
    if (typeof access.aclVersion === "number") this.bootstrap.board.aclVersion = access.aclVersion;
    if (!canRoleDraw(this.bootstrap.actor.role, this.bootstrap.board.drawingPolicy))
      this.tools.setTool("select");
    this.updatePermissions();
  }

  private handleOwnerRecovery(token: string, aclVersion: number): void {
    this.bootstrap.actor.role = "owner";
    this.bootstrap.board.aclVersion = aclVersion;
    this.updatePermissions();
    this.showTransferredOwnerRecovery(token);
  }

  private handlePreview(preview: RemotePreview | null, cancelKey?: string): void {
    if (cancelKey?.startsWith("actor:")) {
      const actorId = cancelKey.slice("actor:".length);
      for (const [key, value] of this.remotePreviews) {
        if (value.actorId === actorId) this.remotePreviews.delete(key);
      }
    } else if (cancelKey) {
      this.remotePreviews.delete(cancelKey);
    }
    if (preview) {
      if (preview.kind === "pencil.start" && Array.isArray(preview.payload.point)) {
        preview.payload = { ...preview.payload, points: [preview.payload.point] };
      }
      const existing = this.remotePreviews.get(preview.key);
      if (existing && preview.kind === "pencil.segment") {
        const previousPoints = Array.isArray(existing.payload.points)
          ? existing.payload.points
          : [];
        const nextPoints = Array.isArray(preview.payload.points) ? preview.payload.points : [];
        preview.payload = {
          ...existing.payload,
          ...preview.payload,
          points: [...previousPoints, ...nextPoints.slice(1)],
        };
      }
      this.remotePreviews.set(preview.key, preview);
    }
    this.renderer.renderRemotePreviews(this.remotePreviews.values());
  }

  private handlePresence(values: Presence[], replace: boolean): void {
    if (replace) {
      this.presences.clear();
    }
    for (const presence of values) {
      const key = presence.connectionId ?? presence.id;
      if (presence.cursor === null && values.length === 1 && !replace) this.presences.delete(key);
      else this.presences.set(key, presence);
    }
    if (![...this.presences.values()].some((presence) => presence.id === this.bootstrap.actor.id)) {
      this.presences.set(this.bootstrap.actor.id, {
        ...this.bootstrap.actor,
        role: this.bootstrap.actor.role,
        updatedAt: Date.now(),
      });
    }
    this.renderParticipants();
    this.renderer.renderPresence(this.presences.values(), this.bootstrap.actor.id);
  }

  private async resync(reason: string): Promise<void> {
    this.notify(reason, "info");
    const next = await this.api.bootstrap(this.bootstrap.board.id);
    const contents = await this.outbox.contents(next.board.id);
    const activeCommands: CommitFrame[] = [];
    for (const entry of contents.active) {
      try {
        const frame = validateClientFrame(entry.command);
        if (frame.t !== "client.commit") throw new Error("Outbox entry is not a commit.");
        activeCommands.push(frame as CommitFrame);
      } catch {
        contents.expired.push(entry);
      }
    }
    this.bootstrap = next;
    this.model.load(next.snapshot as BoardSnapshot, true);
    for (const command of activeCommands) this.model.restoreQueued(command, next.actor.id);
    this.expiredRecovery = contents.expired;
    this.syncRecoveryBanner();
    this.history = {
      historyVersion: next.actor.historyVersion,
      canUndo: next.actor.canUndo ?? false,
      canRedo: next.actor.canRedo ?? false,
    };
    this.titleInput.value = next.board.title;
    this.updateAll();
  }

  private flushOutbox(): void {
    if (this.optimisticRecovery) {
      this.updateStatus();
      return;
    }
    for (const command of this.model.pendingCommands) this.socket.sendCommit(command);
    this.updateStatus();
  }

  private async undo(): Promise<void> {
    if (!this.history.canUndo || !this.canCommit()) return;
    await this.commit({
      kind: "history.undo",
      expectedHistoryVersion: this.history.historyVersion,
    });
  }

  private async redo(): Promise<void> {
    if (!this.history.canRedo || !this.canCommit()) return;
    await this.commit({
      kind: "history.redo",
      expectedHistoryVersion: this.history.historyVersion,
    });
  }

  private readonly onGlobalKeyDown = (event: KeyboardEvent): void => {
    if (isEditingTarget(event.target) || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) void this.redo();
      else void this.undo();
    } else if (key === "y" && !event.metaKey) {
      event.preventDefault();
      void this.redo();
    }
  };

  private openTextEditor(point: Point, item?: BoardItem): void {
    if (!this.canCommit()) return;
    this.closeTextEditor(false);
    const style = this.style;
    const textItem = item?.kind === "text" ? item : undefined;
    this.textEditContext = textItem
      ? {
          itemId: textItem.id,
          expectedVersion: textItem.version,
          geometry: structuredClone(textItem.geometry),
        }
      : null;
    const textPoint: Point = textItem ? [textItem.geometry.x, textItem.geometry.y] : point;
    const client = this.renderer.viewport.boardToClient(textPoint);
    const editor = document.createElement("textarea");
    editor.className = "canvas-text-editor";
    editor.dataset.testid = "canvas-text-editor";
    editor.setAttribute("aria-label", textItem ? "Edit text" : "Add text");
    editor.maxLength = 5_000;
    editor.rows = 2;
    editor.value = textItem?.geometry.text ?? "";
    editor.dataset.boardX = String(textPoint[0]);
    editor.dataset.boardY = String(textPoint[1]);
    editor.placeholder = "Type something";
    editor.style.left = `${Math.min(window.innerWidth - 170, Math.max(8, client[0]))}px`;
    editor.style.top = `${Math.min(window.innerHeight - 100, Math.max(60, client[1] - (textItem?.style.fontSize ?? style.fontSize)))}px`;
    editor.style.fontSize = `${Math.max(14, Math.min(48, (textItem?.style.fontSize ?? style.fontSize) * this.renderer.viewport.zoom))}px`;
    editor.style.color = textItem?.style.color ?? style.color;
    document.body.append(editor);
    this.textEditor = editor;

    const preview = (): void => {
      this.renderer.showLocalText(
        textPoint,
        editor.value,
        textItem?.style ?? { color: style.color, fontSize: style.fontSize, opacity: style.opacity },
        textItem?.transform,
      );
    };
    const schedule = (): void => {
      preview();
      if (this.textEditorTimer !== null) window.clearTimeout(this.textEditorTimer);
      this.textEditorTimer = window.setTimeout(() => void this.closeTextEditor(true), 500);
    };
    editor.addEventListener("input", schedule);
    editor.addEventListener("blur", () => void this.closeTextEditor(true));
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeTextEditor(false);
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.closeTextEditor(true);
      }
    });
    preview();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  private async closeTextEditor(save: boolean): Promise<void> {
    const editor = this.textEditor;
    if (!editor) return;
    const context = this.textEditContext;
    this.textEditor = null;
    this.textEditContext = null;
    if (this.textEditorTimer !== null) window.clearTimeout(this.textEditorTimer);
    this.textEditorTimer = null;
    const value = editor.value;
    editor.remove();
    this.renderer.clearLocalPreview();
    if (!save || !value) return;

    if (context) {
      await this.commit(buildCapturedTextUpdate(context, value));
      return;
    }

    const point: Point = [Number(editor.dataset.boardX), Number(editor.dataset.boardY)];
    await this.commit({
      kind: "item.create",
      item: {
        id: createId(),
        kind: "text",
        style: {
          kind: "text",
          color: this.style.color,
          fontSize: this.style.fontSize,
          opacity: this.style.opacity,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: point[0], y: point[1], text: value },
      },
    });
  }

  private async updateTitle(): Promise<void> {
    if (this.bootstrap.actor.role !== "owner" || this.phase === "archived" || this.archivePending) {
      this.titleInput.value = this.bootstrap.board.title;
      return;
    }
    const title = this.titleInput.value.trim();
    if (!title || title === this.bootstrap.board.title) {
      this.titleInput.value = this.bootstrap.board.title;
      return;
    }
    try {
      const result = await this.api.updateSettings(
        this.bootstrap.board.id,
        { title },
        this.bootstrap.board.aclVersion,
      );
      this.bootstrap.board.title = title;
      this.adoptAclVersion(result);
      document.title = `${title} — Commonspace`;
    } catch (error) {
      this.titleInput.value = this.bootstrap.board.title;
      this.apiError(error);
    }
  }

  private async loadAccessPanel(): Promise<void> {
    if (this.bootstrap.actor.role !== "owner") return;
    this.accessBody.replaceChildren(loadingBlock("Loading access…"));
    try {
      [this.accessMembers, this.recoverySnapshots] = await Promise.all([
        this.api.members(this.bootstrap.board.id),
        this.api.snapshots(this.bootstrap.board.id),
      ]);
      this.renderAccessPanel();
    } catch (error) {
      this.accessBody.replaceChildren(errorBlock("Access controls could not be loaded."));
      this.apiError(error);
    }
  }

  private renderAccessPanel(): void {
    this.accessBody.replaceChildren();

    const section = document.createElement("section");
    section.className = "access-section";
    section.innerHTML = `
      <h3>Who can draw now</h3>
      <div class="segmented-control" data-policy-controls aria-label="Drawing policy">
        <button type="button" data-policy="editors_enabled">Editors</button>
        <button type="button" data-policy="owner_only">Owner only</button>
        <button type="button" data-policy="locked">Locked</button>
      </div>
      <label class="field-row"><span>Board link</span><select data-access-mode aria-label="Board link access"><option value="link_view">Anyone with link can view</option><option value="private">Members only</option></select></label>
    `;
    for (const button of section.querySelectorAll<HTMLButtonElement>("[data-policy]")) {
      const selected = button.dataset.policy === this.bootstrap.board.drawingPolicy;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener(
        "click",
        () => void this.setPolicy(button.dataset.policy as DrawingPolicy),
      );
    }
    const accessMode = query(section, "[data-access-mode]", HTMLSelectElement);
    accessMode.value = this.bootstrap.board.accessMode;
    accessMode.addEventListener(
      "change",
      () => void this.setAccessMode(accessMode.value as AccessMode),
    );
    this.accessBody.append(section);

    const inviteSection = document.createElement("section");
    inviteSection.className = "access-section";
    inviteSection.innerHTML = `
      <h3>Invite people</h3>
      <form class="invite-form" data-invite-form>
        <label><span>Role</span><select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>
        <label><span>Link uses</span><select name="maxUses"><option value="1">One person</option><option value="20">Session link · 20</option><option value="50">Session link · 50</option></select></label>
        <label class="full-field"><span>Label <i>optional</i></span><input name="label" maxlength="80" placeholder="e.g. Design team" /></label>
        <button class="primary-button full-field" type="submit">Create invite link</button>
      </form>
      <div class="one-time-secret" data-invite-result hidden></div>
    `;
    query(inviteSection, "[data-invite-form]", HTMLFormElement).addEventListener(
      "submit",
      (event) => void this.createInvitation(event),
    );
    if (this.managedInvitations.length > 0) {
      const managedHeading = document.createElement("h4");
      managedHeading.textContent = "Created in this browser session";
      managedHeading.className = "subsection-heading";
      const managedList = document.createElement("div");
      managedList.className = "management-list";
      managedList.dataset.managedInvitations = "true";
      for (const invitation of this.managedInvitations) {
        managedList.append(this.invitationRow(invitation));
      }
      inviteSection.append(managedHeading, managedList);
    }
    this.accessBody.append(inviteSection);

    const membersSection = document.createElement("section");
    membersSection.className = "access-section";
    const heading = document.createElement("div");
    heading.className = "section-heading";
    const title = document.createElement("h3");
    title.textContent = "Members";
    const count = document.createElement("span");
    count.textContent = String(this.accessMembers.length);
    heading.append(title, count);
    membersSection.append(heading);
    const list = document.createElement("div");
    list.className = "member-list";
    for (const member of this.accessMembers) list.append(this.memberRow(member));
    membersSection.append(list);
    this.accessBody.append(membersSection);

    const snapshotSection = document.createElement("section");
    snapshotSection.className = "access-section";
    snapshotSection.innerHTML = `
      <div class="section-heading"><h3>Recovery points</h3><span>${this.recoverySnapshots.length}</span></div>
      <p class="section-note">Snapshots restore drawing content as a new board action. Access and ownership are unchanged.</p>
      <form class="snapshot-form" data-snapshot-form>
        <label><span>Snapshot name</span><input name="label" maxlength="80" required placeholder="Before workshop" /></label>
        <button class="primary-button" type="submit">Save recovery point</button>
      </form>
    `;
    query(snapshotSection, "[data-snapshot-form]", HTMLFormElement).addEventListener(
      "submit",
      (event) => void this.createNamedSnapshot(event),
    );
    const snapshotList = document.createElement("div");
    snapshotList.className = "management-list snapshot-list";
    snapshotList.dataset.snapshotList = "true";
    if (this.recoverySnapshots.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-management-list";
      empty.textContent = "No recovery points have been stored yet.";
      snapshotList.append(empty);
    } else {
      for (const snapshot of this.recoverySnapshots)
        snapshotList.append(this.snapshotRow(snapshot));
    }
    snapshotSection.append(snapshotList);
    this.accessBody.append(snapshotSection);

    const safety = document.createElement("section");
    safety.className = "access-section safety-section";
    safety.innerHTML = `
      <h3>Recovery & board</h3>
      <p>Recovery links are shown once. Store yours somewhere private.</p>
      <button type="button" data-rotate-recovery>Rotate recovery link</button>
      <button class="danger-button" type="button" data-clear-board>Clear board</button>
      <div class="archive-danger-zone">
        <strong>Archive permanently</strong>
        <p>Archiving cannot be undone. The board becomes read only, and its existing access and invitation links stop opening it.</p>
        <button class="danger-button" type="button" data-archive-board>Archive board</button>
        <small>Available only when the board is connected and every edit is saved.</small>
      </div>
      <div class="one-time-secret" data-recovery-result hidden></div>
    `;
    query(safety, "[data-rotate-recovery]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.rotateRecovery(),
    );
    query(safety, "[data-clear-board]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.clearBoard(),
    );
    const archiveButton = query(safety, "[data-archive-board]", HTMLButtonElement);
    archiveButton.disabled = !this.canArchiveBoard();
    archiveButton.addEventListener("click", () => void this.archiveBoard());
    this.accessBody.append(safety);
  }

  private memberRow(member: Member): HTMLElement {
    const row = document.createElement("div");
    row.className = "member-row";
    const identity = document.createElement("div");
    identity.className = "member-identity";
    const avatar = document.createElement("span");
    avatar.className = "participant-avatar";
    avatar.textContent = initials(member.displayName);
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    const meta = document.createElement("small");
    meta.textContent =
      member.id === this.bootstrap.actor.id ? "You" : member.connected ? "Online" : "Member";
    text.append(name, meta);
    identity.append(avatar, text);
    row.append(identity);

    if (member.role === "owner") {
      const owner = document.createElement("span");
      owner.className = "role-pill";
      owner.textContent = "Owner";
      row.append(owner);
      return row;
    }
    const actions = document.createElement("div");
    actions.className = "member-actions";
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Role for ${member.displayName}`);
    select.innerHTML =
      '<option value="editor">Editor</option><option value="viewer">Viewer</option>';
    select.value = member.role;
    select.addEventListener(
      "change",
      () => void this.changeMemberRole(member, select.value as "editor" | "viewer"),
    );
    actions.append(select);
    if (member.role === "editor") {
      const transfer = document.createElement("button");
      transfer.type = "button";
      transfer.className = "make-owner";
      transfer.setAttribute("aria-label", `Make ${member.displayName} the board owner`);
      transfer.title = "Transfer ownership";
      transfer.textContent = "Owner";
      transfer.addEventListener("click", () => void this.transferOwnership(member));
      actions.append(transfer);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-member";
    remove.setAttribute("aria-label", `Remove ${member.displayName}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => void this.revokeMember(member));
    actions.append(remove);
    row.append(actions);
    return row;
  }

  private invitationRow(invitation: ManagedInvitation): HTMLElement {
    const row = document.createElement("div");
    row.className = "management-row";
    row.dataset.invitationId = invitation.id;
    const summary = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = invitation.label ?? `${invitation.role} invitation`;
    const metadata = document.createElement("small");
    metadata.textContent = `${invitation.role} · ${invitation.maxUses} use${invitation.maxUses === 1 ? "" : "s"} · expires ${formatDateTime(invitation.expiresAt)}`;
    summary.append(label, metadata);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "danger-text-button";
    revoke.textContent = "Revoke";
    revoke.setAttribute("aria-label", `Revoke ${label.textContent}`);
    revoke.addEventListener("click", () => void this.revokeInvitation(invitation));
    row.append(summary, revoke);
    return row;
  }

  private snapshotRow(snapshot: RecoverySnapshot): HTMLElement {
    const row = document.createElement("div");
    row.className = "management-row";
    row.dataset.snapshotSeq = String(snapshot.seq);
    const summary = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = snapshot.label ?? snapshotKindLabel(snapshot.kind);
    const metadata = document.createElement("small");
    metadata.textContent = `${snapshotKindLabel(snapshot.kind)} · sequence ${snapshot.seq} · ${snapshot.itemCount} item${snapshot.itemCount === 1 ? "" : "s"} · ${formatBytes(snapshot.byteCount)} · ${formatDateTime(snapshot.createdAt)}`;
    summary.append(label, metadata);
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Restore";
    restore.setAttribute("aria-label", `Restore ${label.textContent}`);
    restore.addEventListener("click", () => void this.restoreSnapshot(snapshot, restore));
    row.append(summary, restore);
    return row;
  }

  private async setPolicy(policy: DrawingPolicy): Promise<void> {
    try {
      const result = await this.api.updateSettings(
        this.bootstrap.board.id,
        { drawingPolicy: policy },
        this.bootstrap.board.aclVersion,
      );
      this.bootstrap.board.drawingPolicy = policy;
      this.adoptAclVersion(result);
      this.updatePermissions();
      this.renderAccessPanel();
    } catch (error) {
      this.apiError(error);
    }
  }

  private async setAccessMode(accessMode: AccessMode): Promise<void> {
    try {
      const result = await this.api.updateSettings(
        this.bootstrap.board.id,
        { accessMode },
        this.bootstrap.board.aclVersion,
      );
      this.bootstrap.board.accessMode = accessMode;
      this.adoptAclVersion(result);
      this.notify(
        accessMode === "private"
          ? "Only members can open this board now."
          : "Anyone with the link can view this board.",
        "info",
      );
    } catch (error) {
      this.apiError(error);
      this.renderAccessPanel();
    }
  }

  private async createInvitation(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (submit) submit.disabled = true;
    try {
      const result = await this.api.createInvitation(this.bootstrap.board.id, {
        role: data.get("role") === "viewer" ? "viewer" : "editor",
        maxUses: Math.max(1, Math.min(50, Number(data.get("maxUses")) || 1)),
        label: String(data.get("label") ?? "").trim() || undefined,
        expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
      });
      const token = stringValue(result.token);
      const url =
        stringValue(result.url) ??
        (token
          ? `${location.origin}/b/${this.bootstrap.board.id}#invite=${encodeURIComponent(token)}`
          : null);
      this.managedInvitations = [
        result.invitation,
        ...this.managedInvitations.filter((value) => value.id !== result.invitation.id),
      ];
      saveManagedInvitations(this.bootstrap.board.id, this.managedInvitations);
      this.renderAccessPanel();
      const output = query(this.accessBody, "[data-invite-result]", HTMLElement);
      this.renderOneTimeLink(output, url, "Copy this link now. It won’t be shown again.");
      form.reset();
    } catch (error) {
      this.apiError(error);
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  private async revokeInvitation(invitation: ManagedInvitation): Promise<void> {
    if (!confirm(`Revoke ${invitation.label ?? "this invitation"}? Its link will stop working.`)) {
      return;
    }
    try {
      await this.api.revokeInvitation(this.bootstrap.board.id, invitation.id);
      this.managedInvitations = this.managedInvitations.filter(
        (value) => value.id !== invitation.id,
      );
      saveManagedInvitations(this.bootstrap.board.id, this.managedInvitations);
      this.renderAccessPanel();
      this.notify("Invitation revoked.", "info");
    } catch (error) {
      this.apiError(error);
    }
  }

  private async createNamedSnapshot(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const label = String(new FormData(form).get("label") ?? "").trim();
    if (!label) return;
    const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (submit) submit.disabled = true;
    try {
      const snapshot = await this.api.createNamedSnapshot(this.bootstrap.board.id, label);
      this.recoverySnapshots = [
        snapshot,
        ...this.recoverySnapshots.filter((value) => value.seq !== snapshot.seq),
      ].sort((left, right) => right.seq - left.seq);
      this.renderAccessPanel();
      this.notify(`Recovery point “${label}” saved at sequence ${snapshot.seq}.`, "info");
    } catch (error) {
      this.apiError(error);
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  private async restoreSnapshot(
    snapshot: RecoverySnapshot,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (this.phase !== "ready" || this.model.pendingCount > 0 || this.optimisticRecovery) {
      this.notify("Wait for pending edits to save before restoring a recovery point.", "warning");
      return;
    }
    const label = snapshot.label ?? snapshotKindLabel(snapshot.kind);
    if (
      !confirm(
        `Restore “${label}” from sequence ${snapshot.seq}? Current drawing content will be replaced, and the restore will be recorded as a new action.`,
      )
    ) {
      return;
    }
    button.disabled = true;
    try {
      const result = await this.api.restoreSnapshot(
        this.bootstrap.board.id,
        snapshot.seq,
        this.model.lastAppliedSeq,
      );
      this.closeDrawers();
      this.notify(`Recovery point restored as sequence ${result.seq}.`, "info");
      this.socket.resynchronize("Loading the restored board content.");
    } catch (error) {
      this.apiError(error);
      button.disabled = false;
    }
  }

  private async changeMemberRole(member: Member, role: "editor" | "viewer"): Promise<void> {
    try {
      const result = await this.api.updateMember(
        this.bootstrap.board.id,
        member.id,
        role,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      member.role = role;
    } catch (error) {
      this.apiError(error);
      this.renderAccessPanel();
    }
  }

  private async revokeMember(member: Member): Promise<void> {
    if (!confirm(`Remove ${member.displayName} from this board?`)) return;
    try {
      const result = await this.api.revokeMember(
        this.bootstrap.board.id,
        member.id,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      this.accessMembers = this.accessMembers.filter((value) => value.id !== member.id);
      this.renderAccessPanel();
    } catch (error) {
      this.apiError(error);
    }
  }

  private async transferOwnership(member: Member): Promise<void> {
    if (
      !confirm(
        `Make ${member.displayName} the owner? You will become an editor, and every previous recovery link will stop working.`,
      )
    )
      return;
    try {
      const result = await this.api.transferOwnership(
        this.bootstrap.board.id,
        member.id,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      this.bootstrap.actor.role = "editor";
      const previousOwner = this.accessMembers.find(
        (value) => value.id === this.bootstrap.actor.id,
      );
      if (previousOwner) previousOwner.role = "editor";
      member.role = "owner";
      this.closeDrawers();
      this.updatePermissions();
      this.renderParticipants();
      this.notify(
        result.recoveryTokenDelivered === true
          ? `Ownership transferred to ${member.displayName}. Their active board session received the new recovery link.`
          : `Ownership transferred to ${member.displayName}. They can rotate a recovery link after opening the board.`,
        "info",
      );
    } catch (error) {
      this.apiError(error);
    }
  }

  private showTransferredOwnerRecovery(token: string): void {
    document.querySelector("[data-testid='transferred-owner-recovery']")?.remove();
    const recoveryUrl = `${location.origin}/b/${encodeURIComponent(this.bootstrap.board.id)}#recovery=${encodeURIComponent(token)}`;
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog created-dialog";
    dialog.dataset.testid = "transferred-owner-recovery";
    dialog.innerHTML = `
      <span class="dialog-mark" aria-hidden="true">✓</span>
      <h1>You’re now the owner</h1>
      <p>Save this new recovery link somewhere private. It is shown only in your active owner session.</p>
      <div class="secret-copy"><span></span><button type="button" data-copy>Copy</button></div>
      <button class="primary-button" type="button" data-continue>I saved it</button>
    `;
    query(dialog, ".secret-copy span", HTMLElement).textContent = recoveryUrl;
    query(dialog, "[data-copy]", HTMLButtonElement).addEventListener("click", async (event) => {
      try {
        await navigator.clipboard.writeText(recoveryUrl);
        (event.currentTarget as HTMLButtonElement).textContent = "Copied";
      } catch {
        this.notify("Select and copy the recovery link manually.", "warning");
      }
    });
    query(dialog, "[data-continue]", HTMLButtonElement).addEventListener("click", () => {
      dialog.close();
    });
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  private async rotateRecovery(): Promise<void> {
    if (
      !confirm("Rotate the owner recovery link? The previous link will stop working immediately.")
    )
      return;
    try {
      const result = await this.api.rotateRecovery(
        this.bootstrap.board.id,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      const token = stringValue(result.ownerRecoveryToken) ?? stringValue(result.token);
      const url =
        stringValue(result.ownerRecoveryUrl) ??
        stringValue(result.url) ??
        (token
          ? `${location.origin}/b/${this.bootstrap.board.id}#recovery=${encodeURIComponent(token)}`
          : null);
      const output = query(this.accessBody, "[data-recovery-result]", HTMLElement);
      this.renderOneTimeLink(
        output,
        url,
        "Save this recovery link now. Every older link is invalid.",
      );
    } catch (error) {
      this.apiError(error);
    }
  }

  private async clearBoard(): Promise<void> {
    if (!confirm("Clear every item from this board? A recovery snapshot will be created first."))
      return;
    const accepted = await this.commit({
      kind: "board.clear",
      expectedBoardSeq: this.model.lastAppliedSeq,
    });
    if (accepted) this.closeDrawers();
  }

  private async archiveBoard(): Promise<void> {
    if (!this.canArchiveBoard()) {
      this.notify(
        "Wait until the board shows Saved and resolve any local recovery data before archiving.",
        "warning",
      );
      return;
    }

    this.archivePending = true;
    this.updatePermissions();
    try {
      const outbox = await this.outbox.contents(this.bootstrap.board.id);
      if (
        this.model.pendingCount > 0 ||
        outbox.active.length > 0 ||
        outbox.expired.length > 0 ||
        this.optimisticRecovery
      ) {
        this.notify(
          "Archive cancelled because this browser still has unsaved or recovery edits.",
          "warning",
        );
        return;
      }
      if (
        !confirm(
          `Archive “${this.bootstrap.board.title}” permanently? This cannot be undone. The board will become read only, and existing access and invitation links will stop opening it.`,
        )
      ) {
        return;
      }

      const result = await this.api.archiveBoard(
        this.bootstrap.board.id,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      this.socket.stop(undefined, "archived");
    } catch (error) {
      this.apiError(error);
    } finally {
      this.archivePending = false;
      this.updatePermissions();
    }
  }

  private renderOneTimeLink(container: HTMLElement, url: string | null, message: string): void {
    container.replaceChildren();
    container.hidden = false;
    const note = document.createElement("strong");
    note.textContent = message;
    const value = document.createElement("span");
    value.textContent = url ?? "The server did not return a visible link.";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy link";
    copy.disabled = !url;
    copy.addEventListener("click", async () => {
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = "Copied";
      } catch {
        this.notify("Select and copy the link manually.", "warning");
      }
    });
    container.append(note, value, copy);
  }

  private adoptAclVersion(result: Record<string, unknown>): void {
    const board = isRecord(result.board) ? result.board : result;
    if (typeof board.aclVersion === "number") this.bootstrap.board.aclVersion = board.aclVersion;
    else this.bootstrap.board.aclVersion += 1;
  }

  private renderParticipants(): void {
    this.participantList.replaceChildren();
    const entries = [...this.presences.values()];
    this.participantCount.textContent = String(Math.max(1, entries.length));
    for (const participant of entries) {
      const row = document.createElement("div");
      row.className = "participant-row";
      const avatar = document.createElement("span");
      avatar.className = "participant-avatar";
      avatar.textContent = initials(participant.displayName);
      const identity = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = participant.displayName;
      const detail = document.createElement("small");
      const role =
        participant.id === this.bootstrap.actor.id
          ? `${this.bootstrap.actor.role} · you`
          : (participant.role ?? "participant");
      detail.textContent = participant.activeTool ? `${role} · ${participant.activeTool}` : role;
      identity.append(name, detail);
      const live = document.createElement("i");
      live.className = "live-dot";
      live.title = "Connected";
      row.append(avatar, identity, live);
      this.participantList.append(row);
    }
  }

  private expireEphemeralState(): void {
    const now = Date.now();
    let changedPreview = false;
    for (const [key, preview] of this.remotePreviews) {
      if (now - preview.updatedAt > 3_000) {
        this.remotePreviews.delete(key);
        changedPreview = true;
      }
    }
    if (changedPreview) this.renderer.renderRemotePreviews(this.remotePreviews.values());
    let changedPresence = false;
    for (const [key, presence] of this.presences) {
      if (presence.id !== this.bootstrap.actor.id && now - presence.updatedAt > 60_000) {
        this.presences.delete(key);
        changedPresence = true;
      }
    }
    if (changedPresence) this.renderParticipants();
  }

  private clearPreviewForGesture(gestureId: string): void {
    let changed = false;
    for (const [key, preview] of this.remotePreviews) {
      if (preview.gestureId === gestureId) {
        this.remotePreviews.delete(key);
        changed = true;
      }
    }
    if (changed) this.renderer.renderRemotePreviews(this.remotePreviews.values());
  }

  private canCommit(): boolean {
    return (
      this.outboxAvailable &&
      !this.optimisticRecovery &&
      !this.archivePending &&
      this.phase === "ready" &&
      canRoleDraw(this.bootstrap.actor.role, this.bootstrap.board.drawingPolicy)
    );
  }

  private canArchiveBoard(): boolean {
    return (
      this.bootstrap.actor.role === "owner" &&
      this.outboxAvailable &&
      !this.optimisticRecovery &&
      !this.archivePending &&
      this.expiredRecovery.length === 0 &&
      this.model.pendingCount === 0 &&
      this.phase === "ready"
    );
  }

  private enterArchivedState(): void {
    this.archivePending = false;
    void this.closeTextEditor(false);
    this.tools.setTool("select");
    this.remotePreviews.clear();
    this.renderer.renderRemotePreviews(this.remotePreviews.values());
    this.closeDrawers();
    this.archivedBanner.hidden = false;
    query(this.archivedBanner, "span", HTMLElement).textContent =
      this.model.pendingCount > 0 || this.expiredRecovery.length > 0
        ? "This board is permanently read only. Unsaved local edits may still be visible; export a local recovery JSON if you need them."
        : "This board is permanently read only. Existing access and invitation links can no longer open it.";
    this.root.dataset.archived = "true";
    this.liveRegion.textContent = "Board archived. This board is permanently read only.";
  }

  private updateAll(): void {
    this.setActiveToolButton(this.tools.tool);
    this.updateStyleControls();
    this.updatePermissions();
    this.updateHistoryControls();
    this.updateStatus();
    this.renderParticipants();
    query(this.root, "[data-canvas-hint]", HTMLElement).hidden = this.model.items.size > 0;
    document.title = `${this.bootstrap.board.title} — Commonspace`;
  }

  private updatePermissions(): void {
    const canEdit = this.canCommit();
    const archived = this.phase === "archived";
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      const name = button.dataset.tool as ToolName;
      button.disabled = DRAW_TOOLS.has(name) && !canEdit;
    }
    this.accessButton.hidden = this.bootstrap.actor.role !== "owner" || archived;
    this.accessButton.disabled = archived || this.archivePending;
    this.titleInput.readOnly = this.bootstrap.actor.role !== "owner" || archived;
    this.titleInput.disabled = archived || this.archivePending;
    this.titleInput.classList.toggle(
      "editable",
      this.bootstrap.actor.role === "owner" && !archived,
    );
    if (archived) {
      for (const control of this.accessDrawer.querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLSelectElement
      >("button, input, select")) {
        control.disabled = true;
      }
    }
    const archiveButton = this.accessBody.querySelector<HTMLButtonElement>("[data-archive-board]");
    if (archiveButton) archiveButton.disabled = !this.canArchiveBoard();
    this.renderer.svg.setAttribute("aria-readonly", String(!canEdit));
    this.updateHistoryControls();
    this.updateStatus();
  }

  private updateHistoryControls(): void {
    this.undoButton.disabled = !this.history.canUndo || !this.canCommit();
    this.redoButton.disabled = !this.history.canRedo || !this.canCommit();
  }

  private updateStatus(): void {
    let label: string;
    let state: string;
    if (this.optimisticRecovery) {
      label = "Recovery needed";
      state = "recovery";
    } else if (this.phase === "archived") {
      label = "Board archived";
      state = "archived";
    } else if (this.phase === "reload_required") {
      label = "Reload required";
      state = "reload";
    } else if (
      !this.outboxAvailable ||
      this.phase === "stopped" ||
      !canRoleDraw(this.bootstrap.actor.role, this.bootstrap.board.drawingPolicy)
    ) {
      label = "Read only";
      state = "readonly";
    } else if (this.phase !== "ready") {
      label = "Reconnecting…";
      state = "reconnecting";
    } else if (this.model.pendingCount > 0) {
      label = "Saving…";
      state = "saving";
    } else {
      label = this.model.lastAppliedSeq > 0 ? `Saved · ${this.model.lastAppliedSeq}` : "Saved";
      state = "saved";
    }
    this.saveStatus.dataset.state = state;
    this.saveStatusText.textContent = label;
    const archiveButton = this.accessBody.querySelector<HTMLButtonElement>("[data-archive-board]");
    if (archiveButton) archiveButton.disabled = !this.canArchiveBoard();
  }

  private updateStyleControls(): void {
    query(this.root, "[data-style-swatch]", HTMLElement).style.background = this.style.color;
    query(this.root, "[data-style-width]", HTMLElement).style.height =
      `${Math.min(8, Math.max(2, this.style.width / 3))}px`;
    query(this.root, ".rail-color-dot", HTMLElement).style.background = this.style.color;
    query(this.root, "[data-style-color]", HTMLInputElement).value = this.style.color;
    query(this.root, "[data-style-stroke]", HTMLInputElement).value = String(this.style.width);
    query(this.root, "[data-style-opacity]", HTMLInputElement).value = String(
      this.style.opacity * 100,
    );
    query(this.root, "[data-style-font]", HTMLInputElement).value = String(this.style.fontSize);
    query(this.root, "[data-width-output]", HTMLOutputElement).value = String(this.style.width);
    query(this.root, "[data-opacity-output]", HTMLOutputElement).value =
      `${Math.round(this.style.opacity * 100)}%`;
    query(this.root, "[data-font-output]", HTMLOutputElement).value = String(this.style.fontSize);
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      button.setAttribute("aria-pressed", String(button.dataset.color === this.style.color));
    }
  }

  private setActiveToolButton(tool: ToolName): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
    }
  }

  private updateSelectionActions(ids: ReadonlySet<string>): void {
    this.selectionActions.hidden = ids.size === 0;
    const label = ids.size === 1 ? "1 selected" : `${ids.size} selected`;
    this.selectionActions.setAttribute("aria-label", label);
  }

  private zoomBy(factor: number): void {
    const rect = this.renderer.svg.getBoundingClientRect();
    this.renderer.viewport.zoomAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      this.renderer.viewport.zoom * factor,
    );
  }

  private togglePopover(popover: HTMLElement, trigger: HTMLButtonElement): void {
    const open = popover.hidden;
    this.stylePopover.hidden = true;
    this.exportMenu.hidden = true;
    popover.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  }

  private toggleDrawer(drawer: HTMLElement, trigger: HTMLButtonElement): void {
    const open = drawer.hidden;
    this.closeDrawers();
    drawer.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  }

  private closeDrawers(): void {
    this.participantDrawer.hidden = true;
    this.accessDrawer.hidden = true;
    query(this.root, "[data-testid='participants-button']", HTMLButtonElement).setAttribute(
      "aria-expanded",
      "false",
    );
    this.accessButton.setAttribute("aria-expanded", "false");
  }

  private downloadLocalJson(): void {
    const data = {
      ...this.model.toSnapshot(this.bootstrap.board.id),
      unsavedCommands: [
        ...this.expiredRecovery.map((entry) => entry.command),
        ...this.model.pendingCommands,
      ],
      recoveryOnly: true,
    };
    downloadBlob(
      `${safeFilename(this.bootstrap.board.title)}-recovery.json`,
      "application/json",
      JSON.stringify(data, null, 2),
    );
    if (this.expiredRecovery.length > 0) {
      const commandIds = this.expiredRecovery.map((entry) => entry.commandId);
      void this.outbox
        .removeMany(commandIds)
        .then(() => {
          this.expiredRecovery = [];
          this.syncRecoveryBanner();
        })
        .catch(() => {
          this.notify("The downloaded recovery entries could not be cleared locally.", "warning");
        });
    }
  }

  private downloadLocalSvg(): void {
    const svg = localSvg(
      this.model.toSnapshot(this.bootstrap.board.id),
      this.bootstrap.board.title,
    );
    downloadBlob(`${safeFilename(this.bootstrap.board.title)}-local.svg`, "image/svg+xml", svg);
  }

  private notify(message: string, kind: "info" | "warning" | "error" = "info"): void {
    const toast = document.createElement("div");
    toast.className = `toast toast-${kind}`;
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    toast.textContent = message;
    this.toastRegion.append(toast);
    window.setTimeout(() => {
      toast.classList.add("leaving");
      window.setTimeout(() => toast.remove(), 220);
    }, 4_500);
  }

  private apiError(error: unknown): void {
    if (error instanceof ApiError) {
      if (error.status === 409) {
        this.notify("Access changed in another tab. Refreshing these controls…", "warning");
        void this.resync("Refreshing current board access.");
      } else {
        this.notify(error.message, "error");
      }
      return;
    }
    this.notify("The request could not be completed.", "error");
  }
}

export function boardIdFromPath(pathname = window.location.pathname): string | null {
  const match = pathname.match(/^\/b\/([^/]+)\/?$/);
  if (!match?.[1]) return null;
  try {
    const boardId = decodeURIComponent(match[1]);
    return /^b_[A-Za-z0-9_-]{8,}$/.test(boardId) ? boardId : null;
  } catch {
    return null;
  }
}

export async function confirmRecoveryClaim(
  root: HTMLElement,
  claim: FragmentClaim,
): Promise<boolean> {
  if (claim.type !== "recovery") return true;
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog";
    dialog.dataset.testid = "recovery-confirmation";
    dialog.innerHTML = `
      <span class="dialog-mark" aria-hidden="true">↻</span>
      <h1>Recover board ownership?</h1>
      <p>This will make this device the owner and demote the current owner. Continue only if you intended to use this recovery link.</p>
      <div class="dialog-actions"><button type="button" data-cancel>Cancel</button><button class="primary-button" type="button" data-confirm>Recover ownership</button></div>
    `;
    root.replaceChildren(dialog);
    query(dialog, "[data-cancel]", HTMLButtonElement).addEventListener("click", () => {
      dialog.close();
      resolve(false);
    });
    query(dialog, "[data-confirm]", HTMLButtonElement).addEventListener("click", () => {
      dialog.close();
      resolve(true);
    });
    dialog.addEventListener("cancel", () => resolve(false), { once: true });
    dialog.showModal();
  });
}

export async function requestClaimVerification(
  root: HTMLElement,
  turnstile: { enabled: boolean; siteKey: string | null },
  claimType: FragmentClaim["type"],
): Promise<string | undefined> {
  if (!turnstile.enabled) return undefined;
  if (!turnstile.siteKey) {
    throw new ApiError(
      "TEMPORARILY_UNAVAILABLE",
      "Human verification is temporarily unavailable.",
      503,
    );
  }
  return new Promise((resolve) => {
    const form = document.createElement("form");
    form.className = "claim-dialog claim-verification";
    form.dataset.testid = "claim-verification";
    form.innerHTML = `
      <span class="dialog-mark" aria-hidden="true">✓</span>
      <h1>Verify before continuing</h1>
      <p>This brief check protects shared boards and invitation links from automated abuse.</p>
      <div data-turnstile></div>
      <button class="primary-button" type="submit">Continue to board</button>
    `;
    mountTurnstile(
      query(form, "[data-turnstile]", HTMLElement),
      turnstile.siteKey,
      claimType === "invite" ? "invitation_claim" : "recovery_claim",
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const token = form.querySelector<HTMLInputElement>(
        "input[name='cf-turnstile-response']",
      )?.value;
      if (!token) {
        showInlineError(form, "Complete the human verification before continuing.");
        return;
      }
      resolve(token);
    });
    root.replaceChildren(form);
  });
}

export async function acknowledgeRecoveredOwnership(
  root: HTMLElement,
  boardId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const token = stringValue(result.ownerRecoveryToken) ?? stringValue(result.token);
  if (!token) return;
  const recoveryUrl = `${location.origin}/b/${encodeURIComponent(boardId)}#recovery=${encodeURIComponent(token)}`;
  await new Promise<void>((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog created-dialog";
    dialog.dataset.testid = "new-recovery-link";
    dialog.innerHTML = `
      <span class="dialog-mark" aria-hidden="true">✓</span>
      <h1>Ownership recovered</h1>
      <p>Your old recovery link is now invalid. Save this replacement somewhere private before opening the board.</p>
      <div class="secret-copy"><span></span><button type="button" data-copy>Copy</button></div>
      <button class="primary-button" type="button" data-continue>Continue to board</button>
    `;
    query(dialog, ".secret-copy span", HTMLElement).textContent = recoveryUrl;
    query(dialog, "[data-copy]", HTMLButtonElement).addEventListener("click", async (event) => {
      try {
        await navigator.clipboard.writeText(recoveryUrl);
        (event.currentTarget as HTMLButtonElement).textContent = "Copied";
      } catch {
        (event.currentTarget as HTMLButtonElement).textContent = "Select link";
      }
    });
    query(dialog, "[data-continue]", HTMLButtonElement).addEventListener("click", () => {
      dialog.close();
      resolve();
    });
    root.replaceChildren(dialog);
    dialog.showModal();
  });
}

export function renderLanding(root: HTMLElement, api: ApiClient): void {
  root.innerHTML = `
    <main class="landing" data-testid="landing-page">
      <div class="landing-glow" aria-hidden="true"></div>
      <header><a class="wordmark" href="/"><span class="brand-mark" aria-hidden="true">C</span><span>Commonspace</span></a><span class="landing-badge">Cloudflare-native</span></header>
      <section class="landing-copy">
        <span class="eyebrow">A room for unfinished ideas</span>
        <h1>Think together,<br /><em>in the open.</em></h1>
        <p>Sketch, explain, and move ideas around a shared infinite canvas. No account required.</p>
      </section>
      <form class="create-card" data-create-form>
        <div><span class="card-step">Start a board</span><h2>What are you working on?</h2></div>
        <label><span class="sr-only">Board title</span><input name="title" maxlength="100" value="Untitled board" required autocomplete="off" /></label>
        <div data-turnstile></div>
        <button class="primary-button" type="submit">Open a fresh canvas <span aria-hidden="true">→</span></button>
        <small>Private owner controls · automatic saving · SVG export</small>
      </form>
      <footer><span>Built for 2–20 people</span><span>Pointer, pen & touch ready</span></footer>
    </main>
  `;
  const form = query(root, "[data-create-form]", HTMLFormElement);
  mountTurnstile(query(root, "[data-turnstile]", HTMLElement), api.turnstile.siteKey);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = query(form, "button[type='submit']", HTMLButtonElement);
    button.disabled = true;
    button.textContent = "Creating your board…";
    const formData = new FormData(form);
    const title = String(formData.get("title") ?? "").trim();
    const tokenInput = form.querySelector<HTMLInputElement>("input[name='cf-turnstile-response']");
    try {
      const result = await api.createBoard(title, tokenInput?.value || undefined);
      showCreatedBoard(root, result.board.url, result.ownerRecoveryUrl);
    } catch (error) {
      button.disabled = false;
      button.textContent = "Open a fresh canvas →";
      const message = error instanceof ApiError ? error.message : "The board could not be created.";
      showInlineError(form, message);
    }
  });
}

export function renderFatal(root: HTMLElement, title: string, message: string, retry = true): void {
  root.innerHTML = `
    <main class="fatal-screen" data-testid="fatal-screen">
      <span class="brand-mark" aria-hidden="true">C</span>
      <span class="eyebrow">Commonspace</span>
      <h1></h1><p></p>
      <div><a class="primary-button" href="/">Start a new board</a>${retry ? '<button type="button" data-retry>Try again</button>' : ""}</div>
    </main>
  `;
  query(root, "h1", HTMLElement).textContent = title;
  query(root, "p", HTMLElement).textContent = message;
  root
    .querySelector<HTMLButtonElement>("[data-retry]")
    ?.addEventListener("click", () => location.reload());
}

function showCreatedBoard(root: HTMLElement, boardUrl: string, recoveryUrl: string): void {
  const dialog = document.createElement("dialog");
  dialog.className = "claim-dialog created-dialog";
  dialog.innerHTML = `
    <span class="dialog-mark" aria-hidden="true">✓</span>
    <h1>Your canvas is ready</h1>
    <p>Save this owner recovery link somewhere private. It is the only way back in if this browser loses its owner session.</p>
    <div class="secret-copy"><span></span><button type="button">Copy</button></div>
    <a class="primary-button" href="">Continue to board</a>
  `;
  query(dialog, ".secret-copy span", HTMLElement).textContent = recoveryUrl;
  query(dialog, ".primary-button", HTMLAnchorElement).href = boardUrl;
  query(dialog, ".secret-copy button", HTMLButtonElement).addEventListener(
    "click",
    async (event) => {
      try {
        await navigator.clipboard.writeText(recoveryUrl);
        (event.currentTarget as HTMLButtonElement).textContent = "Copied";
      } catch {
        (event.currentTarget as HTMLButtonElement).textContent = "Select link";
      }
    },
  );
  root.replaceChildren(dialog);
  dialog.showModal();
}

function mountTurnstile(
  container: HTMLElement,
  sessionSiteKey: string | null,
  action = "board_create",
): void {
  const key =
    sessionSiteKey ??
    import.meta.env.VITE_TURNSTILE_SITE_KEY ??
    document.querySelector<HTMLMetaElement>('meta[name="turnstile-site-key"]')?.content;
  if (!key) return;
  container.className = "cf-turnstile";
  container.dataset.sitekey = key;
  container.dataset.action = action;
  if (!document.querySelector("script[data-turnstile-script]")) {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    script.dataset.turnstileScript = "true";
    document.head.append(script);
  }
}

function localSvg(snapshot: BoardSnapshot, title: string): string {
  const items = [...snapshot.items].sort((a, b) => a.z - b.z);
  const bounds = aggregateItemBounds(items);
  const pad = 32;
  const viewBox = bounds
    ? `${bounds.minX - pad} ${bounds.minY - pad} ${Math.max(1, bounds.maxX - bounds.minX + pad * 2)} ${Math.max(1, bounds.maxY - bounds.minY + pad * 2)}`
    : "0 0 1200 800";
  const content = items.map(svgItem).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${escapeXml(title)}"><metadata>{&quot;format&quot;:&quot;cf-whiteboard-json&quot;,&quot;seq&quot;:${snapshot.seq}}</metadata><rect x="-1000000" y="-1000000" width="2000000" height="2000000" fill="#ffffff"/>${content}</svg>`;
}

function svgItem(item: BoardItem): string {
  const transform = `matrix(${item.transform.join(" ")})`;
  const opacity = item.style.opacity;
  const color = escapeXml(item.style.color);
  if (item.kind === "pencil") {
    const points = item.geometry.points.map((point) => `${point[0]},${point[1]}`).join(" ");
    return `<polyline points="${points}" transform="${transform}" fill="none" stroke="${color}" stroke-width="${item.style.width}" opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (item.kind === "line")
    return `<line x1="${item.geometry.x1}" y1="${item.geometry.y1}" x2="${item.geometry.x2}" y2="${item.geometry.y2}" transform="${transform}" fill="none" stroke="${color}" stroke-width="${item.style.width}" opacity="${opacity}" stroke-linecap="round"/>`;
  if (item.kind === "rectangle")
    return `<rect x="${item.geometry.x}" y="${item.geometry.y}" width="${item.geometry.width}" height="${item.geometry.height}" transform="${transform}" fill="none" stroke="${color}" stroke-width="${item.style.width}" opacity="${opacity}"/>`;
  if (item.kind === "ellipse")
    return `<ellipse cx="${item.geometry.x + item.geometry.width / 2}" cy="${item.geometry.y + item.geometry.height / 2}" rx="${item.geometry.width / 2}" ry="${item.geometry.height / 2}" transform="${transform}" fill="none" stroke="${color}" stroke-width="${item.style.width}" opacity="${opacity}"/>`;
  const lines = item.geometry.text
    .split("\n")
    .map(
      (line, index) =>
        `<tspan x="${item.geometry.x}"${index ? ' dy="1.2em"' : ""}>${escapeXml(line || " ")}</tspan>`,
    )
    .join("");
  return `<text x="${item.geometry.x}" y="${item.geometry.y}" transform="${transform}" fill="${color}" font-size="${item.style.fontSize}" opacity="${opacity}" font-family="sans-serif">${lines}</text>`;
}

function aggregateItemBounds(
  items: BoardItem[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (items.length === 0) return null;
  const coordinates: Array<[number, number]> = [];
  for (const item of items) {
    if (item.kind === "pencil")
      coordinates.push(
        ...item.geometry.points.map(
          (point) =>
            [point[0] + item.transform[4], point[1] + item.transform[5]] as [number, number],
        ),
      );
    else if (item.kind === "line")
      coordinates.push(
        [item.geometry.x1 + item.transform[4], item.geometry.y1 + item.transform[5]],
        [item.geometry.x2 + item.transform[4], item.geometry.y2 + item.transform[5]],
      );
    else if (item.kind === "text")
      coordinates.push(
        [
          item.geometry.x + item.transform[4],
          item.geometry.y - item.style.fontSize + item.transform[5],
        ],
        [
          item.geometry.x +
            item.geometry.text.length * item.style.fontSize * 0.65 +
            item.transform[4],
          item.geometry.y + item.style.fontSize + item.transform[5],
        ],
      );
    else
      coordinates.push(
        [item.geometry.x + item.transform[4], item.geometry.y + item.transform[5]],
        [
          item.geometry.x + item.geometry.width + item.transform[4],
          item.geometry.y + item.geometry.height + item.transform[5],
        ],
      );
  }
  return {
    minX: Math.min(...coordinates.map((point) => point[0])),
    minY: Math.min(...coordinates.map((point) => point[1])),
    maxX: Math.max(...coordinates.map((point) => point[0])),
    maxY: Math.max(...coordinates.map((point) => point[1])),
  };
}

function downloadBlob(filename: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function loadingBlock(message: string): HTMLElement {
  const block = document.createElement("div");
  block.className = "drawer-loading";
  block.setAttribute("role", "status");
  block.textContent = message;
  return block;
}

function errorBlock(message: string): HTMLElement {
  const block = document.createElement("p");
  block.className = "drawer-error";
  block.textContent = message;
  return block;
}

function showInlineError(container: HTMLElement, message: string): void {
  container.querySelector(".inline-error")?.remove();
  const error = document.createElement("p");
  error.className = "inline-error";
  error.setAttribute("role", "alert");
  error.textContent = message;
  container.append(error);
}

function query<T extends Element>(
  container: ParentNode,
  selector: string,
  elementType: { new (): T },
): T {
  const element = container.querySelector(selector);
  if (!(element instanceof elementType))
    throw new Error(`Required UI element not found: ${selector}`);
  return element;
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((part) => [...part][0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function managedInvitationStorageKey(boardId: string): string {
  return `commonspace:managed-invitations:${boardId}`;
}

function loadManagedInvitations(boardId: string): ManagedInvitation[] {
  try {
    const serialized = window.sessionStorage.getItem(managedInvitationStorageKey(boardId));
    if (serialized === null) return [];
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) return [];
    return value.flatMap(parseManagedInvitation).slice(0, 50);
  } catch {
    return [];
  }
}

function saveManagedInvitations(boardId: string, invitations: ManagedInvitation[]): void {
  try {
    if (invitations.length === 0) {
      window.sessionStorage.removeItem(managedInvitationStorageKey(boardId));
      return;
    }
    window.sessionStorage.setItem(
      managedInvitationStorageKey(boardId),
      JSON.stringify(invitations.slice(0, 50)),
    );
  } catch {
    // Invitation IDs are only a convenience for this browser session.
  }
}

function parseManagedInvitation(value: unknown): ManagedInvitation[] {
  if (!isRecord(value)) return [];
  if (
    typeof value.id !== "string" ||
    !/^i_[A-Za-z0-9_-]{16,78}$/u.test(value.id) ||
    (value.role !== "viewer" && value.role !== "editor") ||
    (value.label !== null && typeof value.label !== "string") ||
    !Number.isSafeInteger(value.maxUses) ||
    (value.maxUses as number) < 1 ||
    (value.maxUses as number) > 50 ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    return [];
  }
  return [
    {
      id: value.id,
      role: value.role,
      label: value.label,
      maxUses: value.maxUses as number,
      expiresAt: value.expiresAt as number,
    },
  ];
}

function snapshotKindLabel(kind: RecoverySnapshot["kind"]): string {
  if (kind === "pre_clear") return "Before board clear";
  if (kind === "automatic") return "Automatic recovery point";
  return "Named recovery point";
}

function formatDateTime(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return "unknown time";
  }
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${Math.round(value / 1_024)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function safeFilename(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "whiteboard"
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
