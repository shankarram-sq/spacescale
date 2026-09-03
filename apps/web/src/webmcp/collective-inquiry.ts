import "./collective-inquiry.css";

import { boundsForItems, boundsHeight, boundsWidth } from "@collab/geometry";
import { normalizeBoardItem } from "@collab/protocol";
import { renderSvgItem } from "@collab/svg-export";
import type { BoardItem, ServerAction } from "../types";
import { PROBLEM_STEP_WATCH_TOOL, ProblemStepWatchFeed } from "./problem-step-watch";
import { trimSnapshots, WEBMCP_MATHJAX_GUIDANCE, WEBMCP_TEXT_RENDERING_CAPABILITY } from "./shared";

const READ_SELECTION_TOOL = "read_selected_class_ideas";
const INSPECT_VISUAL_TOOL = "inspect_selected_board_visual";
const INSPIRE_SELECTION_TOOL = "inspire_from_selected_ideas";
const EXPLAIN_SELECTION_TOOL = "explain_selected_ideas";
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

export type CollectiveInquiryWebMcpOptions = {
  root: HTMLElement;
  getSelectedItems: () => BoardItem[] | null;
  getAuthoritativeItem: (itemId: string) => BoardItem | undefined;
  getSequence: () => number;
  getParticipantDisplayName: (participantId: string) => string | null;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

export class CollectiveInquiryWebMcp {
  private readonly visualReviewDialog: HTMLDialogElement;
  private readonly problemStepWatch: ProblemStepWatchFeed;
  private readonly snapshots = new Map<string, CollectiveInquirySnapshot>();
  private readonly registration = new AbortController();
  private destroyed = false;
  private visualObjectUrl: string | null = null;

  constructor(private readonly options: CollectiveInquiryWebMcpOptions) {
    this.problemStepWatch = new ProblemStepWatchFeed({
      getSelectedItems: options.getSelectedItems,
      getAuthoritativeItem: options.getAuthoritativeItem,
      getSequence: options.getSequence,
      getParticipantDisplayName: options.getParticipantDisplayName,
    });
    this.visualReviewDialog = this.buildVisualReviewDialog();
    options.root.append(this.visualReviewDialog);
    this.visualReviewDialog.addEventListener("close", this.clearVisualReview);
    void this.register();
  }

  getSnapshot(token: string): CollectiveInquirySnapshot | undefined {
    return this.snapshots.get(token);
  }

  recordAuthoritativeAction(action: ServerAction, changedIds: ReadonlySet<string>): void {
    this.problemStepWatch.recordAuthoritativeAction(action, changedIds);
  }

  recordAuthoritativeReload(seq: number): void {
    this.problemStepWatch.recordAuthoritativeReload(seq);
  }

  destroy(): void {
    this.destroyed = true;
    this.registration.abort();
    this.problemStepWatch.destroy();
    this.visualReviewDialog.removeEventListener("close", this.clearVisualReview);
    this.clearVisualReview();
    this.visualReviewDialog.close();
    this.visualReviewDialog.remove();
  }

  private async register(): Promise<void> {
    if (this.destroyed) return;
    const modelContext = document.modelContext;
    if (typeof modelContext?.registerTool !== "function") return;
    try {
      await modelContext.registerTool(
        {
          name: READ_SELECTION_TOOL,
          description:
            "Read only the saved sticky-note ideas selected in this browser on the live SpaceScale canvas. Use this before expanding, connecting, challenging, clustering, deciding from, or acting on the group's ideas. Each contribution includes its creator's board-visible display name and stable participant ID so the action can be attributed correctly. Board IDs, item IDs, positions, sections, presence, history, authentication data, and unselected content are not returned.",
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
          name: INSPIRE_SELECTION_TOOL,
          description: `Read only the saved sticky notes selected in this browser and return guidance for proposing fresh, source-grounded ideas, analogies, combinations, and next questions without overwriting or ranking the original contributions. Use this when a participant asks for inspiration. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (_input, { signal }) => this.readSelectedIdeas(signal, "inspire"),
        },
        { signal: this.registration.signal },
      );
      await modelContext.registerTool(
        {
          name: PROBLEM_STEP_WATCH_TOOL,
          description: `Start, continue, or stop a 15-minute read-only watch of the exact saved text items selected in this browser. Use this when a participant asks for real-time feedback while working through a problem. First call with action start. Briefly comment on every returned change, then call action wait again with the returned watchToken and nextSeq; repeat after timeouts until the watch expires or the participant asks to stop. Each wait returns once and lasts at most 20 seconds and reports status changed, timeout, resync, stopped, expired, or replaced; every status except changed, timeout and resync ends the watch, and resync carries a fresh snapshot after the board reloaded. The watch never includes unsaved keystrokes, other contents of a selected Section, unselected content, stable item IDs, coordinates, presence, or history. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["start", "wait", "stop"],
                description:
                  "Start from the current saved browser selection, wait for the next saved change, or stop the watch.",
              },
              watchToken: {
                type: "string",
                maxLength: 128,
                description: "Opaque token returned by action start. Required for wait and stop.",
              },
              afterSeq: {
                type: "integer",
                minimum: 0,
                description: "The nextSeq returned by the previous start or wait result.",
              },
              waitMs: {
                type: "integer",
                minimum: 1_000,
                maximum: 20_000,
                default: 15_000,
                description:
                  "How long one wait call may remain pending before returning a timeout.",
              },
            },
            required: ["action"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: (input, { signal }) => this.problemStepWatch.execute(input, signal),
        },
        { signal: this.registration.signal },
      );
      await modelContext.registerTool(
        {
          name: EXPLAIN_SELECTION_TOOL,
          description: `Read only the saved sticky notes selected in this browser and return guidance for explaining their meaning clearly, defining terms, unpacking reasoning, and identifying ambiguities without inventing unsupported claims. Use this when a participant asks what selected writing means. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: async (_input, { signal }) => this.readSelectedIdeas(signal, "explain"),
        },
        { signal: this.registration.signal },
      );
      await modelContext.registerTool(
        {
          name: INSPECT_VISUAL_TOOL,
          description:
            "Make only the saved board items selected in this browser available for visual inspection in an isolated live-page preview. Use this to analyze handwriting, sketches, spatial groupings, arrows, shapes, or mixed visual notes that cannot be understood from text alone. SpaceScale masks the unselected board, replaces stable item IDs with ephemeral aliases, returns each creator's board-visible display name and stable participant ID for action attribution, returns no coordinates, and renders private image cards as placeholders rather than exposing their pixels.",
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
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The WebMCP collaboration tools could not be registered.", "warning");
    }
  }

  private async inspectSelectedVisual(signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const selection = this.visualSelection();
    if (selection.issue) throw new Error(selection.issue);
    if (selection.items.length === 0) {
      throw new Error("Select one or more saved board items first.");
    }

    const capturedAt = new Date().toISOString();
    const sharedItems = selection.items.map((item, index) => ({
      alias: visualAlias(index),
      kind: item.kind,
      action: { type: "created" as const, objectKind: item.kind },
      createdBy: this.participant(item.createdBy),
    }));

    const kindCounts = countKinds(selection.items);
    await this.showVisualReview(selection.items, kindCounts);
    this.options.notify(
      `${selection.items.length} selected visual item${selection.items.length === 1 ? " is" : "s are"} ready for inspection.`,
      "info",
    );
    return {
      capturedAt,
      visualReady: true,
      preview: {
        state: "open_in_live_page",
        scope: "browser_selected_saved_items_only",
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
          "Label uncertain handwriting explicitly and ask a participant to clarify instead of inventing text.",
        collaboration:
          "Use creator identity only to attribute a visible action or ask the right participant for clarification. Do not grade, profile, rank, or infer ability, intent, or participation quality from attribution.",
      },
      privacy:
        "Only the browser-selected items, their board-visible creator names, and stable participant IDs are shared. Board and item IDs, coordinates, history, presence, authentication data, unselected board content, and private image pixels are not exposed.",
    };
  }

  private async readSelectedIdeas(
    signal: AbortSignal,
    purpose: "read" | "inspire" | "explain" = "read",
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
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
    trimSnapshots(this.snapshots, MAX_SNAPSHOTS);

    this.options.notify(
      `${ideas.length} selected contribution${ideas.length === 1 ? " is" : "s are"} ready for collaboration.`,
      "info",
    );
    return {
      selectionToken: token,
      capturedAt: snapshot.capturedAt,
      contributions: ideas,
      purpose,
      responseGuidance:
        purpose === "inspire"
          ? {
              action:
                "Offer several genuinely different possibilities grounded in the selected aliases. Include at least one unexpected connection and one question that could unlock another idea.",
              distinguishSourceFromSuggestion: true,
              preserveOriginalContributions: true,
              avoid: "Do not present a suggestion as something a participant already said.",
            }
          : purpose === "explain"
            ? {
                action:
                  "Explain the selected writing in plain language, preserve equations and notation, define important terms, and separate explicit claims from reasonable interpretation.",
                citeSourceAliases: true,
                surfaceAmbiguity: true,
                avoid:
                  "Do not silently fill gaps or claim intent that the selected text does not support.",
              }
            : undefined,
      textRendering: WEBMCP_TEXT_RENDERING_CAPABILITY,
      collaborationGuidance: {
        purpose:
          "Help the class build on these contributions together. Surface bridges, tensions, assumptions, missing perspectives, and useful next questions.",
        preserveDissent: true,
        avoid:
          "Use identity only for accurate action attribution or a relevant clarification. Do not rank students, infer participation quality or ability, profile individuals, or claim consensus.",
      },
      privacy:
        "This result contains only browser-selected sticky-note text, ephemeral idea aliases, board-visible creator names, and stable participant IDs. Board and item IDs, coordinates, sections, unselected board content, presence, history, authentication data, and contact details were not shared.",
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
        issue: `Select ${MAX_SHARED_IDEAS} ideas or fewer for one collaboration turn.`,
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
        issue: `Select ${MAX_SHARED_VISUAL_ITEMS} visual items or fewer for one inspection.`,
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

  private buildVisualReviewDialog(): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog webmcp-dialog webmcp-visual-review-dialog";
    dialog.dataset.testid = "webmcp-visual-review-dialog";
    dialog.setAttribute("aria-labelledby", "webmcp-visual-review-title");
    dialog.innerHTML = `
      <form method="dialog">
        <div class="webmcp-visual-review-heading">
          <div>
            <span class="eyebrow">Selected visual inspection</span>
            <h2 id="webmcp-visual-review-title">Selected board visual</h2>
          </div>
          <div class="webmcp-visual-review-meta" aria-label="Visual selection summary">
            <span><strong data-webmcp-visual-review-count>0</strong> items</span>
            <span data-webmcp-visual-handwriting hidden></span>
            <span data-webmcp-visual-private-images hidden></span>
          </div>
        </div>
        <div class="webmcp-visual-surface" data-webmcp-visual-surface></div>
        <div class="webmcp-privacy-note"><span aria-hidden="true">◎</span><span>Mark uncertain handwriting as uncertain. Closing this review removes the visual from the live page and does not change the board.</span></div>
        <div class="dialog-actions"><button class="primary-button webmcp-primary-button" type="submit">Finish visual review</button></div>
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
  image.dataset.visualScope = "browser-selected-items-only";
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
    ariaLabel: `Board visual containing ${items.length} browser-selected item${items.length === 1 ? "" : "s"}`,
    content: `<rect x="${minX}" y="${minY}" width="${viewWidth}" height="${viewHeight}" fill="#ffffff"/>${sanitized.map(renderSvgItem).join("")}`,
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
