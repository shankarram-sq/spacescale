# Classroom AI safety and implementation gate

## Current status

SpaceScale exposes a WebMCP integration for the hackathon. The application
embeds no AI provider, model binding, AI request route, or provider
credential: the visiting WebMCP host performs the reasoning. The integration
reads the contribution set the teacher has selected, including each creator's
display name and stable participant ID for attribution, and submits validated
ordinary board operations directly to the shared canvas.

The public hackathon deployment is an isolated demonstration for synthetic or
otherwise non-sensitive test content. It is not approval for use with real
students. This policy remains the gate for a classroom rollout: the school and
product owner must approve the specific feature, data flow, provider, and
audience first.

## Consent model

Using SpaceScale is the consent. Everyone who has access to a board can see
every item on it, who created each item, and every vote. The AI partner acts
on behalf of the Space owner who is looking at that same board, so SpaceScale
does not add in-app consent dialogs, share previews, or approval steps in
front of WebMCP tools, and it does not hide identities or content on a board
from a user, or an agent acting for that user, who already has access to it.

Read tools return the current selection immediately. Write tools add to the
canvas immediately. Selection is the scoping mechanism, not a privacy control:
the agent works with what the teacher selected because that keeps its
contributions targeted, and the teacher can undo any AI batch in one step.

## Allowed purpose and control model

The first AI feature, if approved for real students, must be a narrow
facilitation aid such as clustering selected sticky notes, suggesting group
labels, summarizing a selected section for the teacher, or drafting starter
prompts. It must not grade, profile, rank, discipline, diagnose, or make
consequential decisions about a student.

- Only an owner acting as the teacher may read selected content or execute an AI
  write. A future classroom rollout must additionally add a server-enforced,
  fail-closed kill switch and board-level owner opt-in.
- Everyone on the board sees AI output as it lands: generated items are
  visibly marked with AI-assistance metadata and can be undone.
- School approval and the applicable lawful basis and notice must be recorded
  before use with real students. Age and jurisdiction rules are determined by
  the school; uncertainty means the feature stays off.
- Withdrawing or losing the required approval immediately prevents new AI
  requests without affecting ordinary non-AI board tools.

## Data boundary

An AI request contains the content the teacher selected and the minimum
instruction needed for the task. The complete board is never sent merely
because a section or item is selected.

Selected contributions include the creator's display name and stable
participant ID so the AI can associate an action with the correct person.
Email addresses, contact details, access tokens, and session data are not part
of any tool result because the page never holds them for other participants.

### Selected handwritten visual inspection

`inspect_selected_board_visual` is a bounded visual-input use case for
selected pencil strokes, sketches, shapes, arrows, and nearby selected
context. It sends no request through a new SpaceScale AI backend. The browser
renders the current saved selection into an SVG review surface for the
visiting WebMCP host to inspect, and opens it immediately.

The renderer replaces stable item IDs with ephemeral aliases. Result metadata
includes the creator name and stable participant ID for each item. Image cards
render as placeholders carrying their alt text because the exporter does not
embed asset pixels. The tool instructs the model to preserve uncertainty rather
than guess unclear handwriting and prohibits grading, ranking, or profiling.
Closing the review removes the temporary surface and never mutates the board.
This remains synthetic-demo functionality until the governance and provider
requirements below are satisfied for real student content.

### Generated visual responses

`add_content_visuals` is an output-only image use case. It does not send
existing board images or file metadata to a model. The model may provide a
classroom meme specification that is rendered locally, or an inline PNG, JPEG,
WebP, or GIF. SpaceScale rejects external URLs and SVG, decodes and re-encodes
the raster to remove metadata, applies the existing type, byte, dimension, and
pixel limits, and stores it in the board's asset bucket. The tool fails if the
Space owner has not enabled Images.

Every visual must cite the selected text aliases, include alt text and a
discussion question, and explicitly confirm that it depicts no real student
and does not ridicule or target an individual. The image, caption, and source
connectors carry durable AI attribution and are added as one undoable board
batch. This control is suitable for the synthetic hackathon demo; a real
classroom rollout still requires the provider, age-appropriateness, school
approval, and incident-response gates in this document.

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
leave the board unchanged. The interface labels generated content as
AI-assisted.

Every write is a tool call the teacher asked the agent to make. SpaceScale
adds no confirmation step of its own; the WebMCP host's normal tool-invocation
review applies. Confirmed actions pass through the existing authorization,
lock, limits, validation, history, undo, snapshot, and export paths and are
attributed to the teacher, with AI-assistance metadata, not to a synthetic AI
participant. The teacher can undo any AI batch in one step.

The AI audit record should be metadata-only: approved feature name, policy and
provider version, teacher's actor ID, affected item IDs, time, outcome, and
deletion status. Do not retain the raw input or output in that record.
Generated output is ordinary board content, so owners can undo or delete it
and it follows the normal board export and retention behavior. The school must
also be able to export or delete the associated AI audit metadata and request
deletion of any provider-held transient data.

## Implementation gate checklist

The hackathon demonstration may be exercised only with synthetic or otherwise
non-sensitive test content. No real-student classroom rollout may begin until
every applicable item below has an owner and recorded evidence.

### Governance and experience

- [ ] Define one narrow classroom use case, intended ages, prohibited uses,
  and the accountable school owner.
- [ ] Record school approval, lawful basis, notices, retention schedule, and
  data-subject request process.
- [ ] Design owner-only opt-in, participant disclosure, output labeling, and
  an immediate stop control.
- [ ] Preserve a complete non-AI path for the same classroom activity.

### Provider and data protection

- [ ] Document an exact data-flow inventory proving selected-content-only
  transfer.
- [ ] Approve the provider contract, no-training and retention terms,
  subprocessors, processing region, security controls, incident terms, and
  deletion/export procedure.
- [ ] Complete school privacy, safeguarding, security, accessibility, and
  procurement reviews appropriate to the deployment.

### Engineering and safety

- [ ] Add a server-enforced, fail-closed global kill switch plus board-level
  owner opt-in; do not expose provider credentials to the browser.
- [ ] Enforce role, board lock, selection bounds, request limits, filtering,
  timeouts, rate limits, and abuse controls at the Worker.
- [ ] Keep rejected output out of board state, history, snapshots, exports,
  offline outboxes, analytics, and logs.
- [ ] Submit changes only as validated ordinary actions attributed to the
  teacher, with metadata-only AI auditing and tested delete/export paths.
- [ ] Test selection isolation, unsafe input/output, prompt-injection
  resistance, provider failure, revocation, concurrent role changes, lock
  changes, audit minimization, and kill-switch behavior.

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
