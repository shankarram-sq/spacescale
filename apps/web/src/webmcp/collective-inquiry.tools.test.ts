import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardItem } from "../types";
import { CollectiveInquiryWebMcp } from "./collective-inquiry";
import { webMcpRegistryState } from "./shared";
import type { WebMcpRegisterToolOptions, WebMcpToolDefinition } from "./types";

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

/** The dialog the inquiry module builds at construction; nothing here is exercised. */
function fakeDialog(): HTMLDialogElement {
  const noop = () => undefined;
  return {
    className: "",
    dataset: {},
    open: false,
    returnValue: "",
    innerHTML: "",
    setAttribute: noop,
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    close: noop,
    remove: noop,
    showModal: noop,
  } as unknown as HTMLDialogElement;
}

function harness(options: { canComment?: boolean; canWrite?: boolean } = {}) {
  const tools = new Map<string, WebMcpToolDefinition>();
  vi.stubGlobal("document", {
    createElement: () => fakeDialog(),
    modelContext: {
      registerTool(tool: WebMcpToolDefinition, registration?: WebMcpRegisterToolOptions) {
        tools.set(tool.name, tool);
        registration?.signal?.addEventListener("abort", () => tools.delete(tool.name), {
          once: true,
        });
      },
    },
  });
  const created: Array<{ itemId: string; body: string; assistance: unknown }> = [];
  const notices: string[] = [];
  const inquiry = new CollectiveInquiryWebMcp({
    root: { append: () => undefined } as unknown as HTMLElement,
    getSelectedItems: () => [sticky()],
    getAuthoritativeItem: (itemId) => (itemId === STICKY_ID ? sticky() : undefined),
    getSequence: () => 3,
    getParticipantDisplayName: () => "Sam",
    notify: (message) => notices.push(message),
    canComment: () => options.canComment ?? true,
    canWrite: () => options.canWrite ?? true,
    createComment: async (itemId, body, assistance) => {
      created.push({ itemId, body, assistance });
    },
  });
  const call = async (name: string, input: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is not registered.`);
    return (await tool.execute(input, { signal: new AbortController().signal })) as Record<
      string,
      unknown
    >;
  };
  return { inquiry, tools, created, notices, call };
}

describe("watch reply tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("registers the comment tool and documents the requested status", async () => {
    const { inquiry, tools } = harness();
    await vi.waitFor(() => expect(tools.has("comment_on_watched_step")).toBe(true));
    expect(tools.get("watch_selected_problem_steps")?.description).toContain("requested");
    expect(tools.get("comment_on_watched_step")?.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
    inquiry.destroy();
    expect(tools.size).toBe(0);
  });

  it("mints a selection token the add_* tools can resolve and posts a tagged comment", async () => {
    const { inquiry, tools, created, notices, call } = harness();
    await vi.waitFor(() => expect(tools.has("comment_on_watched_step")).toBe(true));
    const started = await call("watch_selected_problem_steps", { action: "start" });
    const token = String(started.selectionToken);
    expect(started).toMatchObject({
      selectionSources: [{ stepAlias: "step_1", sourceAlias: "idea_1" }],
      canWrite: true,
    });
    expect(inquiry.getSnapshot(token)).toMatchObject({
      sources: [{ alias: "idea_1", itemId: STICKY_ID, version: 4, kind: "sticky" }],
    });
    expect(inquiry.getWatchState().phase).toBe("watching");

    inquiry.requestAssistance({ itemIds: [STICKY_ID], action: "explain" });
    inquiry.requestAssistance({ itemIds: [STICKY_ID], action: "critique" });
    const commented = await call("comment_on_watched_step", {
      watchToken: started.watchToken,
      stepAlias: "step_1",
      action: "critique",
      body: "  Check the division: $6/2=3$.  ",
    });
    expect(commented).toMatchObject({ status: "commented", stepAlias: "step_1", writtenBy: "ai" });
    expect(created).toEqual([
      {
        itemId: STICKY_ID,
        body: "Check the division: $6/2=3$.",
        assistance: { tool: "comment_on_watched_step", action: "critique" },
      },
    ]);
    expect(JSON.stringify(commented)).not.toContain(STICKY_ID);
    expect(notices.at(-1)).toBe("The AI assistant commented on step_1.");
    inquiry.destroy();
  });

  it("rejects bad aliases, oversized bodies, and browsers that cannot comment", async () => {
    const { inquiry, tools, call } = harness({ canComment: false });
    await vi.waitFor(() => expect(tools.has("comment_on_watched_step")).toBe(true));
    const started = await call("watch_selected_problem_steps", { action: "start" });
    expect(started).toMatchObject({ canComment: false });
    const base = { watchToken: started.watchToken, stepAlias: "step_1", body: "Hello" };
    await expect(call("comment_on_watched_step", { ...base, stepAlias: "idea_1" })).rejects.toThrow(
      "stepAlias must look like step_1",
    );
    await expect(call("comment_on_watched_step", { ...base, action: "grade" })).rejects.toThrow(
      "action must be one of",
    );
    await expect(
      call("comment_on_watched_step", { ...base, body: "x".repeat(2_001) }),
    ).rejects.toThrow("1-2000 characters");
    await expect(call("comment_on_watched_step", base)).rejects.toThrow("cannot comment");
    inquiry.destroy();
  });
});

describe("registered tool surface", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts the tools a linked host can see and drops them when the page tears down", async () => {
    const before = webMcpRegistryState().toolCount;
    const { inquiry, tools } = harness();
    await vi.waitFor(() => expect(tools.has("comment_on_watched_step")).toBe(true));

    const linked = webMcpRegistryState();
    expect(linked.hostPresent).toBe(true);
    expect(linked.toolCount).toBe(before + tools.size);

    inquiry.destroy();
    await vi.waitFor(() => expect(webMcpRegistryState().toolCount).toBe(before));
  });
});
