import { expect, type Page, test } from "@playwright/test";
import { canvasPoint, createBoard, dispatchSyntheticPointerGesture, drawShape } from "./helpers";

async function setRange(page: Page, selector: string, value: number): Promise<void> {
  await page.locator(selector).evaluate((node, nextValue) => {
    const input = node as HTMLInputElement;
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

test("line, text, styles, constrained shapes, eraser, and pen input commit canonically", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Pointer-tool acceptance runs in Chromium.");

  await createBoard(page, "Tool acceptance");
  await page.getByTestId("style-button").click();
  const style = page.getByTestId("style-popover");
  await expect(style).toBeVisible();
  await style.getByRole("button", { name: "Use #e5484d" }).click();
  await setRange(page, "[data-style-stroke]", 7);
  await setRange(page, "[data-style-opacity]", 55);
  await setRange(page, "[data-style-font]", 40);
  await expect(style.locator("[data-width-output]")).toHaveText("7");
  await expect(style.locator("[data-opacity-output]")).toHaveText("55%");
  await expect(style.locator("[data-font-output]")).toHaveText("40");
  await page.getByTestId("style-button").click();
  await expect(style).toBeHidden();

  const lineStart = await canvasPoint(page, 0.14, 0.18);
  const line = await drawShape(page, "Straight line", lineStart, {
    x: lineStart.x + 105,
    y: lineStart.y + 35,
  });
  await expect(line).toHaveClass(/board-item-line/u);
  await expect(line).toHaveAttribute("stroke", "#e5484d");
  await expect(line).toHaveAttribute("stroke-width", "7");
  await expect(line).toHaveAttribute("stroke-opacity", "0.55");

  const textPoint = await canvasPoint(page, 0.52, 0.2);
  await page.getByRole("button", { name: /^Text/u }).click();
  await page.mouse.click(textPoint.x, textPoint.y);
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();
  await editor.fill("Shared words");
  await editor.press("Control+Enter");
  const text = page.locator("#drawing-area .board-item-text");
  await expect(text).toHaveCount(1);
  await expect(text).toContainText("Shared words");
  await expect(text).toHaveAttribute("fill", "#e5484d");
  await expect(text).toHaveAttribute("font-size", "40");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const rectangleStart = await canvasPoint(page, 0.16, 0.48);
  const square = await drawShape(
    page,
    "Rectangle",
    rectangleStart,
    { x: rectangleStart.x + 72, y: rectangleStart.y + 39 },
    { shift: true },
  );
  await expect(square).toHaveClass(/board-item-rectangle/u);
  const squareSize = await square.evaluate((node) => ({
    width: Number(node.getAttribute("width")),
    height: Number(node.getAttribute("height")),
  }));
  expect(squareSize.width).toBeGreaterThan(0);
  expect(squareSize.width).toBe(squareSize.height);

  const ellipseStart = await canvasPoint(page, 0.48, 0.48);
  const circle = await drawShape(
    page,
    "Ellipse",
    ellipseStart,
    { x: ellipseStart.x + 44, y: ellipseStart.y + 76 },
    { shift: true },
  );
  await expect(circle).toHaveClass(/board-item-ellipse/u);
  const radii = await circle.evaluate((node) => ({
    x: Number(node.getAttribute("rx")),
    y: Number(node.getAttribute("ry")),
  }));
  expect(radii.x).toBeGreaterThan(0);
  expect(radii.x).toBe(radii.y);

  const penStart = await canvasPoint(page, 0.72, 0.55);
  const beforePen = await page.locator("#drawing-area [data-item-id]").count();
  await page.getByRole("button", { name: /^Pencil/u }).click();
  await dispatchSyntheticPointerGesture(page, "pen", [
    { x: penStart.x, y: penStart.y, pressure: 0.2 },
    { x: penStart.x + 22, y: penStart.y + 20, pressure: 0.5 },
    { x: penStart.x + 48, y: penStart.y - 8, pressure: 0.8 },
    { x: penStart.x + 75, y: penStart.y + 28, pressure: 0.4 },
  ]);
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(beforePen + 1);
  await expect(page.locator("#drawing-area .board-item-pencil")).toHaveCount(1);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const erasedId = await square.getAttribute("data-item-id");
  expect(erasedId).toBeTruthy();
  const squareBounds = await square.boundingBox();
  expect(squareBounds).not.toBeNull();
  if (!squareBounds) throw new Error("The square has no layout bounds.");
  await page.getByRole("button", { name: /^Eraser/u }).click();
  await page.mouse.click(
    squareBounds.x + squareBounds.width / 2,
    squareBounds.y + squareBounds.height / 2,
  );
  await expect(page.locator(`#drawing-area [data-item-id="${erasedId}"]`)).toHaveCount(0);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
});

test("the complete board remains usable at a 320px viewport", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The narrow-layout scenario runs in mobile Chromium.",
  );

  await page.setViewportSize({ width: 320, height: 640 });
  await createBoard(page, "Pocket canvas");

  const layout = await page.evaluate(() => {
    const canvas = document.querySelector("#board-canvas")?.getBoundingClientRect();
    const shell = document.querySelector("[data-testid='board-shell']")?.getBoundingClientRect();
    return {
      innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      canvas: canvas ? { left: canvas.left, right: canvas.right, width: canvas.width } : null,
      shell: shell ? { left: shell.left, right: shell.right, width: shell.width } : null,
    };
  });
  expect(layout.innerWidth).toBe(320);
  expect(layout.documentWidth).toBeLessThanOrEqual(320);
  expect(layout.bodyWidth).toBeLessThanOrEqual(320);
  expect(layout.shell).not.toBeNull();
  expect(layout.shell?.left).toBeGreaterThanOrEqual(0);
  expect(layout.shell?.right).toBeLessThanOrEqual(320);
  expect(layout.canvas?.width).toBeGreaterThan(240);
  expect(layout.canvas?.right).toBeLessThanOrEqual(320);

  const tools = page.getByTestId("tool-rail").locator("button[data-tool]");
  await expect(tools).toHaveCount(11);
  await expect(page.getByTestId("tool-image")).toHaveAttribute("aria-label", "Add image (I)");
  await expect(page.getByTestId("tool-image").locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("tool-eraser").locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("tool-image")).toBeDisabled();
  for (const tool of await tools.all()) {
    await tool.scrollIntoViewIfNeeded();
    const bounds = await tool.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.width).toBeGreaterThanOrEqual(42);
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
  }
  await page.getByRole("button", { name: /^Pan canvas/u }).click();
  await expect(page.getByRole("button", { name: /^Pan canvas/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("access-button").click();
  const drawer = page.getByTestId("access-drawer");
  await expect(drawer).toBeVisible();
  await drawer.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished));
  });
  const drawerBounds = await drawer.boundingBox();
  expect(drawerBounds).not.toBeNull();
  expect(drawerBounds?.x).toBeGreaterThanOrEqual(0);
  expect((drawerBounds?.x ?? 0) + (drawerBounds?.width ?? 0)).toBeLessThanOrEqual(320);
  await drawer.getByRole("button", { name: "Close access panel" }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator("#board-canvas")).toBeVisible();
});
