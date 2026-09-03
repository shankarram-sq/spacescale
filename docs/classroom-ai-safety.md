# Classroom AI safety and implementation gate

## Current status

SpaceScale now exposes a constrained WebMCP integration for the hackathon. The
application still embeds no AI provider, model binding, AI request route, or
provider credential: the visiting WebMCP host performs the reasoning. The
integration is discoverable in every browser that can open the board. It reads
only that browser's saved selection, including each creator's board-visible
display name and stable participant ID for attribution. Writes submit validated
ordinary board operations only when the current participant has normal board
edit permission.

The public hackathon deployment is an isolated demonstration for synthetic or
otherwise non-sensitive test content. It is not approval for use with real
students. This policy remains the gate for a classroom rollout: the school and
product owner must approve the specific feature, data flow, provider, and
audience first.

## Allowed purpose and control model

The first AI feature, if approved, must be a narrow facilitation aid such as
clustering selected sticky notes, suggesting group labels, summarizing a
selected section for the teacher, or drafting starter prompts. It must not grade,
profile, rank, discipline, diagnose, or make consequential decisions about a
student.

- Every browser with board access discovers the WebMCP tools. Read tools operate
  on the saved selection in that browser; write tools use the existing board
  edit permission and never elevate a viewer. A future classroom rollout must
  additionally add a server-enforced, fail-closed kill switch and board-level
  owner opt-in.
- The board header shows whether a WebMCP host is linked to this browser and how
  many tools it can see, so a participant can tell at a glance when an assistant
  is present. While a watch is live the tool rail also offers an AI action that
  shares the whole board. Both are deliberate, visible AI chrome.
- The WebMCP host surfaces tool calls and permissions. Generated items and
  comments retain internal `assistedBy` metadata, use the responsible
  participant's normal author badge, and carry a small, consistent AI mark so a
  reader can always tell tool-written content from a person's. SpaceScale adds
  no other AI chrome except the board's Ask AI button, which exists only while a
  problem-step watch is live in that browser.
- School approval and the applicable lawful basis, notice, and student or
  guardian consent must be recorded before use. Age and jurisdiction rules are
  determined by the school; uncertainty means the feature stays off.
- Withdrawing or losing the required approval immediately prevents new AI
  requests without affecting ordinary non-AI board tools.

## Data boundary

Scope is set deliberately, and differs by tool. Every read tool except the watch
reads only the participant's browser selection, and selecting a Section still
shares that Section rather than its contents. The watch is the deliberate
exception: starting it puts the whole board in scope for as long as it runs, which
is what makes live coaching over handwriting workable. Starting a watch is an
explicit act by the participant's host, the board shows while one is running, and
it expires after 15 minutes. Beyond scope, a request carries only the minimum
instruction needed for the approved task.

Selected contributions may include the creator's board-visible display name and
stable opaque participant ID so the AI can associate an action with the correct
person. This permission does not extend to email addresses, contact details,
board or item IDs, access tokens, session data, presence data, activity history,
or unselected item content. Images and file metadata are excluded unless a
separately reviewed image use case is approved and visibly selected.

### Whole-board watch

`watch_board` lets a visiting WebMCP host follow this board for at most 15
minutes. It follows every saved object of any kind, including handwriting,
shapes, images and video embeds, and takes in objects saved after it started. It
reports only authoritative saved changes. This is the one tool whose scope is the
whole board rather than the browser selection: every other read tool still reads
only what the participant has selected.

Written work is reported as its saved text. Drawn work is reported as a short
description of what it is and the saved version it is at, and, because
handwriting cannot be coached from a description, every result about a board
holding drawn work also carries a PNG of that board. The picture is rendered in
the page from saved objects only; private image cards appear as placeholders
rather than their pixels, and its long edge is capped so a result stays a
readable size. A board of writing alone carries no picture.

The watch is a bounded sequence of cancelable long-poll tool calls rather than a
background SpaceScale model connection. Its page-memory token expires after 15
minutes, the participant can ask the host to stop it immediately, and navigating
away destroys it. Results use ephemeral `step_N` aliases and board-visible display
names only; they exclude stable participant, board, and item IDs, coordinates,
presence, history, contact details, and authentication data. Unsaved keystrokes
are never observed. Step content is marked as untrusted content, and the host is
instructed to comment briefly on the reasoning without grading, profiling, or
inferring ability.

While a watch is live the board shows an Ask AI button, and the tool rail offers
an AI action for the whole board. A participant's request
carries only step aliases and their content, the chosen action, and an optional
280-character note, and it reaches the host only through the watch's next long
poll. The action list deliberately offers "Check my work" (formative
verification, no score) instead of grading. The host replies through
`comment_on_watched_step`, which posts an ordinary object comment on the step
attributed to the requesting participant and tagged as AI-written, or through
the existing card tools; the caller's WebMCP permission is the confirmation, as
it is for the headless card tools.

### Selected handwritten visual inspection

`inspect_selected_board_visual` is a separately bounded visual-input use case for
browser-selected pencil strokes, sketches, shapes, arrows, and nearby selected
context. It sends no request through a new SpaceScale AI backend. The browser
renders the current saved selection into an isolated SVG review surface for the
visiting WebMCP host to inspect. An opaque backdrop covers the unselected board.

The renderer replaces stable item IDs with ephemeral aliases. Result metadata
includes the board-visible creator name and stable participant ID for each item,
but no board ID, item ID, coordinate, presence, or history fields. Private board
image pixels and file metadata are not exposed; selected image cards render as
labeled placeholders. The tool instructs the model to preserve uncertainty rather
than guess unclear handwriting and prohibits grading, ranking, profiling, or
inferences about a person from attribution. Closing the review removes the
temporary surface and never mutates the board. This remains synthetic-demo
functionality until the governance and provider requirements below are satisfied
for real student content.

### Generated visual responses

`add_content_visuals` is an output-only, participant-requested image use case. It
does not send existing board images or file metadata to a model. The model may
provide a classroom meme specification that is rendered locally, or an inline
PNG, JPEG, WebP, or GIF. SpaceScale rejects external URLs and SVG, decodes and
re-encodes the raster to remove metadata, applies the existing type, byte,
dimension, and pixel limits, and stores it only in the board's private asset
bucket. The tool fails if Images are disabled or the participant lacks edit access.

Every visual must cite the selected text aliases and include a discussion
question (alt text is optional; the title is the accessible fallback), and explicitly confirm that it depicts no real student
and does not ridicule or target an individual. The image, caption, and source
connectors retain internal origin metadata and are added as one participant-permitted,
undoable board batch. This control is suitable for the synthetic hackathon
demo; a real classroom rollout still requires the provider, age-appropriateness,
school approval, and incident-response gates in this document.

The chosen provider and contract must require:

- no training, model improvement, advertising, profiling, or human review with
  classroom inputs or outputs;
- no provider retention or request logging beyond transient processing, unless
  a documented technical minimum is approved with a deletion deadline;
- encryption in transit, access controls, incident notification, documented
  subprocessors and processing region, and a school-approved data-processing
  agreement;
- deletion and export support sufficient for the school's student-data and
  records obligations.

Secrets remain server-side. Raw prompts, selected classroom content, model
responses, credentials, and provider request IDs must not appear in application
logs, analytics, error reports, or durable audit metadata.

## Safety, review, and board mutations

Inputs and outputs need age-appropriate content filtering and bounded size,
time, and rate limits. Unsafe, disallowed, or uncertain results fail closed and
leave the board unchanged. The WebMCP host surfaces tool calls and their
permissions; SpaceScale keeps `assistedBy` metadata on every AI-written item
and comment and shows a small AI mark beside the participant attribution.

Model output remains a proposal until the participant confirms its write. For
the five headless education tools, the caller's WebMCP host permission shows the
semantic tool invocation—including the proposed cards and selected source
aliases—and serves as confirmation when normal board edit permission also
allows it. The headline inquiry and class decision flows add an in-app “no
changes yet” preview. No tool may create, update, delete, group, move, or
otherwise mutate board items without this confirmation. Confirmed actions pass
through the existing authorization, lock, limits, validation, history, undo,
snapshot, and export paths and are attributed to the confirming participant,
not to a synthetic AI participant.

The AI audit record should be metadata-only: approved feature name, policy and
provider version, confirming participant's opaque actor ID, affected item IDs,
time, outcome, and deletion status. Do not retain the raw input or output in
that record. Confirmed output is ordinary board content, so owners can undo or
delete it and it follows the normal board export and retention behavior. The
school must also be able to export or delete the associated AI audit metadata
and request deletion of any provider-held transient data.

## Implementation gate checklist

The hackathon demonstration may be exercised only with synthetic or otherwise
non-sensitive test content. No real-student classroom rollout may begin until
every applicable item below has an owner and recorded evidence.

### Governance and experience

- [ ] Define one narrow classroom use case, intended ages, prohibited uses,
  and the accountable school owner.
- [ ] Record school approval, lawful basis, notices, consent or assent rules,
  withdrawal flow, retention schedule, and data-subject request process.
- [ ] Design owner-only opt-in, participant disclosure, explicit selection,
  pre-send review, output labeling, teacher confirmation, and an immediate
  stop control.
- [ ] Preserve a complete non-AI path for the same classroom activity.

### Provider and data protection

- [ ] Document an exact data-flow inventory proving selected-content-only
  transfer and server-side identifier redaction.
- [ ] Approve the provider contract, no-training and retention terms,
  subprocessors, processing region, security controls, incident terms, and
  deletion/export procedure.
- [ ] Complete school privacy, safeguarding, security, accessibility, and
  procurement reviews appropriate to the deployment.

### Engineering and safety

- [ ] Add a server-enforced, fail-closed global kill switch plus board-level
  owner opt-in; do not expose provider credentials to the browser.
- [ ] Enforce role, board lock, consent state, selection bounds, request limits,
  filtering, timeouts, rate limits, and abuse controls at the Worker.
- [ ] Keep unconfirmed output out of board state, history, snapshots, exports,
  offline outboxes, analytics, and logs.
- [ ] Submit confirmed changes only as validated ordinary actions attributed to
  the teacher, with metadata-only AI auditing and tested delete/export paths.
- [ ] Test identifier removal, selection isolation, unsafe input/output,
  prompt-injection resistance, provider failure, revocation, concurrent role
  changes, lock changes, audit minimization, and kill-switch behavior.

### Rollout

- [ ] Obtain final written approval for the exact feature and configuration;
  generic approval for "AI" is insufficient.
- [ ] Pilot with synthetic or non-sensitive content in an isolated environment,
  then a small explicitly approved classroom cohort.
- [ ] Publish support, incident, deletion, and rollback procedures; monitor only
  privacy-safe operational metadata.
- [ ] Re-review before changing the provider, model, use case, input types,
  retention, audience, region, or subprocessors.

Until all required checks pass, the shipped sticky-note, template, section, voting,
and arrange tools remain the supported non-AI alternatives.
