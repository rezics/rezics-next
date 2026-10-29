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
  converter calls, at most 3.1 transactions and at most 165 executions per added record; prepare growth remains
  constant and per-record work may not drift upward.

## Documentation handoff

The importer README Cost row and the former title “Kernel call stays within its bound as R grows” need an owner-side
documentation update. Replace the old title's server-growth implication with the client transport description above.
Keep PostgreSQL metrics assigned to native API checks. Actual server-side sourced batch-write growth is covered by
`specs/imports-growth.test.ts` (run through `services/kernel/test/imports/growth-outcomes.test.ts`); its fixed 100-command
sample records PostgreSQL execution evidence. No kernel `batchWrite` scale check was run by this client correction,
so these results do not establish server-side batch-write scaling or close native API acceptance.

Native API and growth suites remain separate evidence. This change measures no product timeout, admission, retry or
source-semantic behavior.
