import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard, drag, drawShape, moveItem } from "./helpers";

test("shape palette, rotatable protractor, snapping, partial erase, and feature gates work together", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Geometry acceptance runs in Chromium.");

  await createBoard(page, "Geometry lab");
  const presets = [
    ["Square", 0.12, 0.2],
    ["Rectangle", 0.28, 0.2],
    ["Triangle", 0.44, 0.2],
    ["Rhombus", 0.6, 0.2],
    ["Pentagon", 0.2, 0.42],
    ["Hexagon", 0.4, 0.42],
    ["Circle", 0.6, 0.42],
  ] as const;
  for (const [name, horizontal, vertical] of presets) {
    const start = await canvasPoint(page, horizontal, vertical);
    await drawShape(page, name, start, { x: start.x + 72, y: start.y + 58 });
  }
  await expect(page.locator("#drawing-area .board-item-rectangle")).toHaveCount(2);
  await expect(page.locator("#drawing-area .board-item-polygon")).toHaveCount(4);
  await expect(page.locator("#drawing-area .board-item-ellipse")).toHaveCount(1);

  const placement = await canvasPoint(page, 0.76, 0.62);
  await page.getByTestId("tool-protractor").click();
  await page.mouse.click(placement.x, placement.y);
  const protractor = page.locator("#drawing-area .board-item-protractor");
  await expect(protractor).toHaveCount(1);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const rotateHandle = page.locator("[data-rotate-handle='protractor']");
  await expect(rotateHandle).toBeVisible();

  const rotation = await protractor.evaluate((node) => {
    const matrix = (node as SVGGraphicsElement).getScreenCTM();
    if (!matrix) throw new Error("The protractor has no screen transform.");
    const localHandle = new DOMPoint(0, -190).matrixTransform(matrix);
    const pivot = new DOMPoint(0, 0).matrixTransform(matrix);
    const dx = localHandle.x - pivot.x;
    const dy = localHandle.y - pivot.y;
    return {
      start: { x: localHandle.x, y: localHandle.y },
      end: { x: pivot.x - dy, y: pivot.y + dx },
    };
  });
  const beforeRotation = await protractor.getAttribute("transform");
  await drag(page, rotation.start, rotation.end, { steps: 8 });
  await expect.poll(() => protractor.getAttribute("transform")).not.toBe(beforeRotation);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const beforeMove = await protractor.getAttribute("transform");
  await moveItem(page, protractor, -45, 24);
  await expect(protractor).not.toHaveAttribute("transform", beforeMove ?? "");

  const snapTarget = await protractor.evaluate((node) => {
    const matrix = (node as SVGGraphicsElement).getScreenCTM();
    if (!matrix) throw new Error("The protractor has no screen transform.");
    const center = new DOMPoint(0, 0).matrixTransform(matrix);
    const radians = Math.PI / 3;
    const tick = new DOMPoint(Math.cos(radians) * 160, -Math.sin(radians) * 160).matrixTransform(
      matrix,
    );
    return {
      center: { x: center.x, y: center.y },
      nearTick: { x: tick.x + 5, y: tick.y + 4 },
    };
  });
  await page.getByTestId("tool-line").click();
  await page.mouse.move(snapTarget.center.x, snapTarget.center.y);
  await page.mouse.down();
  await page.mouse.move(snapTarget.nearTick.x, snapTarget.nearTick.y, { steps: 5 });
  await expect(page.locator("#local-preview-layer .connector-snap-halo")).toHaveCount(2);
  await page.mouse.up();
  await expect(page.locator("#drawing-area .board-item-line")).toHaveCount(1);

  await page.getByTestId("settings-button").click();
  const settings = page.getByTestId("settings-drawer");
  await expect(settings).toBeVisible();
  const protractorGate = settings.locator("input[data-feature='protractor']");
  await expect(protractorGate).toBeChecked();
  await protractorGate.uncheck();
  await expect(page.getByTestId("tool-protractor")).toBeHidden();
  await protractorGate.check();
  await expect(page.getByTestId("tool-protractor")).toBeVisible();
});
