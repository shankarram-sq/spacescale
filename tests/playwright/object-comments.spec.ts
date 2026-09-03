import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard, drawShape, moveItem } from "./helpers";

test("object comments follow moves, hide after orphaning, and resolve", async ({
  page,
}, testInfo) => {
  test.skip(
    !["chromium", "mobile-chromium"].includes(testInfo.project.name),
    "Focused comment lifecycle runs in Chromium.",
  );

  const browserProblems: string[] = [];
  page.on("pageerror", (error) => browserProblems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      browserProblems.push(message.text());
    }
  });

  await createBoard(page, "Comment review");
  await expect(page).toHaveTitle("Comment review — SpaceScale");
  await expect(page.getByTestId("board-shell")).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);

  const start = await canvasPoint(page, 0.32, 0.38);
  const shape = await drawShape(page, "Rectangle", start, {
    x: start.x + 130,
    y: start.y + 88,
  });
  const shapeBounds = await shape.boundingBox();
  if (!shapeBounds) throw new Error("The comment target has no layout bounds.");
  await page.getByRole("button", { name: /^Select/u }).click();
  await page.mouse.click(
    shapeBounds.x + shapeBounds.width / 2,
    shapeBounds.y + shapeBounds.height / 2,
  );
  await page.getByRole("button", { name: "Comment on selected object" }).click();

  const drawer = page.getByTestId("comments-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("textbox", { name: "Comment" }).fill("Align this object with the title.");
  await drawer.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(drawer.locator(".comment-card")).toHaveCount(1);
  await expect(drawer.locator(".comment-card")).toHaveAttribute("data-state", "open");
  await expect(drawer.locator(".comment-body")).toHaveText("Align this object with the title.");

  const marker = page.locator("#comment-layer .comment-marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("aria-label", "1 open comment on this object");
  const originalMarkerPosition = await marker.locator("circle").evaluate((node) => ({
    cx: node.getAttribute("cx"),
    cy: node.getAttribute("cy"),
  }));

  await drawer.getByRole("button", { name: "Close comments" }).click();
  await moveItem(page, shape, 76, 44);
  await expect
    .poll(() =>
      marker.locator("circle").evaluate((node) => ({
        cx: node.getAttribute("cx"),
        cy: node.getAttribute("cy"),
      })),
    )
    .not.toEqual(originalMarkerPosition);

  await page.getByRole("button", { name: "Delete selected items" }).click();
  await expect(shape).toHaveCount(0);
  await expect(marker).toHaveCount(0);
  await page.getByTestId("comments-button").click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".comment-card")).toHaveCount(0);
  await expect(page.locator("[data-comments-count]")).toBeHidden();

  await drawer.getByRole("checkbox", { name: "Show resolved & orphaned" }).check();
  const hiddenComment = drawer.locator(".comment-card");
  await expect(hiddenComment).toHaveCount(1);
  await expect(hiddenComment).toHaveAttribute("data-state", "orphaned");
  await expect(hiddenComment).toContainText("Deleted object");
  await page.screenshot({
    path: `/tmp/spacescale-comments-orphaned-${testInfo.project.name}.png`,
    fullPage: false,
  });

  await hiddenComment.getByRole("button", { name: "Resolve" }).click();
  await expect(hiddenComment).toHaveAttribute("data-state", "resolved");
  await drawer.getByRole("checkbox", { name: "Show resolved & orphaned" }).uncheck();
  await expect(drawer.locator(".comment-card")).toHaveCount(0);
  expect(browserProblems).toEqual([]);
});
