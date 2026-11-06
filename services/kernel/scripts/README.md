# Kernel scripts

`typecheck`, `check`, `derived` and `search` share one compiler database lifetime on an admitted check host.

## Typecheck phases

`bun run --cwd services/kernel typecheck` places through the [compiler placement contract](../../../docs/development/compiler-check-placement.md). Slot wait and rsync stay on the transport receipt. After admission the command appends paired markers to `REZICS_CHECK_PHASES`:

| Phase            | Work                                                         |
| ---------------- | ------------------------------------------------------------ |
| `database-image` | Postgres image and one throwaway container                   |
| `migrations`     | Schema migrations on that container                          |
| `sql-analysis`   | Schema dump identity and Reylo analysis of changed SQL files |
| `compiler`       | Outer bucket around the nested compiler commands             |
| `client-emit`    | Optional `--emit-client`, nested in `compiler`               |
| `typecheck`      | Workspace TypeScript check, nested in `compiler`             |
| `tsc`            | Workspace `tsc --noEmit`, nested in `compiler`               |
| `construct`      | `bun run construct`, nested in `compiler`                    |
| `openapi`        | Optional `--emit-openapi`, nested in `compiler`              |
| `sql-schema`     | Optional `--emit-schema=` dump from the same database        |
| `cleanup`        | Remove the one-run container and its volume                  |

Client emit stays before the workspace compiler so tests see source-checked declarations. Client emit, `tsc` and construct share the same migrated database; they do not start a second compiler database. `--emit-client` still runs a declaration compiler and then `tsc --noEmit`; that is the accepted client-publication order, not duplicate preparation.

Reylo analyses are cached in immutable snapshots under the host's typecheck cache directory, and `reylo-cache.ts` owns that cache for every consumer. The snapshot key includes the Bun, TypeScript, Reylo and Postgres engine inputs plus the digest of the migrated schema dump, so a migration that changes the schema selects a new snapshot, while a data-only migration with an unchanged dump reuses it. Each command gets a private `.reylo/` copy, and the cache manifest records each source SQL file's content digest. A changed SQL file is regenerated on its own. Reylo names each entry by statement and by server, host and port included, and every throwaway database has a new port, so the copy is first renamed to that server's name: an unchanged statement keeps its entry and only changed statements are written.

`typecheck` prepares the cache inside its own `sql-analysis` phase. `check` writes `database-image`, `migrations`, `sql-schema`, `sql-analysis`, `compiler` and `cleanup`, and compiles and runs its test files against the offline project, whose `direct_url` is empty, so no test process analyses a statement against its database. `withThrowawayDatabase` gives its consumers the same cache by default: the dev-landing Kernel import, `construct`, the `derived` contracts and the boot test. `derived schema` and typecheck's own database opt out, because neither loads a Kernel module. A failed cache generation continues through the ordinary compiler path so TypeScript retains its SQL diagnostics. An explicit `REYLO_CONFIG` or workspace Reylo project file keeps its configured behavior and bypasses this cache.

Decision: One host-local Reylo analysis cache, keyed by toolchain, database configuration and schema dump, serves typecheck, check and the throwaway-database seam; each run re-keys its copy to its own server so only changed statements are analysed.

Mapper-enabled root typechecks run Kernel, Auth and Web compilers one at a time inside the admitted 6GiB slice; the compiler database uses 32MB shared_buffers. Admitted runs reclaim inactive file pages in that slice after install and before each mapper compiler.
The one-run compiler database uses a labelled anonymous volume inside the run slice, matching kernel check storage. It does not use a 1 GiB tmpfs and does not bind-mount the checkout. Persistent derived reuse for local schema/contract generation keeps its existing tmpfs cache. Throwaway `docker run -d` uses `--rm` plus `cleanupStale` on labelled owner pids so a killed owner or failed startup leaves no owned container. Docker stdout/stderr is UTF-8 text whether spawnSync returns a string or a Buffer. Failed OpenSearch or Postgres creates reap the nonce; cleanup throws the first `docker rm` failure so the caller retains the original diagnostic. Root and Kernel `docker run`/`rm -f` wait 120s; `build`/`pull` wait 600s; `exec`/`ps`/`port` probes wait 5s. Signal-path `docker rm -f` is detached so the host supervisor's 200ms SIGKILL cannot abort it. Host-lifetime cleanup uses the same 120s bound. A create that times out or fails reaps that nonce before the error escapes. Isolated-stack attachment uses `--network container:<id>` from `REZICS_ISOLATED_STACK_CONTAINER`; Docker treats `ns:/proc/<pid>/ns/net` as a network name and that path is refused. Isolated stacks bind PostgreSQL's unix socket to `/tmp/rzpg-<pid>` and publish TCP through an independent forwarding child so synchronous Reylo analysis cannot starve packet forwarding; the child exits when the owner closes stdin, including SIGKILL. Command-phases retain the `--rm`/owner-label regression. Management walk Access-deadline and idle-in-transaction setup termination is received through this lifetime; original walks remain open.

When `REZICS_CHECK_PHASES` is set, stderr also records source HEAD, argv, concurrency, and slice `anon` / `file` / `inactive_file` plus `io.pressure` averages when those cgroup files are readable. Missing counters stay omitted. Compare like command/source classes using those command phases and the transport `slotWaitSeconds` / rsync lines separately. Do not treat wrapper wall time as compiler duration.

Observation: the preceding labelled-volume Kernel typecheck on host a recorded 334s command, 324s compiler, 4.6s slot wait, 1.8s rsync, IO full 34% at start, and pre-existing compiler errors. That is an a-host command whose admitted time is mostly the broad compiler bucket; a failed compiler cannot establish a successful full typecheck and does not identify the 10–25 minute host-b symptom. Required-check ledger Kernel typechecks (`bun run --cwd services/kernel typecheck`) on 2026-11-04 used revision `7a651ea717c21e8c659dc7f447d371e556a973d4`, ledger host `remote`, compiler exit 2, command 269–591s and wrapper 330–1375s, with slot wait 4.4–512s. A passing Kernel typecheck on 2026-11-02 (revision `5be89aeae377487d93986e05d0f074321dd149b4`) had command 223s and wrapper 1591s at slot wait 4.6s, so wrapper wall time is not compiler duration. The [compiler placement contract](../../../docs/development/compiler-check-placement.md) records a host-b Kernel typecheck of 362s that returned 0, without nested compiler markers or slice memory/IO.

Cache-aware admission (`3afee00d49` / `b1841e43808feae3d6f1c1f8617bc8ffdde2512f`) is on current dev and is not an ancestor of `main`. `main`'s `scripts/remote-check.ts` blob is `7d324057c430665feaf0c05d75ab1137c4cbe00b`; this tree's blob is `adf74d4a2321dd56bcea95279339f42dfd3c33f4`. Source integration is not live producer identity. Reclaim-stopgap state on the hosts is unobserved. Nested compiler markers exist so a later like-class b-host receipt can separate client emit, `tsc`, construct and OpenAPI without timing assertions. File-cache pressure remains a correlation until that receipt exists. Supermanager handoff: publish the live remote-check producer and confirm or remove the reclaim stopgap; do not treat this outcome as that deployment.

### Cost: Kernel typecheck phases

- Touches: one phase-file append per start/end, one optional cgroup `memory.stat` and `io.pressure` read, one `git rev-parse`.
- Bound: constant in the number of Kernel phases (six outer pairs plus at most five nested compiler pairs).
- Growth check: `test/scripts/command-phases.test.ts` pins pairing, nested compiler order, failed-`tsc` pairing, observation keys, one-run volume/slice args and a single throwaway database for compiler work.

## Reylo native engine

Use Reylo 0.7.0 with its optional platform engine installed; the removed per-database engine packages are unnecessary.
The lockfile and Reylo's native engine launcher participate in SQL-analysis cache identity.

Decision: SQL-derived work bounds include sqlcommenter bytes even though `.sql` omits the comment. Query modules use
encoded source metadata; detached SQL declarations reserve a 512-byte comment envelope. Raw `.sql` dispatch may
therefore consume less than its conservative declaration. Keep inferred cardinalities and nullability at call sites.
The statement-byte regression test pins the envelope against all Kernel SQL paths and the actual Reylo transport.

Compatibility follows the [0.7.0 release notes](https://github.com/colinhacks/reylo/releases/tag/v0.7.0).
Decision: use one focused Kernel regression file for SQL transport byte bounds and the migrated server import graph;
include a PostgreSQL round trip for JSON wire normalization and parameter subscripts; reuse workspace typechecks for inferred result contracts. Run it with
`bun run --cwd services/kernel check test/scripts/reylo-compatibility.test.ts`.

Decision: materialize JSON wire values at SQL parameter boundaries rather than asserting domain records are Reylo
`Json`. Decode opaque JSON database responses with their owner shapes, retaining existing semantic checks. Readonly
domain values and undefined object fields keep their JSON serialization semantics. These codecs stay at database I/O.
The command fences normalize JSON null receipt/basis parameters to SQL NULL, preserving absence rather than trying
to insert metadata without a principal. The compatibility regression covers both event and no-effect fences.

Decision: shared JSON parameter and statement-byte helpers belong to the platform database module and use its declared
public entries. Preparation JSON schemas live in a leaf module; runtime readers do not import the composition facade.
