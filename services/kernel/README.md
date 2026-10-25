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
to `.env`. Use `bun run search down` to stop it while keeping its volume, or `bun run search reset` to remove and
recreate it. The check command starts its own disposable OpenSearch node.

## Run the kernel

Run `bun run db up`, then `bun run dev` from this workspace to serve the API locally. The server reads
`DATABASE_URL` (required), `KERNEL_ROUTE_KEY` (required), and `KERNEL_SESSION_KEYS` (required) from the environment.
`KERNEL_HOSTNAME` defaults to `127.0.0.1` and `KERNEL_PORT` defaults to `4100`. `db up` generates the development
secrets once and keeps them in `.env` across restarts.

Bearer tokens are verified against the Auth service. The first request that carries one reads `AUTH_ISSUER`
(the Auth service's canonical origin), `AUTH_AUDIENCE` (the API's HTTPS URL) and `AUTH_JWKS_URL` (the Auth
service's public JWKS URL, on the exact issuer origin). Without them the kernel still starts and serves anonymous
requests, and refuses every bearer token.

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

API processes use `createWorkClient(databaseUrl)` from `src/work/client.ts` to enqueue by workflow and queue name,
pass that client to modules, and call `close()` on shutdown. Enqueueing needs no running worker; the next worker
runs the persisted work. Reuse a workflow ID for idempotency.

## Check

Run `bun run check` from this workspace. It starts a disposable PostgreSQL database, applies migrations and checks the
schema dump, runs TypeScript, lint and formatting checks, then runs each test file on its own copy of the migrated
database. A plain `bun test` shares one database across files, so run a single file when not running the check. The test
database is removed at the end.

Run `bun run check <path>...` to check named files and run any named test files; paths are relative to this workspace.
The full `bun run check` is what the gate runs.

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
API from `test/support/growth.ts`.

Seed every relation the operation reads, including receipts, outbox, write basis and the Access rows its authorization
reads, to thousands of rows at the smallest scale; for example, use 500 x scale bulk rows of the production shape per
relation. Otherwise, the planner scans small relations and the check fails on rows that production would reach through
an index.

## HTTP contract

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

## Cost

Every read, write, check, authorization, projection and erasure must touch a bounded neighbourhood: an anchor plus bounded hops and results, costing roughly changes × log N, independent of engine speed or machine size.
Here N and P mean rows of the relevant kind in the database and anchor partition, H is that partition's outbox history, C is consumer checkpoints, k is command events (the maximum per envelope for a batch), b ≤ 64 is envelopes, and j ≤ 32 is session components; grow subjects and histories, users' content over time (U × t), and media independently.
The table derives indexed access shapes from `src/`, `db/migrations/` and `db/schema.sql` (DBOS persistence from the installed SDK's own migrations): R/W count examined/written relation rows, shared-block bounds count B-tree probes as logarithmic blocks and constant rows, A counts application SQL separately from transaction control T, writes also maintain the fixed schema indexes, and callback costs and payload bytes are additional, with fixed bytes, callbacks and configuration unless stated otherwise.

| Operation               | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Bound                                                                                                                                                                                                                                                                                                                                                              | Growth check                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| New command             | `time.sql`: no relation; authorization before receipt; `core.receipt` R 0/1 via `receipt_pkey`; `fence.sql`: `core.partition` R/W 1 via `partition_pkey`, `core.outbox` W k via `outbox_pkey`, `editorial.write_basis` W 1 via `write_basis_pkey` and `write_basis_partition_no_position_key`, receipt W 1; each inserted child also probes the partition FK. Grow total N and anchor P/H histories; fix k, receipt/basis bytes and callbacks.                                                        | R/W O(k+1), shared blocks O((k+1) log N), A = 3 + authorization/body SQL; T = 5 (BEGIN, three SET LOCAL, COMMIT). No core scan; JSON/event work linear in k and bytes.                                                                                                                                                                                             | `test/growth-command.test.ts`: “New command stays within its bound as N grows”             |
| Idempotent replay       | Time plus authorization, then receipt R 1 by the full `receipt_pkey`; no fence, body, basis or outbox write. Grow total and anchor receipts/history; fix key, response bytes and authorization.                                                                                                                                                                                                                                                                                                       | R O(1), W 0, shared blocks O(log N), A = 2 + authorization SQL; T = 4 (BEGIN, two SET LOCAL, COMMIT). Digest mismatch substitutes ROLLBACK.                                                                                                                                                                                                                        | `test/growth-command.test.ts`: “Idempotent replay stays within its bound as N grows”       |
| Denied replay           | Time plus authorization; rejection before receipt means no receipt read or write; `receipt-only` may read 0/1 receipt by `receipt_pkey`, and denies on a miss (a matching receipt is an allowed replay). Grow total and anchor receipts/history; fix denial path and authorization.                                                                                                                                                                                                                   | Core R 0/1, W 0, shared blocks O(1)/O(log N); A = 1/2 + authorization SQL, T = 4 ending in ROLLBACK.                                                                                                                                                                                                                                                               | `test/growth-command.test.ts`: “Denied replay stays within its bound as N grows”           |
| One contention retry    | Repeat time, fresh authorization/evidence, receipt and body after 40001/40P01/55P03; same relations/indexes as new command, failed writes roll back. Grow total and anchor N/P/H; fix k and exactly one injected conflict, excluding fence polling.                                                                                                                                                                                                                                                   | At most twice new-command R/W and blocks, A ≤ 6 + twice callback SQL, T ≤ 10 (ROLLBACK then COMMIT); logarithmic N, linear k, constant attempts (three contention attempts maximum).                                                                                                                                                                               | `test/growth-command.test.ts`: “One contention retry stays within its bound as N grows”    |
| Partition state         | `readPartition`: `core.partition` R 0/1 through `partition_pkey`, W 0. Grow total and anchor content/history while fixing partition key; grow partition rows where representable.                                                                                                                                                                                                                                                                                                                     | R O(1), shared blocks O(log N), A = 1, T = 0 standalone; `boundedRead` adds T = 3 (BEGIN, SET LOCAL, COMMIT/ROLLBACK).                                                                                                                                                                                                                                             | `test/growth-command.test.ts`: “Partition state stays within its bound as N grows”         |
| Batch checkpoints       | Ensure outside explicit transaction: `core.consumer_checkpoint` W 0/1, partition FK R 1 on insert; lock R 0/1 with SKIP LOCKED, advance W 1 only after nonempty apply; all checkpoint probes use `consumer_checkpoint_pkey`, FK uses `partition_pkey`. Grow total C and consumers in the anchor partition; fix consumer, b and apply.                                                                                                                                                                 | R/W O(1), shared blocks O(log C + log N); A = 2 busy, 3 empty/stopped before apply, 4 after nonempty apply including log read; T = 2 (BEGIN, COMMIT/ROLLBACK); apply SQL is extra. Ensure can wait on an uncommitted insert despite SKIP LOCKED.                                                                                                                   | `test/growth-events.test.ts`: “Batch checkpoints stays within its bound as C grows”        |
| Batch log               | `read-log.sql`: partition head R 1 by `partition_pkey`; generate at most b positions, left join outbox by `(partition_no, position)` prefix of `outbox_pkey`, R ≤ bk events plus b gap placeholders, W 0. Grow total outbox and anchor H, both before and after the checkpoint; fix b, k and payloads.                                                                                                                                                                                                | Indexed R O(1+bk), shared blocks O(log N + b log N + bk), A = 1 within checkpoint totals, T = 0 additional; sort/validation operates on returned rows (sort CPU O(bk log(bk))). With fixed b alone, R O(H), blocks O(log N + H) exceeds the criterion: no event-count cap per envelope, so bk can reach H.                                                         | `test/growth-events.test.ts`: “Batch log stays within its bound as H grows”                |
| Relay discovery         | `relayEffects` requires one partition argument and calls `readBatch`; neither it nor the server discovers partitions with work, and `registerEffects` installs no discovery loop. Grow total partitions' work and anchor H; fix one supplied partition and b/k.                                                                                                                                                                                                                                       | Supplied-partition call has batch bounds; discovery R, blocks and A/T are undefined because discovery is absent, not a proven constant-cost scheduler. A future all-partition tick would be linear in partition count.                                                                                                                                             | `test/growth-events.test.ts`: “Relay discovery stays within its bound as N grows”          |
| Effect enqueue          | `registerEffects` scans every effect and its type list per event; each match starts deterministic `fx:epoch:partition:position:seq:name` workflow. Installed DBOS upserts R/W 1 `dbos.workflow_status` by `workflow_status_pkey` and inserts W 0/1 `dbos.workflow_input` by `workflow_input_pkey`, even on reuse (rolled back). Grow total DBOS history and anchor events; fix b/k, effect/type lists, matches and bytes, then separately grow registrations.                                         | Per match R/W O(1), shared blocks O(log N), A = 2, T = 2 (BEGIN, COMMIT for new / ROLLBACK for existing); multiply by matches across bk events. CPU and SQL fan-out linear in registrations/matches exceeds the criterion without fixed configuration: no registration or type-list cap; Promise.all does not bound concurrency.                                   | `test/growth-events.test.ts`: “Effect enqueue stays within its bound as N grows”           |
| Effect persistence      | Per matched event's normal workflow execution, DBOS reads 0/1 status/input/output rows per keyed probe using `workflow_status_pkey`, `workflow_input_pkey` and `operation_outputs_pkey`; step completion locks status R 1 and upserts `dbos.operation_outputs` W 1 by `(workflow_uuid, function_id)` PK; terminal completion updates status W 1 and upserts `dbos.workflow_output` W 1 by `workflow_output_pkey`. Grow total and anchor workflow history; fix one execution, matches and effect body. | Each keyed read R O(1), blocks O(log N), A = 1, T = 0 standalone (step replay check reads status plus step output: A = 2); step recording A = 2/T = 2, terminal recording A = 2/T = 2, each R/W O(1), blocks O(log N). Queue claiming/polling, recovery, cancellation polling and effect body are additional; step body retries ≤ 10, not a lifetime recovery cap. | `test/growth-events.test.ts`: “Effect persistence stays within its bound as N grows”       |
| Admission               | `app.ts` uses reserved admission for bearer authentication/health and normal admission for prepare; `Admission` scans/splices its in-memory queue (default ≤ 32, capacities 8 normal + 2 reserved), no relation/index. Grow total and anchor data/history and request arrivals; fix configured limits and job.                                                                                                                                                                                        | Own DB R/W, shared blocks, A/T = 0; CPU O(1) in N/P at fixed queue cap (drain can be quadratic in configured queue length); admitted job costs are extra, not limited by permits.                                                                                                                                                                                  | `test/growth-request.test.ts`: “Admission stays within its bound as N grows”               |
| Request access dispatch | `actorOf` calls injected authenticate once for bearer, zero for anonymous; access is lazily built from route catalogue, and each permission dispatch uses route-array find; prepare and authorize delegate to Access (including command checks before receipts). No wrapper relation/index; `/health` alone sends relation-free SELECT 1. Grow total and anchor data/history; fix routes and Access implementation, separately audit callback anchors.                                                | Wrapper DB R/W and blocks 0, A/T = 0 (health A = 1/T = 0); CPU linear in configured routes, constant in N/P. Authentication, authorization and prepare have their own relation, index, statement and hop bounds; this wrapper imposes none.                                                                                                                        | `test/growth-request.test.ts`: “Request access dispatch stays within its bound as N grows” |
| Session header          | Decode once per request; record merges then encodes. No relations/indexes; validate distinct partitions, find/filter/copy j components and retain last 32; HMAC uses one key-ID map lookup. Grow total and anchor content/history, then j; fix scope/key/payload widths and records per request.                                                                                                                                                                                                      | DB R/W, shared blocks, A/T = 0; CPU O(j), constant N/P; unseal rejects tokens over 4096 characters before decoding, j ≤ 32 on HTTP path. Direct merge accepts longer input and seal has no output-length cap.                                                                                                                                                      | `test/growth-request.test.ts`: “Session header stays within its bound as j grows”          |
| Cursors and seal        | Encode/decode have no relations/indexes; canonicalize binding by sorting parameter keys, validate ≤ 8 after-keys, HMAC SHA-256, canonical base64url and constant-time MAC comparison; expiry uses local time, not SQL. Grow total and anchor content/history; fix binding, key/scope and cursor byte lengths, then grow parameter count/bytes separately.                                                                                                                                             | DB R/W, shared blocks, A/T = 0; constant N/P with fixed inputs; CPU linear in token/scope bytes plus parameter sorting (count × log count). Decode token ≤ 4096 characters; encode, binding parameters and string after-keys have no byte cap, so input work is not universally constant.                                                                          | `test/growth-request.test.ts`: “Cursors and seal stays within its bound as N grows”        |

The batch envelope cap does not bound event results: one envelope can contain the partition's entire H-event history.
Effect registration has no fan-out cap, so a fixed event can create an unbounded number of independently persisted workflows.
The core callback interfaces do not establish bounds for authorization, mutation, projection or erasure; those bounds require the supplied implementations' SQL and cannot be inferred from these adapters.
Session and cursor input caps do not cap all encoding or binding work; constant request CPU assumes fixed byte widths and configuration.
All core relations are ordinary PostgreSQL tables rather than physical per-route partitions, so a logarithmic B-tree shape is available but not forced by SQL; follow-up checks must reject history/table scans and account for planner choice, MVCC dead tuples and maintenance rather than treating returned rows as examined rows.
The partition position update serializes writes within one partition, not through a global sequence, and fence writes join only that partition's outbox, basis and receipt.
SERIALIZABLE predicate locks and conflicts on shared physical tables/index pages can span logical partitions, so partition predicates alone do not prove independent machines or conflict domains.
Preparation may read a separately anchored parent before the resource transaction (minting time adds a separate bounded-read transaction, T +3 with the same one time statement), while arbitrary callbacks can still introduce cross-partition joins or transactions.
DBOS uses shared system tables and one effects queue without a core partition queue key; its queue scheduling and separate enqueue transactions do not establish per-core-partition placement or atomicity with the checkpoint transaction.
No single relay scans all partitions in this base because no partition-discovery scheduler exists; its eventual discovery shape remains unproven.
Fence waiting adds a partition read with A = 1/T = 3 after rollback and on each 25 ms poll until the deadline; the default two-second deadline bounds waiting in time, but configurable deadlines are not a fixed statement-count cap.
