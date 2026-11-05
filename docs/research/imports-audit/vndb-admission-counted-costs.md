# VNDB admission counted measurements

This acceptance-owner reconciliation changes only the local summaries and their consumers in
`services/importer/tests/vndb-archive-limits-growth.test.ts`. It uses the existing shared
`CountedCheck`, `countedSample` and `countedViolations` from
`services/kernel/test/support/growth-counters.ts`. Product code, shared interfaces, fixture traversal,
admission limits, cleanup and other acceptance owners are unchanged.

## Measurements and tolerances

Every compared unit has explicit `{absolute: 0, relative: 0}` slack. This preserves the prior stricter
overrides, including input and retention; the generic returned-row tolerance of 2/10% does not apply here.
There was no measured block-like byte unit in this file requiring the generic 4/50% tolerance.

| Consumer                     | Actual named units                           | Bound               | Exact obligations retained                                                                             |
| ---------------------------- | -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| Rejected fixed staging       | `sqlite statements`, `sqlite returned rows`  | Constant separately | Executions equal the raw plan-evidence delta; returned rows positive; rejection cleanup included.      |
| Ready fixed staging          | `sqlite statements`, `sqlite returned rows`  | Constant separately | Same raw execution identity and positive returned rows.                                                |
| Ready live buffers           | `line capacity bytes`, `input backing bytes` | Constant separately | Exactly 65536 and 128 bytes respectively at every scale.                                               |
| Entry-budget input           | `input bytes`, `entry and body events`       | Linear separately   | Bytes equal the budget; events remain the original sum of entries and bodies.                          |
| Byte-budget input            | `input bytes`, `entry and body events`       | Linear separately   | Independent byte budget with the same exact counters and combined-event identity.                      |
| Both budget modes' retention | `retained total bytes`                       | Constant            | Actual peak of the existing retention observer; zero slack, without a fabricated zero statement count. |

The async `stageProbe` sums actual `sample.counts` from each synchronous execution while staging is active
across awaits. Its preparation/capture boundary and active interval are unchanged. Full SQL, binds,
per-execution returned rows and EQP remain in the existing probe evidence. Every existing plan row still
forbids SCAN, TEMP B-TREE and AUTOMATIC and requires a declared index with `source=? AND run_id=?` prefix.
No SQL/plan validator, rollback or cleanup behavior is changed.

This wrapper instruments prepared `get/all/run/values/raw` methods obtained through `query/prepare`.
It does not activate capture around direct `db.run` or `db.exec` calls, nor add an async iterator wrapper.
The shared probe's broader capabilities do not enlarge this local wrapper's observed surface. Returned
rows are rows delivered to callers, not examined rows, VM steps or SQLite buffer I/O. No missing producer
is represented as zero; unavailable block counts and the fake retention statement sample are removed.

## Scales, populations and admission identities

All logical scales remain **1/8/64**. The accumulating history seed places **128/1024/8192 rows per
source** in each of `vndb_table_runs`, `vndb_table_rows` and `vndb_table_spool`. The three source labels
are `vndb`, `other` and `history`, giving **384/3072/24576 seeded rows in each relation**, before adding
the fixed measured runs. The unchanged explicit other-source assertion is exactly `128 * scale`.
The larger totals are across all three sources, rather than all being same-source VNDB history. This
interpretation follows the actual seed and the committed inventory; it preserves their populations.

Fixed staging still consumes the same six fixture entries, with data before headers. Rejection observes
seven entries, six bodies and six body closures, closes the outer archive, and retains zero rows/spool
for the failed run. Successful staging observes six entries and bodies, returns exactly two records,
and retains the original exact input-byte and byte-visit identities. Failed and ready results survive
reopening the file database; a failed run cannot be staged or paged again.

Each independent entry/byte budget remains `8 * scale`: **8/64/512**. Observed entries are exactly
**9/65/513**, bodies, admitted bytes and body closures are each **8/64/512**, and the original combined
entry-plus-body event count is **17/129/1025**. The excessive body is never opened, the outer iterator
closes, and scans remain zero. Retention continues to measure parser storage capacity through the
existing observer, including its accounting metadata; zero slack is not a claim of zero retained bytes
or zero general heap usage.

Unsafe, overflowing, negative, fractional and infinite declarations, short/lying/mutated bodies,
oversized backing and pre-schema option rejection cases keep their original assertions. No source,
permission, timeout, retry or business semantics change.

## Sources, decisions and scope

The full remaining-port inventory was read directly from its committed candidate
`5c47a835ca8f0804fee95df9bc28a696a5584366`, at
`docs/research/imports-audit/remaining-cost-unit-ports.md`; its source revision is
`860ec3c071f213ccd3cd0ad288f7bf0777c20384`. It is absent from this checkout's base
`22ec9cb1cba1989612a0fa1026244930e49a4183` and was not assumed to be integrated.
The actual local shared counted API, SQLite probe, target test, `VndbTablesStore.stage/readEntry` and
`DumpMemory`/`observeDumpRetention` were read before editing. No external reference project was needed.

Decisions: preserve the original combined entry/body event bound instead of replacing it with separate
weaker checks; name line capacity separately from input backing; retain zero tolerance on every actual
compared unit; report source-specific and all-source seeded populations distinctly. This is a unit
correction of existing local evidence. It does not close missing hot-population or filtered-list axes,
prove native/API/PostgreSQL behavior, or establish all importer costs. No README or file outside the two
assigned paths is changed.

## Verification

The executable change is committed before each managed check. Required commands are the one focused
acceptance run and the importer-scoped typecheck; the specific contract excludes root typecheck and
whole-workspace gates. SQLite files use the existing `os.tmpdir()` directory, and managed logs stay
under `.temp/goal/checks/`.

Both commands tested executable revision `55bf3a9224`; only this report is amended afterward.

| Managed command from the worktree root                                                               | Terminal result                                                                       | Log                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `bun scripts/worker-check.ts -- bun test services/importer/tests/vndb-archive-limits-growth.test.ts` | Exit 0; 4 pass, 0 fail, 466 assertions, one file; 222 ms.                             | `.temp/goal/checks/worker-check-2026-10-29T13-32-09.049Z-4d5fb16f.log` |
| `bun scripts/worker-check.ts -- bun run --cwd services/importer typecheck`                           | Exit 0; no type errors in 133 files, 367.66 ms; remote command 0.384 s, peak 235 MiB. | `.temp/goal/checks/worker-check-2026-10-29T13-32-15.196Z-515c5e85.log` |

The focused run passed all four original scenarios: fixed rejection/ready SQL and buffers; independent
entry/byte budgets; unsafe declarations/bodies/backings; and pre-schema option validation. The scoped
typecheck queued for a shared remote slot. Intermediate wait status 75 meant still queued; the same
check handle was awaited until terminal exit 0, without another check run or an infrastructure failure.
Neither command was rerun, and no check remains live.

The complete executable diff is 59 added and 25 removed lines in the existing test: named check
declarations, actual async probe count aggregation, and all SQL/input/retention consumers. The only
other changed file is this new report. All remaining original assertions and test scenarios are intact.
