# Organisation and Space embedding

SpaceScale lets a trusted backend create a signed URL that opens one shared
Space directly inside an iframe. The browser receives a short-lived signed
launch credential; it never receives the Organisation's HMAC key.

The neutral hierarchy is:

- **Organisation**: the tenant and security boundary. Each Organisation owns
  independent identity-derivation and launch-signing keys plus its templates.
- **Space**: one persistent collaborative whiteboard. Reusing the same
  `organisation_id` and `space_id` always reopens the existing state.
- **Participant**: one person or service within an Organisation. Reusing the
  same `participant_id` preserves attribution across that Organisation's
  Spaces.

Multiple owners are supported. Owners can promote or demote participants,
revoke access, lock the entire Space, or allow selected editors while everyone
else remains a viewer. Editors may modify only objects they created; owners may
modify any object.

## Organisation key registry

Install one encrypted Worker secret named `ORGANISATION_SIGNING_KEYS`. Its JSON
object is keyed by the exact normalised `organisation_id`:

```json
{
  "acme": {
    "derivation_key": "stable-secret-with-at-least-32-bytes",
    "current": {
      "kid": "2026-08",
      "key": "current-signing-secret-with-at-least-32-bytes"
    },
    "previous": []
  }
}
```

Generate the derivation and signing values independently:

```sh
openssl rand -base64 32
openssl rand -base64 32
npx wrangler secret put ORGANISATION_SIGNING_KEYS
npx wrangler secret put ORGANISATION_SIGNING_KEYS --env staging
```

The trusted backend for one Organisation needs only its current `kid` and
signing `key`. Do not give it the derivation key or another Organisation's
entry. The derivation key is Worker-only and must remain stable because it
determines opaque Organisation, Space, Participant, custodian, and recovery
identities.

To rotate launch signing, move the old `current` entry into `previous`, install
a new current key with a new `kid`, and update the parent backend. Remove the
old entry after its issued URLs have expired. Rotation does not change the
Space or Participant identities.

## Signed launch claims

The credential is `el1.<base64url-payload>.<base64url-signature>`. The signature
is HMAC-SHA256 over the literal `el1.<base64url-payload>` using the selected
Organisation signing key. The JSON payload has exactly these fields:

| Claim | Meaning |
| --- | --- |
| `v` | Integer `1`. |
| `aud` | SpaceScale hostname only, such as `spacescale.net`. |
| `organisation_id` | Stable Organisation identifier, 1–120 Unicode characters. It must match a registry key after NFC normalisation and trimming. |
| `space_id` | Stable Space identifier and initial display title, 1–120 Unicode characters. |
| `kid` | Signing-key identifier from the Organisation registry. |
| `role` | `owner`, `editor`, or `viewer`. |
| `display_name` | Human-readable participant name shown on the board. |
| `participant_id` | Stable email address or application identifier, up to 320 Unicode characters. It is never returned to the browser or export. |
| `iat` | Issued-at Unix time in seconds. |
| `exp` | Expiry Unix time in seconds, later than `iat` and no more than 24 hours after it. |

This Node.js helper creates a URL without exposing the signing key:

```js
import { createHmac } from "node:crypto";

const base64url = (value) => Buffer.from(value).toString("base64url");

export function createSpaceUrl({
  origin,
  organisationId,
  spaceId,
  kid,
  signingKey,
  role,
  displayName,
  participantId,
  expiresInSeconds = 60 * 60,
  initialExport,
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    aud: new URL(origin).hostname,
    organisation_id: organisationId,
    space_id: spaceId,
    kid,
    role,
    display_name: displayName,
    participant_id: participantId,
    iat: now,
    exp: now + expiresInSeconds,
  };
  const encoded = base64url(JSON.stringify(payload));
  const signed = `el1.${encoded}`;
  const signature = createHmac("sha256", signingKey).update(signed).digest("base64url");
  const fragment = new URLSearchParams({ launch: `${signed}.${signature}` });
  if (initialExport !== undefined) {
    fragment.set("import", base64url(JSON.stringify(initialExport)));
  }
  return `${origin.replace(/\/$/u, "")}/embed#${fragment}`;
}
```

Create one URL per participant and place it directly in an iframe:

```html
<iframe
  src="SIGNED_SPACE_URL"
  title="Shared Space"
  allow="clipboard-read; clipboard-write"
  style="width: 100%; height: 720px; border: 0"
></iframe>
```

The launch credential lives in the URL fragment, so it is not sent as an HTTP
request target or referrer. SpaceScale immediately removes the fragment from
browser history, exchanges the credential through a same-origin POST, and
keeps the resulting Space-scoped session in history state. The Organisation
signing key never leaves the trusted backend.

HMAC signs the payload but does not encrypt it. Anyone who receives the URL can
base64url-decode its claims, including `participant_id`, until the fragment is
consumed. Use an opaque backend identifier instead of an email address when
the identifier itself must remain confidential.

Configure iframe parents with `ALLOWED_ORIGINS`. Missing or blank denies all;
comma-separated exact HTTPS origins allow only those parents; `*` explicitly
allows every origin.

## Persistent Space behaviour and initial import

All participants with the same Organisation and Space IDs resolve to one
Durable Object and see the same state in real time. If the Space already
exists, a launch only refreshes that Participant's current role and display
name; it never resets the canvas.

An owner launch may include `import=<base64url canonical JSON export>` in the
fragment. The import is applied only while creating a brand-new Space. It is
ignored when the Space already exists, which makes retries safe. Viewer and
editor launches never initialise a Space from import data. Imports are bounded
to 1 MiB and 1,000 objects; private image cards are not importable.

## Organisation templates

Built-in templates are available on every board. An owner in an
Organisation-managed Space can additionally select up to 100 non-image objects
and choose **Templates → Save selected objects as template**. The saved layout
appears under **Organisation templates** in every Space belonging to that same
Organisation and never appears in another Organisation.

Any active owner of an Organisation-managed Space may save or delete an
Organisation template. Editors and viewers may insert the templates only when
their current role and the Space lock permit normal drawing. Insertion clones
the layout to new object IDs, places it around the current viewport, and
attributes the new objects to the inserting Participant.

The authenticated board-facing endpoints are:

```text
GET    /api/v1/boards/<space-board-id>/organisation/templates
POST   /api/v1/boards/<space-board-id>/organisation/templates
DELETE /api/v1/boards/<space-board-id>/organisation/templates/<template-id>
```

`GET` returns `{ organisationId, canManage, templates }`. A regular,
non-Organisation board returns `organisationId: null` and an empty list. `POST`
accepts `{ name, description?, items }`; `DELETE` returns `204`. Authorisation
is evaluated from the live Space membership on every request, not from a stale
launch claim.

## Roles, locking, and attribution

- Owners may manage participant roles, co-owners, revocation, and Space-wide
  drawing policy in real time.
- Editors may create work and modify or delete only their own objects.
- Viewers cannot commit canvas changes.
- `owner_only` allows owners to draw while other participants watch.
- `locked` prevents all drawing commits, including from owners, until an owner
  changes the policy.

All durable objects record opaque creator and last-editor IDs. Text, sticky
text, section titles, image descriptions, and table cells retain content-level
attribution. Owners can download **Attributed data JSON**, or a trusted service
can call:

```text
GET /api/v1/boards/<space-board-id>/export.attributed.json
Authorization: Bearer <Space-scoped embed session>
```

The export is designed for questions such as which Participant asked a
question, who gave particular feedback, and which Participant left table cells
incomplete. It includes display names and opaque IDs, never raw
`participant_id` values. The current export is a state snapshot, not a complete
historical revision log.

## Backend integration sequence

1. Create an Organisation registry entry and install the Worker secret.
2. Store only that Organisation's current `kid` and signing key in its trusted
   parent backend.
3. Choose a stable `space_id` for the activity.
4. Sign one owner URL for each coach/facilitator and one editor or viewer URL
   for each participant.
5. Embed those URLs. No participant sign-in or intermediate board selection is
   required.
6. Reissue a URL with a newer `iat` to update a Participant's launch role, or
   let an online owner change roles and locking immediately from the Space.
7. Reuse the same Organisation and Space IDs to continue from persisted state.
