import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard } from "./helpers";

test("videos, MathJax text surfaces, and compact canvas controls work together", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Focused media and compact-layout QA runs in Chromium.",
  );

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.context().route("https://www.youtube-nocookie.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Video preview</title>",
    }),
  );

  await createBoard(page, "Math and media canvas");
  const stickyPoint = await canvasPoint(page, 0.3, 0.32);
  await page.getByTestId("tool-sticky").click();
  await page.mouse.click(stickyPoint.x, stickyPoint.y);
  const stickyEditor = page.getByTestId("canvas-text-editor");
  await expect(stickyEditor).toBeFocused();
  await stickyEditor.fill("Energy is $E=mc^2$");
  await stickyEditor.press("Control+Enter");
  await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sticky-math-content")).toHaveAttribute("data-math-state", "ready");
  await expect(page.locator(".sticky-math-content mjx-container")).toHaveCount(1);

  await page.getByRole("button", { name: "Comment on selected object" }).click();
  const comments = page.getByTestId("comments-drawer");
  await comments.getByRole("textbox", { name: "Comment" }).fill("Because $c$ is constant.");
  await comments.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(comments.locator(".comment-body")).toHaveAttribute("data-math-state", "ready");
  await expect(comments.locator(".comment-body mjx-container")).toHaveCount(1);
  await comments.getByRole("button", { name: "Close comments" }).click();

  const textPoint = await canvasPoint(page, 0.68, 0.3);
  await page.getByTestId("tool-text").click();
  await page.mouse.click(textPoint.x, textPoint.y);
  const textEditor = page.getByTestId("canvas-text-editor");
  await textEditor.fill(
    "$$\\begin{pmatrix}\\frac{1}{2}\\\\\\frac{3}{4}\\\\\\frac{5}{6}\\\\\\frac{7}{8}\\end{pmatrix}$$",
  );
  await textEditor.press("Control+Enter");
  const freeMath = page.locator(".board-math-content");
  await expect(freeMath).toHaveAttribute("data-math-state", "ready");
  const mathSize = await freeMath.evaluate((content) => {
    const foreign = content.closest("foreignObject");
    const fontSize = Number.parseFloat((content as HTMLElement).style.fontSize);
    return {
      height: Number(foreign?.getAttribute("height")),
      initialHeight: fontSize * 2.2,
      scrollHeight: (content as HTMLElement).scrollHeight,
    };
  });
  expect(mathSize.height).toBeGreaterThan(mathSize.initialHeight);
  expect(mathSize.height).toBeGreaterThanOrEqual(mathSize.scrollHeight);

  const sectionPoint = await canvasPoint(page, 0.28, 0.68);
  await page.getByTestId("tool-zone").click();
  await page.mouse.click(sectionPoint.x, sectionPoint.y);
  const sectionTitle = page.getByTestId("zone-title-editor");
  await sectionTitle.fill("Results: $y=mx+b$");
  await sectionTitle.press("Enter");
  await expect(page.locator(".zone-math-content")).toHaveAttribute("data-math-state", "ready");

  await page.getByTestId("tool-table").click();
  const picker = page.getByTestId("table-picker");
  await picker.getByLabel("Table columns").selectOption("2");
  await picker.getByLabel("Table rows").selectOption("2");
  await picker.getByRole("button", { name: "Choose placement" }).click();
  const tablePoint = await canvasPoint(page, 0.7, 0.68);
  await page.mouse.click(tablePoint.x, tablePoint.y);
  const table = page.locator("#drawing-area .board-item-table");
  await expect(table).toHaveCount(1);
  const firstCell = table.locator('[data-table-cell][data-table-row="0"][data-table-column="0"]');
  await firstCell.dblclick();
  const cellEditor = page.getByTestId("table-cell-editor");
  await cellEditor.fill("$x^2$");
  await cellEditor.press("Control+Enter");
  await expect(table.locator(".table-math-content")).toHaveAttribute("data-math-state", "ready");

  const urlTextPoint = await canvasPoint(page, 0.52, 0.5);
  await page.getByTestId("tool-text").click();
  await page.mouse.click(urlTextPoint.x, urlTextPoint.y);
  const urlEditor = page.getByTestId("canvas-text-editor");
  await urlEditor.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await urlEditor.press("Control+Enter");
  await expect(page.locator("#drawing-area .video-embed-item")).toHaveCount(0);
  await expect(page.locator("#drawing-area .board-text-link")).toHaveCount(1);

  await page.getByTestId("tool-video").click();
  const videoDialog = page.getByRole("dialog", { name: "Embed a video" });
  await videoDialog.getByLabel("Video URL").fill("https://example.com/not-supported");
  await videoDialog.getByRole("button", { name: "Embed video" }).click();
  await expect(videoDialog.getByRole("alert")).toContainText("HTTPS YouTube or Vimeo");
  await videoDialog.getByLabel("Video URL").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await videoDialog.getByRole("button", { name: "Embed video" }).click();
  await expect(videoDialog).toBeHidden();
  const video = page.locator("#drawing-area .video-embed-item");
  await expect(video).toHaveCount(1);
  await expect(video.locator("iframe")).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );

  await page.reload();
  await expect(page.locator("#drawing-area [data-math-state='ready']")).toHaveCount(4);
  await expect(page.locator("#drawing-area .video-embed-item")).toHaveCount(1);
  await expect(page.locator("#drawing-area .board-text-link")).toHaveCount(1);

  await page.setViewportSize({ width: 840, height: 640 });
  await expect(page.locator(".comments-button-label")).toBeHidden();
  await expect(page.locator(".access-button-label")).toBeHidden();
  await expect(page.locator(".wide-label")).toBeHidden();
  const placement = await page.evaluate(() => {
    const zoom = document.querySelector(".zoom-controls")?.getBoundingClientRect();
    const rail = document.querySelector(".tool-rail")?.getBoundingClientRect();
    if (!zoom || !rail) return null;
    return { zoomTop: zoom.top, zoomBottom: zoom.bottom, railTop: rail.top };
  });
  expect(placement).not.toBeNull();
  expect(placement?.zoomTop).toBeLessThan(100);
  expect(placement?.zoomBottom).toBeLessThan(placement?.railTop ?? 0);
  await page.screenshot({ path: "/tmp/spacescale-media-math-responsive.png" });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
