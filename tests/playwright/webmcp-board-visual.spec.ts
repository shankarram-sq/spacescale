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

test("teacher can expose only selected handwriting as an isolated WebMCP visual", async ({
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

  const start = await canvasPoint(page, 0.3, 0.42);
  const end = { x: start.x + 160, y: start.y + 90 };
  const handwriting = await drawShape(page, "Pencil", start, end);
  const handwritingId = await handwriting.getAttribute("data-item-id");
  expect(handwritingId).toBeTruthy();

  const privatePoint = await canvasPoint(page, 0.72, 0.42);
  await page.getByTestId("tool-sticky").click();
  await page.mouse.click(privatePoint.x, privatePoint.y);
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();
  await editor.fill("UNSELECTED PRIVATE NOTE");
  await editor.press("Control+Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  await page.getByRole("button", { name: /^Select/u }).click();
  const handwritingBounds = await handwriting.boundingBox();
  expect(handwritingBounds).not.toBeNull();
  if (!handwritingBounds) throw new Error("The handwriting stroke has no layout bounds.");
  await page.mouse.click(
    handwritingBounds.x + handwritingBounds.width / 2,
    handwritingBounds.y + handwritingBounds.height / 2,
  );
  await expect(page.getByTestId("selection-actions")).toBeVisible();

  const resultPromise = page.evaluate(() => {
    const tool = window.__spaceScaleVisualTools.inspect_selected_board_visual;
    if (!tool) throw new Error("The visual inspection tool was not registered.");
    return tool.execute({}, { signal: new AbortController().signal });
  });
  const consent = page.getByTestId("webmcp-visual-consent-dialog");
  await expect(consent).toBeVisible();
  await expect(consent).toContainText("handwriting / pencil stroke");
  await expect(page.getByTestId("webmcp-visual-review-dialog")).toBeHidden();
  await consent.getByRole("button", { name: "Share 1 visual item" }).click();

  const result = await resultPromise;
  expect(result).toMatchObject({
    visualReady: true,
    preview: {
      state: "open_in_live_page",
      scope: "teacher_selected_saved_items_only",
      itemCount: 1,
      itemKinds: { pencil: 1 },
      containsHandwriting: true,
      privateImagesRenderedAsPlaceholders: 0,
      aliases: [
        {
          alias: "visual_1",
          kind: "pencil",
          action: { type: "created", objectKind: "pencil" },
          createdBy: {
            participantId: expect.any(String),
            displayName: expect.any(String),
          },
        },
      ],
    },
  });
  expect(JSON.stringify(result)).not.toContain("Unknown participant");
  expect(JSON.stringify(result)).not.toContain(handwritingId as string);

  const review = page.getByTestId("webmcp-visual-review-dialog");
  await expect(review).toBeVisible();
  await expect(review).toContainText("AI can inspect now");
  await expect(review).toContainText("1 handwriting stroke");
  const visual = review.locator('img[data-visual-scope="teacher-selected-items-only"]');
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
  expect(visualMarkup.outerHTML).not.toContain(handwritingId as string);
  expect(visualMarkup.outerHTML).not.toContain("UNSELECTED PRIVATE NOTE");

  await page.screenshot({ path: "/tmp/spacescale-webmcp-handwriting-visual.png", fullPage: true });
  await review.getByRole("button", { name: "Finish visual review" }).click();
  await expect(review).toBeHidden();
  await expect(review.locator("[data-webmcp-visual-surface]")).toBeEmpty();
  await expect(page.locator("#drawing-area .board-item-sticky")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
