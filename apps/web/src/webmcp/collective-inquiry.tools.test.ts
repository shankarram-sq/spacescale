import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardItem } from "../types";
import { CollectiveInquiryWebMcp } from "./collective-inquiry";
import { webMcpRegistryState, webMcpToolDefinitions } from "./shared";
import type { RegisteredWebMcpTool, WebMcpRegisterToolOptions } from "./types";

const ACTOR_ID = "018f0000-0000-7000-8000-0000000000a1";
const STICKY_ID = "018f0000-0000-7000-8000-0000000000b1";

function sticky(): Extract<BoardItem, { kind: "sticky" }> {
  return {
    id: STICKY_ID,
    kind: "sticky",
    z: 1,
    version: 4,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: { kind: "sticky", fill: "#fff2a8", textColor: "#27231b", fontSize: 20, opacity: 1 },
    geometry: { x: 10, y: 10, width: 180, height: 140, text: "Let $2x=6$" },
  };
}

function harness(options: { canComment?: boolean; canWrite?: boolean; board?: BoardItem[] } = {}) {
  /** What a linked host is actually offered. */
  const exposed = new Map<string, RegisteredWebMcpTool>();
  /** Every definition the module builds. */
  const tools = webMcpToolDefinitions();
  const board = options.board ?? [sticky()];
  vi.stubGlobal("document", {
    modelContext: {
      registerTool(tool: RegisteredWebMcpTool, registration?: WebMcpRegisterToolOptions) {
        exposed.set(tool.name, tool);
        registration?.signal?.addEventListener("abort", () => exposed.delete(tool.name), {
          once: true,
        });
      },
    },
  });
  const notices: string[] = [];
  const inquiry = new CollectiveInquiryWebMcp({
    getSelectedItems: () => board,
    getBoardItems: () => board,
    getAuthoritativeItem: (itemId) => board.find((item) => item.id === itemId),
    getSequence: () => 3,
    getParticipantDisplayName: () => "Sam",
    notify: (message) => notices.push(message),
    canComment: () => options.canComment ?? true,
    canWrite: () => options.canWrite ?? true,
  });
  const call = async (name: string, input: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is not registered.`);
    return (await tool.execute(input, { signal: new AbortController().signal })) as Record<
      string,
      unknown
    >;
  };
  return { inquiry, tools, exposed, notices, call };
}

describe("list_users", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists who has saved work, with the ids the user and read tools take", async () => {
    const other: BoardItem = {
      ...sticky(),
      id: "018f0000-0000-7000-8000-0000000000c2",
      createdBy: "018f0000-0000-7000-8000-0000000000c1",
    };
    const { inquiry, exposed, call } = harness({ board: [sticky(), sticky(), other] });
    await vi.waitFor(() => expect(exposed.has("list_users")).toBe(true));
    const result = await call("list_users", {});

    expect(result).toMatchObject({
      scope: "participants_with_saved_work",
      participantCount: 2,
      watchTool: "watch_users",
      readTool: "read_user",
    });
    const participants = result.participants as Array<Record<string, unknown>>;
    // Ordered by how much work each has, so the ids a caller needs are easy to pick out.
    expect(participants[0]).toMatchObject({
      participantId: ACTOR_ID,
      displayName: "Sam",
      objectCount: 2,
      objectKinds: { sticky: 2 },
    });
    expect(participants[1]).toMatchObject({ objectCount: 1 });
    // Pinned so the shape a caller depends on cannot drift without a decision.
    expect(Object.keys(participants[0] ?? {}).sort()).toEqual([
      "displayName",
      "objectCount",
      "objectKinds",
      "participantId",
    ]);
    expect(result.note).toContain("no saved work does not appear");
    inquiry.destroy();
  });
});

describe("registered tool surface", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts a watch for a host that hands execute no AbortSignal", async () => {
    // Codex's WebMCP shim passes an options object carrying only requestUserInteraction, so
    // reaching for signal.throwIfAborted() threw a TypeError before the watch ever started.
    const { inquiry, exposed } = harness();
    await vi.waitFor(() => expect(exposed.has("watch_board")).toBe(true));
    const watch = exposed.get("watch_board");
    if (!watch) throw new Error("watch_board was not offered to the host.");

    const started = (await watch.execute({ action: "start" }, {
      requestUserInteraction: () => undefined,
    } as never)) as Record<string, unknown>;
    expect(started).toMatchObject({ status: "started", watchToken: expect.any(String) });

    // And for a host that omits the options argument altogether.
    const stopped = (await watch.execute({
      action: "stop",
      watchToken: started.watchToken,
    })) as Record<string, unknown>;
    expect(stopped).toMatchObject({ status: "stopped" });
    inquiry.destroy();
  });

  it("never names a dropped tool in the contract it advertises to a host", async () => {
    // A description is the contract a host reads at discovery. Naming a tool this build no
    // longer defines sends it to a call that cannot succeed, which is what the reply plan
    // already avoids at runtime.
    const { inquiry, exposed } = harness();
    await vi.waitFor(() => expect(exposed.has("watch_board")).toBe(true));
    const watch = exposed.get("watch_board");
    if (!watch) throw new Error("watch_board was not offered to the host.");
    for (const dropped of [
      "comment_on_watched_step",
      "add_thinking_expansion",
      "read_selected_class_ideas",
      "inspect_selected_board_visual",
    ]) {
      expect(watch.description).not.toContain(dropped);
    }
    expect(watch.description).toContain("insert_comment");
    // Every action is answered in a comment now, so the description must not offer a card.
    expect(watch.description).not.toContain("insert_sticky");
    inquiry.destroy();
  });

  it("offers a host the reads and watches and drops them when the page tears down", async () => {
    const before = webMcpRegistryState().toolCount;
    const { inquiry, tools, exposed } = harness();
    // watch_users is registered last, so its arrival means the whole surface is up.
    await vi.waitFor(() => expect(exposed.has("watch_users")).toBe(true));

    expect([...exposed.keys()].sort()).toEqual([
      "list_users",
      "read_board",
      "read_selection",
      "read_user",
      "watch_board",
      "watch_users",
    ]);
    expect([...tools.keys()].sort()).toEqual([...exposed.keys()].sort());

    const linked = webMcpRegistryState();
    expect(linked.hostPresent).toBe(true);
    expect(linked.toolCount).toBe(before + exposed.size);

    inquiry.destroy();
    await vi.waitFor(() => expect(webMcpRegistryState().toolCount).toBe(before));
  });
});
