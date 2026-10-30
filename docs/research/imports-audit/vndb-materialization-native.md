# VNDB table materialization and ordinary publication

`VndbMaterialization` owns validated table acquisition and delegates publication to
ordinary `Importer.runRecords`. The CLI uses this same facade for raw entries and
real ustar input. All archive entries validate before the importer can resume or
publish any work. Malformed VNDB input returns the CLI's invalid-input status.

The acquisition retains one link in `vndb_table_runs` to the actual active RunStore
generation, written when the importer first consumes its validated record stream.
RunStore remains the authority for completed source membership, native revision,
digest and converter revision. A failed or merely staged run cannot advance that
pointer. Resume keeps the acquisition of the original sealed work even when a
later invocation supplies a different archive. Unchanged imports retain the
original completed generation and acquisition. No separate baseline copies exist.

The frozen portable acceptance retains all fourteen cases, the 32/128/512
unrelated-key populations and the 2/4/8/9 child rows. The fixture forwards raw
entry streams without COPY parsing or grouping. It uses the existing pure VNDB
driver for converter framing and semantic validation. Every importer SQLite
handle, including the runtime's original handle and reopened publication handles,
is attached to the supplied SQL evidence before preparing statements. Actual
successful stage inserts and retained logical row batches have observer hooks;
returned rows, executions and bound EQP come from the frozen evidence producer.
Application executor boundaries observe the absence of kernel calls in local
stage/page measurements. These are local SQLite units, not physical I/O or a new
canonical server growth series.

Unrelated catalogue keys are created through ordinary bulk commands. Earlier
validated table rows and abandoned RunStore acquisitions provide actual unrelated
history in the same source and SQLite tables. They are not a second source or
partition. Native publication uses the existing Auth/Access/runtime and registered
worker. The CLI journey provisions its account key through native credential
effects, reads the pinned COPY bytes through ustar, inspects the public statistic,
then reopens unchanged and rejects a late duplicate with the completed baseline
and exact original receipts intact. Marker inspection covers current logical
SQLite rows and captured public effects, not deleted SQLite pages.

Source evidence consumed: the pinned six COPY/header fixtures; the frozen
`imports-vndb-tables-driver.ts` dump/schema/generator evidence; the actual
`VndbTablesStore`, `convertVndb` (`vndb@7`), importer, RunStore and CLI sources;
and the existing native statistic driver, identity support, API observer and
runtime exports. The reference-project index has no VNDB reference clone.
The earlier incompatible frozen exact-object assertion has been reconciled by
the acceptance owner. Statistic count/average stay admitted; descriptions, image
identifiers, Bayesian rating and user data remain discarded.

Local unit checks prove durable baseline, unchanged reopen, invalid acquisition
and original acquisition recovery using an explicitly local transport double.
They do not establish native publication. Native acceptance is the two named
cases in `vndb-materialization-native.test.ts`, including its fourteen-case child.
Actual converter/bundle revisions, source generation/digests and exact receipt
anchors are emitted by the native CLI journey. Native API growth remains outside
this evidence and unproved here.

The managed retry at implementation revision `ac9ab58f40` finished with exit
status 1. It again passed the ordinary CLI publication case and thirteen of the
fourteen portable cases (2,330 child assertions; the parent had one pass, one
failure and 16 assertions). It observed
native entry revisions 7 and 19, converter `vndb@7`, catalogue version `1.0.0`
and bundle digest
`sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd`.
The ordinary case checked the licensed mean/count, zero native votes, unchanged
reopen, invalid replacement, original receipts and absence of unlicensed markers.

That historical run's remaining portable case reached ordinary publication after measured staging
and paging, then stopped in the ownership transaction with
`SQLiteError: cannot commit transaction - SQL statements in progress`.
The local measured-publication unit again reproduced this without native
services: three units passed, one failed, with 21 assertions. Edited-file formatting
and the importer compiler passed. Native acceptance was incomplete in that retry. The remaining
child stopped at the first supported cardinality, two titles; its four/eight-title
and above-cap iterations were not reached. The independent 32/128/512 population
case passed.

The cause is isolated to the frozen SQLite evidence producer's temporary prepared
plan statement. `sqliteEvidence.prove` calls `db.prepare(...).all(...)` without
finalizing that statement. An empty INSERT plan leaves a statement in progress
in the tested Bun SQLite toolchain (local Bun 1.4.3 and managed Bun
1.4.4-canary.1, build `a0cc096ce`, including the managed retry). This bounded
independent witness reproduces the failure:

```ts
import { Database } from 'bun:sqlite';
const db = new Database(':memory:');
db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT)');
const plan = db.prepare('EXPLAIN QUERY PLAN INSERT INTO items(id,value) VALUES (?,?)');
plan.all('a', 'b'); // Returns [].
db.exec('BEGIN');
db.query('INSERT INTO items(id,value) VALUES (?,?)').run('a', 'b');
db.exec('COMMIT'); // SQLITE_BUSY: SQL statements in progress.
```

The same witness succeeds when `plan.finalize()` is called immediately after
`plan.all`. The failing witness was reproduced twice. Frozen acceptance and its
evidence producer remain unchanged; this slice does not substitute a different
SQL/EQP validator or close statements behind the validator's back.

The exact fourteen child cases and their historical retry outcomes were:

| Case                                                                                                             | Outcome                                      |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| the actual VNDB table-file format is grouped into complete source records before conversion                      | pass                                         |
| tables and headers may arrive in any order and reopen reads durable grouped rows                                 | pass                                         |
| COPY escapes nulls booleans numeric cells and split UTF8 decode before conversion                                | pass                                         |
| changed raw title and entry revision reach the real converter and committed digest                               | pass                                         |
| normalization ignores unsupported public descriptions and images while titles and revisions affect conversion    | pass                                         |
| all required tables validate before the first proposal and a failed source cannot replace the baseline           | pass                                         |
| duplicate table column and primary keys abort rather than overwrite or disappear                                 | pass                                         |
| missing required tables headers titles metadata and mismatched ids abort without API fallback                    | pass                                         |
| malformed COPY cells headers truncation and invalid UTF8 abort atomically                                        | pass                                         |
| unsafe archive paths links and normalized aliases abort before any publication                                   | pass                                         |
| unrelated user post review list tables and shipped SQL are never staged decoded or executed                      | pass                                         |
| keyset enumeration enforces the fixed page cap and emits each VN exactly once                                    | pass                                         |
| one grouped record uses indexed seeks and constant returned rows and statements at 32 128 and 512 unrelated keys | pass                                         |
| supported child cardinality grows only with supplied rows through the hard cap and rejects above it              | blocked at SQLite commit after measured page |

## Subsequent verified completion

The subsequent accepted producer repair at `0710aa933993b00c3c3fa63d6d55006447b68fe7` finalizes observed query-plan
statements before publication. The supplied completion receipt reports all fourteen portable VNDB cases passing
and both native materialization cases passing, including the ordinary account-key CLI publication/reopen case.
This supersedes the incomplete outcome above; the failed attempts and their first reached SQLite error remain
historical evidence. The completion receipt's raw log path and assertion counts were not supplied with the
sealed-recovery contract, so none are inferred here. No extra native check was run for this prose update.
This receipt belongs to the materialization suite, not the new sealed-source CLI recovery caller or native PG
growth. The latter still requires its own named managed command and receipt.
