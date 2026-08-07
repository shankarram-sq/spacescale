# Classroom AI safety and implementation gate

## Current status

AI assistance is **not implemented and not enabled**. The application has no AI
provider, model binding, AI request route, or browser control. AI-driven browser
testing mentioned elsewhere in this repository describes test automation, not a
classroom product feature.

This policy is the gate for any future AI work. Completing the checklist does
not itself authorize a rollout: the school and product owner must approve the
specific feature, data flow, provider, and audience first.

## Allowed purpose and control model

The first AI feature, if approved, must be a narrow facilitation aid such as
clustering selected sticky notes, suggesting group labels, summarizing a
selected zone for the teacher, or drafting starter prompts. It must not grade,
profile, rank, discipline, diagnose, or make consequential decisions about a
student.

- AI is off by default in every environment. A future implementation must add
  a server-enforced kill switch whose absent or invalid value means off.
- Only an owner acting as the teacher may opt in, separately for the board or
  activity. A school-wide setting alone is not participant consent.
- Everyone on the board must see when AI is active, what selected content will
  be sent, why it is being sent, and how to withdraw before submission.
- School approval and the applicable lawful basis, notice, and student or
  guardian consent must be recorded before use. Age and jurisdiction rules are
  determined by the school; uncertainty means the feature stays off.
- Withdrawing or losing the required approval immediately prevents new AI
  requests without affecting ordinary non-AI board tools.

## Data boundary

An AI request may contain only the content the teacher explicitly selected and
the minimum instruction needed for the approved task. The complete board must
never be sent merely because a zone or item is selected.

Before a request leaves the Worker, remove or replace user identifiers, email
addresses, participant names, actor IDs, board IDs, access tokens, session
data, presence data, activity history, and unselected item content. Images and
file metadata are excluded unless a separately reviewed image use case is
approved and visibly selected.

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

Model output is always a preview for the teacher. It cannot create, update,
delete, group, move, or otherwise mutate board items automatically. Only an
explicit teacher confirmation may convert a suggestion into ordinary board
actions. Those actions pass through the existing authorization, lock, limits,
validation, history, undo, snapshot, and export paths and are attributed to the
confirming teacher, not to a synthetic AI participant.

The AI audit record should be metadata-only: approved feature name, policy and
provider version, confirming teacher's opaque actor ID, affected item IDs,
time, outcome, and deletion status. Do not retain the raw input or output in
that record. Confirmed output is ordinary board content, so owners can undo or
delete it and it follows the normal board export and retention behavior. The
school must also be able to export or delete the associated AI audit metadata
and request deletion of any provider-held transient data.

## Implementation gate checklist

No AI code may be enabled until every applicable item below has an owner and
recorded evidence.

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

Until all required checks pass, the shipped sticky-note, template, zone, voting,
and arrange tools remain the supported non-AI alternatives.
