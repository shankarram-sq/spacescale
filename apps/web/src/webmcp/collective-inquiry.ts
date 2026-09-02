import "./collective-inquiry.css";

import { boundsForItems, boundsHeight, boundsWidth } from "@collab/geometry";
import { normalizeBoardItem } from "@collab/protocol";
import { renderSvgItem } from "@collab/svg-export";
import type { BoardItem, Role } from "../types";

const READ_SELECTION_TOOL = "read_selected_class_ideas";
const INSPECT_VISUAL_TOOL = "inspect_selected_board_visual";
const MAX_SHARED_IDEAS = 30;
const MAX_SHARED_VISUAL_ITEMS = 40;
const MAX_SNAPSHOTS = 10;

type ShareableItem = Extract<BoardItem, { kind: "sticky" }>;

export type SharedIdea = {
  alias: string;
  kind: "idea";
  text: string;
  action: {
    type: "created";
    objectKind: "sticky";
  };
  createdBy: SharedParticipant;
};

export type SharedParticipant = {
  participantId: string;
  displayName: string;
};

export type CollectiveInquirySnapshot = {
  token: string;
  capturedAt: string;
  sources: Array<{
    alias: string;
    itemId: string;
    version: number;
    kind: ShareableItem["kind"];
    text: string;
  }>;
};

export type VisualSelectionSnapshot = {
  token: string;
  capturedAt: string;
  sources: Array<{
    alias: string;
    itemId: string;
    version: number;
    kind: BoardItem["kind"];
  }>;
};

export type CollectiveInquiryWebMcpOptions = {
  root: HTMLElement;
  status: HTMLElement;
  selectionButton: HTMLButtonElement;
  getRole: () => Role;
  getSelectedItems: () => BoardItem[] | null;
  getParticipantDisplayName: (participantId: string) => string | null;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

export class CollectiveInquiryWebMcp {
  private readonly shareDialog: HTMLDialogElement;
  private readonly visualConsentDialog: HTMLDialogElement;
  private readonly visualReviewDialog: HTMLDialogElement;
  private readonly guideDialog: HTMLDialogElement;
  private readonly snapshots = new Map<string, CollectiveInquirySnapshot>();
  private readonly visualSnapshots = new Map<string, VisualSelectionSnapshot>();
  private readonly registration = new AbortController();
  private destroyed = false;
  private sharePending = false;
  private visualObjectUrl: string | null = null;

  constructor(private readonly options: CollectiveInquiryWebMcpOptions) {
    this.shareDialog = this.buildShareDialog();
    this.visualConsentDialog = this.buildVisualConsentDialog();
    this.visualReviewDialog = this.buildVisualReviewDialog();
    this.guideDialog = this.buildGuideDialog();
    options.root.append(
      this.shareDialog,
      this.visualConsentDialog,
      this.visualReviewDialog,
      this.guideDialog,
    );
    this.visualReviewDialog.addEventListener("close", this.clearVisualReview);
    options.selectionButton.addEventListener("click", this.openGuide);
    this.refresh();
    void this.register();
  }

  refresh(): void {
    const owner = this.options.getRole() === "owner";
    const supported = typeof document.modelContext?.registerTool === "function";
    this.options.status.hidden = !owner;
    this.options.status.dataset.state = supported ? "ready" : "unavailable";
    this.options.status.title = supported
      ? "AI partner tools are available to ChatGPT through WebMCP."
      : "Open this Space in ChatGPT's built-in browser to use its WebMCP tools.";
    const label = this.options.status.querySelector<HTMLElement>("[data-webmcp-label]");
    if (label) label.textContent = supported ? "AI partner ready" : "AI partner";

    const selection = this.visualSelection();
    this.options.selectionButton.hidden = !owner || selection.items.length === 0;
    this.options.selectionButton.disabled = !supported || selection.issue !== null;
    this.options.selectionButton.title = !supported
      ? "Open this Space in ChatGPT's built-in browser to collaborate with AI."
      : (selection.issue ?? "Ask ChatGPT to work with only this selected board content.");
  }

  getSnapshot(token: string): CollectiveInquirySnapshot | undefined {
    return this.snapshots.get(token);
  }

  destroy(): void {
    this.destroyed = true;
    this.registration.abort();
    this.options.selectionButton.removeEventListener("click", this.openGuide);
    this.visualReviewDialog.removeEventListener("close", this.clearVisualReview);
    this.clearVisualReview();
    this.shareDialog.close();
    this.visualConsentDialog.close();
    this.visualReviewDialog.close();
    this.guideDialog.close();
    this.shareDialog.remove();
    this.visualConsentDialog.remove();
    this.visualReviewDialog.remove();
    this.guideDialog.remove();
  }

  private async register(): Promise<void> {
    if (this.destroyed || this.options.getRole() !== "owner") return;
    const modelContext = document.modelContext;
    if (typeof modelContext?.registerTool !== "function") return;
    try {
      await modelContext.registerTool(
        {
          name: READ_SELECTION_TOOL,
          description:
            "Read only the saved sticky-note ideas the teacher has explicitly selected on the live SpaceScale canvas. Use this before expanding, connecting, challenging, clustering, deciding from, or acting on the class's ideas. Each contribution includes its creator's board-visible display name and stable participant ID so the action can be attributed correctly. Board IDs, item IDs, positions, sections, presence, history, authentication data, and unselected content are not returned.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: true,
          },
          execute: async (_input, { signal }) => this.readSelectedIdeas(signal),
        },
        { signal: this.registration.signal },
      );
      await modelContext.registerTool(
        {
          name: INSPECT_VISUAL_TOOL,
          description:
            "Make only the teacher-selected, saved board items available for visual inspection in an isolated live-page preview. Use this to analyze handwriting, sketches, spatial groupings, arrows, shapes, or mixed visual notes that cannot be understood from text alone. SpaceScale masks the unselected board, replaces stable item IDs with ephemeral aliases, returns each creator's board-visible display name and stable participant ID for action attribution, returns no coordinates, and renders private image cards as placeholders rather than exposing their pixels.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: true,
          },
          execute: async (_input, { signal }) => this.inspectSelectedVisual(signal),
        },
        { signal: this.registration.signal },
      );
      if (this.destroyed) return;
      this.refresh();
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.status.dataset.state = "error";
      this.options.status.title = "The WebMCP collaboration tool could not be registered.";
    }
  }

  private async inspectSelectedVisual(signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (this.options.getRole() !== "owner") {
      throw new Error("Only the Space owner can share a board visual with the AI partner.");
    }
    const selection = this.visualSelection();
    if (selection.issue) throw new Error(selection.issue);
    if (selection.items.length === 0) {
      throw new Error("Select one or more saved board items first.");
    }

    const approved = await this.confirmVisualShare(selection.items, signal);
    if (!approved) throw new Error("The teacher chose not to share this visual selection.");
    signal.throwIfAborted();

    const current = this.visualSelection();
    if (current.issue) throw new Error(current.issue);
    if (!visualSelectionIsFresh(selection.items, current.items)) {
      throw new Error(
        "The selected board content changed during approval. Select it again before sharing the visual.",
      );
    }

    const token = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    const sources = selection.items.map((item, index) => ({
      alias: visualAlias(index),
      itemId: item.id,
      version: item.version,
      kind: item.kind,
    }));
    const sharedItems = selection.items.map((item, index) => ({
      alias: visualAlias(index),
      kind: item.kind,
      action: { type: "created" as const, objectKind: item.kind },
      createdBy: this.participant(item.createdBy),
    }));
    this.visualSnapshots.set(token, { token, capturedAt, sources });
    trimSnapshots(this.visualSnapshots);

    const kindCounts = countKinds(selection.items);
    await this.showVisualReview(selection.items, kindCounts);
    this.options.notify(
      `${selection.items.length} selected visual item${selection.items.length === 1 ? " is" : "s are"} ready for AI inspection.`,
      "info",
    );
    return {
      visualToken: token,
      capturedAt,
      visualReady: true,
      preview: {
        state: "open_in_live_page",
        scope: "teacher_selected_saved_items_only",
        itemCount: selection.items.length,
        itemKinds: kindCounts,
        containsHandwriting: (kindCounts.pencil ?? 0) > 0,
        privateImagesRenderedAsPlaceholders: kindCounts.image ?? 0,
        aliases: sharedItems,
      },
      inspectionGuidance: {
        action:
          "Inspect the isolated visual preview now. Transcribe or analyze only marks that are visibly supported.",
        uncertainty:
          "Label uncertain handwriting explicitly and ask the teacher to clarify instead of inventing text.",
        collaboration:
          "Use creator identity only to attribute a visible action or ask the right participant for clarification. Do not grade, profile, rank, or infer ability, intent, or participation quality from attribution.",
      },
      privacy:
        "Only the teacher-approved selection, its board-visible creator names, and stable participant IDs are shared. Board and item IDs, coordinates, history, presence, authentication data, unselected board content, and private image pixels are not exposed.",
    };
  }

  private async readSelectedIdeas(signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (this.options.getRole() !== "owner") {
      throw new Error("Only the Space owner can share class ideas with the AI partner.");
    }
    const selection = this.shareableSelection();
    if (selection.issue) throw new Error(selection.issue);
    if (selection.items.length === 0) {
      throw new Error("Select one or more saved sticky notes first.");
    }

    const ideas: SharedIdea[] = selection.items.map((item, index) => ({
      alias: `idea_${index + 1}`,
      kind: "idea" as const,
      text: item.geometry.text.trim(),
      action: { type: "created" as const, objectKind: "sticky" as const },
      createdBy: this.participant(item.createdBy),
    }));
    const approved = await this.confirmShare(ideas, signal);
    if (!approved) throw new Error("The teacher chose not to share this selection.");
    signal.throwIfAborted();

    const token = crypto.randomUUID();
    const snapshot: CollectiveInquirySnapshot = {
      token,
      capturedAt: new Date().toISOString(),
      sources: selection.items.map((item, index) => ({
        alias: ideas[index]?.alias ?? `idea_${index + 1}`,
        itemId: item.id,
        version: item.version,
        kind: item.kind,
        text: item.geometry.text.trim(),
      })),
    };
    this.snapshots.set(token, snapshot);
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest);
    }

    this.options.notify(
      `${ideas.length} selected contribution${ideas.length === 1 ? " was" : "s were"} shared with the AI partner.`,
      "info",
    );
    return {
      selectionToken: token,
      capturedAt: snapshot.capturedAt,
      contributions: ideas,
      collaborationGuidance: {
        purpose:
          "Help the class build on these contributions together. Surface bridges, tensions, assumptions, missing perspectives, and useful next questions.",
        preserveDissent: true,
        avoid:
          "Use identity only for accurate action attribution or a relevant clarification. Do not rank students, infer participation quality or ability, profile individuals, or claim consensus.",
      },
      privacy:
        "This result contains only teacher-approved sticky-note text, ephemeral idea aliases, board-visible creator names, and stable participant IDs. Board and item IDs, coordinates, sections, unselected board content, presence, history, authentication data, and contact details were not shared.",
    };
  }

  private participant(participantId: string): SharedParticipant {
    const displayName = this.options.getParticipantDisplayName(participantId)?.trim();
    return {
      participantId,
      displayName: displayName || "Unknown participant",
    };
  }

  private shareableSelection(): { items: ShareableItem[]; issue: string | null } {
    const selected = this.options.getSelectedItems();
    if (selected === null) {
      return { items: [], issue: "Wait for every selected item to finish saving." };
    }
    const items = selected.filter(
      (item): item is ShareableItem =>
        item.kind === "sticky" && item.geometry.text.trim().length > 0,
    );
    if (items.length > MAX_SHARED_IDEAS) {
      return {
        items,
        issue: `Select ${MAX_SHARED_IDEAS} ideas or fewer for one AI collaboration turn.`,
      };
    }
    return { items, issue: null };
  }

  private visualSelection(): { items: BoardItem[]; issue: string | null } {
    const selected = this.options.getSelectedItems();
    if (selected === null) {
      return { items: [], issue: "Wait for every selected item to finish saving." };
    }
    if (selected.length > MAX_SHARED_VISUAL_ITEMS) {
      return {
        items: selected,
        issue: `Select ${MAX_SHARED_VISUAL_ITEMS} visual items or fewer for one AI inspection.`,
      };
    }
    return { items: selected, issue: null };
  }

  private confirmShare(ideas: readonly SharedIdea[], signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.sharePending) {
      return Promise.reject(new Error("Another teacher approval is already open."));
    }
    this.sharePending = true;
    const list = this.shareDialog.querySelector<HTMLElement>("[data-webmcp-share-list]");
    if (list) {
      list.replaceChildren(
        ...ideas.map((idea) => {
          const row = document.createElement("li");
          const alias = document.createElement("span");
          alias.textContent = idea.alias.replace("_", " ");
          const text = document.createElement("p");
          text.textContent = idea.text;
          row.append(alias, text);
          return row;
        }),
      );
    }
    const count = this.shareDialog.querySelector<HTMLElement>("[data-webmcp-share-count]");
    if (count) count.textContent = String(ideas.length);
    const submit = this.shareDialog.querySelector<HTMLButtonElement>("[data-webmcp-share-submit]");
    if (submit) {
      submit.textContent = `Share ${ideas.length} contribution${ideas.length === 1 ? "" : "s"}`;
    }

    this.shareDialog.returnValue = "";
    this.shareDialog.showModal();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.shareDialog.removeEventListener("close", onClose);
        this.sharePending = false;
      };
      const onClose = (): void => {
        cleanup();
        resolve(this.shareDialog.returnValue === "share");
      };
      const onAbort = (): void => {
        cleanup();
        if (this.shareDialog.open) this.shareDialog.close("cancel");
        reject(signal.reason);
      };
      this.shareDialog.addEventListener("close", onClose, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private confirmVisualShare(items: readonly BoardItem[], signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.sharePending) {
      return Promise.reject(new Error("Another teacher approval is already open."));
    }
    this.sharePending = true;
    const kindCounts = countKinds(items);
    const list = this.visualConsentDialog.querySelector<HTMLElement>(
      "[data-webmcp-visual-consent-list]",
    );
    if (list) {
      list.replaceChildren(
        ...Object.entries(kindCounts).map(([kind, count]) => {
          const row = document.createElement("li");
          const label = document.createElement("span");
          label.textContent = humanizeItemKind(kind as BoardItem["kind"], count);
          const value = document.createElement("strong");
          value.textContent = String(count);
          row.append(label, value);
          return row;
        }),
      );
    }
    const count = this.visualConsentDialog.querySelector<HTMLElement>(
      "[data-webmcp-visual-consent-count]",
    );
    if (count) count.textContent = String(items.length);
    const submit = this.visualConsentDialog.querySelector<HTMLButtonElement>(
      "[data-webmcp-visual-consent-submit]",
    );
    if (submit)
      submit.textContent = `Share ${items.length} visual item${items.length === 1 ? "" : "s"}`;

    this.visualConsentDialog.returnValue = "";
    this.visualConsentDialog.showModal();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.visualConsentDialog.removeEventListener("close", onClose);
        this.sharePending = false;
      };
      const onClose = (): void => {
        cleanup();
        resolve(this.visualConsentDialog.returnValue === "share");
      };
      const onAbort = (): void => {
        cleanup();
        if (this.visualConsentDialog.open) this.visualConsentDialog.close("cancel");
        reject(signal.reason);
      };
      this.visualConsentDialog.addEventListener("close", onClose, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async showVisualReview(
    items: readonly BoardItem[],
    kindCounts: Readonly<Partial<Record<BoardItem["kind"], number>>>,
  ): Promise<void> {
    const surface = this.visualReviewDialog.querySelector<HTMLElement>(
      "[data-webmcp-visual-surface]",
    );
    if (!surface) throw new Error("The visual review surface is unavailable.");
    if (this.visualReviewDialog.open) {
      throw new Error("Finish the current visual review before sharing another selection.");
    }
    this.clearVisualReview();
    const preview = buildVisualPreview(items);
    this.visualObjectUrl = preview.objectUrl;
    surface.replaceChildren(preview.image);
    const count = this.visualReviewDialog.querySelector<HTMLElement>(
      "[data-webmcp-visual-review-count]",
    );
    if (count) count.textContent = String(items.length);
    const handwriting = this.visualReviewDialog.querySelector<HTMLElement>(
      "[data-webmcp-visual-handwriting]",
    );
    if (handwriting) {
      const pencilCount = kindCounts.pencil ?? 0;
      handwriting.hidden = pencilCount === 0;
      handwriting.textContent = `${pencilCount} handwriting stroke${pencilCount === 1 ? "" : "s"}`;
    }
    const privateImages = this.visualReviewDialog.querySelector<HTMLElement>(
      "[data-webmcp-visual-private-images]",
    );
    if (privateImages) {
      const imageCount = kindCounts.image ?? 0;
      privateImages.hidden = imageCount === 0;
      privateImages.textContent = `${imageCount} private image${imageCount === 1 ? "" : "s"} shown as ${imageCount === 1 ? "a placeholder" : "placeholders"}`;
    }
    this.visualReviewDialog.showModal();
    try {
      await preview.image.decode();
    } catch {
      if (this.visualReviewDialog.open) this.visualReviewDialog.close();
      this.clearVisualReview();
      throw new Error("The selected visual could not be rendered for inspection.");
    }
  }

  private readonly clearVisualReview = (): void => {
    this.visualReviewDialog
      .querySelector<HTMLElement>("[data-webmcp-visual-surface]")
      ?.replaceChildren();
    if (this.visualObjectUrl) URL.revokeObjectURL(this.visualObjectUrl);
    this.visualObjectUrl = null;
  };

  private readonly openGuide = (): void => {
    if (!this.guideDialog.open) this.guideDialog.showModal();
  };

  private buildShareDialog(): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog webmcp-dialog webmcp-share-dialog";
    dialog.dataset.testid = "webmcp-share-dialog";
    dialog.setAttribute("aria-labelledby", "webmcp-share-title");
    dialog.innerHTML = `
      <form method="dialog">
        <span class="webmcp-dialog-mark" aria-hidden="true">✦</span>
        <span class="eyebrow">AI partner · WebMCP</span>
        <h2 id="webmcp-share-title">Share this selection with AI?</h2>
        <p>The AI can read only the <strong data-webmcp-share-count>0</strong> contributions below. Student names, board identifiers, positions, history, and everything you did not select stay private.</p>
        <ul class="webmcp-share-list" data-webmcp-share-list></ul>
        <div class="webmcp-privacy-note"><span aria-hidden="true">◎</span><span>You stay in control. Reading this selection does not change the shared canvas.</span></div>
        <div class="dialog-actions">
          <button type="submit" value="cancel">Keep private</button>
          <button class="primary-button webmcp-primary-button" type="submit" value="share" data-webmcp-share-submit>Share selection</button>
        </div>
      </form>
    `;
    return dialog;
  }

  private buildVisualConsentDialog(): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog webmcp-dialog webmcp-visual-consent-dialog";
    dialog.dataset.testid = "webmcp-visual-consent-dialog";
    dialog.setAttribute("aria-labelledby", "webmcp-visual-consent-title");
    dialog.innerHTML = `
      <form method="dialog">
        <span class="webmcp-dialog-mark" aria-hidden="true">◫</span>
        <span class="eyebrow">Visual inspection · WebMCP</span>
        <h2 id="webmcp-visual-consent-title">Let AI see this visual selection?</h2>
        <p>After approval, SpaceScale will open an isolated preview containing only these <strong data-webmcp-visual-consent-count>0</strong> saved items. Handwriting and visible text inside the selection may be readable.</p>
        <ul class="webmcp-visual-kind-list" data-webmcp-visual-consent-list></ul>
        <div class="webmcp-privacy-note"><span aria-hidden="true">◎</span><span>The rest of the board will be covered. Names, history, presence, stable IDs, coordinates, and private image pixels stay hidden.</span></div>
        <div class="dialog-actions">
          <button type="submit" value="cancel">Keep private</button>
          <button class="primary-button webmcp-primary-button" type="submit" value="share" data-webmcp-visual-consent-submit>Share visual selection</button>
        </div>
      </form>
    `;
    return dialog;
  }

  private buildVisualReviewDialog(): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog webmcp-dialog webmcp-visual-review-dialog";
    dialog.dataset.testid = "webmcp-visual-review-dialog";
    dialog.setAttribute("aria-labelledby", "webmcp-visual-review-title");
    dialog.innerHTML = `
      <form method="dialog">
        <div class="webmcp-visual-review-heading">
          <div>
            <span class="eyebrow">Approved selection · AI can inspect now</span>
            <h2 id="webmcp-visual-review-title">Selected board visual</h2>
          </div>
          <div class="webmcp-visual-review-meta" aria-label="Visual selection summary">
            <span><strong data-webmcp-visual-review-count>0</strong> items</span>
            <span data-webmcp-visual-handwriting hidden></span>
            <span data-webmcp-visual-private-images hidden></span>
          </div>
        </div>
        <div class="webmcp-visual-surface" data-webmcp-visual-surface></div>
        <div class="webmcp-privacy-note"><span aria-hidden="true">✦</span><span>AI should mark uncertain handwriting as uncertain. Closing this review removes the shared visual from the live page and does not change the board.</span></div>
        <div class="dialog-actions"><button class="primary-button webmcp-primary-button" type="submit">Finish visual review</button></div>
      </form>
    `;
    return dialog;
  }

  private buildGuideDialog(): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog webmcp-dialog webmcp-guide-dialog";
    dialog.dataset.testid = "webmcp-guide-dialog";
    dialog.setAttribute("aria-labelledby", "webmcp-guide-title");
    dialog.innerHTML = `
      <form method="dialog">
        <span class="webmcp-dialog-mark" aria-hidden="true">✦</span>
        <span class="eyebrow">Shared thinking, not private tutoring</span>
        <h2 id="webmcp-guide-title">Invite the AI into the class conversation</h2>
        <p>Keep this board content selected, then ask ChatGPT in the built-in browser to use SpaceScale's site tools.</p>
        <div class="webmcp-prompt-card">
          <span>Try asking</span>
          <p>“If these are typed notes, read the selected class ideas. If they include handwriting or a sketch, inspect the selected board visual. Find two connections, one productive tension, and a question that helps the class move forward.”</p>
        </div>
        <p class="webmcp-guide-note">SpaceScale will ask before sharing either exact anonymized text or an isolated visual preview. Unselected board content stays hidden.</p>
        <div class="dialog-actions"><button class="primary-button webmcp-primary-button" type="submit">Got it</button></div>
      </form>
    `;
    return dialog;
  }
}

function buildVisualPreview(items: readonly BoardItem[]): {
  image: HTMLImageElement;
  objectUrl: string;
} {
  const preview = serializeVisualPreview(items);
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${preview.viewBox}" role="img" aria-label="${preview.ariaLabel}">${preview.content}</svg>`;
  const objectUrl = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  const image = document.createElement("img");
  image.alt = preview.ariaLabel;
  image.dataset.visualScope = "teacher-selected-items-only";
  image.src = objectUrl;
  return { image, objectUrl };
}

export function serializeVisualPreview(items: readonly BoardItem[]): {
  viewBox: string;
  ariaLabel: string;
  content: string;
} {
  if (items.length === 0) throw new Error("A visual preview needs at least one item.");
  const sanitized = items
    .map((item, index) => {
      const normalized = normalizeBoardItem(item);
      const sanitized = {
        ...normalized,
        id: visualAlias(index),
        createdBy: "shared-visual",
      };
      return sanitized.kind === "image"
        ? {
            ...sanitized,
            geometry: { ...sanitized.geometry, alt: "Private image not shared" },
          }
        : sanitized;
    })
    .sort((left, right) => left.z - right.z);
  const bounds = boundsForItems(sanitized);
  if (bounds === null) throw new Error("The selected visual has no renderable bounds.");
  const width = Math.max(1, boundsWidth(bounds));
  const height = Math.max(1, boundsHeight(bounds));
  const padding = Math.max(18, Math.min(72, Math.min(width, height) * 0.08));
  const minX = bounds.minX - padding;
  const minY = bounds.minY - padding;
  const viewWidth = width + padding * 2;
  const viewHeight = height + padding * 2;
  return {
    viewBox: `${minX} ${minY} ${viewWidth} ${viewHeight}`,
    ariaLabel: `Teacher-approved board visual containing ${items.length} selected item${items.length === 1 ? "" : "s"}`,
    content: `<rect x="${minX}" y="${minY}" width="${viewWidth}" height="${viewHeight}" fill="#ffffff"/>${sanitized.map(renderSvgItem).join("")}`,
  };
}

function visualAlias(index: number): string {
  return `visual_${index + 1}`;
}

export function visualSelectionIsFresh(
  left: readonly BoardItem[],
  right: readonly BoardItem[],
): boolean {
  if (left.length !== right.length) return false;
  const versions = new Map(left.map((item) => [item.id, item.version]));
  return right.every((item) => versions.get(item.id) === item.version);
}

function countKinds(items: readonly BoardItem[]): Partial<Record<BoardItem["kind"], number>> {
  const counts: Partial<Record<BoardItem["kind"], number>> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

function humanizeItemKind(kind: BoardItem["kind"], count: number): string {
  const label =
    kind === "pencil"
      ? "handwriting / pencil stroke"
      : kind === "sticky"
        ? "sticky note"
        : kind === "image"
          ? "private image placeholder"
          : kind;
  return count === 1 ? label : `${label}s`;
}

function trimSnapshots<T>(snapshots: Map<string, T>): void {
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    snapshots.delete(oldest);
  }
}
