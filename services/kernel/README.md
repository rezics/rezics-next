# Kernel

The kernel workspace owns the database records and adapters used by the service.

## Development database

Run `bun run db up` from `services/kernel` to create or start the local PostgreSQL database, apply migrations, and write
its connection string to `.env`. Use `bun run db down` to stop it while keeping its volume, `bun run db reset` to remove
and recreate the database, and `bun run db dump` to update the committed schema dump. Dumps run `pg_dump` inside the
running database container, using its PostgreSQL version. The check command uses its disposable database container;
the development dump command uses the local development container. Callers that do not set `KERNEL_DATABASE_CONTAINER`
retain the `docker run` fallback.

## Development search node

Run `bun run search up` from this workspace to create or start the local OpenSearch node and write `OPENSEARCH_URL`
to `.env`. `KERNEL_SEARCH_PREFIX` optionally selects the index prefix and defaults to `rezics-`. Use
`bun run search down` to stop it while keeping its volume, or `bun run search reset` to remove and recreate it. The
check command starts its own disposable OpenSearch node.

## Rebuilding the search index

Run `bun run search rebuild` from this workspace to build the next subject generation and switch the alias to it.
Set `DATABASE_URL`, `OPENSEARCH_URL`, and the deployment's `KERNEL_ROUTE_KEY` (canonical unpadded base64url encoding
of exactly 32 bytes). Rebuild validates the route key before opening the database pool and supplies it to the source
for imported-source fence checks. Other server credentials are not required; `up`, `down`, and `reset` need no route key.
The worker replays the log into the new generation. A failed rebuild reports one of `timeout`, `mismatch`, `busy`,
`running`, or `limit`. The previous generation is deleted 15 minutes after the switch.

## Run the kernel

Run `bun run db up`, then `bun run dev` from this workspace to serve the API locally. The server reads
`DATABASE_URL` (required), `KERNEL_ROUTE_KEY` (required), and `KERNEL_SESSION_KEYS` (required) from the environment.
`KERNEL_HOSTNAME` defaults to `127.0.0.1` and `KERNEL_PORT` defaults to `4100`. `db up` generates the development
secrets once and keeps them in `.env` across restarts. `KERNEL_POOL_ACQUIRE_TIMEOUT_MS` defaults to 200 ms and accepts
whole millisecond values from 50 through 10,000; other values fail startup. Before serving requests, the server opens
all 10 PostgreSQL pool connections and keeps them open while idle. The worker also requires
`KERNEL_RATING_COUNTER_SECRET`, a canonical base64url value containing at least 32 bytes, shared by every worker
instance so controller counts remain stable.

Commerce settings are optional and all or nothing: `STRIPE_SECRET_KEY`, `STRIPE_MANAGED_PAYMENTS`,
`CHECKOUT_SUCCESS_URL` and `CHECKOUT_CANCEL_URL` are required when enabled; the API also requires
`STRIPE_WEBHOOK_SECRETS`, and `STRIPE_API_HOST` is an optional endpoint override. With none set, the API serves
commerce reads but refuses order creation with `dependency_unavailable`, and the worker registers no commerce
workflows. If any setting is present, startup validates the required values and names the first missing or invalid one.

Bearer tokens are verified against the Auth service. The first request that carries one reads `AUTH_ISSUER`
(the Auth service's canonical origin), `AUTH_AUDIENCE` (the API's HTTPS URL) and `AUTH_JWKS_URL` (the Auth
service's public JWKS URL, on the exact issuer origin). Without them the kernel still starts and serves anonymous
requests, and refuses every bearer token. Production `AUTH_AUDIENCE` is fixed to `https://api.rezics.com` (no trailing
slash), shared with Auth and RFC8707 website resource parameters; tests use `https://api.rezics.test`.

Issuers require HTTPS except for canonical HTTP origins on exactly `127.0.0.1`,
`localhost` or `[::1]`, including the configured port. Issuers have no userinfo,
path, trailing slash, query or fragment. Numeric aliases, suffix tricks, other
private/LAN addresses and `0.0.0.0` are rejected. HTTP public JWKS is permitted
only for an approved HTTP issuer on the exact same origin and port, with no
userinfo, query or fragment. Token issuer identity includes the port; request
Host headers do not configure it. The API audience remains HTTPS, including for
local issuers: `https://api.rezics.com` in production without a trailing slash,
and `https://api.rezics.test` in tests. Verification still uses standard JOSE,
cached public keys and current account state, epoch floor and fence checks;
failures retain the `invalid_token` response.

## First governance grant

An operator with deployment database access can grant platform governance to one explicitly named,
already active human account. From the repository root, run:

```sh
DATABASE_URL='postgres://...' bun services/kernel/scripts/bootstrap-governance.ts --account <id>
```

`DATABASE_URL` must name the migrated deployment database, including its seeded Global Context at route 0,
`00000000-0000-8000-8000-000000000000`. The command registers Reylo before dynamically importing SQL-bearing
code, so the root invocation needs neither a preload flag nor the kernel workspace's Bun configuration.
Malformed arguments fail before database access. Missing, pending, suspended, deleted, organization, automated
and authentication-fenced accounts refuse. No HTTP route, Auth signing key or first-user inference participates.

The native Global-partition command commits a durable one-time marker, one ordinary `platform.governance`
resource role grant and one `com.rezics.access.governance.bootstrapped.v1` audit/outbox event together.
The audit contains only the governance account, Global resource and role. Repeating the same account is a no-op;
another account refuses. The marker survives grant revocation, so rerunning the command cannot restore rights.
Concurrent invocations select one winner, and a failed commit leaves none of these effects.

The role expands from `src/access/platform-governance.json`, intersected once at app composition with its trusted
mounted action catalogue. Missing modules contribute no callable actions. All other role validation stays strict.
Later delegation and revocation use ordinary grant commands: the grantor needs management and every delegated
action on Global, with actual client scopes as a separate ceiling. Governance grants imply no rights on other
resources, including resources owned by that person or routed to the same partition.

Account lifecycle and Auth credential establishment precede this operation. The native tests compose registration
receipt verification, Auth provisioning evidence and lifecycle activation directly. The host still needs to carry
exact pending receipt metadata through its provisioning composition: the generic `createAuthBindings` identity
approval alone does not supply that metadata. Bootstrap consumes the resulting committed active human account;
it adds no public registration or client flow.

Derived cost: with `R = N + U*t + M`, each attempt reads the exact named account on its anchor at the native
attempt's authoritative time, releases that connection, then seeks the existing Global row and marker key.
First installation changes one marker, one role row and one audit event, plus the normal partition fence.
A no-op or refusal reads the marker and writes no receipt, grant, fence or event. Rows and statements are constant;
native index buffers are `O(log R)`. Role expansion is bounded by the explicit action data at composition and
creates no per-action governance rows. There is no account scan or cross-partition transaction.

The shared 1x/8x/64x growth checks grow accounts, community contexts, same-Global unrelated grants, unrelated
receipts, same-account receipt history and outbox history at fixed actions. Warm native attempts use 5 statements
for first installation and 3 for no-op/refusal; cold exact CLI processes use 9 and 5 respectively, including Reylo's
fixed schema-catalogue validation. Both paths check constant examined rows/statements and logarithmic shared
buffers using native `auto_explain`, without wall-clock bounds or planner forcing. This adds no recurring global
hotspot beyond the fixed platform resource's intentional one-time installation.

## Durable work

Run `bun run worker` for the kernel's single durable-work process. It requires `DATABASE_URL` and accepts
`KERNEL_EXECUTOR_ID`, falling back to `NOMAD_JOB_NAME` plus `NOMAD_ALLOC_INDEX` when configured, or the SDK's local
identity. `KERNEL_WORKER_POOL_SIZE` defaults to 10 and must be between 1 and 100; the module pool, enqueue client and
SDK share this bounded pool. SIGINT and SIGTERM stop dispatch and drain in-flight workflows before closing it.
Migrations, not the worker, create and upgrade the `dbos` schema.

The worker registers the six ADR-0033 queues once, calls every module registration in order, then launches DBOS
once. Governance has separate concurrency; import work supplies its source as `queuePartitionKey`. A module exports
one `WorkModule` registration for its workflows, effects and schedules and adds one entry to `KERNEL_WORK_MODULES`
in `src/work/modules.ts`, just as its HTTP routes register in `createKernel`. Registrations receive the pool, queue
options and work client. Duplicate module names and registration after launch are refused. Modules never launch
DBOS or create their own worker. The list is empty until modules add their work.

Every test that starts the shared kernel worker takes its environment from `workerTestEnv(overrides)` in
`test/support/worker-env.ts`. Use `overrides` for optional all-or-nothing groups such as commerce's Stripe settings.
Add a fixture there whenever a module adds a required worker variable; `test/support/worker-env.test.ts` fails when a
module's required variable has no fixture.

API processes use `createWorkClient(databaseUrl)` from `src/work/client.ts` to enqueue by workflow and queue name,
pass that client to modules, and call `close()` on shutdown. Enqueueing needs no running worker; the next worker
runs the persisted work. A workflow ID provides idempotency only while its workflow row is retained; never reuse an ID
for idempotency after retention may have deleted that row, because DBOS will treat it as a new workflow.

The retention module collects only `SUCCESS`, `ERROR`, `CANCELLED` and `MAX_RECOVERY_ATTEMPTS_EXCEEDED` workflows
whose `completed_at` is older than the configured period. Each list query uses that same strict cutoff for DBOS's
`endTime`, which bounds `created_at` so an ordered scan stops at the cutoff instead of walking later retained workflows.
The short-batch growth check measured `Limit -> Sort -> Index Scan using idx_workflow_status_completed_at`; the
full-batch history plan is `Limit -> Index Scan using workflow_status_created_at_index`, filtering completion and
status row by row. Short-batch work is O(long-lived workflows + batch + log N), independent of later retained history.
`KERNEL_WORKFLOW_RETENTION_DAYS` defaults to 30 and accepts whole numbers from 7 through 365. A UTC schedule runs every
10 minutes; each run deletes at most 60 batches of 1,000 workflows, oldest first, with each batch committed by the DBOS
SDK in its own transaction. Children are retained independently. Rows kept are about workflow rate × (retention period
plus 10 minutes), provided the rate stays below the sweep capacity of 8.64 million workflows per day.

### Membership workflows

The default `accounts` WorkModule resolves persisted native workflow approvals through installed Access. Registration
reads `WorkContext.env`, validates the configuration before registering steps, and reports `ConfigError` with the
invalid variable's name. It requires `KERNEL_ROUTE_KEY` (canonical base64url, exactly 32 bytes), `AUTH_ISSUER`,
`AUTH_AUDIENCE`, `AUTH_JWKS_URL` with the public-verifier URL rules above, and a reference key ring.
The three Auth values are passed explicitly to installed Access; supplied contexts never fall back to `process.env`.
Only Auth's public JWKS is used. The module does not construct an Auth host, pool, provider or maintenance runtime.

When `KERNEL_SESSION_KEYS` is supplied, the module reuses that existing deployment ring: comma-separated
`kid:canonical-base64url` entries, with the first key current, at most four distinct canonical decimal IDs in 0–255,
and each key at least 32 bytes. The value is bounded to 8192 UTF-8 bytes. This takes precedence over the workflow-only
setting; the caller must use the same deployed ring. Seal purposes separate approvals from session tokens.

Otherwise `KERNEL_WORKFLOW_REFERENCE_KEYS` is required, as JSON of at most 8192 UTF-8 bytes:
`{"current":7,"keys":{"7":"<canonical base64url key containing at least 32 bytes>"}}`.
Use exactly the same key ring in the caller's `createWorkflowApprovals`. There must be one to four keys, with canonical
decimal key IDs from 0 through 255, an integer `current` naming an existing key, and no duplicate properties, unknown
properties, padding or noncanonical base64url. Configuration parses once per module registration. Keep old keys while
outstanding approvals need them. The existing accounts expiry registration also reads the optional
`KERNEL_WRITE_RATE_EXPIRY_PARTITION` (0–4095) and `KERNEL_WRITE_RATE_EXPIRY_NODE` admission; without a partition it
installs no schedule. These are all accounts-module environment reads.

Organization membership input maps to native `AccountOperation` membership with exactly `organizationId` from
`principal.id`, `memberAccountId`, `role`, optional `reservationId` and `authorization`. Native immutable operation-key
and digest binding, original scopes, delegator and epoch floor remain authoritative. Every protected registered
reserve and publication step resolves the exact sealed approval afresh; publication also performs the native final command-time authorization.
References are opaque nonempty locators bounded to 4096 characters, including native dotted seals. Enqueue rejects
JWTs, bearer strings, raw contexts and unknown fields. It never decodes a locator for authority, and persists no bearer
or resolved actor. Native expiry denies even if approval cleanup has not run.

Reserve precedes publication; leave commits authoritative removal before inverse release. Failed joins terminalize the
exact authoritative reservation before inverse cleanup. Cleanup uses that native terminal proof and remains possible
after approval revocation or self-removal, without restoring membership authority. The existing 1000-membership cap,
historical intervals and native receipt semantics remain in force. Command keys derive from the stable workflow
identity and fixed phase; no module contention retry or additional DBOS launch is installed. Explicit trusted component-test injection remains available.
Organization creation and Realm operations still have no native approval descriptor and remain unavailable by default;
they need their owning adapters. Component fixtures establish domain rows and test JWTs, not ordinary registration,
final lifecycle/API assembly or a website provider.

With `R = N + U*t + M`, resolution seeks one sealed exact approval row on the actor anchor in `O(log R)`. Installed
actor-side authorization costs `O((1+K) log G + matches)`, with `K <= 1000`. Fixed reserve, publication and release
commands each use one anchored partition and `O(log R)` point mutations. No ACL, history or table scan or held
cross-anchor connection is introduced. `growth-native-membership-work.test.ts` measures actual native resolution and
workflow commands at three scales of prior approvals, membership intervals and unrelated accounts, with constant
statements and rows at fixed K and logarithmic buffer bounds, without timing assertions or planner forcing. Existing
process-death ordering, compensation and cap tests continue independently.

## Check

Run `bun run check` from this workspace. It starts a disposable PostgreSQL database, applies migrations and checks the
schema dump, runs TypeScript, lint and formatting checks, then runs each test file on its own copy of the migrated
database. A plain `bun test` shares one database across files, so run a single file when not running the check. The test
database is removed at the end.
Every test file's processes read Reylo's SQL analyses from one analysis database cloned from the template once, named by
`REYLO_CONFIG`, so no file re-analyses the statements it imports against its own copy.
Each test file gets `KERNEL_POOL_ACQUIRE_TIMEOUT_MS=2000` so cold connections have more time to establish on a loaded check host.

New kernel tests compose their app, Access and kernel through `test/support/test-kernel.ts`. `testKernel` mirrors the
production route catalogue, Realm role reader and write-rate stage, substituting its supplied test pool, local Auth/JWKS
and fixed route key. `testApp` mounts the same app stage and builds Access from its mounted actions; `testAccess` uses the
production Access constructor, Realm role reader, resource roles and resource-type binding. Pass a named override such
as `clock`, `actions` or `writeRate` only when a test needs to vary that contract. Use `registerTestClient` to register a
client from the mounted production scope set, with a named `scopes` override for tests that exercise narrower consent.
Use `writeTestReceipt` for production-shaped receipt and optional write-basis fixture rows.
When a task changes a kernel-wide contract, run the full kernel check and fix every test the change turns red.

Run `bun run check <path>...` to check named files and run any named test files; paths are relative to this workspace.
The full `bun run check` is what the gate runs.
A test file whose every failure is a growth bound error is rerun alone once after the suite, under a stack slot; a file that
passes alone is reported as load-sensitive and does not fail the run.

Affected mode, `bun run check --affected <rev>` or `KERNEL_CHECK_AFFECTED=<rev>` (the flag wins), runs only the test
files that import a path changed since `<rev>` (committed, staged, unstaged or untracked), or the whole suite when the
selector cannot place a change, and prints its selection first; named files ignore it. The full run stays the gate for
promotion.

A computed dynamic import hides what it loads from the selector. `scripts/affected-reach.ts` lists, for each such site,
the files it can load; a site listed there depends on those files, and an unlisted computed import still runs its tests
on every change. An entry that no longer matches the code selects the whole suite.

Each check run writes every test file's wall, database create and drop, and per-test times to
`.temp/kernel-check/timings/<UTC timestamp>.json` in the main checkout (`KERNEL_CHECK_TIMINGS` overrides the directory)
and replaces `latest.json` there. Files run longest first by `latest.json`, files without a recorded time first;
`KERNEL_CHECK_ORDER=name` restores name order.

| Resource          | Per check run                                                                                        | Per test file                                                                                               | Bound                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containers        | One PostgreSQL and one search container, both labelled `rezics.kernel.check.pid` and removed at exit | Reuses the run's containers                                                                                 | Each has a 1 GiB data tmpfs; search has a 512 MiB JVM heap. Stale cleanup reads one `docker ps` listing and does linear work only in labelled containers.                                                             |
| Database copies   | Migrated `rezics` template plus at most one live `kernel_test_*` copy                                | Created from the template, dropped in `finally` after the file                                              | Disk is the template plus one copy and the largest file's writes, rather than all files' copies. `check-resources.test.ts` guards one live copy and a template of at most 256 MiB, a quarter of the PostgreSQL tmpfs. |
| Connections       | Files run sequentially; no pool is retained between files                                            | The file closes its pools                                                                                   | Each pool has a fixed connection limit. `GrowthDatabase.close()` closes its instrumented pool (max 10) and admin pool (max 2).                                                                                        |
| Growth-check data | Lives in the current file's database copy                                                            | Each population uses at most the largest scale times its declared per-unit ordinals, times rows per ordinal | Checks declare scales (default largest 64), populations and operation writes; reset data between checks. Seeding batches at most 1,000 ordinals or uses at most four concurrent production writes.                    |

Findings: the sorted test-file list and total execution work grow with the number of files. Stale-cleanup listing
memory and work grow with labelled containers, including concurrent checks and interrupted runs; live checks keep
their containers. Growth checks do not automatically reset populations between checks, so distinct populations and
operation writes can accumulate within a file unless it resets them. Capture memory grows with statements and plans
in one operation. `GrowthDatabase` currently has no `openPool` API; if added, its pools must also be closed by
`close()`.

## Growth checks

A growth check proves that the cost of one operation stays within a declared bound as its data grows; it counts rows,
shared blocks and statements, never time. Use `checkGrowth` from `test/support/growth.ts` with `seed` in `grow` to
add rows between scales. Grow both the total data and hot partition, while keeping the operation's own neighbourhood
fixed. Seed through production writes or bulk rows of identical shape. The bounds are `constant`, `logarithmic` and
`linear`; default slack is 2 rows or 10%, 4 blocks or 50%, and no statement slack. Other modules import the public
API from `test/support/growth.ts`. A check uses three to five scales, and its largest scale must not exceed 4096.

Each measured session in the instrumented `pool` and `openPool` connections pins `max_parallel_workers_per_gather = 0`
and `jit = off`, then sets `work_mem = 4MB`, `random_page_cost = 4`, `effective_cache_size = 4GB`,
`effective_io_concurrency = 16` and `default_statistics_target = 100` explicitly. The fixed defaults keep container
configuration from changing a query plan; disabling per-query parallel workers also keeps shared worker availability
from changing the work counted by a capture. `admin` connections are for setup and assertions and are not measured. A
test can still use `SET LOCAL` for a planner option inside its transaction.

Use `includeBackends` for captures spanning multiple connections; it matches each plan to statements from the same
backend PID.
Reylo freshness probes (statements selecting `fresh_table`, `fresh_column` and `fresh_type` with a catalog-only plan)
are set apart without a bound: Reylo repeats them by time and concurrency, never by data size. Other catalog-only
statements are counted apart, with one allowed per distinct non-catalog query text across the measured run; a
statement that also reads data counts in full.

A statement that fails still counts as a statement, in the operation's or the background count, and its SQLSTATE is recorded in `statementErrors` or `backgroundStatementErrors`; reports list failed attempts by SQLSTATE. PostgreSQL produces no plan for it, so its rows and blocks are not measured; a path that fails statements as part of normal work (a conflict it retries) should use a form that completes, such as `ON CONFLICT`, where its cost must be measured.

Statements in the operation's async context count toward its cost, as do statements issued by a DBOS workflow while a
capture runs; workflows started by a schedule and their children, and loops started outside both, are reported as
background work. Background statement counts follow measured
wall time, while rows and blocks per background statement must stay within the default constant-cost slack as data
grows when the statement reads an application relation. Statements reading only DBOS system relations remain
reported, but their row and block growth is not bounded because `grow` does not seed DBOS history; that history's
growth is a production retention question, not a growth check result. A scale with no applicable background statement
is skipped for that bound.

Plans are collected only inside a capture: an instrumented connection runs auto_explain just for the statements of a
measured run, and seeding is never explained. Each report sample carries `seeding`, the statements and rows written by
`grow` (every pool, `admin` included) with the time of `grow` and of the vacuum after it; when `GROWTH_PROFILE` names a
file, `checkGrowth` appends one JSON line per check with the test file, check name, scales and each scale's `seeding`.
The line also carries every repetition, relation sizes and a shadow whole-series verdict that does not yet decide the check.
Each report sample also carries `repetitions`, the cost of every measured run in order, and `relationSizes`, the
`reltuples` and `relpages` of every relation the measured plans read at that scale.
`seed` skips its own vacuum inside `grow`, since `checkGrowth` vacuums right after.

Declare the check's growth model: the relations, partitions and keys that grow with N in production (subjects,
content, history, receipts, outbox, write basis and the Access rows its authorization reads). Seed each of them at
every scale with the production row shape, key distribution and fan-out, from thousands of rows at the smallest
scale; 500 x scale bulk rows is the usual choice. A relation whose production size does not grow with N, such as
definitions, roles or configuration, may stay at fixture size, and a sequential scan of it is acceptable. Assert
the access each growing relation needs, a named index or a single partition, rather than forbidding sequential
scans everywhere. Injected planner statistics do not replace seeding: they change only a plan's estimates, while a
growth check measures executed work (`docs/research/growth-check-plan-stability.md`).

Every scale is measured warm. Keep the default `warmups`. When the operation uses up the state it measures, pass
`warmup`, which runs the same code path on spare state (another probe, a fresh key) so the measured run is not the
backend's first. `checkGrowth` refuses fewer than one warm-up per scale. It runs `VACUUM (ANALYZE)` on the test database
after each scale's `grow`, so planner statistics never depend on autovacuum; seed in `grow`, not `operation`, since the
vacuum runs after `grow`; before each measured repetition it also vacuums `dbos.workflow_status`, because DBOS's
idempotent enqueue updates an existing status row and pruning that tuple chain keeps buffer cost from depending on
maintenance timing. Do not analyze or vacuum the checked database by hand in `grow`.

Each measured repetition starts from equivalent state. When the operation writes, give every warm-up and
repetition its own fresh keys, subjects or probes, as production spreads its writes, so that no repetition updates
rows an earlier one wrote. The harness does not rewrite or compact relations between repetitions: that would hide
the version chains, index growth and visibility effects a write check should reveal. A check that measures repeated
writes to the same rows declares that history in its growth model.

A module README cites a growth check by its test file and test title and says what grows and what stays fixed. It
does not restate the scales, which the test owns and may change. Test titles do not name scales either, so a
scale change does not break a citation.

Product code sets no planner method settings (`enable_seqscan`, `enable_bitmapscan` or any other `enable_*`).
PostgreSQL documents them as a crude, temporary way to influence a plan. A sequential scan of a small relation is
bounded by that relation's size, and the planner moves to an index as statistics follow growth. A pin would make
a growth check measure the pin instead of the declared growth model. When a check sees a scan of a relation that
grows in production, seed that relation in the check; when a production plan is wrong, fix statistics, indexes or
the query shape.

## HTTP contract

JSON request bodies are validated against the declared body schema without type coercion. JSON strings are
refused for numeric or boolean fields, as are numbers for string fields, with `400 invalid_request` and the field's
JSON pointer. The app composition compiles each route's body check once and runs it before Elysia's coercing
validation. Query and path parameters retain type coercion because their values arrive as strings.

A request's deadline is fixed at arrival from `requestDeadlineMs`. Code reached by a route takes its deadline from the
route's `job.deadline` or `deadlineFor(budgetMs)`, never from `Date.now() + N` or the kernel clock, which is business
time and tests move. Durable work gets `Date.now() + budgetMs` from the same `deadlineFor`. A deadline crossing the
Auth service boundary still travels explicitly through the Auth contract. This costs one async context scope per
request and one O(1) store read per `deadlineFor` call, with no database statements.

When the HTTP contract changes, regenerate both `contracts/openapi.json` with `bun run openapi` and the client
declarations with `bun run client` while the development database is up. Tests fail while either generated contract is
stale.

Register AIP-136 custom methods with `customMethod(resourcePath, verb)` from `src/http/custom-method.ts`, then use
that path with `.post(...)`. The resource path must not end in `/` and the verb must match `^[a-z][A-Za-z0-9]*$`
(lowerCamelCase). For example, `customMethod('/v1/media/:id', 'complete')` registers `/v1/media/:id/$complete`
internally and serves `POST /v1/media/{id}:complete`; `customMethod('/v1/subjects', 'merge')` serves
`POST /v1/subjects:merge`. Every app from `createApp` translates the last literal colon in the last path segment
when its suffix is a registered custom verb. Parameters can contain colons; `%3A` never acts as the separator.
Internal `/$` paths return `404 not_found`. OpenAPI uses the public AIP paths. Eden exposes custom methods as
`client.media({ id }).$complete.post(body)` or `client.subjects.$merge.post(body)` and the client fetcher sends
them to their public AIP paths.

## Deployment

The build runs `bun run analyse`. It starts a disposable PostgreSQL, applies the migrations, has Reylo analyse every
`.sql` statement under `src` against it, and writes the result to `dist/reylo` (or to the directory given as its
argument). It then imports every `.sql` file with no database connection and fails naming each file that has no entry.
The release carries `dist/reylo` and the same lockfile as the build, because an entry is keyed by Reylo's engine
version.

Every production server and worker process sets `REYLO_CONFIG` to `dist/reylo/.reylo.yaml`. Boot then reads every
analysis from the release, never describes a statement against the production database, and writes nothing under the
package root. A missing entry is a build defect that `analyse` reports; production does not repair it.

## Database changes

Kernel-owned migrations live in `db/migrations/` and their dump lives in `db/schema.sql`. Each module has its code and
authoritative SQL statements in `src/<module>/`, its migrations in `db/<module>/migrations/`, and its dump in
`db/<module>/schema.sql`. A module exists when its migrations directory exists, and its tables live in the PostgreSQL
schema with the module's name. The module owner edits `src/<module>/`, `db/<module>/`, and that module's tests.

Migration versions use UTC timestamps in `YYYYMMDDHHMMSS_<name>.sql` form and are unique across all migration
directories. `0001_core_partition.sql` keeps its name and sorts first. Dbmate applies pending migrations from every
directory in version order, so a module migration may merge behind a newer migration from another directory. Once a
migration is merged, never rename or edit it. Run `bun run db dump` to update and commit every schema dump.

Only kernel migrations create PostgreSQL extensions. A module that needs an extension asks the kernel to install it;
module migrations may use extensions but must not create them.

DBOS Transact keeps its system tables in the `dbos` schema, created and upgraded by its own migrations when `migrate`
runs, and left out of the schema dumps.

A 16-bit route value maps to its partition by taking the top 12 bits.

Every SQL statement is stored in one reylo-typed `.sql` file and run through `pg` from an adapter module (ADR-0026).
Every statement the kernel sends is a `.sql` file under `src/`, typed by reylo and checked for partition binding.
TypeScript sends only transaction control (`BEGIN ISOLATION LEVEL …`, `SET LOCAL …`, `COMMIT`, `ROLLBACK`).

Authenticated native reads reuse only the genuine actor snapshot from the installed Access instance and pool.
Its lifetime ends at the earliest of the original request deadline, JWT expiry, and the actual authentication
account observation plus 180 seconds; preparing another read never extends it. Authentication still performs
one account point read and retains its invalid-token 401 behavior.

Every native command attempt additionally reads the current acting account by exact `(route, account_id)` before
resource checkout, releasing that read before acquiring the resource connection. One opaque observation is shared
across all action checks in that live attempt, including self-account receipt checks. A retry obtains a new observation
and time. Missing or unavailable anchors and changes to state, fence, authentication floor or operator deny execution
and receipt disclosure against the immutable authenticated snapshot, even when token epoch exceeds a changed floor.
Anonymous commands add no acting-account read and retain the generic eligibility formula.

## Opaque list cursors

A keyset cursor can carry the position of an item the reader cannot see, so a list cursor must be opaque, not only
signed. `src/tokens/list-cursor.ts` encrypts every list cursor with authenticated encryption:

```ts
encodeListCursor(ring, { route, viewer, query }, { epoch, after }, now): Promise<string>
decodeListCursor(ring, { route, viewer, query }, token, now): Promise<{ ok: true; epoch; after } | { ok: false; reason: 'expired' | 'invalid' }>
```

- `route` is the list's method and path template, or a feed's fixed name. `viewer` is the acting account's lowercase
  UUID, or `null` for an anonymous viewer; the two never match. `query` holds every parameter that shapes the list
  (filters, sort, page size). A cursor decodes only for the route, viewer and query it was issued for.
- `now` is the kernel clock's time and is required. A cursor issued more than 60 s after `now` is `invalid`; one older
  than 15 minutes is `expired`. Every other failure (tamper, another viewer, route or query, unknown key id) answers
  `invalid`, and `decodeListCursor` never throws.
- Caps: each string after-key at most 256 UTF-8 bytes, at most 8 after-keys, `route` at most 256 bytes, canonical
  query at most 2,048 bytes, token at most 4,096 characters. Encoding above a cap throws `TypeError`; decoding an
  oversized token answers `invalid` before any decryption.
- Construction: WebCrypto HKDF-SHA-256 and AES-256-GCM with a 128-bit tag. A fresh random 16-byte salt per token
  derives a one-message key and IV, with HKDF info `rezics/list-cursor/v1`, so the raw ring key never encrypts and
  the HMAC seal, session tokens and list cursors share no key material. The route, viewer kind and id, canonical
  query, version and key id are authenticated associated data and do not travel in the token.

Keys come from the same `tokens` ring as the other tokens, read from `KERNEL_SESSION_KEYS`; there is no separate
variable and no fallback. Rotate by prepending a new `kid:base64url` entry: it becomes current, and older entries
still decrypt. Retire a key by removing its entry, which makes every cursor issued under it `invalid` at once, so a
client restarts from the first page. Keep a previous key at least 15 minutes, the cursor lifetime, before retiring it.

Every new list uses `encodeListCursor`. An existing list moves when its owner next touches it. `encodeCursor` stays
only for lists that have not yet moved.

## Cost

Every read, write, check, authorization, projection and erasure must touch a bounded neighbourhood: an anchor plus bounded hops and results, costing roughly changes × log N, independent of engine speed or machine size.
Here N and P mean rows of the relevant kind in the database and anchor partition, H is that partition's outbox history, C is consumer checkpoints, k is the command event count capped at 1,000 by `MAX_COMMAND_EVENTS` (the maximum per envelope for a batch), b ≤ 64 is envelopes, and j ≤ 32 is session components; grow subjects and histories, users' content over time (U × t), and media (M) independently.
The table derives indexed access shapes from `src/`, `db/migrations/` and `db/schema.sql` (DBOS persistence from the installed SDK's own migrations): R/W count examined/written relation rows, shared-block bounds count B-tree probes as logarithmic blocks and constant rows, A counts application SQL separately from transaction control T, writes also maintain the fixed schema indexes, and callback costs and payload bytes are additional, with fixed bytes, callbacks and configuration unless stated otherwise.

| Operation                  | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Growth check                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker concurrency         | Queue configuration bounds in-flight workflows per worker process to the sum of configured `workerConcurrency` values (18); the `workflows` queue remains unbounded until its sleeping checkout workflows are removed. This bounds in-flight command attempts by configuration, not burst size. Durable steps issuing commands use `COMMAND_STEP_RETRIES` to retry transient command refusals.                                                                                                                                                                                                                                                                                                                           | Up to 18 workflows across bounded queues, plus workflows on the unbounded `workflows` queue. A durable command step retries `overloaded`, `contention`, `deadline` and `fenced` refusals with one-second initial interval, 2× backoff and at most 8 attempts; other errors are not retried by this policy.                                                                                                                                                               | `test/work-queues.test.ts`: “every work queue except workflows bounds its per-process concurrency”; “command step retries retry transient command unavailability only” |
| Workflow retention         | SDK list filters terminal status and `completed_at`, bounds `created_at` with the same strict cutoff through `endTime`, orders by `created_at ASC` and limits to 1,000. Short-batch plan: `Limit -> Sort -> Index Scan using idx_workflow_status_completed_at`; full-batch history plan: `Limit -> Index Scan using workflow_status_created_at_index`, filtering completion and status. Deletion removes status/input/output/operation rows; DBOS cascades owned events, notifications, streams and event history.                                                                                                                                                                                                       | 1 list transaction (BEGIN, SET LOCAL timeout, SELECT, COMMIT) + 1 delete transaction (BEGIN, 4 deletes, COMMIT): 10 statements. Short-batch work O(long-lived workflows + batch + log N). Up to 1,000 workflows per batch and 60 batches per run (600 statements, 60,000 workflows).                                                                                                                                                                                     | `test/work/growth-retention.test.ts`: “a short retention batch stays bounded as retained workflow history grows”                                                       |
| New command                | `time.sql`: no relation; authorization before receipt; `core.receipt` R 0/1 via `receipt_pkey`; `fence.sql`: `core.partition` R/W 1 via `partition_pkey`, `core.outbox` W k via `outbox_pkey`, `editorial.write_basis` W 1 via `write_basis_pkey` and `write_basis_partition_no_position_key`, receipt W 1; each inserted child also probes the partition FK. `MAX_COMMAND_EVENTS` enforces k ≤ 1,000 after the body, before fence writes; excess events roll back with `too_many_events`. Grow total N and anchor P/H histories, then k; fix receipt/basis bytes and callbacks. Registered types and stored JSON data are checked in memory after the cap, before finalization and fence.                               | R/W O(k+1), shared blocks O((k+1) log N), A = 3 + authorization/body SQL; T = 5 (BEGIN, three SET LOCAL, COMMIT). No core scan; accepted commands have k ≤ 1,000, with JSON/event work linear in k and bytes. The cap is checked after the body, so body work is additional even on rejection. Validation: O(total event data bytes) CPU, one lookup and precompiled check/event, no SQL, k ≤ MAX_COMMAND_EVENTS.                                                        | `test/growth-command.test.ts`: “New command stays within its bound as N grows”; `test/command-event-cap.test.ts`: “New command stays within its bound as k grows”      |
| Idempotent replay          | Time plus authorization, then receipt R 1 by the full `receipt_pkey`; no fence, body, basis or outbox write. Grow total and anchor receipts/history; fix key, response bytes and authorization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | R O(1), W 0, shared blocks O(log N), A = 2 + authorization SQL; T = 4 (BEGIN, two SET LOCAL, COMMIT). Digest mismatch substitutes ROLLBACK.                                                                                                                                                                                                                                                                                                                              | `test/growth-command.test.ts`: “Idempotent replay stays within its bound as N grows”                                                                                   |
| Denied replay              | Time plus authorization; rejection before receipt means no receipt read or write; `receipt-only` may read 0/1 receipt by `receipt_pkey`, and denies on a miss (a matching receipt is an allowed replay). Grow total and anchor receipts/history; fix denial path and authorization.                                                                                                                                                                                                                                                                                                                                                                                                                                      | Core R 0/1, W 0, shared blocks O(1)/O(log N); A = 1/2 + authorization SQL, T = 4 ending in ROLLBACK.                                                                                                                                                                                                                                                                                                                                                                     | `test/growth-command.test.ts`: “Denied replay stays within its bound as N grows”                                                                                       |
| One contention retry       | Repeat time, fresh authorization/evidence, receipt and body after 40001/40P01/55P03; same relations/indexes as new command, failed writes roll back. Grow total and anchor N/P/H; fix k and exactly one injected conflict, excluding fence polling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The check injects one conflict and makes two attempts: at most twice new-command R/W and blocks, A ≤ 6 + twice callback SQL, T ≤ 10 (ROLLBACK then COMMIT). Production retries contention with capped exponential backoff until the deadline; per-attempt work remains logarithmic in N and linear in k.                                                                                                                                                                 | `test/growth-command.test.ts`: “One contention retry stays within its bound as N grows”                                                                                |
| Same-partition concurrency | `runCommand` queues same-partition serializable attempts by `(pool, partition)` in FIFO order; queued attempts hold no connection, and each pool admits at most 64 waiters. Grow concurrent new commands in one anchor partition at scales 2, 8 and 32 while growing the seeded population.                                                                                                                                                                                                                                                                                                                                                                                                                              | For c concurrent commands, R/W O(c), shared blocks O(c log N), A/T O(c); the gate permits exactly one serializable transaction per command, so contention attempts do not grow with c within one pool. Each command retains the new-command cost.                                                                                                                                                                                                                        | `test/growth-command.test.ts`: “Concurrent commands in one partition stay within their bound as concurrency grows”                                                     |
| Partition state            | `readPartition`: `core.partition` R 0/1 through `partition_pkey`, W 0. Grow total and anchor content/history while fixing partition key; grow partition rows where representable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | R O(1), shared blocks O(log N), A = 1, T = 0 standalone; `boundedRead` adds T = 3 (BEGIN, SET LOCAL, COMMIT/ROLLBACK).                                                                                                                                                                                                                                                                                                                                                   | `test/growth-command.test.ts`: “Partition state stays within its bound as N grows”                                                                                     |
| Batch checkpoints          | Ensure outside explicit transaction: `core.consumer_checkpoint` W 0/1, partition FK R 1 on insert; lock R 0/1 with SKIP LOCKED, advance W 1 only after nonempty apply; all checkpoint probes use `consumer_checkpoint_pkey`, FK uses `partition_pkey`. Grow total C and consumers in the anchor partition; fix consumer, b and apply.                                                                                                                                                                                                                                                                                                                                                                                    | R/W O(1), shared blocks O(log C + log N); A = 2 busy, 3 empty/stopped before apply, 4 after nonempty apply including log read; T = 2 (BEGIN, COMMIT/ROLLBACK); apply SQL is extra. Ensure can wait on an uncommitted insert despite SKIP LOCKED.                                                                                                                                                                                                                         | `test/growth-events.test.ts`: “Batch checkpoints stays within its bound as C grows”                                                                                    |
| Batch log                  | `read-log.sql`: partition head R 1 by `partition_pkey`; generate at most b positions, left join outbox by `(partition_no, position)` prefix of `outbox_pkey`, R ≤ bk events (at most 64 × 1,000 = 64,000 per batch), with one placeholder instead at each missing position (or one head row when empty), W 0. Grow total outbox and anchor H, both before and after the checkpoint; fix b, k and payloads.                                                                                                                                                                                                                                                                                                               | Indexed R O(1+bk), shared blocks O(log N + b log N + bk), A = 1 within checkpoint totals, T = 0 additional; sort/validation operates on returned rows (sort CPU O(bk log(bk))). With b ≤ 64 and enforced k ≤ 1,000, returned event rows are bounded independently of H.                                                                                                                                                                                                  | `test/growth-events.test.ts`: “Batch log stays within its bound as H grows”                                                                                            |
| Relay discovery            | `startWorker` runs the effects relay through `startRelays`; each tick runs `scan-partitions.sql` per relay: scan the fixed 4,096 `core.partition` rows, join the consumer checkpoint by `consumer_checkpoint_pkey`, and for each of the `A` partitions ahead of their checkpoint probe `outbox_pkey` once at `(partition_no, checkpoint + 1, 0)` for the first pending envelope's `recorded_at`, then sort the `A` rows oldest first (partition number breaks ties; a missing envelope sorts first). It returns at most 4,096 partitions and scans no outbox history. Grow N, U × t, M and anchor H; fix relay count and concurrency (default 4).                                                                        | Discovery R O(4,096 + A) with A ≤ 4,096, W 0, indexed shared blocks O(4,096 × (1 + log C) + A × log H), A = 1 per relay, T = 0; row work is constant in outbox history H, N, U × t and M, and the sort is O(A log A). Add checkpoint/log/enqueue costs for each batch started. At most configured concurrency runs at once across all relays, one run per relay/partition; each run drains batches until busy, empty or stopped, so total batch work grows with backlog. | `test/relay-effects.test.ts`: `effects relay discovery stays within its bound as outbox history grows`                                                                 |
| Effect enqueue             | `registerEffects` scans every effect and its type list per event; each match starts deterministic `fx:epoch:partition:position:seq:name` workflow with `queuePartitionKey: String(partition_no)`. Jobs are sorted by position then event sequence (registration order breaks ties) and enqueued sequentially within each partition, concurrently across partitions. Installed DBOS upserts R/W 1 `dbos.workflow_status` by `workflow_status_pkey` and inserts W 0/1 `dbos.workflow_input` by `workflow_input_pkey`, even on reuse (rolled back). Grow total DBOS history and anchor events; fix b/k, effect/type lists, matches and bytes, then separately grow registrations.                                           | Per match R/W O(1), shared blocks O(log N), A = 2, T = 2 (BEGIN, COMMIT for new / ROLLBACK for existing); multiply by matches across bk events. Per event, CPU and SQL fan-out is linear in matching registrations, a constant for each deployment, so it does not exceed the criterion. Sorting m matched jobs in a partition costs O(m log m); enqueue concurrency is bounded by input partitions, not matches.                                                        | `test/growth-effects.test.ts`: “Effect enqueue stays within its bound as N grows”                                                                                      |
| Effect persistence         | `effects` uses `queuePartitionKey: String(partition_no)` and `partitionConcurrency: 1`: one effect executes at a time within each partition, following enqueue order; other partitions can progress independently. Per matched event's normal workflow execution, DBOS reads 0/1 status/input/output rows per keyed probe using `workflow_status_pkey`, `workflow_input_pkey` and `operation_outputs_pkey`; step completion locks status R 1 and upserts `dbos.operation_outputs` W 1 by `(workflow_uuid, function_id)` PK; terminal completion updates status W 1 and upserts `dbos.workflow_output` W 1 by `workflow_output_pkey`. Grow total and anchor workflow history; fix one execution, matches and effect body. | Each keyed read R O(1), blocks O(log N), A = 1, T = 0 standalone (step replay check reads status plus step output: A = 2); step recording A = 2/T = 2, terminal recording A = 2/T = 2, each R/W O(1), blocks O(log N). Queue claiming/polling, recovery, cancellation polling and effect body are additional; step body retries ≤ 10, not a lifetime recovery cap.                                                                                                       | `test/growth-effects.test.ts`: “Effect persistence stays within its bound as N grows”                                                                                  |
| Admission                  | `app.ts` uses reserved admission for bearer authentication/health and normal admission for prepare; `Admission` scans/splices its in-memory queue (default ≤ 32, capacities 8 normal + 2 reserved), no relation/index. Grow total and anchor data/history and request arrivals; fix configured limits and job.                                                                                                                                                                                                                                                                                                                                                                                                           | Own DB R/W, shared blocks, A/T = 0; CPU O(1) in N/P at fixed queue cap (drain can be quadratic in configured queue length); admitted job costs are extra, not limited by permits.                                                                                                                                                                                                                                                                                        | `test/growth-request.test.ts`: “Admission stays within its bound as N grows”                                                                                           |
| Request access dispatch    | `actorOf` calls injected authenticate once for bearer, zero for anonymous; access is lazily built from route catalogue, and each permission dispatch uses route-array find; prepare and authorize delegate to Access (including command checks before receipts). No wrapper relation/index; `/health` alone sends relation-free SELECT 1. Grow total and anchor data/history; fix routes and Access implementation, separately audit callback anchors.                                                                                                                                                                                                                                                                   | Wrapper DB R/W and blocks 0, A/T = 0 (health A = 1/T = 0); CPU linear in configured routes, constant in N/P. Authentication, authorization and prepare have their own relation, index, statement and hop bounds; this wrapper imposes none.                                                                                                                                                                                                                              | `test/growth-request.test.ts`: “Request access dispatch stays within its bound as N grows”                                                                             |
| Command actor admission    | `readAccount` uses `access.account` primary key `(route, account_id)` independently before resource checkout, once per live attempt shared across action checks. Grow R = N + U × t + M, unrelated accounts and the same actor receipts/history; fix K <= 1000. Authentication retains its one account point read; anonymous commands add none.                                                                                                                                                                                                                                                                                                                                                                          | Per authenticated command attempt: additional R = 1, W = 0, A = 1, T = 0, examined rows O(1), indexed blocks O(log R); connection released before resource checkout. Existing O((1 + K) log G + matches) authorization and actual k log R command changes are unchanged.                                                                                                                                                                                                 | `test/access/growth-command-admission.test.ts`: three scales; `test/access/command-admission.test.ts`: retry reads.                                                    |
| Session header             | Decode once per request; record merges then encodes. No relations/indexes; validate distinct partitions, find/filter/copy j components and retain last 32; HMAC uses one key-ID map lookup. Grow total and anchor content/history, then j; fix scope/key/payload widths and records per request.                                                                                                                                                                                                                                                                                                                                                                                                                         | DB R/W, shared blocks, A/T = 0; CPU O(j), constant N/P; unseal rejects tokens over 4096 characters before decoding, j ≤ 32 on HTTP path. Direct merge accepts longer input and seal has no output-length cap.                                                                                                                                                                                                                                                            | `test/growth-request.test.ts`: “Session header stays within its bound as j grows”                                                                                      |
| Cursors and seal           | Encode/decode have no relations/indexes; canonicalize binding by sorting parameter keys, validate ≤ 8 after-keys, HMAC SHA-256, canonical base64url and constant-time MAC comparison; expiry uses local time, not SQL. Grow total and anchor content/history; fix binding, key/scope and cursor byte lengths, then grow parameter count/bytes separately.                                                                                                                                                                                                                                                                                                                                                                | DB R/W, shared blocks, A/T = 0; constant N/P with fixed inputs; CPU linear in token/scope bytes plus parameter sorting (count × log count). Decode token ≤ 4096 characters; encode, binding parameters and string after-keys have no byte cap, so input work is not universally constant.                                                                                                                                                                                | `test/growth-request.test.ts`: `Cursors and seal stays within its bound as N grows`                                                                                    |
| Opaque list cursors        | Encode/decode have no relations/indexes and take no pool. Canonicalize the query by sorting parameter keys, validate ≤ 8 after-keys of ≤ 256 bytes, route ≤ 256 bytes and canonical query ≤ 2,048 bytes; one HKDF-SHA-256 derivation (cached imported key per ring key) and one AES-256-GCM operation per token; decode checks length ≤ 4096 and canonical base64url before any decryption. Expiry uses the passed clock, not SQL.                                                                                                                                                                                                                                                                                       | DB R/W, shared blocks, A/T = 0; constant N/P and constant CPU: one derivation and one AES-GCM pass over at most 4,096 characters, independent of list size and position.                                                                                                                                                                                                                                                                                                 | `test/tokens/list-cursor.test.ts`: `oversized inputs are refused` (maximal token stays within 4,096 characters)                                                        |

- Import identity history: `test/imports/identity-growth.test.ts`, “fixed public bulk grant changes and reduced-scope native Auth/Access remain bounded across actual history growth”, at [1, 8, 64].

Effect registration has no fan-out cap, so a fixed event can create an unbounded number of independently persisted workflows.
The core callback interfaces do not establish bounds for authorization, mutation, projection or erasure; those bounds require the supplied implementations' SQL and cannot be inferred from these adapters.
Session and cursor input caps do not cap all encoding or binding work; constant request CPU assumes fixed byte widths and configuration.
All core relations are ordinary PostgreSQL tables rather than physical per-route partitions, so a logarithmic B-tree shape is available but not forced by SQL; follow-up checks must reject history/table scans and account for planner choice, MVCC dead tuples and maintenance rather than treating returned rows as examined rows.
The partition position update serializes writes within one partition, not through a global sequence, and fence writes join only that partition's outbox, basis and receipt.
Same-partition writers from one process queue in the gate without holding a connection; writers in other processes conflict at the fence and retry, so expected attempts grow with the number of processes writing that partition at once, not with data totals.
SERIALIZABLE predicate locks and conflicts on shared physical tables/index pages can span logical partitions, so partition predicates alone do not prove independent machines or conflict domains.
Preparation may read a separately anchored parent before the resource transaction (minting time adds a separate bounded-read transaction, T +3 with the same one time statement), while arbitrary callbacks can still introduce cross-partition joins or transactions.
DBOS uses shared system tables; logical queue partitioning does not establish physical per-core-partition placement, and separate enqueue transactions do not establish atomicity with the checkpoint transaction.
Fence waiting adds a partition read with A = 1/T = 3 after rollback and on each 25 ms poll until the deadline; the default two-second deadline bounds waiting in time, but configurable deadlines are not a fixed statement-count cap.

## Write rate deployment configuration

Every kernel application installs the shared write rate stage after authentication and body validation,
before command effects. Set `KERNEL_WRITE_RATE_SECRET` to a private, stable random secret of at least
32 bytes (for example `openssl rand -base64 32`). Keep it identical across replicas; rotating it starts
new counter identities. Missing keys and unavailable counter storage refuse writes with 503 and
`Cache-Control: no-store`. Exhausted capacity returns 429 with a positive integer `Retry-After`.
Never log the key, bearer tokens or client IP addresses.

`KERNEL_WRITE_RATE_OVERRIDES` optionally contains strict partial budget JSON, for example
`{"anonymous":{"write":{"maximum":10,"seconds":60}}}`. Unknown classes, families or fields,
noninteger values, maximum outside 1–1000000, and seconds outside 1–86400 fail startup validation.
The default is the versioned `RATE_LIMIT_V1` catalogue. Report and provider capacity have separate
family keys from ordinary writes. Imports and semantic batches spend the total command count once,
up to 100, before any command runs; a denied batch spends no units.

Anonymous attribution uses the socket peer. Behind a proxy, set `KERNEL_RATE_TRUSTED_PROXY_PEERS`
to comma-separated exact literal peer IPs and optionally `KERNEL_RATE_CLIENT_IP_HEADER` (default
`cf-connecting-ip`). Each trusted peer must replace that header with a single validated client IP.
Untrusted forwarding headers are ignored. Equivalent IPv6 spellings and addresses within one /64
share capacity; IPv4-mapped IPv6 shares its IPv4 identity. Missing attribution shares a conservative
unknown-peer identity. `startServer` supplies Bun's actual socket address, including for custom methods.

Account age and private tier come from the existing verified actor anchor read. Ordinary human and
automated accounts use new-account capacity for seven days, then member capacity. Trusted capacity
requires the private server-administered `trusted` tier; service capacity also requires an active
automated actor explicitly provisioned with the `service` tier. Public profiles, JWT claims, OAuth
clients and request JSON cannot set these facts. Historic unknown creation times start at migration
time. Creation time is immutable. Tier provisioning is private database administration; there is no
public tier upgrade API. Changing class does not change the counter key.

The consumed Access counter is one routed UNLOGGED table. A spend performs one atomic PK upsert
for at most one row, including batch100; it creates no receipt, WAL event or outbox item. Crash or
partition movement may reset windows. Requests do not sweep counters or start background workers.
The route-led expiry index supports a separately registered cleanup job restricted to one admitted
local route and at most 1000 expired rows per tick, with a 48-hour retention bound. Limiter admission
grants capacity only; normal Access and command receipt ordering still apply. Turnstile and front
controls remain independent.

## Anonymous command receipts

`src/command/command.ts` exports `CommandPrincipal`, `PrincipalCommandIdentity`, `PrincipalCommandReceipt`,
`PrincipalCommandOptions`, `CommandAttribution`, `ANONYMOUS_PRINCIPAL_ID`, `principalCommandIdentity(actor)`,
`normalizeCommandKey(principal, key)` and the additive `runCommand` principal overload. Construct identity only from
the verified request `Actor`: spread `principalCommandIdentity(actor)` into command options, place identity at
`options.principal`, and give `receipt` only `{ kind, key, digest }`. The separate basis contains `clientId` and
`requestedBy`, both null for anonymous. Existing account-only `actorAccountId` options still normalize to account
receipts, and account digest/client/requestedBy behavior stays compatible. Mixed identity forms are rejected.

The logical receipt key is `(principal_kind, principal_id, command_kind, idempotency_key)`; its physical primary key
starts with `partition_no`. Anonymous has kind `anonymous` and the nil UUID kind marker, never a fabricated account,
credential owner or trusted account bypass. Account principals cannot use that marker. Generated `actor_account_id`
columns preserve existing account read projections and return null for anonymous. Anonymous write bases have null
actor/client/requestedBy. The forward-only migration preserves existing account outcomes, digests, positions,
transactions and creation/recording timestamps. Receipt retention is unchanged.

Anonymous commands require a client-generated UUIDv4 possession key and trusted `CommandAuthorization`. Keys are
validated before checkout and normalized to lowercase. Nil, other UUID versions/variants, missing keys and arbitrary
strings fail; no server replacement is minted. `src/http/request.ts` exports
`idempotencyKeyOf(header, principal?)`, which keeps the existing structured-field string `Idempotency-Key` transport
and applies principal validation when supplied. Account keys retain the existing 1..255 text contract.

Every command attempt authorizes at fresh authoritative T before its receipt seek, including replay and conflicts.
Anonymous cannot use the account self-read replay exception. A holder of the same key and matching digest can replay
the stored outcome across requester/IP/cookie changes; a mismatched digest conflicts. Denial reveals no receipt and
commits no effect or position. Retry, fencing and atomic receipt/outbox/write-basis behavior use the existing executor.

`src/http/request.ts` also exports `requestDigest(operation, actor, normalizedBody)` for either actor kind,
`anonymousRequestDigest(operation, { semantic, abuse? })`, and
`anonymousCommandTarget(routeKey, operation, key)`. The anonymous digest binds the operation and canonical semantic
JSON with fixed null anonymous client/requestedBy attribution; the executor binds it to the fixed anonymous receipt
principal. Supply every effect-relevant normalized field, including the report target,
reason and content, in `semantic`. Put already-verified Turnstile/CSRF and other request authentication/abuse evidence
in `abuse`; it is excluded from the digest. A fresh proof can retry the same semantic command. Proof verification,
Turnstile, CSRF and rate limits remain in front and never replace UUIDv4 possession or Access. Never pass raw request
JSON containing proof secrets as semantic input or publish keys/digests/proofs in incidental logs or events.

`anonymousCommandTarget` uses the existing stable deployment route key, operation and canonical UUIDv4 key to derive
a route and UUIDv8 target. Reuse that anchor across retries, including changed bodies, so the authoritative receipt can
return a conflict instead of relocating the command. No new environment variable or content-specific SQL is needed.

Owning routes must explicitly declare anonymous admission in their installed action catalogue and supply a real
`ResourceEligibility` from `createResourceAnonymousEligibility` through `Resource.eligibility` to
`accessCommandAuthorization`. Missing/forged evidence and unknown actions fail closed. Bad supplied bearer tokens
still fail authentication. PRIVATE report creation can be domain-eligible without making the report public.

The installed Access evaluator and generic eligibility capability are exercised by
`test/access/anonymous-receipts.test.ts`, including successful execution/replay and denial after domain facts change.
The core receipt suite's trusted authorization fixtures separately prove executor ordering and atomicity. Owning
content commands and final conformance must still prove their actual domain eligibility and normalized request fields.

Per attempt, receipt access is one partition/principal/kind/key index seek, followed on a miss by one partition fence
and k bounded event/basis writes: fixed SQL count and O(k log R) index buffers, plus the owning bounded eligibility
callback and H container hops. No receipt-history scan or nil-account lookup is introduced.
`test/anonymous-receipts-growth.test.ts` uses the shared PostgreSQL plan/buffer harness at 1x/8x/64x with
512/4,096/32,768 unrelated receipts, outbox events and write bases in the same partition and anonymous namespace.
It holds one execute/replay/conflict sequence fixed, checks constant statements/rows and logarithmic shared-buffer
growth, and rejects receipt sequential scans. The trusted authorization fixture isolates core executor cost;
the owning eligibility callback and H-hop costs remain additional.

### Native Auth current consent: usage, security and cost

`src/access/auth-consent.ts` exports `CurrentConsentReader` and
`createAuthConsentReader({ url, serviceTokenId, serviceTokenSecret, fetch? })`.
Trusted server composition supplies the exact private HTTPS
`/internal/v1/consents:read` URL and the existing kernel worker's Cloudflare Access
service token; literal loopback HTTP is accepted for isolated tests. The transport
uses `CF-Access-Client-Id` and `CF-Access-Client-Secret`, with redirects disabled.
No environment variables are read by this module.

Call the reader with `{ actorAccountId, clientId, deadline }` only for durable
person-attributed steps. Inject this port into the restorer when composing that
workflow. Each invocation reads Auth's current fact at Auth's native instant;
the existing Access clock and evaluator T retain their meaning. Ordinary
`requestJSON` does not call this port. Kernel receives no Auth database
credentials, provider keys, cookies or session/introspection capability.

The response must contain only the exact requested identities and bounded scopes;
missing, unavailable, malformed, foreign-identity and late responses fail closed
as null. No raw transport error or service secret is exposed. Request and response
sizes are bounded, and both fetch and body consumption obey the caller deadline
with a three-second upper bound. Responses are never retained as durable consent
authority. Per invocation cost is one bounded request/response plus Auth's one
exact consent/client/coverage/reduction SQL statement, fixed rows and O(log R)
blocks. The Auth native growth probe retains its SQL and plans in
`.temp/current-consent-growth.json`; later durable Access growth checks must
include this Auth probe as well.

## Content work configuration

The HTTP service reads `CONTENT_TURNSTILE_SECRET` and `CONTENT_TURNSTILE_HOSTNAME` to verify anonymous report proofs
with Cloudflare Siteverify. Set both together; partial or malformed configuration fails startup without echoing the
secret. If both are absent, public reads and authenticated reports continue, while anonymous reports fail closed with
the same not-found response used for ineligible targets. `CONTENT_SOURCE_HOSTS` is an optional comma-separated list
of exact lowercase DNS hosts for URL-import requests. The API uses its existing `KERNEL_SESSION_KEYS` ring for content
cursors and does not need media storage credentials. Content worker settings are optional and all or nothing.

The content registration in `src/content/register.ts` uses the shared kernel worker and its
queues, database pool, enqueue client and shutdown. It does not start a separate process or relay.
Content owns the storage and sources groups; Access owns the shared Auth consent group. Registration installs
the same workflows, queues, schedules and effects with or without them. An absent storage port or consent reader fails closed with
`dependency_unavailable` on every call, and an absent sources group leaves the source allowlist empty.
A partial group fails startup and names its first missing or invalid variable. Errors and logs name the
variable, never a value. Startup logs one line for each absent group.

| Variable                       | Value                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTENT_R2_ENDPOINT`          | HTTPS account S3 origin, `https://<32-hex-account-id>.r2.cloudflarestorage.com` (optional `eu` or `fedramp` jurisdiction). No path, credentials, query or fragment. |
| `CONTENT_R2_BUCKET`            | Media bucket name, 3–63 lowercase letters, digits and hyphens.                                                                                                      |
| `CONTENT_R2_ACCESS_KEY_ID`     | Private host-side R2 access key with media read/write/delete permission.                                                                                            |
| `CONTENT_R2_SECRET_ACCESS_KEY` | Corresponding private secret.                                                                                                                                       |
| `CONTENT_SOURCE_HOSTS`         | Comma-separated exact lowercase DNS source hosts, at most 100, for trusted HTTPS source imports. No schemes, ports, wildcard suffixes, IP literals or whitespace.   |

Access reads the shared consent group with `readAuthConsentConfig(env)`. It is optional and all or nothing:
`KERNEL_AUTH_CONSENT_URL` is the exact private HTTPS
`/internal/v1/consents:read` endpoint, together with `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
for its Cloudflare Access service token. The shared `KERNEL_ROUTE_KEY` binds imported source tuples.

Image processing uses the partitioned effects queue; object purges and author erasure use the
independently bounded governance queue. URL imports use the import queue. Content contributes its
shared effects through the kernel registration. The enqueue-only operation client reads committed
operation identities and native DBOS status and latest progress events without starting a runtime.

Storage operations have a 30-second request deadline and a 20-MiB byte limit. Collection uses the
persistent `content.collection.hourly` DBOS schedule in UTC. Each sweep visits the fixed 4096
partition numbers with at most eight partition workflows in flight and batches of at most 100.
Collection jobs obtain authoritative command time; the schedule timestamp cannot change the
24-hour retention cutoff. The shared worker owns draining work and closing resources on shutdown.

`CONTENT_TEST_COLLECTION_PARTITIONS` optionally restricts collection to a comma-separated list of distinct
partition numbers from 0 through 4095 for worker fixtures. Leave it unset in deployment so collection visits
all partitions.
