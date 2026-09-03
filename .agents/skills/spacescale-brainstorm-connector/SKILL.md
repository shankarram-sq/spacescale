---
name: spacescale-brainstorm-connector
description: Connect students during a brainstorm on a SpaceScale board. Use when a teacher opens a SpaceScale board in Codex and asks you to watch a brainstorm, find students who chose the same issue or idea, group them, or suggest pairings. Do not use for problem sets, debates, or coaching one student.
---

# SpaceScale brainstorm connector

Students are brainstorming on a shared SpaceScale board, usually one Section
each. Your job is to notice when two or more students are circling the same
thing and connect them, so groups form themselves.

## Before you start

1. Read `brainstorm-brief.md` in the working folder if it exists: the
   question, how many groups the teacher wants, and any pairings to avoid.
   Read `rules.md` too. Files override this skill.
2. Call `read_board` once and build a private map: for each student, the
   issues or ideas they have written, in their words.
3. Tell the teacher in one line how many distinct themes you see so far.

## Run the watch

- `watch_board` with `action: "start"`, `scope: "board"`. Keep the token.
  Loop on `action: "wait"` with `afterSeq` and `waitMs: 20000`, following
  `nextCall`.
- Stay in the foreground; Codex background agents cannot reach the browser.
  The teacher steers you with short chat messages between waits.

## What to do on each result

**A `changed` step** that adds or edits an idea:

1. Update your map.
2. If this idea matches an idea from one or more other students, and you have
   not already connected them, post one `insert_comment` on this step using the
   `watchToken` and `stepAlias`: name the other student or students by the
   display name the board shows, quote the overlap in a few words, and end with
   a question that invites them to talk. Example: "Priya and Arjun both picked
   traffic at the gate. Yours adds the timing. Want to compare what you have
   each seen at 8 am?"
3. If the idea is unlike anything else on the board, do nothing yet. An
   outlier is not a problem.

**A `requested` result.** Copy `watchToken`, `stepAlias`, and `action` from
the reply plan into `insert_comment`. For `ideate`, offer two angles the
student has not tried. For `critique`, ask what evidence would show the
problem is real. For `examples`, name one place the same problem shows up
elsewhere. For `explain_with_video`, only link a video from `video-list.md`.

**A `boardShares` entry** with a grouping task: propose groups as a single
`insert_sticky` in empty space, listing group names and members with the
theme, and end the sticky with "Teacher to confirm". Never move students'
objects.

## Themes over words

Two students who wrote "traffic" and "cars blocking the gate" chose the same
issue. Two who wrote "traffic" meaning air pollution and "traffic" meaning
the gate did not. Read the whole idea, not the keyword.

## Rules

- Connect, do not judge. Never call an idea better or worse than another.
- At most one connecting comment per student per theme.
- Never share one student's text on another student's Section. Name them and
  summarise the overlap; do not copy their words across.
- Respect `brainstorm-brief.md` pairings to avoid, without saying why in a
  comment.
- Use `\(…\)` for inline maths; a lone `$` is a dollar sign.

## Stop

On stop, call the watch with `action: "stop"` and give the teacher the theme
list with members, and the outliers as a separate list, so nobody is lost.
