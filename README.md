# Cloudflare Collab Canvas

A secure collaborative SVG whiteboard built for Cloudflare Workers, Workers
Static Assets, SQLite-backed Durable Objects, R2, and Turnstile.

The browser renders gestures immediately, while one `BoardRoom` Durable Object
per board validates, commits, sequences, and broadcasts every durable action
through the shared board reducer. SQLite is authoritative; private R2 objects
provide immutable recovery checkpoints and named snapshots.

## Development

Requirements: Node.js 22.19 or newer and a Cloudflare account.

```sh
npm install
cp .env.sample .env
cp .dev.vars.example .dev.vars
npm run cf:check
npm run cf:bootstrap -- --env development
npm run dev
```

Useful checks:

```sh
npm run typecheck
npm test
npm run test:edge
npm run test:e2e
npm run load:smoke
npm run security:scan
npm run cf:types
npm run build
npm run check
```

## Cloudflare setup

`.env.sample` is the source of truth for configuration names. Real secrets
must never be committed, printed in logs, placed in `wrangler.jsonc`, or exposed
to browser code. Copy `.env.sample` to ignored `.env` for provisioning scripts.
Copy `.dev.vars.example` to ignored `.dev.vars` for local Worker runtime
secrets. Production secrets are installed with Wrangler encrypted secrets or
the Cloudflare deployment API.

### Variables

| Name | Purpose and acquisition |
| --- | --- |
| `R2_BUCKET_NAME` | Private checkpoint/export bucket. Use a stable environment-specific name. `npm run cf:bootstrap` creates it; no R2 S3 key is needed. |
| `TURNSTILE_SITE_KEY` | Public site key from **Cloudflare Dashboard → Turnstile → widget → Site Key**. It may be exposed to the browser. |
| `SESSION_SIGNING_KEY_CURRENT` | Secret HMAC key for device sessions. Generate independently per environment with `openssl rand -base64 32`. |
| `SESSION_SIGNING_KEY_PREVIOUS` | Optional prior session key, accepted only during rotation. Leave empty on a new installation. |
| `CLASSROOM_INTEGRATION_KEY` | Secret HMAC key shared with the trusted classroom backend for participant-specific embed URLs. Generate with `openssl rand -base64 32` and keep it stable. |
| `APP_HOSTNAME` | Public hostname only—no scheme, path, query, or trailing slash. Example: `whiteboard.example.com` or a `workers.dev` hostname. |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins allowed to embed `/embed`. Missing, blank, or invalid configuration denies all framing; a literal `*` explicitly allows every parent. |
| `BOARD_CREATION_ENABLED` | Public fail-closed operational switch. `true` permits new boards; `false` preserves existing-board read/reconnect/export routes while rejecting creation. |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID from **Dashboard → account → Account home/Overview**. It is an identifier, not a cryptographic secret. |
| `CLOUDFLARE_API_TOKEN` | Secret Cloudflare management API token used by bootstrap/CI; it is not an R2 S3 credential. Creation and scope are below. |
| `TURNSTILE_SECRET_KEY` | Secret Siteverify key from **Dashboard → Turnstile → widget → Settings/details → Secret Key**. It must exist only server-side. |

### Exact API-token permissions

Create a custom token at **Cloudflare Dashboard → Manage Account → Account API
Tokens → Create Token → Create Custom Token**. For first-time bootstrap, grant:

| Resource scope | Dashboard permission | API permission name | Why |
| --- | --- | --- | --- |
| Include only the target account | Workers Scripts: Edit | `Workers Scripts Write` | Upload/deploy Worker modules and Static Assets, manage Worker secrets, and provision/bind the declared SQLite Durable Object class. |
| Include only the target account | Workers R2 Storage: Edit | `Workers R2 Storage Write` | Look up and create the private R2 bucket during bootstrap. |

Add no Zone, DNS, SSL, Workers Routes, D1, KV, Pages, Workers Tail, or broad
account permissions when using `workers.dev` or a Worker Custom Domain. Add a
TTL and client-IP restriction when CI has stable egress. Review the policy,
create the token, copy it once, and store it only in the local/CI secret store.

After the bucket exists, remove R2 Storage access and use a steady-state CI
deployment token with only **Workers Scripts: Edit** scoped to the one account.
Runtime R2 access comes from the private `BOARD_SNAPSHOTS` binding, not an API
or S3 credential.

Cloudflare does not support managing Turnstile widgets with account-owned API
tokens. Create the widget in the dashboard, or use a short-lived user API token
with **Turnstile: Edit** (`Turnstile Sites Write`) scoped to the target account,
then revoke it. Runtime Siteverify uses only `TURNSTILE_SECRET_KEY`.

Classic Worker Routes need **Zone: Workers Routes: Edit** for the single zone;
automating their DNS record additionally needs **Zone: DNS: Edit**. A Worker
Custom Domain needs neither permission. `wrangler tail` should use a separate
operator token with **Workers Tail: Read**.

The Turnstile widget uses action `board_create` for creation,
`invitation_claim` for invitation links, and `recovery_claim` for owner
recovery. The Worker verifies the returned hostname and exact action through
Siteverify; tokens are single use and never reach a board Durable Object.

The committed public deployment contract is:

| Environment | Hostname | Private R2 bucket | Turnstile |
| --- | --- | --- | --- |
| Development | `localhost` | `cloudflare-collab-canvas-dev-snapshots` | Disabled; Cloudflare test site key only |
| Staging | `cloudflare-collab-canvas-staging.spacescale.workers.dev` | `cloudflare-collab-canvas-staging-snapshots` | Required; dedicated staging widget |
| Production | `spacescale.net` | `collab-canvas-snapshots` | Required; dedicated production widget |

Production is declared as a Worker Custom Domain with `workers_dev` disabled,
so a deployment cannot silently fall back to an origin that fails the exact
origin and Turnstile-hostname checks. Staging uses its isolated `workers.dev`
hostname. Confirm the custom domain is active before production validation.

For each non-development environment, copy the public `TURNSTILE_SITE_KEY` and
secret `TURNSTILE_SECRET_KEY` from the same widget. Its hostname allowlist must
contain the exact hostname in this table. Do not pair a site key from one
widget with a secret from another, and do not reuse either widget between
staging and production. The bootstrap rejects hostname/bucket drift and
Turnstile test keys outside development.

### Provision and deploy

Verify the configured account, Workers access, R2 access, and Turnstile secret
without printing credential values:

```sh
npm run cf:check
```

`cf:check` also verifies that `APP_HOSTNAME` and `R2_BUCKET_NAME` identify one
committed environment. With a token that can read Turnstile Sites, it checks
the widget site key, hostname allowlist, and returned secret pairing without
printing any of those values. The documented least-privilege Workers/R2 token
cannot read widgets, so a `manualDashboardConfirmationRequired` result means
you must confirm the same-widget key/secret and hostname allowlist in the
Turnstile dashboard before deployment.

Provision an environment idempotently:

```sh
npm run cf:bootstrap -- --env production
```

The command reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` only from
the process environment (the npm script loads ignored `.env` when present),
verifies the committed environment/bucket configuration, creates the bucket
only when absent, and emits a machine-readable result without secrets. Reruns
against a correctly configured bucket succeed without mutation.

To deploy only after successful provisioning:

```sh
npm run cf:bootstrap -- --env production --deploy
```

Cloudflare can also pull this repository, run `npm run check`, and deploy it
directly with Workers Builds. Runtime secrets stay on the Worker, so this path
does not need a GitHub deployment API token. The exact dashboard settings,
staging separation, and rollout tradeoffs are documented in
[docs/deployment-ci.md](docs/deployment-ci.md#cloudflare-workers-builds).

Install runtime secrets before the first production request:

```sh
npx wrangler secret put SESSION_SIGNING_KEY_CURRENT
npx wrangler secret put CLASSROOM_INTEGRATION_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Install distinct staging secrets explicitly against the staging environment:

```sh
npx wrangler secret put SESSION_SIGNING_KEY_CURRENT --env staging
npx wrangler secret put CLASSROOM_INTEGRATION_KEY --env staging
npx wrangler secret put TURNSTILE_SECRET_KEY --env staging
```

Before running either bootstrap/deploy command, set `.env` to the selected
environment's bucket, hostname, and Turnstile widget credentials. For staging,
that means `cloudflare-collab-canvas-staging-snapshots`,
`cloudflare-collab-canvas-staging.spacescale.workers.dev`, and the public site
key from the same staging widget whose secret was installed above. Production
uses `collab-canvas-snapshots`, `spacescale.net`, and its separate widget.

During signing-key rotation, install `SESSION_SIGNING_KEY_PREVIOUS`, deploy code
that accepts both keys, rotate the current key, wait past the session window,
then remove the previous key.

For staging and production use distinct Worker deployments, Durable Object
namespaces, R2 buckets, session keys, Turnstile widgets, and origins. Never copy
production data into local development or staging.

## Architecture

```text
Browser (TypeScript + SVG)
  ├─ static shell → Workers Static Assets
  └─ HTTP/WebSocket → gateway Worker
                         ├─ creation/claim abuse controls
                         └─ BoardRoom Durable Object per board
                              ├─ authoritative SQLite state/actions/ACL
                              └─ immutable R2 recovery snapshots/exports
```

The BoardRoom's private SQLite database is the sole authority for whether a
board exists and for its current state. Ordinary board requests never depend on
R2 availability. The gateway applies bounded creation and claim buckets, and
those capability-issuing flows require action-bound Turnstile outside
development.

See [docs/operations.md](docs/operations.md) for deployment, rollback,
recovery, quotas, and incident procedures. GitHub environment, staging token
broker, approval, candidate-smoke, and rollback setup is in
[docs/deployment-ci.md](docs/deployment-ci.md).

Trusted-backend signing, iframe setup, live coach controls, co-owners, and the
activity feed are documented in
[docs/classroom-embedding.md](docs/classroom-embedding.md).
