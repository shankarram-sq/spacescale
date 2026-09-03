import { expect, test } from "@playwright/test";

test("presents an AI-enabled learning canvas with a fresh suggested name", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The homepage smoke runs in Chromium.");

  await page.addInitScript(() => {
    const load = Number(window.name || "0");
    window.name = String(load + 1);
    Math.random = () => (load === 0 ? 0 : 0.9999);
  });

  await page.goto("/");

  await expect(page).toHaveTitle("SpaceScale — AI-enabled collaborative learning");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Learn together,with AI.");
  await expect(page.getByText("WebMCP enabled", { exact: true })).toBeVisible();
  await expect(page.getByText("Cloudflare-native", { exact: true })).toHaveCount(0);
  await expect(page.locator(".landing-hero-mark .brand-mark")).toHaveCSS("width", "82px");

  const boardTitle = page.getByRole("textbox", { name: "Board title" });
  await expect(boardTitle).toHaveValue("Bright Algebra Academy 1000");

  await page.reload();
  await expect(boardTitle).toHaveValue("Wondering Vector Workshop 9999");

  await boardTitle.fill("Biology revision");
  await expect(boardTitle).toHaveValue("Biology revision");
});
