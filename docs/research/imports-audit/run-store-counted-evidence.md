# Run-store counted evidence reconciliation

The run-store evidence summary and every tracked value caller now use `runStoreCounts`, returning only
`sqlite returned rows` and `sqlite statements`. The producer still validates the complete raw evidence before
summing it. Shared `CountedCheck`, `countedSample` and `countedViolations` supply the assertions. No product store,
probe, forwarding driver, wrapper, fixture, business scenario, key, envelope byte or numeric ceiling changed.
No missing acceptance test was found: the existing complete portable suites and local suites cover this contract.

## Source and scope

Base: `22ec9cb1cba1989612a0fa1026244930e49a4183`. Code revision: `44f99b892c123748a3c06e34e567eb0cbccdc882`.
The remaining-port inventory was read from its actual committed revision
`5c47a835ca8f0804fee95df9bc28a696a5584366:docs/research/imports-audit/remaining-cost-unit-ports.md`,
whose inspected source revision is `860ec3c071f213ccd3cd0ad288f7bf0777c20384`.
It was not assumed to be integrated into this base. The latter revision's commit subject is unrelated to this
inventory; the inventory itself lives in the former commit.

Read source: all four portable files named below; both production forwarding drivers; both native wrappers;
`run-store-growth.test.ts`, `run-store-pages.test.ts`, shared `sqlite-growth.ts`, `growth-counters.ts` and
`growth-bound.ts`; the importer README, Imports and Performance Goal definitions, architecture, scope and workflow
verification/review rules. No reference project source or external research was required for this summary-only change.

Changes outside declared paths: none. Both forwarding drivers already return raw evidence, so compatibility edits
were unnecessary. Both wrappers remain byte-for-byte unchanged. No new helper, duplicated counter engine or mirrored
suite was introduced. Files in undeclared risk areas stayed closed.

## Units, tolerances and identities

`sqlite returned rows` is exactly the sum of `executions[].rows`, the actual rows delivered to callers.
`sqlite statements` is exactly `executions.length`, including transaction controls. Probe callers consume the
already integrated `sample.counts` with these same two units, never the deprecated compatibility summary.
Neither unit measures examined rows, VM/index steps, PostgreSQL work or buffer IO. Unavailable buffer evidence is
omitted. No byte metric is remapped or invented. The existing byte/key/envelope constraints remain business assertions.

Every returned-row growth check explicitly retains absolute slack **2**, relative slack **0.1**. Every execution
growth check explicitly retains absolute **0**, relative **0**. The removed synthetic buffer metric carried no
observation (the direct seven-operation check formerly overrode its slack to zero); no real byte tolerance is changed.
For a scale ratio r and values a,b,c, constant still permits `max(b,c)-a <= max(absolute, relative*a)`;
linear still permits `c-b <= 1.5*r*max(b-a,0) + max(absolute, relative*a)`.

| Surface                                                            | Exact retained ceilings and growth                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable run-state begin, successful seal, mass-disappearance seal | Each <=8 returned rows / <=16 statements; constant.                                                                                                      |
| Portable classify / acknowledge                                    | Each <=64 / <=48; constant.                                                                                                                              |
| Portable pending page                                              | <=8 / <=16; constant.                                                                                                                                    |
| Portable vanished after Qvanished0, limit 3                        | Exact keys Qvanished1–3; <=3 / <=16; constant.                                                                                                           |
| Portable finalize cap 8                                            | Each page <=128 / <=256; calls <scale+20; first page constant; sums linear.                                                                              |
| Supplied staging                                                   | Visits exactly scale+1; rows <=16*visits; statements >=visits and <=32*visits; both linear.                                                              |
| Local mass-check / classify / pending / ack                        | Each <=64 / <=48; constant; pending key and immutable bytes survive rejection/reopen/changed-body rejection.                                             |
| Plans common measurement                                           | Exactly zero network requests and empty kernel partitions; rows <=64*(m+cap), statements <=32*(m+cap).                                                   |
| Fixed plans                                                        | 128 commands, cap 8 for prepare/ack: <=8704 / <=4352; page/finalize cap 2, m=0: <=128 / <=64; all constant.                                              |
| Variable plans m=1/8/64                                            | Prepare statements >=m; prepare/ack rows and statements linear; page constant; exact public envelopes reconstructed unchanged.                           |
| Direct seven-operation capture                                     | Control/stage/key/omission constant; projection/vanished/finalize pages LINEAR, with fixed limit 8. The page assertion is not tightened.                 |
| Probe page                                                         | Exact active run, Q000002–Q000004, empty acknowledged page; observed statements >0, returned rows >=3; both constant; invalid limits 101/0 still reject. |

All rejected/run/source/generation/cursor/control assertions remain. The validator body before the summary return
is byte-identical, SHA-256 `9b8502e266737c0e98d7365f642e92bbc39402e1659b8587af3deda9c5d05634`. It still requires nonempty executions, integer
returned rows, actual ANALYZE per database and raw growing schema/index definitions; forbids COUNT/OFFSET; verifies
controls have no reads/rows/plan and direct VALUES inserts use a declared unique key without hidden reads; requires
readable SQL plans and every growing relation occurrence; rejects growing SCAN, AUTOMATIC and temporary B-trees;
checks each alias has a declared-index SEARCH with explicit constraints; requires non-point ranges to have
first-column equality, at least two constrained index columns, SQL LIMIT and the caller's returned-row page cap.
Raw SQL, bindings, database identities and EQP evidence remain in the original contract.

## Scales, physical populations and remaining limits

Portable run-state uses an accumulating same-source store at **32/128/512**. Each scale adds three complete snapshots
of n history keys, one fixed key and eight vanished keys: prior n+9 and supplied/survivors n+1. Earlier snapshots and
failed/measured runs remain. Staging grows its finite supplied-record pass separately. These are logical input sizes,
not total database row counts.

Local fixed operations likewise accumulate three snapshots of n keys at **32/128/512**, plus intervening blocked and
refresh runs. Plans accumulate three snapshots of n+1 records at **32/128/512**, a 64-field fixed historical record
and a 128-command changed plan. The independent **1/8/64** axis counts private commands, not catalogue rows.

The direct seven-operation fixture uses a fresh file for each operation and logical scale **1/8/64**. Its completed
seed inserts **500/4000/32000 rows into EACH** of `run_sources`, `run_generations`, `run_entries`, `run_members`,
`run_acknowledged`, `run_commands`, `run_payloads`, and `run_envelopes`, outside measurement, then runs ANALYZE.
One hot source owns all generations; extra source rows pad the sources relation. These are the exact deterministic
seed cardinalities; there is no new per-table count observation in this run.

The probe-page fixture uses fresh databases at **32/128/512 staged entries**, one source/run and no acknowledged
population. The eight-table physical row populations for the accumulating portable and local fixtures are **missing
observations**: the raw measurement schema/executions do not include a cardinality snapshot, and wrapper success
output does not export one. Although `persisted()` can expose rows outside measurement, this port does not change
the immutable business scenarios to add a population capture. No inferred complete eight-table population is claimed.

This reconciliation preserves existing scales and populations. It does not close missing hot-population or filtered
list axes, certify list-axis completeness, or establish all-importer, PostgreSQL, native-kernel or promoted-main proof.

## Verification

The first committed revision ran the four-file acceptance once: exit 1, **10 pass / 1 fail**, 102 expect calls,
11 tests across four files, 141.62 seconds. All eight local growth tests, the local page test and the run-state
wrapper passed. The latter wrapper validates the real complete **16 pass / 0 fail** child summary and absence of
skip/todo. The run-plan wrapper has **22** immutable declarations, but its child summary was unavailable: it timed
out and Bun killed one dangling child. Its raw failure was:

```text
(fail) all bounded run-plan outcomes pass with production durable storage [120030.74ms]
  ^ this test timed out after 120000ms.
```

The first root typecheck exited 1 with three TS2379 errors in the two local test files: the shared
`countedViolations` signature accepts `CountedCheck<unknown>`, while the first configuration used
`CountedCheck<CountedValues>`. The final configuration follows the existing importer counted-check pattern:
`CountedCheck` with an explicitly cast identity reader. All four configurations were corrected and committed.
No shared API, evidence, bound, tolerance, host, dependency, setting, timeout or wrapper was changed.

Final-code acceptance and root typecheck are pending. The initial timeout is not claimed to be a reproduced base
failure, a counted-assertion failure, or passing evidence for the 22 run-plan outcomes. No baseline command was run.

## Full old/new portable hashes

SHA-256 of complete file bytes; unchanged forwarders and frozen wrappers are included to make preservation reviewable.

| File                                                 | Before                                                             | After                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `specs/imports-run-store-driver.ts`                  | `019a7b1a8be734030c35085cab64d05a096748a8f63e2d74d1ffde4d3495ca74` | `afe331b8c69860ef429ebde7799a673614208d6350233a308ac3d3d3e536a28f` |
| `specs/imports-run-store.test.ts`                    | `3761e52f00242c6aa92f9b429bfd3a898063670d75476326ae51d0f7c7807246` | `4eca455fcedb0e22af294035ca2959149b7d7dad0e44f4d9ef4425c222e34442` |
| `specs/imports-run-plans.test.ts`                    | `994cb1686056cd117c5e2cab49053b953a64b2d407cd1db6ffe2935b8f15e58c` | `c835bd140f5e1b93eab126de8f1c8d222efe73add88a674962d503c7ec2863db` |
| `specs/imports-run-plans-driver.ts`                  | `fd20a65c1dca68b965a81b73ea2692f18707e9daab212b1f0463d72554080b1f` | `588a7c2d8cf42cfbc058cf5e4d77ef9958eb3cf87800e172932acd69da70b337` |
| `services/importer/tests/run-store-driver.ts`        | `f5685781939f3da264112bb5ef616d50e82c7e0b77ca6dfd035fa27cc67f106d` | `f5685781939f3da264112bb5ef616d50e82c7e0b77ca6dfd035fa27cc67f106d` |
| `services/importer/tests/run-plans-driver.ts`        | `60b65dcd138f6d72ae0983936f40fc8a455bf036275a0aa68a36363ac82b388e` | `60b65dcd138f6d72ae0983936f40fc8a455bf036275a0aa68a36363ac82b388e` |
| `services/importer/tests/run-store-outcomes.test.ts` | `0f87ad4ef65711d7c1763a634dc644f00359e2865b510d94360ce12bcc777ae7` | `0f87ad4ef65711d7c1763a634dc644f00359e2865b510d94360ce12bcc777ae7` |
| `services/importer/tests/run-plans-outcomes.test.ts` | `3ae5d03efded32e2e10a9f7e5de3f594e4f3f1e3d3c9ad35b824d21bc5b2a67d` | `3ae5d03efded32e2e10a9f7e5de3f594e4f3f1e3d3c9ad35b824d21bc5b2a67d` |

## Full reconciliation diff

The complete code diff (all six changed source/test files, full Git blob identities) follows. It can also be reproduced
with `git diff --full-index 22ec9cb1cba1989612a0fa1026244930e49a4183 44f99b892c123748a3c06e34e567eb0cbccdc882 -- specs/imports-run-store-driver.ts specs/imports-run-store.test.ts specs/imports-run-plans.test.ts specs/imports-run-plans-driver.ts services/importer/tests/run-store-growth.test.ts services/importer/tests/run-store-pages.test.ts`.

```diff
diff --git a/services/importer/tests/run-store-growth.test.ts b/services/importer/tests/run-store-growth.test.ts
index d74974e4c71e4c9f877d8afceea11ea046a01221..bdab8def1f090f54b5422b9fc8a7fe957e63a7a8 100644
--- a/services/importer/tests/run-store-growth.test.ts
+++ b/services/importer/tests/run-store-growth.test.ts
@@ -3,12 +3,27 @@ import { mkdtemp, rm } from 'node:fs/promises';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
-import { assertGrowth, type GrowthSample } from '../../kernel/test/support/growth-bound.ts';
-import { runStoreCost, type Staged } from '../../../specs/imports-run-store-driver.ts';
+import {
+  countedSample,
+  countedViolations,
+  type CountedCheck,
+  type CountedSample,
+  type CountedValues,
+} from '../../kernel/test/support/growth-counters.ts';
+import { runStoreCounts, type Staged } from '../../../specs/imports-run-store-driver.ts';
 import { createImportRunStoreDriver } from './run-store-driver.ts';
 import { RunStore } from '../src/run-store.ts';
 import { createSqliteProbe } from './support/sqlite-growth.ts';

+const fixedCounts: CountedCheck = {
+  read: (counts) => counts as CountedValues,
+  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
+  slack: {
+    'sqlite returned rows': { absolute: 2, relative: 0.1 },
+    'sqlite statements': { absolute: 0, relative: 0 },
+  },
+};
+
 function record(key: string, revision: number): Staged {
   const projection: Staged['projection'] = [
     {
@@ -58,7 +73,7 @@ const ack = (keys: string[]): BatchWriteResult => ({
 test('fixed run-state operations stay indexed at three scales', async () => {
   const directory = await mkdtemp(join(tmpdir(), 'run-growth-'));
   const d = await createImportRunStoreDriver({ directory });
-  const samples = new Map<string, GrowthSample[]>();
+  const samples = new Map<string, { scale: number; counted: CountedSample }[]>();
   try {
     for (const scale of [32, 128, 512]) {
       // One deterministic population, same source and indexes, three historical versions.
@@ -82,11 +97,11 @@ test('fixed run-state operations stay indexed at three scales', async () => {
       }
       const measure = async <T>(name: string, operation: () => Promise<T>) => {
         const measured = await d.measure(operation);
-        const cost = runStoreCost(measured.evidence, 8);
-        expect(cost.rows).toBeLessThanOrEqual(64);
-        expect(cost.statements).toBeLessThanOrEqual(48);
+        const counts = runStoreCounts(measured.evidence, 8);
+        expect(counts['sqlite returned rows']).toBeLessThanOrEqual(64);
+        expect(counts['sqlite statements']).toBeLessThanOrEqual(48);
         const group = samples.get(name) ?? [];
-        group.push({ scale, cost });
+        group.push({ scale, counted: countedSample([counts]) });
         samples.set(name, group);
         return measured.value;
       };
@@ -128,8 +143,7 @@ test('fixed run-state operations stay indexed at three scales', async () => {
       }
       expect((await d.source('growth')).count).toBe(scale);
     }
-    for (const group of samples.values())
-      assertGrowth(group, { rows: 'constant', blocks: 'constant', statements: 'constant' });
+    for (const group of samples.values()) expect(countedViolations(fixedCounts, group)).toEqual([]);
   } finally {
     await d.close();
     await rm(directory, { recursive: true, force: true });
@@ -245,7 +259,7 @@ async function measureRunGrowth(
   page = false,
   status: 'staging' | 'ready' = 'ready',
 ) {
-  const samples: GrowthSample[] = [];
+  const samples: { scale: number; counted: CountedSample }[] = [];
   const plans: string[] = [];
   for (const scale of RUN_SCALES) {
     const directory = await mkdtemp(join(tmpdir(), 'run-store-growth-followup-'));
@@ -271,7 +285,7 @@ async function measureRunGrowth(
         const statements = measured.statements.map((event) => `${event.sql}\n${JSON.stringify(event.plan)}`).join('\n');
         throw new Error(`${name}: ${String(error)}\n${statements}`);
       }
-      samples.push({ scale, cost: measured.cost });
+      samples.push({ scale, counted: countedSample([measured.counts]) });
       plans.push(
         `scale ${scale}:\n${measured.statements.map((event) => `${event.sql}\n${JSON.stringify(event.plan)}`).join('\n')}`,
       );
@@ -281,15 +295,18 @@ async function measureRunGrowth(
     }
   }
   try {
-    assertGrowth(
-      samples,
-      {
-        rows: page ? 'linear' : 'constant',
-        blocks: 'constant',
-        statements: page ? 'linear' : 'constant',
-      },
-      { blocks: { absolute: 0, relative: 0 } },
-    );
+    expect(
+      countedViolations(
+        {
+          ...fixedCounts,
+          bounds: {
+            'sqlite returned rows': page ? 'linear' : 'constant',
+            'sqlite statements': page ? 'linear' : 'constant',
+          },
+        },
+        samples,
+      ),
+    ).toEqual([]);
   } catch (error) {
     throw new Error(`${name}: ${String(error)}\n${plans.join('\n')}`);
   }
diff --git a/services/importer/tests/run-store-pages.test.ts b/services/importer/tests/run-store-pages.test.ts
index 240d6feac03cdea6fe5e78ce938da5f4a1aaaa82..00b18e67b277a5f5e7d3147825fd9525e1a69a09 100644
--- a/services/importer/tests/run-store-pages.test.ts
+++ b/services/importer/tests/run-store-pages.test.ts
@@ -1,11 +1,26 @@
 import { Database } from 'bun:sqlite';
 import { expect, test } from 'bun:test';
-import { assertGrowth, type GrowthSample } from '../../kernel/test/support/growth-bound';
+import {
+  countedSample,
+  countedViolations,
+  type CountedCheck,
+  type CountedSample,
+  type CountedValues,
+} from '../../kernel/test/support/growth-counters.ts';
 import { RUN_TABLES, RunStore, type SourceProjection } from '../src/run-store';
 import { createSqliteProbe } from './support/sqlite-growth';

+const fixedCounts: CountedCheck = {
+  read: (counts) => counts as CountedValues,
+  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
+  slack: {
+    'sqlite returned rows': { absolute: 2, relative: 0.1 },
+    'sqlite statements': { absolute: 0, relative: 0 },
+  },
+};
+
 test('sealed source projections use bounded indexed pages at three scales', () => {
-  const samples: GrowthSample[] = [];
+  const samples: { scale: number; counted: CountedSample }[] = [];
   for (const scale of [32, 128, 512]) {
     const database = new Database(':memory:');
     const probe = createSqliteProbe(database, { growingTables: RUN_TABLES });
@@ -35,10 +50,10 @@ test('sealed source projections use bounded indexed pages at three scales', () =
         expect(page.map((entry) => entry.row.recordKey)).toEqual(['Q000002', 'Q000003', 'Q000004']);
         expect(store.pageAcknowledged('wikidata', { limit: 3 })).toEqual([]);
       });
-      expect(result.cost.statements).toBeGreaterThan(0);
-      expect(result.cost.rows).toBeGreaterThanOrEqual(3);
+      expect(result.counts['sqlite statements']).toBeGreaterThan(0);
+      expect(result.counts['sqlite returned rows']).toBeGreaterThanOrEqual(3);
       probe.verifyPlans();
-      samples.push({ scale, cost: result.cost });
+      samples.push({ scale, counted: countedSample([result.counts]) });
       expect(() => store.pageStaged(run, { limit: 101 })).toThrow();
       expect(() => store.pageAcknowledged('wikidata', { limit: 0 })).toThrow();
       expect(store.activeRun('bangumi')).toBeNull();
@@ -47,5 +62,5 @@ test('sealed source projections use bounded indexed pages at three scales', () =
       store.close();
     }
   }
-  assertGrowth(samples, { rows: 'constant', blocks: 'constant', statements: 'constant' });
+  expect(countedViolations(fixedCounts, samples)).toEqual([]);
 });
diff --git a/specs/imports-run-plans-driver.ts b/specs/imports-run-plans-driver.ts
index 66ffdd88a08a5aeb3a6cae9a2961650db00140ab..7c6dc26bd752e76e929e5011e9ed9bfa8fb02902 100644
--- a/specs/imports-run-plans-driver.ts
+++ b/specs/imports-run-plans-driver.ts
@@ -39,9 +39,9 @@
  * services/importer/tests/support/sqlite-growth.ts, installed before statements
  * are prepared, including every connection and rejection. Supplement its raw
  * evidence with actual sqlite_schema/PRAGMA introspection and ANALYZE/EQP for
- * every distinct SQL/binding at every scale, as required by runStoreCost. Never
+ * every distinct SQL/binding at every scale, as required by runStoreCounts. Never
  * substitute callbacks, static indexed flags, wall time or invented counters.
- * blocks:0 means unavailable buffer evidence, not zero physical IO.
+ * Summaries count SQLite statements and returned rows; buffer IO is not observed.
  */
 import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
 import type { Evidence, Omission, Run, RunStoreDriver } from './imports-run-store-driver.ts';
diff --git a/specs/imports-run-plans.test.ts b/specs/imports-run-plans.test.ts
index 78ccc4066132feca856e1cb80cec3c751c08a335..4c88fa99c06b7371217ba66c33716cc943cab7f4 100644
--- a/specs/imports-run-plans.test.ts
+++ b/specs/imports-run-plans.test.ts
@@ -9,8 +9,14 @@ import {
   type BatchCommand,
   type BatchWriteResult,
 } from '@rezics/definitions/bulk';
-import { assertGrowth, type GrowthSample } from '../services/kernel/test/support/growth-bound.ts';
-import { runStoreCost, type Run, type Staged, type Pending } from './imports-run-store-driver.ts';
+import {
+  countedSample,
+  countedViolations,
+  type CountedCheck,
+  type CountedSample,
+  type CountedValues,
+} from '../services/kernel/test/support/growth-counters.ts';
+import { runStoreCounts, type Run, type Staged, type Pending } from './imports-run-store-driver.ts';
 import {
   MISSING_RUN_PLANS_DRIVER,
   PLAN_CAPS,
@@ -18,6 +24,15 @@ import {
   type RunPlansDriver,
 } from './imports-run-plans-driver.ts';

+const fixedCounts: CountedCheck = {
+  read: (counts) => counts as CountedValues,
+  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
+  slack: {
+    'sqlite returned rows': { absolute: 2, relative: 0.1 },
+    'sqlite statements': { absolute: 0, relative: 0 },
+  },
+};
+
 const SOURCE = 'wikidata';
 // Existing catalogue fixture identities, never allocated by this component.
 const subject = '00000000-0000-4000-8000-000000000001';
@@ -600,28 +615,28 @@ async function measured<T>(h: Harness, operation: () => Promise<T>, m: number, p
   const capture = await h.d.measure(operation);
   expect(capture.networkRequests).toBe(0);
   expect(capture.kernelPartitions).toEqual([]);
-  const cost = runStoreCost(capture.evidence, pageCap);
-  expect(cost.rows).toBeLessThanOrEqual(64 * (m + pageCap));
-  expect(cost.statements).toBeLessThanOrEqual(32 * (m + pageCap));
-  return { value: capture.value, cost };
+  const counts = runStoreCounts(capture.evidence, pageCap);
+  expect(counts['sqlite returned rows']).toBeLessThanOrEqual(64 * (m + pageCap));
+  expect(counts['sqlite statements']).toBeLessThanOrEqual(32 * (m + pageCap));
+  return { value: capture.value, counts };
 }

 test(
   'same-source 32 128 512 unrelated keys and history cannot grow fixed 128-command prepare page ack or finalize costs',
   async () =>
     withStore(async (h) => {
-      const samples = new Map<string, GrowthSample[]>();
+      const samples = new Map<string, { scale: number; counted: CountedSample }[]>();
       const capture = async <T>(name: string, scale: number, operation: () => Promise<T>, m = 128, cap = 8) => {
         const sample = await measured(h, operation, m, cap);
         const group = samples.get(name) ?? [];
-        group.push({ scale, cost: sample.cost });
+        group.push({ scale, counted: countedSample([sample.counts]) });
         samples.set(name, group);
         return sample.value;
       };
       for (const n of [32, 128, 512]) {
         const unrelated = await grow(h, n);
         const fixed = record('Qfixed', n * 10 + 1);
-        const run = await h.ready([...unrelated, fixed]); // streaming source setup outside cost
+        const run = await h.ready([...unrelated, fixed]); // streaming source setup outside counts
         await h.d.analyze();
         expect(await capture('prepare', n, () => h.d.prepare(run, 'Qfixed', { commands: plan(fixed) }))).toBe(
           'changed',
@@ -635,8 +650,7 @@ test(
         await capture('finalize page', n, () => h.d.finalize(run, 2), 0, 2);
         await h.finish(run);
       }
-      for (const group of samples.values())
-        assertGrowth(group, { rows: 'constant', blocks: 'constant', statements: 'constant' });
+      for (const group of samples.values()) expect(countedViolations(fixedCounts, group)).toEqual([]);
     }),
   120_000,
 );
@@ -645,33 +659,40 @@ test(
   'M 1 8 64 private commands grow actual touched work linearly with shared SQLite indexed-plan proof',
   async () =>
     withStore(async (h) => {
-      const samples = new Map<string, GrowthSample[]>();
+      const samples = new Map<string, { scale: number; counted: CountedSample }[]>();
       for (const m of [1, 8, 64]) {
         const r = record('Qpayload', m, m);
         const run = await h.ready([r]);
         await h.d.analyze();
         const prepare = await measured(h, () => h.d.prepare(run, r.row.recordKey, { commands: proposals(r) }), m);
-        expect(prepare.cost.statements).toBeGreaterThanOrEqual(m);
+        expect(prepare.counts['sqlite statements']).toBeGreaterThanOrEqual(m);
         const page = await measured(h, () => h.d.pagePending(run, { limit: 2 }), 0, 2);
         expect(page.value.flatMap(portable)).toEqual(proposals(r));
         const ack = await measured(h, () => h.ack(run, page.value), m);
-        for (const [name, cost] of [
-          ['prepare', prepare.cost],
-          ['page', page.cost],
-          ['ack', ack.cost],
+        for (const [name, counts] of [
+          ['prepare', prepare.counts],
+          ['page', page.counts],
+          ['ack', ack.counts],
         ] as const) {
           const group = samples.get(name) ?? [];
-          group.push({ scale: m, cost });
+          group.push({ scale: m, counted: countedSample([counts]) });
           samples.set(name, group);
         }
         await h.finish(run);
       }
       for (const [name, group] of samples)
-        assertGrowth(group, {
-          rows: name === 'page' ? 'constant' : 'linear',
-          blocks: 'constant',
-          statements: name === 'page' ? 'constant' : 'linear',
-        });
+        expect(
+          countedViolations(
+            {
+              ...fixedCounts,
+              bounds: {
+                'sqlite returned rows': name === 'page' ? 'constant' : 'linear',
+                'sqlite statements': name === 'page' ? 'constant' : 'linear',
+              },
+            },
+            group,
+          ),
+        ).toEqual([]);
     }),
   120_000,
 );
diff --git a/specs/imports-run-store-driver.ts b/specs/imports-run-store-driver.ts
index eef7dcbdcc385921bb66d79c40b051f54741f959..8f33cca3ddf4fc1c072070fdf5d5cf5cf1144c3f 100644
--- a/specs/imports-run-store-driver.ts
+++ b/specs/imports-run-store-driver.ts
@@ -127,8 +127,8 @@ export type CreateImportRunStoreDriver = (options: { directory: string }) => Pro
  * Wrap ALL actual Database prepare/query/run/exec and executed Statement
  * get/all/iterate/run, including transaction controls and lazy iterator rows.
  * Count executions once, not preparations. Capture even on operation rejection.
- * No VM/fullscan/index-step/FFI counters. rows = actual rows delivered to caller;
- * blocks:0 means unavailable SQLite buffer evidence, not zero physical IO.
+ * No VM/fullscan/index-step/FFI counters. rows = actual rows delivered to caller.
+ * Summaries count SQLite statements and returned rows; buffer IO is not observed.
  * EXPLAIN every distinct SQL AND actual binding after ANALYZE at EVERY scale,
  * outside measurement. No fabricated counters, empty capture, or static flags.
  * Schema is raw sqlite_schema plus PRAGMA index_list/index_info/table_info
@@ -160,11 +160,10 @@ export interface Evidence {
   executions: Execution[];
 }

+export type RunStoreCounts = { 'sqlite returned rows': number; 'sqlite statements': number };
+
 /** Indexed-plan proof shared by the executable scenarios; never a product flag. */
-export function runStoreCost(
-  evidence: Evidence,
-  pageCap: number = CAPS.page,
-): { rows: number; blocks: 0; statements: number } {
+export function runStoreCounts(evidence: Evidence, pageCap: number = CAPS.page): RunStoreCounts {
   function requireProof(condition: unknown, message: string): asserts condition {
     if (!condition) throw new Error(`Run-store SQLite evidence: ${message}`);
   }
@@ -285,5 +284,5 @@ export function runStoreCost(
       }
     }
   }
-  return { rows, blocks: 0, statements: evidence.executions.length };
+  return { 'sqlite returned rows': rows, 'sqlite statements': evidence.executions.length };
 }
diff --git a/specs/imports-run-store.test.ts b/specs/imports-run-store.test.ts
index 3d038978a8b224e3ff2ad1a60265be884517006a..826b5b98f7f684ba107a5a0b92ef403623e64b5e 100644
--- a/specs/imports-run-store.test.ts
+++ b/specs/imports-run-store.test.ts
@@ -3,11 +3,17 @@ import { mkdtemp, rm } from 'node:fs/promises';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { checkBatchWrite, type BatchCommand, type BatchWriteResult } from '@rezics/definitions/bulk';
-import { assertGrowth, type GrowthSample } from '../services/kernel/test/support/growth-bound.ts';
+import {
+  countedSample,
+  countedViolations,
+  type CountedCheck,
+  type CountedSample,
+  type CountedValues,
+} from '../services/kernel/test/support/growth-counters.ts';
 import {
   CAPS,
   MISSING_RUN_STORE_DRIVER,
-  runStoreCost,
+  runStoreCounts,
   type CreateImportRunStoreDriver,
   type Run,
   type RunStoreDriver,
@@ -15,6 +21,15 @@ import {
   type Pending,
 } from './imports-run-store-driver.ts';

+const fixedCounts: CountedCheck = {
+  read: (counts) => counts as CountedValues,
+  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
+  slack: {
+    'sqlite returned rows': { absolute: 2, relative: 0.1 },
+    'sqlite statements': { absolute: 0, relative: 0 },
+  },
+};
+
 const SOURCE = 'wikidata';
 const PRIVATE = 'PRIVATE_SOURCE_BODY_DO_NOT_PERSIST';
 // A storage fixture, deliberately independent of the not-yet-landed converter.
@@ -556,8 +571,8 @@ test(
   'three-scale actual SQLite evidence bounds counters classify ack and vanished pages independent of same-source history',
   async () =>
     withStore(async (h) => {
-      const samples = new Map<string, GrowthSample[]>();
-      const finalizationTotals: GrowthSample[] = [];
+      const samples = new Map<string, { scale: number; counted: CountedSample }[]>();
+      const finalizationTotals: { scale: number; counted: CountedSample }[] = [];
       const measure = async <T>(
         name: string,
         scale: number,
@@ -566,11 +581,11 @@ test(
         maxStatements: number,
       ) => {
         const result = await h.d.measure(operation);
-        const cost = runStoreCost(result.evidence, 8);
-        expect(cost.rows).toBeLessThanOrEqual(maxRows);
-        expect(cost.statements).toBeLessThanOrEqual(maxStatements);
+        const counts = runStoreCounts(result.evidence, 8);
+        expect(counts['sqlite returned rows']).toBeLessThanOrEqual(maxRows);
+        expect(counts['sqlite statements']).toBeLessThanOrEqual(maxStatements);
         if (!samples.has(name)) samples.set(name, []);
-        samples.get(name)!.push({ scale, cost });
+        samples.get(name)!.push({ scale, counted: countedSample([counts]) });
         return result.value;
       };
       for (const scale of [32, 128, 512]) {
@@ -625,31 +640,35 @@ test(
             omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision: '1' }],
           });
         let status = 'more';
-        const total = { rows: 0, blocks: 0 as const, statements: 0 };
+        const total = { 'sqlite returned rows': 0, 'sqlite statements': 0 };
         for (let pages = 0; status !== 'complete'; pages++) {
           expect(pages).toBeLessThan(scale + 20);
           const measured = await h.d.measure(() => h.d.finalize(run, 8));
-          const cost = runStoreCost(measured.evidence, 8);
-          expect(cost.rows).toBeLessThanOrEqual(128);
-          expect(cost.statements).toBeLessThanOrEqual(256);
-          total.rows += cost.rows;
-          total.statements += cost.statements;
+          const counts = runStoreCounts(measured.evidence, 8);
+          expect(counts['sqlite returned rows']).toBeLessThanOrEqual(128);
+          expect(counts['sqlite statements']).toBeLessThanOrEqual(256);
+          total['sqlite returned rows'] += counts['sqlite returned rows'];
+          total['sqlite statements'] += counts['sqlite statements'];
           status = measured.value;
           expect(['more', 'complete']).toContain(status);
           if (pages === 0) {
             if (!samples.has('bounded finalization page')) samples.set('bounded finalization page', []);
-            samples.get('bounded finalization page')!.push({ scale, cost });
+            samples.get('bounded finalization page')!.push({ scale, counted: countedSample([counts]) });
             if (status === 'more') {
               run = await h.reopen(run);
               await h.d.analyze();
             }
           }
         }
-        finalizationTotals.push({ scale, cost: total });
+        finalizationTotals.push({ scale, counted: countedSample([total]) });
       }
-      for (const group of samples.values())
-        assertGrowth(group, { rows: 'constant', blocks: 'constant', statements: 'constant' });
-      assertGrowth(finalizationTotals, { rows: 'linear', blocks: 'constant', statements: 'linear' });
+      for (const group of samples.values()) expect(countedViolations(fixedCounts, group)).toEqual([]);
+      expect(
+        countedViolations(
+          { ...fixedCounts, bounds: { 'sqlite returned rows': 'linear', 'sqlite statements': 'linear' } },
+          finalizationTotals,
+        ),
+      ).toEqual([]);
     }),
   120_000,
 );
@@ -658,7 +677,7 @@ test(
   'one-pass supplied staging grows linearly separately from persistent-history indexed operations',
   async () =>
     withStore(async (h) => {
-      const samples: GrowthSample[] = [];
+      const samples: { scale: number; counted: CountedSample }[] = [];
       for (const scale of [32, 128, 512]) {
         const { supplied } = await grow(h, scale);
         const run = await h.begin(SOURCE, 1);
@@ -672,14 +691,19 @@ test(
           }
         });
         expect(visits).toBe(scale + 1);
-        const cost = runStoreCost(result.evidence);
-        expect(cost.rows).toBeLessThanOrEqual(16 * visits);
-        expect(cost.statements).toBeGreaterThanOrEqual(visits);
-        expect(cost.statements).toBeLessThanOrEqual(32 * visits);
-        samples.push({ scale, cost });
+        const counts = runStoreCounts(result.evidence);
+        expect(counts['sqlite returned rows']).toBeLessThanOrEqual(16 * visits);
+        expect(counts['sqlite statements']).toBeGreaterThanOrEqual(visits);
+        expect(counts['sqlite statements']).toBeLessThanOrEqual(32 * visits);
+        samples.push({ scale, counted: countedSample([counts]) });
         expect(await h.d.abandon(run)).toBe('abandoned');
       }
-      assertGrowth(samples, { rows: 'linear', blocks: 'constant', statements: 'linear' });
+      expect(
+        countedViolations(
+          { ...fixedCounts, bounds: { 'sqlite returned rows': 'linear', 'sqlite statements': 'linear' } },
+          samples,
+        ),
+      ).toEqual([]);
     }),
   120_000,
 );
```
