# Shared growth harness: contributor journey and remaining design gaps

Research/access date: 2026-10-30. This is design evidence for the Performance manager, not an owner contract or
native acceptance result. Only this report changes in the checkout. No experiments, checks, benchmarks, or
independent revalidation of existing deliveries were performed. Reference source was read, never installed or run.

## Answer and authority

**The harness has a useful implemented contributor journey, but the complete end-to-end capability is not yet
demonstrated.** Contributors can declare bounds, seed real populations, invoke production operations, retain native
occurrences, inspect verdicts and obtain actionable errors. Gaps remain in independent-axis evidence, precise episode
ownership, conservation of nested native work through costing/projection, durable diagnostic export, and the complete
reserved counters scenario. These are distinct gaps; adding another example query does not close them.

The authorities are [Performance](../goals/performance.md),
[growth-harness acceptance](../goals/performance.capabilities.md#growth-harness),
[Kernel Growth checks](../../services/kernel/README.md#growth-checks), and
[development verification](../development/verification.md). A contributor's module Cost entry owns the operation's
anchors, admitted expansion and budget. This report recommends additions for those owners to adopt; it changes none.

Reuse the findings in [plan stability](growth-check-plan-stability.md), [classification](growth-classification.md),
[calibration](growth-uncertainty-calibration.md), and [cost audit](performance-cost-audit.md). Real physical populations,
production distributions and observed pages remain essential. The adopted classifier, uncertainty, retry, settle,
catalogue and background policies remain in force. Earlier research proposals are not newer authority: in particular,
do not replace today's nonblocking inconclusive result with an older proposal to fail insufficient evidence. The cost
audit is a historical operation inventory, not current execution evidence or authority for its old table-only format;
verification now admits an operation subsection with Touches, Bound and Growth check.

Use these stages independently: **designed** means an owner describes the journey; **implemented** means a native
path exists; **accepted on dev** requires the owner's recorded acceptance; **promoted** requires recorded promotion.
Existing owner deliveries remain trusted evidence at their stated stage. This static reading establishes no new dev
acceptance or promotion. The manifest explicitly records no complete growth-harness acceptance/promotion; subsequent
stage advancement is **unknown here**, not disproved. A product UI is not required; the interface is tests and reports.

## The developer journey that exists

Paths below are relative to `services/kernel/test/support/` unless otherwise stated. Consumer imports should come
from the genuine public facade [`growth.ts`](../../services/kernel/test/support/growth.ts), not its implementation
modules. The following table distinguishes usable APIs from proposed interfaces.

| Contributor step       | Existing interface and evidence                                                                                                                    | Remaining boundary                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Derive the budget      | Module Cost entry; `GrowthCheck.bounds`, optional `byteBounds`, `indexProbes`, `attempts`, `counted`                                               | The harness cannot infer a valid budget from a passing fit. Owner must identify every native dependency and growing input.                                 |
| Open native resources  | `openGrowthDatabase()` returns production `createPool`-based `pool`, unmeasured `admin`, instrumented `openPool()` and `close()`                   | A service using another pool/process needs an explicit capture binding; admin is setup/assertion support, never the measured operation.                    |
| Populate each scale    | Exported `Population`, `placement()`, `seed()`; `rows` or `write`, optional `finish`; `grow(db, scale, previous)`                                  | Deterministic hot/cold placement exists. Independent axes and authentic derived-state completeness are contributor obligations, not enforced declarations. |
| Execute the actual job | `checkGrowth(db, { grow, operation, warmup?, prepare?, ... })`; `capture()` and `measure()` for direct captures                                    | Pass `db.pool`/`openPool()` to the real handler/service/default worker. SQL copied into `operation` proves only that SQL.                                  |
| Attribute native work  | Async context, DBOS handling, client queues, occurrence indexes, optional backend metadata; `readAttemptLedger()`                                  | No public database/session/ReadyForQuery episode identity or explicit cross-worker ownership receipt exists.                                               |
| Settle and capture     | `settle()`, `settleAdmin()`, `GrowthSettleInfrastructureError`; nested auto_explain notices                                                        | Existing settle diagnostics have a writer. Capture/cost completeness belongs to the existing native capture/cost owner.                                    |
| Inspect result         | Returned `GrowthReport`: costs, repetitions, relation sizes, occurrences with native plan documents, attempts, counted values, verdicts and shadow | In-memory evidence is richer than exported JSONL. There is no complete persisted journey artifact with ownership/coverage reconciliation.                  |
| Diagnose a failure     | `GrowthBoundError` scale/relation details, normalized statement growth and costly node; `GROWTH_REVIEW` on stderr                                  | Counted-unit errors lack native-unit provenance; early failures and background evidence are not fully exported by the profile writer.                      |

A real current invocation, shown for later contributor use and **not run for this report**, is:

```sh
GROWTH_PROFILE="$PWD/.temp/growth-owner.jsonl" bun run --cwd services/kernel check test/support/growth.test.ts
```

Run it from the worktree root with `.temp/` available; replace the test path with the owner's actual native suite.
The existing check runner owns database preparation and resource admission. The acceptance manifest separately names
`test/support/growth.test.ts test/support/growth-counters.test.ts`; this report executes neither. `GROWTH_RULE=series`
selects series unless the check specifies a rule. `GROWTH_PROFILE` opts into append-only JSONL; it is not a report viewer
or a proof of completeness. No new CLI is needed for this journey.

The contributor first fixes an admitted neighbourhood: actor/anchor, selected keys, page/change count, authorization
fanout, dependency depth and response payload. For an indexed fixed-neighbourhood operation, derive examined rows and
statements from that finite composition, logarithmic blocks from the actual descents, and bytes from the admitted
payload/statement parameters. For a bounded job step, derive change-proportional work and the continuation boundary.
Include denied, empty, retry, lookahead, discarded candidates, receipts, outbox and native authorization. A response
limit alone is not a derivation. `indexProbes` must describe actual growing-index descents under the existing rule.

Then use `Population.write` for ordinary writes, or `Population.rows` with identical production shapes plus `finish`
for real derived state. Bulk seeding is fixture preparation, not an alternate production API. The measured closure
invokes the authentic operation and awaits its declared completion, including owned worker steps. Assertions outside
capture can establish useful results, denials and fixture shape; they cannot substitute for measuring the actual path.
`warmup` uses spare state on the same production path for consumable operations; `prepare` is outside measurement.
Fresh keys must preserve the intended starting semantics. Keep default warmups and adopted settle behaviour.

## Independent growth is a model, not a large fixture

At minimum name total population, selected hot-partition population, unrelated same-owner history, unrelated-owner
history, and relevant dependency/fanout growth where applicable. A coupled fixture can conceal which input causes
work; a helper's deterministic placement does not establish independence. Run separate declared sweeps: grow one
unrelated axis while holding the admitted neighbourhood and other axes fixed, then test genuine input/fanout growth
under its own bound. Growing total and hot partition together remains useful, but is not the only sweep.

For example, keep a selected subject's admitted page and Access neighbourhood fixed while independently increasing
nonmatching rows in its partition, rows in other partitions, and receipts/history for its owner and other owners.
Separately grow actual changed neighbours when the operation promises change-linear work. Record relevant key
distribution, widths, selectivity and derived rows, not just inserted row totals. Definitions/configuration can remain
small if they do not grow in production. No fixture floor, synthetic statistics, forced plan or blanket scan ban is
needed. The existing targeted access-path helper is supplementary; it does not establish capture completeness.

`ReportSample.seeding` records statements/rows written and preparation times; `relationSizes` records `reltuples` and
`relpages` for measured relations. Those planner estimates are not exact per-axis counts, and relations omitted by
capture cannot validate their own coverage. `growth-baseline.ts` has specialized semantic-history helpers, but is not
re-exported by the facade and is not a general independent-axis interface. A minimal additive design is an optional
growth-model description plus a setup-side observation hook returning axis cardinalities/footprints and fixed
neighbourhood evidence. Persist these alongside the existing samples. Do not put fixture-observation SQL in measured
work or import unrelated module SQL to fabricate a native operation.

## Ownership must follow actual episodes

The complete chain is invocation → operation/request or worker lineage → database connection lifetime → transaction
episode → statement occurrence → native plan/effect → classified cost → projected verdict → diagnostic artifact.
Reusable backend PID is only one identity component. PostgreSQL ReadyForQuery reports idle `I`, active transaction
`T`, or failed transaction `E`; reaching ReadyForQuery does not necessarily end a transaction. The protocol also has
query-cycle boundaries distinct from individual statements. [Protocol flow][protocol-flow], [message formats][protocol]

Recommended additive evidence identifies database/server, connection lifetime, backend PID, monotonically distinct
query-cycle and transaction episodes, occurrence, and owning request/workflow lineage. An explicit transaction spans
`T`/`E` cycles until it returns idle; implicit transactions and multi-statement messages need their actual protocol
boundaries. No assigned transaction ID is required for read-only episodes. Record end state, error and completion or
incomplete coverage. Keep connection counts separate from transactions, queries and worker episodes. Never make all
work from a PID foreground because one prior episode belonged to the operation.

Today `currentAttribution()` follows async context; DBOS work during capture is foreground unless its workflow ID is
recognized as scheduled. Its own comment acknowledges that an unrelated nonscheduled workflow can be charged to the
operation. That conservative fallback can produce a false failure; it does not prove ownership. A detached owned
workflow beginning after capture drains can also fall outside the evidence. Capture drains queries already tracked,
not arbitrary future work. The missing design is an explicit lineage/completion binding for an owned worker episode,
with independent work retained separately. Reuse real workflow/request identity, not SQL/backend matcher exemptions.
The current `attempts` parser recognizes SQL transaction commands per backend; it is useful retry evidence, not this
protocol episode model. Nested captures across databases are implemented; the outer report is not automatically a
single combined cross-database budget or counted-connection result.

## Capture every owned native effect before projection

The installed session capture already enables JSON auto_explain, analyze, buffers and nested statements with full
sampling; trigger timing is off. PostgreSQL distinguishes nested statement plans from trigger timing statistics.
An outer SQL string need not match a nested function/trigger/RI statement. EXPLAIN buffer counters include child work,
so aggregating roots and nested documents also needs explicit overlap accounting. [auto_explain][auto],
[EXPLAIN guide][explain], [EXPLAIN options][explain-options]

Static boundary findings to route to the **existing native capture/cost owner**, not a second implementation slice:

- `growth-capture.ts` records `planStatements` while notices arrive on the active client occurrence, including nested
  notices. But `growth-cost.ts:costOf` and `withoutCatalogTexts` still use client SQL/backend matching when deciding
  which plans survive. Occurrence ownership must survive different or absent nested Query Text; a matcher cannot be
  the completeness condition. Missing text must not become zero native work or attach to another request.
- `statementOccurrences` retains linked native documents, whereas grouped attributions match query text. Those views
  can disagree with inclusive totals. Require reconciliation under the owner's native aggregation semantics, including
  parent/child buffer overlap, CTEs, filtered/rechecked rows and repeated loops; do not invent a second cost formula.
- PostgreSQL 19's `RI_FKey_check` can directly probe a unique index and lock a tuple without SPI/executor plans. The
  harness comments acknowledge missing existence-probe plans. That does not make the physical work disappear.
  Account for native work in the enclosing episode where exposed; identify unobservable units explicitly and require
  the capture owner's supported evidence path. A derived bound on unique lookups is not a measured row count.
  Parent delete/cascade SPI work is a separate case, not covered by the fast-path explanation. [RI source][ri]
- Failed statements count with SQLSTATE; prior completed work survives an aborted attempt. A failed execution can
  lack a completed plan. Preserve unavailable row/block coverage rather than asserting zero or replaying it as a
  substitute measurement. Keep the adopted serialization/deadlock treatment.

Catalogue handling is a **projection after ownership and native aggregation**. Preserve the raw owned ledger, classify
catalogue-only evidence using the full native dependency set, and apply the already adopted catalogue rule to that
view. A catalogue-looking caller whose nested work reads application data cannot hide it. A mixed plan counts in
full. No SQL/backend exclusions should repair capture gaps. `withoutCatalogStatements()` is a real exported helper
for direct captures; using it does not certify that its input captured everything.

`pg_stat_statements` is useful independent aggregate evidence, not an ownership oracle: its grouping uses database,
user, normalized query identity and top-level status, not request/session/transaction episodes. `track=all` includes
nested statements but not a per-occurrence plan ledger; representative SQL can be unavailable, and failed execution
statistics have limitations. Concurrent snapshots cannot attribute a delta to this operation. Do not reset shared
statistics or add it as a production prerequisite. Any isolated test-side cross-check remains supplementary.
[pg_stat_statements][pgss]

## Units, verdicts and actionable results

| Unit or result         | Current meaning                                                                                              | What an end-to-end report must make explicit                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rows                   | Executed scan output plus filter/recheck removals, multiplied by loops                                       | Examined work differs from returned rows; unavailable native work is identified.                                                                                                                 |
| Shared blocks          | Hits plus reads, with current tree/CTE accounting                                                            | Non-distinct buffer accesses, not unique pages, latency or disk reads; nested overlap must reconcile.                                                                                            |
| Statements             | Client application statements; controls/catalogue classified separately                                      | One outer statement may own many nested native executions. Keep both ledgers; do not relabel every plan as a client round trip.                                                                  |
| Request/response bytes | Driver SQL/prepared-value payload and returned field payload, optional bounds                                | Not HTTP bytes, complete wire framing, WAL or native storage traffic. Nested server SQL does not create a client request payload.                                                                |
| Connections            | Distinct foreground backend PIDs when configured as a counted unit                                           | Connections are not transaction episodes; cross-database/session lifetime identity needs care.                                                                                                   |
| Native counted units   | `counted.read(value, scale)`, integer validation, scale medians/repetitions, numeric limits/growth bounds    | Contributor return values need provenance from the authentic native port. A synthetic returned `scale` tests the harness only. Current limits test scale medians, not every execution's maximum. |
| Independent background | Separate capture statements/plans/bytes; per-statement application rows/blocks bounded under existing policy | Preserve occurrence, owner and own bounded-work evidence. Poll counts depend on duration; DBOS-only history remains reported under its adopted boundary.                                         |

The existing selected verdict is compatible, violation or inconclusive. Only established violations block; an
inconclusive result passes with `GROWTH_REVIEW` and remains a review obligation. Use the adopted calibrated
uncertainties (rows 22; blocks max(9, 3%); statements exact), envelope/series policy, step corroboration, index-depth
allowance and retry/settle handling unchanged. Compatibility means no established violation over the measured range,
not proof of an asymptotic class or complete capture. Capture errors and unavailable evidence must remain identifiable
separately from compatible measurements; no tolerance expansion repairs missing work.

`GrowthReport.samples[*].occurrenceRepetitions` retains exact native documents in memory. The JSONL writer exports
selected-rule verdicts, shadow, repetitions, relation sizes, seeding, attempts, counted values and grouped foreground
statements. It omits those native occurrence documents and complete independent-background evidence. Profile write
failure only warns; exceptions before report construction can leave no profile entry. `growth-profile-read.ts` is a
calibration-oriented parser, not a public actionable report viewer; neither it nor `growth-report.ts` is re-exported
as a facade API. These are concrete durable-report gaps, not absence of reporting altogether.

Add a backward-compatible artifact version and optional detailed output/sink, with one terminal record even on
capture, operation, attribution, catalogue, counted or background failure. Reference the native owner's occurrence
ledger rather than duplicating it. Include model/axis observations, ownership/coverage, raw and projected totals,
background evidence, rule/calibration identity, failed attempts, selected verdict and any diagnostic artifact path.
An actionable text view should say: operation and Cost link; axis/fixed neighbourhood; scale/repetition and unit;
observed values/limit or intervals; responsible episode/occurrence/node/relation; coverage caveat; next owner/action.
For example: an indexed read's unexpected application scan routes to its algorithm/fixture owner; an unmatched owned
nested plan routes to capture/cost; moving relation counters route to the existing settle diagnostics writer. A
successful shell exit alone must never be displayed as accepted/promoted or as affirmative evidence for an
inconclusive metric. The detailed sink is additive; do not change the adopted nonblocking classifier policy.

## Primary-source patterns and recommendation

Rails query assertions scope real application execution, establish connection/transaction state before capture,
and print executed queries on count mismatch. They measure client events, not hidden database physical work. Borrow
the narrow invocation and useful failure output, not their schema/cache filters or regex selection. [Rails source][rails]
Google Benchmark binds input size with `SetComplexityN`, fits a declared family or selects by normalized RMS, and
reports coefficient and residual. Its source uses a high-order-term least-squares fit, not this harness's calibrated
counted-work acceptance model. Reuse explicit input identity and retained fit diagnostics; retain adopted policies.
[Benchmark guide][benchmark-guide], [fitting source][benchmark-fit]

pgTAP supplies native database assertions with test descriptions, diagnostics and planned-test completion;
`performs_ok` and `performs_within` measure elapsed time. It is suitable supplementary SQL behaviour/schema tooling,
not a replacement for production-handler capture or counted growth. Its own performance test checks a failing
diagnostic and finishes/rolls back. [pgTAP source][pgtap], [performance test][pgtap-test]
PostgreSQL pgbench reports script/command failures and retries separately, a useful diagnostic pattern for authentic
episodes; throughput/latency are a different purpose. No new runner or database extension is needed here. [pgbench][pgbench]

The common pattern is explicit workload boundaries, meaningful units, controlled state and retained failure
evidence. None supplies automatic full request-to-trigger ownership for this stack. Recommend only these whole slices:

1. **Contributor model and native scenario binding:** adopt a concise Cost-to-invocation recipe, optional axis
   observations and explicit native-unit provenance; bind the reserved counters journey through authentic operations.
   Reuse seed/check APIs. This closes model and complete-scenario gaps together, not a new fixture framework.
2. **Complete diagnostic artifact:** consume the native capture/cost owner's episode ledger and settle writer's
   diagnostics; persist terminal coverage, raw/projected/background evidence and render the actionable text above.
   Include failure-path export and old-profile compatibility in the same slice, not a standalone cosmetic formatter.

Precise episode ownership, nested capture/cost conservation and catalogue projection corrections stay with the
existing native capture/cost owner. New settle diagnostic work is not assigned here. Adoption must precede
implementation. UI, new benchmark engines, classifier redesign and physical database-copy orchestration are deferred.

## Exact later proof cases (not executed here)

`growth-counters.test.ts` **exists now**, contrary to the manifest's stale absence sentence. Its five tests cover
counted limit failure, counted growth failure, median/profile persistence, missing-unit refusal and backend counts.
They use `SELECT 1`/synthetic returned values and empty grow. No test has the reserved title
`counted-unit-ceilings-at-three-scales`, and these tests do not bind its complete native journey. This is implemented
partial support with a contract-registration gap, not evidence that the reserved scenario passed or is promoted.
The native owner should preserve existing tests and add the missing complete binding later.

| Later proof                             | Required observable evidence                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `counted-unit-ceilings-at-three-scales` | Real production operation at three independently seeded scales; examined/removed rows, shared blocks, client statements, both byte payloads, backend connections and authentic native counted units all captured, attributed and asserted; independent background has its own bounded statements. Include useful result assertions and native provenance. |
| Independent axes                        | Separate hot-partition, other-partition, same-owner-history and other-owner-history sweeps with fixed selected neighbourhood; separately derived affected-fanout series. Axis observations prove what actually grew; an omitted expected population is a coverage diagnostic.                                                                             |
| Nested work conservation                | Trigger/function SQL with different Query Text, missing-text replay of the capture data, RI direct-probe and SPI/cascade cases; all owned effects survive costing and catalogue projection. Parent/child/CTE overlap reconciles without double charging; unavailable native units are visible.                                                            |
| Episode separation                      | Same pooled backend serves operation A, independent B and operation C sequentially; B is never borrowed. Include read-only and failed `E` transaction states, queued statements, implicit/multi-statement cycles, reconnect/PID reuse and cross-database capture.                                                                                         |
| Worker completion                       | A real owned queued workflow/child completes after the initiating callback; independent nonscheduled and scheduled work remains separate. Completion receipt closes coverage; unfinished/detached work cannot be represented as complete.                                                                                                                 |
| Failure/uncertainty                     | Existing calibrated compatible/violation/inconclusive controls unchanged; SQLSTATE retry, failed statement without plan and settle failure retain coverage/reasons. Counted missing-unit/over-limit and background scan failures retain their evidence and actionable owner.                                                                              |
| Durable diagnosis                       | In-memory and persisted foreground/background/occurrence totals reconcile; catalogue-only and mixed nested cases conserve raw work. Capture/operation/early assertion and artifact-write failures have explicit terminal/export status; legacy JSONL remains readable.                                                                                    |

These are future acceptance requirements for adopted slices and existing owners, not new tests or acceptance runs
in this research task. No owner contracts, frozen tests, fixtures, schemas, settings or control-plane state changed.

## Source register

All external links below were accessed 2026-10-30. Source paths are pinned for inspected code; no substantial source
was copied. Clones remain under the main checkout's ignored `.reference/`, registered in its `INDEX.md`.

| Primary source                  | Revision, inspected paths and licence                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL documentation        | Version 19 EXPLAIN, auto_explain, pg_stat_statements, protocol and pgbench pages linked below; PostgreSQL License ([licence](https://www.postgresql.org/about/licence/)).                                                                   |
| PostgreSQL source, reused clone | `.reference/library-shelf-maintenance/postgres`; `0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89` (REL_19_RC1), `src/backend/utils/adt/ri_triggers.c`, `contrib/auto_explain/auto_explain.c`; PostgreSQL License, `COPYRIGHT`.                    |
| Rails, reused clone             | `.reference/performance-hot-path-bounds/rails`; `2d8fbfaca37d5dbbac95a44ea4c300ef54a767de`, `activerecord/lib/active_record/testing/query_assertions.rb`; MIT, `MIT-LICENSE`.                                                               |
| Google Benchmark                | `.reference/performance-growth-harness/benchmark`; `53aaafd9f2b0005f85c302711e40fd8e4ca60e38`, `docs/user_guide.md`, `src/complexity.cc`; Apache-2.0, `LICENSE`.                                                                            |
| pgTAP                           | `.reference/performance-growth-harness/pgtap`; `21ceed193bf370892d530c5115680839ee322851`, `doc/pgtap.md`, `sql/pgtap.sql.in`, `test/sql/performs_ok.sql`; PostgreSQL License, `README.md` Copyright and License, confirmed by `META.json`. |

[auto]: https://www.postgresql.org/docs/19/auto-explain.html
[explain]: https://www.postgresql.org/docs/19/using-explain.html
[explain-options]: https://www.postgresql.org/docs/19/sql-explain.html
[pgss]: https://www.postgresql.org/docs/19/pgstatstatements.html
[protocol]: https://www.postgresql.org/docs/19/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-READYFORQUERY
[protocol-flow]: https://www.postgresql.org/docs/19/protocol-flow.html
[pgbench]: https://www.postgresql.org/docs/19/pgbench.html
[ri]: https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/utils/adt/ri_triggers.c
[rails]: https://github.com/rails/rails/blob/2d8fbfaca37d5dbbac95a44ea4c300ef54a767de/activerecord/lib/active_record/testing/query_assertions.rb
[benchmark-guide]: https://github.com/google/benchmark/blob/53aaafd9f2b0005f85c302711e40fd8e4ca60e38/docs/user_guide.md#asymptotic-complexity
[benchmark-fit]: https://github.com/google/benchmark/blob/53aaafd9f2b0005f85c302711e40fd8e4ca60e38/src/complexity.cc
[pgtap]: https://github.com/theory/pgtap/blob/21ceed193bf370892d530c5115680839ee322851/sql/pgtap.sql.in
[pgtap-test]: https://github.com/theory/pgtap/blob/21ceed193bf370892d530c5115680839ee322851/test/sql/performs_ok.sql
