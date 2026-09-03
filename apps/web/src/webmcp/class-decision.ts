import { isVoteTable, summarizeVotes } from "../activities/voting";
import type { BoardItem } from "../types";
import { registerWebMcpTool } from "./shared";

const READ_VOTE_TOOL = "read_live_class_vote";

export type ClassDecisionWebMcpOptions = {
  getSelectedItems: () => BoardItem[] | null;
  getItems: () => Iterable<BoardItem>;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

/** Reads the aggregate result of the one vote table selected in this browser. */
export class ClassDecisionWebMcp {
  private readonly registration = new AbortController();

  constructor(private readonly options: ClassDecisionWebMcpOptions) {
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
          name: READ_VOTE_TOOL,
          description:
            "Read the aggregate live result from the one saved SpaceScale vote table selected in this browser. Returns option labels and counts only—never voter identities, stamp IDs, student names, or inferred consensus. Use after the class has responded to an inquiry map.",
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
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The class-vote tool could not be registered.", "warning");
    }
  }

  private readVote(): Record<string, unknown> {
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
    this.options.notify(
      `Shared aggregate class response: ${totalVotes} current vote${totalVotes === 1 ? "" : "s"}, no identities.`,
      "info",
    );
    return {
      capturedAt: new Date().toISOString(),
      options,
      totalVotes,
      leadingOptions,
      tie: leadingOptions.length > 1,
      guidance:
        "Treat the vote as input to a class decision, not proof of consensus. Preserve a concrete minority concern and keep the next question open.",
      privacy:
        "Aggregate counts only. No voter names, actor IDs, stamp IDs, or holdout identities.",
    };
  }
}
