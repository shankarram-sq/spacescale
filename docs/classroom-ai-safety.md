# Classroom AI safety and implementation gate

## Current status

SpaceScale now exposes a constrained WebMCP integration for the hackathon. The
application still embeds no AI provider, model binding, AI request route, or
provider credential: the visiting WebMCP host performs the reasoning. The
integration reads only a teacher-approved anonymized selection and submits
validated ordinary board operations after an explicit WebMCP write permission.

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

- Only an owner acting as the teacher may read selected content or execute an AI
  write. The selection dialog and WebMCP host permission are separate, explicit
  decisions. A future classroom rollout must additionally add a server-enforced,
  fail-closed kill switch and board-level owner opt-in.
- Everyone on the board must see when AI is active, what selected content will
  be shared, why it is being shared, and how to withdraw before submission.
  Confirmed output remains visibly marked with AI-assistance metadata.
- School approval and the applicable lawful basis, notice, and student or
  guardian consent must be recorded before use. Age and jurisdiction rules are
  determined by the school; uncertainty means the feature stays off.
- Withdrawing or losing the required approval immediately prevents new AI
  requests without affecting ordinary non-AI board tools.

## Data boundary

An AI request may contain only the content the teacher explicitly selected and
the minimum instruction needed for the approved task. The complete board must
never be sent merely because a section or item is selected.

Before a request leaves the Worker, remove or replace user identifiers, email
addresses, participant names, actor IDs, board IDs, access tokens, session
data, presence data, activity history, and unselected item content. Images and
file metadata are excluded unless a separately reviewed image use case is
approved and visibly selected.

### Selected handwritten visual inspection

`inspect_selected_board_visual` is a separately bounded visual-input use case for
teacher-selected pencil strokes, sketches, shapes, arrows, and nearby selected
context. It sends no request through a new SpaceScale AI backend. After the
teacher approves item kinds and counts, the browser renders only the still-current
saved selection into an isolated SVG review surface for the visiting WebMCP host
to inspect. An opaque backdrop covers the unselected board.

The renderer replaces stable item IDs with ephemeral aliases and includes no
author, actor, board, coordinate, presence, or history fields in the tool result.
Private board image pixels and file metadata are not exposed; selected image cards
render as labeled placeholders. The call fails if the selected item set or any
version changes during approval. The tool instructs the model to preserve
uncertainty rather than guess unclear handwriting and prohibits grading, ranking,
profiling, and individual attribution. Closing the review removes the temporary
surface and never mutates the board. This remains synthetic-demo functionality
until the governance and provider requirements below are satisfied for real
student content.

### Generated visual responses

`add_content_visuals` is an output-only, teacher-requested image use case. It
does not send existing board images or file metadata to a model. The model may
provide a classroom meme specification that is rendered locally, or an inline
PNG, JPEG, WebP, or GIF. SpaceScale rejects external URLs and SVG, decodes and
re-encodes the raster to remove metadata, applies the existing type, byte,
dimension, and pixel limits, and stores it only in the board's private asset
bucket. The tool fails if the Space owner has not enabled Images.

Every visual must cite the approved text aliases, include alt text and a
discussion question, and explicitly confirm that it depicts no real student
and does not ridicule or target an individual. The image, caption, and source
connectors carry durable AI attribution and are added as one teacher-permitted,
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
leave the board unchanged. The interface must label generated suggestions as
AI-assisted and warn that they may be inaccurate or biased.

Model output remains a proposal until the teacher explicitly confirms its
write. For the five headless education tools, the WebMCP host write permission
shows the semantic tool invocation—including the proposed cards and approved
source aliases—and serves as that confirmation. The headline inquiry and class
decision flows add an in-app “no changes yet” preview. No tool may create,
update, delete, group, move, or otherwise mutate board items without this
confirmation. Confirmed actions pass through the existing authorization, lock,
limits, validation, history, undo, snapshot, and export paths and are attributed
to the confirming teacher, not to a synthetic AI participant.

The AI audit record should be metadata-only: approved feature name, policy and
provider version, confirming teacher's opaque actor ID, affected item IDs,
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
