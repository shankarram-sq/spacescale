# Operations runbook

This runbook deliberately refers to board identifiers and aggregate metadata,
never board text, cookies, raw invitation/recovery tokens, or session
signatures.

The saved-query, metric-field, exact alert-threshold, and notification-delivery
readiness contract is documented in [observability.md](observability.md). Its
repository commands are validation and dry-run planning only; they do not
provision a Cloudflare dashboard or alert.

## Provisioning

1. Provision the isolated staging Worker, its private `staging-cloud-collab`
   R2 bucket, and the `staging-cloud-collab.spacescale.net` Worker Custom
   Domain. Keep its Durable Object namespace and signing keys separate from
   production.
2. Create one dedicated production Turnstile widget. Allow only
   `spacescale.net`, and copy its public site key and Siteverify secret from
   the same widget. Staging deliberately has no Turnstile widget or credentials.
3. Run `npm run cf:check` for the selected environment.
4. Run `npm run cf:bootstrap -- --env <development|staging|production>`.
5. Install production runtime secrets with
   `npx wrangler secret put SESSION_SIGNING_KEY_CURRENT`,
   `npx wrangler secret put CLASSROOM_INTEGRATION_KEY`, and
   `npx wrangler secret put TURNSTILE_SECRET_KEY`. Install only the two
   staging signing secrets with
   `npx wrangler secret put SESSION_SIGNING_KEY_CURRENT --env staging` and
   `npx wrangler secret put CLASSROOM_INTEGRATION_KEY --env staging`.
6. Deploy staging only from the `staging` branch. Do not initialize individual
   board objects from CI; the creator request chooses their placement.
7. Validate `/healthz`, create a disposable staging board, commit one item,
   reconnect from its prior sequence, create a named snapshot, and confirm both
   JSON and SVG exports. Verify the named snapshot through the owner API and
   its private immutable R2 object metadata without printing board content.
8. Move `main` to that unchanged commit only after the staging delivery and
   20-client smoke test pass. Production remains behind its GitHub environment
   approval gate.

The public environment values are committed in `config/environments.json` and
must agree with local configuration before bootstrap: staging uses bucket
`staging-cloud-collab` and hostname
`staging-cloud-collab.spacescale.net`; production uses bucket
`collab-canvas-snapshots` and hostname `spacescale.net`. Keep
`BOARD_CREATION_ENABLED=true` normally; set the committed public switch to
`false` for an intentional creation freeze before deploying. Bootstrap rejects
hostname, bucket, and switch drift.

Set `ALLOWED_ORIGINS` to a comma-separated list of exact classroom application
origins in local configuration and in each GitHub environment. It is public
configuration, not a secret. Missing, blank, path-bearing, wildcard-pattern, or
malformed values deny framing. A literal `*` allows every iframe parent.
Normal board pages remain non-embeddable.

Both release targets are Worker Custom Domains with their `workers.dev`
fallback disabled. Confirm the custom domains and certificates are active after
the first authorized deployment. Ongoing staging CI uses Worker version
upload/deploy and deliberately does not reconcile that pre-attached domain, so
its token needs no Zone Workers Routes permission. Staging has its own Worker,
Durable Object namespace, R2 bucket, runtime signing keys, and test data; it
inherits no production route, binding, secret, or data.

Staging fixes `TURNSTILE_ENABLED=false` so Playwright, AI-driven browser tests,
and the 20-client smoke test can exercise board creation and capability claims
without interactive challenges. Treat it as a public, lower-trust automation
surface and use disposable test data only. Production fixes
`TURNSTILE_ENABLED=true` and fails closed without its real site key and
Siteverify secret.

The default Workers/R2 management token cannot inspect Turnstile widgets. For
production, if `cf:check` reports
`manualDashboardConfirmationRequired`, confirm in the Turnstile dashboard that
the configured public site key and installed secret come from the same widget
and that its hostname allowlist contains `spacescale.net`. A token with
Turnstile Sites Read lets `cf:check` perform this comparison without emitting
keys or secrets. Staging has no widget pairing to inspect.

## Session-key rotation

1. Preserve the old current key as `SESSION_SIGNING_KEY_PREVIOUS`.
2. generate a new independent 32-byte current key;
3. install both encrypted values and deploy;
4. monitor authentication rejection counts for one 30-day session window;
5. remove the previous key and deploy again.

Never reuse signing keys between environments.

`CLASSROOM_INTEGRATION_KEY` is also an identity-derivation key. Keep it stable
within an environment and back it up in the secret manager. Rotating it creates
new derived classroom board and actor IDs; treat rotation as a classroom data
migration, not routine session-key maintenance.

## Deploy and rollback

Push a candidate commit to `staging` and wait for CI, the isolated staging
version promotion, and the 20-client smoke test to pass. The workflow then
publishes a `cloudflare/staging` commit-status attestation for that exact SHA.
Fast-forward `main` to that SHA without amending, squashing, or creating a new
merge commit. The production workflow verifies that the current staging tip
matches `main` and that the latest trusted attestation on that commit succeeded
before requesting production approval. Any changed SHA must repeat staging
validation.

Cloudflare-native Git builds and the repository's protected GitHub workflow are
both documented in [deployment-ci.md](deployment-ci.md); use only one automatic
production deploy path at a time. Retain the prior production version. Until
version affinity is configured for both HTML and content-hashed Static Assets,
attach a candidate at 0%, verify it with a version override, and promote
atomically rather than percentage-splitting browser traffic. Roll back Worker
code only when it can read every forward schema migration already applied;
never pair a destructive schema change with incompatible old code.

## Metadata-only board inspection

Use sampled structured events, an owner-authorized metadata endpoint, or
[Durable Objects Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/).
Data Studio requires at least the **Workers Platform Admin** role. Its queries
run against remote deployed objects and are billed for requests, duration,
rows read, and rows written. Every query is also recorded in Cloudflare Audit
Logs v1 as correlated `query executed` and `query completed` events. Treat it
as production access, use an individually attributable account, and record the
two events' `query_id` in the incident or change record.

The owner-approved board URL is `/b/<boardId>`. Select the correct environment's
`BoardRoom` namespace in Data Studio and enter that exact `b_...` segment as
the **user-provided unique name**; the gateway resolves rooms with
`BOARD_ROOMS.getByName(boardId)`. A Cloudflare-generated Durable Object ID can
be entered instead when it is already known. Data Studio does not provide a
safe cross-board content search. Keep the full board ID inside the approved
operator workflow and out of screenshots, chat, and tickets; record its
privacy-safe hash in the ticket.

Run only the required statements below. Data Studio sends every statement in
"run all" as a separate Durable Object request, so do not paste the whole
section and run it at once. Never use `SELECT *`. The following status, lag,
and aggregate-count queries do not select board content or identities:

```sql
SELECT version, name, applied_at_ms
FROM _sql_schema_migrations
ORDER BY version;
```

```sql
SELECT
  access_mode,
  drawing_policy,
  latest_seq,
  min_replay_seq,
  latest_snapshot_seq,
  MAX(latest_seq - latest_snapshot_seq, 0) AS snapshot_lag_actions,
  CASE
    WHEN dirty_since_at_ms IS NULL THEN 0
    ELSE MAX(
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 - dirty_since_at_ms,
      0
    )
  END AS snapshot_lag_ms,
  acl_version,
  snapshot_live_item_count AS live_item_count,
  snapshot_live_item_bytes AS live_item_json_bytes,
  usage_checkpoint_seq,
  created_at_ms,
  updated_at_ms,
  archived_at_ms
FROM board
WHERE singleton = 1;
```

```sql
SELECT
  (SELECT COUNT(*) FROM items WHERE deleted = 0) AS live_item_rows,
  (SELECT COUNT(*) FROM items WHERE deleted = 1) AS tombstone_item_rows,
  (SELECT COUNT(*) FROM actions) AS retained_action_rows,
  (SELECT COUNT(*) FROM action_receipts) AS compacted_action_receipt_rows,
  (SELECT COUNT(*) FROM history_entries WHERE state = 'active') AS active_history_rows,
  (SELECT COUNT(*) FROM history_entries WHERE state = 'undone') AS undone_history_rows,
  (SELECT COUNT(*) FROM history_entries WHERE state = 'invalidated') AS invalidated_history_rows,
  (SELECT COUNT(*) FROM http_receipts) AS http_receipt_rows,
  (SELECT COUNT(*) FROM snapshots) AS snapshot_rows,
  (SELECT COUNT(*) FROM members WHERE revoked_at_ms IS NULL) AS active_member_rows,
  (
    SELECT COUNT(*)
    FROM invitations
    WHERE revoked_at_ms IS NULL
      AND expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      AND use_count < max_uses
  ) AS active_invitation_rows;
```

Snapshot inventory and scheduled-work queries must expose only aggregate or
sequence metadata, never labels, creators, object keys, or digests:

```sql
SELECT
  kind,
  COUNT(*) AS snapshot_count,
  MIN(seq) AS oldest_seq,
  MAX(seq) AS newest_seq,
  SUM(byte_count) AS retained_bytes,
  MIN(created_at_ms) AS oldest_created_at_ms,
  MAX(created_at_ms) AS newest_created_at_ms
FROM snapshots
GROUP BY kind
ORDER BY kind;
```

```sql
SELECT seq, kind, item_count, byte_count, created_at_ms
FROM snapshots
ORDER BY seq DESC
LIMIT 200;
```

```sql
SELECT job_name, due_at_ms, attempt, updated_at_ms
FROM scheduled_jobs
ORDER BY due_at_ms, job_name;
```

Daily counters are estimates maintained by the application. Inspect the
durable rollups and any action-accounting rows newer than the checkpoint with
these separate queries:

```sql
SELECT
  day_utc,
  incoming_frames,
  billed_request_estimate,
  rows_read_estimate,
  rows_written_estimate,
  r2_reads,
  r2_writes,
  r2_bytes,
  actions,
  snapshots,
  updated_at_ms
FROM usage_counters
ORDER BY day_utc DESC
LIMIT 31;
```

```sql
SELECT
  b.usage_checkpoint_seq,
  b.latest_seq,
  COUNT(a.seq) AS pending_action_rows,
  COALESCE(SUM(a.usage_incoming_frames), 0) AS pending_incoming_frames,
  COALESCE(SUM(a.usage_rows_read_estimate), 0) AS pending_rows_read_estimate,
  COALESCE(SUM(a.usage_rows_written_estimate), 0) AS pending_rows_written_estimate,
  COALESCE(SUM(a.usage_r2_reads), 0) AS pending_r2_reads,
  COALESCE(SUM(a.usage_r2_writes), 0) AS pending_r2_writes,
  COALESCE(SUM(a.usage_r2_bytes), 0) AS pending_r2_bytes,
  COALESCE(SUM(a.usage_snapshots), 0) AS pending_snapshots
FROM board AS b
LEFT JOIN actions AS a ON a.seq > b.usage_checkpoint_seq
WHERE b.singleton = 1
GROUP BY b.usage_checkpoint_seq, b.latest_seq;
```

For SQLite allocation, run each pragma separately and calculate allocated
bytes as `page_count * page_size`; `freelist_count * page_size` is reusable
allocation, not additional storage. `snapshot_live_item_bytes` is only the
estimated serialized live-item payload and is not the database size.

```sql
PRAGMA page_count;
```

```sql
PRAGMA page_size;
```

```sql
PRAGMA freelist_count;
```

Do not select or print `board.title`, owner/member actor IDs or display names,
recovery/invitation material, item IDs or `data_json`, action/receipt IDs,
hashes or JSON payloads, snapshot labels/creators/R2 keys, or scheduled-job
`payload_json`. Active-duration is not stored in BoardRoom SQLite; inspect the
Cloudflare Durable Objects platform metric instead of inventing a SQL proxy.

## Snapshot and recovery

An owner creates a named snapshot from **Access > Recovery points > Save
recovery point** on `/b/<boardId>`. Wait until pending edits have saved, use an
incident/change label containing no board content, and record the displayed
sequence. The underlying request is exactly
`POST /api/v1/boards/<boardId>/snapshots` with the existing owner session,
same-origin and CSRF checks, an `Idempotency-Key`, and JSON body
`{"label":"<1-80 visible characters>"}`. Success is HTTP 201 with
`snapshot.seq`, `kind`, `sha256`, `itemCount`, `byteCount`, and `createdAt`.
Do not copy the response's label or any actor data into diagnostics.

In that same owner tab, replace the sequence below and run the snippet once in
the browser console. It uses the owner session without copying its cookie,
lists only safe snapshot fields, fetches the current JSON and SVG exports into
memory, and prints only verification results—not board content or digests.

```js
const expectedSeq = Number("REPLACE_WITH_SNAPSHOT_SEQUENCE");
const boardMatch = /^\/b\/(b_[A-Za-z0-9_-]{22})$/.exec(location.pathname);
if (!boardMatch) throw new Error("Open the exact owner board URL first.");
const boardId = boardMatch[1];

const listResponse = await fetch(
  `/api/v1/boards/${encodeURIComponent(boardId)}/snapshots`,
  { credentials: "same-origin", cache: "no-store" },
);
if (!listResponse.ok) throw new Error(`Snapshot list failed: ${listResponse.status}`);
const snapshot = (await listResponse.json()).snapshots.find(
  (entry) => entry.seq === expectedSeq && entry.kind === "named",
);
if (!snapshot) throw new Error("The named snapshot sequence was not found.");

const base64UrlSha256 = async (bytes) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const checks = [];
for (const extension of ["json", "svg"]) {
  const response = await fetch(
    `/api/v1/boards/${encodeURIComponent(boardId)}/export.${extension}`,
    { credentials: "same-origin", cache: "no-store" },
  );
  const bytes = await response.arrayBuffer();
  const digest = await base64UrlSha256(bytes);
  const etag = response.headers.get("etag")?.replace(/^"|"$/gu, "");
  const seq = Number(response.headers.get("x-whiteboard-seq"));
  checks.push({
    extension,
    status: response.status,
    contentType: response.headers.get("content-type"),
    noStore: response.headers.get("cache-control") === "no-store",
    sameSnapshotSequence: seq === expectedSeq,
    etagMatchesBody: etag === digest,
    jsonMatchesSnapshotSha: extension === "json" ? digest === snapshot.sha256 : "n/a",
    bytes: bytes.byteLength,
  });
}
console.table(checks);
```

Both rows must be HTTP 200, `noStore`, `sameSnapshotSequence`, and
`etagMatchesBody`; content types must start with `application/json` and
`image/svg+xml` respectively. The JSON row must also have
`jsonMatchesSnapshotSha: true` and its byte count must equal
`snapshot.byteCount`. SVG has its own digest because it is generated on demand.
If either export sequence differs, the board changed after the snapshot; do
not claim a mismatch—wait for pending edits, create another named snapshot,
and retry.

### Private R2 object verification

Keep the bucket private. Run the following from the repository in a fresh
shell with tracing disabled. It loads the existing `.env`, reads the board ID
without placing it in shell history, downloads the immutable JSON object with
the current Wrangler `--remote` command, compares its base64url SHA-256 and byte
count to the owner API metadata, and uses the authenticated R2 list API to
confirm the stored `custom_metadata.sha256`, size, and content type. It never
prints or parses the object body.

```bash
(
set -eu
set +x
umask 077
set -a
. ./.env
set +a

IFS= read -r -s -p "Board ID: " ops_board_id
printf '\n'
IFS= read -r -p "Snapshot sequence: " ops_snapshot_seq
IFS= read -r -p "Expected SHA-256 from owner API: " ops_expected_sha
IFS= read -r -p "Expected byte count from owner API: " ops_expected_bytes

ops_snapshot_key="boards/${ops_board_id}/snapshots/${ops_snapshot_seq}.json"
ops_tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$ops_tmp_dir"' EXIT

npx wrangler r2 object get \
  "${R2_BUCKET_NAME}/${ops_snapshot_key}" \
  --remote \
  --file "${ops_tmp_dir}/snapshot.json"

ops_actual_sha="$(
  openssl dgst -sha256 -binary "${ops_tmp_dir}/snapshot.json" \
    | openssl base64 -A \
    | tr '+/' '-_' \
    | tr -d '='
)"
ops_actual_bytes="$(wc -c < "${ops_tmp_dir}/snapshot.json" | tr -d '[:space:]')"
test "${ops_actual_sha}" = "${ops_expected_sha}"
test "${ops_actual_bytes}" = "${ops_expected_bytes}"

curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --data-urlencode "prefix=${ops_snapshot_key}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${R2_BUCKET_NAME}/objects" \
  --output "${ops_tmp_dir}/object-list.json"

ops_remote_count="$(
  jq --arg key "${ops_snapshot_key}" \
    '[.result[] | select(.key == $key)] | length' \
    "${ops_tmp_dir}/object-list.json"
)"
ops_remote_sha="$(
  jq -r --arg key "${ops_snapshot_key}" \
    '.result[] | select(.key == $key) | .custom_metadata.sha256' \
    "${ops_tmp_dir}/object-list.json"
)"
ops_remote_bytes="$(
  jq -r --arg key "${ops_snapshot_key}" \
    '.result[] | select(.key == $key) | .size' \
    "${ops_tmp_dir}/object-list.json"
)"
ops_remote_type="$(
  jq -r --arg key "${ops_snapshot_key}" \
    '.result[] | select(.key == $key) | .http_metadata.contentType' \
    "${ops_tmp_dir}/object-list.json"
)"

test "${ops_remote_count}" = "1"
test "${ops_remote_sha}" = "${ops_expected_sha}"
test "${ops_remote_bytes}" = "${ops_expected_bytes}"
test "${ops_remote_type}" = "application/json; charset=utf-8"
printf 'Private R2 snapshot verification passed.\n'
)
```

The API token needs only the already-provisioned account/R2 read permissions;
do not create a public domain, presigned URL, or separate credential for this
check. A missing object, non-unique exact-key result, digest/size/content-type
mismatch, or absent custom metadata is a failed recovery verification. Keep
the temporary cleanup trap intact.

Restore creates a new sequenced action and never rewinds ACL/settings. A board
clear must fail unless its exact pre-clear snapshot was written successfully.

SQLite in the BoardRoom is authoritative for current state and board existence;
R2 must never become a routing prerequisite for ordinary board traffic. Apply
snapshot lifecycle rules only to the documented snapshot classes and retain
named snapshots until their owner-controlled lifecycle permits deletion.

## `SQLITE_FULL`

1. reject new durable mutations with a stable storage/temporary error;
2. keep existing sockets readable where possible;
3. archive diagnostic counters without board content;
4. verify the latest R2 snapshot and offer canonical owner exports;
5. compact only data proven unnecessary to replay, retained snapshots, command
   receipts, and undo/redo lineage;
6. move the service to Workers Paid or operator-assisted recovery before
   reopening writes.

## Quota exhaustion

Surface daily estimates for Worker/DO request units, SQLite reads/writes, R2
operations/bytes, action counts, and snapshot lag, plus Cloudflare's platform
active-duration metric. Warn
at 70% of a free allowance and stop new board creation before hard exhaustion;
preserve existing read/reconnect/export paths. Cloudflare free allowances reset
at 00:00 UTC. Moving to Workers Paid changes billing, not stored data or IDs.

## Abuse and maintenance

An operator may disable only new board creation through a deployment variable,
leaving existing board routes active.

### Audited emergency archive

Archive is a terminal, permanently read-only board state. It is not deletion,
but version one has no unarchive operation. Never promise recovery by clearing
`archived_at_ms`, and never run an ad hoc `UPDATE ... SET archived_at_ms =
NULL`.

The normal owner product flow is:

1. Wait until pending edits have saved. Before archiving, create a **named**
   snapshot using the owner flow under **Access** and record its sequence.
2. Complete both checks already documented in [Snapshot and
   recovery](#snapshot-and-recovery): verify the JSON and SVG exports against
   that named snapshot, then verify the private immutable R2 JSON object's
   SHA-256 and byte count against the owner API metadata. Do not proceed on a
   sequence, digest, size, metadata, or content-type mismatch.
3. In the owner-only **Access** panel, open **Recovery & board**, choose
   **Archive board**, and acknowledge that the operation is irreversible and
   makes the board permanently read-only.
4. The client sends the authenticated, same-origin, CSRF-protected request
   `POST /api/v1/boards/<boardId>/archive` with the exact JSON body
   `{"expectedAclVersion": <current integer>}`. Success is HTTP 200 with
   `{"archived": true, "archivedAt": <integer>, "aclVersion": <integer>}`.
   A stale ACL version fails without archiving; refresh the owner view before
   deciding whether to retry.
5. After the archive transaction commits, the BoardRoom immediately closes
   every currently valid attached WebSocket with close code 4011. Use a new
   request, not an existing socket, to verify an authenticated owner bootstrap
   receives HTTP 410 with `error.code` `FORBIDDEN`; verify a fresh WebSocket
   upgrade also receives HTTP 410 `FORBIDDEN` instead of HTTP 101.

An authorized Workers Platform Admin may use Data Studio only as an emergency
metadata-only fallback when the owner route cannot be used. This is production
access, not an equivalent owner interaction:

1. Open an approved incident/change record with the privacy-safe board hash,
   stable reason code, named approver, environment, and UTC time. Do not include
   the raw board ID, board content, identities, snapshot labels, object keys, or
   digests. Before the fallback, the owner must have completed the named
   snapshot, JSON/SVG export, and private R2 SHA/byte verification above.
2. Select the exact BoardRoom object by its owner-approved unique name as
   described under [Metadata-only board inspection](#metadata-only-board-inspection).
   Run this preflight by itself:

   ```sql
   SELECT
     b.latest_seq,
     b.acl_version,
     b.archived_at_ms,
     b.updated_at_ms,
     (
       SELECT COUNT(*)
       FROM snapshots AS s
       WHERE s.seq = b.latest_seq
         AND s.kind = 'named'
     ) AS named_snapshot_at_latest_seq
   FROM board AS b
   WHERE b.singleton = 1;
   ```

   Confirm `archived_at_ms` is null,
   `named_snapshot_at_latest_seq` is exactly 1, and `latest_seq` equals the
   sequence of the named snapshot whose exports and R2 object were verified.
   Record only these metadata values. If any check fails, stop and repeat the
   owner snapshot and verification flow while the board is still accessible.
3. In the statement below, replace both `REPLACE_WITH_...` tokens with the
   unquoted integer values from the verified snapshot and the immediately
   preceding preflight. Run the resulting **single atomic statement** once:

   ```sql
   UPDATE board
   SET
     archived_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
     updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
     acl_version = acl_version + 1
   WHERE singleton = 1
     AND archived_at_ms IS NULL
     AND latest_seq = REPLACE_WITH_VERIFIED_NAMED_SNAPSHOT_SEQ
     AND acl_version = REPLACE_WITH_PREFLIGHT_ACL_VERSION
     AND EXISTS (
       SELECT 1
       FROM snapshots AS s
       WHERE s.seq = board.latest_seq
         AND s.kind = 'named'
     )
   RETURNING latest_seq, acl_version, archived_at_ms, updated_at_ms;
   ```

   Exactly one row must be returned. Zero rows means the board, ACL, or archive
   state changed; do not weaken the predicates or rerun with guessed values.
   Return to preflight and, if the sequence changed, create and verify a new
   named snapshot before another attempt.
4. Run this postflight by itself:

   ```sql
   SELECT
     latest_seq,
     acl_version,
     archived_at_ms,
     updated_at_ms
   FROM board
   WHERE singleton = 1;
   ```

   Confirm the sequence is unchanged, the ACL version is the preflight value
   plus one, `archived_at_ms` is non-null, and `updated_at_ms` equals it. Record
   only those metadata values. Correlate Data Studio's `query executed` and
   successful `query completed` Audit Log events by `query_id` and add the
   query ID to the incident record.
5. Verify a fresh authenticated owner bootstrap and a fresh WebSocket upgrade
   each receive HTTP 410 with the stable `FORBIDDEN` response, as in the owner
   flow. The archive is irreversible; there is no supported unarchive.

The two paths differ for already-open WebSockets. The owner API runs inside the
BoardRoom and, after committing, can immediately close its current valid
sockets with code 4011. A direct Data Studio metadata update cannot wake or
control an already-running Durable Object and therefore cannot immediately
broadcast or close those sockets. With the fallback, each live socket is
affected and closed only when it next sends an inbound frame and the BoardRoom
observes the archived metadata. An idle socket may remain physically open
until then. Immediate closure from an operator path would require a separately
implemented, authenticated wake/control route; Data Studio alone is not
evidence that code 4011 was delivered.

Permanent deletion is not a version-one product operation.

Keep Cloudflare rate-limiting/WAF rules in front of `/api/v1/boards` and
`*/claims` as defense in depth. The Worker has bounded per-isolate creation and
claim buckets. Production capability flows require action-bound Turnstile;
staging deliberately disables it for isolated automation. Alert on R2 snapshot
failures without treating them as evidence that an authoritative board is
absent.
