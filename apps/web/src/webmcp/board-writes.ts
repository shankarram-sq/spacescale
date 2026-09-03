import { COORDINATE_LIMIT } from "@collab/geometry";
import {
  ASSIST_ACTIONS,
  type AssistAction,
  type Assistance,
  MAX_IMAGE_ALT_CODE_POINTS,
  MAX_STICKY_TEXT_CODE_POINTS,
} from "@collab/protocol";
import { VIDEO_EMBED_HEIGHT, VIDEO_EMBED_WIDTH, videoEmbedFromText } from "../board/links";
import {
  buildImageCreateOperation,
  buildStickyCreateOperation,
  type ImageAssetMetadata,
} from "../tools/controller";
import type {
  BatchItemOperation,
  BoardItem,
  DurableOperation,
  NewBoardItem,
  Point,
  TextFontFamily,
} from "../types";
import { createId, roundBoard } from "../types";
import {
  enumValue,
  isRecord,
  registerWebMcpTool,
  requiredText,
  WEBMCP_MATHJAX_GUIDANCE,
} from "./shared";

export const INSERT_COMMENT_TOOL = "insert_comment";
export const INSERT_STICKY_TOOL = "insert_sticky";
export const INSERT_IMAGE_TOOL = "insert_image";
export const INSERT_VIDEO_TOOL = "insert_video";

/** Matches the edge's comment limit, counted in code points like the server does. */
const MAX_COMMENT_CODE_POINTS = 2_000;
/**
 * How many comments this page will write outside a watch before it refuses.
 *
 * A watch-targeted comment is already bounded by the watch's own cap, which the target
 * resolution enforces. The location and selection forms have no such anchor, and the board
 * itself only stops at 10,000 comments, so a host that loops or retries could bury a class's
 * work. This is deliberately generous for a lesson and finite for a runaway caller.
 */
const MAX_UNWATCHED_COMMENTS = 50;
/**
 * A generated PNG, JPEG, WebP or GIF arrives as a data URL rather than a link: SpaceScale never
 * fetches an external image. Base64 costs a third over the bytes, and the board's own upload
 * ceiling is 5 MiB, so this bounds the string a host may send before any decoding happens.
 */
const MAX_INLINE_IMAGE_DATA_URL_LENGTH = 7_100_000;

/** The sticky palette a host may pick from, named rather than given as free-form hex. */
export const STICKY_FILLS = {
  yellow: "#ffe299",
  coral: "#ffafa3",
  lavender: "#d3bdff",
  mint: "#b3efbd",
  sky: "#a8daff",
  slate: "#afbccf",
} as const;

export type StickyFillName = keyof typeof STICKY_FILLS;

/** The board styles a write inherits from this participant when the call does not override them. */
export type BoardWriteStyle = {
  stickyFill: string;
  stickyTextColor: string;
  stickyFontSize: number;
  stickyOpacity: number;
  textColor: string;
  textFontSize: number;
  textFontFamily: TextFontFamily;
  textOpacity: number;
};

/**
 * A step of a live board watch, resolved to something a comment can attach to. The watch
 * deliberately returns no coordinates, so this is how a reply plan names its target without one.
 */
export type WatchedStepTarget = {
  itemId: string;
  action?: AssistAction;
  /** Must be called exactly once; `posted` counts the comment against the watch's cap. */
  release: (posted: boolean) => void;
};

export type BoardWriteWebMcpOptions = {
  /** Whether this browser's participant may add objects to the board. */
  canWrite: () => boolean;
  /** Whether this browser's participant may post object comments. */
  canComment: () => boolean;
  /** Whether this Space allows image cards at all. */
  imagesEnabled: () => boolean;
  /** Why this Space cannot take an object of this kind, or null when it can. */
  featureIssue: (kind: "sticky" | "image" | "video") => string | null;
  /** The board styles this participant is currently drawing with. */
  getStyle: () => BoardWriteStyle;
  /** Board coordinates a write lands on when the call names no location. */
  getPlacementCenter: () => Point;
  /** The topmost saved object covering a board point, for a comment that names a location. */
  itemAt: (point: Point) => BoardItem | undefined;
  /** The one saved object selected in this browser, when exactly one is. */
  getSelectedItem: () => BoardItem | null;
  /** Resolves a live watch's step alias to a comment target, or throws saying why it cannot. */
  resolveWatchedStep?: (
    watchToken: string,
    stepAlias: string,
    action?: AssistAction,
  ) => WatchedStepTarget;
  commit: (operation: DurableOperation) => Promise<boolean>;
  /** Posts a comment as this browser's participant, tagged with the writing tool. */
  createComment: (itemId: string, body: string, assistance: Assistance) => Promise<void>;
  /** Sanitizes and privately stores one inline image, returning what an image card needs. */
  storeImage: (imageDataUrl: string, signal: AbortSignal) => Promise<ImageAssetMetadata>;
  /** Selects what was just written, as the board's own insert paths do. */
  revealItems: (itemIds: readonly string[]) => void;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

const LOCATION_SCHEMA = {
  type: "object",
  description:
    "Where on the board to write, in board coordinates. Omit to land at the centre of this participant's current view.",
  properties: {
    x: { type: "number", minimum: -COORDINATE_LIMIT, maximum: COORDINATE_LIMIT },
    y: { type: "number", minimum: -COORDINATE_LIMIT, maximum: COORDINATE_LIMIT },
  },
  required: ["x", "y"],
  additionalProperties: false,
} as const;

/**
 * The board's generic write surface: one object of one kind per call, placed where the caller
 * asks. Each write goes in as one ordinary realtime command, tagged as written by AI, with the
 * same undo, section membership, and permission checks a participant's own insert gets. The
 * caller's WebMCP permission is the approval; there is no separate preview to accept.
 */
export class BoardWriteWebMcp {
  private readonly registration = new AbortController();
  /** Comments written through the location and selection forms in this page's lifetime. */
  private unwatchedComments = 0;
  /** One comment at a time, so concurrent calls cannot race past the cap together. */
  private commentInFlight = false;

  constructor(private readonly options: BoardWriteWebMcpOptions) {
    void this.register();
  }

  destroy(): void {
    this.registration.abort();
  }

  private async register(): Promise<void> {
    const modelContext = document.modelContext;
    if (typeof modelContext?.registerTool !== "function") return;
    try {
      await registerWebMcpTool(
        modelContext,
        {
          name: INSERT_COMMENT_TOOL,
          description: `Post one comment on a saved object on this board. Name the object in one of three ways: pass watchToken and stepAlias to comment on a step of a live board watch, which is what a watch's reply plan asks for and the only way to answer a request the watch delivered; or pass location, a board coordinate the object covers; or pass neither, which comments on the one object selected in this browser. The comment is attributed to this browser's participant, carries a small AI tag, renders MathJax, is limited to ${MAX_COMMENT_CODE_POINTS} characters, and can be resolved by the class like any other comment. A comment on a watched step counts against that watch's own cap; the location and selection forms are limited to ${MAX_UNWATCHED_COMMENTS} per page, and each result reports how many are left. Never grade, label, rank, or profile a participant. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: {
            type: "object",
            properties: {
              watchToken: {
                type: "string",
                maxLength: 128,
                description:
                  "Opaque token from watch_board, to comment on a step that watch reported. Pass stepAlias with it.",
              },
              stepAlias: {
                type: "string",
                pattern: "^step_(?:[1-9][0-9]{0,3}|10000)$",
                description: "The step_N alias of the watched step to comment on.",
              },
              action: {
                type: "string",
                enum: [...ASSIST_ACTIONS],
                description:
                  "The participant action this comment answers, copied from the reply plan. Omit for feedback on a changed step. Pass it whenever the plan names one: another request may have queued on the step since, and only this tells the board which one is being answered.",
              },
              location: LOCATION_SCHEMA,
              body: {
                type: "string",
                minLength: 1,
                maxLength: MAX_COMMENT_CODE_POINTS,
                description: "The comment. Plain text with optional TeX; no HTML.",
              },
            },
            required: ["body"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: (input, { signal }) => this.insertComment(input, signal),
        },
        { signal: this.registration.signal },
      );
      await registerWebMcpTool(
        modelContext,
        {
          name: INSERT_STICKY_TOOL,
          description: `Add one sticky note to this board at a location you choose. Pass the note's text and, optionally, a fill colour from the board's sticky palette. Text is limited to ${MAX_STICKY_TEXT_CODE_POINTS} characters and may be left empty for a participant to complete. The note lands as one ordinary realtime command, tagged as written by AI, with ordinary undo. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: {
            type: "object",
            properties: {
              location: LOCATION_SCHEMA,
              text: {
                type: "string",
                maxLength: MAX_STICKY_TEXT_CODE_POINTS,
                description:
                  "The note's text. Plain text with optional TeX; no HTML. Empty leaves the note blank for a participant to fill in.",
              },
              fill: {
                type: "string",
                enum: Object.keys(STICKY_FILLS),
                description:
                  "A colour from the board's sticky palette. Omit to use this participant's current sticky colour.",
              },
            },
            required: ["text"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: (input, { signal }) => this.insertSticky(input, signal),
        },
        { signal: this.registration.signal },
      );
      await registerWebMcpTool(
        modelContext,
        {
          name: INSERT_IMAGE_TOOL,
          description:
            "Add one image card to this board at a location you choose. Supply the picture itself as a PNG, JPEG, WebP or GIF data URL; SpaceScale never fetches an external image URL, and sanitizes and privately stores what you send in this board's own bucket. Give alt text describing what the picture shows. The card lands as one ordinary realtime command, tagged as written by AI, with ordinary undo. Never depict a real participant or target an individual.",
          inputSchema: {
            type: "object",
            properties: {
              location: LOCATION_SCHEMA,
              imageDataUrl: {
                type: "string",
                maxLength: MAX_INLINE_IMAGE_DATA_URL_LENGTH,
                description:
                  "The picture as a data URL, for example data:image/png;base64,.... External URLs are refused.",
              },
              alt: {
                type: "string",
                minLength: 1,
                maxLength: MAX_IMAGE_ALT_CODE_POINTS,
                description: "What the picture shows, for participants who cannot see it.",
              },
            },
            required: ["imageDataUrl", "alt"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: (input, { signal }) => this.insertImage(input, signal),
        },
        { signal: this.registration.signal },
      );
      await registerWebMcpTool(
        modelContext,
        {
          name: INSERT_VIDEO_TOOL,
          description:
            "Embed one YouTube or Vimeo video on this board at a location you choose. Pass the complete HTTPS video link; SpaceScale plays it through a privacy-conscious embed. Only link a video you are confident exists and is appropriate for the class. The embed lands as one ordinary realtime command, tagged as written by AI, with ordinary undo.",
          inputSchema: {
            type: "object",
            properties: {
              location: LOCATION_SCHEMA,
              url: {
                type: "string",
                maxLength: 2_048,
                description: "A complete HTTPS YouTube or Vimeo video link.",
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: (input, { signal }) => this.insertVideo(input, signal),
        },
        { signal: this.registration.signal },
      );
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The board write tools could not be registered.", "warning");
    }
  }

  private async insertComment(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!isRecord(input)) throw new Error("Comment input must be an object.");
    if (typeof input.body !== "string") throw new Error("body must be text.");
    const body = input.body.trim();
    const characters = [...body].length;
    if (characters === 0 || characters > MAX_COMMENT_CODE_POINTS) {
      throw new Error(`body must contain 1-${MAX_COMMENT_CODE_POINTS} characters.`);
    }
    if (!this.options.canComment()) {
      throw new Error("This browser cannot comment on this Space.");
    }
    if (this.commentInFlight) {
      throw new Error("Wait for the previous comment to finish before writing another.");
    }
    const watched = this.watchedTarget(input);
    signal.throwIfAborted();
    if (watched) {
      // The watch counts this against its own comment cap either way, so release exactly once.
      this.commentInFlight = true;
      try {
        await this.options.createComment(watched.target.itemId, body, {
          tool: INSERT_COMMENT_TOOL,
          ...(watched.target.action === undefined ? {} : { action: watched.target.action }),
        });
      } catch (error) {
        watched.target.release(false);
        throw error;
      } finally {
        this.commentInFlight = false;
      }
      watched.target.release(true);
      this.options.notify(`The AI assistant commented on ${watched.stepAlias}.`, "info");
      return this.commentResult({ stepAlias: watched.stepAlias, characters });
    }
    if (this.commentInFlight) {
      throw new Error("Wait for the previous comment to finish before writing another.");
    }
    if (this.unwatchedComments >= MAX_UNWATCHED_COMMENTS) {
      throw new Error(
        `This page has written its limit of ${MAX_UNWATCHED_COMMENTS} AI comments outside a board watch. Comment on a watched step, or ask a participant to reload.`,
      );
    }
    const target = this.commentTarget(input.location);
    this.commentInFlight = true;
    try {
      await this.options.createComment(target.id, body, { tool: INSERT_COMMENT_TOOL });
    } finally {
      this.commentInFlight = false;
    }
    // Only a comment the board accepted counts, so a refusal cannot spend the budget.
    this.unwatchedComments += 1;
    this.options.notify("The AI assistant added a comment.", "info");
    return this.commentResult({
      objectKind: target.kind,
      characters,
      remainingUnwatchedComments: MAX_UNWATCHED_COMMENTS - this.unwatchedComments,
    });
  }

  private commentResult(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      status: "commented",
      ...extra,
      writtenBy: "ai",
      attribution:
        "The comment shows this browser's participant as its author with a small AI tag, like every AI-written object on the board.",
      privacy:
        "Only the comment text left the conversation. No board, item, or participant identifiers were returned.",
    };
  }

  /**
   * Resolves the watch-step form of a comment target, or undefined when the call does not use
   * it. A watch reports steps by alias and returns no coordinates, so this is the only way to
   * answer a request about a step the participant did not leave selected.
   */
  private watchedTarget(
    input: Record<string, unknown>,
  ): { target: WatchedStepTarget; stepAlias: string } | undefined {
    if (input.watchToken === undefined && input.stepAlias === undefined) return undefined;
    const watchToken = requiredText(input.watchToken, "watchToken", 128);
    const stepAlias = requiredText(input.stepAlias, "stepAlias", 16);
    if (!/^step_(?:[1-9][0-9]{0,3}|10000)$/u.test(stepAlias)) {
      throw new Error("stepAlias must look like step_1.");
    }
    const action =
      input.action === undefined ? undefined : enumValue(input.action, ASSIST_ACTIONS, "action");
    const resolve = this.options.resolveWatchedStep;
    if (!resolve) throw new Error("This browser cannot comment on a watched step.");
    return { target: resolve(watchToken, stepAlias, action), stepAlias };
  }

  /** The object a comment attaches to: the one under the given point, else the lone selection. */
  private commentTarget(location: unknown): BoardItem {
    if (location !== undefined) {
      const point = boardPoint(location);
      const hit = this.options.itemAt(point);
      if (!hit) {
        throw new Error(
          `No saved object covers ${point[0]}, ${point[1]}. Comments attach to an object, so name a location on one.`,
        );
      }
      return hit;
    }
    const selected = this.options.getSelectedItem();
    if (!selected) {
      throw new Error(
        "Name the object to comment on: pass watchToken and stepAlias for a watched step, or a location on it, or select exactly one saved object in this browser first.",
      );
    }
    return selected;
  }

  private async insertSticky(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!isRecord(input)) throw new Error("Sticky input must be an object.");
    this.requireWritable("sticky");
    if (typeof input.text !== "string") throw new Error("text must be text.");
    const text = input.text.trim();
    if ([...text].length > MAX_STICKY_TEXT_CODE_POINTS) {
      throw new Error(`text must contain at most ${MAX_STICKY_TEXT_CODE_POINTS} characters.`);
    }
    const fill = stickyFill(input.fill);
    const style = this.options.getStyle();
    const point = this.placement(input.location);
    const itemId = createId();
    const created = createdItem(
      buildStickyCreateOperation(
        itemId,
        point,
        {
          stickyFill: fill ?? style.stickyFill,
          stickyTextColor: style.stickyTextColor,
          stickyFontSize: style.stickyFontSize,
          stickyOpacity: style.stickyOpacity,
        },
        text,
      ),
      "sticky note",
    );
    await this.write(created, signal, "The sticky note could not be queued for saving.");
    this.options.revealItems([itemId]);
    this.options.notify("Sticky note added.", "info");
    return this.writeResult("sticky", point, { characters: [...text].length });
  }

  private async insertImage(input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!isRecord(input)) throw new Error("Image input must be an object.");
    this.requireWritable("image");
    if (!this.options.imagesEnabled()) throw new Error("Image cards are disabled for this Space.");
    if (typeof input.imageDataUrl !== "string") throw new Error("imageDataUrl must be text.");
    const imageDataUrl = input.imageDataUrl.trim();
    if (!imageDataUrl.startsWith("data:image/")) {
      throw new Error(
        "imageDataUrl must be an inline data URL such as data:image/png;base64,.... SpaceScale never fetches an external image.",
      );
    }
    if (imageDataUrl.length > MAX_INLINE_IMAGE_DATA_URL_LENGTH) {
      throw new Error("That image is larger than this board accepts. Send a smaller one.");
    }
    if (typeof input.alt !== "string") throw new Error("alt must be text.");
    const alt = input.alt.trim();
    const altCharacters = [...alt].length;
    if (altCharacters === 0 || altCharacters > MAX_IMAGE_ALT_CODE_POINTS) {
      throw new Error(`alt must contain 1-${MAX_IMAGE_ALT_CODE_POINTS} characters.`);
    }
    const point = this.placement(input.location);

    const asset = await this.options.storeImage(imageDataUrl, signal);
    signal.throwIfAborted();
    // Permission can change while the upload is in flight; the card is what needs the check.
    this.requireWritable("image");
    if (!this.options.imagesEnabled()) {
      throw new Error("The image was stored, but image cards were disabled before it could land.");
    }
    const itemId = createId();
    const created = createdItem(buildImageCreateOperation(itemId, point, asset), "image card");
    if (created.kind !== "image") throw new Error("The image card could not be prepared.");
    created.geometry = { ...created.geometry, alt };
    await this.write(created, signal, "The image was stored, but its card could not be queued.");
    this.options.revealItems([itemId]);
    this.options.notify("Image added.", "info");
    return this.writeResult("image", point, { altCharacters });
  }

  private async insertVideo(input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!isRecord(input)) throw new Error("Video input must be an object.");
    this.requireWritable("video");
    if (typeof input.url !== "string") throw new Error("url must be text.");
    const video = videoEmbedFromText(input.url);
    if (!video) throw new Error("url must be a complete HTTPS YouTube or Vimeo video link.");
    const style = this.options.getStyle();
    const point = this.placement(input.location);
    const itemId = createId();
    await this.write(
      {
        id: itemId,
        kind: "text",
        style: {
          kind: "text",
          color: style.textColor,
          fontSize: style.textFontSize,
          fontFamily: style.textFontFamily,
          opacity: style.textOpacity,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: roundBoard(point[0] - VIDEO_EMBED_WIDTH / 2),
          y: roundBoard(point[1] - VIDEO_EMBED_HEIGHT / 2 + style.textFontSize),
          text: video.sourceUrl,
          embed: "video",
        },
      },
      signal,
      "The video embed could not be queued for saving.",
    );
    this.options.revealItems([itemId]);
    this.options.notify("Video embedded.", "info");
    return this.writeResult("video", point, { provider: video.provider });
  }

  private requireWritable(kind: "sticky" | "image" | "video"): void {
    if (!this.options.canWrite()) {
      throw new Error("This browser needs board edit access to write to this Space.");
    }
    const issue = this.options.featureIssue(kind);
    if (issue) throw new Error(issue);
  }

  /** Sends one create as an AI-attributed command and waits for the board to acknowledge it. */
  private async write(item: NewBoardItem, signal: AbortSignal, failure: string): Promise<void> {
    signal.throwIfAborted();
    const accepted = await this.options.commit({
      kind: "item.create",
      item: { ...item, assistedBy: "ai" } as NewBoardItem,
    });
    if (!accepted) throw new Error(failure);
  }

  private placement(location: unknown): Point {
    if (location === undefined) {
      const [x, y] = this.options.getPlacementCenter();
      return [roundBoard(x), roundBoard(y)];
    }
    return boardPoint(location);
  }

  private writeResult(
    objectKind: string,
    point: Point,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      status: "inserted",
      objectKind,
      location: { x: point[0], y: point[1] },
      ...extra,
      changedCanvas: true,
      aiAttributed: true,
      undoable: true,
      message:
        "Added as one acknowledged realtime command, tagged as written by AI, and undoable by any participant.",
      privacy:
        "Only what you supplied was written to the board. No board, item, or participant identifiers were returned.",
    };
  }
}

function stickyFill(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(value in STICKY_FILLS)) {
    throw new Error(`fill must be one of: ${Object.keys(STICKY_FILLS).join(", ")}.`);
  }
  return STICKY_FILLS[value as StickyFillName];
}

function boardPoint(value: unknown): Point {
  if (!isRecord(value)) throw new Error("location must be an object with x and y.");
  return [boardCoordinate(value.x, "location.x"), boardCoordinate(value.y, "location.y")];
}

function boardCoordinate(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  if (Math.abs(value) > COORDINATE_LIMIT) {
    throw new Error(`${field} must be between -${COORDINATE_LIMIT} and ${COORDINATE_LIMIT}.`);
  }
  return roundBoard(value);
}

/** Unwraps a create the board's own insert helpers built, so the item can be adjusted and tagged. */
function createdItem(operation: BatchItemOperation, label: string): NewBoardItem {
  if (operation.kind !== "item.create") throw new Error(`The ${label} could not be prepared.`);
  return operation.item;
}
