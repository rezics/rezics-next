# Local store counted SQLite growth evidence

This reconciliation uses the committed additive probe API at
`b62550eaa61df4b4dab54cc3f9022479311b55b3` (`tests/support/sqlite-growth.ts`). Each migrated
sample reads `measure().counts`, then uses the shared `countedSample`, `countedViolations`
and `CountedCheck` exports. Units are **sqlite statements** (native executions, including
transaction controls) and **sqlite returned rows** (rows delivered to callers). These are
neither internal visited rows nor PostgreSQL statements/shared buffers. No buffer or IO
measurement is claimed. Actual bound SQL parameters and EQP plans remain evidence;
verification rejects scans, automatic indexes and temporary sorts and requires real SEARCH
proof. Setup, cardinality assertions, ANALYZE and EQP execution stay outside capture.

The owning importer README Cost rows were read for record get/count/page/upsert, run
staging/key/pages and binding lookup/candidate page/media projection/writes. The README
remains separately owned; this report does not claim all importer costs are migrated.

## Stored neighbourhoods

N is directly 64, 512 and 4096 unrelated stored keys/history records, never a multiplier
or supplied byte size. All growing neighbours share the measured target's source. Existing
fixture builders and production local-store operations are reused; no server authority or
effect SQL is involved. File-backed journals remain under `tmpdir()`; memory stores remain
in memory. All table cardinalities below are asserted before measurement.

Binding fixtures add one fixed hot owner (or eight hot candidates) to N unrelated owners.
The candidate write seed retains its original two-candidates-on-one-neighbour distribution
and consistent group/record counters. Table counts, in records/groups/journal/candidates/media
order, are:

| Fixed operation    | Per-table rows before capture |
| ------------------ | ----------------------------- |
| claim + journal    | N+1 / 0 / N+1 / 0 / 0         |
| candidate page (8) | 0 / 0 / 0 / N+8 / 0           |
| media projection   | N+1 / 0 / 0 / 0 / N+1         |
| binding write      | N+1 / N+1 / N+1 / N+1 / 0     |
| media write        | N+1 / 0 / 0 / 0 / N+1         |

RecordStore now grows N acknowledged records in the target's own source rather than
one record per unrelated source. Its source-count table has one correctly maintained row;
prior measured targets are additional acknowledged rows (0, 1 and 2 before capture).
The fixed insertion still increments the stored count once.

Run fixtures retain failed one-record historical generations, live same-source keys and
immutable entries from earlier samples. Counts before the first fixed operation at each N:

| Suite       |    N | sources | generations | entries | members | acknowledged | commands/payloads/envelopes |
| ----------- | ---: | ------: | ----------: | ------: | ------: | -----------: | --------------------------- |
| record caps |   64 |       1 |          66 |     192 |      64 |           64 | 0 / 0 / 0                   |
| record caps |  512 |       1 |         516 |    1667 |     512 |          512 | 0 / 0 / 0                   |
| record caps | 4096 |       1 |        4102 |   13446 |    4096 |         4096 | 0 / 0 / 0                   |
| empty run   |   64 |       1 |          65 |     129 |       0 |           64 | 0 / 0 / 0                   |
| empty run   |  512 |       1 |         514 |    1090 |      65 |          513 | 0 / 0 / 0                   |
| empty run   | 4096 |       1 |        4099 |    8771 |     513 |         4097 | 0 / 0 / 0                   |

Record caps independently stages and reads each supplied M=72/144/288 KiB record at every
N, preserving exact serialized-byte deltas, UTF-8 accounting, projection/parser caps,
framing overhead and upstream cleanup. Larger records do not stand for more stored rows.

## Exact ceilings

All pairs below are returned rows / native executions. Growth is constant with zero
additional allowance, and absolute ceilings remain independently asserted:

- Binding claim + journal: 2/2 (two point lookups); candidate page: 8/1 (r=8);
  media projection: 2/2. These ceilings follow the owning Cost row.
- Binding writes: 14/20; media writes: 10/16, unchanged.
- Record insertion: at most 1 returned row / exactly 5 executions (three point statements
  plus BEGIN/COMMIT), derived from the upsert Cost row. Writes do not return changed rows.
- Record caps: general 5/9; stage exactly 1/6, key read exactly 3/5, page exactly 2/2.
- Empty run: general 2/7; resolution exactly 2/7; nested transaction/key read exactly 1/5.
  Original BEGIN IMMEDIATE/COMMIT traces, nested control counts, insert changes and per-read
  delivered row counts remain exact. Idempotent resolution retains the same ceiling.

SQL binding/index, transaction, lazy-row, serialized-byte and limit assertions are retained.
The native probe and all public helper/caller signatures outside the assigned files are
unchanged. No product algorithm, native API case, grant or PostgreSQL witness is amended.

## Verification and remaining migration

The focused four-suite acceptance and root typecheck are recorded with their revision and
log paths in the delivery summary. No whole-kernel or root gate is part of this evidence.

Remaining direct legacy `.cost` callers in importer tests are `sqlite-growth.test.ts`,
`run-store-growth.test.ts`, `run-store-native-keys-growth.test.ts`, `run-store-pages.test.ts`,
`vndb-tables.test.ts`, `vndb-tables-growth.test.ts`, `vndb-chunk-growth.test.ts`,
`vndb-archive-limits-growth.test.ts` and `cli-driver.ts`. The reconciliation growth suite
also accesses application command `.cost` metadata; its SQLite measurements already use
named counts. Compatibility remains for untouched callers only.
