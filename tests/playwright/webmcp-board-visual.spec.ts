import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard, drawShape } from "./helpers";

type RegisteredTool = {
  name: string;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
};

declare global {
  interface Window {
    __spaceScaleVisualTools: Record<string, RegisteredTool>;
  }
}

test("a board participant can expose only selected handwriting as an isolated WebMCP visual", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The WebMCP visual smoke runs in Chromium.");
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.addInitScript(() => {
    const tools: Record<string, RegisteredTool> = {};
    Object.defineProperty(window, "__spaceScaleVisualTools", { value: tools });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }) {
          tools[tool.name] = tool;
          options?.signal?.addEventListener("abort", () => delete tools[tool.name], { once: true });
        },
      },
    });
  });

  await createBoard(page, "Handwritten ideas");
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(window.__spaceScaleVisualTools.inspect_selected_board_visual)),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => window.__spaceScaleVisualTools.inspect_selected_board_visual?.annotations,
    ),
  ).toEqual({ readOnlyHint: true, untrustedContentHint: true });

  const equationPoint = await canvasPoint(page, 0.36, 0.22);
  await page.getByTestId("tool-text").click();
  await page.mouse.click(equationPoint.x, equationPoint.y);
  const equationEditor = page.getByTestId("canvas-text-editor");
  await equationEditor.fill("x² + 7x + 10 = 0");
  await equationEditor.press("Control+Enter");
  const equation = page.locator("#drawing-area .board-item-text").last();
  await expect(equation).toContainText("x² + 7x + 10 = 0");

  const start = await canvasPoint(page, 0.34, 0.47);
  const points = [
    { x: start.x + 35, y: start.y - 15 },
    { x: start.x + 65, y: start.y + 35 },
    { x: start.x + 95, y: start.y + 75 },
    { x: start.x + 130, y: start.y + 90 },
    { x: start.x + 165, y: start.y + 75 },
    { x: start.x + 195, y: start.y + 35 },
    { x: start.x + 225, y: start.y - 15 },
  ];
  const handwriting = [
    await drawShape(
      page,
      "Pencil",
      { x: start.x, y: start.y + 50 },
      { x: start.x + 260, y: start.y + 50 },
    ),
    await drawShape(
      page,
      "Pencil",
      { x: start.x + 130, y: start.y - 60 },
      { x: start.x + 130, y: start.y + 150 },
    ),
  ];
  for (const [index, point] of points.slice(0, -1).entries()) {
    handwriting.push(
      await drawShape(page, "Pencil", point, points[index + 1] as { x: number; y: number }),
    );
  }
  const selectedItemIds = [
    await equation.getAttribute("data-item-id"),
    ...(await Promise.all(handwriting.map((stroke) => stroke.getAttribute("data-item-id")))),
  ];
  expect(selectedItemIds.every(Boolean)).toBe(true);

  const privatePoint = await canvasPoint(page, 0.78, 0.45);
  await page.getByTestId("tool-sticky").click();
  await page.mouse.click(privatePoint.x, privatePoint.y);
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();
  await editor.fill("UNSELECTED PRIVATE NOTE");
  await editor.press("Control+Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  await page.getByRole("button", { name: /^Select/u }).click();
  const selectedVisuals = [equation, ...handwriting];
  const selectedBounds = await Promise.all(selectedVisuals.map((item) => item.boundingBox()));
  if (selectedBounds.some((bounds) => bounds === null)) {
    throw new Error("A selected equation or handwriting stroke has no layout bounds.");
  }
  for (const [index, bounds] of selectedBounds.entries()) {
    if (index === 1) await page.keyboard.down("Shift");
    const target = bounds as NonNullable<(typeof selectedBounds)[number]>;
    const x = index === 1 ? target.x + target.width * 0.08 : target.x + target.width / 2;
    const y = index === 2 ? target.y + target.height * 0.08 : target.y + target.height / 2;
    await page.mouse.click(x, y);
  }
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("selection-actions")).toBeVisible();

  const result = await page.evaluate(() => {
    const tool = window.__spaceScaleVisualTools.inspect_selected_board_visual;
    if (!tool) throw new Error("The visual inspection tool was not registered.");
    return tool.execute({}, { signal: new AbortController().signal });
  });
  expect(result).toMatchObject({
    visualReady: true,
    preview: {
      state: "open_in_live_page",
      scope: "browser_selected_saved_items_only",
      itemCount: 9,
      itemKinds: { pencil: 8, text: 1 },
      containsHandwriting: true,
      privateImagesRenderedAsPlaceholders: 0,
    },
  });
  const aliases = (result.preview as { aliases: Array<{ kind: string }> }).aliases;
  expect(aliases).toHaveLength(9);
  expect(aliases.map((alias) => alias.kind).sort()).toEqual([
    "pencil",
    "pencil",
    "pencil",
    "pencil",
    "pencil",
    "pencil",
    "pencil",
    "pencil",
    "text",
  ]);
  for (const alias of aliases) {
    expect(alias).toMatchObject({
      action: { type: "created", objectKind: alias.kind },
      createdBy: {
        participantId: expect.any(String),
        displayName: expect.any(String),
      },
    });
  }
  expect(JSON.stringify(result)).not.toContain("Unknown participant");
  for (const selectedItemId of selectedItemIds) {
    expect(JSON.stringify(result)).not.toContain(selectedItemId as string);
  }

  const review = page.getByTestId("webmcp-visual-review-dialog");
  await expect(review).toBeVisible();
  await expect(review).toContainText("Selected visual inspection");
  await expect(review).toContainText("8 handwriting strokes");
  const visual = review.locator('img[data-visual-scope="browser-selected-items-only"]');
  await expect(visual).toBeVisible();
  await expect(visual).toHaveAttribute("src", /^blob:/u);
  const visualMarkup = await visual.evaluate((node) => {
    const image = node as HTMLImageElement;
    return {
      outerHTML: image.outerHTML,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  });
  expect(visualMarkup.naturalWidth).toBeGreaterThan(0);
  expect(visualMarkup.naturalHeight).toBeGreaterThan(0);
  for (const selectedItemId of selectedItemIds) {
    expect(visualMarkup.outerHTML).not.toContain(selectedItemId as string);
  }
  expect(visualMarkup.outerHTML).not.toContain("UNSELECTED PRIVATE NOTE");

  await page.screenshot({ path: "/tmp/spacescale-webmcp-handwriting-visual.png", fullPage: true });
  await review.getByRole("button", { name: "Finish visual review" }).click();
  await expect(review).toBeHidden();
  await expect(review.locator("[data-webmcp-visual-surface]")).toBeEmpty();
  await expect(page.locator("#drawing-area .board-item-sticky")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
