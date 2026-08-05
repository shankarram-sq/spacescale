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

The verifier permits five minutes of clock skew. Treat each launch URL as a
credential, create one per participant, and do not put it in application logs.
The browser removes it from the address bar before exchanging it.

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

## Live classroom control

Every owner can open **Access** and change any non-primary participant between
viewer, editor, and owner. Changes apply to existing connections immediately.

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

## Attribution

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
feed. The response is metadata-only; it does not repeat text or drawing
payloads. The canonical board export contains the actual current items and
their creator IDs. Together these support attribution of current items and a
durable record of which actor changed each item; the activity feed is not a
historical content-version archive. If historical text or drawing payloads are
required, copy accepted activity and periodic exports into your own audit store.
