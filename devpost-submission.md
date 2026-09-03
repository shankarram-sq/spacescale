# Title

SpaceScale

## One-line Summary

An AI-enabled visual classroom where WebMCP agents understand handwriting,
challenge mistaken diagrams, and add actionable feedback to a shared live
canvas.

## Problem

Classroom AI usually lives in a text chat, disconnected from the work students
are doing together. When a student draws the wrong parabola, the agent misses
the spatial evidence, the teacher loses the shared learning moment, and any
useful feedback has to be copied back to the board by hand.

## Solution

SpaceScale is a realtime visual classroom built on Cloudflare. Students and
teachers draw, write, organize, comment, vote, and embed YouTube or Vimeo videos
on one durable canvas. When the board is opened in a compatible host, the page
registers fifteen semantic WebMCP tools that let AI reason over the actual
visual workspace instead of reducing it to a chat transcript.

The participant chooses what the agent can inspect by selecting saved canvas
objects. The agent can read selected ideas, inspect selected handwriting and
sketches through a canonical visual, follow selected saved problem steps, or
read an aggregate vote. It can catch a mistake in a hand-drawn graph, add an
AI-authored correction with a concrete point to check, and return source-linked
inquiry maps, learning scaffolds, visuals, action plans, and dissent-preserving
decisions as ordinary shared canvas objects.

These AI actions remain trustworthy collaboration: every write uses the
authorizing participant's current actor ID and role, enters the same durable
commit path as their own edits, and is revalidated by the Worker before it is
saved.

## Why This Matters

A class gets one inspectable human-agent conversation instead of many invisible
ones. AI suggestions remain connected to the student ideas that motivated them.
Everyone can question the result, change it, vote on it, or undo it. Teachers
retain control without having to copy material between a whiteboard and a chat.

The permission model also makes delegated browser tools safer and easier to
reason about. A viewer's agent remains a viewer. An editor's agent can create
new work but cannot rewrite another participant's work. An owner's agent has
only the owner's normal access. The model cannot choose a role or actor ID in a
tool call.

## How We Used AI

SpaceScale deliberately contains no embedded model API key and sends no board
prompt to a separate SpaceScale AI backend. The visiting WebMCP agent performs
the reasoning. The page contributes the hard product context that only the live
application has: the participant's selection, canonical saved objects, a
selected-only visual, authoritative change cursors, current permissions, and
aggregate vote state.

AI is used to connect and challenge ideas, explain selected writing, propose
fresh perspectives, interpret explicitly selected handwriting, structure
inquiries and decisions, create source-linked classroom visuals, and give
bounded feedback as selected problem steps are saved. Strict schemas keep class
weights, votes, final choices, grades, and student profiles out of model control.

## How We Used Codex

Codex was the primary engineering partner for the WebMCP Challenge work. It
helped translate the classroom collaboration idea into semantic tool contracts,
implement the WebMCP adapters and deterministic canvas compilers, reason through
visual feedback and participant-scoped authorization, write unit/edge/browser
coverage, debug realtime acknowledgement behavior, and prepare the public demo,
recording script, and submission documentation.

The project also uses Codex as the reference demo agent: it discovers the tools
from the live page, reasons over only the participant-approved context, and
returns results through permission-bound site actions.

## Key Features

- Fifteen discoverable WebMCP tools covering selection reads, inspiration,
  explanation, isolated visual inspection, saved-step watching, 27 classroom
  collaboration modes, content visuals, inquiry maps, aggregate votes, and
  class decisions.
- Selected-only handwriting and sketch inspection using the board's canonical
  SVG renderer, masking of unselected work, temporary aliases, and explicit
  uncertainty guidance.
- AI-authored, source-linked feedback that can turn a visual misconception into
  a concrete next action, such as plotting `(-4, -2)` to correct a quadratic.
- Shared public YouTube and Vimeo cards that persist, synchronize, select, move,
  copy, and delete like other canvas objects.
- Same-author permission inheritance: no service account, no elevated agent
  role, local preflight plus authoritative Worker enforcement, and success only
  after server acknowledgement.
- Source-linked AI contributions that are attributed to the authorizing
  participant, broadcast in real time, committed atomically, and undoable.
- A bounded 15-minute watcher for authoritative saves to explicitly selected
  problem steps—never raw keystrokes or a whole Section.
- Visual preview gates for collective inquiry maps and class decisions, with
  dissent preserved and no inferred consensus.
- MathJax across learning text surfaces, object comments, templates, grouping,
  sections, stamps, image cards, snapshots, safe exports, and offline recovery.

## Architecture

The TypeScript browser application registers tools with
`document.modelContext.registerTool` when the API is present and remains a full
collaborative canvas when it is absent. Read receipts and watch sessions are
bounded and live only in page memory. Write tools accept semantic intent—not raw
coordinates, arbitrary HTML, or actor identity—and compile it to protocol-valid
board operations.

All writes flow through the participant's durable outbox and WebSocket session.
One `BoardRoom` Durable Object per board validates role, item ownership, section
locks, versions, topology, and batch limits before a shared reducer sequences
and persists the action to SQLite. The resulting authoritative action resolves
the WebMCP promise and is broadcast to collaborators. Private raster assets,
recovery checkpoints, and named snapshots use R2.

## What We Built During the Challenge

SpaceScale is an **existing project** based on the open-source Cloudflare Collab
Canvas foundation. During the WebMCP Challenge submission period, the project
was meaningfully extended from a secure collaborative whiteboard into an
AI-enabled learning product. The challenge work added:

- the fifteen-tool WebMCP integration and 27 enforced education modes;
- selected-only semantic, visual, explanatory, inspiration, vote, and
  saved-change read surfaces;
- the participant-scoped WebMCP commit/acknowledgement path and attribution;
- inquiry-map, decision, learning-scaffold, and source-linked visual compilers;
- handwriting masking and visual-review safety boundaries;
- shared video cards and MathJax learning content;
- classroom roles, object comments, richer grouping/section workflows, a new
  education-focused homepage, and extensive contract/unit/edge/Chromium tests;
- the implementation spec, safety gate, judge instructions, screenshot pack,
  and three-minute recording runbook.

The public repository history and the comparison with the upstream foundation
show the complete functional delta.

## Testing Instructions

1. Open [https://webmcp.spacescale.net/](https://webmcp.spacescale.net/) in
   ChatGPT's in-app browser or another environment that exposes WebMCP site
   tools.
2. Enter a board title, choose **Open a fresh canvas**, and then **Continue to
   board**. No account is required for the demo.
3. Enter `x² + 7x + 10 = 0`, sketch a deliberately incorrect graph with roots
   at `-3` and `-1`, and add a sticky containing that student claim.
4. Let the agent inspect the visual work. Then select the claim sticky and ask:
   “Add a counterexample that checks `x = -4` and asks the student to correct
   the plot.” Confirm the generated card computes `y = -2`, links to the source
   claim, carries AI provenance in the authoritative data, synchronizes to a
   second session, and disappears with one undo.
5. From **Access**, create a viewer invite. Open it in a private window and try
   the same write. Confirm that the viewer's agent cannot commit.
6. Choose **Video**, paste a public YouTube or Vimeo URL, and confirm the shared
   video card can be selected, moved, reloaded, and seen from the second session.
7. For local verification, use Node.js 22.19+, run `npm install`, then run
   `npm run check` and `npm run test:e2e`.

Detailed prompts and recovery paths are in
[`docs/hackathon-build/demo-runbook.md`](docs/hackathon-build/demo-runbook.md).

## Public Demo Link

[https://webmcp.spacescale.net/](https://webmcp.spacescale.net/)

## Public Repository Link

[https://github.com/shankarram-sq/spacescale](https://github.com/shankarram-sq/spacescale)

License: MIT. StayQrious remains the named copyright holder; Shankar Ram
Akshayakumar is identified as the original author and maintainer.

## Demo Video

TODO: Add the public YouTube URL for the final demo (under three minutes, clear
spoken audio).

## Screenshot Shot List

Upload these in this order:

1. `docs/submission-assets/ai-feedback-correction.png` — lead image: a mistaken
   hand-drawn quadratic and a real WebMCP-generated correction asking the
   student to plot `(-4, -2)`.
2. `docs/submission-assets/homepage.png` — education-focused SpaceScale landing
   page with the WebMCP badge and public product positioning.
3. `docs/submission-assets/media-math-canvas.png` — a live board combining a
   privacy-conscious video card, mathematical notation, and collaborative
   canvas tools.
4. `docs/submission-assets/handwriting-visual-review.png` — optional technical
   evidence for selected visual inspection.

Use the first image as the project thumbnail if Devpost accepts the same crop;
otherwise crop it to Devpost's requested aspect ratio without adding claims or
sensitive data.

## Submission Readiness Notes

- Live URL: provided and publicly reachable.
- Repository: public, with all source, setup instructions, tests, documentation,
  assets, and a detectable MIT license.
- WebMCP fit: explicit in the README, implementation spec, test instructions,
  and demo runbook.
- Existing-project disclosure: explicit, with challenge-period functional delta.
- Screenshots: committed under `docs/submission-assets/`.
- Demo script: timed to finish under three minutes and includes visible tool use,
  handwriting, author-scoped permission proof, video, realtime sync, and undo.
- Outstanding item: replace the single YouTube placeholder above after upload.

## Known Limitations

- WebMCP tools require a compatible host. The canvas itself still works in a
  normal browser without site tools.
- The public deployment is a hackathon demo for synthetic or non-sensitive
  content; real classroom rollout requires the documented safety,
  administration, and data-governance gate.
- Cross-Group Jigsaw remains behind an authoritative section-context provider;
  the live catalog exposes 27 non-section education modes and reports that
  boundary explicitly.
- Video cards embed supported lesson media but do not send a video's audio,
  transcript, or frame pixels to the agent.

## Official Form Fields

The following answers are prepared for the Devpost form:

- **Submitter Type:** Individual
- **Country of residence:** India
- **Organization name:** Leave blank
- **App Status:** Existing
- **If Existing, what was updated during the submission period?** Use the
  “What We Built During the Challenge” section above.
- **Live URL:** https://webmcp.spacescale.net/
- **Testing instructions:** Use the numbered “Testing Instructions” above.
- **Public repository:** https://github.com/shankarram-sq/spacescale
- **Agents/clients tested:** Codex in a WebMCP-compatible browser host; Chromium
  with a standards-shaped `document.modelContext` harness for automated tests.
- **AI tools leveraged:** Codex for product scoping, architecture, implementation,
  tests, debugging, review, and submission preparation.
- **Learning level:** Significant
- **Gained AI career value:** Yes
- **Demo video:** TODO — paste the final public YouTube URL.
