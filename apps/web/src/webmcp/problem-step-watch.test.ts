import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardItem, ServerAction } from "../types";
import { PROBLEM_STEP_WATCH_DURATION_MS, ProblemStepWatchFeed } from "./problem-step-watch";

const ACTOR_ID = "018f0000-0000-7000-8000-0000000000a1";
const STICKY_ID = "018f0000-0000-7000-8000-0000000000b1";
const TEXT_ID = "018f0000-0000-7000-8000-0000000000b2";
const TABLE_ID = "018f0000-0000-7000-8000-0000000000b3";
const SECTION_ID = "018f0000-0000-7000-8000-0000000000b4";
const VIDEO_ID = "018f0000-0000-7000-8000-0000000000b5";
const UNSELECTED_ID = "018f0000-0000-7000-8000-0000000000b6";

function sticky(text = "Let $2x=6$", version = 1): Extract<BoardItem, { kind: "sticky" }> {
  return {
    id: STICKY_ID,
    kind: "sticky",
    z: 1,
    version,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "sticky",
      fill: "#fff2a8",
      textColor: "#27231b",
      fontSize: 20,
      opacity: 1,
    },
    geometry: { x: 10, y: 10, width: 180, height: 140, text },
  };
}

function canvasText(): Extract<BoardItem, { kind: "text" }> {
  return {
    id: TEXT_ID,
    kind: "text",
    z: 2,
    version: 1,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "text",
      color: "#111827",
      fontSize: 20,
      fontFamily: "sans",
      opacity: 1,
    },
    geometry: { x: 10, y: 180, text: "Divide both sides by $2$" },
  };
}

function table(): Extract<BoardItem, { kind: "table" }> {
  return {
    id: TABLE_ID,
    kind: "table",
    z: 3,
    version: 1,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "table",
      borderColor: "#111827",
      fill: "#ffffff",
      headerFill: "#f3f4f6",
      textColor: "#111827",
      fontSize: 16,
      opacity: 1,
    },
    geometry: {
      x: 220,
      y: 10,
      columnWidths: [100, 100],
      rowHeights: [40, 40],
      cells: [
        ["Step", "Result"],
        ["$2x/2$", "$6/2$"],
      ],
      headerRow: true,
    },
  };
}

function section(): Extract<BoardItem, { kind: "zone" }> {
  return {
    id: SECTION_ID,
    kind: "zone",
    z: 4,
    version: 1,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "zone",
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18,
      opacity: 0.18,
    },
    geometry: { x: 0, y: 0, width: 520, height: 320, title: "Solve for $x$" },
  };
}

function video(): Extract<BoardItem, { kind: "text" }> {
  return {
    ...canvasText(),
    id: VIDEO_ID,
    geometry: { x: 10, y: 360, text: "https://youtu.be/example", embed: "video" },
  };
}

function unselectedSticky(
  text = "Unselected private work",
  version = 1,
): Extract<BoardItem, { kind: "sticky" }> {
  return { ...sticky(text, version), id: UNSELECTED_ID, sectionId: SECTION_ID };
}

function serverAction(seq: number, item: BoardItem): ServerAction {
  return {
    v: 1,
    t: "server.action",
    seq,
    acceptedAt: Date.UTC(2026, 8, 3, 12, 0, seq),
    actor: { id: ACTOR_ID, displayName: "Sam" },
    commandId: `018f0000-0000-7000-8000-${seq.toString().padStart(12, "0")}`,
    actionId: `018f0000-0000-7000-9000-${seq.toString().padStart(12, "0")}`,
    op: {
      kind: "item.update",
      itemId: item.id,
      expectedVersion: Math.max(0, item.version - 1),
      patch: { geometry: item.geometry },
      item,
    },
  };
}

function setup(selected: BoardItem[] = [sticky()]) {
  let sequence = 7;
  const items = new Map<string, BoardItem>(
    [sticky(), canvasText(), table(), section(), video(), unselectedSticky()].map((item) => [
      item.id,
      item,
    ]),
  );
  const feed = new ProblemStepWatchFeed({
    getSelectedItems: () => selected,
    getAuthoritativeItem: (itemId) => items.get(itemId),
    getSequence: () => sequence,
    getParticipantDisplayName: (participantId) =>
      participantId === ACTOR_ID ? "Sam" : "Unselected participant",
  });
  return {
    feed,
    items,
    setSequence(value: number) {
      sequence = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("problem-step WebMCP watch", () => {
  it("starts a 15-minute watch over only exact selected text-bearing items", async () => {
    const unselected = unselectedSticky();
    const { feed } = setup([sticky(), canvasText(), table(), section(), video()]);

    const result = await feed.execute({ action: "start" }, new AbortController().signal);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "started",
      durationSeconds: 900,
      nextSeq: 7,
      continueWatching: true,
      steps: [
        { alias: "step_1", kind: "sticky", text: "Let $2x=6$" },
        { alias: "step_2", kind: "text", text: "Divide both sides by $2$" },
        { alias: "step_3", kind: "table", text: "Step\tResult\n$2x/2$\t$6/2$" },
        { alias: "step_4", kind: "zone", text: "Solve for $x$" },
      ],
    });
    expect(serialized).not.toContain(STICKY_ID);
    expect(serialized).not.toContain(VIDEO_ID);
    expect(serialized).not.toContain(unselected.geometry.text);
    expect(result.privacy).toContain("other Section contents");
  });

  it("does not report an unselected child of a selected Section", async () => {
    vi.useFakeTimers();
    const { feed, items, setSequence } = setup([section()]);
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const pending = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    const privateUpdate = unselectedSticky("Private next step", 2);
    items.set(UNSELECTED_ID, privateUpdate);
    setSequence(8);

    feed.recordAuthoritativeAction(serverAction(8, privateUpdate), new Set([UNSELECTED_ID]));
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    // nextSeq stays at the last sequence that changed a watched step. Advancing it to 8 would
    // disclose that an unselected item was edited, which this watch promises to exclude.
    expect(result).toMatchObject({ status: "timeout", changes: [], nextSeq: 7 });
    expect(JSON.stringify(result)).not.toContain("Private next step");
    feed.destroy();
  });

  it("resolves a pending wait with an authoritative selected-step update", async () => {
    const { feed, items, setSequence } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const pending = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 20_000 },
      new AbortController().signal,
    );
    const updated = sticky("Therefore $x=3$", 2);
    items.set(STICKY_ID, updated);
    setSequence(8);

    feed.recordAuthoritativeAction(serverAction(8, updated), new Set([STICKY_ID]));

    await expect(pending).resolves.toMatchObject({
      status: "changed",
      nextSeq: 8,
      changes: [
        {
          seq: 8,
          actor: { displayName: "Sam" },
          steps: [{ alias: "step_1", kind: "sticky", change: "updated", text: "Therefore $x=3$" }],
        },
      ],
      nextCall: { input: { action: "wait", afterSeq: 8, waitMs: 15_000 } },
    });
    feed.destroy();
  });

  it("times out cleanly, releases an aborted wait, and expires after 15 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
    const { feed } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const timeout = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timeout).resolves.toMatchObject({
      status: "timeout",
      nextSeq: 7,
      remainingSeconds: 899,
      continueWatching: true,
    });

    const controller = new AbortController();
    const aborted = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      controller.signal,
    );
    controller.abort(new Error("stop waiting"));
    await expect(aborted).rejects.toThrow("stop waiting");

    const retry = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(retry).resolves.toMatchObject({ status: "timeout" });

    vi.setSystemTime(new Date(Date.now() + PROBLEM_STEP_WATCH_DURATION_MS));
    await expect(
      feed.execute(
        { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "expired", continueWatching: false });
    feed.destroy();
  });

  it("reports a resync with fresh text when the board is reloaded wholesale", async () => {
    vi.useFakeTimers();
    const { feed, items, setSequence } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const pending = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 5_000 },
      new AbortController().signal,
    );

    // Sequence-gap recovery and snapshot restore replace authoritative state outright, so no
    // individual action ever reaches the feed for the changes the replacement carried.
    items.set(STICKY_ID, sticky("Let $2x=6$ so $x=3$", 4));
    setSequence(42);
    feed.recordAuthoritativeReload(42);

    const result = await pending;
    expect(result).toMatchObject({ status: "resync", nextSeq: 42 });
    expect(result.steps).toEqual([
      {
        alias: "step_1",
        kind: "sticky",
        text: "Let $2x=6$ so $x=3$",
        createdBy: { displayName: "Sam" },
      },
    ]);

    // Following the returned nextCall resumes the long poll. Repeating the snapshot here would
    // make the agent process one reload twice.
    const followUp = feed.execute(
      { action: "wait", watchToken, afterSeq: 42, waitMs: 1_000 },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await followUp).toMatchObject({ status: "timeout", nextSeq: 42 });

    // A caller still holding a pre-reload sequence resolves to a resync on its own merit.
    const stale = await feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    expect(stale).toMatchObject({ status: "resync", nextSeq: 42 });
    feed.destroy();
  });

  it("resyncs once on the next wait when a board reload finds no wait in flight", async () => {
    vi.useFakeTimers();
    const { feed, items, setSequence } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);

    items.set(STICKY_ID, sticky("Reloaded step", 4));
    setSequence(42);
    feed.recordAuthoritativeReload(42);

    const first = await feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    expect(first).toMatchObject({ status: "resync", nextSeq: 42 });
    const second = feed.execute(
      { action: "wait", watchToken, afterSeq: 42, waitMs: 1_000 },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await second).toMatchObject({ status: "timeout", nextSeq: 42 });
    feed.destroy();
  });

  it("keeps a change recordable when a step snapshot would have been updated first", async () => {
    const { feed, items } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const update = sticky("Let $2x=6$ so $x=3$", 2);
    items.set(STICKY_ID, update);

    // acceptedAt passes frame validation as a safe integer but cannot be formatted as a date.
    const hostile = { ...serverAction(8, update), acceptedAt: Number.MAX_SAFE_INTEGER };
    expect(() => feed.recordAuthoritativeAction(hostile, new Set([STICKY_ID]))).not.toThrow();

    const result = await feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "changed", nextSeq: 8 });
    expect(result.changes).toMatchObject([
      { seq: 8, steps: [{ alias: "step_1", change: "updated" }] },
    ]);
    feed.destroy();
  });

  it("ends a watch on stop and on replacement with guidance not to wait again", async () => {
    const { feed } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const stopped = await feed.execute(
      { action: "stop", watchToken },
      new AbortController().signal,
    );
    expect(stopped).toMatchObject({ status: "stopped", continueWatching: false });
    expect(stopped.nextAction).toContain("Do not call wait again");
    expect(() =>
      feed.execute({ action: "wait", watchToken, afterSeq: 7 }, new AbortController().signal),
    ).toThrow(/missing or expired/);

    // A sixth concurrent watch evicts the oldest, which must say why rather than going quiet.
    const tokens: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const session = await feed.execute({ action: "start" }, new AbortController().signal);
      tokens.push(String(session.watchToken));
    }
    expect(() =>
      feed.execute(
        { action: "wait", watchToken: String(tokens[0]), afterSeq: 7 },
        new AbortController().signal,
      ),
    ).toThrow(/missing or expired/);
    feed.destroy();
  });

  it("reports deletion without exposing the stable item identifier", async () => {
    const { feed, items, setSequence } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    items.delete(STICKY_ID);
    setSequence(8);
    const deletion = serverAction(8, sticky());
    deletion.op = { kind: "item.delete", itemId: STICKY_ID, expectedVersion: 1 };
    feed.recordAuthoritativeAction(deletion, new Set([STICKY_ID]));

    const result = await feed.execute(
      { action: "wait", watchToken, afterSeq: 7 },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "changed",
      changes: [{ steps: [{ alias: "step_1", kind: "sticky", change: "deleted" }] }],
    });
    expect(JSON.stringify(result)).not.toContain(STICKY_ID);
    feed.destroy();
  });
});

describe("board-side assist requests", () => {
  function watching(selected: BoardItem[] = [sticky(), canvasText()]) {
    const states: Array<ReturnType<ProblemStepWatchFeed["getState"]>> = [];
    const minted: unknown[] = [];
    let canComment = true;
    const context = setup(selected);
    const feed = new ProblemStepWatchFeed({
      getSelectedItems: () => selected,
      getAuthoritativeItem: (itemId) => context.items.get(itemId),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
      onStateChanged: (state) => states.push(state),
      canComment: () => canComment,
      mintSelectionToken: (sources) => {
        minted.push(sources);
        return `token_${minted.length}`;
      },
    });
    return {
      feed,
      states,
      minted,
      items: context.items,
      setCanComment(value: boolean) {
        canComment = value;
      },
    };
  }

  it("reports idle, watching and listening as the host starts and waits", async () => {
    vi.useFakeTimers();
    const { feed, states } = watching();
    expect(feed.getState()).toEqual({ phase: "idle", expiresAt: null, watchedItemIds: new Set() });

    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    expect(states.at(-1)).toMatchObject({ phase: "watching" });
    expect(states.at(-1)?.watchedItemIds).toEqual(new Set([STICKY_ID, TEXT_ID]));
    expect(started).toMatchObject({
      selectionToken: "token_1",
      canComment: true,
      participantRequests: { actions: expect.arrayContaining(["explain", "check_work"]) },
    });

    const wait = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq, waitMs: 1_000 },
      new AbortController().signal,
    );
    expect(feed.getState().phase).toBe("listening");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toMatchObject({ status: "timeout" });
    expect(feed.getState().phase).toBe("watching");

    await feed.execute(
      { action: "stop", watchToken: started.watchToken },
      new AbortController().signal,
    );
    expect(feed.getState().phase).toBe("idle");
  });

  it("goes idle on expiry without any host call and on destroy", async () => {
    vi.useFakeTimers();
    const { feed } = watching();
    await feed.execute({ action: "start" }, new AbortController().signal);
    expect(feed.getState().phase).toBe("watching");
    await vi.advanceTimersByTimeAsync(PROBLEM_STEP_WATCH_DURATION_MS);
    expect(feed.getState().phase).toBe("idle");

    await feed.execute({ action: "start" }, new AbortController().signal);
    expect(feed.getState().phase).toBe("watching");
    feed.destroy();
    expect(feed.getState().phase).toBe("idle");
  });

  it("resolves a pending wait with the request, its reply plan and a fresh selection token", async () => {
    const { feed, minted } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const wait = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    const receipt = feed.requestAssistance({
      itemIds: [STICKY_ID],
      action: "critique",
      note: "  not sure about the division  ",
    });
    expect(receipt).toEqual({ requestId: "req_1", delivered: true, stepAliases: ["step_1"] });
    const result = await wait;
    expect(result).toMatchObject({
      status: "requested",
      continueWatching: true,
      nextSeq: started.nextSeq,
      selectionToken: "token_2",
      canComment: true,
      requests: [
        {
          requestId: "req_1",
          action: "critique",
          note: "not sure about the division",
          steps: [{ alias: "step_1", kind: "sticky", text: "Let $2x=6$" }],
          reply: {
            via: "comment",
            call: {
              tool: "comment_on_watched_step",
              input: { watchToken: started.watchToken, stepAlias: "step_1" },
            },
          },
        },
      ],
    });
    expect(minted).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(STICKY_ID);
    expect(JSON.stringify(result)).not.toContain(ACTOR_ID);
  });

  it("queues requests ahead of changes when no wait is pending and caps the queue", async () => {
    const { feed, items } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    for (let index = 0; index < 12; index += 1) {
      expect(feed.requestAssistance({ itemIds: [], action: "explain" }).delivered).toBe(false);
    }
    const updated = sticky("Let $2x=6$ so $x=3$", 2);
    items.set(STICKY_ID, updated);
    feed.recordAuthoritativeAction(serverAction(8, updated), new Set([STICKY_ID]));

    const first = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(first).toMatchObject({ status: "requested", droppedRequests: 2, nextSeq: 8 });
    expect(first.requests).toHaveLength(10);
    expect((first.requests as Array<{ steps: unknown[] }>)[0]?.steps).toHaveLength(2);

    const second = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(second).toMatchObject({ status: "changed", changes: [{ seq: 8 }] });
    expect(second).not.toHaveProperty("droppedRequests");
  });

  it("keeps queued requests when a wait is aborted and prefers cards for generative actions", async () => {
    const { feed } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const controller = new AbortController();
    const wait = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      controller.signal,
    );
    controller.abort();
    await expect(wait).rejects.toThrow();
    feed.requestAssistance({ itemIds: [STICKY_ID], action: "ideate" });
    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "requested",
      requests: [
        {
          action: "ideate",
          reply: {
            via: "board",
            call: {
              tool: "add_thinking_expansion",
              input: { selectionToken: expect.any(String), sourceAliases: ["step_1"] },
            },
          },
        },
      ],
    });
  });

  it("falls back to a comment for text steps and to the conversation when commenting is off", async () => {
    const { feed, setCanComment } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    feed.requestAssistance({ itemIds: [TEXT_ID], action: "examples" });
    const commentFallback = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(commentFallback.requests).toMatchObject([{ reply: { via: "comment" } }]);

    setCanComment(false);
    feed.requestAssistance({ itemIds: [TEXT_ID], action: "explain" });
    const chatFallback = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(chatFallback).toMatchObject({ canComment: false });
    expect(chatFallback.requests).toMatchObject([{ reply: { via: "conversation" } }]);
    expect((chatFallback.requests as Array<{ reply: object }>)[0]?.reply).not.toHaveProperty(
      "call",
    );
  });

  it("rejects requests outside a live watch, for unwatched items, and with bad input", async () => {
    vi.useFakeTimers();
    const { feed } = watching();
    expect(() => feed.requestAssistance({ itemIds: [], action: "explain" })).toThrow(
      "start a problem-step watch first",
    );
    await feed.execute({ action: "start" }, new AbortController().signal);
    expect(() => feed.requestAssistance({ itemIds: [UNSELECTED_ID], action: "explain" })).toThrow(
      "Only steps in the current AI watch",
    );
    expect(() => feed.requestAssistance({ itemIds: [], action: "grade" as never })).toThrow(
      "action must be one of",
    );
    expect(() =>
      feed.requestAssistance({ itemIds: [], action: "explain", note: "x".repeat(281) }),
    ).toThrow("note must contain 1-280 characters");
    await vi.advanceTimersByTimeAsync(PROBLEM_STEP_WATCH_DURATION_MS);
    expect(() => feed.requestAssistance({ itemIds: [], action: "explain" })).toThrow(
      "start a problem-step watch first",
    );
  });

  it("resolves comment targets by alias, remembers the requested action, and caps comments", async () => {
    const { feed, items } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const token = String(started.watchToken);
    expect(() => feed.commentTarget("missing", "step_1")).toThrow("missing or expired");
    expect(() => feed.commentTarget(token, "step_9")).toThrow("not part of this watch");

    feed.requestAssistance({ itemIds: [STICKY_ID], action: "check_work" });
    const target = feed.commentTarget(token, "step_1");
    expect(target).toMatchObject({ itemId: STICKY_ID, action: "check_work" });
    expect(() => feed.commentTarget(token, "step_1")).toThrow("previous comment");
    target.release(false);
    expect(feed.commentTarget(token, "step_2")).toMatchObject({ itemId: TEXT_ID });

    items.delete(TEXT_ID);
    feed.recordAuthoritativeAction(serverAction(9, canvasText()), new Set([TEXT_ID]));
    expect(() => feed.commentTarget(token, "step_2")).toThrow("no longer on the board");
  });

  it("enforces the per-watch comment cap through release", async () => {
    const { feed } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const token = String(started.watchToken);
    for (let index = 0; index < 20; index += 1) feed.commentTarget(token, "step_1").release(true);
    expect(() => feed.commentTarget(token, "step_1")).toThrow("limit of 20 AI comments");
  });
});
