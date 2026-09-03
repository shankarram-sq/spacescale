# WebMCP hackathon demo runbook

## Setup

1. Open SpaceScale in a Codex or compatible browser environment with WebMCP enabled.
2. Use GPT-5.6 Sol or GPT-5.6 Terra. Site tools are not currently available in Enterprise or Edu workspaces.
3. Open the board as any participant. Use a participant with edit access for write-tool demos, and open two more invitation/browser sessions for a convincing live vote.
4. From **Templates**, add **Collective inquiry demo**. Wait until the seeded objects finish saving.

The template contains the challenge “How might our school reduce cafeteria waste?”, eight contrasting contributions, and a live three-option vote table.

## Three-minute story

### 0:00–0:30 — establish the problem

Show that several students are editing one canvas. Say:

> Most classroom AI creates 30 private conversations for 30 students. SpaceScale gives the class one shared, visible conversation with an AI thinking partner.

Select the eight sticky notes, then ask Codex to inspect the board's available WebMCP tools. SpaceScale needs no dedicated AI button or status chrome.

### 0:30–1:20 — first collaborative loop

Ask the agent:

> Use SpaceScale’s site tools to read the selected class ideas. Find three meaningful themes, two surprising bridges across the class, one productive tension, and a next question. Then stage a collective inquiry map for participant review.

Show both human-control moments:

1. The WebMCP host shows the selected-ideas tool call; the result includes board-visible creator attribution.
2. SpaceScale previews the proposed themes, bridges, tension, and operation count before changing the canvas.

Approve the map. Point out that it appears as shared canvas objects, not private chat text, and is one undoable realtime update.

### 1:20–2:05 — students change the state

Have students react to the shared map and place one stamp each in the vote table. Emphasize that student response—not an isolated prompt—determines the next AI contribution.

Select only the vote table.

### 2:05–2:45 — second collaborative loop

Ask the agent:

> Read the live class vote. Propose a small pilot based on the response, but keep the strongest minority concern visible and leave the class with a next question. Stage the decision for teacher review.

Show the aggregate bars in the decision preview. Approve it. Point out the four visible outcomes:

- class choice and rationale;
- dissent the class will not erase;
- small pilot and success measure;
- next question that keeps inquiry open.

### 2:45–3:00 — close

Undo the decision once to prove participant control, then redo it if useful. End with:

> The AI has a seat at the table, not the teacher’s chair.

## Recovery prompts

If the agent does not call the tools automatically:

> Inspect the available SpaceScale site tools. Start with `read_selected_class_ideas`, then use its selection token with `stage_collective_inquiry`.

For the second loop:

> Use `read_live_class_vote` on the selected table, then use its vote token with `stage_class_decision`. Include a concrete minority concern.

## Judge exploration: the broader education toolkit

The core three-minute story uses the two previewed loops. If a judge asks what else the WebMCP integration enables, call `list_class_collaboration_modes`, let Codex follow the returned entry/role/connection contract, keep the same browser-selection token, and try one prompt from each family:

- **Expand thinking:** “Use Gap Finder to add only two missing perspectives as testable questions.”
- **Understand ideas:** “Offer exactly two alternative clusterings and ask what each organization reveals or hides.”
- **Improve reasoning:** “Map one claim, one assumption and one counterexample; connect them and ask what evidence would change our minds.”
- **Support decisions:** “Draft criteria from the discussion, but leave every class weight blank for students.”
- **Turn ideas into action:** “Convert one selected hypothesis into a prediction, evidence need and small reversible test.”
- **Make the thinking memorable:** “Create one classroom-safe meme from two selected ideas. Make the joke reveal a connection, add alt text, and ask what the meme helps us notice or oversimplifies.”

These calls use `add_thinking_expansion`, `add_idea_sensemaking`, `add_collective_reasoning`, `add_group_decision_scaffold`, `add_learning_action_plan`, and `add_content_visuals`. They add no new feature-specific interface: Codex supplies the reasoning and visual concept, SpaceScale validates the structure and source aliases, and normal board edit permission governs writes. Meme cards render locally; generated raster images are sanitized into the existing private board asset path. Cross-Group Jigsaw is intentionally deferred to the separately tested section-context integration.

### Optional handwriting moment

Draw or paste synthetic handwritten strokes on an otherwise quiet part of the board, select only those strokes and any context the class wants to include, then ask:

> Inspect the selected board visual. Carefully transcribe what is legible, mark anything uncertain, and suggest two connections plus one question the class should discuss together.

Codex calls `inspect_selected_board_visual`. SpaceScale directly opens a selected-only visual review with an opaque backdrop. Point out that the SVG contains ephemeral aliases instead of board IDs, unselected notes are absent, private image pixels are placeholders, and closing the review leaves the shared canvas unchanged.

### Optional live problem-coaching moment

Select the exact saved notes, text items, table, or Section title that contain the
participant's working steps, then ask:

> Watch these selected problem steps for 15 minutes. Whenever I save a changed step, comment briefly on whether the reasoning follows, identify the first issue or uncertainty, ask one useful next-step question, and keep watching. Do not solve ahead unless I ask.

Codex calls `watch_selected_problem_steps` with `action: "start"`, then alternates
short feedback with bounded `wait` calls. Edit and finish saving a selected item
to demonstrate immediate feedback. Point out that the tool observes only
authoritative saved changes—not keystrokes—and that selecting a Section shares
its title only, never its contents. Ask Codex to stop early, or let the watch end
automatically after 15 minutes.

## Demo checks

- Site tools menu lists all fifteen tools; `list_class_collaboration_modes` reports 27 live modes, the bounded problem-step watch and visual tool, an enforceable input contract for every mode, the reserved section boundary, and no unselected board data.
- Selection results include selected text, action type, and the creator's board-visible name and stable participant ID.
- Thinking expansion rejects more than three additions; every critique card ends in a question.
- Decision scaffolds leave weights, ratings, votes, response counts, and final choice blank.
- Every generated card has source connectors and the responsible participant's ordinary author badge; no AI-specific label is added to the board.
- A visual call adds only one to three private images, each with alt text, a source-linked caption, and a discussion question; external URLs and student likenesses are rejected by contract.
- Cancelling either proposal leaves the board unchanged.
- Approval appears in a second browser session.
- Tool success arrives after the server acknowledgement.
- Undo removes the approved generated batch.
- Vote results contain counts only and never expose identities.
