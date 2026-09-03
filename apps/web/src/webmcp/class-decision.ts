import {
  buildClassDecision,
  type ClassDecisionProposal,
  type DecisionVoteOption,
} from "../activities/class-decision";
import { isVoteTable, summarizeVotes } from "../activities/voting";
import type { Bounds } from "../board/model";
import type { BoardItem, DurableOperation, Role } from "../types";

const READ_VOTE_TOOL = "read_live_class_vote";
const STAGE_DECISION_TOOL = "stage_class_decision";
const MAX_VOTE_SNAPSHOTS = 10;

type VoteSnapshot = {
  token: string;
  tableId: string;
  options: DecisionVoteOption[];
  totalVotes: number;
  capturedAt: string;
};

export type ClassDecisionWebMcpOptions = {
  getRole: () => Role;
  getSelectedItems: () => BoardItem[] | null;
  getItem: (itemId: string) => BoardItem | undefined;
  getItems: () => Iterable<BoardItem>;
  getItemBounds: (itemId: string) => Bounds | undefined;
  commit: (operation: DurableOperation) => Promise<boolean>;
  selectItems: (itemIds: readonly string[]) => void;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

export class ClassDecisionWebMcp {
  private readonly snapshots = new Map<string, VoteSnapshot>();
  private readonly registration = new AbortController();

  constructor(private readonly options: ClassDecisionWebMcpOptions) {
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
          name: READ_VOTE_TOOL,
          description:
            "Read the aggregate live result from the one saved SpaceScale vote table currently selected. Returns option labels and counts. Use after the class has responded to an AI-assisted inquiry map.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: true,
          },
          execute: async (_input, { signal }) => {
            signal.throwIfAborted();
            return this.readVote();
          },
        },
        { signal: this.registration.signal },
      );
      await modelContext.registerTool(
        {
          name: STAGE_DECISION_TOOL,
          description:
            "Add a class decision record from a live SpaceScale vote result. Propose a chosen direction, rationale, small pilot, success measure, an explicit minority concern that must remain visible, and the next open question. SpaceScale adds the vote evidence and decision cards directly as one realtime, undoable board update.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: [
              "voteToken",
              "decisionTitle",
              "chosenOption",
              "rationale",
              "minorityConcern",
              "pilotAction",
              "successMeasure",
              "nextQuestion",
            ],
            properties: {
              voteToken: { type: "string" },
              decisionTitle: { type: "string", minLength: 3, maxLength: 100 },
              chosenOption: { type: "string", minLength: 1, maxLength: 500 },
              rationale: { type: "string", minLength: 10, maxLength: 450 },
              minorityConcern: { type: "string", minLength: 10, maxLength: 400 },
              pilotAction: { type: "string", minLength: 10, maxLength: 400 },
              successMeasure: { type: "string", minLength: 5, maxLength: 280 },
              nextQuestion: { type: "string", minLength: 10, maxLength: 280 },
            },
          },
          annotations: {
            readOnlyHint: false,
          },
          execute: async (input, { signal }) => this.stageDecision(input, signal),
        },
        { signal: this.registration.signal },
      );
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The AI class-decision tools could not be registered.", "warning");
    }
  }

  private readVote(): Record<string, unknown> {
    if (this.options.getRole() !== "owner") {
      throw new Error("Only the Space owner can share the class vote with the AI partner.");
    }
    const selected = this.options.getSelectedItems();
    if (selected === null) throw new Error("Wait for the selected vote table to finish saving.");
    if (selected.length !== 1 || !selected[0] || !isVoteTable(selected[0])) {
      throw new Error("Select exactly one saved ‘Vote with stamps’ table first.");
    }
    const summary = summarizeVotes(selected[0], this.options.getItems());
    if (!summary) throw new Error("The selected table is not a live SpaceScale vote.");
    const options = summary.options.map(({ label, count }) => ({ label, count }));
    const totalVotes = options.reduce((total, option) => total + option.count, 0);
    const highest = Math.max(0, ...options.map((option) => option.count));
    const leadingOptions = options
      .filter((option) => option.count === highest && highest > 0)
      .map((option) => option.label);
    const token = crypto.randomUUID();
    const snapshot: VoteSnapshot = {
      token,
      tableId: selected[0].id,
      options,
      totalVotes,
      capturedAt: new Date().toISOString(),
    };
    this.snapshots.set(token, snapshot);
    while (this.snapshots.size > MAX_VOTE_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest);
    }
    this.options.notify(
      `Shared aggregate class response: ${totalVotes} current vote${totalVotes === 1 ? "" : "s"}.`,
      "info",
    );
    return {
      voteToken: token,
      capturedAt: snapshot.capturedAt,
      options,
      totalVotes,
      leadingOptions,
      tie: leadingOptions.length > 1,
      guidance:
        "Treat the vote as input to a class decision, not proof of consensus. Preserve a concrete minority concern and keep the next question open.",
      scope: "Aggregate option labels and counts from the selected vote table.",
    };
  }

  private async stageDecision(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (this.options.getRole() !== "owner") {
      throw new Error("Only the Space owner can add an AI-assisted class decision.");
    }
    const parsed = parseDecision(input);
    const snapshot = this.snapshots.get(parsed.voteToken);
    if (!snapshot)
      throw new Error("That vote token has expired. Read the selected live vote again.");
    if (!snapshot.options.some((option) => option.label === parsed.proposal.chosenOption)) {
      throw new Error("chosenOption must exactly match an option in the live class vote.");
    }
    const table = this.options.getItem(snapshot.tableId);
    const current = table ? summarizeVotes(table, this.options.getItems()) : null;
    if (!current || !sameCounts(snapshot.options, current.options)) {
      throw new Error(
        "The class vote changed. Read the live result again before adding a decision.",
      );
    }
    const bounds = this.options.getItemBounds(snapshot.tableId);
    if (!bounds) throw new Error("The selected vote table is no longer on the canvas.");
    const batch = buildClassDecision(parsed.proposal, snapshot.options, bounds);
    signal.throwIfAborted();
    const accepted = await this.options.commit(batch.operation);
    if (!accepted) throw new Error("The class decision could not be queued for saving.");
    this.options.selectItems(batch.itemIds);
    this.options.notify(
      "Class decision added with the minority concern and next question intact.",
      "info",
    );
    return {
      status: "added",
      changedCanvas: true,
      createdItemCount: batch.itemIds.length,
      totalVotes: snapshot.totalVotes,
      chosenOption: parsed.proposal.chosenOption,
      dissentPreserved: true,
      message: "The decision record was added as one normal SpaceScale batch and remains undoable.",
    };
  }
}

function parseDecision(input: unknown): { voteToken: string; proposal: ClassDecisionProposal } {
  if (!isRecord(input)) throw new Error("The class decision must be an object.");
  return {
    voteToken: requiredText(input.voteToken, "voteToken", 100),
    proposal: {
      decisionTitle: requiredText(input.decisionTitle, "decisionTitle", 100),
      chosenOption: requiredText(input.chosenOption, "chosenOption", 500),
      rationale: requiredText(input.rationale, "rationale", 450),
      minorityConcern: requiredText(input.minorityConcern, "minorityConcern", 400),
      pilotAction: requiredText(input.pilotAction, "pilotAction", 400),
      successMeasure: requiredText(input.successMeasure, "successMeasure", 280),
      nextQuestion: requiredText(input.nextQuestion, "nextQuestion", 280),
    },
  };
}

function sameCounts(
  saved: readonly DecisionVoteOption[],
  current: readonly DecisionVoteOption[],
): boolean {
  return (
    saved.length === current.length &&
    saved.every(
      (option, index) =>
        option.label === current[index]?.label && option.count === current[index]?.count,
    )
  );
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
