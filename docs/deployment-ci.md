# CI deployment setup

The `Deploy` workflow runs only after a successful `CI` push run for the current
`main` commit. It serializes deliveries, rejects a queued commit if `main` has
advanced, deploys isolated staging, and enters production only after the named
GitHub environment gate is approved.

## GitHub environments

Create `staging` and `production` environments. Configure these values in each
environment so credentials cannot cross the environment boundary:

| Kind | Name | Required value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | The one target Cloudflare account ID. |
| Secret | `CLOUDFLARE_API_TOKEN` | An account token scoped to that account with only Workers Scripts: Edit (`Workers Scripts Write`). |
| Variable | `TURNSTILE_SITE_KEY` | The public key of that environment's dedicated real Turnstile widget. Test keys are rejected. |
| Variable | `TURNSTILE_TOKEN_BROKER_URL` | Staging only: the HTTPS endpoint implementing the broker contract below. |

Add at least one required reviewer to the `production` environment. Approval of
that environment authorizes the production job and confirms that the candidate
can still read every additive Durable Object/SQLite migration if rollback is
needed. Do not approve a release containing a destructive or backward-
incompatible storage migration.

Pre-provision each private R2 bucket. Install distinct Worker runtime secrets
before enabling delivery:

- `SESSION_SIGNING_KEY_CURRENT`;
- optional `SESSION_SIGNING_KEY_PREVIOUS` during rotation; and
- `TURNSTILE_SECRET_KEY` from the same widget as that environment's public
  site key.

The CI token does not need R2, Turnstile administration, Zone, DNS, Routes,
Tail, or Observability permissions. The R2 binding supplies runtime access.

## Staging Turnstile broker contract

Turnstile tokens are single-use and short-lived. They are not GitHub secrets
and must never be stored as reusable CI values. The staging job obtains a
GitHub OIDC token with audience
`cloudflare-collab-canvas-staging-turnstile-broker` and sends it as a bearer
token to `TURNSTILE_TOKEN_BROKER_URL`.

The broker must validate the OIDC signature and these claims before doing any
work:

- issuer is GitHub Actions and audience is the exact value above;
- repository is the expected repository;
- ref is `refs/heads/main`;
- workflow identity is `.github/workflows/deploy.yml` from the trusted main
  branch;
- environment is `staging`; and
- run ID and commit SHA agree with the authenticated OIDC claims and request.

The JSON request is:

```json
{
  "hostname": "cloudflare-collab-canvas-staging.spacescale.workers.dev",
  "repository": "owner/repository",
  "commitSha": "validated commit SHA",
  "runId": "GitHub run ID",
  "tokens": { "board_create": 1, "invitation_claim": 20 }
}
```

Using only the dedicated staging widget on that exact hostname, the broker must
obtain one fresh token carrying action `board_create` and 20 fresh tokens
carrying action `invitation_claim`. It must not use the production widget,
generate tokens from the Siteverify secret, cache a response, return a token
twice, or log tokens. The response has exactly these fields:

```json
{
  "hostname": "cloudflare-collab-canvas-staging.spacescale.workers.dev",
  "runId": "GitHub run ID",
  "issuedAt": 1780000000,
  "expiresAt": 1780000290,
  "boardCreateToken": "fresh token",
  "invitationClaimTokens": ["20 distinct fresh tokens"]
}
```

Timestamps are Unix seconds. `issuedAt` describes the oldest token and
`expiresAt` the earliest expiry. At response time at least 220 seconds of
validity must remain because production-like invitation throttling spaces the
20 staging claims. The workflow rejects wrong shape, host, run, freshness,
lifetime, count, length, or duplicate values, masks every returned token, and
never uploads the response. Missing or invalid broker configuration fails the
deployment before the load test.

## Production promotion and rollback

The workflow requires one existing production deployment at 100% before it can
capture a rollback target. For the first installation, an operator must
provision the production bucket and runtime secrets, run the documented
production bootstrap/deploy once, and verify `/healthz`. A missing deployment
or an existing traffic split fails closed; the workflow does not guess a
rollback version.

Production upload uses the repository-pinned Wrangler 4.118.0 and sends no
custom-domain traffic to the candidate. It then creates a two-version
deployment with the prior version at 100% and candidate at 0%. Read-only
health, HTML, and every referenced content-hashed asset are fetched through
`spacescale.net` with:

```text
Cloudflare-Workers-Version-Overrides: cloudflare-collab-canvas="candidate-version-id"
```

`/healthz` must report that exact candidate version from the version-metadata
binding. Only then is the candidate promoted atomically to 100%; unpinned live
health and Static Assets are checked again.

Percentage splitting is intentionally disabled for now. Vite HTML and its
content-hashed asset requests can otherwise reach different Worker versions
and produce a 404. A multi-step percentage rollout may replace the 0%-to-100%
promotion only after an operator configures and verifies version affinity for
all HTML and asset requests.

The previous version ID and exact rollback command are retained for 90 days as
a workflow artifact. Any failure after the 0% deployment attempts to restore
the previous version to 100%. If automation cannot do so, use the command in
the job summary after confirming the retained code is still storage-schema
compatible.
