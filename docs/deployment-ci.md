# Deployment setup

The project retains GitHub Actions as the protected release path. Cloudflare
Workers Builds is also supported as an alternative direct Git deployment path,
but do not enable both paths for the same Worker at the same time.

## Cloudflare Workers Builds

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) can
connect a Worker to GitHub, pull each selected commit, run the test suite, and
deploy without a GitHub Actions deployment token. If this path is enabled
later, connect the production Worker in **Worker → Settings → Builds** with:

| Setting | Production value |
| --- | --- |
| Worker | `cloudflare-collab-canvas` |
| Root directory | `/` |
| Production branch | `main` |
| Build variable | `NODE_VERSION=22.19.0` |
| Build command | `npm run check` |
| Deploy command | `npx --no-install wrangler deploy` |

Connect the `staging` branch only to the separate
`cloudflare-collab-canvas-staging` Worker and use
`npx --no-install wrangler deploy --env staging`. Its public hostname is
`staging-cloud-collab.spacescale.net`, and its private R2 bucket is
`staging-cloud-collab`. Do not connect either branch to both Workers or use a
production preview branch as staging; previews would share production Durable
Object and R2 bindings.

Store application secrets in **Worker → Settings → Variables & Secrets**, not
in the Builds secret store. Build variables and secrets exist only while the
repository is building and are not runtime bindings. Install these encrypted
runtime secrets:

| Worker | Runtime secrets |
| --- | --- |
| Staging | `SESSION_SIGNING_KEY_CURRENT`, optional `SESSION_SIGNING_KEY_PREVIOUS`, and `CLASSROOM_INTEGRATION_KEY` |
| Production | The same three environment-specific keys plus `TURNSTILE_SECRET_KEY` |

Set `ALLOWED_ORIGINS` as a dashboard-managed plain runtime variable on each
Worker. Set the production `TURNSTILE_SITE_KEY` there as well. Staging has no
Turnstile key or secret because its committed configuration disables Turnstile.
Missing or blank `ALLOWED_ORIGINS` denies iframe parents; `*` deliberately
permits every parent. The committed `keep_vars` setting prevents Wrangler from
deleting dashboard-managed plain variables. Encrypted Worker secrets survive
Wrangler deployments independently of `keep_vars`.

The native deploy commands intentionally omit `--strict` while plain runtime
variables are dashboard-owned; those remote-only values otherwise appear as
configuration drift. Use strict mode only after testing that ownership model.

A plain `wrangler deploy` immediately moves live traffic to the new version.
Cloudflare-native builds do not reproduce the protected workflow's exact-commit
staging gate, 20-client remote smoke, GitHub production approval,
version-override probes, or automatic rollback. Keep the GitHub browser job if
full Playwright coverage is required, because `npm run check` does not include
`npm run test:e2e`.

Enable and verify a Cloudflare Git connection before disabling
`.github/workflows/deploy.yml`. Once enabled, disable one deployment path to
prevent duplicate deployments. See Cloudflare's documentation for
[build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
[runtime secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
and [`keep_vars`](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth).

## GitHub Actions deployment

The `Deploy` workflow consumes successful push-triggered `CI` runs from two
release branches, with deliberately separate authority:

- `staging` can upload and promote a version only on
  `cloudflare-collab-canvas-staging`, then probes
  `staging-cloud-collab.spacescale.net` and runs the short 20-client load test.
- After those checks, staging writes a `cloudflare/staging` commit-status
  attestation to the exact validated SHA. `main` can enter the production gate
  only when its SHA is still the current `staging` tip and the latest trusted
  attestation for that SHA is successful. The production GitHub environment
  must then be approved before any production candidate is uploaded.

The staging workflow uses `wrangler versions upload` followed by
`wrangler versions deploy ...@100`. These commands update code and traffic but
do not reconcile routes, so the ongoing staging token needs no Zone Workers
Routes permission. Provision and attach the Worker Custom Domain once before
enabling CI. The staging deployment never modifies the production Worker,
Durable Object namespace, R2 bucket, secrets, custom domain, or traffic. The
production path does not redeploy staging; it verifies the prior exact-SHA
attestation.

Release an unchanged commit in this order:

1. Push the candidate commit to `staging`.
2. Wait for both `CI` and **Staging deploy and 20-client smoke** to succeed,
   including the successful `cloudflare/staging` status on that SHA.
3. Fast-forward `main` to that exact commit and push `main`.
4. Wait for `CI`; confirm **Verify exact commit passed staging** accepts the
   current staging tip and its trusted commit-status attestation.
5. Approve the `production` environment and monitor candidate probes and
   promotion.

A merge commit, squash commit, amended commit, or any additional change after
step 2 has a different SHA and must pass staging again. The workflow also
rejects stale runs if either release branch advances while a delivery is
queued.

GitHub loads a `workflow_run` workflow from the repository's default branch.
When introducing or changing this release controller, first land the final
`.github/workflows/deploy.yml` on `main` without promoting application code.
Its production gate fails closed until an exact candidate has subsequently
passed the `staging` branch and published the attestation above.

## GitHub environments

Create `staging` and `production` GitHub environments. Credentials are
environment-scoped and may use distinct Cloudflare account IDs and API tokens:

| Environment | Kind | Name | Required value |
| --- | --- | --- | --- |
| Staging | Secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the isolated staging Worker and `staging-cloud-collab` bucket. |
| Staging | Secret | `CLOUDFLARE_API_TOKEN` | Token scoped to that account with Workers Scripts: Edit (`Workers Scripts Write`). |
| Staging | Variable (optional) | `ALLOWED_ORIGINS` | Exact comma-separated iframe origins; blank denies all and `*` allows all. |
| Production | Secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the production Worker. |
| Production | Secret | `CLOUDFLARE_API_TOKEN` | Token scoped to that account with Workers Scripts: Edit (`Workers Scripts Write`). |
| Production | Variable | `TURNSTILE_SITE_KEY` | Public key of the dedicated real production widget; test keys are rejected. |
| Production | Variable (optional) | `ALLOWED_ORIGINS` | Exact comma-separated iframe origins; blank denies all and `*` allows all. |

Add at least one required reviewer to the `production` environment. Approval
authorizes the production job and confirms that the candidate can still read
every additive Durable Object/SQLite migration if rollback is needed. Do not
approve a release containing a destructive or backward-incompatible storage
migration. The `staging` environment must not require production approval.

Pre-provision the private R2 buckets. Install distinct Worker runtime secrets
before enabling delivery:

| Worker | Required encrypted runtime secrets |
| --- | --- |
| Staging | `SESSION_SIGNING_KEY_CURRENT` and `CLASSROOM_INTEGRATION_KEY` |
| Production | `SESSION_SIGNING_KEY_CURRENT`, `CLASSROOM_INTEGRATION_KEY`, and `TURNSTILE_SECRET_KEY` |

`SESSION_SIGNING_KEY_PREVIOUS` is optional on either Worker during a controlled
rotation. Never share session or classroom signing keys between staging and
production. After the buckets, Workers, and Custom Domains are provisioned, the
CI tokens do not need R2, Turnstile administration, Zone, DNS, Routes, Tail, or
Observability permissions. Runtime R2 access comes from the private binding;
staging version upload/deploy intentionally leaves its pre-attached custom
domain unchanged.

## Automation-only staging security

Staging deliberately fixes `TURNSTILE_ENABLED=false` in both committed
configuration and the deployment command. It needs no Turnstile widget, site
key, Siteverify secret, reusable test token, or token broker. This allows
Playwright and AI-driven browser runs to exercise board creation and capability
claims, and lets the delivery workflow run its 20-client smoke test without an
interactive challenge.

Treat `staging-cloud-collab.spacescale.net` as a public, lower-trust test
surface. Use only disposable test boards, isolated Durable Objects and R2 data,
and staging-only signing keys. Never connect a production classroom backend or
copy production board data into staging. Production independently fixes
`TURNSTILE_ENABLED=true`, requires a real `TURNSTILE_SITE_KEY`, and verifies
requests with the installed `TURNSTILE_SECRET_KEY`.

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
