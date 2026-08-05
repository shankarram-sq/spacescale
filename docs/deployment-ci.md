# Deployment setup

The project supports Cloudflare Workers Builds as the direct Git deployment
path and retains the protected GitHub Actions pipeline as the higher-assurance
alternative.

## Cloudflare Workers Builds

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) can
connect the existing Worker to GitHub, pull each selected commit, run the test
suite, and deploy without a GitHub Actions deployment token. In **Worker →
Settings → Builds**, connect this repository with:

| Setting | Production value |
| --- | --- |
| Worker | `cloudflare-collab-canvas` |
| Root directory | `/` |
| Production branch | `development` (the current remote default) |
| Build variable | `NODE_VERSION=22.19.0` |
| Build command | `npm run check` |
| Deploy command | `npx --no-install wrangler deploy` |

Store application secrets in **Worker → Settings → Variables & Secrets**, not
in the Builds secret store. Build variables and secrets exist only while the
repository is building and are not runtime bindings. Install these encrypted
runtime secrets on each Worker:

- `SESSION_SIGNING_KEY_CURRENT`;
- optional `SESSION_SIGNING_KEY_PREVIOUS` during rotation;
- `CLASSROOM_INTEGRATION_KEY`; and
- `TURNSTILE_SECRET_KEY`.

Set dashboard-managed public runtime values there as plain variables,
including `TURNSTILE_SITE_KEY` and optional `ALLOWED_ORIGINS`. Missing or blank
`ALLOWED_ORIGINS` denies iframe parents; `*` deliberately permits every parent.
The committed `keep_vars` setting prevents Wrangler from deleting dashboard-
managed plain variables. Encrypted Worker secrets survive Wrangler deployments
independently of `keep_vars`.

The native deploy commands intentionally omit `--strict` while plain runtime
variables are dashboard-owned; those remote-only values otherwise appear as
configuration drift. Use strict mode only after testing that ownership model.

For the separate staging Worker, create a distinct staging release branch,
connect it to `cloudflare-collab-canvas-staging`, and use
`npx --no-install wrangler deploy --env staging`. Do not connect the
same branch to both production and staging. Do not use production preview
branches as a substitute for staging because they share the production Durable
Object and R2 bindings.

For a manual production gate, initially use
`npx --no-install wrangler versions upload`, test the uploaded version,
and promote it in Cloudflare. A plain `wrangler deploy` immediately moves live
traffic to the new version. Cloudflare-native builds do not reproduce the
repository's staging load smoke, GitHub approval, version-override probes, or
automatic rollback. Keep the GitHub browser job if full Playwright coverage is
required, because `npm run check` does not include `npm run test:e2e`.

Enable and verify the Cloudflare Git connection before disabling
`.github/workflows/deploy.yml`; otherwise pushes would have no automatic release
path. Once enabled, disable one deployment path to prevent duplicate production
deployments. See Cloudflare's documentation for
[build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
[runtime secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
and [`keep_vars`](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth).

## GitHub Actions deployment

The current remote does not have a `main` branch, so this fallback remains
inactive until a deliberate `main` release branch is created. Cloudflare
Workers Builds should target `development` in the current repository layout.

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
| Variable (optional) | `ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins allowed to frame classroom embed pages. Blank or missing denies all; literal `*` allows every parent. |
| Variable | `TURNSTILE_TOKEN_BROKER_URL` | Staging only: the HTTPS endpoint implementing the broker contract below. |

Add at least one required reviewer to the `production` environment. Approval of
that environment authorizes the production job and confirms that the candidate
can still read every additive Durable Object/SQLite migration if rollback is
needed. Do not approve a release containing a destructive or backward-
incompatible storage migration.

Pre-provision each private R2 bucket. Install distinct Worker runtime secrets
before enabling delivery:

- `SESSION_SIGNING_KEY_CURRENT`;
- optional `SESSION_SIGNING_KEY_PREVIOUS` during rotation;
- `CLASSROOM_INTEGRATION_KEY`, shared only with that environment's trusted
  classroom backend; and
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
