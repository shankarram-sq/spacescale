# Deployment and CI

This repository intentionally uses a lightweight release flow while the product
has no production consumers. A working development build may be promoted; broad
validation is available on demand and is not a deployment gate.

## Workflows

`.github/workflows/ci.yml` is manual-only through `workflow_dispatch`. When
explicitly started it runs the full repository check, verifies generated Worker
binding types, and runs Playwright. Pull requests and branch pushes do not wait
for this workflow.

`.github/workflows/deploy.yml` runs directly on pushes to:

- `staging`, targeting `staging-cloud-collab.spacescale.net`
- `main`, targeting `spacescale.net`

Each job:

1. checks out the pushed `${{ github.sha }}`;
2. installs the pinned dependencies;
3. verifies the environment-scoped Cloudflare credentials;
4. idempotently creates or reuses the snapshot and private image R2 buckets;
5. builds the web assets;
6. uploads a Worker version;
7. deploys that version directly at 100%; and
8. makes up to five small `/healthz` requests that check only `ok` and the
   service identity.

The deployment workflow does not depend on CI, exact-SHA attestations,
approvals, candidate traffic, browser or load suites, convergence loops,
automated rollback, or a schema-compatibility gate. Fix forward and redeploy if
a release has a defect. Because these are new, unused deployments, resetting an
unused environment is also acceptable when faster than repairing its data.

Moving the same commit from `development` to `staging` and then `main` is
recommended for traceability, but the workflow does not enforce that order.

## GitHub environments

Create `staging` and `production` GitHub environments. They may point to
different Cloudflare accounts and should use distinct credentials.

| Environment | Kind | Name | Value |
| --- | --- | --- | --- |
| Staging | Secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the isolated staging Worker and buckets. |
| Staging | Secret | `CLOUDFLARE_API_TOKEN` | Staging account token. |
| Staging | Secret | `ORGANISATION_SIGNING_KEYS` | JSON registry uploaded as an encrypted Worker-version secret. |
| Staging | Variable | `ALLOWED_ORIGINS` | Comma-separated iframe origins; blank denies all and `*` allows all. |
| Production | Secret | `CLOUDFLARE_ACCOUNT_ID` | Account containing the production Worker and buckets. |
| Production | Secret | `CLOUDFLARE_API_TOKEN` | Production account token. |
| Production | Secret | `ORGANISATION_SIGNING_KEYS` | JSON registry uploaded as an encrypted Worker-version secret. |
| Production | Variable | `TURNSTILE_SITE_KEY` | Public key for the production Turnstile widget. |
| Production | Variable | `ALLOWED_ORIGINS` | Comma-separated iframe origins; blank denies all and `*` allows all. |

Because every deployment verifies or provisions both R2 buckets, each API token
needs these account permissions:

- **Workers Scripts: Edit**
- **Workers R2 Storage: Edit**

Correct existing private buckets are reused without mutation. Bucket bootstrap
also rejects a bucket with an enabled `r2.dev` or custom public domain.

The workflow passes `ORGANISATION_SIGNING_KEYS` through Wrangler's
`--secrets-file`; it is encrypted as a Worker-version secret and never written
to the repository or logs. Install the remaining Worker runtime secrets once
with Wrangler or the Cloudflare dashboard:

| Worker | Required runtime secrets |
| --- | --- |
| Staging | `SESSION_SIGNING_KEY_CURRENT`; Organisation registry supplied by the GitHub environment |
| Production | `SESSION_SIGNING_KEY_CURRENT`, `TURNSTILE_SECRET_KEY`; Organisation registry supplied by the GitHub environment |

`SESSION_SIGNING_KEY_PREVIOUS` is optional during a controlled session-key
rotation. Never share session or Organisation signing keys across environments.

## Environment isolation

The committed deployment contract is:

| Environment | Hostname | Snapshot bucket | Image bucket | Turnstile |
| --- | --- | --- | --- | --- |
| Development | `localhost` | `cloudflare-collab-canvas-dev-snapshots` | `cloudflare-collab-canvas-dev-assets` | Disabled |
| Staging | `staging-cloud-collab.spacescale.net` | `staging-cloud-collab` | `staging-cloud-collab-assets` | Disabled |
| Production | `spacescale.net` | `collab-canvas-snapshots` | `collab-canvas-assets` | Enabled |

Staging is deliberately automation-friendly. It has no Turnstile challenge so
Playwright and AI-driven testing can create disposable boards. Keep it isolated
from production data, signing keys, Durable Objects, and R2 buckets.

Production requires both `TURNSTILE_SITE_KEY` at deployment and
`TURNSTILE_SECRET_KEY` at runtime. Configure both from the same widget and allow
`spacescale.net` on that widget.

## Normal release

Run only the focused development checks appropriate to the change, then push:

```sh
git push origin development
git push origin development:staging
git push origin development:main
```

The final two pushes trigger their environment deployments. A full validation
run can be dispatched manually whenever requested.

## Cloudflare Workers Builds

Workers Builds may pull the repository and deploy with secrets stored at the
Worker level. It remains an optional alternative. Do not enable it for a Worker
that is also targeted by the GitHub deployment workflow, or both systems may
race to deploy different commits.
