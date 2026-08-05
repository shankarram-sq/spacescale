import {
  type BrowserContextOptions,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";

function isolatedContextOptions(testInfo: TestInfo): BrowserContextOptions {
  return {
    ignoreHTTPSErrors: true,
    ...(testInfo.project.use.extraHTTPHeaders === undefined
      ? {}
      : { extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders }),
  };
}

async function createBoard(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();
  await page.getByRole("textbox", { name: "Board title" }).fill(title);
  await page.getByRole("button", { name: /Open a fresh canvas/u }).click();

  const ready = page.getByRole("dialog");
  await expect(ready.getByRole("heading", { name: "Your canvas is ready" })).toBeVisible();
  await ready.getByRole("link", { name: "Continue to board" }).click();
  await expect(page).toHaveURL(/\/b\/b_[A-Za-z\d_-]{22}$/u);
  await expect(page.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
}

async function createEditorInvite(page: Page): Promise<string> {
  await page.getByTestId("access-button").click();
  const drawer = page.getByTestId("access-drawer");
  await expect(drawer).toBeVisible();
  const form = drawer.locator("[data-invite-form]");
  await form.locator("select[name='role']").selectOption("editor");
  await form.locator("select[name='maxUses']").selectOption("20");
  await form.getByRole("button", { name: "Create invite link" }).click();
  const result = drawer.locator("[data-invite-result] span");
  await expect(result).toContainText("#invite=");
  const inviteUrl = (await result.textContent())?.trim();
  expect(inviteUrl).toMatch(/#invite=./u);
  return inviteUrl as string;
}

async function drawMouseGesture(page: Page, toolName: string, offset = 0): Promise<void> {
  const canvas = page.locator("#board-canvas");
  const before = await canvas.locator("#drawing-area [data-item-id]").count();
  await page.getByRole("button", { name: new RegExp(`^${toolName}`, "u") }).click();
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("Canvas has no layout bounds.");
  const start = {
    x: bounds.x + bounds.width * 0.35 + offset,
    y: bounds.y + bounds.height * 0.4,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 90, start.y + 55, { steps: 8 });
  await page.mouse.up();
  await expect(canvas.locator("#drawing-area [data-item-id]")).toHaveCount(before + 1);
  await expect(page.getByTestId("save-status")).toContainText("Saved");
}

async function installWebSocketControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWebSocket = globalThis.WebSocket;
    const sockets = new Set<WebSocket>();
    let socketOffline = false;
    const forceDisconnect = (socket: WebSocket): void => {
      socket.dispatchEvent(
        new CloseEvent("close", { code: 4000, reason: "test network interruption" }),
      );
      socket.close(4000, "test network interruption");
    };
    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols: string | string[] = []) {
        super(url, protocols);
        sockets.add(this);
        this.addEventListener("close", () => sockets.delete(this), { once: true });
        if (socketOffline) queueMicrotask(() => forceDisconnect(this));
      }
    }
    Object.defineProperties(globalThis, {
      WebSocket: { configurable: true, value: TrackedWebSocket },
      __setTestSocketOffline: {
        configurable: true,
        value: (offline: boolean) => {
          socketOffline = offline;
          if (offline) {
            for (const socket of sockets) forceDisconnect(socket);
          }
        },
      },
    });
  });
}

type TouchEventInit = {
  type: "pointerdown" | "pointermove" | "pointerup";
  pointerId: number;
  x: number;
  y: number;
  primary?: boolean;
};

async function dispatchTouchEvents(page: Page, events: TouchEventInit[]): Promise<void> {
  await page.locator("#board-canvas").evaluate((node, touchEvents) => {
    const canvas = node as SVGSVGElement;
    const capturedPointers = new Set<number>();

    // Synthetic pointer events are not registered as active hardware pointers by
    // browser engines, so provide the matching capture lifecycle for the gesture
    // controller while retaining real PointerEvent dispatch and coordinates.
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

    for (const event of touchEvents) {
      canvas.dispatchEvent(
        new PointerEvent(event.type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: event.pointerId,
          pointerType: "touch",
          isPrimary: event.primary ?? false,
          clientX: event.x,
          clientY: event.y,
          button: 0,
          buttons: event.type === "pointerup" ? 0 : 1,
          pressure: event.type === "pointerup" ? 0 : 0.5,
        }),
      );
    }
  }, events);
}

test("an offline client replays a collaborator's commit exactly once and converges", async ({
  browser,
  page,
}, testInfo) => {
  await installWebSocketControl(page);
  await createBoard(page, "Reconnect room");
  await drawMouseGesture(page, "Rectangle");
  const inviteUrl = await createEditorInvite(page);

  const replayedItemIds: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const frame = JSON.parse(payload) as {
          t?: string;
          actions?: Array<{ op?: { kind?: string; item?: { id?: string } } }>;
        };
        if (frame.t !== "server.replay") return;
        for (const action of frame.actions ?? []) {
          if (action.op?.kind === "item.create" && typeof action.op.item?.id === "string") {
            replayedItemIds.push(action.op.item.id);
          }
        }
      } catch {
        // Non-JSON frames are protocol failures handled by the application.
      }
    });
  });

  const collaboratorContext = await browser.newContext(isolatedContextOptions(testInfo));
  const collaborator = await collaboratorContext.newPage();
  try {
    await collaborator.goto(inviteUrl);
    await expect(collaborator.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    await expect(collaborator.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    const baselineIds = await collaborator
      .locator("#drawing-area [data-item-id]")
      .evaluateAll((nodes) => nodes.map((node) => (node as SVGGraphicsElement).dataset.itemId));

    const offlineReconnectAttempt = page.waitForEvent("websocket");
    await page.evaluate(() => {
      (
        globalThis as typeof globalThis & { __setTestSocketOffline: (offline: boolean) => void }
      ).__setTestSocketOffline(true);
    });
    await expect(page.getByTestId("save-status")).toContainText("Reconnecting");
    await offlineReconnectAttempt;

    await drawMouseGesture(collaborator, "Ellipse", 45);
    const collaboratorIds = await collaborator
      .locator("#drawing-area [data-item-id]")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as SVGGraphicsElement).dataset.itemId).sort(),
      );
    expect(collaboratorIds).toHaveLength(2);
    const replayedId = collaboratorIds.find((id) => !baselineIds.includes(id));
    expect(replayedId).toBeTruthy();

    await page.evaluate(() => {
      (
        globalThis as typeof globalThis & { __setTestSocketOffline: (offline: boolean) => void }
      ).__setTestSocketOffline(false);
    });
    await expect(page.getByTestId("save-status")).toContainText("Saved");
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(2);
    await expect
      .poll(async () =>
        page
          .locator("#drawing-area [data-item-id]")
          .evaluateAll((nodes) =>
            nodes.map((node) => (node as SVGGraphicsElement).dataset.itemId).sort(),
          ),
      )
      .toEqual(collaboratorIds);
    await expect.poll(() => replayedItemIds.filter((id) => id === replayedId).length).toBe(1);
    expect(new Set(replayedItemIds).size).toBe(replayedItemIds.length);
  } finally {
    await collaboratorContext.close();
  }
});

test("two-finger touch navigation cancels drawing while a single touch commits", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "This scenario requires a touch-capable project.");

  await createBoard(page, "Touch room");
  await page.getByRole("button", { name: /^Pencil/u }).click();
  const canvas = page.locator("#board-canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("Canvas has no layout bounds.");
  const initialViewBox = await canvas.getAttribute("viewBox");
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };

  await dispatchTouchEvents(page, [
    { type: "pointerdown", pointerId: 11, x: center.x - 40, y: center.y, primary: true },
    { type: "pointerdown", pointerId: 12, x: center.x + 40, y: center.y },
    { type: "pointermove", pointerId: 11, x: center.x - 70, y: center.y + 15, primary: true },
    { type: "pointermove", pointerId: 12, x: center.x + 70, y: center.y + 15 },
    { type: "pointerup", pointerId: 11, x: center.x - 70, y: center.y + 15, primary: true },
    { type: "pointerup", pointerId: 12, x: center.x + 70, y: center.y + 15 },
  ]);

  await expect.poll(() => canvas.getAttribute("viewBox")).not.toBe(initialViewBox);
  await expect(canvas.locator("#drawing-area [data-item-id]")).toHaveCount(0);
  await expect(canvas.locator("#local-preview-layer .local-preview")).toHaveCount(0);

  await dispatchTouchEvents(page, [
    { type: "pointerdown", pointerId: 21, x: center.x - 55, y: center.y - 45, primary: true },
    { type: "pointermove", pointerId: 21, x: center.x - 20, y: center.y - 15, primary: true },
    { type: "pointermove", pointerId: 21, x: center.x + 25, y: center.y + 25, primary: true },
    { type: "pointerup", pointerId: 21, x: center.x + 25, y: center.y + 25, primary: true },
  ]);

  await expect(canvas.locator("#drawing-area [data-item-id]")).toHaveCount(1);
  await expect(page.getByTestId("save-status")).toContainText("Saved");
});
