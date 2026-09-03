import { expect, test } from "@playwright/test";

import { createBoard } from "./helpers";

test("a delimiter opens the maths field, and its TeX lands back in the text", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const store = window as unknown as { __cspViolations: string[] };
    store.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      store.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  await createBoard(page, "Maths keyboard");
  await page.getByTestId("tool-text").click();
  await page.locator("#board-canvas").click({ position: { x: 400, y: 300 } });
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();

  // Typing the opening half completes the pair and brings up the field.
  await editor.type("Solve $$");
  await expect(editor).toHaveValue("Solve $$$$");
  const panel = page.getByTestId("math-field-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("math-field")).toHaveCount(1);

  // What the field is given is written back between the delimiters, not over the prose.
  await page.locator("math-field").click();
  await page.keyboard.type("x^2+1");
  await expect(editor).toHaveValue("Solve $$x^2+1$$");

  // MathLive's on-screen keyboard is the point of the field, so it has to open.
  await page.evaluate(() => {
    const field = document.querySelector("math-field") as HTMLElement & {
      executeCommand?: (command: string) => void;
    };
    field?.executeCommand?.("toggleVirtualKeyboard");
  });
  const keyboard = await page.evaluate(() => {
    const virtual = (window as unknown as { mathVirtualKeyboard?: { visible?: boolean } })
      .mathVirtualKeyboard;
    return { present: Boolean(virtual), visible: virtual?.visible === true };
  });
  expect(keyboard).toEqual({ present: true, visible: true });

  // The board's content security policy has to accommodate the library, not be broken by it.
  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);

  // A lone dollar is a dollar: a price must not open a formula.
  await page.keyboard.press("Escape");
  await editor.fill("Kits cost $12 each");
  await editor.click();
  await expect(panel).toBeHidden();
});

test("clicking away from the maths field saves the text instead of losing it", async ({ page }) => {
  await createBoard(page, "Maths keyboard focus");
  await page.getByTestId("tool-text").click();
  await page.locator("#board-canvas").click({ position: { x: 400, y: 300 } });
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();

  await editor.type("Answer $$");
  await expect(page.getByTestId("math-field-panel")).toBeVisible({ timeout: 20_000 });
  await page.locator("math-field").click();
  await page.keyboard.type("2x");
  await expect(editor).toHaveValue("Answer $$2x$$");

  // Focus is in the maths field, and the participant clicks the canvas rather than pressing Done.
  // The text editor already declined to save when focus left it, so the panel has to finish the
  // edit; otherwise the next click opens a new editor and discards this draft.
  await page.locator("#board-canvas").click({ position: { x: 1050, y: 260 } });
  // That click starts a new text object; dismissing it leaves only what was saved.
  await page.keyboard.press("Escape");
  await expect(page.locator("#board-canvas")).toContainText("Answer", { timeout: 10_000 });
});
