# WebMCP Challenge demo runbook

This recording script is designed for a public YouTube demo under three
minutes. Lead with a concrete AI intervention on visual student work, then prove
that the same tool remains permission-bound and collaborative.

## Before recording

1. Open [webmcp.spacescale.net](https://webmcp.spacescale.net/) in ChatGPT's
   in-app browser or another compatible WebMCP host.
2. Create a Space named **AI feedback on a quadratic**. Keep a second browser
   session open as a viewer.
3. Add `x² + 7x + 10 = 0`, a hand-drawn graph that incorrectly marks roots at
   `-3` and `-1`, and a sticky saying “I think the roots are x = -3 and x = -1.”
4. Add one relevant public YouTube or Vimeo lesson video with **Video**. Keep it
   paused beside the work.
5. Hide notifications, close unrelated tabs, set browser zoom to 100%, test the
   microphone, and rehearse once. Use only synthetic student work.

## Three-minute story

### 0:00–0:20 — one shared AI workspace

Show the equation, mistaken graph, sticky, video card, and two participant
avatars. Say:

> Most classroom AI disappears into private chats. SpaceScale gives people and
> AI one visual workspace, so feedback becomes visible work the class can
> inspect, discuss, and improve together.

Point out **WebMCP enabled**. There is no extension, separate MCP server, or
SpaceScale model API key.

### 0:20–1:18 — AI catches a mistake in visual work

Select the equation and hand-drawn graph. Ask:

> Inspect this selected visual and check whether the plotted curve is consistent
> with the equation. Explain the first concrete issue without solving everything
> for the student.

Let the agent reason about the drawing. Then select the student's claim sticky
and ask:

> Read this selected claim. Use a Counterexample Challenge to add AI feedback
> that checks x = -4 and asks the student to plot the resulting point before
> correcting the curve.

Show the new source-linked card:

- heading: **AI feedback · Check x = -4**;
- calculation: `16 - 28 + 10 = -2`;
- prompt: **Can you plot (-4, -2) and use it to correct the curve?**

Say:

> The AI did not just answer in chat. Its feedback is a WebMCP-generated canvas
> object with AI provenance, a visible link to the student's claim, realtime
> synchronization, and one-step undo.

### 1:18–1:58 — the AI cannot outrank its author

Switch to the viewer session and attempt the same write. Show that it cannot
commit. Say:

> The agent has exactly the permissions of the person who invited it. There is
> no privileged bot identity. A viewer's agent stays read-only; an editor's
> agent can create feedback but cannot rewrite another person's work. The Worker
> checks role, actor, ownership, locks, and the complete batch before saving.

Switch back and undo, then redo or rerun the feedback if useful.

### 1:58–2:33 — feedback lives with the lesson

Pan to the YouTube or Vimeo card and the work around it. Move the video once and
show the second session update. Say:

> Learning is visual and multimedia. Lesson video, handwriting, formulas,
> comments, student claims, and AI feedback stay on one durable shared canvas
> instead of being split across tools and transcripts.

### 2:33–2:58 — close

Show the mistaken plot, the AI correction card, and both synchronized sessions.
End with:

> SpaceScale gives AI a visible seat at the table—not the teacher's chair. Every
> contribution is source-linked, permission-bound, attributable, and
> reversible.

End on the product name and public URL.

## Recovery prompts

If the host does not choose the tools automatically:

- Visual reasoning: “Call `inspect_selected_board_visual` on my current
  selection and check the graph against the equation.”
- Correction card: “Call `read_selected_class_ideas`, then call
  `add_collective_reasoning` in `counterexample_challenge` mode. Include a
  claim card and a counterexample card checking `x = -4`, connected with the
  label `checks`.”
- Capability discovery: “Call `list_class_collaboration_modes` and find the
  smallest reasoning mode for correcting a visual misconception.”

If a write fails unexpectedly, confirm that the participant has edit access,
the sticky finished saving, and the selection token came from the same browser
session.

## Optional second story

For group decisions, use the **Collective inquiry demo** template. Read selected
ideas, stage and approve an inquiry map, let participants vote with stamps, read
the aggregate vote, and stage a decision that preserves one minority concern.
This shows how human response changes the agent's next contribution.

For live problem coaching, select the exact saved items containing a student's
steps and ask the host to call `watch_board`. It follows
server-acknowledged changes for up to 15 minutes and prompts the agent to respond
after each saved step.

## Final recording checklist

- Public or unlisted YouTube video, under three minutes, with clear spoken audio.
- Public URL visible at least once.
- A visible WebMCP visual read and permission-bound write.
- The student's incorrect `-3`/`-1` claim is readable.
- The generated card visibly checks `x = -4` and asks for `(-4, -2)`.
- The feedback card is source-linked, synchronized, and undoable.
- The viewer write is visibly refused.
- The lesson video is visible as a shared canvas object.
- No invitation token, recovery link, email, key, or real student content is
  shown.
