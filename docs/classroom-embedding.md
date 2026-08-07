# Classroom embedding

The classroom integration lets a trusted backend create short-lived, signed
URLs for a shared board. Opening one of those URLs in an iframe creates or
joins the board immediately—there is no invitation or Turnstile step.

## Configuration

Configure two values for each environment:

- `CLASSROOM_INTEGRATION_KEY` is one secret shared only by the classroom
  backend and the Worker. Generate at least 32 random bytes, keep it stable,
  and install the same literal value on both sides. Rotating it changes the
  derived classroom board and participant IDs.
- `ALLOWED_ORIGINS` is a comma-separated allowlist of exact HTTPS origins
  permitted to frame `/embed`, for example
  `https://classroom.example.edu,https://teacher.example.edu`. Paths and
  wildcard patterns are rejected. When it is absent, blank, or invalid,
  embedding is denied. A literal `*` explicitly permits every parent origin.

Install the secret without placing it in `wrangler.jsonc`:

```sh
npx wrangler secret put CLASSROOM_INTEGRATION_KEY
npx wrangler secret put CLASSROOM_INTEGRATION_KEY --env staging
```

Normal `/` and `/b/...` pages always send `frame-ancestors 'none'`; only
`/embed` and `/embed/b/...` use the configured parent allowlist.

## Launch token

The launch token is:

```text
cl1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, "cl1." + payloadPart))>
```

The JSON object must contain exactly these fields:

| Field | Meaning |
| --- | --- |
| `v` | Integer `1`. |
| `aud` | Worker hostname only, such as `spacescale.net`. |
| `board_name` | Stable classroom/activity key, 1–120 Unicode characters. The same normalized value resolves to the same board. |
| `role` | `owner`, `editor`, or `viewer`. |
| `display_name` | Participant name shown to collaborators, 1–40 characters. |
| `user_identifier` | Stable backend identifier, up to 320 characters. An opaque database ID is preferable to an email address. |
| `iat` | Issued-at time in Unix seconds. |
| `exp` | Expiry in Unix seconds, after `iat` and no more than 24 hours later. |

If your parent backend calls these values `name` and `email_id`, translate them
before signing rather than adding new launch claims:

```js
{
  display_name: participant.name,
  user_identifier: participant.databaseId ?? stableHmacPseudonym(participant.canonicalEmail),
}
```

Prefer an opaque, stable database ID. If email is the only stable identifier,
use a stable HMAC pseudonym produced with a backend-only key and keep that key
stable; rotating it creates a different board actor. Do not put the email in
`display_name` or send it as an additional signed field.

The verifier permits five minutes of clock skew. Treat each launch URL as a
credential, create one per participant, and do not put it in application logs.
The browser removes it from the address bar before exchanging it.
The payload is base64url-encoded for transport, not encrypted. Anyone who can
read the iframe URL can decode its claims, which is why `user_identifier`
should not contain a raw email when an opaque identifier or pseudonym is
available.

This Node.js example uses the secret as its literal UTF-8 value, matching the
Worker:

```js
import { createHmac } from "node:crypto";

function signClassroomLaunch(payload, secret) {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signed = `cl1.${payloadPart}`;
  const signature = createHmac("sha256", secret).update(signed, "utf8").digest("base64url");
  return `${signed}.${signature}`;
}

const now = Math.floor(Date.now() / 1000);
const token = signClassroomLaunch(
  {
    v: 1,
    aud: "spacescale.net",
    board_name: "class-7b:fractions:2026-08-05",
    role: "editor",
    display_name: "Asha",
    user_identifier: "student_1842",
    iat: now,
    exp: now + 60 * 60,
  },
  process.env.CLASSROOM_INTEGRATION_KEY,
);

const iframeUrl = `https://spacescale.net/embed#launch=${encodeURIComponent(token)}`;
```

Use the same `board_name` for the coach and every student. Give each person a
distinct `user_identifier`. Multiple participants may be launched as `owner`.

## Embed

Render the participant-specific URL directly:

```html
<iframe
  src="https://spacescale.net/embed#launch=PARTICIPANT_TOKEN"
  title="Class whiteboard"
  referrerpolicy="no-referrer"
  sandbox="allow-scripts allow-same-origin allow-downloads allow-modals"
  allow="clipboard-write"
></iframe>
```

The exchange returns a short-lived session scoped to that one board. HTTP uses
an `Authorization: Bearer ...` header, and WebSocket authentication uses a
subprotocol rather than a URL parameter. The launch token is never persisted.
The bearer is retained in memory and in that iframe's frame-local session
history so sibling participant frames cannot overwrite it; neither credential
is stored in `localStorage` or `sessionStorage`.

## Initialize a new board from canonical JSON

An owner launch can carry one canonical **JSON export** in the URL fragment:

```js
import { readFile } from "node:fs/promises";

const canonicalJson = await readFile("fractions-board.json", "utf8");
const encodedImport = Buffer.from(canonicalJson, "utf8").toString("base64url");
const coachUrl =
  `https://spacescale.net/embed#launch=${encodeURIComponent(ownerToken)}` +
  `&import=${encodedImport}`;
```

Use the file downloaded from the normal **JSON** export, whose format is
`cf-whiteboard-json`. The classroom-data/attributed export is an analytics
view and is deliberately not an import format.

The import has first-creation semantics:

- open the coach's owner URL before any student URL;
- an owner import initializes a board only when that `board_name` has never
  been created;
- once the board exists, every import fragment is ignored and the current
  authoritative state continues unchanged;
- editor/viewer launches cannot seed a board;
- object IDs, creator IDs, text, design, geometry, and paint order are
  preserved, while the destination board rebases its sequence/version
  baseline;
- the decoded JSON is limited to 1 MiB and 1,000 objects;
- image cards are rejected because canonical JSON does not contain their
  private asset bytes.

Like the launch credential, the browser removes the import data from its
visible URL before the session exchange. A fragment can still be exposed in
LMS logs, browser history synchronization, screenshots, or copied URLs, so do
not place sensitive content in an import link.

## Live classroom control

Every owner can open **Access** and change any non-primary participant between
viewer, editor, and owner. Changes apply to existing connections immediately.

Editors may create new objects and copy another participant's object, but they
may update or delete only objects whose `createdBy` actor ID is their own. This
single rule covers text edits, table cells, movement, resizing, colours,
design changes, and deletion. Owners and co-owners may update any object.
Authorization is enforced by the BoardRoom even if a participant bypasses the
browser controls.

- **Students can edit** (`editors_enabled`) lets editors and owners draw.
- **Lock students** (`owner_only`) leaves every owner able to draw and makes
  editors/viewers read-only.
- **Lock everyone** (`locked`) prevents content changes by everyone, including
  owners, until an owner changes the policy.

The first owner becomes the primary recovery custodian. Co-owners have the same
live classroom controls. Only primary-custody recovery/transfer is special;
transferring custody does not remove other owners.

Classroom boards do not issue a separate end-user recovery URL on first launch:
the trusted backend can always issue another signed owner launch. If a separate
recovery capability is wanted, the primary owner can explicitly rotate one in
the Access panel and store the resulting one-time URL.

A launch link supplies an initial role. A coach's newer live role change or
revocation takes precedence when an older link is reopened. To intentionally
replace that decision from the backend, issue a token with a strictly newer
`iat` value.

## Attribution and classroom data export

The Worker derives an opaque actor ID from `user_identifier`; the raw identifier
is not stored in the board database or broadcast to other participants. Every
accepted action records that actor ID, the display name at acceptance, the
action kind, affected item IDs, and acceptance time. Owners can page through
the durable activity feed:

```http
GET /api/v1/boards/<board-id>/activity?afterSeq=0&limit=100
Authorization: Bearer <owner-board-session>
```

Use the owner launch session from your trusted integration when retrieving the
feed. Its response is metadata-only; it does not repeat text or drawing
payloads. The activity feed is useful for an audit timeline, but an
`item.update` may be a move, resize, colour change, or content change, so the
latest activity actor is not necessarily the author of an object's current
text.

Every owner, including a classroom co-owner, can download **Classroom data
JSON** from the board's export menu. Trusted backends can fetch the same current,
authoritative data for any board for which they hold an owner session:

```http
GET /api/v1/boards/<board-id>/export.attributed.json
Authorization: Bearer <owner-board-session>
Accept: application/json
```

The endpoint is owner-only. Viewer and editor sessions cannot use it. Responses
use `Cache-Control: no-store`, identify the captured board sequence in
`X-Whiteboard-Seq`, and use this normalized shape:

```json
{
  "format": "cf-whiteboard-attributed-json",
  "version": 1,
  "board": {
    "id": "b_1234567890123456789012",
    "title": "Fractions exit ticket",
    "seq": 42,
    "stateCreatedAt": 1786118400000
  },
  "participants": [
    {
      "id": "a_1234567890123456789012",
      "displayName": "Asha Patel",
      "role": "editor",
      "status": "active"
    }
  ],
  "objects": [
    {
      "item": {
        "id": "018f0000-0000-7000-8000-000000000101",
        "kind": "sticky"
      },
      "attribution": {
        "createdBy": {
          "id": "a_2345678901234567890123",
          "displayName": "Coach Mira"
        },
        "lastModifiedBy": {
          "id": "a_1234567890123456789012",
          "displayName": "Asha Patel"
        },
        "updatedSeq": 42,
        "updatedAt": 1786118400000
      },
      "content": [
        {
          "kind": "sticky_text",
          "text": "Why does dividing by a fraction make the answer larger?",
          "responsibleUser": {
            "id": "a_1234567890123456789012",
            "displayName": "Asha Patel"
          },
          "lastChangedBy": {
            "id": "a_1234567890123456789012",
            "displayName": "Asha Patel"
          },
          "updatedSeq": 42,
          "updatedAt": 1786118400000
        }
      ]
    }
  ]
}
```

Each object contains its complete canonical `item`; the shortened item above is
only to keep the example readable. `createdBy` is the participant who created
the board object. `lastModifiedBy` is the last modifier recorded by the object's
current provenance state, including a non-content modification; its `updatedSeq`
and `updatedAt` describe that modification. It is not necessarily the actor who
performed a later undo or recovery restore. Each sibling entry in `content[]`
extracts a current text-bearing value and reports the participant responsible
for that current value. Its `lastChangedBy` may instead identify the participant
who cleared it. Plain text, sticky-note text, zone labels, image descriptions,
and table cells use `kind: "text"`, `"sticky_text"`, `"zone_title"`,
`"image_alt"`, and `"table_cell"`, respectively. A table has one entry per
cell with zero-based `row` and `column`. Empty table cells are included with
`text: ""` and `responsibleUser: null`, which makes roster comparisons
possible.

Participant `role` is `owner`, `editor`, or `viewer`; it is `null` only for a
`referenced` actor without a membership row. `status` is `active` for a current
member, `revoked` for a removed member, or `referenced` when an object refers to
an actor for whom no membership row remains. Actor IDs are stable opaque
identifiers while the integration key and normalized user identifier remain
stable; display names are the human-readable names known to the board. Sequence
fields identify authoritative board actions, and every `*At` timestamp is Unix
time in milliseconds.

This is current-state attribution, not a transcript of every prior text value.
Undo, redo, and recovery restore the object and content provenance associated
with the state that becomes current. The activity feed separately records the
participant who performed that history or restore action. Moving or recolouring
an object changes its object-level modifier without changing its content author.
A template may have been created by the coach while its current text was
supplied by a student, which is why `createdBy`, `lastModifiedBy`, and
`responsibleUser` must not be treated as synonyms.

### Backend authentication and actor mapping

To call the API, create a fresh signed launch with `role: "owner"` for a trusted
backend identity, exchange it at `POST /api/v1/embed/session`, then use the
returned `sessionToken` as the bearer above. The exchange request must send an
`Origin` equal to the Worker's own origin. The bearer is short-lived and scoped
to the one derived board, so repeat the exchange for another `board_name` rather
than reusing a session across boards.

The following backend helper uses `signClassroomLaunch` from the earlier example
and returns the parsed attributed export:

```js
async function fetchClassroomData({ workerOrigin, boardName, integrationKey }) {
  const now = Math.floor(Date.now() / 1000);
  const audience = new URL(workerOrigin).hostname;
  const launchToken = signClassroomLaunch(
    {
      v: 1,
      aud: audience,
      board_name: boardName,
      role: "owner",
      display_name: "Classroom export service",
      user_identifier: "classroom-export-service",
      iat: now,
      exp: now + 5 * 60,
    },
    integrationKey,
  );

  const exchange = await fetch(`${workerOrigin}/api/v1/embed/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: workerOrigin,
    },
    body: JSON.stringify({ token: launchToken }),
  });
  if (!exchange.ok) throw new Error(`Session exchange failed: ${exchange.status}`);
  const { board, sessionToken } = await exchange.json();

  const response = await fetch(
    `${workerOrigin}/api/v1/boards/${encodeURIComponent(board.id)}/export.attributed.json`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
    },
  );
  if (!response.ok) throw new Error(`Classroom export failed: ${response.status}`);
  return response.json();
}

const workerOrigin = "https://spacescale.net";
const integrationKey = process.env.CLASSROOM_INTEGRATION_KEY;
if (!integrationKey) throw new Error("CLASSROOM_INTEGRATION_KEY is required");
const classroomData = await fetchClassroomData({
  workerOrigin,
  boardName: "class-7b:fractions:2026-08-05",
  integrationKey,
});
```

The export deliberately omits `user_identifier` and raw email. Save the `actor.id`
returned by each participant's launch exchange beside that participant in your
backend, or derive the same opaque actor ID when joining export results to your
roster. The derivation normalizes `user_identifier` with NFC and trims it, then
computes HMAC-SHA256 with the literal `CLASSROOM_INTEGRATION_KEY` over
`classroom-actor:v1`, a zero byte, and the normalized identifier. Take the first
16 digest bytes, encode them as unpadded base64url, and prefix `a_`:

```js
import { createHmac } from "node:crypto";

function classroomActorId(userIdentifier, integrationKey) {
  const normalized = userIdentifier.normalize("NFC").trim();
  const digest = createHmac("sha256", integrationKey)
    .update(`classroom-actor:v1\0${normalized}`, "utf8")
    .digest();
  return `a_${digest.subarray(0, 16).toString("base64url")}`;
}
```

Keep that mapping and the integration key in the trusted backend. Do not expose
either to browser code or add raw emails to the exported file.

### Interpreting classroom questions

The normalized content entries support questions such as "Which student wrote
which current question?" by filtering non-empty text-bearing entries and
grouping them by `responsibleUser.id`. They can also identify who contributed
non-empty cells to a shared table and which cells remain empty.

The board does not currently store an explicit assignee or peer-feedback
recipient. Consequently, the export cannot infer who a comment was intended for
from its position, and it cannot by itself prove that a particular table belongs
to a particular student. For questions such as "What feedback did one child give
another?" or "Who did not complete their table?", use a classroom convention
that your backend already knows—for example, one board or table item ID per
student—and join the export to that assignment and your expected roster. Without
that convention, the honest conclusions are "who authored this current text",
"who contributed to this shared table", and "which cells are empty".

These executable helpers make the required classroom conventions explicit. The
first expects the backend to identify the response objects or table cells used
for questions:

```js
function currentQuestionsByStudent(data, isQuestionEntry) {
  const grouped = new Map();

  for (const { item, content } of data.objects) {
    for (const entry of content) {
      if (!isQuestionEntry(item, entry)) continue;
      const text = entry.text.trim();
      if (!text || !entry.responsibleUser) continue;
      const actor = entry.responsibleUser;
      const existing = grouped.get(actor.id) ?? {
        participant: actor,
        questions: [],
      };
      existing.questions.push({ itemId: item.id, kind: entry.kind, text });
      grouped.set(actor.id, existing);
    }
  }

  return [...grouped.values()];
}

const questionTableId = "018f0000-0000-7000-8000-000000000101";
const questions = currentQuestionsByStudent(
  classroomData,
  (item, entry) =>
    item.id === questionTableId &&
    entry.kind === "table_cell" &&
    entry.column === 1 &&
    entry.row > 0,
);
```

For peer feedback, store the intended recipient for each feedback object in the
parent backend. The export supplies the author; the backend mapping supplies the
recipient:

```js
function currentPeerFeedback(data, recipientByItemId) {
  const rows = [];
  for (const { item, content } of data.objects) {
    const recipient = recipientByItemId.get(item.id);
    if (!recipient) continue;
    for (const entry of content) {
      const text = entry.text.trim();
      if (!text || !entry.responsibleUser) continue;
      rows.push({
        itemId: item.id,
        from: entry.responsibleUser,
        to: recipient,
        text,
      });
    }
  }
  return rows;
}

const recipientByItemId = new Map([
  [
    "018f0000-0000-7000-8000-000000000201",
    {
      id: classroomActorId("student-42", integrationKey),
      displayName: "Asha Patel",
    },
  ],
]);
const feedback = currentPeerFeedback(classroomData, recipientByItemId);
```

For completion, store one table-item assignment per expected student. The
following considers every non-header cell required and reports a student as
incomplete when their table is missing, has no required cells, or contains an
empty required cell:

```js
function studentsWithIncompleteTables(data, expectedStudents, tableIdByActorId) {
  const objectsById = new Map(data.objects.map((object) => [object.item.id, object]));

  return expectedStudents.filter((student) => {
    const tableId = tableIdByActorId.get(student.id);
    const table = tableId ? objectsById.get(tableId) : undefined;
    if (!table || table.item.kind !== "table") return true;

    const requiredCells = table.content.filter(
      (entry) =>
        entry.kind === "table_cell" &&
        !(table.item.geometry.headerRow === true && entry.row === 0),
    );
    return requiredCells.length === 0 || requiredCells.some((entry) => !entry.text.trim());
  });
}

const expectedStudents = [
  {
    id: classroomActorId("student-42", integrationKey),
    displayName: "Asha Patel",
  },
];
const tableIdByActorId = new Map([
  [expectedStudents[0].id, "018f0000-0000-7000-8000-000000000301"],
]);
const incomplete = studentsWithIncompleteTables(
  classroomData,
  expectedStudents,
  tableIdByActorId,
);
```

The canonical `/export.json` remains the board recovery representation. Use the
attributed export for classroom analysis. If a historical content-version archive
is required, copy the paginated activity feed and periodic attributed exports
into the school's approved audit store with an appropriate retention policy.
