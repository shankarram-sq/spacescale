import { expect, test } from "@playwright/test";
import { chooseMoreTool, createBoard, expandToolPermissions, openSettingsDrawer } from "./helpers";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (input: unknown, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
};

declare global {
  interface Window {
    __spaceScaleWebMcpTools: Record<string, RegisteredTool>;
  }
}

/** A 1×1 opaque PNG: the smallest picture the board's upload path will accept. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Definitions the build keeps but withholds from every host; none may reach a linked page. */
const WITHHELD_TOOLS = [
  "add_collective_reasoning",
  "add_content_visuals",
  "add_group_decision_scaffold",
  "add_idea_sensemaking",
  "add_learning_action_plan",
  "add_thinking_expansion",
  "comment_on_watched_step",
  "explain_selected_ideas",
  "insert_filled_template",
  "inspect_selected_board_visual",
  "inspire_from_selected_ideas",
  "list_class_collaboration_modes",
  "read_selected_class_ideas",
  "stage_class_decision",
  "stage_collective_inquiry",
];

test("a board participant can use headless WebMCP tools with neutral board attribution", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The WebMCP demo-path smoke runs in Chromium.");
  test.setTimeout(60_000);

  await page.addInitScript(() => {
    const tools: Record<string, RegisteredTool> = {};
    Object.defineProperty(window, "__spaceScaleWebMcpTools", { value: tools });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }) {
          tools[tool.name] = tool;
          options?.signal?.addEventListener(
            "abort",
            () => {
              delete tools[tool.name];
            },
            { once: true },
          );
        },
      },
    });
  });

  await createBoard(page, "Collective inquiry demo");
  await page.getByTestId("settings-button").click();
  const settingsDrawer = page.getByTestId("settings-drawer");
  await expandToolPermissions(page);
  await expect(settingsDrawer.getByRole("checkbox", { name: "Enable Images" })).toBeChecked();
  await page.getByTestId("settings-button").click();

  // The shipped surface: three reads and the four generic writes, and nothing else.
  await expect
    .poll(() => page.evaluate(() => Object.keys(window.__spaceScaleWebMcpTools).sort()))
    .toEqual([
      "insert_comment",
      "insert_image",
      "insert_sticky",
      "insert_video",
      "read_live_class_vote",
      "read_templates",
      "watch_board",
    ]);
  expect(
    await page.evaluate(
      (withheld) => withheld.filter((name) => name in window.__spaceScaleWebMcpTools),
      WITHHELD_TOOLS,
    ),
  ).toEqual([]);

  // The compact header control reports readiness and opens a page-session call history.
  const webMcpStatus = page.getByTestId("webmcp-status");
  const webMcpStatusTime = page.getByTestId("webmcp-status-time");
  const mcpActivity = page.getByTestId("mcp-activity-menu");
  await expect(webMcpStatus).toHaveAttribute("data-state", "ready");
  await expect(webMcpStatus).toHaveAttribute("data-host", "linked");
  await expect(webMcpStatus).toContainText("MCP");
  await expect(webMcpStatusTime).toHaveText("Ready");
  await expect(page.getByTestId("save-status")).not.toContainText("·");
  await webMcpStatus.click();
  await expect(mcpActivity).toBeVisible();
  await expect(mcpActivity).toContainText(/\d+ site tools ready/u);
  await expect(mcpActivity).toContainText("No MCP calls in this tab yet.");
  await webMcpStatus.click();
  await expect(mcpActivity).toBeHidden();
  // The AI button exists only while a problem-step watch is live in this browser.
  await expect(page.locator("[data-selection-ai-wrap]")).toBeHidden();
  await expect(page.getByTestId("ai-watch-indicator")).toBeHidden();
  await expect(page.getByTestId("tool-ai")).toBeHidden();
  expect(
    await page.evaluate(() => window.__spaceScaleWebMcpTools.watch_board?.annotations),
  ).toEqual({ readOnlyHint: true, untrustedContentHint: true });
  expect(
    await page.evaluate(() => window.__spaceScaleWebMcpTools.insert_comment?.annotations),
  ).toEqual({ readOnlyHint: false, untrustedContentHint: true });

  // A description is the contract a host reads at discovery; naming a withheld tool sends it to
  // a call that cannot succeed.
  const advertised = await page.evaluate(() =>
    Object.fromEntries(
      Object.entries(window.__spaceScaleWebMcpTools).map(([name, tool]) => [
        name,
        tool.description,
      ]),
    ),
  );
  for (const description of Object.values(advertised)) {
    for (const withheld of WITHHELD_TOOLS) {
      expect(description).not.toContain(withheld);
    }
  }

  const templates = await page.evaluate(() => {
    const tool = window.__spaceScaleWebMcpTools.read_templates;
    if (!tool) throw new Error("The template reader was not registered.");
    return tool.execute({}, { signal: new AbortController().signal });
  });
  expect(templates).toMatchObject({ scope: "board_activity_templates", writeTool: null });
  expect(Number(templates.templateCount)).toBeGreaterThan(0);
  expect(JSON.stringify(templates)).not.toContain("itemId");

  await chooseMoreTool(page, "activities-button");
  await page.getByTestId("activity-collective-inquiry-demo").click();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const canvasItems = page.locator("#drawing-area [data-item-id]");
  await expect(canvasItems).toHaveCount(13);

  const watchStart = await page.evaluate(() => {
    const tool = window.__spaceScaleWebMcpTools.watch_board;
    if (!tool) throw new Error("The problem-step watch was not registered.");
    return tool.execute({ action: "start" }, { signal: new AbortController().signal });
  });
  expect(watchStart).toMatchObject({
    status: "started",
    durationSeconds: 900,
    nextSeq: expect.any(Number),
    canComment: true,
    steps: expect.arrayContaining([expect.objectContaining({ kind: "sticky" })]),
  });
  await expect(page.getByTestId("ai-watch-indicator")).toBeVisible();
  await expect(page.getByTestId("ai-watch-indicator")).toContainText("AI watching");
  await expect(webMcpStatus).toHaveAttribute("data-state", "watch");
  const askAi = page.getByTestId("selection-ai");
  await expect(askAi).toBeVisible();
  await expect(askAi).toBeEnabled();

  // A request from the board resolves the host's pending wait with a reply plan that names
  // the generic comment write.
  const requestedResult = page.evaluate(
    ({ watchToken, afterSeq }) => {
      const tool = window.__spaceScaleWebMcpTools.watch_board;
      if (!tool) throw new Error("The problem-step watch was not registered.");
      return tool.execute(
        { action: "wait", watchToken, afterSeq, waitMs: 20_000 },
        { signal: new AbortController().signal },
      );
    },
    { watchToken: String(watchStart.watchToken), afterSeq: Number(watchStart.nextSeq) },
  );
  await expect(webMcpStatus).toHaveAttribute("data-state", "active");
  await askAi.click();
  const aiMenu = page.getByTestId("ai-assist-menu");
  await expect(aiMenu).toBeVisible();
  await expect(aiMenu.getByRole("menuitem")).toHaveCount(6);
  await expect(aiMenu.getByRole("menuitem", { name: "Grade" })).toHaveCount(0);
  await aiMenu.locator("[data-ai-assist-note]").fill("Not sure about the second step");
  await aiMenu.getByRole("menuitem", { name: "Critique" }).click();
  await expect(aiMenu).toBeHidden();
  await expect(page.getByTestId("toast-region")).toContainText(
    "Sent to the AI assistant: Critique",
  );
  const requested = await requestedResult;
  expect(requested).toMatchObject({
    status: "requested",
    continueWatching: true,
    canComment: true,
    requests: [
      {
        action: "critique",
        note: "Not sure about the second step",
        reply: {
          via: "comment",
          call: {
            tool: "insert_comment",
            input: {
              watchToken: watchStart.watchToken,
              stepAlias: expect.any(String),
              action: "critique",
            },
          },
        },
      },
    ],
  });

  // The request covered every watched step and left no single selection behind, so the reply
  // plan's watchToken and stepAlias are the only handle on what is being answered.
  const stepAlias = String(
    (requested.requests as Array<{ reply: { call: { input: { stepAlias: string } } } }>)[0]?.reply
      .call.input.stepAlias,
  );
  const answered = await page.evaluate(
    ({ watchToken, alias }) => {
      const tool = window.__spaceScaleWebMcpTools.insert_comment;
      if (!tool) throw new Error("The comment write was not registered.");
      return tool.execute(
        {
          watchToken,
          stepAlias: alias,
          action: "critique",
          body: "Check the division step: $6/2=3$, so $x=3$.",
        },
        { signal: new AbortController().signal },
      );
    },
    { watchToken: String(watchStart.watchToken), alias: stepAlias },
  );
  expect(answered).toMatchObject({ status: "commented", stepAlias, writtenBy: "ai" });
  await expect(page.locator("[data-comments-count]")).toHaveText("1");
  await expect(webMcpStatus).toHaveAttribute("data-state", "watch");
  await expect(webMcpStatusTime).toHaveText(/^\d{1,2}:\d{2}\s?(?:AM|PM)?$/iu);
  await webMcpStatus.click();
  await expect(mcpActivity).toContainText("insert_comment");
  await expect(mcpActivity).toContainText("Completed");
  await expect(mcpActivity).not.toContainText("watch_board");
  await webMcpStatus.click();
  await expect(mcpActivity).toBeHidden();
  await openSettingsDrawer(page);
  await page.getByTestId("comments-button").click();
  const answeredDrawer = page.getByTestId("comments-drawer");
  await expect(answeredDrawer.locator(".comment-card")).toHaveCount(1);
  await expect(answeredDrawer.locator(".comment-card .assistance-tag")).toHaveText("AI · Critique");
  await expect(answeredDrawer.locator(".comment-card strong").first()).not.toHaveText("AI");
  await answeredDrawer.getByRole("button", { name: "Close comments" }).click();

  const watchResult = page.evaluate(
    ({ watchToken, afterSeq }) => {
      const tool = window.__spaceScaleWebMcpTools.watch_board;
      if (!tool) throw new Error("The problem-step watch was not registered.");
      return tool.execute(
        { action: "wait", watchToken, afterSeq, waitMs: 20_000 },
        { signal: new AbortController().signal },
      );
    },
    { watchToken: String(watchStart.watchToken), afterSeq: Number(watchStart.nextSeq) },
  );
  const firstSticky = page.locator("#drawing-area .board-item-sticky").first();
  const firstStickyBounds = await firstSticky.boundingBox();
  if (!firstStickyBounds) throw new Error("The watched sticky has no layout bounds.");
  await page.getByRole("button", { name: /^Select/u }).click();
  await page.mouse.dblclick(
    firstStickyBounds.x + firstStickyBounds.width / 2,
    firstStickyBounds.y + firstStickyBounds.height / 2,
  );
  const stickyEditor = page.getByTestId("canvas-text-editor");
  await expect(stickyEditor).toHaveAttribute("aria-label", "Edit sticky note");
  await stickyEditor.fill(`${await stickyEditor.inputValue()}\nA newly saved problem step.`);
  await stickyEditor.press("Control+Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  expect(await watchResult).toMatchObject({
    status: "changed",
    changes: [
      {
        steps: [
          {
            alias: expect.any(String),
            kind: "sticky",
            change: "updated",
            text: expect.stringContaining("A newly saved problem step."),
          },
        ],
      },
    ],
  });
  await page.evaluate((watchToken) => {
    const tool = window.__spaceScaleWebMcpTools.watch_board;
    if (!tool) throw new Error("The problem-step watch was not registered.");
    return tool.execute({ action: "stop", watchToken }, { signal: new AbortController().signal });
  }, String(watchStart.watchToken));
  await expect(page.locator("[data-selection-ai-wrap]")).toBeHidden();
  await expect(page.getByTestId("ai-watch-indicator")).toBeHidden();
  await expect(page.getByTestId("tool-ai")).toBeHidden();

  // Each generic write lands one object where the call asks, tagged as written by AI.
  const written = await page.evaluate(
    async ({ png }) => {
      const signal = new AbortController().signal;
      const tools = window.__spaceScaleWebMcpTools;
      for (const name of ["insert_sticky", "insert_image", "insert_video"]) {
        if (!tools[name]) throw new Error(`${name} was not registered.`);
      }
      const sticky = await tools.insert_sticky?.execute(
        {
          location: { x: 640, y: 60 },
          text: "What would change your mind about $x=3$?",
          fill: "mint",
        },
        { signal },
      );
      const video = await tools.insert_video?.execute(
        { location: { x: 640, y: 320 }, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { signal },
      );
      const image = await tools.insert_image?.execute(
        { location: { x: 640, y: 620 }, imageDataUrl: png, alt: "A single grey pixel" },
        { signal },
      );
      return { sticky, video, image };
    },
    { png: TINY_PNG },
  );
  expect(written.sticky).toMatchObject({
    status: "inserted",
    objectKind: "sticky",
    location: { x: 640, y: 60 },
    aiAttributed: true,
    undoable: true,
  });
  expect(written.video).toMatchObject({ status: "inserted", objectKind: "video" });
  expect(written.image).toMatchObject({ status: "inserted", objectKind: "image" });
  expect(JSON.stringify(written)).not.toContain("itemId");

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(canvasItems).toHaveCount(16);
  await expect(page.locator('#drawing-area [data-assisted-by="ai"]')).toHaveCount(3);
  await expect(page.locator("#drawing-area .creator-badge-ai").first()).toBeVisible();
  await expect(page.locator("#drawing-area")).not.toContainText("AI-assisted");

  // A comment attaches to whatever saved object covers the location it names, so the note the
  // assistant just wrote is a target like any other.
  const commented = await page.evaluate(() => {
    const tool = window.__spaceScaleWebMcpTools.insert_comment;
    if (!tool) throw new Error("The comment write was not registered.");
    return tool.execute(
      // The centre of the 180x140 note written at 640, 60.
      { location: { x: 730, y: 130 }, body: "Check the division step: $6/2=3$, so $x=3$." },
      { signal: new AbortController().signal },
    );
  });
  expect(commented).toMatchObject({ status: "commented", objectKind: "sticky", writtenBy: "ai" });
  await expect(page.locator("[data-comments-count]")).toHaveText("2");
  await openSettingsDrawer(page);
  await page.getByTestId("comments-button").click();
  const commentsDrawer = page.getByTestId("comments-drawer");
  await expect(commentsDrawer.locator(".comment-card")).toHaveCount(2);
  // The watch reply carries the action it answered; the coordinate-targeted one has none.
  await expect(commentsDrawer.locator(".comment-card .assistance-tag")).toHaveText([
    "AI",
    "AI · Critique",
  ]);
  await expect(commentsDrawer.locator(".comment-card strong").first()).not.toHaveText("AI");
  await commentsDrawer.getByRole("button", { name: "Close comments" }).click();
  await openSettingsDrawer(page);

  // Every write is one ordinary command, so each undoes on its own.
  for (const remaining of [15, 14, 13]) {
    await page.waitForTimeout(300);
    await page.getByTestId("undo-button").click();
    await expect(canvasItems).toHaveCount(remaining);
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  }

  // A write the board cannot place refuses rather than guessing.
  const refusals = await page.evaluate(async () => {
    const signal = new AbortController().signal;
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["insert_sticky", { text: "a", fill: "neon" }],
      ["insert_video", { url: "https://example.com/clip.mp4" }],
      ["insert_image", { imageDataUrl: "https://example.com/cat.png", alt: "A cat" }],
    ];
    const messages: string[] = [];
    for (const [name, input] of attempts) {
      const tool = window.__spaceScaleWebMcpTools[name];
      if (!tool) throw new Error(`${name} was not registered.`);
      try {
        await tool.execute(input, { signal });
        messages.push("unexpected success");
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    return messages;
  });
  expect(refusals[0]).toContain("fill must be");
  expect(refusals[1]).toContain("YouTube or Vimeo");
  expect(refusals[2]).toContain("never fetches an external image");
  await expect(canvasItems).toHaveCount(13);
});
