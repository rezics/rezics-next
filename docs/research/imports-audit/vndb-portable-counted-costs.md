# Portable VNDB table counted costs

This is a unit-only acceptance-owner reconciliation. Delivery proves this specification artifact exists;
it proves no native outcome, indexed-growth pass or complete VNDB import. The portable
`createVndbTablesDriver(limits, attachSqlite)` binding is still missing. The unbound suite and
missing-driver verifier were not run; their loader error would not be a native failure.

## Counted observations

Only the summary and its two growth consumers use the shared
`services/kernel/test/support/growth-counters.ts` `CountedCheck`, `countedSample` and
`countedViolations`. Each sample retains the single actual observation as both `value` and its
one-element `repetitions` array. `sqlite returned rows` reads raw `Cost.rows`; `sqlite statements`
reads raw `Cost.statements`. Both bounds are constant. Explicit slack is respectively
absolute 2 / relative 0.1 and absolute 0 / relative 0. No counted absolute ceiling is added.

At the unchanged scales 32, 128 and 512, each consumer applies the same inequality as before:
`max(value128, value512) - value32 <= max(absolute, relative * value32)`.
The consumers are the fixed-record page read and the fixed seven-row staging operation in
`one grouped record uses indexed seeks and constant returned rows and statements at 32 128 and 512 unrelated keys`.
The former synthetic blocks series is removed, with no replacement buffer measurement. These are
SQLite rows returned to store callers and executed statements, never examined rows, PostgreSQL
units, physical IO, elapsed time or an estimate of underlying page work.

Raw `Cost` semantics and `sqliteEvidence.finish()` returning `{ rows, statements }` are unchanged.
All-handle attachment before preparation, nested execution counting, iterator consumption, ANALYZE,
bound EQP, declared-index equality/range constraints and empty-plan/control validation are unchanged.
The loader still overlays actual raw observations onto the binding's cost; no missing producer is
filled with zero. Driver changes are solely the stale buffer comment. Its ABI, exports, signatures,
Entry, GroupedRecord, limits, helper logic and converter framing are unchanged.

## Preserved acceptance

All fourteen test names and every business assertion remain byte-for-byte unchanged. In particular:

- `validCost`: every raw value is a nonnegative safe integer, statements positive,
  cross-partition statements exactly zero, buffered rows at most `16 * (8 + 2) = 160`.
- Fixed grouped read: at most 16 statements, returned rows in `[2 + m, 4 * (1 + m)]`, zero row writes.
- Stage of S rows: exactly S row writes; returned rows and statements each at most `8 * S + 16`.
- Enumeration: 193 keys, 13 pages of exactly 16 through the final 1, cap 16/reject 17,
  returned rows at most 128 per page and buffered rows at most 160; exact keys and cursors retained.
- Fixed stage: S = 7, positive storage at most `8 * inputBytes + 4096`, with identical row/byte
  storage at 32/128/512 unrelated keys and historical activity `4 * scale`.
- Child axis: real seed request of 512 unrelated keys and 2048 historical activity, m = 2/4/8,
  reject 9, staging S = m + 5, unchanged `8 * inputBytes + 4096` storage formula.
- Complete validation before publication, durable baseline/reopen, digest/revision sensitivity,
  rights/source attribution, no user data, unsupported/unknown fields, COPY escapes, UTF8,
  unsafe paths and late invalidation controls remain intact. No timeout, scale or ceiling changed.

The actual optional-empty Latin adoption is separate. The title oracle still includes every
non-NULL Latin value, including empty strings. This reconciliation does not silently reconcile
that oracle with the converter's optional-empty behavior. The local two-file correction is also
separate; native store, local tests, converter and fixtures are untouched.

## Remaining unbound cells and decisions

Every one of the fourteen portable cases still needs the real binding. In particular, native
rowWrites, peakBufferedRows and crossPartitionStatements producers are not supplied by this change;
fixture/native converter invocation, commit/baseline publication, reopen/digest/rights controls,
193-key enumeration and both growth series remain unproved through the portable interface.
The existing local store tests are separate evidence, not a factory implementation or portable pass.
No new tests or unbound rerun are appropriate for this contracted summary-only change.

The specific contract exempts root typecheck because shared types and runtime are unchanged.
Only the artifact acceptance is requested:
`bun scripts/worker-check.ts -- test -s docs/research/imports-audit/vndb-portable-counted-costs.md`. It establishes SPEC delivery only.
Scoped formatting is applied once. No files outside the three declared paths are changed.

Read sources: the full fourteen-case portable suite and driver/validator; shared growth counters
and prior growth-bound implementation; native `services/importer/src/vndb-tables.ts`, local
`services/importer/tests/vndb-tables.test.ts` and `vndb-tables-growth.test.ts`; importer README Cost
rows; the client counted-cost audit, optional-Latin acceptance and missing-driver verification
entry point; imports Goal and development workflow. Existing pinned official dump/generator
provenance stays in the driver. No reference-project source or new external research is needed
for this unit substitution, and no upstream evidence is newly claimed.

## File identities and complete code diff

Hashes are SHA-256 of complete source files, before and after this reconciliation. The report
itself is new (no old file); its complete addition is available in the delivery commit.

- `specs/imports-vndb-tables.test.ts`: before `2db4a61d4612e3a358db9fa4ed1460cbfe8ff6396da0f51fc98b1eefb651ca9f`;
  after `97d91eecee9860906c474eb9955253cffe6a04523cb72e5d6c07c48dfd3e98a6`.
- `specs/imports-vndb-tables-driver.ts`: before `d1d12e1e5417ba96279726c25739854141f2d18990e0029619afc3570234b5ec`;
  after `8bbb39e5f2482bd703f1fa1abb97a6426218902b46b4e3ba9e93a42cf852e11f`.

The complete before/after diff for both existing files follows:

```diff
diff --git a/specs/imports-vndb-tables-driver.ts b/specs/imports-vndb-tables-driver.ts
index 28c1db7fdf..50e220213f 100644
--- a/specs/imports-vndb-tables-driver.ts
+++ b/specs/imports-vndb-tables-driver.ts
@@ -49,7 +49,8 @@
  * indexes or INTEGER PRIMARY KEY with an equality/range prefix. No scan, automatic
  * index, temporary sort, OFFSET, whole-state enumeration or historical COUNT.
  * Returned rows count actual get/all/iterate consumption, not examined VM rows.
- * blocks:0 means SQLite buffer counters are unavailable, not zero physical IO.
+ * Actual returned-row/statement counts and bound EQP prove indexed access;
+ * SQLite buffers and physical IO are not measured.
  * Streaming the explicit archive once is O(input bytes), independently asserted.
  * Staging writes equal S, durable bytes <=8*input bytes+4096, buffered rows <=160.
  */
diff --git a/specs/imports-vndb-tables.test.ts b/specs/imports-vndb-tables.test.ts
index 10d2661953..691ae4fb71 100644
--- a/specs/imports-vndb-tables.test.ts
+++ b/specs/imports-vndb-tables.test.ts
@@ -1,7 +1,11 @@
 import { expect, test } from 'bun:test';
 import { readFileSync } from 'node:fs';
 import { checkBatchWrite } from '@rezics/definitions/bulk';
-import { assertGrowth, type GrowthSample } from '../services/kernel/test/support/growth-bound.ts';
+import {
+  type CountedCheck,
+  countedSample,
+  countedViolations,
+} from '../services/kernel/test/support/growth-counters.ts';
 import {
   loadVndbTablesDriver,
   limits,
@@ -149,9 +153,16 @@ function boundedStage(cost: Cost, rows: number) {
   expect(cost.statements).toBeLessThanOrEqual(8 * rows + 16);
   expect(cost.rows).toBeLessThanOrEqual(8 * rows + 16);
 }
-function sample(scale: number, cost: Cost): GrowthSample {
-  // SQLite buffers are unavailable; blocks:0 does not claim zero physical IO.
-  return { scale, cost: { rows: cost.rows, blocks: 0, statements: cost.statements } };
+const sqliteCounts: CountedCheck<Cost> = {
+  read: (cost) => ({ 'sqlite returned rows': cost.rows, 'sqlite statements': cost.statements }),
+  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
+  slack: {
+    'sqlite returned rows': { absolute: 2, relative: 0.1 },
+    'sqlite statements': { absolute: 0, relative: 0 },
+  },
+};
+function sample(scale: number, cost: Cost) {
+  return { scale, counted: countedSample([sqliteCounts.read(cost, scale)]) };
 }
 async function rejected(d: VndbTablesDriver, entries: Entry[]) {
   const before = await Promise.all(['v123', 'v124'].map((key) => d.baseline(key)));
@@ -555,8 +566,8 @@ test('keyset enumeration enforces the fixed page cap and emits each VN exactly o
 });
 
 test('one grouped record uses indexed seeks and constant returned rows and statements at 32 128 and 512 unrelated keys', async () => {
-  const costs: GrowthSample[] = [];
-  const staging: GrowthSample[] = [];
+  const costs: ReturnType<typeof sample>[] = [];
+  const staging: ReturnType<typeof sample>[] = [];
   const storage: Array<{ rows: number; bytes: number }> = [];
   for (const scale of [32, 128, 512]) {
     const d = await loadVndbTablesDriver();
@@ -587,8 +598,8 @@ test('one grouped record uses indexed seeks and constant returned rows and state
   }
   expect(storage[1]).toEqual(storage[0]);
   expect(storage[2]).toEqual(storage[0]);
-  assertGrowth(costs, { rows: 'constant', blocks: 'constant', statements: 'constant' });
-  assertGrowth(staging, { rows: 'constant', blocks: 'constant', statements: 'constant' });
+  expect(countedViolations(sqliteCounts, costs)).toEqual([]);
+  expect(countedViolations(sqliteCounts, staging)).toEqual([]);
 });
 
 test('supported child cardinality grows only with supplied rows through the hard cap and rejects above it', async () => {
```
