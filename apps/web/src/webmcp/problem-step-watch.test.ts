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
    expect(result).toMatchObject({ status: "timeout", changes: [], nextSeq: 8 });
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
