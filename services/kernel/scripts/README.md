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

Reylo analyses are cached in immutable snapshots under the host's typecheck cache directory. The snapshot key includes
the Bun, TypeScript, Reylo and Postgres engine inputs plus the digest of the migrated schema dump. Each command gets a
private `.reylo/` copy, and the cache manifest records each source SQL file's content digest. An unchanged run reads
the existing analyses offline; a changed SQL file is regenerated on its own, while a changed schema dump selects a
new snapshot. A failed cache generation continues through the ordinary compiler path so TypeScript retains its SQL
diagnostics. An explicit `REYLO_CONFIG` or workspace Reylo project file keeps its configured behavior and bypasses
this cache. Reylo's stored entries carry a database-wide schema fingerprint, so a migration that changes the schema
invalidates the analyses for that database; a data-only migration with an unchanged schema dump reuses them.

Decision: Keep successful Reylo analyses in immutable host-local snapshots keyed by schema-dump digest and compiler/config/dependency identity; each run gets a private copy and only changed SQL statements are regenerated.

The one-run compiler database uses a labelled anonymous volume inside the run slice, matching kernel check storage. It does not use a 1 GiB tmpfs and does not bind-mount the checkout. Persistent derived reuse for local schema/contract generation keeps its existing tmpfs cache.

When `REZICS_CHECK_PHASES` is set, stderr also records source HEAD, argv, concurrency, and slice `anon` / `file` / `inactive_file` plus `io.pressure` averages when those cgroup files are readable. Missing counters stay omitted. Compare like command/source classes using those command phases and the transport `slotWaitSeconds` / rsync lines separately. Do not treat wrapper wall time as compiler duration.

Observation: the preceding labelled-volume Kernel typecheck on host a recorded 334s command, 324s compiler, 4.6s slot wait, 1.8s rsync, IO full 34% at start, and pre-existing compiler errors. That is an a-host command whose admitted time is mostly the broad compiler bucket; a failed compiler cannot establish a successful full typecheck and does not identify the 10–25 minute host-b symptom. Required-check ledger Kernel typechecks (`bun run --cwd services/kernel typecheck`) on 2026-11-04 used revision `7a651ea717c21e8c659dc7f447d371e556a973d4`, ledger host `remote`, compiler exit 2, command 269–591s and wrapper 330–1375s, with slot wait 4.4–512s. A passing Kernel typecheck on 2026-11-02 (revision `5be89aeae377487d93986e05d0f074321dd149b4`) had command 223s and wrapper 1591s at slot wait 4.6s, so wrapper wall time is not compiler duration. The [compiler placement contract](../../../docs/development/compiler-check-placement.md) records a host-b Kernel typecheck of 362s that returned 0, without nested compiler markers or slice memory/IO.

Cache-aware admission (`3afee00d49` / `b1841e43808feae3d6f1c1f8617bc8ffdde2512f`) is on current dev and is not an ancestor of `main`. `main`'s `scripts/remote-check.ts` blob is `7d324057c430665feaf0c05d75ab1137c4cbe00b`; this tree's blob is `9dfda2127d982476425c6993044503aaaf9eb667`. Source integration is not live producer identity. Reclaim-stopgap state on the hosts is unobserved. Nested compiler markers exist so a later like-class b-host receipt can separate client emit, `tsc`, construct and OpenAPI without timing assertions. File-cache pressure remains a correlation until that receipt exists. Supermanager handoff: publish the live remote-check producer and confirm or remove the reclaim stopgap; do not treat this outcome as that deployment.

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
reuse workspace typechecks for inferred result contracts. Run it with
`bun run --cwd services/kernel check scripts/statement-bytes.test.ts`.
