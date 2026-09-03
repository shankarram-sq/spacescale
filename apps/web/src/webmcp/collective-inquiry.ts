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
  private readonly visualReviewDialog: HTMLDialogElement;
  private readonly guideDialog: HTMLDialogElement;
  private readonly snapshots = new Map<string, CollectiveInquirySnapshot>();
  private readonly visualSnapshots = new Map<string, VisualSelectionSnapshot>();
  private readonly registration = new AbortController();
  private destroyed = false;
  private visualObjectUrl: string | null = null;

  constructor(private readonly options: CollectiveInquiryWebMcpOptions) {
    this.visualReviewDialog = this.buildVisualReviewDialog();
    this.guideDialog = this.buildGuideDialog();
    options.root.append(this.visualReviewDialog, this.guideDialog);
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
    this.visualReviewDialog.close();
    this.guideDialog.close();
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
            "Read the saved sticky-note ideas currently selected on the live SpaceScale canvas. Use this before expanding, connecting, challenging, clustering, deciding from, or acting on the class's ideas. The result is returned immediately with no in-app prompt. Each contribution includes its text, its creator's display name, and the creator's stable participant ID so actions can be attributed correctly. Unselected content is not returned.",
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
            "Open the currently selected, saved board items in an isolated live-page preview for visual inspection. Use this to analyze handwriting, sketches, spatial groupings, arrows, shapes, or mixed visual notes that cannot be understood from text alone. The preview opens immediately with no in-app prompt. SpaceScale renders only the selected items, replaces item IDs with ephemeral aliases, and returns each creator's display name and stable participant ID for attribution.",
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
    if (this.visualReviewDialog.open) {
      throw new Error("Finish the current visual review before sharing another selection.");
    }
    const selection = this.visualSelection();
    if (selection.issue) throw new Error(selection.issue);
    if (selection.items.length === 0) {
      throw new Error("Select one or more saved board items first.");
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
        scope: "selected_saved_items_only",
        itemCount: selection.items.length,
        itemKinds: kindCounts,
        containsHandwriting: (kindCounts.pencil ?? 0) > 0,
        imagesRenderedAsPlaceholders: kindCounts.image ?? 0,
        aliases: sharedItems,
      },
      inspectionGuidance: {
        action:
          "Inspect the isolated visual preview now. Transcribe or analyze only marks that are visibly supported.",
        uncertainty:
          "Label uncertain handwriting explicitly and ask the teacher to clarify instead of inventing text.",
        collaboration:
          "Use creator identity to attribute actions or ask the right participant for clarification. Do not grade, rank, or infer ability from attribution.",
      },
      scope:
        "The preview contains the selected items, their creators' display names, and stable participant IDs. Image cards render as placeholders with their alt text. Unselected board content is not included.",
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
    trimSnapshots(this.snapshots);

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
          "Use identity for accurate attribution or relevant clarification. Do not rank students, infer ability, or claim consensus.",
      },
      scope:
        "This result contains the selected sticky-note text, ephemeral idea aliases, creator display names, and stable participant IDs. Unselected board content is not included.",
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

  private async showVisualReview(
    items: readonly BoardItem[],
    kindCounts: Readonly<Partial<Record<BoardItem["kind"], number>>>,
  ): Promise<void> {
    const surface = this.visualReviewDialog.querySelector<HTMLElement>(
      "[data-webmcp-visual-surface]",
    );
    if (!surface) throw new Error("The visual review surface is unavailable.");
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
    const images = this.visualReviewDialog.querySelector<HTMLElement>(
      "[data-webmcp-visual-images]",
    );
    if (images) {
      const imageCount = kindCounts.image ?? 0;
      images.hidden = imageCount === 0;
      images.textContent = `${imageCount} image${imageCount === 1 ? "" : "s"} shown as ${imageCount === 1 ? "a placeholder" : "placeholders"}`;
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

  private buildVisualReviewDialog(): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog webmcp-dialog webmcp-visual-review-dialog";
    dialog.dataset.testid = "webmcp-visual-review-dialog";
    dialog.setAttribute("aria-labelledby", "webmcp-visual-review-title");
    dialog.innerHTML = `
      <form method="dialog">
        <div class="webmcp-visual-review-heading">
          <div>
            <span class="eyebrow">Selected items · AI can inspect now</span>
            <h2 id="webmcp-visual-review-title">Selected board visual</h2>
          </div>
          <div class="webmcp-visual-review-meta" aria-label="Visual selection summary">
            <span><strong data-webmcp-visual-review-count>0</strong> items</span>
            <span data-webmcp-visual-handwriting hidden></span>
            <span data-webmcp-visual-images hidden></span>
          </div>
        </div>
        <div class="webmcp-visual-surface" data-webmcp-visual-surface></div>
        <div class="webmcp-note"><span aria-hidden="true">✦</span><span>AI should mark uncertain handwriting as uncertain. Closing this review removes the preview from the live page and does not change the board.</span></div>
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
        <p class="webmcp-guide-note">SpaceScale shares the selected text or an isolated visual preview straight away. Changes the AI makes land on the shared canvas as one undoable update.</p>
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
  image.dataset.visualScope = "selected-items-only";
  image.src = objectUrl;
  return { image, objectUrl };
}

export function serializeVisualPreview(items: readonly BoardItem[]): {
  viewBox: string;
  ariaLabel: string;
  content: string;
} {
  if (items.length === 0) throw new Error("A visual preview needs at least one item.");
  const aliased = items
    .map((item, index) => ({
      ...normalizeBoardItem(item),
      id: visualAlias(index),
      createdBy: "shared-visual",
    }))
    .sort((left, right) => left.z - right.z);
  const bounds = boundsForItems(aliased);
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
    ariaLabel: `Board visual containing ${items.length} selected item${items.length === 1 ? "" : "s"}`,
    content: `<rect x="${minX}" y="${minY}" width="${viewWidth}" height="${viewHeight}" fill="#ffffff"/>${aliased.map(renderSvgItem).join("")}`,
  };
}

function visualAlias(index: number): string {
  return `visual_${index + 1}`;
}

function countKinds(items: readonly BoardItem[]): Partial<Record<BoardItem["kind"], number>> {
  const counts: Partial<Record<BoardItem["kind"], number>> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

function trimSnapshots<T>(snapshots: Map<string, T>): void {
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    snapshots.delete(oldest);
  }
}
