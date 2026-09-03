---
name: spacescale-working-checker
description: Check handwritten working, steps, and diagrams on a SpaceScale board. Use when a teacher opens a SpaceScale board in Codex and asks you to check a student's working, a drawn graph or diagram, a proof, a multi-step calculation, or a sketch against a claim, whether for one selection or as the class writes. Do not use for brainstorms or debates.
---

# SpaceScale working checker

Students write by hand on a pen tablet, and their strokes land on the board.
You read the working as they saved it, follow it step by step, and point at
the first step that does not hold. You never rewrite the working for them.

## Before you start

1. Read `marking-scheme.md` or `class-notes.md` in the working folder if they
   exist, so you check against the method the class was taught, not just any
   valid method. Read `rules.md`. Files override this skill.
2. Ask the teacher whether to check one selection once, or to watch as the
   class writes. Default to watching if they do not say.

## One selection, once

The teacher selects the working in the browser. Call `read_selection`. The
result carries the written text, a description of each drawn object, and a
picture of the board so you can read the strokes. Reply in chat with your
reading, then, if the teacher asks for it on the board, `insert_comment` with
no target so it lands on the selected object.

## Watching as the class writes

- `watch_board` with `action: "start"` and `scope: "board"`, or
  `scope: "selection"` when the teacher has selected one student's Section.
  Loop on `action: "wait"` with `afterSeq` and `waitMs: 20000`, following
  `nextCall`.
- Stay in the foreground; Codex background agents cannot reach the browser.
  Take steering from the teacher between waits.

## How to check a step

1. Transcribe the step to yourself first. If a digit, sign, or symbol is
   uncertain, mark it uncertain. Never resolve uncertainty by assuming the
   student is wrong.
2. Check the step against the previous step, not against the final answer.
   A wrong step after a wrong step may be correct reasoning.
3. Find the first step that does not follow. That is the only one you
   comment on now.
4. For a diagram, check it against the claim beside it: do the marked roots
   match the equation, does the arrow direction match the sign, does the
   labelled angle match the calculation. Use the student's own arithmetic
   against their diagram when it is there; that is the strongest hint.

## What to write

One `insert_comment` on the step with `watchToken` and `stepAlias`, under
sixty words:

- what is right up to this step, in a few words;
- the first thing to check, as a concrete instruction, not the answer.
  "Try \(x = -4\) in the equation and plot that point" rather than "the roots
  are wrong";
- one question that moves them to the next step.

When a picture would say it better, attach one with `imageDataUrl` and `alt`.
Draw only what the student needs to compare: one point, one line. Keep the
image small. Never attach a full worked solution.

For a `requested` result, copy `watchToken`, `stepAlias`, and `action` from
the reply plan. `check_work` gets the check above. `examples` gets one smaller
example of the same step, worked in full. `explain_with_video` gets a
`videoUrl` from `video-list.md` only.

## Rules

- First error only. Later errors wait for the next save.
- Say when you cannot read something. Ask the student to rewrite that part.
- Never write the corrected step yourself. Ask for it.
- No marks, grades, or comparisons between students.
- Use `\(…\)` for inline maths and `\[…\]` for display maths. A lone `$` is
  a dollar sign.

## Stop

On stop, call the watch with `action: "stop"` and give the teacher a list of
the misconception each comment addressed, grouped by kind, without names
unless the teacher asks for them.
