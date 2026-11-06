# Local development stack

Use Bun, Docker and Go Task (`task`, or the repository's `go-task` binary). From a fresh checkout:

```sh
bun install --frozen-lockfile
task dev:infra
task dev
```

`dev:infra` starts persistent PostgreSQL and OpenSearch, migrates Kernel and a separate `rezics_auth` database,
creates development keys, configures the Web worker, supplies Content's exact source-host list to Kernel's API, and
configures the shared content worker's storage. It can be repeated. Identical generated configuration is not rewritten, so repeating setup
while app servers run does not trigger configuration reloads. An interrupted setup can be repeated too.
`dev` also runs setup, then starts these processes together; Ctrl-C ends the processes it launched and leaves
infrastructure running. A child startup failure ends the other children.

| Service                      | Loopback address       |
| ---------------------------- | ---------------------- |
| Web                          | http://127.0.0.1:3000  |
| Auth pages and public issuer | http://127.0.0.1:4200  |
| Native Auth behind the pages | http://127.0.0.1:3100  |
| Kernel API                   | http://127.0.0.1:4100  |
| Kernel background worker     | No HTTP listener       |
| PostgreSQL                   | 127.0.0.1:54329        |
| OpenSearch                   | http://127.0.0.1:59200 |

Open Web and choose Sign in. Auth offers password sign-in, passkeys and sign-up. Sign-up works without an email
provider or Cloudflare account. The development widget completes locally; it and its verifier exist only in the
explicit local host. Use `127.0.0.1` throughout, including callbacks. Cookies are host-bound. The API token audience
remains `https://api.rezics.test`; it is an identifier, not an external network dependency. Dependency installation,
the first Docker image download and dataset downloads still need network access.

When `WEBSITE_CONFIGURATION_FILE` selects a deployment's public registration artifact, local Auth registration,
generated Web bindings and Web launch use its exact scopes. Setup never rewrites that artifact. Without it, scopes
come from the mounted Kernel action catalogue. Relative artifact paths resolve from the repository root before Web
starts in its workspace. After changing registration scopes, sign in again for new consent;
changing origins or restarting the stack does not renew existing session authority.

## Persona and import permissions

```sh
task dev:persona
task dev
# In another terminal, after the stack is ready:
task seed:dev
```

The one persona task provisions `developer@rezics.test`, prints its generated password and account ID, installs its
importer credential through native credential authorization and writes `.temp/local-stack/seed.env` for `seed:dev`.
Native Auth startup also provisions this persona, so first-run public reads work without a separate manual bootstrap.
`seed:dev` repeats `dev:persona` before invoking the existing dump/seed producer, reloading the private `seed.env`
even on its first invocation. Keep `task dev` running and wait for normal readiness before seeding. Repeating either
task reuses the developer, account key and ordinary exposure command keys; the native local bootstrap receipt does not
restore a grant that an operator later revokes.
The persona owns the development platform governance role, including `gate:any`, Access grant authority and the
cross-media importer's subject, statement, source-statistic, source-fence and media-import permissions. The importer
client requests only its import scopes. The separate `rezics-dev-showcase` first-party client requests Board,
thread, source-read, edition, Commerce, Collection and personal Library scopes. The local stack installs that developer's direct `board:create`
grant on Global Context using a one-time native bootstrap receipt; Board creation itself uses the ordinary authenticated
`POST /v1/boards` command and current Access checks. This grants no production authority and does not change the
platform governance policy. The same person can sign into Web using the printed password. Local database setup supplies a finite
100,000-command/minute write budget for new and member accounts through the ordinary deployment override, so
a fresh persona can submit the bounded dataset batches. Explicit existing overrides are preserved; all other rate
families, authorization and operator checks retain their normal policy.

`seed:dev` first finishes the existing finite import and publication. Its local showcase stage binds the selected
VNDB `v2002` work from the returned native read identities, creates or resumes one published Global discussion Board,
confirms it in the anonymous discussion directory, then creates one original `CC-BY-4.0` thread on that Board. The
same thread supplies the exact authored source for native Content edition creation and separate publication. The
Commerce step reads the current money schema and uses its minimum configured sale amount in an ordinary offer create;
Content or the seed does not infer eligibility. The native creator edition and offer lists must both return the exact
source binding before the outcome is complete.

The local Board, thread, edition, and offer commands reuse the `showcase.sqlite` action journal, fixed command keys,
original client and credential identities. Unknown delivery retries the frozen request; refusals and unavailable
readback are recorded separately and stop the dependent steps. A successful result adds `developmentShowcase` to
`.temp/cross-media-seed/result.json`, including actual work, Board, thread, post, edition and offer IDs without
credentials. Repeating `seed:dev` resumes the same native commands. `task dev:reset` retires the complete active seed
directory first, so the new database imports and binds fresh native identities.

Decision: keep the importer client import-only, use a separate local first-party showcase client, bootstrap only
`board:create` on Global Context for the developer, and bind the ordinary published discussion Board plus authored
edition and eligible offer to the exact selected VNDB `v2002` native Subject identity.

Decision: local persona setup opens mounted anonymous GET exposure groups plus the explicit M1 `search` (path 9,
mixed Search), `search_advanced` (path 10, filters and POST `/v1/subjects:facets`), and `personal_library` for the
protected VN source-statistic writer (path 2) and personal Library (path 20), through ordinary platform
commands; `seed:dev` composes that same setup. Future additions must name a concrete M1 path here and in the bounded
list in `services/auth/scripts/dev-stack.ts`; anonymous POST routes are not scanned for openings.
Production configuration and unlisted private/write gates retain their defaults.
A public exposure opening admits that group, while ordinary route and resource permissions still apply. Kernel and
both app servers bind loopback. Do not expose this development database or host to a network.
If an opening fails, setup reports the group and native error, exits unsuccessfully and tells you which task to rerun
after resolving it. Seed does not continue after a failed persona step.

### Upload the development persona's private VNDB list

Decision: `REZICS_DEV_VNDB_EXPORT` names the persona's actual private VNDB version 1.0 export; missing input stays
unavailable and prevents a complete showcase report. The seed does not synthesize personal activity from catalogue
records. Supply an owner-only regular UTF-8 file under `.temp/` before running `task seed:dev`; the native preview
owns XML/version admission. The separate showcase client requests `library_entry:update` through the existing
personal Library gate and own-account authority, without adding platform grants.

The mounted wrapper uses the generated authenticated Kernel client and the common `showcase.sqlite` upload journal.
It seals the original persona, client, credential identity, destination, XML and idempotency key before sending.
Unknown delivery reuses that exact intent after reopen. A changed identity cannot resend the private export;
permanent refusals stay terminal. Successful replay still visits native authorization and must return the original
upload UUID and row count. The response is journalled before disclosure. Only those actual response fields enter
`developmentShowcase.personalList`; no export bytes or local export path enter the result or diagnostics. The seed
directory is mode 0700 and the showcase journal and combined result are mode 0600.

- Touches: one private export and one preview action plus its response in the existing journal; no review/apply,
  status, Progress, vote or Library activity is inferred from an upload acknowledgement.
- Bound: 2 MiB source input, the existing 2 MiB serialized request ceiling, one application preview call per run,
  at most three HTTP attempts within 30 seconds, and the existing 1 MiB response cap; at most 5,000 reported rows.
- Growth check: `services/importer/tests/showcase-personal-list.test.ts` covers exact process reopen, changed
  custody, response identity, terminal refusal and private file admission; `services/importer/test/cross-media-local-seed.test.ts`
  verifies the mounted authenticated request, actual response handoff, permissions and absence of private export
  data from the combined result. Native private-list lifecycle and browser acceptance remain integration-owned.

### Compose the development persona Collections

Decision: persona fixtures use native curated occurrence order and released Type presentation; grid is a client
layout, and mixed presentation stays `null`. Selection order is not an absolute catalogue rank or a personal state.
The ranked fixture contains the exact selected VNDB roots, grid contains the selected Bangumi roots, and mixed
contains both in that order. A homogeneous fixture selects its actual current Type; heterogeneous roots stay mixed.

The existing development wrapper calls this component inside the cross-media CLI's open `ShowcaseJournal` lifetime,
after source publication. Its native outcomes are retained in the existing result file and the wrapper report. Each exact source-key/native
UUID pair is reread anonymously, including its provider identifier and Type; matching titles never join identities.
The report preserves the supplied work-link handoffs. Collections are owned by the development persona through
ordinary Collection commands, with the separate showcase client credential using `subject:read` and Collection create/read/update
scopes. Ordinary importer scopes and platform grants retain their existing contracts.

Prepared action bodies, keys and acknowledged UUIDs live in the common showcase journal. A lost response retains
the original operation for exact replay; a permanent refusal stays terminal. Creator and anonymous reads verify
current owner, kind, occurrence IDs, Subject IDs and order. Missing or changed current membership is incomplete and
does not create replacement identities. A missing source never truncates a retained Collection.

The wrapper retains Content's delivered `seedDevelopmentContentEdition` and Commerce's delivered offer helper.
Collections report only their current native outcomes; the wrapper combines them with the actual published edition
and eligible offer readback. Completion requires all three current Collections as well as the producer outcomes.
Decision: Collection scopes belong to the separate showcase client; the importer client keeps its existing scopes.

- Touches: three native curated Collections, ten ordered occurrences for the five selected roots, and their common
  showcase actions; each action stores one acknowledged UUID beside its sealed body/key.
- Bound: five source reads, at most thirteen create/member operations and twelve creator/public readbacks: thirty
  application HTTP calls on first completion and seventeen on exact rerun. The existing transport allows at most
  three sends per call within a 30-second deadline, 4 KiB request and 256 KiB response. Local journal work uses indexed
  action-key lookups; SQLite counts are not PostgreSQL work measurements.
- Growth check: `scripts/datasets/development-showcase-seed.test.ts` pins exact reopen, unknown delivery, permanent
  refusal and unavailable current reads; `services/kernel/test/imports/showcase-persona.test.ts` binds the component to
  source publication and native Collection commands. Collection presentation/growth and Content publication remain
  separate producer acceptance; combined persona, offer, doctor and served-page acceptance remain with integration.

## Imported covers and Character images

`dev:infra` trusts the exact Bangumi media host `lain.bgm.tv` for selected cover and Character image imports. It adds
that host to an explicit `CONTENT_SOURCE_HOSTS` list without removing the operator's entries. When no complete R2
storage group is configured, it selects the development-only file store at
`.temp/local-stack/content-media` and sets `NODE_ENV=development` for Kernel. The API reads the same source list as
the shared content worker; that worker writes originals and normalized variants through the existing `MediaStorage`
port. Each object is limited to 20 MiB and keys remain under the fixed local root. Re-running setup and restarting
Kernel preserve the reservations and stored bytes. A complete R2 group remains selected unchanged; a partial R2
group fails with the name of its first missing variable.

Decision: local development uses the existing media port with a fixed 20 MiB-per-object file store and the exact
Bangumi media host `lain.bgm.tv`; R2 remains the only production storage configuration.

## Keys and reset

Generated Auth signing, website, importer, and staging keys and the persona password live under
`.temp/local-stack/` with private file permissions. Kernel `.env` retains separate session, receipt, write-rate, route and rating
keys across restarts, and supplies the local Auth issuer, audience and JWKS URL to both API and worker. Native Auth and the worker share Kernel's purpose-separated reference seal ring.
`apps/web/.dev.vars` contains the local website client key and loopback bindings. All generated files are ignored.
Generated bindings use literal dotenv quoting so the website JWK remains valid JSON.
Local setup also supplies a 10-second pool connection allowance for parallel cold startup on busy hosts, preserving
explicit overrides. Native request deadlines and authorization remain unchanged.
An authorized persona password rotation may retain its original registration input as `bootstrapPassword` in the
private key file; sign-in uses the current password. Database reset drops that obsolete bootstrap input before
registering the current password on the fresh database.
Local setup owns `apps/web/.dev.vars`; keep deployment secrets in deployment configuration. Production entrypoints
never import the development host or create these grants.

If a database was created from an incompatible migration baseline (for example, `relation "revision" already exists`),
stop your local `task dev` and run this one command:

```sh
task dev:reset
```

This explicitly deletes the configured local PostgreSQL container and volume, including both development databases,
then migrates fresh databases. When the fixed local media root is selected, it also removes only
`.temp/local-stack/content-media`; it never deletes an R2 bucket or other files under `.temp/local-stack`. It keeps
generated keys and the OpenSearch volume, and allocates a fresh local search
namespace so generations in the deleted database cannot collide with retained indices. Ordinary setup preserves that
namespace. It retires the active local importer journals under
`.temp/local-stack/seed-archives/`, preserving their contents while the next seed starts without old native UUIDs. Re-run `task dev`; the persona and
public-read openings are rebuilt. This command is destructive: use it only for your own development stack, never a
shared database. It never prunes Docker. Normal `dev:infra` never resets data automatically.

Individual commands are `dev:web`, `dev:auth` (pages), `dev:auth:host`, `dev:kernel` and `dev:worker`. Complete sign-in
needs the full stack. PostgreSQL and search ports can be changed with `KERNEL_DATABASE_PORT` and `KERNEL_SEARCH_PORT`;
container and volume names can be isolated with `KERNEL_DATABASE_CONTAINER`, `KERNEL_DATABASE_VOLUME`,
`KERNEL_SEARCH_CONTAINER` and `KERNEL_SEARCH_VOLUME`. App and issuer ports above are fixed for local callbacks.

## Walk stacks

A walk-and-repair task runs the product on a seeded stack as each persona and repairs what it finds. Its worker starts
one bounded stack with `walk` below when its brief lists `acceptance.requires` with `native` or `browser`; the control
plane passes that list to the worker as `GOAL_ACCEPTANCE_REQUIRES`. Every other worker is still refused local stack
containers, and its checks keep the remote placement in [scripts/README.md](../../scripts/README.md#check-hosts).

```sh
bun services/auth/scripts/dev-stack.ts walk -- <command...>
```

`walk` runs in this order:

1. Waits for a walk slot. At most `REZICS_WALK_STACKS` stacks (default 6; an integer from 1 to 1000) run on the host
   at once, counted across worktrees under the main checkout's `.temp/walk-stacks`. A further start waits in arrival
   order and prints its position, `walk <task> waiting (<held>/<limit> held, <n> ahead)`. It is never refused.
2. Names the stack's containers and volumes `rezics-walk-<task>-database` and `rezics-walk-<task>-search`, and gives
   it its slot's loopback ports: `20000 + 10 × slot` plus 0 for Web, 1 for the Auth pages, 2 for native Auth, 3 for
   Kernel, 4 for PostgreSQL and 5 for search.
3. Runs `db up`, `search up` and `setup`, starts the processes `dev` starts, and waits until Web and the Auth pages
   answer, for at most ten minutes. Its output goes to `.temp/walk/<task>/stack.log`.
4. Runs `<command>` in the caller's directory with the stack's names, ports and origins. Persona and seed steps belong
   inside `<command>`, for example `dev-stack.ts persona` followed by `task seed:dev`.
5. Stops the processes, removes the stack's containers and volumes, and releases the slot when the command ends or the
   attempt receives SIGHUP, SIGINT or SIGTERM. A stack left by a killed attempt is removed when the same task next
   starts.

A walk stack is admitted only while the slot lock its launch holds is held: the environment names the slot, but the
name alone does not admit a container. Walk stacks do not change check placement; the worker's checks still run on
hosts a and b.

Decision: walk stacks are a bounded, queued replacement for the local-container refusal, granted only to workers whose
brief lists native or browser acceptance.

Decision: keep one causal binding regression and the existing launcher assertions. Kernel setup persists the selected
loopback Auth issuer, audience, JWKS URL, Kernel host and API port in `services/kernel/.env`; start applies the same
tuple after reading that file, overriding a previous stack's identity. Native Library growth and browser qualification
remain separate acceptance outcomes.

## Cross-media dump cache

`seed:dev` fetches the pinned Bangumi Archive release and a VNDB dump, verifies them, extracts source tables and seeds
Kernel over loopback HTTP. Later runs reuse the dump cache; state and the import report stay under
`.temp/cross-media-seed/`. The cache defaults to `/home/edge/projects/rezics/rezics-datasets/dumps/`;
set `REZICS_DATASETS_DUMP_CACHE` to choose another location. Bangumi is pinned by URL and SHA-256.

Decision: `seed:dev` uses the exact November 4 VNDB snapshot, ignoring other manifest-selected dumps and never
substituting a rotated archive. General VNDB acquisition retains its rotating-dump behavior.

The development pin is `vndb-db-2026-11-04.tar.zst` from https://dl.vndb.org/dump/, SHA-256
`fadbe611c4d6475ef63a0c1861512bc9ff64d21c6c9804a988522c7c65f6fa85`, with archive `TIMESTAMP`
`2026-11-04 08:00:24+00`. Both cached and downloaded archive bytes must match the pin. Extraction checks tar
integrity, required tables and `.header` files, and the exact timestamp before recording `vndb/manifest.json`.
Missing or changed pinned bytes stop the seed; it does not continue with Bangumi alone. Restore the exact archive
in the dump cache when the provider rotates it away. Changing the pin is an explicit source-generation change.
VNDB's dump metadata licence remains independent of image rights. The wrapper's returned and persisted
`developmentShowcase.sourceSnapshots` carries the verified archive URL, filename, SHA-256 and metadata licences for
both providers, plus VNDB's verified TIMESTAMP, even when later publication is incomplete.

The general `fetchVndbDump` helper, when called without a pin, first tries the inventoried URL and resolves a rotated
404/410 through the provider's dump index. It verifies structure and records the resolved filename and SHA-256 for
machine-local reuse. This mode does not establish the development seed's pinned acceptance generation.

The seed's `REZICS_DEV_PERSONA_*`, `AUTH_ORIGIN` and `KERNEL_ORIGIN` environment seam also works with a manually
configured local account. Seed origins accept HTTPS or loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`).
