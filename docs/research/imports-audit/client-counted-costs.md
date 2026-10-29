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
## Recovered prerequisite and blocked cause capture

Inspection on 2026-10-30 confirms the restored parent is an ancestor of the assigned branch.
The actual controller-formatted CPU file has SHA256
`f0d46d44ca3cbffaf7e60a162e6aaa6356b0ffc7b034d293391505f080e1c751`.
This supersedes the earlier missing-prerequisite receipt: `cfd7a51a577b8f6825e940ed425f70854b5d8178f5732fc27d78ee9aadeb732b`
was a raw preformat proposal, not the installed formatted bytes. The restored file contains the constant
`SQLite prepares` bound with zero default slack and the raw three-scale diagnostic. It remains unchanged.
Exact old and new formatted CPU hashes are both
`f0d46d44ca3cbffaf7e60a162e6aaa6356b0ffc7b034d293391505f080e1c751`.

The driver now offers bounded literal-SQL diagnostics through `IMPORTER_PREPARE_TRACE=1` in its existing
prepare wrapper: database ordinal, prepare-event ordinal and exact SQL, at most 128 events per handle and
16384 characters per SQL. No bound values are logged. The callback is still installed once through
`instrumentDatabase`; its identity, counter placement and execution/cache behavior are preserved.
No public interface or runtime changed.

The required launch command was attempted once and retried twice:

```sh
bun scripts/worker-check.ts --run -- env IMPORTER_PREPARE_TRACE=1 bun test services/importer/tests/record-cpu-growth.test.ts
```

Each attempt exited 1 immediately with the exact error `Invalid check id: --`. No check ID was returned,
no slot was entered, and no CPU case ran. The current script parses `--run` as resuming an existing check ID,
so the mandated separator is interpreted as that ID. No alternate launch syntax or runner repair was used.
This is a tool failure before test execution, not a CPU assertion result. The focused final CPU check,
affected importer typecheck and artifact acceptance have not run through the mandated runner.

The predecessor's raw 16/64/256 values above remain preserved evidence, including the honest 62/62/64 RED;
they were not reproduced by this attempt. Actual prepare-event counts, distinct literal sets and the
256-minus-64 set difference are still unmeasured. The exact two-after-key cause is unconfirmed, so the
256/1024/4096 amendment and independent exact-equality assertion remain held. No prewarming, padding,
filtering, extra allowance, timeout change or product repair is authorized or introduced.

Source inspection read the full `RunStore.query()` and `RecordBindings.statement()` cache implementations.
Both cache by literal text; `RunStore.query()` additionally clears its cache on prepare callback replacement.
The staged first/after SQLs are at `run-store.ts:489/496`; acknowledged first/after SQLs are at
`run-store.ts:512/517`. These are candidate sites, not a measured cause. Pending and vanished pages use one
literal each across cursor states. Actual importer pending/staged/vanished page limits at
`importer.ts:501/978/1029` and candidate limit at `importer.ts:429` are all 100. Candidate paging also uses
one literal. A smallest scale of at least 201 is the proposed branch-complete boundary; only an actual trace
may establish which cold branches this fixture reaches. Original scales, all assertions, concurrency 16,
transport/media behavior, cleanup and 120000 ms timeout remain intact.

Full final CPU diff: empty. Full final driver diff:

```diff
@@
-function countWork(database: Database): Database {
+let tracedDatabases = 0;
+function countWork(database: Database): Database {
+  const trace = process.env.IMPORTER_PREPARE_TRACE === '1';
+  const databaseNumber = trace ? ++tracedDatabases : 0;
+  let prepareEvent = 0;
@@
     pipelineWork.prepares++;
     count(sql);
+    // Opt-in cold-cache evidence only: bounded literal SQL, never bound parameters.
+    if (trace && ++prepareEvent <= 128 && sql.length <= 16_384) {
+      console.info('importer prepare trace:', JSON.stringify({ database: databaseNumber, event: prepareEvent, sql }));
+    }
```

The integrated inventories `remaining-cost-unit-ports.md` at
`472aa311ffe270eca9f01f7d7bf633281c76f14d` and `vndb-tables-binding-seams.md` at
`14659f678751fc153ab67752628b9d9efc32c15d` are source inventories, not native passes. Their observations do
not establish CPU branch coverage or equality. This documentation change preserves the distinction between SQLite
executions/returned rows, input bytes/chunks, requests and retained bytes; unavailable SQLite blocks are not zero.
Old row-like slack 2/10%, byte/block-like slack 4/50% and execution zero remain obligations wherever the old
checks apply; counted defaults are zero and stricter explicit zero/exact ceilings remain binding. Raw SQL,
bindings, EQP, validators, combined events and separate PG-derived appended-row/calls-plus-plans checks remain
unchanged; canonical native PG capture remains separate. Physical populations and payload axes stay independent.
VNDB fourteen-case portable binding remains absent; production grouping retains `id`, `olang`, `c_votecount`
and `c_average`. Statistics six-case native binding and its source-statistic API effects remain distinct.
No producer, adapter, fabricated materialization/baseline or zero-I/O observation is introduced here.

Only this audit and the existing test driver change, with no outside-path changes or external reference-project research. Artifact
nonemptiness can establish delivery of this evidence, but cannot establish CPU equality, native/API/growth
acceptance, integration or promotion. The required next step is to reconcile the mandated launch syntax with the available runner before the one
actual cause run. The scale amendment depends on observing exactly the required two-text difference.

## Documentation handoff

The importer README Cost row and the former title “Kernel call stays within its bound as R grows” need an owner-side
documentation update. Replace the old title's server-growth implication with the client transport description above.
Keep PostgreSQL metrics assigned to native API checks. The reviewed 100-command width witness belongs to
`services/kernel/test/semantic/growth-sourced-writes.test.ts`, whose actual fixed batch includes 48 changes,
48 fresh-key duplicates and four replays across several tuple homes. Its series limit remains open. Importer
`M=64` and private 300-command scenarios do not establish that server width proof. No kernel `batchWrite` scale check was run by this client correction,
so these results do not establish server-side batch-write scaling or close native API acceptance.

Native API and growth suites remain separate evidence. This change measures no product timeout, admission, retry or
source-semantic behavior.

## Cause-capture launch revalidation

On 2026-10-30, the recovered checkout again contains the exact controller-formatted restored CPU file:
old and current SHA256 `f0d46d44ca3cbffaf7e60a162e6aaa6356b0ffc7b034d293391505f080e1c751`.
The constant zero-slack bound and raw diagnostic are present; no prerequisite was copied or restored.
The existing opt-in driver instrumentation is unchanged. Inspection reconfirms both full literal-text caches,
the staged and acknowledged first/after SQLs, and the four reviewed importer page limits of 100.

The first revalidated mandated cause-capture launch exited 1 with `Invalid check id: --`, before returning
a check ID or executing a test. Both permitted retries produced the same error and exit status. All three launches failed before entering
a check slot. The runner dispatch at `scripts/worker-check.ts:783` treats `--run` as an existing-check operation;
`recordPath()` at line 113 rejects the supplied `--` as its ID. No alternate syntax or runner repair was used.
The runner, dependency configuration, frozen assertions, scales and runtime remain unchanged.

No cause diagnostic, final CPU test, importer typecheck or artifact acceptance reached execution in this
revalidation. There are no new prepared SQL strings, event counts, distinct sets or three-scale values.
The predecessor's 16/64/256 evidence (62/62/64 prepares) remains the only reached CPU result reported here.
The exact two-site cause remains unconfirmed, so the scale amendment and independent exact-equality assertion
are held. Usable constant-work proof still requires a passing branch-complete exact-equality run.

Full final CPU diff: empty; full final driver diff for this revalidation: empty. Exact old/new formatted CPU
SHA256 hashes are both `f0d46d44ca3cbffaf7e60a162e6aaa6356b0ffc7b034d293391505f080e1c751`.
Only this audit changed in the revalidation; there are no outside-path files or new reference-project sources.
This tool blocker prevents the required evidence and does not change any acceptance requirement or establish
native/API/growth success, integration or promotion.

## Corrected launch continuation

The current contract corrects the launch syntax to `bun scripts/worker-check.ts -- <command...>`.
The earlier parser failures above remain historical tool evidence; this continuation uses the corrected syntax
for the one actual original-scale cause capture. The restored CPU file still has the exact formatted hash
`f0d46d44ca3cbffaf7e60a162e6aaa6356b0ffc7b034d293391505f080e1c751`; the old scales and assertions are unchanged.

## Actual original-scale cause capture: proposed cause disagrees

The corrected launch ran the original frozen case once, at the committed diagnostic checkpoint.
Command: `bun scripts/worker-check.ts -- env IMPORTER_PREPARE_TRACE=1 bun test services/importer/tests/record-cpu-growth.test.ts`.
Log: `.temp/goal/checks/worker-check-2026-10-29T21-10-22.817Z-af7832d0.log`.
Terminal exit **1**, 0 pass, 1 fail, 4 assertions, 2380.56 ms for the test. All three committed/new-record
assertions passed. The existing zero-slack constant-prepare assertion failed honestly at scale 256; subsequent
marginal/rate assertions were not reached. No diagnostic rerun or final amended CPU run was performed.
The earlier parser-blocked sections describe prior attempts, not this reached result.

| Records / driver-database ordinal | Converter calls | Counted prepares | SQLite executions | Transactions | Commits | All traced prepare events | Distinct literal texts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 / 1 | 80 | 62 | 2686 | 51 | 51 | 63 | 62 |
| 64 / 2 | 320 | 62 | 10654 | 195 | 195 | 63 | 62 |
| 256 / 3 | 1280 | 64 | 42544 | 773 | 773 | 65 | 64 |

Each driver opens one instrumented handle. Trace event ordinals are contiguous 1–63, 1–63 and 1–65,
respectively; no diagnostic limit was reached. They include setup's `PRAGMA table_info(run_generations)`
before the existing work-counter reset; counted prepares exclude that event. Ownership's
`SELECT capability FROM import_owners WHERE source=?` is prepared twice per handle outside the two caches.
Thus all-event counts, distinct text cardinalities and counted prepares are reported separately, without
filtering the measured counters. The runner repeats one trace line in its failure-summary excerpt; that
excerpt is not a second prepare event. The event counts above use the original test-output section only.
The predecessor's 2654/10526/42032 execution counts remain historical evidence above; this actual base gives
2686/10654/42544 and is not substituted for or represented as that older run.

The literal set at 16 equals the set at 64. The set at 256 is their union with **exactly these two texts**
(JSON strings preserve literal whitespace):

```json
[
  "SELECT row_json,projection_json FROM run_entries\n          WHERE source=? AND run_id=? AND record_key>? ORDER BY record_key LIMIT ?",
  "UPDATE run_generations SET status=?,cursor=? WHERE source=? AND id=?"
]
```

The first is `RunStore.pageStaged()`'s after-key SELECT at `services/importer/src/run-store.ts:502`
(trace database 3, event 49). The second is `RunStore.finalize()`'s full-page cursor UPDATE at
`services/importer/src/run-store.ts:1244` (database 3, event 61). The staging page and finalization page
sizes are both 100 (`importer.ts:1023` and `1119`). The UPDATE is a full-page branch, **not an after-key
SQL variant**. The acknowledged-page after-key SELECT at `run-store.ts:523` is absent from every traced
set. Therefore the contract's expected pair of two after-key variants is contradicted by actual evidence.
The proposed scale amendment and independent equality assertion are held as explicitly required when the
set difference disagrees. No alternate cause, warmed cache, synthetic prepares, allowance or runtime fix
is introduced. Authorizing the observed staged-SELECT/finalize-UPDATE pair requires contract reconciliation.

For a complete, durable text-set capture, the following is the common set at 16 and 64; the 256 set is
exactly this set plus the two strings above. No text is removed at 256.

```json
[
  "DELETE FROM import_owners WHERE source=? AND capability=?",
  "INSERT INTO binding_candidates (source, external_id, field_group, candidate, subject, key, bytes, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  "INSERT INTO binding_groups (source, external_id, field_group, candidate_count) VALUES (?, ?, ?, ?)",
  "INSERT INTO binding_journal (source, external_id, key, bytes, signature, acknowledgement) VALUES (?, ?, ?, ?, ?, ?)",
  "INSERT INTO binding_media (source, external_id, key, bytes, signature, accepted, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  "INSERT INTO binding_records (source, external_id, state, subject, bootstrap_key, candidate_count, cover_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
  "INSERT INTO import_owners(source,pid,birth,capability) VALUES(?,?,?,?)\n        ON CONFLICT(source) DO UPDATE SET pid=excluded.pid,birth=excluded.birth,capability=excluded.capability",
  "INSERT INTO run_acknowledged(source,record_key,row_json,projection_json) VALUES(?,?,?,?)\n      ON CONFLICT(source,record_key) DO UPDATE SET row_json=excluded.row_json,projection_json=excluded.projection_json",
  "INSERT INTO run_commands(source,run_id,command_key,record_key,field_group,op,envelope_index,done)\n            VALUES(?,?,?,?,?,?,?,?)",
  "INSERT INTO run_envelopes(source,run_id,record_key,envelope_index,multi,bytes,keys_json,remaining,pending)\n            VALUES(?,?,?,?,?,?,?,?,?)",
  "INSERT INTO run_generations(source,id,seq,lease,status,threshold,prior) VALUES(?,?,?,?,?,?,?)",
  "INSERT INTO run_members(source,record_key,active,seen,row_json) VALUES(?,?,?,?,?)\n          ON CONFLICT(source,record_key) DO UPDATE SET active=excluded.active,seen=excluded.seen,row_json=excluded.row_json",
  "INSERT INTO run_payloads(source,command_key,body) VALUES(?,?,?)",
  "INSERT INTO run_sources(source,sequence,lease_run,generation,present_count) VALUES(?,?,?,?,?)\n        ON CONFLICT(source) DO UPDATE SET sequence=excluded.sequence,lease_run=excluded.lease_run",
  "INSERT OR IGNORE INTO run_entries(source,run_id,record_key,row_json,projection_json)\n        VALUES(?,?,?,?,?)",
  "PRAGMA table_info(run_generations)",
  "SELECT * FROM binding_records WHERE source=? AND external_id=?",
  "SELECT * FROM run_commands WHERE source=? AND run_id=? AND command_key=?",
  "SELECT * FROM run_entries WHERE source=? AND run_id=? AND record_key=?",
  "SELECT * FROM run_entries WHERE source=? AND run_id=? AND record_key>?\n        ORDER BY record_key LIMIT ?",
  "SELECT * FROM run_generations WHERE source=? AND id=?",
  "SELECT * FROM run_members WHERE source=? AND record_key=?",
  "SELECT * FROM run_sources WHERE source=?",
  "SELECT body FROM run_payloads WHERE source=? AND command_key=?",
  "SELECT candidate_count FROM binding_groups WHERE source=? AND external_id=? AND field_group=?",
  "SELECT capability FROM import_owners WHERE source=?",
  "SELECT g.id FROM run_sources AS s\n      JOIN run_generations AS g ON g.source=s.source AND g.id=s.lease_run\n      WHERE s.source=? AND s.lease_run=? AND g.id=? AND g.lease=? AND g.status='ready'",
  "SELECT key, bytes, signature, accepted, status FROM binding_media WHERE source=? AND external_id=? AND key=?",
  "SELECT key, bytes, signature, acknowledgement FROM binding_journal WHERE source=? AND external_id=? AND key=?",
  "SELECT key, bytes, signature, candidate, subject, field_group FROM binding_candidates WHERE source=? AND external_id=? AND field_group=? AND candidate=?",
  "SELECT key, bytes, signature, candidate, subject, field_group FROM binding_candidates WHERE source=? AND external_id=? AND field_group=? AND candidate>? ORDER BY candidate LIMIT ?",
  "SELECT m.row_json FROM run_members AS m INDEXED BY run_missing\n      WHERE m.source=? AND m.active=1\n        AND m.seen<(SELECT seq FROM run_generations WHERE source=? AND id=?)\n        AND (m.seen,m.record_key)>(COALESCE((SELECT seen FROM run_members WHERE source=? AND record_key=?),-1),?)\n      ORDER BY m.seen,m.record_key LIMIT ?",
  "SELECT pid,birth,capability FROM import_owners WHERE source=?",
  "SELECT record_key,envelope_index,multi,bytes,keys_json FROM run_envelopes\n      WHERE source=? AND run_id=? AND record_key=? AND pending=1\n      ORDER BY envelope_index LIMIT 300",
  "SELECT record_key,envelope_index,multi,bytes,keys_json FROM run_envelopes INDEXED BY run_envelope_pending\n      WHERE source=? AND run_id=? AND pending=1 AND (record_key,envelope_index)>(?,?)\n      ORDER BY record_key,envelope_index LIMIT ?",
  "SELECT row_json FROM run_acknowledged WHERE source=? AND record_key=?",
  "SELECT row_json,projection_json FROM run_acknowledged WHERE source=? AND record_key=?",
  "SELECT row_json,projection_json FROM run_entries\n          WHERE source=? AND run_id=(SELECT generation FROM run_sources WHERE source=?) AND record_key=?",
  "SELECT row_json,projection_json FROM run_entries\n          WHERE source=? AND run_id=? ORDER BY record_key LIMIT ?",
  "SELECT row_json,projection_json,kind FROM run_entries INDEXED BY run_cover_pending\n      WHERE source=? AND run_id=? AND cover_pending=1 AND record_key>?\n      ORDER BY record_key LIMIT ?",
  "SELECT s.lease_run,g.id,g.lease FROM run_sources AS s\n      JOIN run_generations AS g ON g.source=s.source AND g.id=s.lease_run\n      WHERE s.source=? AND s.lease_run IS NOT NULL\n      AND g.status IN ('staging','ready','finalizing')",
  "UPDATE binding_groups SET candidate_count=candidate_count+? WHERE source=? AND external_id=? AND field_group=?",
  "UPDATE binding_journal SET acknowledgement=? WHERE source=? AND external_id=? AND key=?",
  "UPDATE binding_media SET accepted=? WHERE source=? AND external_id=? AND key=?",
  "UPDATE binding_media SET status=? WHERE source=? AND external_id=? AND key=?",
  "UPDATE binding_records SET candidate_count=candidate_count+? WHERE source=? AND external_id=?",
  "UPDATE binding_records SET cover_key=? WHERE source=? AND external_id=?",
  "UPDATE binding_records SET state=?, subject=? WHERE source=? AND external_id=?",
  "UPDATE run_commands SET done=1 WHERE source=? AND run_id=? AND command_key=?",
  "UPDATE run_entries SET cover_pending=0,omissions_json=? WHERE source=? AND run_id=? AND record_key=?",
  "UPDATE run_entries SET cover_pending=1 WHERE source=? AND run_id=? AND record_key=?",
  "UPDATE run_entries SET kind=?,bytes=?,keys_json=?,remaining=?,pending=? WHERE source=? AND run_id=? AND record_key=?",
  "UPDATE run_entries SET remaining=remaining-? WHERE source=? AND run_id=? AND record_key=?\n          RETURNING remaining",
  "UPDATE run_entries SET resolved=1,pending=0 WHERE source=? AND run_id=? AND record_key=?",
  "UPDATE run_envelopes SET remaining=remaining-1,pending=CASE WHEN remaining=1 THEN 0 ELSE 1 END\n      WHERE source=? AND run_id=? AND record_key=? AND envelope_index=?",
  "UPDATE run_generations SET classified=classified+1,changed=changed+?,prepared=prepared+?\n          WHERE source=? AND id=?",
  "UPDATE run_generations SET lease=lease WHERE source=? AND id=? AND lease=? AND status='ready'",
  "UPDATE run_generations SET resolved=resolved+1 WHERE source=? AND id=?",
  "UPDATE run_generations SET status=? WHERE source=? AND id=?",
  "UPDATE run_generations SET status=?,expected=?,skipped=? WHERE source=? AND id=?",
  "UPDATE run_generations SET supplied=supplied+1,survivors=survivors+? WHERE source=? AND id=?",
  "UPDATE run_sources SET generation=CASE WHEN generation IS NULL OR ? > 0 THEN ? ELSE generation END,\n        present_count=?,lease_run=NULL WHERE source=? AND lease_run=?"
]
```

The caches were read in full: `RunStore.query()` caches exact SQL text and invalidates on prepare callback
replacement; `RecordBindings.statement()` caches exact SQL text. The callback remains installed once with
unchanged identity and counters. Current pending/staged/vanished/candidate page limits remain 100 at
`importer.ts:502/1023/1074/430`; finalization also uses 100. Source locations supersede the older line-number
observations above, while the integrated measurement inventories remain source inventories rather than passes.

Exact old/new formatted CPU SHA256 hashes remain, respectively:
`f0d46d44ca3cbffaf7e60a162e6aaa6356b0ffc7b034d293391505f080e1c751` /
`f0d46d44ca3cbffaf7e60a162e6aaa6356b0ffc7b034d293391505f080e1c751`.
Full final CPU diff: empty. Full driver diff in this continuation: empty; the earlier bounded diagnostic
addition is reproduced above. All original scales, assertions, concurrency, fixtures, cleanup and 120000 ms
timeout remain intact. No final branch-complete constant-work proof is claimed. Artifact nonemptiness
establishes only delivery of this evidence. No outside-path file changed, no external reference-project source
was required, and no server, native API, PostgreSQL, broader workspace, integration or promotion check ran.
