# Native composed import counted costs

This specification reconciles the existing composed measurement seam with Performance's named counted units.
It does not establish all native outcomes, server batch-width growth, or Goal completion on main.
The starting revision is `ba527538407241a3b896a5221503ab40b098d273`.

## Sources and decisions

Read the complete **Shared native growth composition and cost aggregation** section of
`docs/research/imports-audit/remaining-cost-unit-ports.md` from inventory commit `5c47a835ca`, including its
producer/caller inventory, exact inequalities and physical-population limits. Also read the current growth driver,
growth spec and fixture, API driver and indexed/five-phase/checkGrowth callers, both native wrapper entrypoints,
`growth-sqlite-capture.ts`, raw `api-capture.ts`, `api-runtime.ts:measureGrowth`, `api-population.ts`, the actual
SQLite validator `specs/support/verify-import-api.ts`, shared `growth-bound.ts`, `growth-cost.ts`,
`growth-counters.ts` and counted integration in `growth.ts`. Read existing client-counted-cost evidence and
RunStore/RecordBindings method declarations and SQL paths used by the unchanged budget derivations.
No reference clone or external source is prescribed for this reconciliation; none was used.

The native producer already keeps SQLite separate from PostgreSQL. The defect was consumer relabelling:
`database()` overrode canonical PG rows/statements with PG-derived totals and represented SQLite/requests as
PG-shaped costs. Preserve those stricter derived assertions separately, then use untouched `costOf(c.postgres)`.
The API local five-phase samples need the same SQLite correction; the independent real PG checkGrowth is unchanged.

The actual typed growth producer is `openImportGrowthFixture`, forwarded by `growth-driver.ts`; its only value
consumer is `specs/imports-growth.test.ts`, loaded by `growth-outcomes.test.ts`. Optional `Counters.accounting`
is declared in the existing growth port and produced/consumed in those scoped files. It exposes actual parser
pulled/scanned/copied bytes only when a parser observation exists, plus request-body bytes and page/plan byte
accounting. It adds no Source, metadata, discovery, API port, SQLite statement/relation or raw Capture interface.
No additional typed caller needs changing. Pure conversion can still omit work/accounting observations.

## Units, classes, tolerances and ceilings

| Evidence | Actual observation | N/history | M | Absolute / relative slack | Ceiling |
| --- | --- | --- | --- | --- | --- |
| Canonical PostgreSQL rows | `costOf(c.postgres).rows` | constant | linear | 2 / 10% | existing shared bound |
| Canonical PostgreSQL statements | `costOf(c.postgres).statements` | constant | linear | 0 / 0 | existing shared bound |
| Canonical PostgreSQL blocks | `costOf(c.postgres).blocks` | logarithmic | linear | 4 / 50% | existing shared bound |
| sqlite returned rows | sum actual `rowsReturned` | constant | linear | 2 / 10% | existing indexed proof |
| sqlite executions | actual SQLite execution count, controls included | constant | linear | 0 / 0 | 1456 + 144I + 32M |
| network requests | actual captured plus manually observed sends | constant | linear | 2 / 10% | 101-command rejection retains <=1 |
| derived PG examined plus ModifyTable rows | canonical examined rows + sum `rowsAppended` | constant | linear | 2 / 10% | existing derived inequality |
| derived PG client calls plus raw plans | complete PG client-call count + raw plan count | constant | linear | 0 / 0 | 4000 + 1000I + 256M |

`rowsAppended` remains the existing ModifyTable Actual Rows * Actual Loops derivation, including extra matching
native plans assigned to the last successful call. It is not independent affected-row truth. The raw statements,
plans, SQLSTATE errors, backends and background capture are preserved. No canonical cost override remains.
Unavailable SQLite buffers are omitted; no fake blocks/statements zero or cross-engine PG sum is emitted.
The API reconcile/api/stop/removal/removalApi local samples use constant SQLite rows/executions with 2/10% and
zero slack, and retain real PG constant rows/statements and logarithmic blocks at each independent population axis.

The unchanged static terms are:

| Method/source | Fixed | Per I | Per M | Derivation retained |
| --- | ---: | ---: | ---: | --- |
| RunStore stage/classify/dispatch/acknowledge, `services/importer/src/run-store.ts` | 1200 | 80 | 0 | begin/stage/seal/pageStaged/key/plan/acknowledge/finalize bounded point/page branches; record loop per I |
| RecordBindings, `services/importer/src/record-bindings.ts` | 256 | 64 | 32 | bootstrap prepare/ACK 6+6; first proposal 9+7; later 8+7; transaction controls included |
| Kernel/Auth/Access/receipt/fence/content, `services/kernel/src/http/kernel.ts` and access callees | 4000 | 1000 | 256 | bounded authenticated request, actor, permission, receipt, fence and routed-content branches, client calls plus raw plans |

The new named acceptance case freezes these coefficient sums at every scenario and verifies native raw Capture
immutability, exact canonical cost, and exact separate count identities. Existing methods and coefficients are
unchanged; no observed maximum, ceiling increase, planner/session pin, compiler workaround or runtime repair.

Reader `workUnits` remains the derived mixed sum scanned + copied bytes + SQLite executions + PG client calls +
raw plans. `allocatedBytes` remains pulled + copied + request-body + page/plan accounted bytes, not CPU or general
heap allocation. Exact identities now connect these composites to their separate actual observations. Reader
work/allocation stays positive and <=64*(bytes+fields), retained <=64*(min(bytes,65536)+fields). Database allocation
stays <=64*(I*65536+M*1024), retained <=4*(8*65536+M*1024), records <=I for bulk and <=8 otherwise.
No missing parser observation is replaced by a fabricated parser counter.

## Preserved outcome and population limits

All existing fixed N/history 32/128/512 and independent M 1/8/64 populations remain. I=M for bulk, I=8 for vanished
pages, otherwise I=1. The full SQLite indexed validator, generic index plans for all captured and nested SQL,
raw Capture equivalence/error/control/native-plan assertions, partition membership and <=4I limit remain intact.
Exact first/next vanished pages, disjoint keys, source/generation/key-range/LIMIT anchors, fences, command receipts,
mass-loss zero writes, source isolation, parser one-pass/backpressure and caps are unchanged. The public 101-command
rejection and private 300-command >3-envelope case retain exact 65536-byte/100-command packing and unique keys.
Pure converter untouched return semantics and exact nonincreasing incremental byte slope are unchanged.

Physical seeding is not a new 4096-key guarantee. The actual population seeds 2N semantic subjects, 2N SQLite
members across bangumi/seed-other, 2H abandoned generations and <=3H editorial write bases. Each distinct one of
five history routes gets 32H revisions (1024/4096/16384 per route); immutable sequences accumulate when H falls.
Generated scenario sources are not necessarily the hot bangumi source. Bulk adds M real records; vanished setup
has 96 baseline, 80 survivors, 16 missing and a 96-record decoy; mass baseline has 16. Setup/warmup writes also
contribute physical rows. No claim is made that every generated source or table has 4096 unrelated hot keys.
Server batch width/series evidence remains with Semantic/Performance.

## Verification

Code changes are committed before checks. Required commands (each through the existing foreground wrapper):

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/growth-outcomes.test.ts test/imports/api-outcomes.test.ts
bun scripts/worker-check.ts -- bun run typecheck
bun scripts/worker-check.ts -- test -s docs/research/imports-audit/native-composed-counted-costs.md
```

### Recorded results

Tested executable revision: `2093ab2dfa` (subsequent changes only record evidence in this report).

| Command | Result | Evidence |
| --- | --- | --- |
| Focused kernel command above | exit 1 | `.temp/goal/checks/worker-check-2026-10-29T14-34-09.976Z-104fb41c.log` |
| Root `bun run typecheck` through worker-check | exit 0 | `.temp/goal/checks/worker-check-2026-10-29T14-34-24.381Z-05d36756.log` |
| Report-presence acceptance | executed after committing this completed report; terminal result in worker handoff | `test -s` command above |

The focused command queued for **575.216 s** before acquiring host b; waiting was not treated as a failure.
The initial API child completed **22 pass / 1 fail / 20374 assertions**, failing its fixed-growth case in setup
with the exact first error below. Its independent shared native PG harness case passed. Initial growth completed
**15 pass / 2 fail / 270508 assertions**: vanished-page raw capture had a successful non-control SQL statement
without a plan (`semantic/slots-read-operation.sql`, expected true, received false); bulk replacement received
503 `deadline_exceeded`, retryable true, `effect_status:not_applied`, at record `growth-source:10012`.
The new named native unit-summary acceptance case passed in **5324.38 ms**.

The existing runner automatically reran the growth wrapper once alone: **15 pass / 2 fail / 287107 assertions**.
Its failures were new-record and vanished-page raw plan coverage (same preserved control-or-error assertion,
expected true, received false). The new named acceptance case again passed in **4286.74 ms**. The 101-command,
300-command, cap-byte, parser, converter and revision cases passed. No manual native rerun, base native run,
source repair or capture workaround was performed. Identical base assertions remain in place, but this attempt
does not claim an executed base comparison or a complete native outcome pass.

After the automatic isolated rerun, remote cleanup also emitted this exact tool failure:

```text
remote-check: could not remove /srv/rezics-check/runs/mvtnlpge-6c64db7f on b
```

The wrapper subsequently reached terminal **exit 1**; both started checks have finished. This is retained as a
tool blocker under the contract's infrastructure-after-rerun rule, independent of the delivered unit specification.
The scoped migration, typecheck and passing named unit case do not erase the failing native outcomes or setup error.

Exact first failure line from the API child (complete backend diagnostics retained):

```text
GrowthSettleInfrastructureError: VACUUM did not make every page all-visible after three rounds; relations: [{"relation":"dbos.operation_outputs","pages":10,"visible":5}]; backends: [{"pid":1618,"backend_type":"client backend","application_name":"","state":"idle","xact_start":null,"backend_xid":null,"backend_xmin":null,"query":"COMMIT"},{"pid":1628,"backend_type":"client backend","application_name":"","state":"idle","xact_start":null,"backend_xid":null,"backend_xmin":null,"query":"COMMIT"},{"pid":1629,"backend_type":"client backend","application_name":"","state":"idle","xact_start":null,"backend_xid":null,"backend_xmin":null,"query":"LISTEN dbos_streams_channel;"},{"pid":1630,"backend_type":"client backend","application_name":"","state":"idle","xact_start":null,"backend_xid":null,"backend_xmin":null,"query":"SELECT n.nspname AS schema, c.relname AS name,c.relkind AS kind,c.reloptions AS options,"},{"pid":1631,"backend_type":"client backend","application_name":"","state":"idle","xact_start":null,"backend_xid":null,"backend_xmin":null,"query":"UPDATE \"dbos\".queues SET \"polling_interval_sec\" = $1, \"updated_at\" = $2 WHERE name = $3"},{"pid":1632,"backend_type":"client backend","application_name":"","state":"active","xact_start":"2026-10-29T14:50:01.526Z","backend_xid":null,"backend_xmin":"88256","query":"(SELECT version_id, version_name, version_timestamp, created_at, application_name FROM \"dbos\".application_versions WHERE application_name = $1 ORDER BY application_name, version_timestamp DESC LIMIT 1)"},{"pid":1633,"backend_type":"client backend","application_name":"","state":"idle","xact_start":null,"backend_xid":null,"backend_xmin":null,"query":"SET auto_explain.log_min_duration = -1"},{"pid":1634,"backend_type":"client backend","application_name":"","state":"active","xact_start":"2026-10-29T14:50:01.526Z","backend_xid":null,"backend_xmin":"88256","query":"WITH input AS NOT MATERIALIZED ("},{"pid":1635,"backend_type":"client backend","application_name":"","state":"idle in transaction","xact_start":"2026-10-29T14:50:01.525Z","backend_xid":null,"backend_xmin":"88256","query":"WITH input AS NOT MATERIALIZED ("},{"pid":1636,"backend_type":"client backend","application_name":"","state":"idle in transaction","xact_start":"2026-10-29T14:50:01.526Z","backend_xid":null,"backend_xmin":null,"query":"BEGIN ISOLATION LEVEL READ COMMITTED"},{"pid":1637,"backend_type":"client backend","application_name":"","state":"active","xact_start":"2026-10-29T14:50:01.526Z","backend_xid":null,"backend_xmin":null,"query":"SET auto_explain.log_min_duration = -1"},{"pid":1641,"backend_type":"client backend","application_name":"","state":"active","xact_start":"2026-10-29T14:50:01.526Z","backend_xid":null,"backend_xmin":"88256","query":"WITH input AS NOT MATERIALIZED ("},{"pid":1642,"backend_type":"client backend","application_name":"","state":"idle","xact_start":null,"backend_xid":null,"backend_xmin":null,"query":"SET auto_explain.log_min_duration = -1"},{"pid":1643,"backend_type":"client backend","application_name":"","state":"idle","xact_start":null,"backend_xid":null,"backend_xmin":null,"query":"SET auto_explain.log_min_duration = -1"}]; vacuum notices: ["INFO: aggressively vacuuming \"import_identity_7a06f680568e4c4ca40a730ee79fda45.dbos.operation_outputs\"","INFO: finished vacuuming \"import_identity_7a06f680568e4c4ca40a730ee79fda45.dbos.operation_outputs\": index scans: 0\npages: 0 removed, 10 remain, 10 scanned (100.00% of total), 0 eagerly scanned\ntuples: 0 removed, 140 remain, 0 are dead but not yet removable\nremovable cutoff: 88254, which was 1 XIDs old when operation ended\nnew relfrozenxid: 88254, which is 21 XIDs ahead of previous value\nfrozen: 6 pages from table (60.00% of total) had 10 tuples frozen\nvisibility map: 3 pages set all-visible, 3 pages set all-frozen (0 were all-visible)\nindex scan not needed: 0 pages from table (0.00% of total) had 0 dead item identifiers removed\navg read rate: 0.000 MB/s, avg write rate: 0.000 MB/s\nbuffer usage: 68 hits, 0 reads, 0 dirtied\nWAL usage: 9 records, 0 full page images, 855 bytes, 0 full page image bytes, 0 buffers full\nmemory usage: dead item storage 0.02 MB accumulated across 0 resets (limit 64.00 MB each)\nsystem usage: CPU: user: 0.00 s, system: 0.00 s, elapsed: 0.00 s","INFO: aggressively vacuuming \"import_identity_7a06f680568e4c4ca40a730ee79fda45.pg_toast.pg_toast_21724\"","INFO: finished vacuuming \"import_identity_7a06f680568e4c4ca40a730ee79fda45.pg_toast.pg_toast_21724\": index scans: 0\npages: 0 removed, 0 remain, 0 scanned (100.00% of total), 0 eagerly scanned\ntuples: 0 removed, 0 remain, 0 are dead but not yet removable\nremovable cutoff: 88254, which was 1 XIDs old when operation ended\nnew relfrozenxid: 88254, which is 21 XIDs ahead of previous value\nfrozen: 0 pages from table (100.00% of total) had 0 tuples frozen\nvisibility map: 0 pages set all-visible, 0 pages set all-frozen (0 were all-visible)\nindex scan not needed: 0 pages from table (100.00% of total) had 0 dead item identifiers removed\navg read rate: 0.000 MB/s, avg write rate: 0.000 MB/s\nbuffer usage: 13 hits, 0 reads, 0 dirtied\nWAL usage: 1 records, 0 full page images, 307 bytes, 0 full page image bytes, 0 buffers full\nmemory usage: dead item storage 0.02 MB accumulated across 0 resets (limit 64.00 MB each)\nsystem usage: CPU: user: 0.00 s, system: 0.00 s, elapsed: 0.00 s","INFO: analyzing \"dbos.operation_outputs\"","INFO: \"operation_outputs\": scanned 10 of 10 pages, containing 141 live rows and 0 dead rows; 141 rows in sample, 141 estimated total rows","INFO: finished analyzing table \"import_identity_7a06f680568e4c4ca40a730ee79fda45.dbos.operation_outputs\"\navg read rate: 0.000 MB/s, avg write rate: 0.000 MB/s\nbuffer usage: 128 hits, 0 reads, 0 dirtied\nWAL usage: 28 records, 0 full page images, 6700 bytes, 0 full page image bytes, 0 buffers full\nsystem usage: CPU: user: 0.00 s, system: 0.00 s, elapsed: 0.00 s"]; attribution: {"dbos.operation_outputs":{"notAllVisibleBlocks":[{"blkno":"1","all_visible":false,"all_frozen":false,"pd_all_visible":false},{"blkno":"2","all_visible":false,"all_frozen":false,"pd_all_visible":false},{"blkno":"3","all_visible":false,"all_frozen":false,"pd_all_visible":false},{"blkno":"4","all_visible":false,"all_frozen":false,"pd_all_visible":false},{"blkno":"5","all_visible":false,"all_frozen":false,"pd_all_visible":false}],"pgCheckVisible":[]},"preparedTransactions":[],"replicationSlots":[],"owners":[{"relation":"dbos.operation_outputs","owner":"rezics","settle_role":"rezics"}]}
```

Existing revision diagnostics provide the following actual counts from the first complete measurement sequence.
These are sums of the emitted SQL histograms and the HTTP diagnostic array, not inferred engine work. Plan-text
entries are labelled as such rather than asserted to be canonical statements or rows; returned-row totals and
canonical rows/blocks are not emitted by that diagnostic. No missing observation is filled with zero.

| Axis | N | History | M | SQLite executions | PG foreground SQL executions | PG plan-text entries | HTTP diagnostic attempts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline-shared | 32 | 32 | 1 | 142 | 308 | 222 | 10 |
| n | 128 | 32 | 1 | 142 | 308 | 222 | 10 |
| n | 512 | 32 | 1 | 142 | 308 | 222 | 10 |
| history | 32 | 128 | 1 | 142 | 308 | 222 | 10 |
| history | 32 | 512 | 1 | 142 | 308 | 222 | 10 |
| fields | 32 | 32 | 8 | 142 | 308 | 222 | 10 |
| fields | 32 | 32 | 64 | 142 | 308 | 222 | 10 |

The unchanged ceilings apply to actual SQLite executions and the separately derived PG client-calls-plus-raw-plans
unit. The fixed diagnostic counts do not establish server batch-width series or global native cost success.
The full focused log SHA-256 is `054bc0e2db9df34dfbb6250497e3530f3b5bd9b5557d55c5d6943392855bf654`.

Specification delivery and native outcome proof are separate.
There are no outside-declared-path changes. No frozen sibling capture/runtime/validator, source, policy, rights,
credentials, settings, timeout, README, dependency or broad gate is modified.

## Executable file hashes

SHA-256 of the four executable/port files, excluding this report's self-referential hash:

- `specs/imports-growth-driver.ts`: `a4fc998bd44d48ae3ff62a79a51211f57f20d32a4d22d9f4f27f2ea723084a5c`
- `specs/imports-growth.test.ts`: `4726f2c17af5bed9e0a84ecbdb699a550ae4192459cc4a7b7e2d15691e31fceb`
- `specs/imports-api.test.ts`: `d58226aa6fad7736908d3f1aba653767df736394aaa3635ba09dc44583bb95df`
- `services/kernel/test/imports/growth-fixture.ts`: `8ad8f0c62fc3fd70beb1e92f760606c93d9dd6e21c84c9926fea4b37db45b549`

## Full scoped executable diff

The report itself contains the prose above and this diff; excluding itself avoids recursive embedding.
Patch SHA-256: `7c25dfa038679afee3a93c63f88844b7ceeda2b822382ed29171ae8e97ff65aa`.

```diff
diff --git a/services/kernel/test/imports/growth-fixture.ts b/services/kernel/test/imports/growth-fixture.ts
index b067bd20a4..149bd67ac7 100644
--- a/services/kernel/test/imports/growth-fixture.ts
+++ b/services/kernel/test/imports/growth-fixture.ts
@@ -1374,6 +1374,19 @@ export async function openImportGrowthFixture(): Promise<ImportGrowthDriver> {
         sqlite: captured.sqlite,
         statements: captured.statements,
         networkRequests,
+        accounting: {
+          ...(readerSample === undefined
+            ? {}
+            : {
+                reader: {
+                  pulledBytes: readerSample.counters.pulledBytes,
+                  scannedBytes: readerSample.counters.scannedBytes,
+                  copiedBytes: readerSample.counters.copiedBytes,
+                },
+              }),
+          requestBodyBytes: requestBytes,
+          pagePlanBytes: memory.allocated,
+        },
         workUnits: readerWork + sqliteStatements.length + pg.length + postgres.plans.length,
         allocatedBytes: readerBytes + readerCopied + requestBytes + memory.allocated,
         peakRetainedBytes: Math.max(readerSample?.peakBytes ?? 0, memory.peakBytes, requestPeak),
diff --git a/specs/imports-api.test.ts b/specs/imports-api.test.ts
index fbefbc87d4..a4708d11a3 100644
--- a/specs/imports-api.test.ts
+++ b/specs/imports-api.test.ts
@@ -8,8 +8,9 @@ import {
 } from '@rezics/definitions/bulk';
 import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
 import { documentText, parseDocument } from '@rezics/document';
-import { assertGrowth, type GrowthSample } from '../services/kernel/test/support/growth-bound';
+import { assertGrowth } from '../services/kernel/test/support/growth-bound';
 import { checkGrowth } from '../services/kernel/test/support/growth';
+import { countedSample, countedViolations, validateCountedRun } from '../services/kernel/test/support/growth-counters';
 import { costOf } from '../services/kernel/test/support/growth-cost';
 import { assertIndexedSqlite } from './support/verify-import-api';
 import { isAbsolute } from 'node:path';
@@ -984,6 +985,8 @@ function indexed(c: Counters) {
     expect(Number.isSafeInteger(value)).toBe(true);
     expect(value).toBeGreaterThanOrEqual(0);
   }
+  const counts = { 'sqlite returned rows': c.rowsReturned, 'sqlite executions': c.statements };
+  return validateCountedRun({ read: () => counts }, counts, 1);
 }
 test('fixed changes have bounded indexed work as unrelated catalogue and history grow independently', async () => {
   for (const dimension of ['catalogueRecords', 'historyRows', 'both'] as const) {
@@ -1024,13 +1027,22 @@ test('fixed changes have bounded indexed work as unrelated catalogue and history
         samples.push({ ...measured, stop: stop.reconcile, removal: removal.reconcile, removalApi: removal.api });
       });
     for (const phase of ['reconcile', 'api', 'stop', 'removal', 'removalApi'] as const) {
-      const sqlite: GrowthSample[] = samples.map((sample, i) => ({
-        scale: [32, 128, 512][i]!,
-        cost: { rows: sample[phase].rowsReturned, blocks: 0, statements: sample[phase].statements },
-      }));
-      assertGrowth(sqlite, { rows: 'constant', blocks: 'constant', statements: 'constant' });
+      const scales = [32, 128, 512];
+      expect(
+        countedViolations(
+          {
+            read: () => ({}),
+            bounds: { 'sqlite returned rows': 'constant', 'sqlite executions': 'constant' },
+            slack: {
+              'sqlite returned rows': { absolute: 2, relative: 0.1 },
+              'sqlite executions': { absolute: 0, relative: 0 },
+            },
+          },
+          samples.map((sample, i) => ({ scale: scales[i]!, counted: countedSample([indexed(sample[phase])]) })),
+        ),
+      ).toEqual([]);
       assertGrowth(
-        samples.map((sample, i) => ({ scale: sqlite[i]!.scale, cost: costOf(sample[phase].postgres) })),
+        samples.map((sample, i) => ({ scale: scales[i]!, cost: costOf(sample[phase].postgres) })),
         { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
       );
     }
diff --git a/specs/imports-growth-driver.ts b/specs/imports-growth-driver.ts
index 06dc1b3ac7..68c2584069 100644
--- a/specs/imports-growth-driver.ts
+++ b/specs/imports-growth-driver.ts
@@ -20,7 +20,7 @@
  * At each scale seed runs ANALYZE outside measurement. Capture raw EXPLAIN QUERY
  * PLAN with the actual parameters for EVERY distinct executed SQLite SQL/binding,
  * also outside measurement. Never require statement-status, VM or index-height
- * estimates. SQLite blocks:0 means unavailable buffers, NOT zero physical I/O.
+ * estimates. SQLite buffers are unavailable; omit them from named counted samples.
  * Growing-table metadata comes from actual schema/index introspection, includes
  * every growing relation (including read aliases), and is checked in test support.
  * PostgreSQL retains actual examined rows and shared hits plus reads via growth.ts.
@@ -50,8 +50,10 @@
  * read + candidate insert + journal update + COMMIT = 7. Thus one bootstrap plus
  * one candidate already costs 28 SQLite statements BEFORE RunStore or Auth/Access.
  * Later proposals omit the first group insert (8 prepare + 7 acknowledge).
- * Exact combined budgets await real binding: declare additive per-method ceilings
- * before seed/measure, derived from production branches, never from observations.
+ * Binding declares static additive per-method ceilings before seed/measure,
+ * derived from production branches, never from observations. PostgreSQL client
+ * calls + raw plans and examined + ModifyTable rows remain separate derived units;
+ * canonical costOf(postgres) is never overridden.
  * Include retries, controls, nested security/receipt/fence paths and RunStore
  * prepare/acknowledge. Each term has fixed + per-item + per-field coefficients;
  * no dependence on N/history. Ratio checks remain mandatory for the full capture.
@@ -155,7 +157,7 @@ export interface SqliteStatement {
 }
 export interface PostgresStatement {
   engine: 'postgres';
-  /** Actual write row count, separate from auto_explain examined rows. */
+  /** Derived ModifyTable Actual Rows * Actual Loops, not independent affected-row truth. */
   rowsAppended: number;
   sql: string;
   /** Raw auto_explain JSON; empty only for captured transaction control or a failed attempt marked by the shared SQLSTATE. */
@@ -180,8 +182,15 @@ export interface Counters {
   };
   statements: readonly Statement[];
   networkRequests: number;
-  /** Reader/database phases only; absent for pure conversion, never fabricated. */
+  /** Actual accounting ingredients; parser observations exist only when a reader ran. */
+  accounting?: {
+    reader?: { pulledBytes: number; scannedBytes: number; copiedBytes: number };
+    requestBodyBytes: number;
+    pagePlanBytes: number;
+  };
+  /** Derived scanned+copied bytes + SQLite executions + PG client calls + raw plans; not CPU. */
   workUnits?: number;
+  /** Derived input/copy/request/page/plan accounting, not general heap allocation. */
   allocatedBytes?: number;
   peakRetainedBytes?: number;
   peakRetainedRecords?: number;
diff --git a/specs/imports-growth.test.ts b/specs/imports-growth.test.ts
index d2ae4f625f..5d40b95b43 100644
--- a/specs/imports-growth.test.ts
+++ b/specs/imports-growth.test.ts
@@ -9,6 +9,7 @@ import type { ConversionInput } from '../packages/conversion/src';
 import { isAbsolute } from 'node:path';
 import { pathToFileURL } from 'node:url';
 import { assertGrowth, type GrowthSample } from '../services/kernel/test/support/growth-bound';
+import { countedSample, countedViolations, validateCountedRun } from '../services/kernel/test/support/growth-counters';
 import { costOf, isControlStatement } from '../services/kernel/test/support/growth-cost';
 import type { Counters, Fixture, ImportGrowthDriver, Scenario, Seed, SqliteStatement } from './imports-growth-driver';
 import { assertIndexedSqlite } from './support/verify-import-api';
@@ -88,6 +89,9 @@ function integer(value: number) {
 function common(c: Counters): asserts c is Required<Counters> {
   for (const value of [c.networkRequests, c.workUnits, c.allocatedBytes, c.peakRetainedBytes, c.peakRetainedRecords])
     integer(value!);
+  expect(c.accounting).toBeDefined();
+  integer(c.accounting!.requestBodyBytes);
+  integer(c.accounting!.pagePlanBytes);
 }
 function purity(c: Counters) {
   integer(c.networkRequests);
@@ -100,6 +104,13 @@ function purity(c: Counters) {
 function readerCost(c: Counters, bytes: number, fields: number, byteCap = RECORD_CAP) {
   common(c);
   purity(c);
+  expect(c.accounting.reader).toBeDefined();
+  const reader = c.accounting.reader!;
+  for (const value of Object.values(reader)) integer(value);
+  expect(c.workUnits).toBe(reader.scannedBytes + reader.copiedBytes);
+  expect(c.allocatedBytes).toBe(reader.pulledBytes + reader.copiedBytes);
+  expect(c.accounting.requestBodyBytes).toBe(0);
+  expect(c.accounting.pagePlanBytes).toBe(0);
   expect(c.workUnits).toBeGreaterThan(0);
   expect(c.workUnits).toBeLessThanOrEqual(64 * (bytes + fields));
   expect(c.allocatedBytes).toBeGreaterThan(0);
@@ -210,17 +221,21 @@ function database(c: Counters, fixture: Fixture, seed: Seed, items = 1) {
   expect(c.allocatedBytes).toBeLessThanOrEqual(64 * (items * RECORD_CAP + seed.fields * 1024));
   expect(c.peakRetainedBytes).toBeLessThanOrEqual(4 * (B * RECORD_CAP + seed.fields * 1024));
   expect(c.peakRetainedRecords).toBeLessThanOrEqual(seed.scenario === 'bulk' ? items : B);
-  return {
-    // blocks:0 means unavailable SQLite buffers, not zero physical I/O.
-    sqlite: { rows: returned, blocks: 0, statements: sqliteStatements },
-    postgres: {
-      ...postgres,
-      rows: postgres.rows + appended,
-      statements: postgresStatements.length + c.postgres.plans.length,
-    },
-    // Status polls may repeat, so requests are compared with row slack.
-    network: { rows: c.networkRequests, blocks: 0, statements: 0 },
+  const counts = {
+    'sqlite returned rows': returned,
+    'sqlite executions': sqliteStatements,
+    'network requests': c.networkRequests,
+    'derived PG examined plus ModifyTable rows': postgres.rows + appended,
+    'derived PG client calls plus raw plans': postgresStatements.length + c.postgres.plans.length,
   };
+  // Keep the original composites, with their actual ingredients, outside canonical PG cost.
+  const reader = c.accounting.reader;
+  const work = sqliteStatements + postgresStatements.length + c.postgres.plans.length;
+  expect(c.workUnits).toBe(reader ? work + reader.scannedBytes + reader.copiedBytes : work);
+  const allocated = c.accounting.requestBodyBytes + c.accounting.pagePlanBytes;
+  expect(c.allocatedBytes).toBe(reader ? allocated + reader.pulledBytes + reader.copiedBytes : allocated);
+  validateCountedRun({ read: () => counts }, counts, seed.n);
+  return { postgres, counts };
 }
 const options = (scenario: Scenario, n = 32, history = 32, fields = 1): Seed =>
   Object.freeze({ n, history, fields, scenario, source: 'growth-source', key: 'fixed-record' });
@@ -416,6 +431,7 @@ async function reconcile(scenario: Scenario) {
   const fixed = new Map<number, string>();
   const samples = new Map<string, GrowthSample[]>();
   const pages = new Map<string, GrowthSample[]>();
+  const counted = new Map<string, { scale: number; counted: ReturnType<typeof countedSample> }[]>();
   for (const axis of ['n', 'history', 'fields'] as const)
     for (const scale of axisScales(axis)) {
       const seed = { ...options(scenario), [axis]: scale };
@@ -435,12 +451,12 @@ async function reconcile(scenario: Scenario) {
         expect(result.counters.networkRequests).toBeGreaterThanOrEqual(result.value.envelopes!.length);
       }
       const cost = database(result.counters, fixture, seed, items);
-      for (const engine of ['sqlite', 'postgres', 'network'] as const) {
-        const key = `${axis}:${engine}`;
-        const group = samples.get(key) ?? [];
-        group.push({ scale, cost: cost[engine] });
-        samples.set(key, group);
-      }
+      const group = samples.get(axis) ?? [];
+      group.push({ scale, cost: cost.postgres });
+      samples.set(axis, group);
+      const units = counted.get(axis) ?? [];
+      units.push({ scale, counted: countedSample([cost.counts]) });
+      counted.set(axis, units);
       const sql = result.counters.statements.map((s) => `${s.sql}\n${s.explain}`).join('\n');
       if (scenario === 'mass-disappearance') {
         expect(result.value.status).toBe('mass-disappearance-blocked');
@@ -476,12 +492,13 @@ async function reconcile(scenario: Scenario) {
           }),
         );
         const nextCost = database(next.counters, fixture, seed, B);
-        for (const engine of ['sqlite', 'postgres', 'network'] as const) {
-          const key = `${axis}:${engine}`;
-          const group = pages.get(key) ?? [];
-          group.push({ scale, cost: nextCost[engine] });
-          pages.set(key, group);
-        }
+        const group = pages.get(axis) ?? [];
+        group.push({ scale, cost: nextCost.postgres });
+        pages.set(axis, group);
+        const key = `${axis}:next-page`;
+        const units = counted.get(key) ?? [];
+        units.push({ scale, counted: countedSample([nextCost.counts]) });
+        counted.set(key, units);
         expect(next.value.visitedKeys).toEqual(fixture.vanishedKeys.slice(B, B * 2));
         expect(next.value.visitedKeys.length).toBeGreaterThan(0);
         expect(next.value.visitedKeys.length).toBeLessThanOrEqual(B);
@@ -489,14 +506,71 @@ async function reconcile(scenario: Scenario) {
       }
     }
   for (const [key, group] of [...samples, ...pages]) {
-    const payload = key.startsWith('fields:');
+    const payload = key === 'fields';
     assertGrowth(group, {
       rows: payload ? 'linear' : 'constant',
-      blocks: key.endsWith(':postgres') ? (payload ? 'linear' : 'logarithmic') : 'constant',
+      blocks: payload ? 'linear' : 'logarithmic',
       statements: payload ? 'linear' : 'constant',
     });
   }
+  for (const [axis, samples] of counted) {
+    const bound: 'linear' | 'constant' = axis.startsWith('fields') ? 'linear' : 'constant';
+    const bounds = Object.fromEntries(Object.keys(samples[0]!.counted).map((name) => [name, bound]));
+    expect(
+      countedViolations(
+        {
+          read: () => ({}),
+          bounds,
+          slack: {
+            'sqlite returned rows': { absolute: 2, relative: 0.1 },
+            'sqlite executions': { absolute: 0, relative: 0 },
+            'network requests': { absolute: 2, relative: 0.1 },
+            'derived PG examined plus ModifyTable rows': { absolute: 2, relative: 0.1 },
+            'derived PG client calls plus raw plans': { absolute: 0, relative: 0 },
+          },
+        },
+        samples,
+      ),
+    ).toEqual([]);
+  }
 }
+test('native import growth preserves canonical PostgreSQL capture and exact separate SQLite transport and derived work bounds', async () => {
+  const seed = options('unchanged');
+  const fixture = await d().seed(seed);
+  const result = await d().measure(() =>
+    d().run({
+      kind: 'unchanged',
+      source: seed.source,
+      key: seed.key,
+      fields: seed.fields,
+      pageCap: B,
+    }),
+  );
+  const raw = structuredClone(result.counters.postgres);
+  const summary = database(result.counters, fixture, seed);
+  expect(result.counters.postgres).toEqual(raw);
+  expect(summary.postgres).toEqual(costOf(raw));
+  const sqlite = result.counters.statements.filter((s) => s.engine === 'sqlite');
+  const pg = result.counters.statements.filter((s) => s.engine === 'postgres');
+  expect(summary.counts).toEqual({
+    'sqlite returned rows': sqlite.reduce((sum, s) => sum + s.rowsReturned, 0),
+    'sqlite executions': sqlite.length,
+    'network requests': result.counters.networkRequests,
+    'derived PG examined plus ModifyTable rows': costOf(raw).rows + pg.reduce((sum, s) => sum + s.rowsAppended, 0),
+    'derived PG client calls plus raw plans': raw.statements.length + raw.plans.length,
+  });
+  // Freeze the pre-existing static ceilings independently of observations or growth class.
+  for (const terms of Object.values(d().statementBudgets)) {
+    for (const engine of ['sqlite', 'postgres'] as const) {
+      const methods = terms.filter((term) => term.engine === engine);
+      expect(
+        ['fixed', 'perItem', 'perField'].map((key) =>
+          methods.reduce((sum, term) => sum + term[key as 'fixed' | 'perItem' | 'perField'], 0),
+        ),
+      ).toEqual(engine === 'sqlite' ? [1456, 144, 32] : [4000, 1000, 256]);
+    }
+  }
+});
 test('unchanged refresh still point seeks the fence without reading source or subject history', async () => {
   await reconcile('unchanged');
 });
```
