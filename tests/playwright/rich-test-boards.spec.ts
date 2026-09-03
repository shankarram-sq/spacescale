import { expect, test } from "@playwright/test";
import { createBoard } from "./helpers";

const TEST_BOARDS = [
  {
    id: "product-discovery-lab",
    title: "Product discovery fixture",
    itemCount: 28,
    sectionCount: 4,
    transformed: false,
  },
  {
    id: "incident-response-room",
    title: "Incident response fixture",
    itemCount: 24,
    sectionCount: 3,
    transformed: true,
  },
  {
    id: "design-critique-studio",
    title: "Design critique fixture",
    itemCount: 30,
    sectionCount: 3,
    transformed: true,
  },
] as const;

for (const fixture of TEST_BOARDS) {
  test(`${fixture.title} inserts as a relationship-rich commentable board`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Rich board fixture QA runs in Chromium.");

    const browserProblems: string[] = [];
    page.on("pageerror", (error) => browserProblems.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserProblems.push(message.text());
    });

    const boardUrl = await createBoard(page, fixture.title);
    await page.getByTestId("activities-button").click();
    const templateButton = page.getByTestId(`activity-${fixture.id}`);
    await expect(templateButton).toBeVisible();
    await templateButton.click();

    const drawingArea = page.locator("#drawing-area");
    await expect(drawingArea.locator("[data-item-id]")).toHaveCount(fixture.itemCount);
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(drawingArea.locator(".board-item-zone")).toHaveCount(fixture.sectionCount);
    await expect(drawingArea.locator(".board-item-table")).not.toHaveCount(0);
    await expect(drawingArea.locator(".board-item-line")).not.toHaveCount(0);
    await expect(drawingArea.locator(".board-item-stamp")).not.toHaveCount(0);
    await expect(drawingArea.locator("a[data-board-link]").first()).toBeVisible();

    const commentTarget = drawingArea.locator(".board-item-sticky").filter({
      hasText: "COMMENT TARGET",
    });
    await expect(commentTarget).toHaveCount(1);
    await page.keyboard.press("Escape");
    const targetBounds = await commentTarget.boundingBox();
    if (!targetBounds) throw new Error("The rich board comment target has no rendered bounds.");
    await page.mouse.click(
      targetBounds.x + targetBounds.width / 2,
      targetBounds.y + targetBounds.height / 2,
    );
    const commentButton = page.getByRole("button", { name: "Comment on selected object" });
    await expect(commentButton).toBeEnabled();
    await commentButton.click();
    const comments = page.getByTestId("comments-drawer");
    await comments.getByRole("textbox", { name: "Comment" }).fill(`Review ${fixture.id}`);
    await comments.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(comments.locator(".comment-card")).toHaveCount(1);
    await expect(page.locator("#comment-layer .comment-marker")).toHaveCount(1);

    const boardId = new URL(boardUrl).pathname.split("/").at(-1);
    if (!boardId) throw new Error("The rich board URL omitted its board ID.");
    const exported = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/boards/${id}/export.json`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      return { status: response.status, body: await response.json() };
    }, boardId);
    expect(exported.status).toBe(200);
    const body = exported.body as {
      items: Array<{
        id: string;
        kind: string;
        groupId?: string;
        sectionId?: string;
        transform: number[];
      }>;
      sections: Array<{ id: string; memberItemIds: string[] }>;
    };
    expect(body.items).toHaveLength(fixture.itemCount);
    expect(body.sections).toHaveLength(fixture.sectionCount);
    expect(body.sections.every((section) => section.memberItemIds.length > 0)).toBe(true);
    expect(body.items.some((item) => item.groupId !== undefined)).toBe(true);
    for (const item of body.items.filter((candidate) => candidate.sectionId !== undefined)) {
      expect(body.sections.some((section) => section.id === item.sectionId)).toBe(true);
    }
    expect(body.items.some((item) => item.transform.slice(0, 4).join(",") !== "1,0,0,1")).toBe(
      fixture.transformed,
    );

    await comments.getByRole("button", { name: "Close comments" }).click();
    await page.screenshot({
      path: `/tmp/spacescale-${fixture.id}.png`,
      fullPage: false,
    });
    expect(browserProblems).toEqual([]);
  });
}
