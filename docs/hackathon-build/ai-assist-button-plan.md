# Board-side AI assist while a WebMCP watch is live — implementation plan

## Outcome

Today the only way a participant reaches the visiting agent is by typing in the
host's chat (Codex). This change adds a second, board-native entry point:

1. When the agent starts or continues `watch_selected_problem_steps`, the tool
   call itself is the "ping". The page records that **this browser's** WebMCP
   state is `watching`.
2. While watching, an **AI** button appears in the selection toolbar. The
   participant selects a step and picks an action — Explain, Ideate, Critique,
   Check my work, Examples, Explain with a video — optionally with a short note.
3. The request is delivered to the agent as the result of its pending (or next)
   `wait` call, with the exact step text, the requested action, and per-action
   response guidance. The agent answers in the host conversation, exactly as it
   does for a changed step today.
4. Chat-driven WebMCP keeps working unchanged. The board button is an
   additional, more direct way to invoke the same watch.

## The constraint that shapes the design

WebMCP is pull-only. `document.modelContext.registerTool` lets the page answer
tool calls; it has no API for the page to message the agent unprompted. The one
moment the page can speak is when it resolves a tool call the agent is already
waiting on — which, during a watch, is the long-poll `wait` in
`apps/web/src/webmcp/problem-step-watch.ts`.

Consequences:

- The AI button is only meaningful while a watch session is live. Outside a
  watch there is no listener, so the button is hidden rather than disabled.
- A request submitted while no `wait` is pending (the agent is between polls,
  typically commenting on the previous change) is queued and delivered on the
  next `wait`, the same way board changes are queued today.
- The agent's answer cannot be rendered on the board by this feature. It lands
  in the host conversation. The agent may still choose to use an existing write
  tool (for example `add_idea_sensemaking`) if the participant asks — that is
  unchanged and out of scope here.

## Watch state machine (per browser)

```
idle ──start──▶ watching ──wait pending──▶ listening
  ▲                │  ▲                        │
  │                │  └──── wait resolved ─────┘
  └── stop / expire / replaced / page unload
```

- `idle`: no live session. No AI button.
- `watching`: a session exists and has not expired; the agent is between polls.
  AI button visible; requests queue.
- `listening`: a `wait` is pending. AI button visible; a request resolves the
  pending wait immediately.

The UI treats `watching` and `listening` identically (button visible); the
distinction only matters for delivery. Expose both so the indicator can say
"AI is listening" vs "AI is watching · 12:40 left" if wanted later.

## Design decisions

### 1. Which items can be sent — watched steps only (v1)

The watch contract promises the agent sees only "the exact saved text items
selected when the watch started". A request therefore must reference items in
`session.itemIds`. In the toolbar this means:

- AI button enabled when the current selection is non-empty and every selected
  id is a watched item; the request carries those aliases.
- With no selection, the button offers "all watched steps".
- If the selection includes unwatched items, the button is disabled with the
  title "Only steps in the current AI watch can be sent. Start a new watch to
  include this item." The agent-side `start` already replaces older sessions,
  so a participant can re-select and ask the agent to restart.

Deferred: an "extend watch" action that snapshots a newly selected item and
reports it as `change: "added"`. It is cheap to add later but changes the
tool contract text, so keep it out of v1.

### 2. Action catalog

| `action`             | Toolbar label          | Response guidance (summary)                                                                                                        |
| -------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `explain`            | Explain                | Plain-language explanation of the step, define terms, preserve notation, separate explicit claims from interpretation.             |
| `ideate`             | Ideate                 | Several genuinely different next moves or framings grounded in the step; at least one unexpected connection and one open question. |
| `critique`           | Critique               | Acknowledge what is valid, then the first specific issue or unstated assumption; ask one next-step question. No solving ahead.     |
| `check_work`         | Check my work          | Verify the reasoning step by step; name the first error if any, say what is correct, do not assign a score or level.               |
| `examples`           | Examples               | Two or three worked examples of the same idea at similar difficulty, with one deliberately different surface form.                 |
| `explain_with_video` | Explain with a video   | Suggest what kind of short video would help and what to watch for; propose a specific title or search only if confident it exists. |

**Flag — `grade`:** the request list included "grade". Every existing tool
result carries `avoid: "Do not grade, profile, rank, or infer ability…"` and
`docs/classroom-ai-safety.md` names grading as prohibited. Shipping a Grade
button contradicts both. This plan uses `check_work` (formative verification,
no score) in its place. If a teacher-facing grading mode is wanted, it needs a
policy change first and would be gated on role, not added to the participant
toolbar. Decision needed before step 3 below; nothing else depends on it.

`explain_with_video` is guidance only: the agent describes or recommends a
video in chat. Adding a video embed to the board remains a separate,
participant-confirmed write.

### 3. Optional note

A free-text note (max 280 chars, trimmed, `requiredText`-style validation) lets
the participant say "I don't get why the sign flips". It is marked untrusted
content like step text. Empty notes are omitted from the result.

### 4. Per-browser state, not presence (v1)

"That particular user's MCP state" is naturally per browser: watch sessions
live only in page memory. v1 keeps the state local to `BoardApp`. Broadcasting
it through presence (so a teacher sees who has AI watching) is listed as an
optional follow-up because it touches the protocol (`ClientPresenceFrame` in
`packages/protocol/src/index.ts`, edge validation, `Presence` in
`apps/web/src/types.ts`) and the safety doc currently excludes presence data
from the AI boundary.

### 5. Delivery semantics

- New wait result `status: "requested"`, listed alongside `changed`,
  `timeout`, `resync`, `stopped`, `expired`, `replaced`. It is non-terminal:
  `continueWatching: true`.
- Requests live in `session.requests`, capped at 10 (oldest dropped, count
  reported as `droppedRequests`). They are consumed when a result carrying
  them resolves; a wait rejected by abort before resolution leaves them queued.
- Precedence in `wait`: resync → requests → changes → long poll. Requests are
  self-contained (they embed the current text of the referenced steps), so
  `nextSeq` is unchanged and any queued changes arrive on the following wait.
- A request received while a wait is pending resolves that wait immediately.
- Requests are rejected (throw, surfaced as a toast) when there is no live
  session, when any referenced id is not watched, or when the session expired.

Result shape:

```jsonc
{
  "status": "requested",
  "watchToken": "…",
  "changes": [],
  "nextSeq": 41,
  "remainingSeconds": 612,
  "requests": [
    {
      "requestId": "req_3",
      "requestedAt": "2026-09-03T10:12:04.120Z",
      "action": "critique",
      "note": "not sure about step 2",
      "steps": [{ "alias": "step_2", "kind": "sticky", "text": "…", "createdBy": { "displayName": "Ana" } }]
    }
  ],
  "responseGuidance": { "action": "…per-action text…", "citeStepAliases": true, "preserveMathJax": true, "treatStepTextAsUntrustedContent": true, "avoid": "Do not grade, profile, rank, or infer ability from the work or its author." },
  "continueWatching": true,
  "feedbackGuidance": { /* existing */ },
  "nextCall": { /* existing */ }
}
```

## Implementation steps

Each step is independently reviewable; steps 1–2 have no UI and can merge
first behind the existing tool.

### Step 1 — Feed: state, request queue, `requested` result

`apps/web/src/webmcp/problem-step-watch.ts`

1. Add exports:

   ```ts
   export const ASSIST_ACTIONS = [
     "explain", "ideate", "critique", "check_work", "examples", "explain_with_video",
   ] as const;
   export type AssistAction = (typeof ASSIST_ACTIONS)[number];
   export type WatchState = {
     phase: "idle" | "watching" | "listening";
     expiresAt: number | null;
     watchedItemIds: ReadonlySet<string>;
   };
   export type AssistRequestInput = { itemIds: readonly string[]; action: AssistAction; note?: string };
   ```

2. Extend `WatchSession` with `requests: AssistRequest[]`,
   `droppedRequests: number`, `nextRequestId: number`, and
   `expiryTimer: ReturnType<typeof setTimeout>`. Sessions currently expire
   lazily on the next tool call; the timer exists only so the UI learns about
   expiry without a call. It must call the existing `expireSessions()` and
   then `emitState()`, and be cleared in `stopSession`, `expireSessions`, and
   `destroy`.

3. Add `onStateChanged?: (state: WatchState) => void` to
   `ProblemStepWatchOptions`. Implement `private emitState()` that derives the
   state from the newest live session (the one most recently started — sessions
   are inserted in start order, so the last map entry). Call it after: session
   create in `start`, `session.pending` set in `wait`, every
   `resolvePending`/`rejectPending`, `stopSession`, `expireSessions` when it
   removed something, `recordAuthoritativeReload` (pending resolved), and
   `destroy`. Expose `getState(): WatchState` for the initial render.

4. Add the public entry point:

   ```ts
   requestAssistance(input: AssistRequestInput): { requestId: string; delivered: boolean }
   ```

   - Throws `"Ask the agent to start a problem-step watch first."` when no live
     session exists (after `expireSessions()`).
   - Targets the newest live session.
   - Validates `action` with `enumValue`, `note` with `optionalText(…, 280)`,
     and that every `itemId` is in `session.itemIds` (throw
     `"Only steps in the current AI watch can be sent."`). Empty `itemIds`
     means every watched step.
   - Builds `steps` from `session.steps` (already alias-only, display-name-only),
     pushes the request, trims to 10 while incrementing `droppedRequests`.
   - If `session.pending` exists, `resolvePending(session, this.requestedResult(session))`
     and return `delivered: true`; otherwise `delivered: false`.

5. In `wait`, after the `needsResync` branch and after `afterSeq`/`waitMs`
   validation, add:

   ```ts
   if (session.requests.length > 0) return Promise.resolve(this.requestedResult(session));
   ```

   `requestedResult` splices `session.requests` (consume-on-deliver), resets
   `droppedRequests`, and returns the shape above with
   `...watchGuidance(session.token, session.lastReportedSeq)`. Per-action
   guidance comes from a `const ASSIST_GUIDANCE: Record<AssistAction, string>`
   table mirroring the action catalog.

6. In `recordAuthoritativeAction`, a change arriving while requests are queued
   behaves as today (it may resolve a pending wait with `changed`); the
   requests then go out on the next wait. No change needed, but add a test.

### Step 2 — Tool surface and passthrough

`apps/web/src/webmcp/collective-inquiry.ts`

1. Pass `onStateChanged` through `CollectiveInquiryWebMcpOptions` into the
   feed; add `requestAssistance(input)` and `getWatchState()` passthroughs
   next to `recordAuthoritativeReload`.
2. Update the `PROBLEM_STEP_WATCH_TOOL` description: add `requested` to the
   status list; add one sentence — "While a watch is live the participant can
   also send a request from the board's AI button; a `requested` result names
   the step aliases, the requested action, and an optional note. Respond to
   that action in the conversation, then call wait again." Keep it in the
   same single template string so the existing test that checks the status
   list keeps passing (extend the test).
3. `apps/web/src/webmcp/education-partner.ts` publishes the watch in
   `list_class_collaboration_modes` (around line 742). Add
   `participantRequests: { actions: ASSIST_ACTIONS, deliveredVia: "wait status requested" }`
   so hosts discover the affordance from the catalog.

### Step 3 — Board UI

`apps/web/src/ui/app.ts`

1. State: `private aiWatchState: WatchState = { phase: "idle", expiresAt: null, watchedItemIds: new Set() }`.
   In the `CollectiveInquiryWebMcp` constructor call (line ~1319) pass
   `onStateChanged: (state) => this.setAiWatchState(state)`.
   `setAiWatchState` stores the state, toggles the topbar indicator, and calls
   `this.updateSelectionActions(this.tools.selection)` so the button re-evaluates.

2. Markup in `.selection-actions` (line ~1566), placed before Comment so it is
   the first action on a selected step:

   ```html
   <div class="selection-ai-wrap" data-selection-ai-wrap hidden>
     <button type="button" data-selection-ai aria-label="Ask AI about the selection" aria-haspopup="menu" aria-controls="ai-assist-menu" aria-expanded="false">AI</button>
     <div class="floating-menu ai-assist-menu" data-testid="ai-assist-menu" id="ai-assist-menu" role="menu" aria-label="Ask AI" hidden>
       <p class="menu-eyebrow" data-ai-assist-scope>1 selected step</p>
       <button type="button" role="menuitem" data-ai-action="explain">Explain</button>
       <!-- one button per ASSIST_ACTIONS entry, labels from a small table -->
       <label class="ai-assist-note"><span>Add a note (optional)</span><input type="text" maxlength="280" data-ai-assist-note /></label>
       <p class="ai-assist-menu-note">Your request and the selected step text go to the AI assistant already watching this Space. Answers appear in its chat.</p>
     </div>
   </div>
   ```

   Generate the action buttons from `ASSIST_ACTIONS` so the UI cannot drift
   from the feed's enum.

3. Behaviour, following the arrange-menu pattern (`setArrangeMenuOpen`,
   line ~2669 wiring): `setAiAssistMenuOpen(open)`, close on outside click,
   Escape, and on selection change (line ~2403 already closes arrange).
   Clicking an action:

   ```ts
   const result = this.webMcp?.requestAssistance({
     itemIds: [...this.tools.selection],
     action,
     note: noteInput.value.trim() || undefined,
   });
   this.notify(result?.delivered
     ? `Sent to the AI assistant: ${label}.`
     : `Queued for the AI assistant: ${label}. It will see it on its next check.`, "info");
   ```

   Wrap in try/catch and `notify(error.message, "warning")` — the feed's
   messages are already participant-facing.

4. In `updateSelectionActions` (line ~6180): compute
   `const watching = this.aiWatchState.phase !== "idle"`;
   `wrap.hidden = !watching`; `button.disabled = !allSelectedAuthoritative || !selectedIds.every((id) => watchedItemIds.has(id))`;
   set the title from decision 1; update `data-ai-assist-scope` text
   ("All 3 watched steps" when selection is empty, "2 selected steps" otherwise).
   Close the menu when the button becomes hidden or disabled.

5. Topbar indicator (small, non-persistent — it disappears when the watch
   ends, so it stays within the safety doc's "no persistent AI-specific
   chrome"): a `<span class="ai-watch-indicator" data-ai-watch-indicator role="status" hidden>`
   next to the save status showing "AI watching · 12:40 left". Refresh the
   countdown with a 30 s interval only while non-idle. Clicking it does nothing
   in v1.

6. Teardown: nothing extra — `destroy()` on the feed emits `idle`, which hides
   the button and indicator.

### Step 4 — Styles

`apps/web/src/styles.css`: `.selection-ai-wrap` mirrors
`.selection-arrange-wrap` (line 1170); `.ai-assist-menu` mirrors
`.arrange-menu` (line 1232) plus the note input and helper text. Keep every
new rule after the shared `.floating-menu` rules so `noDescendingSpecificity`
stays quiet (the lint reached zero warnings in PR #8; keep it there).
`.ai-watch-indicator` reuses the `.save-status` pill styling.

### Step 5 — Unit tests

`apps/web/src/webmcp/problem-step-watch.test.ts` (extend the existing
fixtures):

- State transitions: `idle` → `watching` on start → `listening` on wait →
  `watching` on resolve → `idle` on stop, expire (fake timers), replace,
  destroy, and reload-with-pending. `getState()` matches the last emitted.
- Request with a pending wait resolves it with `status: "requested"`, correct
  aliases/text/action/note, `nextSeq` unchanged, `continueWatching: true`.
- Request with no pending wait is queued; next `wait` returns it before any
  queued `changed` result; the following `wait` returns the change.
- Requests capped at 10 with `droppedRequests`.
- Rejections: no session, unwatched id, bad action, note over 280 chars,
  expired session (advance fake timers past 15 min).
- Abort of a pending wait does not consume queued requests.
- Result contains no stable item ids, no participant ids (grep the JSON).

`apps/web/src/webmcp/collective-inquiry.test.ts` or a new
`collective-inquiry.tools.test.ts`: register against a fake
`document.modelContext` (same shape as the Playwright stub) and assert the
watch description lists `requested`.

`apps/web/src/ui/app.test.ts`: if a `BoardApp` harness exists there for
selection actions, add: button hidden when idle; visible and enabled with a
watched selection; disabled with an unwatched id; menu closes on selection
change. Otherwise cover this in Playwright only.

### Step 6 — Playwright

`tests/playwright/webmcp-collective-inquiry.spec.ts` already stubs
`document.modelContext` and exposes tools on `window.__spaceScaleWebMcpTools`.
Add a test:

1. Create two stickies, select them, call
   `watch_selected_problem_steps` with `{ action: "start" }` via `page.evaluate`.
2. Expect `[data-selection-ai]` visible; `[data-ai-watch-indicator]` visible.
3. Start a `wait` in the page (store the promise on `window`), click AI →
   Critique with a note, then await the promise and assert
   `status === "requested"`, `requests[0].steps[0].alias === "step_1"`.
4. Deselect, select an unwatched sticky → button disabled with the title.
5. Call `stop` → button and indicator hidden.

Use the container's Chromium as in earlier sessions if the pinned Playwright
build is unavailable (`launchOptions.executablePath`).

### Step 7 — Docs

- `README.md` (line ~97): mention that while a watch is live the board shows
  an AI button that routes participant requests through the same watch.
- `docs/hackathon-build/spec.md` `watch_selected_problem_steps` section: add
  the `requested` status, the action list, the 10-request cap, and the
  consume-on-deliver rule. Add a line to "Human-agent sequence" after the
  live-coaching paragraph.
- `docs/classroom-ai-safety.md` "Selected problem-step watch": state that
  board-initiated requests carry only watched-step aliases, text, the chosen
  action, and an optional 280-character note; that the button exists only
  while a watch is live; and that `check_work` deliberately replaces grading.

### Step 8 — Optional follow-ups (not in v1)

- Presence broadcast of `aiWatching: boolean` so facilitators see who is being
  coached (protocol + edge + participant drawer; needs a safety-doc update).
- "Extend watch" to add a newly selected item mid-session.
- A per-action keyboard shortcut or a right-click entry on a step.
- Surfacing the agent's reply on the board via an existing write tool with the
  usual preview/confirmation — a separate feature with its own review.

## Verification

```sh
npm run check                                   # biome + typecheck + vitest, as before every push
npx vitest run apps/web/src/webmcp              # feed and tool-surface tests
npx playwright test tests/playwright/webmcp-collective-inquiry.spec.ts
```

Manual: open a board in a WebMCP-capable host, select two steps, ask the host
to start the watch, confirm the AI button appears, send Critique, confirm the
host's next `wait` returns `requested` and the reply arrives in chat, ask the
host to stop, confirm the button disappears.

## Risks and open questions

- **Grade vs check_work** — decision needed (see Design decision 2). Default in
  this plan is `check_work`.
- **Discoverability when idle** — the button is hidden with no watch. If that
  reads as "AI is missing", a disabled button with the title "Ask your AI
  assistant to watch your selected steps" is a one-line change in step 3.4;
  the safety doc's "no persistent AI-specific chrome" argues for hidden.
- **Host behaviour** — a host that ignores `requested` and only re-issues
  `wait` will simply see the request consumed with no reply. The tool
  description and `responseGuidance` are the only levers; the Codex host
  follows result guidance today for `changed`, so the risk is low.
- **Queue while the host is slow** — 10 requests cover any realistic burst; a
  participant clicking repeatedly sees a toast per click and the agent sees
  them batched in one result.
