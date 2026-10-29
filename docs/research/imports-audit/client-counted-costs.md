# Importer client counted-cost correction

This audit correction distinguishes measured work by the layer that performs it. The SQLite probe exposes additive
raw counts named `sqlite statements` and `sqlite returned rows`, collected from the same native executions and rows
delivered to callers. Its captured SQL, bound parameters, execution plans and indexed `SEARCH` evidence remain the
proof of the SQLite path. SQLite buffer/block counts are unavailable and are not represented as zero. The probe's
older `.cost` field remains deprecated compatibility for tests not migrated in this slice.

These importer suites do not capture PostgreSQL. The labels `PostgreSQL rows`, `PostgreSQL blocks`, and
`PostgreSQL statements` belong only to checks backed by actual PostgreSQL capture. HTTP request counts describe
client transport activity; they do not measure coordinator batching or server work.

## Migrated evidence

- `sqlite-counted-units.test.ts` measures one real keyed insert and one real keyed select. It asserts their exact SQL,
  parameters, returned row count and indexed `SEARCH` plan, and checks that no blocks or PostgreSQL unit is claimed.
- `importer-reconciliation-growth.test.ts` seeds same-source records and history at 64, 512 and 4096 records. A
  fixed changed-record reconciliation checks counted SQLite statements/returned rows, one transport request and
  exactly nine fence calls at each history size. The command-width axis is separately sampled at 2, 8 and 32 aliases,
  below the 512-fact per-command cap. The actual seed acquisition reads 64, 512 and 4096 records once each, reaches
  EOF before the first transport effect, and reports linear input-record counts.
- `importer-growth.test.ts` exercises client transport with 64, 512 and 4096 supplied commands in batches of at most 100. It asserts exactly `ceil(N / 100)` sends, one send for every supplied batch, no extra route calls, and linear
  counted request/command work. It makes no claim about stored/imported server rows.
- `record-cpu-growth.test.ts` counts converter calls, SQLite prepares, SQLite executions and SQLite commits at its
  existing 16, 64 and 256 record scales. Existing exact marginal ceilings remain: at most 0.1 prepares, exactly 5
  converter calls, at most 3.1 transactions and at most 165 executions per added record; constant prepare growth is
  required and per-record work may not drift upward.

## Restored prepare bound

The migration at `2d207cfb8af1f9a082cd355bda6fdff3bff196dc` collected `SQLite prepares` but omitted it from
`CountedCheck.bounds`. The pre-migration case required constant prepare growth under the incorrect blocks label.
The existing shared check now restores that obligation as `'SQLite prepares': 'constant'`, using zero default
slack. The marginal ceiling of 0.1 prepares per added record remains, but alone allows extra prepares and does not
prove constant growth. All three scales, exact marginal ceilings, transaction and commit rate checks, behavior
assertions, temporary-directory cleanup and timeout are preserved. Bounded diagnostics report all three raw samples.

The prior receipt reported four passing tests and 9,015 assertions; it predates this focused correction and does not
prove the omitted bound. These are machine-independent work counts, not real CPU timings or whole-importer/server
scaling evidence.

Focused correction evidence, tested revision `4b91afdd21`:

| Records | Converter calls | SQLite prepares | SQLite executions | Transactions | SQLite commits |
| ------: | --------------: | --------------: | ----------------: | -----------: | -------------: |
|      16 |              80 |              62 |              2654 |           51 |             51 |
|      64 |             320 |              62 |             10526 |          195 |            195 |
|     256 |            1280 |              64 |             42032 |          773 |            773 |

Command: `bun scripts/worker-check.ts -- bun test services/importer/tests/record-cpu-growth.test.ts`.
Check ID: `3fd89030-47a7-4407-a903-729877a3d7c7`; log:
`.temp/goal/checks/worker-check-2026-10-29T10-22-51.029Z-75d4abd7.log`; terminal exit status **1**
(0 pass, 1 fail, 4 assertions). The wrapper selected the cached pinned Bun revision
`a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b` and the remote runner's temporary filesystem.

The first failure is `expect(countedViolations(check, samples)).toEqual([])`: the violation is
`{ unit: 'SQLite prepares', scale: 256, value: 64, limit: 'constant', kind: 'bound' }`.
Prepares grow from 62 to 64, so the restored zero-slack requirement fails. The retained marginal ceiling alone
would allow this increase (2 / 240 prepares per added record). Later marginal and rate assertions were not reached
in this run. The assertion remains restored; runtime repair is outside this correction's contract. No broader
importer, kernel or root check was run.

The native/local outcome remains **RED**: the constant-prepare requirement is unachieved. This is a
specification artifact delivery preserving the restored assertion and the recorded failure, not a runtime repair
or passing native acceptance. The totals do not establish the cause: additional cold literal SQL branches at page
thresholds could produce a bounded jump; these samples alone prove neither per-record nor indefinite prepare
growth. Actual-cause investigation remains separate.

The frozen, controller-formatted test is preserved at Git blob `51646d618c1482af9fc53e8f671f28f17b0ba062`.
This documentation continuation uses only `test -s docs/research/imports-audit/client-counted-costs.md` for artifact
acceptance; the completed focused check is not rerun, and no typecheck or broader gate is required.
converter calls, at most 3.1 transactions and at most 165 executions per added record. On the inspected base,
prepares are reported but absent from the counted growth bounds; this is not constant-prepare proof.
Per-record work may not drift upward.

## CPU amendment prerequisite mismatch

Inspection on 2026-10-30 at `0378f4bb1cabf15eff4ef8269f9e0c746d0e6a0f` found that the prerequisite restored
CPU case is absent. The authorized amendment requires preserving the restored constant prepare bound, diagnostics
and frozen case, whose specified formatted SHA256 is
`cfd7a51a577b8f6825e940ed425f70854b5d8178f5732fc27d78ee9aadeb732b`.
The actual formatted file has SHA256
`53c72ec5b9d4e15637c01fad80a61d01e2b5cd6f687c2fae8ff0d0bb0e11a851`.
Its `check.bounds` contains only converter calls, SQLite executions and SQLite commits. SQLite prepares appear
in sample values and the marginal ceiling of 0.1, but have no constant bound or independent exact equality
assertion. It also has no raw-sample diagnostic output. `countedViolations` visits only declared bounds/limits,
so an increase from 62 to 64 prepares would not fail that omitted bound.

The test and driver remain byte-for-byte unchanged: old and new actual CPU file hashes are both
`53c72ec5b9d4e15637c01fad80a61d01e2b5cd6f687c2fae8ff0d0bb0e11a851`.
The full CPU/driver diff is empty. Existing scales remain 16/64/256 and the timeout remains 120000 ms.
No cause diagnostic or final CPU check was run: running this case cannot supply the required honest
constant-bound RED, and restoring a different frozen case is outside the narrow scale amendment.
The predecessor's stated 62/62/64 values are supplied evidence, not values reproduced by this attempt;
actual per-scale event counts, distinct SQL sets and the proposed exact two-text difference remain unmeasured.
The 256/1024/4096 amendment is held until the required restored case is present and the cause is observed.

Source inspection confirms that `RunStore.query()` caches by literal SQL text and clears its cache when the
prepare callback identity changes; `RecordBindings.statement()` caches by literal text for its handle.
The existing driver installs `countWork` through `instrumentDatabase`, with prepare counting before preparation.
`RunStore.pageStaged()` and `pageAcknowledged()` have distinct first/after-key SQL literals; that observation
alone does not identify the measured two-site cause. Actual importer pending/staged/vanished page limits are
100, and binding candidate pages enforce a maximum of 100. No cache, callback, counter or runtime was changed.

The integrated inventories `remaining-cost-unit-ports.md` at
`472aa311ffe270eca9f01f7d7bf633281c76f14d` and `vndb-tables-binding-seams.md` at
`14659f678751fc153ab67752628b9d9efc32c15d` are source inventories, not native passes. Their observations do
not supply the missing CPU prerequisite. This documentation change preserves the distinction between SQLite
executions/returned rows, input bytes/chunks, requests and retained bytes; unavailable SQLite blocks are not zero.
Old row-like slack 2/10%, byte/block-like slack 4/50% and execution zero remain obligations wherever the old
checks apply; counted defaults are zero and stricter explicit zero/exact ceilings remain binding. Raw SQL,
bindings, EQP, validators, combined events and separate PG-derived appended-row/calls-plus-plans checks remain
unchanged; canonical native PG capture remains separate. Physical populations and payload axes stay independent.
VNDB fourteen-case portable binding remains absent; production grouping retains `id`, `olang`, `c_votecount`
and `c_average`. Statistics six-case native binding and its source-statistic API effects remain distinct.
No producer, adapter, fabricated materialization/baseline or zero-I/O observation is introduced here.

Only this audit changes, with no outside-path changes or external reference-project research. Artifact
nonemptiness can establish delivery of this evidence, but cannot establish CPU equality, native/API/growth
acceptance, integration or promotion. The required next step is to supply the restored prerequisite case on
the assigned branch before performing its one cause run and authorized scale amendment.

## Documentation handoff

The importer README Cost row and the former title “Kernel call stays within its bound as R grows” need an owner-side
documentation update. Replace the old title's server-growth implication with the client transport description above.
Keep PostgreSQL metrics assigned to native API checks. Actual server-side sourced batch-write growth is covered by
`specs/imports-growth.test.ts` (run through `services/kernel/test/imports/growth-outcomes.test.ts`); its fixed 100-command
sample records PostgreSQL execution evidence. No kernel `batchWrite` scale check was run by this client correction,
so these results do not establish server-side batch-write scaling or close native API acceptance.

Native API and growth suites remain separate evidence. This change measures no product timeout, admission, retry or
source-semantic behavior.
