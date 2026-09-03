# SpaceScale: multiplayer AI with the teacher at the controls

**One shared canvas, a whole class, and one AI that sees everyone's work at
once. The teacher decides what it knows, what it may do, and when it wakes up.
WebMCP is what makes that possible without a backend, a model key, or an
extension.**

Live demo: [webmcp.spacescale.net](https://webmcp.spacescale.net/) ·
Code: [github.com/shankarram-sq/spacescale](https://github.com/shankarram-sq/spacescale)

---

## The gap

AI is mainstream. Almost all of it is single-player: one person, one chat, one
private answer. A classroom is the opposite of that. Thirty people are working
on the same problem at the same time, at different speeds, with different
misconceptions, and the person who knows them best is standing at the front of
the room.

Multiplayer AI, where one agent watches a shared workspace and responds to each
person inside it, is rare. Multiplayer AI that the *host* controls from their
own device, with their own notes and their own rules, without anyone shipping
a server, is rarer still. That combination is what SpaceScale builds, and it is
what WebMCP uniquely enables.

## What it looks like in a classroom

A teacher assigns five problems. Every student has a Section of the board and
works in it, typing or writing by hand on a smart notepad. The teacher starts a
board watch from Codex with the class notes and a coaching skill loaded.

From then on, without the teacher prompting again:

- A student who finishes early gets a fast-finisher question pinned beside
  their last answer.
- A student stuck on question three gets a hint on that exact step. A hint, not
  the answer, because the teacher's skill says so.
- A student who is struggling across every problem gets a two-minute video
  placed next to their work, chosen from the resources the teacher provided.

Each of these lands as an ordinary canvas object, marked as AI-written,
attributed to the teacher, visible to whoever should see it, and undoable in one
click. The teacher never left the board.

Two more scenes, same machinery, different skill:

- **Brainstorm.** Six students each list problems near the school. The agent
  notices that three of them chose traffic at the gate and leaves a comment
  connecting them, so the groups form themselves.
- **Debate.** Two sides argue. The agent comments on each side's Section with
  the assumption their argument rests on, phrased as a question, so the next
  round is about evidence rather than volume.

## Three things only WebMCP makes possible here

### 1. Two-way WebMCP: the page can invoke the agent

WebMCP lets an agent call tools on a web page. SpaceScale also runs it the
other way. While a watch is live, the board grows an **Ask AI** button in its
selection toolbar and an **AI** action in the tool rail. A student selects
their step and picks *Explain*, *Critique*, *Check my work*, *Examples*, or
*Explain with a video*. The teacher can hand the whole board over with a task.

That request travels back to Codex on the watch's next long poll, together
with the step's content and a reply plan naming the exact tool call to answer
with. The agent replies as a comment on that step. The website is no longer
just a target of tool calls. It is a participant that can ask.

Today this rides on bounded 20-second long polls, which is enough to feel live
in a classroom. When WebMCP gains a push or subscription mechanism, the same
tools drop straight onto it.

### 2. Collaboration on the site, knowledge on the client

SpaceScale ships with no model key and no AI backend. Everything the agent
knows about *this* class comes from the teacher's own machine: Codex, a skill
file that encodes the pedagogy, and local documents such as the class notes,
the marking scheme, or the video list.

The site does what only the site can do: hold the live state, show who wrote
what, render handwriting to an image, collect a vote, and put the agent's
answer in front of the right person in real time. The client does what only
the teacher can do: decide the mode, the rules, and the background material.

This split is the personalisation story. A skill is a text file. Two teachers
in the same school can run the same board with different coaching styles. A
department can share one skill and edit it on a Friday afternoon. Nothing
deploys.

### 3. Handwriting and diagrams, not just text

In our classrooms students write on Huion smart notepads, and the strokes land
on the board as ordinary pencil paths. Whenever a watched board holds drawn
work, every watch result carries a PNG of the board as it stands, so the agent
reads the handwriting and the diagram rather than a description of them.

The demo board shows a hand-drawn parabola with the roots marked in the wrong
place. The agent sees the sketch, notices that the student's own arithmetic
already contradicts the claim, and asks them to plot one point before fixing
the curve. That is feedback on visual work, on the canvas where it was drawn.

## Why this is new

Each piece exists somewhere. A tutor bot can give hints. A chat can summarise a
brainstorm. A vision model can read a graph. What did not exist is all of it
running at once, in real time, on a shared space, personal to one teacher's
notes and rules, with the agent holding exactly that teacher's permissions and
nothing more.

WebMCP is the reason it fits together. The most valuable context in a lesson
is not in any database. It is the live page: who is on which step, what they
just saved, what they selected, how the class voted. WebMCP hands that context
to the agent directly, and hands the agent's answer back to the page, without
DOM scraping, a browser extension, or a second server.

## Built for education, open to any room

The seven tools are deliberately generic. A watch, a vote reader, a template
reader, and four writes: comment, sticky note, image, video. Nothing in the
protocol knows what a lesson is. The education behaviour lives in the skill.

Swap the skill and the same board becomes:

- a marketing war room where the agent connects campaign ideas that target the
  same audience and flags the assumption under each one;
- a project retrospective where it groups sticky notes by root cause and drops
  a follow-up question on each cluster;
- a design critique where it reads the sketches and comments on the flow.

## Safe by construction

- The agent has no identity of its own. Every write runs as the participant
  who started the watch, through the same commit path as their own edits, and
  the Cloudflare Worker revalidates role, ownership, and locks before saving.
- A viewer's agent is read-only. An editor's agent can add work but cannot
  rewrite another student's.
- Every AI contribution carries a visible AI mark and provenance metadata, and
  undoes in one step.
- The watch never sees unsaved keystrokes, stable IDs, presence, or history,
  and expires after fifteen minutes.

## Try it in three minutes

1. Open the demo in a WebMCP-capable host and insert the **Problem set: six
   students** template.
2. Ask the host to start `watch_board`. Edit one student's answer, then press
   **Ask AI** on a step and choose *Check my work*.
3. Watch the reply arrive as a comment on that step, marked as AI, attributed
   to you, and one undo away from gone.

## What comes next

- Replace long polling with a push channel the moment WebMCP offers one.
- Ship a starter library of skills: problem set coach, brainstorm connector,
  debate mapper, with a plain-language editing guide for teachers.
- Pilot in our own StayQrious classrooms with the safety and data-governance
  gate already documented in the repo.
