---
name: spacescale-debate-mapper
description: Surface the assumptions under each side of a debate on a SpaceScale board. Use when a teacher opens a SpaceScale board in Codex and asks you to watch a debate, structured argument, or for-and-against activity and help students see the assumptions, evidence gaps, or claims behind their arguments. Do not use for problem sets, brainstorms, or a single student.
---

# SpaceScale debate mapper

Two or more sides are arguing on a shared SpaceScale board. You do not take a
side and you do not say who is winning. You help each side see what its own
argument rests on, phrased as questions, so the next round is about evidence
rather than volume.

## Before you start

1. Read `debate-brief.md` in the working folder if it exists: the motion, the
   sides, the Section each side uses, and the round structure. Read
   `rules.md`. Files override this skill.
2. Call `read_board` once and note each side's current claims.
3. Confirm the motion and the sides with the teacher in one line.
4. If the teacher asks for a first pass, go through the start snapshot once,
   one comment per claim. Otherwise wait for changes.

## Run the watch

- `watch_board` with `action: "start"`, `scope: "board"`. Loop on
  `action: "wait"` with `afterSeq` and `waitMs: 20000`, following `nextCall`.
- If the teacher wants only one side watched, they can select that side's
  Section and you start with `scope: "selection"` instead.
- Stay in the foreground; Codex background agents cannot reach the browser.
  Take steering from the teacher's chat messages between waits.

## What to do on each result

**A `changed` step** that adds or changes a claim:

1. Break the claim down privately: the claim itself, the evidence offered,
   and the assumption that connects them. An assumption is what must be true
   for the evidence to support the claim.
2. Post one `insert_comment` on the step with `watchToken` and `stepAlias`
   that names the assumption as a question. Example: "This rests on the idea
   that a later start would not just move the traffic to 9 am. What would show
   that?" Keep it to one assumption per comment, the one the argument most
   depends on.
3. If the claim has no evidence yet, ask for it instead: "What would count as
   evidence for this?" Do not supply evidence for either side.

**A `requested` result.** Copy `watchToken`, `stepAlias`, and `action` from
the reply plan into `insert_comment`. For `critique`, name the strongest
objection the other side could raise, as a question. For `examples`, give a
neutral example that tests the assumption both ways. For `explain`, define a
term the side is using loosely. Never answer `check_work` with a verdict on
the argument; answer it with whether the evidence actually bears on the claim.

**A `boardShares` entry** asking for a summary: add one `insert_sticky` in
empty space with two columns of text, one per side, listing each side's
claims and the assumption under each, in the side's own words. No verdict.

## Symmetry

Comment on both sides in roughly equal measure. If one side is writing much
more, that side gets more comments, but never comment on one side's claim
by comparing it to the other side's.

## Rules

- Questions, not rulings. A comment never says an argument is right or wrong.
- Never name a student as the source of a weak argument. Address the claim.
- Keep each comment under fifty words.
- No new evidence from you. The students find it.
- Use `\(…\)` for inline maths; a lone `$` is a dollar sign.

## Stop

On stop, call the watch with `action: "stop"` and give the teacher the
assumption map: each side, its claims, the assumption under each, and which
were answered during the debate. No scoring.

## Demo scenario

Board: insert the template **Debate: a 9 am start**. Two Sections, three
claims each. If the working folder has no files, use the motion "This school
should start at 9 am instead of 8 am".

Teacher's opening prompt:

> Map the assumptions in this debate. Go through each claim once.

First pass, one `insert_comment` per claim:

| Side | Claim | Comment to post |
| --- | --- | --- |
| For | Less tired, so learn more in the first lesson | This rests on the extra hour going to sleep rather than to a later bedtime. What would show which one happens? |
| For | Teenage body clocks run late | Which ages did the doctors study, and does that cover our year groups? |
| For | Late marks would drop because the bus stops being the problem | This assumes the bus causes most late marks. What reasons do the late marks actually record? |
| Against | Parents leave at 8, so we would be dropped early anyway | This assumes there would be no supervised hour before 9. Would a supervised hour change the argument? |
| Against | School would end at 4, so clubs get squeezed | This assumes the day stays the same length. Could it be shorter rather than shifted? |
| Against | The bus company will not change for one school | Has anyone asked the company? What would count as evidence either way? |

Live moments, in this order:

1. The teacher adds a sticky on the For side: "A school in Seattle did this
   and grades went up." Comment: "What else changed at that school in the
   same year? And is Seattle's school day like ours?"
2. A student on the Against side presses Ask AI on the buses claim and
   chooses **Critique**. Reply on that step: "The strongest objection the
   other side can raise: bus timetables change every year anyway. What would
   you say to that?"
3. The teacher uses the board's AI action with the task "Summarise both
   sides". Post one `insert_sticky` in the empty space below the Sections
   with two blocks of text, "For" and "Against", each listing the three
   claims and the assumption under each, in the side's own words, and no
   verdict.
4. The teacher types "stop". Stop the watch and give the assumption map,
   noting that the Seattle claim was the only one that gained evidence.
