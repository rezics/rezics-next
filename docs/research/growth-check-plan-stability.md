# PostgreSQL growth checks: plan shape and repeatable work

Research date: 2026-10-27. This report is evidence and a recommendation for the owning documentation to adopt;
it does not change the harness contract. Reference repositories were shallow-cloned and read as untrusted data.
Nothing from them was installed, built, or executed; no database experiments were performed. The explicit
workspace-only write instruction takes precedence over the requested external reference-cache location: clones
are under `.temp/growth-check-plan-stability-refs/<project>/` in this worktree. No external checkout was modified.

## Recommendation

Keep real, growing fixtures for assertions about executed rows and buffers. Add a separate, optional plan-choice
test using synthetic statistics when a particular distribution or cardinality estimate needs coverage. Do not
replace physical growth with statistics injection, and do not add an automatic `VACUUM FULL` rewrite before
every repetition. Prefer equivalent fresh operation state; where physical repeatability is essential, measure
one operation per fresh database copy of a prepared scale. These are recommendations, not measured speedups.

The blanket rule “500 rows per scale unit in every read relation, and no sequential scans” is stronger than the
practices found. Seed the relations and partitions whose growth can make the operation do unbounded work, with
realistic key distribution, row width, fan-out, and selectivity. A legitimately small reference relation can
remain small. Assert important access properties selectively; allow sequential scans when they are appropriate
to the declared workload, especially a linear operation. Keep unforced plan choice in the executed-work tests.

The shared pattern is to control inputs and assert the property under test: optimizer tests control statistics
and settings; storage tests control physical state; application tests count statement events. None of the
reviewed sources establishes a universal recipe that makes exact buffer totals stable for arbitrary repeated
writes. Several deliberately omit those totals from expected output. [P1][P2][C1][C2][A1][A2][A3]

## What the local harness currently proves

[`services/kernel/README.md`](../../services/kernel/README.md#growth-checks),
[`growth.ts`](../../services/kernel/test/support/growth.ts),
[`growth-cost.ts`](../../services/kernel/test/support/growth-cost.ts), and
[`growth-bound.ts`](../../services/kernel/test/support/growth-bound.ts) establish three physical scales,
one or more warmups, five measured repetitions by default, and per-metric medians. Setup runs database-wide
`VACUUM (ANALYZE)` after `grow`; each measured repetition additionally vacuums/analyzes `dbos.workflow_status`
when present. The code examined does not implement the proposed general rewrite step.

The metric is shared hits plus reads, rather than disk reads alone; rows derive from executed plan-node rows,
loops, and filtering. Thus changing a read into a hit does not by itself reduce counted block accesses.
Statistics affect estimates and plan selection; they do not supply missing runtime tuples, heap pages,
index depth, dead tuple chains, or index-only visibility. Medians reduce occasional variation but cannot
make successively different physical starting states equivalent. [P3][P4]

## Practices found in mature projects

| Source and purpose                  | How it controls plans/work                                                                                                                                                                       | Cost and determinism implications                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL planner regression tests | Real fixtures plus explicit `ANALYZE`; scoped `enable_*` settings to exercise particular paths. `select.sql` disables sequential/bitmap scans and sorting to expose index-ordering bugs.         | Setup grows with actual data. Settings make a targeted feature test dependable, but do not demonstrate the unforced production choice.                                                                                                    |
| PostgreSQL statistics tests         | `stats_ext.sql` disables autovacuum on tables whose estimated rows are checked. `stats_import.sql` restores/clears statistics and compares catalog representations.                              | Avoids asynchronous auto-analyze changes; imported values remove sampling variation for the specified estimates. Requires maintenance of distributions and version-sensitive representations.                                             |
| PostgreSQL EXPLAIN tests            | `explain.sql` normalizes numeric details and drops text buffer lines; disables JIT and I/O timing.                                                                                               | Stable output checks formatting/structure, not exact execution cost.                                                                                                                                                                      |
| CockroachDB optimizer tests         | An in-memory test catalog accepts `ALTER TABLE … INJECT STATISTICS`; fixtures include row/distinct counts, widths and histograms. `opt` expected output records plans, estimated rows and costs. | No population of the represented dataset is needed for these optimizer tests. Statistics fixtures are cheap relative to physical seeding, but need representative distributions and refreshed expectations as optimizer behavior changes. |
| `pg_hint_plan`                      | Scan/join/order hints, join row-estimate correction and planning settings; its tests exercise the hints.                                                                                         | Little data setup is required to request a path. Requires a compatible extension and hint maintenance. A forced path can hide an optimizer-choice regression. It is not a physical-state reset or an immutable whole-plan guarantee.      |
| `pg_dbms_stats`                     | Exports/imports and locks planner statistics through extension hooks, including the relation size presented to planning.                                                                         | Separates production-sized planning from local data volume more fully than native catalog restoration. Requires the extension, matching schema/types and compatible export formats. Does not reproduce execution work.                    |
| Citus plan tests                    | Real tables, `VACUUM ANALYZE`, explicit planner settings, filtered EXPLAIN and `BUFFERS OFF` in many expected plans.                                                                             | Stable structural assertions without claiming stable buffer numbers. Has version-specific expected output where upstream behavior differs.                                                                                                |
| Django, Rails, `rspec-sqlimit`      | Capture SQL issued inside a scope and assert count or a filtered limit.                                                                                                                          | Works with small fixtures and catches N+1 patterns cheaply. One costly full scan still counts as one statement; these assertions do not stabilize or measure PostgreSQL buffer work.                                                      |

The observations above come from the actual test implementations, not assumptions that these projects run
production-sized integration databases. Sources: PostgreSQL [P1][P2], CockroachDB [C1], hints/stats extensions
[H1][D1], Citus [C2], and frameworks [A1][A2][A3]. Time costs in the table are qualitative deductions from
the setup mechanisms; this read-only research did not benchmark them.

### PostgreSQL's ten-page heuristic is real, but conditional

In PostgreSQL 19 RC1, `table_block_relation_estimate_size()` reads the physical block count. It substitutes
ten pages only when that count is below ten, `reltuples < 0`, and the relation has no inheritance children.
The source describes protection against caching a plan while a newly created table is still empty. After
vacuum/analyze supplies statistics, that fallback no longer applies. It is not a permanent minimum for all
relations or a production-cardinality simulation. [P3]

Do not preserve this accidental unknown-statistics state to obtain a convenient index plan. A newly created
relation and a maintained relation are different planner inputs. For the normal growth scenario, initialize
both the seeded relations and ancillary relations that may be created during warmup before establishing the
measurement baseline. Test the genuinely new/unmaintained state separately if it matters. Deciding whether
to vacuum by a previous `reltuples` sign encodes fixture history, rather than the intended production state.

### Native statistics import/export: PostgreSQL 18 versus 19 RC1

The release-tag catalogs and documentation, rather than rolling search results, are the version authority:

| Facility                                                                       | PostgreSQL 18.0                                                                                                                  | PostgreSQL 19 RC1                                                          |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pg_restore_relation_stats`                                                    | Present; variadic alternating argument-name/value pairs, returns boolean.                                                        | Present, same calling form.                                                |
| `pg_restore_attribute_stats`                                                   | Present; variadic pairs, returns boolean.                                                                                        | Present, same calling form.                                                |
| `pg_clear_relation_stats`                                                      | Present; schema and relation, returns void.                                                                                      | Present.                                                                   |
| `pg_clear_attribute_stats`                                                     | Present; schema, relation, attribute and inherited flag, returns void.                                                           | Present.                                                                   |
| `pg_dump --statistics`, `--statistics-only` and corresponding restore controls | Available; statistics are excluded by default. Extended statistics from `CREATE STATISTICS` are not included by the 18 exporter. | Available; `pg_dump` additionally emits `pg_restore_extended_stats` calls. |
| `pg_restore_extended_stats`, `pg_clear_extended_stats`                         | Absent from the 18.0 catalog.                                                                                                    | Present for extended statistics objects.                                   |

Relation restoration accepts `relpages`, `reltuples`, `relallvisible`, `relallfrozen`, and an originating
`version`; column restoration addresses a column by name or number and the inherited flag, with statistics
such as width, null/distinct fractions, common values, histograms and correlation. Consult the pinned version
for supported details. Minor problems can produce warnings and partial restoration: require a true result,
inspect warnings, and verify the resulting statistics rather than treating a successful SQL call as enough.
These functions require `MAINTAIN` on the target table or database ownership and cannot run during recovery.
Their results can be overwritten by maintenance. [P5][P6]

“Export” here means `pg_dump` collecting statistics and emitting restoration calls, not a symmetric SQL
`pg_export_relation_stats()` API. `pg_clear_*_stats` removes optimizer metadata; it does not clean tuples or
reset cumulative I/O counters. In particular, clearing relation statistics restores the unknown `reltuples`
state, so it can reintroduce the ten-page heuristic without changing physical size. [P5][P6][P7]

Even successful native import does **not** make an empty heap look like a production heap. For an ordinary
heap with known positive `relpages`, PostgreSQL uses the stored density and current physical pages:

`estimated tuples = round(imported reltuples / imported relpages × current physical pages)`.

For example, importing one million rows over ten thousand pages into a ten-page fixture gives approximately
one thousand estimated rows, not one million. An empty maintained heap can take the zero-page fast path.
Indexes also use their actual sizes. Faking a higher density can inflate estimated rows but still does not
inflate scan page cost or index depth, and imported visibility counts can distort index-only costing.
This conclusion follows directly from the size-estimation code; it was not experimentally measured. [P3]

`pg_dbms_stats` is instructive precisely because it records and substitutes the current relation file size
as well as the catalog statistics. Its documented off-site analysis workflow exports statistics from one
database and imports them into another. It cautions that settings and density changes can still change plans.
The inspected upstream revision advertises PostgreSQL 14 support; it is not evidence of PostgreSQL 19 RC1
compatibility. Do not add it to this harness without a separate compatibility assessment. [D1]

CockroachDB's approach is an excellent model for a **plan-only** layer: its test catalog stores injected JSON
statistics and optimizes against those objects, without needing the represented rows. It is not evidence
that an actual PostgreSQL execution on a tiny heap measures production buffer work. [C1]

## Repeated writes: what can and cannot reset the measured work

PostgreSQL's own EXPLAIN regression suite explicitly filters variable buffer output. Its separate I/O
statistics test creates 4,500 real rows with autovacuum disabled, rewrites using `VACUUM FULL`, adjusts
`wal_skip_threshold`, then uses a small vacuum buffer ring. It checks that reads and reuse-plus-evictions
**increase**, rather than an exact total. The rewrite intentionally arranges I/O for a storage test; it is
not routine normalization of every modifying statement. [P1][P2]

Citus has a complementary physical test: `columnar_buffer_access_strategy.sql` populates a large relation
above a fraction of `shared_buffers`, verifies physical size, evicts that relation's cached buffers with
`pg_buffercache`, and asserts bounds on cached blocks. It also uses `VACUUM FULL` to test the columnar rewrite
path itself. This is targeted cache/storage testing with real blocks, distinct from its ordinary plan-output
tests. It supplies no general justification for rewriting application tables before each measurement. [C2]

| Mechanism                                                   | What it stabilizes                                                                                              | What remains different or what it costs                                                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Warmup                                                      | Backend initialization and much cache residency.                                                                | Writes can change live rows, chains, visibility and index structure. A spare key prevents consuming the probe but does not restore shared physical pages.                            |
| Plain `VACUUM`                                              | Reclaims removable dead tuples for reuse; can restore visibility-map state.                                     | Does not normally compact the whole heap or shrink indexes to their original layout. Old snapshots can prevent cleanup. It also updates relation statistics.                         |
| `VACUUM (ANALYZE)`                                          | Cleanup plus refreshed distribution estimates.                                                                  | Sampling and changed contents may change plans. Applying it after injected statistics can replace the injection.                                                                     |
| `VACUUM FULL`, followed by plain vacuum                     | Rewrites/compacts live data; subsequent vacuum can establish visibility-map state needed for a chosen baseline. | Full-table work, new files and rebuilt indexes, exclusive locks, extra disk space, changed locality/cache state and statistics. Live accumulated writes remain. Not a rewind.        |
| Transaction rollback/savepoint                              | Restores transactional logical contents for a compatible single-transaction operation.                          | Aborted versions and physical allocation can remain; sequences are not generally rolled back. Cannot encompass independent commits or background workflows.                          |
| Fresh seeded database or template copy                      | Repeats the same starting live data and physical layout, if copied after preparation and quiescence.            | Setup/copy and connection costs; each copy needs equivalent warmup. A logical dump/reload recreates layout rather than preserving a physical copy exactly.                           |
| Filesystem/volume snapshot restored to an isolated instance | Can restore physical baseline when captured consistently with PostgreSQL backup/recovery requirements.          | Infrastructure and restart/recovery costs. This is an architectural option, not an observed shared convention in these suites. Never copy arbitrary live data files as a substitute. |
| Exported SQL snapshot                                       | Synchronizes transaction visibility of pre-existing rows.                                                       | Does not rewind files, allocations or writes; holding it can prevent dead-version reclamation.                                                                                       |
| `CHECKPOINT`                                                | Flushes permanent relation dirty data to disk.                                                                  | Does not remove dead tuples, rewind tables or evict the shared cache; does not normalize hit-plus-read accesses.                                                                     |

The table combines observed tests with deductions from documented semantics; the proposed database-copy
protocol is a recommendation, not a claim that all reviewed projects use it. Plain/full vacuum semantics
and visibility behavior are documented in [P4][P8]; snapshots, copies, physical backups and checkpoints in
[P9][P10]. PostgreSQL's statistics regression test even records dead tuples from an aborted subtransaction,
demonstrating why logical rollback and physical cleanup must not be equated. [P2]

For a template-based implementation, prepare and maintain each scale once, finish any baseline warmup writes,
then quiesce it and disconnect all sessions. `CREATE DATABASE … TEMPLATE …` requires no other connections
to the template; pool and workflow ownership therefore need explicit lifecycle support. Copy the prepared
baseline for each repetition, open the measured sessions, perform an equivalent warmup policy, and capture
one operation. The default `WAL_LOG` copy strategy and `FILE_COPY` have different costs; the latter forces
checkpoints. Use only databases owned by that test. A crash-consistent storage snapshot requires its own
documented backup/recovery protocol. Neither copy approach was timed in this research. [P9][P10]

## Proposed policy for this harness

1. **Retain separate assertions for statements, executed work, and plan properties.** Statement counting
   catches N+1 queries with tiny fixtures, following Django/Rails. Count the actual operation and its owned
   workflows; make schema/setup exclusions explicit. Keep row/block growth assertions because statement
   counts cannot detect a single growing scan. [A1][A2][A3]
2. **Replace universal fixture padding with an explicit growth model.** Declare which totals, hot partitions,
   matching/nonmatching keys and authorization paths grow. Physically populate these dimensions at all three
   scales, retaining the operation's bounded neighborhood. Keep production row shapes and indexes. Calibrate
   a sufficient baseline using the observed unforced plans and physical sizes; 500 is a fixture choice, not
   a PostgreSQL guarantee. A sparse or empty ancillary relation needs a declared lifecycle scenario, not
   automatically fabricated production history.
3. **Keep controlled planner settings, without forcing the successful path in growth tests.** The current
   explicit costs, JIT and parallel-worker settings reduce environmental variation. Record server version,
   settings, plan nodes, relation sizes and estimates for failures. Prefer a specific index/partition/access
   expectation over a global sequential-scan prohibition. A plan can legitimately change while the cost bound
   remains satisfied. Pins/hints belong in tests intended to exercise a particular executor path. [P1][H1]
4. **Offer statistics injection only as an explicit additional planning scenario.** Use native supported
   functions rather than direct catalog writes, and a versioned synthetic statistics fixture consistent with
   schema, types, distributions and extended statistics. Apply it after maintenance and before fresh planning;
   ensure no auto-analyze or later maintenance replaces it. Account for physical-size rescaling and cached
   plans. Do not label its runtime buffer results production-scale growth evidence. [P3][P5][P6]
5. **Specify the write-state baseline.** For consumable work use equivalent fresh keys/probes. For repeated
   updates distinguish a maintained steady-state scenario from an accumulating-history scenario. Targeted
   plain vacuum outside capture can be part of the former, after transactions/snapshots permit cleanup;
   avoid analyze between repetitions unless replanning is an intentional part of that scenario. Ordinary
   vacuum still changes relation metadata and visibility, so it is not an identity reset. If equivalent
   physical state cannot be achieved this way, use isolated fresh copies, not progressively stronger cleanup.
6. **Do not add the candidate rewrite step as a default.** Conditional `VACUUM FULL` plus plain vacuum based
   on prior maintenance history adds expensive normalization and can conceal precisely the chain, history,
   index-growth and visibility effects a production-shaped write test should reveal. A narrowly named
   compacted-database/storage scenario may deliberately use it. Keep the existing DBOS-specific maintenance
   provision as an explicit current assumption pending validation against the chosen baseline, rather than
   extrapolating it to all written relations. No implementation or acceptance-test change is made here.

Before adoption, the owner can validate the policy with small focused fixtures: native restoration on empty
and populated heaps; first-use versus maintained relations; repeated same-key updates versus fresh-copy runs;
and a missing-index regression that must increase work or violate an access expectation. Record every
repetition's work and physical metadata so a median cannot hide drift. These are proposed follow-up checks;
none was run as part of this source-only investigation.

## Primary sources, inspected revisions, and licences

File paths below are relative to each reference repository. Links pin inspected revisions or release tags;
the official documentation links provide readable explanations. Patterns may be followed freely. Under this
task's copying policy, code may be copied only from MIT, Apache-2.0 or BSD projects, with attribution and
their notices. No source code was copied into this report or the harness. In particular, do not copy Citus
or current CockroachDB implementation code; PostgreSQL's separately named licence is not an automatic entry
in that copying whitelist.

- **[P1] PostgreSQL planner/EXPLAIN tests, 19 RC1:**
  [`src/test/regress/sql/select.sql`](https://github.com/postgres/postgres/blob/REL_19_RC1/src/test/regress/sql/select.sql),
  [`stats_ext.sql`](https://github.com/postgres/postgres/blob/REL_19_RC1/src/test/regress/sql/stats_ext.sql),
  [`explain.sql`](https://github.com/postgres/postgres/blob/REL_19_RC1/src/test/regress/sql/explain.sql).
- **[P2] PostgreSQL statistics/I/O tests, 19 RC1:**
  [`src/test/regress/sql/stats.sql`](https://github.com/postgres/postgres/blob/REL_19_RC1/src/test/regress/sql/stats.sql),
  [`stats_import.sql`](https://github.com/postgres/postgres/blob/REL_19_RC1/src/test/regress/sql/stats_import.sql).
- **[P3] PostgreSQL size estimation, 19 RC1:**
  [`src/backend/access/table/tableam.c`](https://github.com/postgres/postgres/blob/REL_19_RC1/src/backend/access/table/tableam.c#L717),
  [`src/backend/optimizer/util/plancat.c`](https://github.com/postgres/postgres/blob/REL_19_RC1/src/backend/optimizer/util/plancat.c).
- **[P4] PostgreSQL execution and visibility:**
  [EXPLAIN documentation](https://www.postgresql.org/docs/19/using-explain.html),
  [index-only scans](https://www.postgresql.org/docs/19/indexes-index-only-scans.html).
- **[P5] PostgreSQL 18.0 interfaces:**
  [`src/include/catalog/pg_proc.dat`](https://github.com/postgres/postgres/blob/REL_18_0/src/include/catalog/pg_proc.dat),
  [`doc/src/sgml/func.sgml`](https://github.com/postgres/postgres/blob/REL_18_0/doc/src/sgml/func.sgml),
  [`doc/src/sgml/ref/pg_dump.sgml`](https://github.com/postgres/postgres/blob/REL_18_0/doc/src/sgml/ref/pg_dump.sgml).
- **[P6] PostgreSQL 19 RC1 interfaces/exporter:**
  [`src/include/catalog/pg_proc.dat`](https://github.com/postgres/postgres/blob/REL_19_RC1/src/include/catalog/pg_proc.dat),
  [`doc/src/sgml/func/func-admin.sgml`](https://github.com/postgres/postgres/blob/REL_19_RC1/doc/src/sgml/func/func-admin.sgml),
  [`src/bin/pg_dump/pg_dump.c`](https://github.com/postgres/postgres/blob/REL_19_RC1/src/bin/pg_dump/pg_dump.c),
  [`doc/src/sgml/ref/pg_dump.sgml`](https://github.com/postgres/postgres/blob/REL_19_RC1/doc/src/sgml/ref/pg_dump.sgml).
- **[P7] PostgreSQL clear implementation:**
  [`src/backend/statistics/relation_stats.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/statistics/relation_stats.c#L224)
  at inspected main revision `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`.
- **[P8] PostgreSQL maintenance:** [VACUUM](https://www.postgresql.org/docs/19/sql-vacuum.html),
  [routine vacuuming](https://www.postgresql.org/docs/19/routine-vacuuming.html).
- **[P9] PostgreSQL physical preparation:**
  [CREATE DATABASE](https://www.postgresql.org/docs/19/sql-createdatabase.html),
  [filesystem backup consistency](https://www.postgresql.org/docs/19/backup-file.html).
- **[P10] PostgreSQL visibility versus persistence:**
  [snapshot synchronization](https://www.postgresql.org/docs/19/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION),
  [CHECKPOINT](https://www.postgresql.org/docs/19/sql-checkpoint.html).
  All PostgreSQL references use the
  [PostgreSQL License, `COPYRIGHT`](https://github.com/postgres/postgres/blob/REL_19_RC1/COPYRIGHT).
- **[C1] CockroachDB**, revision `d30c905fff79ef825adc96bcc647f1872a90f2ff`:
  [`pkg/sql/opt/testutils/testcat/alter_table.go`](https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/sql/opt/testutils/testcat/alter_table.go),
  [`pkg/sql/opt/testutils/opttester/opt_tester.go`](https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/sql/opt/testutils/opttester/opt_tester.go),
  [`pkg/sql/opt/xform/testdata/coster/scan`](https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/sql/opt/xform/testdata/coster/scan),
  [`testfixtures/tpch_stats`](https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/sql/opt/testutils/opttester/testfixtures/tpch_stats).
  [CockroachDB Software License, `LICENSE`](https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/LICENSE);
  the inspected Go files explicitly select it. Source-available evidence, not permissively licensed code.
- **[H1] pg_hint_plan**, revision `52af48fb1ab45648b90c555d3355f8c5261dbdc3`:
  [`docs/hint_list.md`](https://github.com/ossc-db/pg_hint_plan/blob/52af48fb1ab45648b90c555d3355f8c5261dbdc3/docs/hint_list.md),
  [`sql/pg_hint_plan.sql`](https://github.com/ossc-db/pg_hint_plan/blob/52af48fb1ab45648b90c555d3355f8c5261dbdc3/sql/pg_hint_plan.sql).
  [BSD-3-Clause, `COPYRIGHT`](https://github.com/ossc-db/pg_hint_plan/blob/52af48fb1ab45648b90c555d3355f8c5261dbdc3/COPYRIGHT);
  also carries [`COPYRIGHT.postgresql`](https://github.com/ossc-db/pg_hint_plan/blob/52af48fb1ab45648b90c555d3355f8c5261dbdc3/COPYRIGHT.postgresql).
- **[D1] pg_dbms_stats**, revision `e041b7cf92f105e41746e8e06b106f1246cc51b0`:
  [`doc/pg_dbms_stats-en.md`](https://github.com/ossc-db/pg_dbms_stats/blob/e041b7cf92f105e41746e8e06b106f1246cc51b0/doc/pg_dbms_stats-en.md),
  [`pg_dbms_stats.c`](https://github.com/ossc-db/pg_dbms_stats/blob/e041b7cf92f105e41746e8e06b106f1246cc51b0/pg_dbms_stats.c),
  [`sql/ut.sql`](https://github.com/ossc-db/pg_dbms_stats/blob/e041b7cf92f105e41746e8e06b106f1246cc51b0/sql/ut.sql).
  [BSD-3-Clause, `COPYRIGHT`](https://github.com/ossc-db/pg_dbms_stats/blob/e041b7cf92f105e41746e8e06b106f1246cc51b0/COPYRIGHT).
- **[C2] Citus**, revision `5ca742e83302a8771020a56927654ea9ee5a501d`:
  [`src/test/regress/sql/multi_explain.sql`](https://github.com/citusdata/citus/blob/5ca742e83302a8771020a56927654ea9ee5a501d/src/test/regress/sql/multi_explain.sql),
  [`columnar_buffer_access_strategy.sql`](https://github.com/citusdata/citus/blob/5ca742e83302a8771020a56927654ea9ee5a501d/src/test/regress/sql/columnar_buffer_access_strategy.sql).
  [AGPL-3.0, `LICENSE`](https://github.com/citusdata/citus/blob/5ca742e83302a8771020a56927654ea9ee5a501d/LICENSE).
- **[A1] Django**, revision `e9414948e9660ee4c167eebb187710ee3031d9d8`:
  [`django/test/testcases.py`, `_AssertNumQueriesContext` and `assertNumQueries`](https://github.com/django/django/blob/e9414948e9660ee4c167eebb187710ee3031d9d8/django/test/testcases.py),
  [`django/test/utils.py`, `CaptureQueriesContext`](https://github.com/django/django/blob/e9414948e9660ee4c167eebb187710ee3031d9d8/django/test/utils.py).
  [BSD-3-Clause, `LICENSE`](https://github.com/django/django/blob/e9414948e9660ee4c167eebb187710ee3031d9d8/LICENSE).
- **[A2] Rails**, revision `83ddc9f66acbf55c14a6a3f6dd716bea2c495a41`:
  [`activerecord/lib/active_record/testing/query_assertions.rb`](https://github.com/rails/rails/blob/83ddc9f66acbf55c14a6a3f6dd716bea2c495a41/activerecord/lib/active_record/testing/query_assertions.rb).
  [MIT, `MIT-LICENSE`](https://github.com/rails/rails/blob/83ddc9f66acbf55c14a6a3f6dd716bea2c495a41/MIT-LICENSE).
  The counter ignores cached events, normally excludes schema queries and materializes pending transactions
  before capture. Django similarly initializes its connection before taking its query-log boundary.
- **[A3] rspec-sqlimit**, revision `4606ca65381eeac6f0dd531384e585f1defa26a3`:
  [`lib/rspec/sqlimit/counter.rb`](https://github.com/nepalez/rspec-sqlimit/blob/4606ca65381eeac6f0dd531384e585f1defa26a3/lib/rspec/sqlimit/counter.rb),
  [`README.md`](https://github.com/nepalez/rspec-sqlimit/blob/4606ca65381eeac6f0dd531384e585f1defa26a3/README.md).
  [MIT, `LICENSE.txt`](https://github.com/nepalez/rspec-sqlimit/blob/4606ca65381eeac6f0dd531384e585f1defa26a3/LICENSE.txt).
  Its notification counter excludes CACHE/SCHEMA events and supports an SQL regex limit; it does not inspect plans.

[P1]: https://github.com/postgres/postgres/blob/REL_19_RC1/src/test/regress/sql/explain.sql
[P2]: https://github.com/postgres/postgres/blob/REL_19_RC1/src/test/regress/sql/stats.sql
[P3]: https://github.com/postgres/postgres/blob/REL_19_RC1/src/backend/access/table/tableam.c#L717
[P4]: https://www.postgresql.org/docs/19/using-explain.html
[P5]: https://github.com/postgres/postgres/blob/REL_18_0/doc/src/sgml/func.sgml
[P6]: https://github.com/postgres/postgres/blob/REL_19_RC1/doc/src/sgml/func/func-admin.sgml
[P7]: https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/statistics/relation_stats.c#L224
[P8]: https://www.postgresql.org/docs/19/routine-vacuuming.html
[P9]: https://www.postgresql.org/docs/19/sql-createdatabase.html
[P10]: https://www.postgresql.org/docs/19/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION
[C1]: https://github.com/cockroachdb/cockroach/blob/d30c905fff79ef825adc96bcc647f1872a90f2ff/pkg/sql/opt/testutils/testcat/alter_table.go
[H1]: https://github.com/ossc-db/pg_hint_plan/blob/52af48fb1ab45648b90c555d3355f8c5261dbdc3/docs/hint_list.md
[D1]: https://github.com/ossc-db/pg_dbms_stats/blob/e041b7cf92f105e41746e8e06b106f1246cc51b0/doc/pg_dbms_stats-en.md
[C2]: https://github.com/citusdata/citus/blob/5ca742e83302a8771020a56927654ea9ee5a501d/src/test/regress/sql/multi_explain.sql
[A1]: https://github.com/django/django/blob/e9414948e9660ee4c167eebb187710ee3031d9d8/django/test/testcases.py
[A2]: https://github.com/rails/rails/blob/83ddc9f66acbf55c14a6a3f6dd716bea2c495a41/activerecord/lib/active_record/testing/query_assertions.rb
[A3]: https://github.com/nepalez/rspec-sqlimit/blob/4606ca65381eeac6f0dd531384e585f1defa26a3/lib/rspec/sqlimit/counter.rb
