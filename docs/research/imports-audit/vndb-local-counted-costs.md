# Local VNDB tables counted evidence

The two local suites exercise the real `VndbTablesStore` on temporary SQLite files. Their growth summaries use
the shared `CountedCheck`, `countedSample` and `countedViolations` from
`services/kernel/test/support/growth-counters.ts` with these units:

| Unit                   | Producer                                                          | Absolute / relative growth slack |
| ---------------------- | ----------------------------------------------------------------- | -------------------------------- |
| `sqlite returned rows` | Actual `get`, `all`, `values` and consumed iterator results       | 2 / 0.1                          |
| `sqlite statements`    | Actual synchronous SQL executions, including transaction controls | 0 / 0                            |

The asynchronous harness still starts capture before the operation, awaits it, finishes capture after it and
cancels on error. The first suite includes `begin` in measured staging; the second begins its run before capture.
The exported `sqliteEvidence()` port and its raw `{ rows, statements }` result are unchanged. Local consumers map
those fields directly to named units. Synchronous projection, validation and cleanup consume the integrated
probe's `sample.counts`. No missing producer is replaced with zero, and no SQLite block, examined-row, write-row
or cross-partition count is inferred.

## Preserved bounds and populations

In `services/importer/tests/vndb-tables.test.ts`, one-record pages still return `v123` with two titles and require
4–12 returned rows and at most 16 executions. Page and inspection counts remain constant; staging returned rows
and executions remain linear. All use the explicit slack above.

The accumulating same-source archive axis remains 32/128/512. At each scale, another n earlier archives each
contain two VNs and seven stored rows, followed by a hot archive with n+1 VNs and 3n+4 stored rows. The fixture
construction therefore retains these totals before the child cases:

| Logical n | Total runs | Total VNs | Total stored rows |
| --------- | ---------- | --------- | ----------------- |
| 32        | 33         | 97        | 324               |
| 128       | 162        | 482       | 1608              |
| 512       | 675        | 2019      | 6732              |

These headers-first archives leave no spool rows. The separate child axis still uses 2/4/8 titles for the selected
VN, with logical scales children² = 4/16/64. Returned rows remain linear and executions constant on that axis;
it is not catalogue growth. Each child archive has 33 VNs and respectively 100/102/106 stored rows.

In `services/importer/tests/vndb-tables-growth.test.ts`, logical scales 1/8/64 seed 250 archives per source per
unit across two sources. The background alone, before measured operations, contains:

| Logical scale | Background runs | Background stored rows | Background spool rows |
| ------------- | --------------- | ---------------------- | --------------------- |
| 1             | 500             | 1500                   | 1500                  |
| 8             | 4000            | 12000                  | 12000                 |
| 64            | 32000           | 96000                  | 96000                 |

The measured work stays fixed: staging consumes the six fixture entries with data before headers; projection has
17 VNs and returns 16 with cursor `v16`; validation has 33 VNs; cleanup has 65 VNs (195 stored rows) plus 65 spool
rows for each of three tables (195 spool rows). These hot fixtures are additional to the background. Staging adds
one ready run and seven stored rows at each scale; projection and validation retain one hot run with 51 and 99
stored rows respectively. Cleanup removes its hot stored/spool rows while retaining the run record. Every SQL
returned-row and execution growth assertion in this suite remains constant with the explicit slack above; the
suite had no additional aggregate numeric ceilings.

## Evidence boundary

Raw SQL, bindings, actual returned rows and bound EQP validation remain with their original producers. The
asynchronous validator still rejects history COUNT/OFFSET, scans except constant rows, automatic indexes and
temporary sorts; SEARCH must use declared indexes with equality/range constraints. Direct probe consumers still
call `verifyPlans()`. Capture continues across awaits and actual lazy-row consumption, including transaction and
cleanup executions. Record values, source/licence admission, strict invalid cases, baseline preservation, reopen,
byte and child caps, SQL and indexes are unchanged.

This is native-store/local-harness evidence. It does not supply the still-missing `createVndbTablesDriver` binding,
run the portable VNDB API acceptance, or establish PostgreSQL, server API write, filtered-list or additional hot
population axes. The separate portable `Cost`, driver and spec remain unchanged. No README is rewritten.

Sources read for this reconciliation: the committed `remaining-cost-unit-ports.md` inventory at `5c47a835ca`,
its VNDB caller/population section, `specs/imports-vndb-tables-driver.ts` (raw capture and EQP validator),
`services/importer/tests/support/sqlite-growth.ts` (integrated counts and raw evidence),
`services/importer/src/vndb-tables.ts` (staging, projection, validation and cleanup), and the two local suites.
No external reference project was required by this unit-only contract.

Verification commands from the worktree root, through `bun scripts/worker-check.ts --`:

```sh
bun test services/importer/tests/vndb-tables.test.ts services/importer/tests/vndb-tables-growth.test.ts
bun run --cwd services/importer typecheck
```
