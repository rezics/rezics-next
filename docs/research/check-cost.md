# Check cost: a 24-hour evidence audit

Research snapshot: 2026-10-29. Window: **2026-10-28 06:50:00 through
2026-10-29 06:50:00 UTC**, or 14:50 through 14:50 in Asia/Shanghai.
This report proposes work; it does not change the check policy.

The recovered remote accounting reports **141.002 check-hours** inside run slices.
Multiplying each slice's elapsed time by its peak memory gives **496.263 peak-GiB-hours**.
These are observed costs in the recovered cohort, not a complete host census.
Peak-GiB-hours are a capacity envelope, **not measured memory consumption integrated over time**.
The available logs cannot supply the requested complete phase-level GiB-hour ledger.

The largest measured exposure is compilation: root typecheck alone accounts for
33.919 slice-hours and 109.498 peak-GiB-hours. Dependency provisioning reports
7.873 hours; outbound synchronization reports another 5.178 hours.
Postgres startup cannot yet be ranked by saved hours: its duration is not separated
from OpenSearch startup, migration, compilation and tests.

## Evidence and coverage

Repository source inspected at `c8b631f54f6c65bbefc0036c4e8a09c39edd3614`:

- [worker wrapper](../../scripts/worker-check.ts) and [remote runner](../../scripts/remote-check.ts);
- [kernel runner](../../services/kernel/scripts/check.ts),
  [compiler database](../../scripts/compiler-database.ts) and
  [root typecheck](../../scripts/typecheck.ts);
- [test lanes](../../scripts/test-lanes.ts), [web runner](../../apps/web/scripts/check.ts)
  and [gate](../../scripts/gate.ts).

The controller's SQLite database was opened read-only. Overlapping worker attempts
identified exact event-log paths; completed command-execution events supplied wrapper
identifiers, result paths and check-log paths. No directory crawl of other workers
was used. The collection found 1,070 overlapping attempts, 1,048 readable event logs,
55,996 completed command events, 2,323 wrapper identifiers and 2,312 readable result
records. Attempt counts are discovery coverage, not check counts.

Of 4,570 referenced check/landing log paths, 3,883 were readable: 3,381 worker logs
and 502 landing logs. Landing logs recovered this way did not add remote resource
measurements. Historical promotion logs and unreferenced runs are not a complete census.

The table cohort contains 3,344 worker-log artifacts whose filename start is in the
window and whose last modification is no later than its end. Another 26 in-window
starts were excluded because their logs changed after the cutoff. Runs beginning
before the window, deleted logs and unreferenced executions are absent. This is a
**start cohort**, not interval-clipped host utilization. A silent running log can
remain in this cohort; absence of further output does not establish completion.

There are 2,207 identifiable terminal current result records in the cohort. Other
artifacts include earlier automatic reruns, records no longer available and running
checks. Resource totals count physical reported scopes, including failed runs and
reruns; the terminal-failure denominator counts logical wrapper checks instead.

Local evidence is retained under `.temp/research-check-cost/`: `logs.json` maps
original exact paths to copied logs and SHA-256 digests; `records.json` preserves
wrapper results; `final-rows.json` and `final-tables.py` contain the extracted rows
and aggregation. These temporary files are not durable repository evidence.
The manifest SHA-256 is
`46770c2ced4820e544b66d1650ffd3e84a5c3a24f86d68223ee9c1d878703b3c`.

Two example source logs, identified independently of worker directory names:

| Log basename | SHA-256 | Observation |
| --- | --- | --- |
| `worker-check-2026-10-28T20-49-39.152Z-cc460148.log` | `f24cf24ca21ca7cb648df3c2f5821f31696212d5c732f02239eefee805be146e` | Full web command 8,309.231 s; slice 8,311.626 s; peak 5.005 GiB |
| `worker-check-2026-10-29T00-24-04.999Z-a64a6f7b.log` | `b291ff2d35b1e70d3a5ce1feffffd8d39ec09a22e2c235760c5c7a375b3e3610` | Two physical remote executions: 7,865.042 s and 769.956 s |

One apparent resource observation was actually expected/received text from a
remote-runner test failure: 0.5 CPU seconds, 4 seconds and 64 MiB. It and its fake
one-second command duration were excluded; the real host measurement in the same
log was retained. Its log SHA-256 is
`41b8f19cab29bc614c8ff68a9f70da108c638610f53605040f6e56aa045c4171`.

Full remote journal retrieval failed despite authenticated small-tail queries
succeeding. Bounded full-window and filtered systemd queries exhausted the retries;
the final errors were `b journal query timed out after 55 seconds` and
`a journal query timed out after 55 seconds`. Partial filtered streams cover only
the first several hours. The current remote configuration offers a and b, not c.
Partial journal entries were not extrapolated into daily totals or added to wrapper
measurements, which would risk counting the same scopes twice.

## Definitions

For reported run duration `d` seconds and slice peak `p` bytes:

```text
check-hours = sum(d) / 3600
peak-GiB-hours = sum(d * p) / (3600 * 2^30)
actual GiB-hours = integral(memory.current(t) / 2^30, dt / 3600)
```

The last quantity was not recorded. Linux documents `memory.peak` as a maximum,
whereas `memory.current` is current usage including descendants. A peak cannot
recover an integral or swap pressure. See the official
[cgroup v2 memory documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

Remote slice duration covers runtime provisioning, installation and the command,
including containers assigned to that slice. It excludes outbound rsync, slot wait
and cleanup after accounting. Counts differ between phase lines and complete scope
summaries because interrupted runs can report only a prefix. Do not add the whole
slice total to the phase totals. Log modification time minus filename time is not
used as elapsed execution time.

Classification prefers durable argv, then literal invocation and distinctive
runner output. Kernel and web classes include targeted checks. Unknown utility
commands remain visible rather than being assigned to a convenient class.

## Measured command-class costs

Hours below are sums of concurrently running work, not wall-clock coverage.
The memory column is the peak envelope defined above; actual GiB-hours are unknown
for **every** class. Queue time is waiting, not execution savings.

| Command class | Log artifacts | Timed scopes | Slice check-h | Peak-GiB-h | Rsync h | Provision h | Command h | Queue h |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Kernel check | 1,006 | 765 | 77.959 | 294.119 | 2.564 | 3.083 | 76.002 | 7.827 |
| Root typecheck | 791 | 422 | 33.919 | 109.498 | 1.223 | 2.531 | 31.926 | 1.669 |
| Web check/browser | 384 | 296 | 19.657 | 77.355 | 0.698 | 0.836 | 18.695 | 2.081 |
| Docs/utility/unknown | 304 | 126 | 3.316 | 8.791 | 0.261 | 0.668 | 3.074 | 0.280 |
| Control-plane/script tests | 640 | 79 | 3.192 | 1.419 | 0.190 | 0.518 | 2.718 | 2.778 |
| Workspace typecheck | 94 | 39 | 1.540 | 3.837 | 0.097 | 0.050 | 1.488 | 0.189 |
| Auth check | 39 | 31 | 1.317 | 1.213 | 0.083 | 0.156 | 1.157 | 0.141 |
| Other tests | 43 | 22 | 0.077 | 0.025 | 0.042 | 0.024 | 0.051 | 0.064 |
| Install | 43 | 8 | 0.025 | 0.005 | 0.020 | 0.008 | 0.015 | 0.034 |
| **Total** | **3,344** | **1,788** | **141.002** | **496.263** | **5.178** | **7.873** | **135.126** | **15.064** |

Kernel slices have median peak 3.811 GiB and maximum 5.993 GiB; root typechecks
have median 3.456 GiB and maximum 4.631 GiB. A one-file kernel check still starts
Postgres and OpenSearch, migrates, compares schema and compiles the kernel before
running its selected tests. File filtering is not a proportional memory reduction.
The web class mixes small checks with full gates: its 1.092 GiB median must not
size full gates, whose observed peaks exceed 5 GiB.

## Measured phases and missing attribution

| Phase | Observations | Elapsed work h | Median s | Maximum s | Memory attribution |
| --- | ---: | ---: | ---: | ---: | --- |
| Outbound rsync | 2,343 | 5.178 | 4.895 | 358.859 | Outside measured slice; unavailable |
| Runtime provisioning and `bun install` | 2,061 | 7.873 | 2.801 | 914.932 | Paired subset: at most 11.798 peak-GiB-h |
| Container start and migrations | Not separated | Unknown | Unknown | Unknown | Inside command; unavailable |
| Typecheck | Partial workspace timings | See below | Not comparable | Not comparable | Inside command; unavailable |
| Tests | 12,505 process summaries | 159.536 process-h | Not comparable | Not comparable | Inside command; unavailable |
| Whole command | 1,788 | 135.126 | 144.398 | 8,309.231 | Paired subset: at most 470.210 peak-GiB-h |
| Teardown | Not timed | Unknown | Unknown | Unknown | After accounting; unavailable |
| Return rsync | 45 | 0.044 | 2.531 | 29.926 | Unavailable |
| Slot wait | 2,343 | 15.064 | 3.648 | 2,719.999 | Not measured as run execution |

The install bound uses 1,758 logs with exactly one scope and one install phase,
covering 5.168 hours. The command bound uses 1,775 such pairs, covering 131.980
hours. Each assigns the whole slice peak to every second of that phase; neither
is its actual integral. They omit unpaired observations and cannot be extrapolated.

In 420 unambiguous root-typecheck scopes, summing the longest reported workspace
duration gives 26.834 hours of workspace critical paths. These include generators;
concurrent workspace durations must not be added as check elapsed time. Kernel
compilation has no corresponding separate duration. Bun test summaries measure
overlapping process work, including hooks; 159.536 process-hours cannot be
subtracted from 135.126 command-hours to infer migration or compilation cost.

The shared kernel timing file merges earlier file timings and includes stack-slot
waiting in `create`. Its 8.848 summed create-hours across 780 entries are therefore
neither daily database-start hours nor pure database-clone cost. Similarly,
`/tmp/rezics-check-memory/peaks.json` is a rolling peak sample without timestamps
or elapsed durations, not a 24-hour ledger.

## Infrastructure failure share

Of 2,207 known terminal logical checks, 845 passed and 1,362 returned nonzero.
**62 / 2,207 = 2.81%** are explicitly marked `infrastructureFailureFinal` after
the wrapper's automatic rerun. This is the proven terminal infrastructure floor:
23 kernel, 23 root typecheck, nine web, two workspace typecheck, two script tests,
and one each auth, other tests and unknown.

A broader diagnostic review flags **213 / 2,207 = 9.65%** for triage. Overlapping
signals include 114 environment-expansion failures without metrics, 81 Bun revision
mismatches, 62 final wrapper failures, 35 transport diagnostics, 19 Reylo mapper
crashes and three rsync errors. These counts overlap and are not additive.
Recovery, local fallback or quoted diagnostics can coexist with a nonzero test
result, so 9.65% is not a proven infrastructure fraction. Another 1,149 nonzero
checks remain unclassified. Even 201 successful checks contain the expansion
warning: searching warning text alone would overstate terminal failures.

The exact daily infrastructure share remains unknown without a complete terminal
ledger and explicit failure attribution. Neither worker-attempt counts nor the
incident's historical failure count is a substitute denominator.

## Ranked changes for host work

This ranking uses **measured addressable exposure**, not achieved savings.
No proposed optimization has an A/B result here. Ceilings overlap; they must not
be summed. Require an equal-result comparison before adopting a saving estimate.

| Rank | Change | Measured exposure / saving ceiling in recovered cohort | Risk and proof required |
| --- | --- | --- | --- |
| 1 | Reuse compilation or typecheck once per landing dependency closure | Root typecheck: 33.919 slice-h, 109.498 peak-GiB-h; its command phase 31.926 h. Retained landing checks and cache misses reduce savings. Kernel compilation is additional but unmeasured. | High correctness risk: SQL content mapping and generated inputs. Compare cold/warm diagnostics and exit codes across schema, mapper, dependency and config changes; keep a full landing oracle. |
| 2 | Cache verified runtime and an assembled dependency tree per host | Provision phase: 7.873 h, with 11.798 peak-GiB-h envelope in the smaller paired subset. Current cache already avoids many downloads; remaining savings need measurement. | Medium risk: stale hooks, patches, ABI or writable shared files. Compare cold/warm trees and checks; invalidate every relevant key and test concurrent readers plus interrupted publication. |
| 3 | Reduce outbound workspace synchronization | 5.178 h of rsync exposure; no measured GiB-h saving. Existing delta transfer means this is an upper ceiling, not an expectation. | Medium risk: stale, deleted, executable or symlinked files. Verify remote tree equivalence after branch changes, deletion, renames and failed transfers; benchmark bytes and elapsed time. |
| 4 | Plan documentation-only typechecks before placement | 18 timed scopes among 31 checks on tasks declaring only concrete Markdown paths: 1.795 slice-h and 5.568 peak-GiB-h. Actual diffs must confirm the inference. This is a subset of rank 1. | Low risk with an exact diff/dependency planner. Assert documentation selects no compiler database; SQL, generator and config changes still select all dependants. |
| Unranked pending timings | One long-lived Postgres per host, with migrated template databases | Startup/migration saving is unknown. The 77.959 kernel slice-h and 294.119 peak-GiB-h include much more than Postgres; assigning them to this proposal would be false. | High shared-state risk. Prove parallel isolation, template invalidation, no active template connections, failed-run cleanup, role/config isolation and equivalent migrations/schema. OpenSearch remains separately provisioned. |

For rank 1, TypeScript documents [incremental builds](https://www.typescriptlang.org/tsconfig/incremental.html)
and a disposable [build-info file](https://www.typescriptlang.org/tsconfig/tsBuildInfoFile.html).
That establishes the mechanism, not safety for this repository's TypeScript beta
and Reylo content mapper. A base commit alone is not a cache key: include compiler,
config, generated inputs, source/dependency state and schema/mapper identity.
Use immutable published entries and private writable copies; invalidate on missing
inputs. First benchmark whole-kernel compilation separately from services and tests.

For rank 2, the runner already sets a shared `BUN_INSTALL_CACHE_DIR`, and installs
with hardlinks. Bun's [global-cache documentation](https://bun.com/docs/pm/global-cache)
and installer source distinguish cached packages from installation verification and
tree materialization. Cache keys need the lockfile, manifests, patches, exact Bun
revision, platform/architecture/libc and relevant hook environment. The current
"bun install" timer also covers provisioning the pinned runtime; measure these
separately. Never mutate shared hardlinked package files. Publish assembled trees
atomically, retaining per-run writable outputs and lifecycle-hook state.

For rank 4, the root planner already maps Markdown-only changes to zero affected
workspaces. Moving that decision before remote placement can avoid upload/install
too. This proposes a future manager policy; it does not waive a current contract's
explicit root typecheck. Declared paths are evidence for an experiment, not proof
of the actual changed-file closure.

For Postgres, per-file databases are **already cloned from a migrated run template**.
The new opportunity is removing per-run server provisioning and template migration.
PostgreSQL's [CREATE DATABASE documentation](https://www.postgresql.org/docs/19/sql-createdatabase.html)
and source enforce absence of other template connections. Publish versioned templates
after closing connections, with keys for migrations, extensions, server image,
locale and configuration. Retain a private fallback and admission limits; a shared
server moves idle memory outside run slices and needs separate accounting. Do not
claim savings by merely moving that memory to an unmeasured cgroup.

Closest future regression suites are `scripts/typecheck.test.ts`,
`scripts/typecheck-placement.test.ts`, `scripts/remote-check.test.ts`,
`scripts/worker-check.test.ts`, `scripts/check-memory.test.ts`,
`scripts/test-lanes.test.ts` and `scripts/stack-run.test.ts`. New implementation
tests should exercise the failure and invalidation cases above, not just cache hits.

## Browser sharding: latency, not a host-hour reduction

The tracked `apps/web/check-timings.json`, recorded 2026-10-28 20:12:42.482 UTC,
has 133 merged file entries. Applying the current runner's source classifier yields
62 browser files with 9,821.580 seconds summed wall time; longest is 334.364 seconds.
Seed SHA-256: `1add0e300e1c5b0e0c9295d2c7346880cf08bf4441eae6b0a174b2350df4443d`.
These mixed historical timings include failures, not a clean replay of one gate.

Longest-first greedy scheduling models one lane at 163.693 minutes and two at
82.047 minutes: **81.646 minutes (49.88%) less critical-path time** before added
startup/install overhead. Three lanes model 55.017 minutes; four model 41.497.
This is a model using measured durations, not an achieved speedup. Total file work
is unchanged; extra service stacks can increase check-hours and memory pressure.
The current tree has 180 eligible test files and 92 classified browser files;
the incident's 174-file count is a different snapshot.

The runner defaults to six browser lanes but an inherited `REZICS_STACK_SLOT`
forces one. Investigate placement and lease propagation before buying more hosts.
REZICS uses Bun tests with the Playwright library, not Playwright Test: its
`--shard` command is not a drop-in solution. Adapt the isolation and scheduling
patterns in official [sharding](https://playwright.dev/docs/test-sharding) and
[parallelism](https://playwright.dev/docs/test-parallel) documentation to existing
file-list lanes, with independent directories, ports, databases and artifacts.
Prove every file runs exactly once, all failures propagate, retries stay attributable,
and resource admission still caps aggregate memory. Extend
`apps/web/tests/check-lanes.test.ts` and `apps/web/tests/check-timings.test.ts`.

## Recommendation and measurement prerequisite

Adopt compilation reuse as the first resource experiment, runtime/dependency
publication second, and two-lane browser scheduling as a separately budgeted latency
experiment. Defer a Postgres migration until phase measurements establish its return.
Fix proven infrastructure failures as reliability work, without inventing saved hours.

Before comparing implementations, persist a host-independent run ledger with command
class, revision, host, retry number, terminal status, explicit infrastructure cause
and monotonic boundaries for rsync, runtime, install, each service start, migrations,
generation, compilation, tests and teardown. Preserve it beyond checkout deletion.
Sample `memory.current`, swap and pressure for the run slice including containers;
integrate samples, retain sampling error and account for host-shared services separately.
Do not add descendant scope metrics to parent slice metrics. Clip intervals to the
reporting window and include starts before it, unfinished runs and every retry.
Only this can produce the requested true GiB-hours and complete per-phase totals.

The shared source patterns are disposable/versioned compiler state, immutable package
publication, explicit database-template isolation and independent test partitions.
Implement these designs in the existing Bun/TypeScript/Postgres tooling; no source
files or long passages need to be copied. Changes belong in owning contracts only
after adoption. The incomplete host census and absent memory integrals remain open
measurement limitations, not evidence of zero cost.

## Reference source provenance

Existing clones were read without installing, building or executing their contents.
The reference index was updated with the inspected revisions and licences.

| Project | Reused local reference path under main checkout `.reference/` | Inspected revision and source | Licence |
| --- | --- | --- | --- |
| PostgreSQL | `library-shelf-maintenance/postgres` | [`0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89`, `src/backend/commands/dbcommands.c`](https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/commands/dbcommands.c), read with `git show` | PostgreSQL License, `COPYRIGHT` |
| Bun | `search-worker-outcome-harness/bun` | [`c643ea8c2a9da88cae7e3508d2dd95c8f5857926`, `src/install/PackageInstall.rs`](https://github.com/oven-sh/bun/blob/c643ea8c2a9da88cae7e3508d2dd95c8f5857926/src/install/PackageInstall.rs) | MIT plus linked dependency licences, `LICENSE.md` |

Official documentation links above are primary explanatory sources accessed
2026-10-29; measured REZICS costs come from the local logs, not those sources.
