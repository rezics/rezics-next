# SQLite probe and slash-key counted evidence

This consumer migration uses the additive probe API present at base revision
`62e5c165bed7906e9c00fdf97991dce5ab20a955` (probe implementation last changed in
`b62550eaa61df4b4dab54cc3f9022479311b55b3`). It follows the
[client counted-cost correction](client-counted-costs.md): `sqlite statements` counts actual native executions,
including transaction controls; `sqlite returned rows` counts rows delivered to the caller. Both are sampled with
shared `countedSample` and checked with `countedViolations`. No unavailable buffer measurement is represented as zero.
`SqliteEvidence.rows` continues to describe each raw execution; neither that field nor the compatibility API changes.

## Probe controls

`services/importer/tests/sqlite-growth.test.ts` preserves every existing native behavior assertion. Exact
(statement, returned-row) totals remain:

| Measured operation                                                      | Statements | Returned rows |
| ----------------------------------------------------------------------- | ---------: | ------------: |
| Keyed select                                                            |          1 |             1 |
| RecordStore get, count and three-row cursor page, at 32/128/512 records |          3 |             5 |
| Prepared gets, values and bound update                                  |          4 |             2 |
| Partial/unused native iterators                                         |          2 |             3 |
| Query cache, transaction, compound exec and returning insert            |          8 |             2 |
| Named binding, keyed upsert/delete and escaped compound exec            |          6 |             1 |
| Nested savepoint/rollback                                               |          6 |             1 |
| Database isolation and restored prepared statement                      |          1 |             1 |
| Compound inserts with quoted/comment boundaries                         |          2 |             0 |
| Empty/comment-only exec                                                 |          0 |             0 |

The post-exception restored measurement still counts one statement. Raw bindings and per-event row totals, control
counts, native aggregate changes, trigger refusal, evidence/binary caps, restore/close behavior, unsafe scans,
automatic indexes, temporary sorts, generated keys and unsupported plans retain their assertions. The focused
additive API acceptance already exists in `sqlite-counted-units.test.ts`; no mirrored counter test is added here.

## Slash-key populations and bounds

`services/importer/tests/run-store-native-keys-growth.test.ts` retains one real in-memory SQLite seed, analyzed at
64, 512 and 4096 records. At each sample, N current keys are actually staged in the active run and N distinct
one-record failed historical runs remain in the same source. The fixed measured keys are
`/authors/OL100002A`, `/books/OL100001M` and `/works/OL100000W`; page widths remain three or two. Setup,
classification and finalization stay outside measurement. All databases in these two suites remain `:memory:`;
no file journal is introduced.

The population assertions and emitted seed evidence distinguish logical records from physical table rows. Immediately
before the three fixed keys are staged at each scale:

| Table / logical population                             |  64 |  512 | 4096 |
| ------------------------------------------------------ | --: | ---: | ---: |
| Current active-run staged records                      |  64 |  512 | 4096 |
| Failed historical records / runs                       |  64 |  512 | 4096 |
| `run_sources`                                          |   1 |    1 |    1 |
| `run_generations`                                      |  66 |  515 | 4100 |
| `run_entries`                                          | 131 | 1094 | 8777 |
| `run_members`                                          |   3 |   67 |  515 |
| `run_acknowledged`                                     |   3 |   67 |  515 |
| `run_commands`, `run_payloads`, `run_envelopes` (each) |   0 |    0 |    0 |

Current here means staged in the active run, not already acknowledged membership. Completed immutable snapshots
explain the additional entries; membership/acknowledged rows reflect the preceding completed scale plus the three
fixed keys. Each scale adds three fixed-key entries during measurement, then acknowledges/finalizes its N current
keys outside measurement.

All fifteen operation groups retain all three samples, exact ceilings of eight `sqlite statements` and five
`sqlite returned rows`, positive execution counts and constant growth with zero absolute/relative slack. Every
operation must retain native `SEARCH` evidence with a source-prefixed key, and the probe must accept all captured
plans. Stage/ack control traces remain exactly `BEGIN IMMEDIATE`, `COMMIT`. Exact page contents, staged metadata,
acknowledged metadata and the separate identifier, JSON byte-cap, unsafe getter, metadata and stale-capability
controls remain intact. There is no timeout, cap, tolerance or operation-width increase.

Observed counts at every scale (each fixed-key operation is repeated separately for all three keys):

| Operation                  | `sqlite statements` | `sqlite returned rows` |
| -------------------------- | ------------------: | ---------------------: |
| Stage each fixed key       |                   7 |                      2 |
| Get each fixed key         |                   5 |                      5 |
| First staged page          |                   2 |                      4 |
| Cursor staged page         |                   2 |                      3 |
| Acknowledge each fixed key |                   7 |                      2 |
| Get each acknowledged key  |                   5 |                      5 |
| Acknowledged cursor page   |                   1 |                      2 |

## Validation and limits

Validation results and the exact tested revision are recorded after the committed focused run and root typecheck.
The acceptance command is `bun test services/importer/tests/sqlite-growth.test.ts
services/importer/tests/run-store-native-keys-growth.test.ts`, through `bun scripts/worker-check.ts --`.

Remaining deprecated SQLite `.cost` consumers in this base are `bindings-growth.test.ts`, `record-store-growth.test.ts`,
`run-store-growth.test.ts`, `run-store-empty-growth.test.ts`, `run-store-pages.test.ts`, `record-caps-growth.test.ts`
and `cli-driver.ts`, all under `services/importer/tests/`. The probe retains its compatibility field for them.
The client reconciliation suite already consumes named counts. Byte/cap controls outside this slice are unchanged.

Sources inspected: the two edited test files, `tests/support/sqlite-growth.ts`, `tests/sqlite-counted-units.test.ts`,
`src/run-store.ts`, shared `services/kernel/test/support/growth-counters.ts` and `growth-bound.ts`, the client
counted-cost report, and importer/Goal/development owner documents. No reference-project source was required or
ported. No files outside the three declared paths changed. The README writer remains separate.

These results are local harness evidence. They do not establish imported native user-case acceptance, PostgreSQL
work, all-costs migration or main promotion.
