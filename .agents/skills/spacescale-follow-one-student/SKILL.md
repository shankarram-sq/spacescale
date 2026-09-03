---
name: spacescale-follow-one-student
description: Follow one named student's work on a SpaceScale board with close coaching. Use when a teacher opens a SpaceScale board in Codex and asks you to follow, watch, or focus on one student or a small named group, for example a student who is struggling or needs extra support. Do not use for whole-class watching; the problem-set coach covers that.
---

# SpaceScale: follow one student

The teacher has asked you to give one student, or a small named group, closer
attention than the whole-class watch allows. This is the one place a watch
points at a person rather than a region, so it follows tighter rules.

## Before you start

1. Read `class-notes.md`, `video-list.md`, and `rules.md` in the working
   folder if they exist. If the teacher has a `support-notes.md` for this
   student (the approach they want, what has worked), read it and follow it.
   Files override this skill.
2. Call `list_users` to get the participant IDs the user tools take. It lists
   people with saved work, by display name, with how many objects they have.
   Those counts say how much work exists, never how well anyone is doing.
3. Match the teacher's name for the student to a display name. If two names
   could match, ask; do not guess.
4. Tell the teacher which student you will follow and start only when they
   confirm. This is teacher-initiated, visible on the board, and expires.

## Run the watch

- `watch_users` with `action: "start"` and `participantIds` for the student.
  Loop on `action: "wait"` with the `watchToken`, `afterSeq`, and
  `waitMs: 20000`, following `nextCall`.
- The watch follows that student's work wherever it sits on the board,
  including what they save while it runs. A change to their object by
  someone else is reported without naming the other person.
- To read once without watching, call `read_user` with the same IDs.
- Stay in the foreground; Codex background agents cannot reach the browser.
  Take steering from the teacher between waits.

## How to coach

Reply on the student's own work with `insert_comment` using `watchToken` and
`stepAlias`. Pace yourself: one comment per meaningful step, and let a
student sit with a hint before adding another. A student under close watch
should feel supported, not chased.

- Start every comment with what is right. Then one thing to check. Then one
  question.
- Break the next step smaller than you would for the class. If the class
  hint is "check the sign", the hint here is "what is \(-3 \times -1\)?"
- When the student is stuck across two saves in a row, switch mode: give a
  smaller worked example of the same step, then ask them to try theirs.
- When they are stuck across three, attach a video from `video-list.md` with
  `videoUrl` and tell the teacher in chat that this student may need them in
  person.
- When a `requested` result arrives, answer the action the student chose,
  copying `watchToken`, `stepAlias`, and `action` from the reply plan.

## Handwriting

Drawn work arrives with a description and a picture of the board. Read the
strokes. Say when you cannot read something and ask for a rewrite of that
part only.

## Rules

- Never grade, rank, profile, or compare this student to anyone, in comments
  or in chat. The teacher asked you to help, not to assess.
- Never say in a comment that the student is being followed more closely.
- Never report what other students are doing. This watch does not show them.
- Comments under fifty words. Hints, not answers.
- Use `\(…\)` for inline maths; a lone `$` is a dollar sign.

## Stop

Stop when the teacher says so or when the watch expires, with
`action: "stop"`. Give the teacher three lines: where the student started,
where they got to, and the one thing to pick up next time. No scores.
