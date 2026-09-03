import {
  buildCollectiveInquiryMap,
  type CollectiveInquiryBatch,
  CollectiveInquiryError,
  type CollectiveInquiryProposal,
} from "../activities/collective-inquiry";
import type { Bounds } from "../board/model";
import type { DurableOperation, Role } from "../types";
import type { CollectiveInquirySnapshot } from "./collective-inquiry";

const STAGE_INQUIRY_TOOL = "stage_collective_inquiry";

export type InquiryMapWebMcpOptions = {
  getRole: () => Role;
  getSnapshot: (token: string) => CollectiveInquirySnapshot | undefined;
  getItemVersion: (itemId: string) => number | undefined;
  getItemBounds: (itemId: string) => Bounds | undefined;
  commit: (operation: DurableOperation) => Promise<boolean>;
  selectItems: (itemIds: readonly string[]) => void;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

export class InquiryMapWebMcp {
  private readonly registration = new AbortController();

  constructor(private readonly options: InquiryMapWebMcpOptions) {
    void this.register();
  }

  destroy(): void {
    this.registration.abort();
  }

  private async register(): Promise<void> {
    if (this.options.getRole() !== "owner") return;
    const modelContext = document.modelContext;
    if (typeof modelContext?.registerTool !== "function") return;
    try {
      await modelContext.registerTool(
        {
          name: STAGE_INQUIRY_TOOL,
          description:
            "Add a visual collective-inquiry map from a SpaceScale selection. Connect the selected contribution aliases into 2-4 themes, identify bridges across themes, and name one productive tension plus a next question. SpaceScale computes the canvas layout and adds the map directly as one realtime, undoable board update.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["selectionToken", "mapTitle", "themes", "bridges", "tension"],
            properties: {
              selectionToken: {
                type: "string",
                description: "Opaque token returned by read_selected_class_ideas.",
              },
              mapTitle: { type: "string", minLength: 3, maxLength: 100 },
              themes: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label", "summary", "ideaAliases"],
                  properties: {
                    id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
                    label: { type: "string", minLength: 2, maxLength: 60 },
                    summary: { type: "string", minLength: 10, maxLength: 400 },
                    ideaAliases: {
                      type: "array",
                      minItems: 1,
                      maxItems: 30,
                      uniqueItems: true,
                      items: { type: "string", pattern: "^idea_[1-9][0-9]*$" },
                    },
                  },
                },
              },
              bridges: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["fromThemeId", "toThemeId", "insight"],
                  properties: {
                    fromThemeId: { type: "string" },
                    toThemeId: { type: "string" },
                    insight: { type: "string", minLength: 10, maxLength: 260 },
                  },
                },
              },
              tension: {
                type: "object",
                additionalProperties: false,
                required: ["statement", "nextQuestion"],
                properties: {
                  statement: { type: "string", minLength: 10, maxLength: 320 },
                  nextQuestion: { type: "string", minLength: 10, maxLength: 240 },
                },
              },
            },
          },
          annotations: {
            readOnlyHint: false,
          },
          execute: async (input, { signal }) => this.stage(input, signal),
        },
        { signal: this.registration.signal },
      );
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The AI inquiry-map tool could not be registered.", "warning");
    }
  }

  private async stage(input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (this.options.getRole() !== "owner") {
      throw new Error("Only the Space owner can add an AI-assisted inquiry map.");
    }
    const proposal = parseProposal(input);
    const snapshot = this.options.getSnapshot(proposal.selectionToken);
    if (!snapshot) {
      throw new Error(
        "That selection token has expired. Read the currently selected ideas again before adding a map.",
      );
    }
    const knownAliases = new Set(snapshot.sources.map((source) => source.alias));
    const assignedAliases = new Set<string>();
    for (const theme of proposal.themes) {
      for (const alias of theme.ideaAliases) {
        if (!knownAliases.has(alias)) {
          throw new Error(`${alias} is not part of the selection.`);
        }
        if (assignedAliases.has(alias)) {
          throw new Error(`${alias} was assigned to more than one theme.`);
        }
        assignedAliases.add(alias);
      }
    }
    for (const source of snapshot.sources) {
      if (this.options.getItemVersion(source.itemId) !== source.version) {
        throw new Error(
          "The selected class ideas changed after they were read. Read the selection again before adding a map.",
        );
      }
    }

    const sources = snapshot.sources.map((source) => {
      const bounds = this.options.getItemBounds(source.itemId);
      if (!bounds) throw new Error("One of the selected class ideas is no longer on the canvas.");
      return { alias: source.alias, bounds };
    });
    let batch: CollectiveInquiryBatch;
    try {
      batch = buildCollectiveInquiryMap(proposal, sources);
    } catch (error) {
      if (error instanceof CollectiveInquiryError) throw error;
      throw new Error("SpaceScale could not lay out that inquiry map safely.");
    }

    signal.throwIfAborted();
    const accepted = await this.options.commit(batch.operation);
    if (!accepted) throw new Error("The inquiry map could not be queued for saving.");
    this.options.selectItems(batch.itemIds);
    this.options.notify(
      "AI-assisted inquiry map added. The class can now challenge and extend it.",
      "info",
    );
    return {
      status: "added",
      changedCanvas: true,
      createdItemCount: batch.itemIds.length,
      connectedContributionCount: assignedAliases.size,
      themeCount: proposal.themes.length,
      message:
        "The map was added as one normal SpaceScale batch. It is visible to collaborators and can be undone.",
    };
  }
}

function parseProposal(input: unknown): CollectiveInquiryProposal {
  if (!isRecord(input)) throw new Error("The inquiry proposal must be an object.");
  const selectionToken = requiredText(input.selectionToken, "selectionToken", 100);
  const mapTitle = requiredText(input.mapTitle, "mapTitle", 100);
  if (!Array.isArray(input.themes) || input.themes.length < 2 || input.themes.length > 4) {
    throw new Error("themes must contain two to four entries.");
  }
  const themes = input.themes.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`themes[${index}] must be an object.`);
    const id = requiredText(entry.id, `themes[${index}].id`, 32);
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(id)) {
      throw new Error(`themes[${index}].id must be a short lowercase identifier.`);
    }
    if (!Array.isArray(entry.ideaAliases) || entry.ideaAliases.length === 0) {
      throw new Error(`themes[${index}].ideaAliases must name at least one selected contribution.`);
    }
    const ideaAliases = entry.ideaAliases.map((alias, aliasIndex) =>
      requiredText(alias, `themes[${index}].ideaAliases[${aliasIndex}]`, 30),
    );
    return {
      id,
      label: requiredText(entry.label, `themes[${index}].label`, 60),
      summary: requiredText(entry.summary, `themes[${index}].summary`, 400),
      ideaAliases,
    };
  });
  const themeIds = new Set(themes.map((theme) => theme.id));
  if (themeIds.size !== themes.length) throw new Error("Every theme must have a unique id.");
  if (!Array.isArray(input.bridges) || input.bridges.length > 3) {
    throw new Error("bridges must be an array with at most three entries.");
  }
  const bridges = input.bridges.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`bridges[${index}] must be an object.`);
    const fromThemeId = requiredText(entry.fromThemeId, `bridges[${index}].fromThemeId`, 32);
    const toThemeId = requiredText(entry.toThemeId, `bridges[${index}].toThemeId`, 32);
    if (!themeIds.has(fromThemeId) || !themeIds.has(toThemeId) || fromThemeId === toThemeId) {
      throw new Error(`bridges[${index}] must connect two different proposed themes.`);
    }
    return {
      fromThemeId,
      toThemeId,
      insight: requiredText(entry.insight, `bridges[${index}].insight`, 260),
    };
  });
  if (!isRecord(input.tension)) throw new Error("tension must be an object.");
  return {
    selectionToken,
    mapTitle,
    themes,
    bridges,
    tension: {
      statement: requiredText(input.tension.statement, "tension.statement", 320),
      nextQuestion: requiredText(input.tension.nextQuestion, "tension.nextQuestion", 240),
    },
  };
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength) {
    throw new Error(`${field} must contain 1-${maxLength} characters.`);
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
