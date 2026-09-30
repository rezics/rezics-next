# Release and rollback

These commands prepare local release images and Worker outputs. They never
push images, submit Cloudflare configuration or run Nomad jobs. The maintainer's
deployment repository owns those actions and the host placement described in
[deployment](deployment.md#production-fleet).

## Build and verify

1. Install the pinned toolchain with `task install`, then generate the reviewed
   model artifacts with `task gen`. Preserve a clean source revision for a release.
2. Run `task release:images`. It builds Main, relay, relay initialization, Account
   and migration roles from one digest-pinned Bun base, installs only their
   production dependency graph with immutable Yarn resolution, and includes the
   existing Fuseki image identity. It excludes environment files, fixtures,
   tests, developer dependencies and `.temp` from the payload.
3. Retain the printed `.temp/release-images/<input-digest>.json` with the release.
   It records source input digest, platform, base pin, local OCI config identities
   and image tags. Run the command again: changed identities under the same input
   digest fail. Local image IDs are not registry manifest digests; the deployment
   phase must record the registry digests returned by its push and pull by those
   digests. Never substitute a mutable tag during rollout or recovery.
4. Build Workers with `CLOUDFLARE_ENV=production task web:build`,
   `CLOUDFLARE_ENV=production task accounts:build` and
   `CLOUDFLARE_ENV=production task about:build`. Supply the registered
   `WEB_OAUTH_CLIENT_ID` to the web build. Production vars in each
   `wrangler.jsonc` contain `<VARIABLE_NAME>` placeholders: replace them with the
   deployment's configured origins, or supply the corresponding process variables
   to the Vite builds. Unresolved placeholders and loopback origins fail validation.
   Set `MAIN_ORIGIN`, `ACCOUNT_ORIGIN` and `MAIN_RESOURCE` for web;
   `ACCOUNT_SERVICE_ORIGIN`, `ACCOUNT_BASE_URL` and `WEB_ORIGIN` for Accounts;
   and `ABOUT_SITE_URL` in the about build environment (Astro uses it for canonical
   URLs). These are deployment inputs; this repository assigns no production
   hostnames. Retain the effective Worker vars with the release output so publishing
   uses the same configuration as the build.
   The about site's D1 binding is not inherited by Wrangler environments: supply
   its real production DB binding in the deployment repository before deployment.
   The production about command also bundles its Worker with Wrangler's dry run;
   the output is under `.temp/worker-builds/about` and no Worker is deployed.

The [Bun container guide](https://bun.sh/guides/ecosystem/docker) describes the
builder/runtime split. The build sets `SOURCE_DATE_EPOCH=0` to normalize image
timestamps as documented by [Docker](https://docs.docker.com/build/ci/github-actions/reproducible-builds/).
Local builds disable generated provenance/SBOM attestations, whose metadata can
change the image index on an otherwise identical rebuild. Publication must
attach its own verified evidence and retain the resulting registry identity.
Worker vars and bindings are environment-specific as documented by
[Cloudflare](https://developers.cloudflare.com/workers/wrangler/environments/).

## Validate and migrate

Use the existing envalid specs in `services/main/src/config.ts` and
`services/account/src/config.ts` to assemble a private production environment.
Use real public HTTPS origins, remote TLS SMTP with a verified sender, private
owner database credentials, graph capabilities, OAuth registration and S3
credentials. Development examples are descriptions of local setup and cannot
be copied to production. Keep credentials out of release manifests and images.

Run `task ops:env-check -- <private-env-file>` against the intended Access
database. Validation rejects loopback/Mailpit SMTP, fixture roots, `.temp` object
directories, placeholder credentials, development URLs and public non-HTTPS
origins. It also refuses every `commerce.payment_provider` row, including disabled
fake providers. A missing table is allowed only for a first installation; a
connection failure is not accepted. Container entrypoints run the same checks.

Run `task ops:migrate -- <private-env-file>` before starting application writers,
or run the `migrate` image with the environment injected by the secret manager.
The job applies Access, relay, Content and Account. A session advisory lock per
database serializes concurrent release jobs across each owner's DDL. Content
also takes its existing transaction lock. Each SQL migration commits with its
history record; a failed job can be retried and already committed Access, relay
and Content files are not reapplied. Tracking uses names or Content versions,
with no checksums, so recorded SQL can be edited in place. Account runs the same
Better Auth provider migration and idempotent `installConsentRefreshFence` steps
as development and QA, under the release lock. Its SQL is reapplied on every run;
the existing `public.rezics_local_migration` table records completed Account files.
A rerun reports only newly recorded files. No job silently reverses a migration.

Production `/health/ready` additionally requires this release's migrations to be
recorded in `public.rezics_local_migration` (Access, relay and Account) and
`content.schema_migration` (Content). Additional history is allowed. The checks
neither hash sources nor create a schema-seal table. Main also refuses a payment
provider row. Development readiness keeps its existing probes. Both APIs return
`{ "status": "ready" }`; Main's existing `/health/search-ready` reports graph data
epoch, sequence and index generation. Projection lag after a write affects search
readiness without making API readiness flap. Neither probe repairs a schema.
`/health/live` proves HTTP process liveness. Relay initialization and migration
are batch commands: their health signal is a successful exit, not an HTTP listener.
The relay is a long-running consumer whose process exit must be monitored by its
scheduler.

Fast configuration and schema-record tests run with
`task test -- scripts/ops/tests/g-722.test.ts`. The Docker image build and runtime
smoke test is an explicit live check:
`task test -- tests/live/g-722-images.test.ts`. It is deferred from affected plans
and stays outside unit selection.

## Roll out

Take the complete recovery cut described in [recovery](recovery.md), retain the
previous digests and Worker versions, and apply the edge pause below. Stop
application writers and the one Fuseki writer when changing a graph format;
never overlap two JVMs on live TDB2. Run migrations once from the pinned release,
initialize the relay checkpoint with its configured consumer and data epoch,
then start compatible writers and the APIs. Wait for both readiness probes and
Main `/health/search-ready` to confirm the expected epoch and index generation.
Release the three Workers separately, verify sign-in, private API calls, reads
and recovery, then remove the pause. Preserve release evidence with the recovery
set. Bootstrap and graph/index initialization are separate owner operations.

## Roll back

Pause new writes and stop the candidate. Reuse the previous recorded registry
digests and Worker versions only if they accept the current schema and graph
format. Migration records establish completion, not backward compatibility.
A schema rollback requires the
previous complete recovery cut restored into isolated volumes, its matching
release, owner/readiness checks and manual routing promotion as
[recovery](recovery.md) describes. Do not run an older migration job against a
newer history or reuse the candidate's database with an older unqualified image.

## Edge pause procedure

Create independent Cloudflare WAF custom rules for registration, uploads and
public posting on every externally reachable origin. Match HTTP method and the
normalized URI path; keep rules disabled until needed, and use a block response
that explains the temporary pause. Web forwards Main paths under `/api/main`,
so apply each Main match to both `/v1/...` and `/api/main/v1/...`. Restrict direct
Main and Account service origins to the deployment's authenticated access path;
a public bypass origin defeats this procedure. No application pause flag exists.

| Pause | Methods and paths from the current route declarations |
| --- | --- |
| Registration | `POST /api/auth/sign-up/email`, the enabled Better Auth registration endpoint on Accounts. |
| Uploads | `POST /v1/media/uploads`; `PUT /v1/media/uploads/{upload}/bytes`; `POST /v1/media/publications`. |
| Posting | `POST /v1/content-drafts`, `/v1/content-comments`, `/v1/content-publications`, `/v1/content-edits`, `/v1/contributions`, `/v1/contribution-publications`, `/v1/contribution-edits`, `/v1/member-reply-drafts`, `/v1/realm-replies`, `/v1/realm-reply-reviews`, `/v1/realm-reply-placements`, `/v1/reviews`, `/v1/publication-selections`, `/v1/works`, `/v1/fixed-releases`; `POST /v1/works/{id}/web-publications/{release}/snapshots`; `POST /v1/compositions/{id}/stages/{stage}/activate`. |

The paths come from [media](../../services/main/src/routes/media.ts),
[Content](../../services/main/src/routes/content.ts),
[contributions](../../services/main/src/routes/contributions.ts),
[member replies](../../services/main/src/routes/member-replies.ts),
[Realm replies](../../services/main/src/routes/realm-replies.ts),
[reviews](../../services/main/src/routes/reviews.ts),
[publication](../../services/main/src/routes/publication.ts),
[web publications](../../services/main/src/routes/web-publications.ts) and
[compositions](../../services/main/src/routes/compositions.ts), plus
[Works and releases](../../services/main/src/routes/works.ts).

The posting pause must also close the web's server-action entrance: block `POST`
requests carrying a `Next-Action` header and `POST /{locale}/studio/{agent}/new`
(including its trailing-slash form), where the progressive Studio creation form
submits without that header. Cloudflare exposes
[request header names](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.request.headers.names/)
for this match.
Match header names without regard to case and fail closed when the header
inventory is truncated. The current write action is
[Studio creation](../../apps/web/features/studio/actions.ts), mounted on the
[new Work page](../../apps/web/app/[locale]/studio/[agent]/new/page.tsx).
Blocking all action dispatch also pauses the Contents group expansion action;
ordinary reads remain available. Report, appeal, recovery and export use their
API/proxy paths and stay open. Review the action manifest for each release so
new progressive forms cannot bypass the pause.

Keep `POST /v1/reports`, `/v1/governance/process-steps` (including appeals),
`/v1/exports` and `/v1/erasures` open, including their BFF forms. Keep Account
`/api/account/recovery-claims` and its `/{claimId}/read`, `/approval` and
`/activation` routes, `/api/account/data-export`, sign-in, password reset and
verification open. These are declared in [reports](../../services/main/src/routes/reports.ts),
[exports](../../services/main/src/routes/exports.ts),
[erasures](../../services/main/src/routes/erasures.ts),
[Account](../../services/account/src/app.ts) and
[Account export](../../services/account/src/data-export.ts).

Before enabling a rule, run one blocked write and one report, appeal, recovery
and export through both the public API and the browser. A pause is qualified
only when those preserved paths work. After enabling it, repeat the probes;
disable the same rule to reopen that capability. Retain its rule ID, timestamp
and responder. New routes and server actions require another edge drill: path
rules cannot stop a new internal action that never traverses the matched public
URL. A comprehensive application admission switch is deferred to G-737.
