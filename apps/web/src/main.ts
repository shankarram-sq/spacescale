import "./styles.css";
import { ApiClient, ApiError, takeEmbedLaunch, takeFragmentClaim } from "./transport/api";
import {
  acknowledgeRecoveredOwnership,
  BoardApp,
  boardIdFromPath,
  confirmRecoveryClaim,
  renderFatal,
  renderLanding,
  requestClaimVerification,
} from "./ui/app";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Application root is missing.");

const api = new ApiClient();
let boardId = boardIdFromPath();
const embedPath = /^\/embed(?:\/|$)/u.test(window.location.pathname);
const embedLaunch = takeEmbedLaunch();
const fragmentClaim = embedPath ? null : takeFragmentClaim();

void start();

async function start(): Promise<void> {
  try {
    if (embedLaunch !== null) {
      showBootMessage("Opening your Space…");
      const launched = await api.startEmbedSession(embedLaunch);
      boardId = launched.board.id;
      history.replaceState(history.state, "", `/embed/b/${encodeURIComponent(launched.board.id)}`);
      await api.ensureSession();
    } else if (embedPath) {
      if (api.embedSessionToken === null) {
        throw new ApiError(
          "AUTH_REQUIRED",
          "Open this Space again from its parent application.",
          401,
        );
      }
      await api.ensureSession();
    } else {
      await api.ensureSession();
    }
    if (!boardId) {
      renderLanding(root as HTMLElement, api);
      return;
    }

    if (fragmentClaim) {
      const confirmed = await confirmRecoveryClaim(root as HTMLElement, fragmentClaim);
      if (fragmentClaim.type === "recovery" && !confirmed) {
        renderFatal(
          root as HTMLElement,
          "Recovery cancelled",
          "No ownership changes were made. You can safely close this tab.",
          false,
        );
        return;
      }
      const turnstileToken = await requestClaimVerification(
        root as HTMLElement,
        api.turnstile,
        fragmentClaim.type,
      );
      showBootMessage(
        fragmentClaim.type === "invite" ? "Joining your board…" : "Recovering ownership…",
      );
      const claimResult = await api.claim(
        boardId,
        fragmentClaim,
        fragmentClaim.type === "recovery",
        turnstileToken,
      );
      if (fragmentClaim.type === "recovery") {
        await acknowledgeRecoveredOwnership(root as HTMLElement, boardId, claimResult);
      }
    }

    showBootMessage("Loading the latest canvas…");
    const bootstrap = await api.bootstrap(boardId);
    await BoardApp.mount(root as HTMLElement, api, bootstrap);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 410) {
        renderFatal(
          root as HTMLElement,
          "Board archived",
          "This board has been permanently archived and can no longer be opened.",
          false,
        );
        return;
      }
      const title =
        error.code === "FORBIDDEN" || error.code === "AUTH_REQUIRED"
          ? "This board is private"
          : "Board unavailable";
      renderFatal(root as HTMLElement, title, error.message);
      return;
    }
    renderFatal(
      root as HTMLElement,
      "Couldn’t open the board",
      "Check your connection and try again.",
    );
  }
}

function showBootMessage(message: string): void {
  const current = (root as HTMLElement).querySelector<HTMLElement>(".boot-screen span:last-child");
  if (current) {
    current.textContent = message;
    return;
  }
  (root as HTMLElement).innerHTML =
    '<div class="boot-screen" role="status" aria-live="polite"><span class="brand-mark" aria-hidden="true">C</span><span></span></div>';
  const text = (root as HTMLElement).querySelector<HTMLElement>(".boot-screen span:last-child");
  if (text) text.textContent = message;
}
