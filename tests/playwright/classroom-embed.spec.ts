import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Frame, type Page, test } from "@playwright/test";
import { isolatedContextOptions } from "./helpers";

const LOCAL_PARENT_URL = "http://localhost:4173/";
const LOCAL_WORKER_ORIGIN = "https://127.0.0.1:8787";
const EMBED_BEARER_HISTORY_KEY = "cf-collab-canvas.embed-bearer";

type Participant = {
  name: string;
  role: "owner" | "editor" | "viewer";
  displayName: string;
  userIdentifier: string;
};

test("classroom iframes join one board with live owner controls and attribution", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The classroom orchestration flow runs once.");
  test.skip(
    Boolean(process.env.PLAYWRIGHT_BASE_URL),
    "Remote classroom testing requires a separately configured parent origin and signing key.",
  );

  const integrationKey = readDevVar("CLASSROOM_INTEGRATION_KEY");
  const boardName = `playwright-classroom-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1_000);
  const participants = {
    coach: {
      name: "coach",
      role: "owner",
      displayName: "Coach Mira",
      userIdentifier: `coach-${randomUUID()}`,
    },
    student: {
      name: "student",
      role: "editor",
      displayName: "Student Asha",
      userIdentifier: `student-${randomUUID()}`,
    },
    coOwner: {
      name: "co-owner",
      role: "owner",
      displayName: "Coach Dev",
      userIdentifier: `coach-${randomUUID()}`,
    },
  } satisfies Record<string, Participant>;

  const cspErrors: string[] = [];
  captureCspErrors(page, cspErrors);
  const studentContext = await browser.newContext(isolatedContextOptions(testInfo, 31));
  const coOwnerContext = await browser.newContext(isolatedContextOptions(testInfo, 32));
  const studentPage = await studentContext.newPage();
  const coOwnerPage = await coOwnerContext.newPage();
  captureCspErrors(studentPage, cspErrors);
  captureCspErrors(coOwnerPage, cspErrors);

  try {
    const coach = await mountParticipant(
      page,
      LOCAL_PARENT_URL,
      participants.coach,
      launchUrl(LOCAL_WORKER_ORIGIN, integrationKey, boardName, participants.coach, now),
    );
    const student = await mountParticipant(
      studentPage,
      LOCAL_PARENT_URL,
      participants.student,
      launchUrl(LOCAL_WORKER_ORIGIN, integrationKey, boardName, participants.student, now),
    );
    const coOwner = await mountParticipant(
      coOwnerPage,
      LOCAL_PARENT_URL,
      participants.coOwner,
      launchUrl(LOCAL_WORKER_ORIGIN, integrationKey, boardName, participants.coOwner, now),
    );

    const boardPaths = [coach, student, coOwner].map((frame) => new URL(frame.url()).pathname);
    expect(new Set(boardPaths).size).toBe(1);
    expect(boardPaths[0]).toMatch(/^\/embed\/b\/b_[A-Za-z\d_-]{22}$/u);
    for (const frame of [coach, student, coOwner]) expect(new URL(frame.url()).hash).toBe("");

    const studentItemId = await drawRectangle(student);
    for (const frame of [coach, student, coOwner]) {
      await expect(frame.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    }

    await coach.getByTestId("access-button").click();
    const coachAccess = coach.getByTestId("access-drawer");
    await expect(coachAccess).toBeVisible();
    await expect(coachAccess.getByRole("combobox", { name: "Role for Coach Dev" })).toHaveValue(
      "owner",
    );

    await coachAccess
      .getByRole("combobox", { name: "Role for Student Asha" })
      .selectOption("viewer");
    await expect(student.getByTestId("save-status")).toContainText("Read only");
    await expect(student.getByRole("button", { name: /^Rectangle/u })).toBeDisabled();

    await coachAccess
      .getByRole("combobox", { name: "Role for Student Asha" })
      .selectOption("editor");
    await expect(student.getByRole("button", { name: /^Rectangle/u })).toBeEnabled();

    await coachAccess.locator("button[data-policy='owner_only']").click();
    await expect(coachAccess.locator("button[data-policy='owner_only']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(student.getByRole("button", { name: /^Rectangle/u })).toBeDisabled();
    await expect(coach.getByRole("button", { name: /^Rectangle/u })).toBeEnabled();
    await expect(coOwner.getByRole("button", { name: /^Rectangle/u })).toBeEnabled();

    await drawRectangle(coOwner);
    for (const frame of [coach, student, coOwner]) {
      await expect(frame.locator("#drawing-area [data-item-id]")).toHaveCount(2);
    }

    await coOwner.getByTestId("access-button").click();
    const coOwnerAccess = coOwner.getByTestId("access-drawer");
    await expect(coOwnerAccess).toBeVisible();
    await expect(coOwnerAccess.locator("button[data-policy='owner_only']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await coOwnerAccess.locator("button[data-policy='editors_enabled']").click();
    await expect(student.getByRole("button", { name: /^Rectangle/u })).toBeEnabled();

    const activity = await coach.evaluate(
      async ({ historyKey }) => {
        const state: unknown = history.state;
        const bearer =
          state !== null && typeof state === "object" && !Array.isArray(state)
            ? (state as Record<string, unknown>)[historyKey]
            : null;
        const boardId = location.pathname.split("/").at(-1);
        const response = await fetch(`/api/v1/boards/${boardId}/activity?afterSeq=0&limit=100`, {
          headers: typeof bearer === "string" ? { Authorization: `Bearer ${bearer}` } : {},
          cache: "no-store",
        });
        return { status: response.status, body: await response.json() };
      },
      { historyKey: EMBED_BEARER_HISTORY_KEY },
    );
    expect(activity.status).toBe(200);
    expect(activity.body).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          actor: {
            id: expect.stringMatching(/^a_[A-Za-z\d_-]{22}$/u),
            displayName: "Student Asha",
          },
          kind: "item.create",
          itemIds: [studentItemId],
          acceptedAt: expect.any(Number),
        }),
      ]),
    });
    expect(cspErrors).toEqual([]);
  } finally {
    await Promise.all([studentContext.close(), coOwnerContext.close()]);
  }
});

function readDevVar(name: string): string {
  const localVariablesFile = process.env.LOCAL_DEV_VARS_FILE ?? ".dev.vars.example";
  const contents = readFileSync(localVariablesFile, "utf8");
  const line = contents
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith(`${name}=`));
  if (line === undefined) throw new Error(`${name} is missing from ${localVariablesFile}.`);
  const raw = line.slice(line.indexOf("=") + 1).trim();
  const quoted =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
  const value = quoted ? raw.slice(1, -1) : raw;
  if (value.length === 0) throw new Error(`${name} is empty in ${localVariablesFile}.`);
  return value;
}

function launchUrl(
  workerOrigin: string,
  integrationKey: string,
  boardName: string,
  participant: Participant,
  issuedAt: number,
): string {
  const payload = {
    v: 1,
    aud: "localhost",
    board_name: boardName,
    role: participant.role,
    display_name: participant.displayName,
    user_identifier: participant.userIdentifier,
    iat: issuedAt,
    exp: issuedAt + 60 * 60,
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signed = `cl1.${payloadPart}`;
  const signature = createHmac("sha256", integrationKey).update(signed, "utf8").digest("base64url");
  return `${workerOrigin}/embed#launch=${encodeURIComponent(`${signed}.${signature}`)}`;
}

async function mountParticipant(
  page: Page,
  parentUrl: string,
  participant: Participant,
  source: string,
): Promise<Frame> {
  await page.goto(parentUrl);
  await expect(page.getByRole("heading", { name: "Classroom test host" })).toBeVisible();
  await page.evaluate(
    ({ frameName, frameSource, title }) => {
      document.documentElement.style.height = "100%";
      document.body.style.height = "100%";
      document.body.style.margin = "0";
      const iframe = document.createElement("iframe");
      iframe.name = frameName;
      iframe.title = `${title} whiteboard`;
      iframe.src = frameSource;
      iframe.referrerPolicy = "no-referrer";
      iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-downloads", "allow-modals");
      iframe.allow = "clipboard-write";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      document.body.replaceChildren(iframe);
    },
    {
      frameName: participant.name,
      frameSource: source,
      title: participant.displayName,
    },
  );

  await expect
    .poll(() => sanitizedFrameLocation(page.frame({ name: participant.name })), { timeout: 15_000 })
    .toMatch(/^\/embed\/b\/b_[A-Za-z\d_-]{22}$/u);
  const frame = page.frame({ name: participant.name });
  if (frame === null) throw new Error(`The ${participant.name} iframe did not load.`);
  await expect(frame.getByTestId("board-shell")).toBeVisible();
  await expect(frame.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
  await expect(frame.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return frame;
}

function sanitizedFrameLocation(frame: Frame | null): string {
  if (frame === null || frame.url() === "about:blank") return "";
  const url = new URL(frame.url());
  return `${url.pathname}${url.hash === "" ? "" : "#redacted"}`;
}

async function drawRectangle(frame: Frame): Promise<string> {
  const items = frame.locator("#drawing-area [data-item-id]");
  const before = await items.count();
  await frame.getByRole("button", { name: /^Rectangle/u }).click();
  await frame.locator("#board-canvas").evaluate((node) => {
    const canvas = node as SVGSVGElement;
    const capturedPointers = new Set<number>();
    Object.defineProperties(canvas, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.add(pointerId),
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.has(pointerId),
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.delete(pointerId),
      },
    });
    const bounds = canvas.getBoundingClientRect();
    const points = [
      { x: bounds.left + bounds.width * 0.3, y: bounds.top + bounds.height * 0.35 },
      { x: bounds.left + bounds.width * 0.42, y: bounds.top + bounds.height * 0.47 },
      { x: bounds.left + bounds.width * 0.5, y: bounds.top + bounds.height * 0.55 },
    ];
    points.forEach((point, index) => {
      const last = index === points.length - 1;
      canvas.dispatchEvent(
        new PointerEvent(index === 0 ? "pointerdown" : last ? "pointerup" : "pointermove", {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 701,
          pointerType: "mouse",
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons: last ? 0 : 1,
          pressure: last ? 0 : 0.5,
        }),
      );
    });
  });
  await expect(items).toHaveCount(before + 1);
  await expect(frame.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const itemId = await items.nth(before).getAttribute("data-item-id");
  if (itemId === null) throw new Error("The authoritative item ID is missing.");
  return itemId;
}

function captureCspErrors(page: Page, errors: string[]): void {
  page.on("console", (message) => {
    const text = message.text();
    if (/content security policy|refused to frame/iu.test(text)) errors.push(text);
  });
}
