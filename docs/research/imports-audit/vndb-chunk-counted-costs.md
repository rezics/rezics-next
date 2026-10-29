# VNDB chunk counted-unit correction

The local async wrapper in `services/importer/tests/vndb-chunk-growth.test.ts` now sums the shared SQLite probe's
actual `sample.counts`, rather than its deprecated PostgreSQL-shaped cost summary. Its consumers use the shared
`CountedCheck`, `countedSample` and `countedViolations` API. No SQLite buffer count is available or reported.

## Capture and unchanged obligations

`stageProbe` remains installed before `VndbTablesStore` prepares statements. Its existing wrappers around
`query`/`prepare` execution methods and `db.run`/`exec`, statement identity, WeakSet protection and active measurement
boundaries are unchanged. Each synchronous execution is captured inside the asynchronous stage, across awaits and
through any cleanup inside that boundary. Returned rows and executions must both be positive, and the delta in
`verifyPlans()` evidence must equal the actual SQLite statement count exactly. Raw SQL, binds, per-execution
returned rows and EQP remain in the shared probe; its indexed SEARCH/key-prefix validation is unchanged.

The change adds no instrumentation, traversal, source interpretation or product code. It retains all five existing
tests, including both growth tests and every configuration/backing control. The exact admitted/visited/pulled-byte
equalities, chunk/pull equalities, retained-input and line ceilings, two-record result, zero-pull invalid configuration,
hostile backing rejection before visits, iterator closure without resume, failed-run cleanup and baseline preservation
are unchanged. Eight ignored invalid-UTF8 chunks still drain without scanning or persistence; the unlicensed sentinel
fixture and padding are unchanged.

## Units, tolerances and populations

| Actual unit | Bound | Absolute / relative slack |
| --- | --- | --- |
| `sqlite returned rows` | Constant on both axes | 2 / 0.1 |
| `sqlite statements` | Constant on both axes | 0 / 0 |
| `input byte visits` | Linear on the input axis | 2 / 0.1 |
| `input chunks` | Linear on the input axis | 0 / 0 |
| `admitted input bytes` | Linear on the input axis | 4 / 0.5 |

These are the previous inequalities on the same observations, with explicit tolerances because counted defaults
are zero. The former block-like input metric was actual admitted bytes and retains its 4/50% tolerance on that unit.
The unavailable SQLite block placeholder is removed; it is not replaced by an inferred physical-IO zero.

The SQL-history axis remains 32/128/512. It accumulates real same-source ready six-entry archives and keeps earlier
measured archives. At the end of each measured stage there are 33/130/515 runs and 231/910/3605 stored table rows,
seven per archive. Each measured archive contains the same two source records. These populations are not a new
4096-key hot-population or filtered-list axis.

The independent input axis remains 1/8/64, with VN entry bytes padded to 512 times the scale and the other five entries
unchanged. Actual iterator visits, admitted bytes and pulled bytes each equal the sum of all six encoded entry lengths.
Pulls equal admitted chunks exactly, at scale + 5 (6/13/69). Peak retained input is exactly 512 bytes, every observed
line buffer stays at most 65536 bytes, and the resulting page contains exactly two records. One new archive is staged
at each scale in this separate database; earlier runs remain. Only finite input work grows on this axis; SQL counts
remain constant. No numeric ceiling or raw identity is replaced by a growth classification.

## Sources and limits

Read the full remaining-port inventory from its committed source,
[`5c47a835ca` report](https://github.com/rezics/rezics-next/blob/5c47a835ca8f0804fee95df9bc28a696a5584366/docs/research/imports-audit/remaining-cost-unit-ports.md),
whose source inventory revision is `860ec3c071f213ccd3cd0ad288f7bf0777c20384`, since the report is absent from this
checkout's base. Also inspected this test, `services/importer/tests/support/sqlite-growth.ts`,
`services/kernel/test/support/growth-counters.ts`, `growth-bound.ts`, `services/importer/src/vndb-tables.ts` and the
VN fixture. No external reference project was needed or used.

This is local asynchronous capture of real SQLite calls and input observations. It proves neither native API nor
PostgreSQL work, SQLite examined rows, physical IO, general heap allocation, all importer costs or main-branch
acceptance. Separate missing hot-population/filtered-list axes remain open. The existing raw TAR observer, producer
semantics, shared counted API and other migration owners are untouched. Only the existing test and this report change;
there are no changes outside the declared paths and no README edit.

## Verification

The existing acceptance scenarios already cover the named contract, so no duplicate acceptance test or fixture was
added. The contract's specific no-shared-type-change exception selects the focused file and importer-scoped
typecheck, without a root typecheck or whole-workspace suite.

Checked test revision `544b424904f81d2e5b78f2c1cb66a30779a001c2` once with each managed command:

```sh
bun scripts/worker-check.ts -- bun test services/importer/tests/vndb-chunk-growth.test.ts
bun scripts/worker-check.ts -- bun run --cwd services/importer typecheck
```

- Focused acceptance: terminal exit status 0; 5 pass, 0 fail, 571 `expect()` calls across one file (363 ms).
  Log: `.temp/goal/checks/worker-check-2026-10-29T13-31-58.652Z-15f8cb43.log`.
- Importer typecheck: terminal exit status 0; no type errors in 133 files (391.63 ms). It queued for 613.060 seconds
  and was awaited on the same check through completion; no second run or diagnostic rerun was started.
  Log: `.temp/goal/checks/worker-check-2026-10-29T13-32-04.339Z-4b5f7304.log`.

Both checks are terminal, with no runtime conflict, infrastructure failure or remaining live check. The only later
edit records these results in this report; test bytes remain the checked revision's bytes.
