# Title

SpaceScale

## One-line Summary

Multiplayer AI for the classroom: one shared canvas, a whole class, and one
WebMCP agent that reads every student's handwriting and typed work, while the
teacher's own skills and files decide what it knows and what it may do.

## Problem

AI is mainstream, but almost all of it is single-player: one person, one chat,
one private answer. A classroom is the opposite. Thirty people work on the same
problem at once, at different speeds, with different misconceptions, and the
person who knows them best is standing at the front of the room.

Multiplayer AI, where one agent watches a shared workspace and responds to each
person inside it, is rare. Multiplayer AI that the host controls from their own
device, with their own notes and rules, without anyone deploying a server, is
rarer still. And the richest evidence of student thinking, the working steps and
the diagrams, is handwritten, which digital tools usually cannot assess at all.

## Solution

SpaceScale is a realtime visual classroom built on Cloudflare. Students and
teachers draw, write by hand on a Huion or any other pen tablet, type, organize,
comment, vote, and embed YouTube or Vimeo videos on one durable canvas. When the
board is open in a WebMCP-capable host, the page registers twelve tools. Six
read: one reading of the whole board, the current selection, or one named
participant's work, plus a participant list, an aggregate vote reader, and an
activity-template reader. Two follow the same three scopes live for fifteen
minutes. Four write: comments that can carry a picture or a video, sticky
notes, images, and videos.

The teacher starts a board watch from Codex with a coaching skill and the class
documents loaded. From then on the agent follows every saved step across the
class, analyses handwriting strokes and diagrams as well as text, and answers
each student on their own work: a fast-finisher question for one, a hint (not
the answer) for another, a short video attached to a comment for a third. When
one student needs more attention, the teacher can point the watch at that
student's work alone. Every reply lands as an ordinary canvas object, marked as
AI-written, attributed to the teacher, visible in real time, and undoable in
one step.

WebMCP also runs the other way. While a watch is live, the board shows an
**Ask AI** button in the selection toolbar and an **AI** action in the tool
rail. A student picks a step and an action (Explain, Ideate, Critique, Check my
work, Examples, Explain with a video); the request reaches Codex on the watch's
next long poll with a reply plan naming the exact tool call to answer with. The
page is a participant that can ask, not just a target of tool calls.

## Why This Matters

Each piece exists somewhere. A tutor bot can hint. A chat can summarise a
brainstorm. A vision model can read a graph. What did not exist is all of it at
once, in real time, on a shared space, personal to one teacher's notes and
rules, with the agent holding exactly that teacher's permissions and nothing
more.

The most valuable context in a lesson is not in any database. It is the live
page: who is on which step, what they just saved, what they selected, how the
class voted. WebMCP hands that context to the agent and hands the agent's
answer back to the page, without DOM scraping, a browser extension, or a second
server.

The logic of the lesson lives in the teacher's own skills and files. A skill
encodes the pedagogy: when to hint, when to hold back, when to reach for a
video. Local documents supply the knowledge: class notes, marking scheme, video
list. A skill is a text file, so two teachers can run the same board with
different coaching styles and a department can share and edit one on a Friday
afternoon. Anything SpaceScale does not do today can be added the same way,
without touching the site.

Because the twelve tools are generic, the same board serves any domain. Swap the
skill and it becomes a marketing war room that connects campaign ideas aimed at
the same audience, a project retrospective that groups sticky notes by root
cause, or a design critique that reads the sketches.

## How We Used AI

The visiting WebMCP agent performs all reasoning; SpaceScale contributes the
context only the live application has. A scope is the same question whether
read once or followed live: the whole board, the selection, or one person's
work. The watch delivers server-acknowledged saved changes to every object in
its scope, including handwriting strokes, shapes, and diagrams, so the agent can
follow a multi-step solution to the step that went wrong or check a drawing
against the claim beside it. The vote reader returns aggregate counts only. The
template reader lets the agent lay out a whole activity scaffold in one call.

AI is used to coach each student on their own step, hand out fast-finisher
work, connect students who chose the same brainstorm issue, surface the
assumptions under each side of a debate, and explain with a placed video.
Schemas keep votes, grades, and student profiles out of model control.

## How We Used Codex

Codex was the primary engineering partner for the WebMCP Challenge work. It
helped translate the classroom idea into semantic tool contracts, implement the
WebMCP adapters, the two-way watch, and the participant-scoped write path,
write unit, edge, and browser coverage, debug realtime acknowledgement, and
prepare the demo, runbook, and submission.

Codex is also the reference demo agent. The teacher runs it with a coaching
skill and local class documents; it discovers the tools from the live page,
watches the board, receives Ask AI requests, and replies through permission-
bound site actions.

## Key Features

- Twelve discoverable WebMCP tools. Reads: `read_board`, `read_selection`,
  `read_user`, `list_users`, `read_live_class_vote`, `read_templates`.
  Watches: `watch_board` with scope board or selection, and `watch_users`.
  Writes: `insert_comment`, `insert_sticky`, `insert_image`, `insert_video`.
  Each write places one object where the call asks, as a single acknowledged
  realtime command.
- Three scopes, read once or followed live: the whole board, the current
  selection, or one named student's work. Following a student is
  teacher-initiated, visible, and expiring, and reports strictly less than a
  board watch.
- Comments that carry a picture or a public video beside their text, so a
  reply can show the diagram or the clip it is talking about right on the
  student's step.
- Two-way WebMCP: an **Ask AI** button and a whole-board **AI** action deliver
  participant requests to the host on the watch's next long poll, with a reply
  plan naming the next tool call.
- Handwriting and diagram analysis from strokes written on a Huion or any pen
  tablet, so steps and diagrams that digital setups usually cannot evaluate
  become assessable.
- Skills and local files as the pedagogy: the teacher's Codex skill and
  documents set the mode, rules, and background material for the class. Five
  skills ship in the repo under `.agents/skills` with an install guide:
  problem-set coach, brainstorm connector, debate mapper, working checker,
  and follow one student.
- Per-student Sections so feedback lands on one person's work while the rest
  of the class stays visible beside it.
- Same-author permission inheritance: no service account, no elevated agent
  role, local preflight plus authoritative Worker enforcement, success only
  after server acknowledgement.
- Every AI contribution carries a visible AI mark and `assistedBy` provenance,
  is attributed to the responsible participant, syncs in real time, and undoes
  in one step.
- Shared YouTube and Vimeo cards, MathJax with a MathLive keyboard, object
  comments, templates, stamps, tables, sections, snapshots, and offline
  recovery.

## Architecture

The TypeScript browser application registers tools with
`document.modelContext.registerTool` when the API is present and remains a full
collaborative canvas when it is absent. The watch lives only in page memory,
returns ephemeral aliases rather than stable IDs, never captures unsaved
keystrokes, and expires after fifteen minutes. Write tools accept a location
and content, never coordinates of other objects, arbitrary HTML, or an actor
identity.

All writes flow through the participant's durable outbox and WebSocket session.
One `BoardRoom` Durable Object per board validates role, item ownership,
section locks, versions, and batch limits before a shared reducer sequences and
persists the action to SQLite. The resulting authoritative action resolves the
WebMCP promise and is broadcast to collaborators. Private raster assets,
recovery checkpoints, and named snapshots use R2.

The site holds state and presentation; the client holds knowledge and rules.
That split is deliberate, and it is why the same code serves any domain.

## What We Built During the Challenge

SpaceScale is an **existing project** based on the open-source Cloudflare
Collab Canvas foundation. During the WebMCP Challenge submission period it was
extended from a secure collaborative whiteboard into an AI-enabled learning
product. The challenge work added:

- the twelve-tool WebMCP integration, with the surface kept to generic reads,
  watches, and writes so skills carry the pedagogy;
- three scopes for reading and watching: the whole board, the selection, or
  one participant's work, with a participant list derived from saved content;
- the two-way watch: bounded long polls, the Ask AI selection action, the
  whole-board AI action, and reply plans that name the tool that continues;
- comments that carry a picture or a video through the same asset pipeline and
  link check as the canvas;
- handwriting and diagram support through the watch;
- the participant-scoped WebMCP commit and acknowledgement path with AI
  provenance and a visible AI mark;
- per-student Sections, demo boards, activity templates, shared video cards,
  MathJax with a MathLive keyboard, object comments, and classroom roles;
- contract, unit, edge, and Chromium coverage for the permission and WebMCP
  boundaries;
- five installable Codex skills with an install guide;
- the implementation spec, safety gate, pitch, demo runbook, and screenshots.

The public repository history and the comparison with the upstream foundation
show the complete functional delta.

## Testing Instructions

1. Open [https://webmcp.spacescale.net/](https://webmcp.spacescale.net/) in a
   WebMCP-capable host such as Codex in a compatible browser. No account is
   required for the demo.
2. Enter a board title, choose **Open a fresh canvas**, then **Continue to
   board**.
3. Open **Templates** and insert **Problem set: six students**. Ask the host to
   start `watch_board`. Edit one student's answer, then select a step, press
   **Ask AI**, and choose **Check my work**. Confirm the reply arrives as a
   comment on that step, marked as AI, attributed to you, synced to a second
   session, and removed by one undo.
4. For handwriting, insert **Graph check: one student's working**. Ask the
   agent to check the drawn curve against the equation, then ask it to add a
   counterexample at `x = -4`. Confirm the card computes `y = -2` and asks the
   student to plot `(-4, -2)`.
5. From **Access**, create a viewer invite, open it in a private window, and
   try the same write. Confirm the viewer's agent cannot commit.
6. Choose **Video**, paste a public YouTube or Vimeo URL, and confirm the shared
   card can be selected, moved, and seen from the second session.
7. For local verification, use Node.js 22.19+, run `npm install`, then
   `npm run check` and `npm run test:e2e`.

Detailed prompts and recovery paths are in
[`docs/hackathon-build/demo-runbook.md`](docs/hackathon-build/demo-runbook.md).
The full pitch is in
[`docs/hackathon-build/pitch.md`](docs/hackathon-build/pitch.md).

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
   evidence for handwriting analysis.

Use the first image as the project thumbnail if Devpost accepts the same crop;
otherwise crop it to Devpost's requested aspect ratio without adding claims or
sensitive data.

## Submission Readiness Notes

- Live URL: provided and publicly reachable.
- Repository: public, with all source, setup instructions, tests, documentation,
  assets, and a detectable MIT license.
- WebMCP fit: explicit in the README, pitch, implementation spec, test
  instructions, and demo runbook.
- Existing-project disclosure: explicit, with challenge-period functional delta.
- Screenshots: committed under `docs/submission-assets/`.
- Demo script: timed to finish under three minutes and includes visible tool use,
  handwriting, Ask AI, author-scoped permission proof, video, realtime sync, and
  undo.
- Outstanding item: replace the single YouTube placeholder above after upload.

## Known Limitations

- WebMCP tools require a compatible host. The canvas itself still works in a
  normal browser without site tools.
- The page-to-agent direction currently rides on bounded 20-second long polls.
  When WebMCP offers a push or subscription mechanism, the same tools move onto
  it.
- The watch gets chatty when many participants save work at once and replies
  slow down. It suits a small group today.
- A Codex background agent has no access to the browser, so it cannot call
  the board's tools. The watch runs in the foreground session and the teacher
  steers it with comments in chat.
- The fix is multiple agents: a background agent holding the watch so Codex
  stays responsive, asking back for detail, and spinning up to two extra
  agents when requests queue. Codex accepts the background instruction but the
  behaviour is not yet reliable and needs more testing. It is a prompt and
  skill change, not a site change.
- The public deployment is a hackathon demo for synthetic or non-sensitive
  content; real classroom rollout requires the documented safety,
  administration, and data-governance gate.
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
  tests, debugging, review, and submission preparation, and as the demo agent
  driven by teacher-authored skills and files.
- **Learning level:** Significant
- **Gained AI career value:** Yes
- **Demo video:** TODO — paste the final public YouTube URL.
