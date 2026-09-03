import { expect, type Page, test } from "@playwright/test";
import { createBoard } from "./helpers";

type RelationshipExport = {
  sections: Array<{ id: string; memberItemIds: string[] }>;
  items: Array<{ id: string; kind: string; sectionId?: string }>;
};

async function exportRelationships(page: Page, boardUrl: string): Promise<RelationshipExport> {
  return page.evaluate(async (url) => {
    const boardId = new URL(url).pathname.split("/").at(-1);
    const response = await fetch(`/api/v1/boards/${boardId}/export.json`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    return (await response.json()) as RelationshipExport;
  }, boardUrl);
}

for (const id of [
  "student-questions",
  "brainstorm-school-traffic",
  "problem-set-six-students",
] as const) {
  test(`${id} gives each student a Section that holds their work`, async ({ page }) => {
    const boardUrl = await createBoard(page, id);
    await page.getByTestId("activities-button").click();
    await page.getByTestId(`activity-${id}`).click();
    await expect(page.locator(".toast")).toContainText("added", { timeout: 15000 });
    await page.waitForTimeout(1500);

    const exported = await exportRelationships(page, boardUrl);
    expect(exported.sections).toHaveLength(6);
    for (const section of exported.sections) {
      expect(section.memberItemIds.length, section.id).toBeGreaterThan(0);
    }
    const held = exported.items.filter((item) => item.sectionId !== undefined);
    expect(held.length).toBeGreaterThanOrEqual(6);
  });
}
