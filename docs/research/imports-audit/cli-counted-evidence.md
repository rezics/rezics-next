# CLI counted evidence

This reconciliation replaces the CLI observation's generic `Execution.cost` with the closed
`Execution.counts` fields `sqlite statements` and `sqlite returned rows`. It amends measurement
summaries and their assertions only. The existing real-pipeline wrapper and all 13 portable
scenario names remain unchanged. No product, native Auth or source-statistics file changes.

## Units and decisions

| Observation            | Identity / bound                                                 | Explicit absolute / relative slack |
| ---------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `sqlite statements`    | Exact raw SQL execution count; fixed run constant                | 0 / 0                              |
| `sqlite returned rows` | Exact sum of raw per-execution returned rows; fixed run constant | 2 / 0.1                            |
| `input bytes`          | Actual observed encoded input bytes; streaming linear            | 2 / 0.1                            |
| `input records`        | Actual supplied-record count from real seal; streaming linear    | 0 / 0                              |

The shared `CountedCheck`, `countedSample` and `countedViolations` implement the existing
inequalities with explicit prior tolerances. Each scale has one actual invocation, with no
invented repetitions. The unavailable buffer placeholder is removed; there was no measured
block-like byte unit in this slice to carry a 4 / 0.5 tolerance. SQLite returned rows are
neither examined rows nor PostgreSQL cost.

Missing capture is accepted only when actual observers report no state writes, runner,
key reads, requests, or input activity. Existing help, rejected configuration and missing-file
cases exercise that genuine no-I/O preflight. Otherwise the driver fails instead of supplying
zero proof. A captured empty execution set remains an observation; successful growth still
requires nonempty actual SQL. The producer preserves raw SQL, binds, returned rows and EQP,
verifies plans before closing, and derives both named counts from that same execution set.

The fixed and streaming axes remain 1 / 8 / 64 with fresh SQLite files in `os.tmpdir()`.
At n, the seed creates 4n failed generations with one staged record each under `hot-history`
(4 / 32 / 256), then n unrelated membership keys (1 / 8 / 64), then a refresh with one
survivor and n-1 vanished keys. `hot-history` is a different source from measured Wikidata;
this is not measured-source history growth or an observed count of every physical relation.
The measured Wikidata baseline starts empty. These populations do not close separate hot
population or filtered-list axes, and there is no claimed 4096-row scale.

Streaming supplies n distinct records with the original chunk axis, verifies exactly one
pass, exact encoded bytes and records, peak buffered bytes <=131072 and page records <=100,
and preserves the intentional mass-disappearance exit. Existing handle closure,
diagnostics <=4096 bytes/private redaction, no COUNT/OFFSET, token file and 1..4096-byte
reads, request <=65536-byte/origin/bearer checks, indexed SEARCH prefixes and rejection of
SCAN, automatic indexes and temporary sorts are untouched. This fixture remote proves
client wiring; it establishes no native Auth, PostgreSQL, all-costs or promoted-main proof.

## Sources and scope

Read the full committed remaining-unit inventory directly with
`git show 5c47a835ca8f0804fee95df9bc28a696a5584366:docs/research/imports-audit/remaining-cost-unit-ports.md`;
its source inventory is revision `860ec3c071f213ccd3cd0ad288f7bf0777c20384`.
Also read the CLI producer and portable contract/suite, the unchanged wrapper,
`services/importer/tests/support/sqlite-growth.ts`, shared `growth-counters.ts` and prior
`growth-bound.ts` tolerances, `services/importer/src/cli.ts` preflight/observers,
`services/importer/README.md` CLI and cost sections, and workflow/Goal definitions.
No external reference source or external research was needed for this unit-only port.
A tracked-source caller search found only the driver and portable suite consuming the
exported observation; no additional caller or outside-declared-path change was needed.

## Verification

The required commands were submitted once each after source formatting and a commit:

```sh
bun scripts/worker-check.ts -- bun test services/importer/tests/cli-outcomes.test.ts
bun scripts/worker-check.ts -- bun scripts/typecheck.ts
```

The unchanged wrapper executes the entire portable suite with its real binding, checks its
actual child pass count against source declarations, requires child exit 0 and 0 failures,
and rejects skips/todos. The portable suite is never run unbound. Terminal results are
recorded below; no native Auth or source-statistics suite is rerun.

## Before/after evidence

Baseline: `22ec9cb1cba1989612a0fa1026244930e49a4183`. SHA-256 hashes cover full file bytes before and after formatting.
Each diff below is the complete source diff from that baseline, including the native
binding as well as both reconciled portable files. Context lines use `|` instead of a
space (`git diff --output-indicator-context='|'`) so formatting preserves empty context lines.

### `specs/imports-cli-driver.ts`

Before SHA-256: `da37aa815d5a83f4f77fd1036ba83e4c561ff7375fc780c50f9d3c7354c169f2`

After SHA-256: `66eb7c1a0f2464ec7e7aa12efdf5b7ac4fd4dc1a8cb2fdc85c4c18fc020a831a`

```diff
diff --git a/specs/imports-cli-driver.ts b/specs/imports-cli-driver.ts
index dc2fa338ff..d63ad2e5c5 100644
--- a/specs/imports-cli-driver.ts
+++ b/specs/imports-cli-driver.ts
@@ -2,7 +2,6 @@ import { isAbsolute } from 'node:path';
|import { pathToFileURL } from 'node:url';
|import type { BatchCommand } from '@rezics/definitions/bulk';
|import type { Entry } from './imports-vndb-tables-driver.ts';
-import type { GrowthSample } from '../services/kernel/test/support/growth-bound.ts';
|
|/**
| * TEST ONLY: IMPORT_CLI_DRIVER exports createImportCliDriver({directory, fetch, clock}).
@@ -40,7 +39,7 @@ import type { GrowthSample } from '../services/kernel/test/support/growth-bound.
| * and must never be called by the CLI. baseline is an opaque committed-generation
| * fingerprint; pendingKeys are original durable journal command keys.
| *
- * Cost evidence covers ALL actual forwarded SQLite executions and returned rows,
+ * Counted evidence covers ALL actual forwarded SQLite executions and returned rows,
| * including consumed iterators, transactions and reopened handles. The binding MUST
| * use createSqliteProbe from services/importer/tests/support/sqlite-growth on
| * synchronous real store operations and aggregate its actual samples, calling
@@ -48,9 +47,10 @@ import type { GrowthSample } from '../services/kernel/test/support/growth-bound.
| * EVERY distinct executed statement; reject growing SCAN, TEMP B-TREE, AUTOMATIC
| * indexes; require declared-index/INTEGER PRIMARY KEY SEARCH prefixes. Explicitly
| * classify exact INSERT/control; SELECT/UPDATE/DELETE cannot be exempt by name.
- * blocks:0 means unavailable SQLite buffer measurement, never zero physical IO.
- * seed grows hot failed-run history and unrelated live keys/history with ONE seed
- * at 1,8,64, leaving the measured source baseline empty; it uses real
+ * Named counts report SQLite statements and returned rows, never examined rows or
+ * buffer/physical IO. Missing capture is valid only for observed no-I/O preflight.
+ * seed grows failed runs under a separate hot-history source and unrelated live
+ * keys/history with ONE seed at 1,8,64, leaving the measured source baseline empty; it uses real
| * stores and the same fixture API, outside measured invoke. No fabricated costs.
| * Real HTTP/Auth/PostgreSQL growth is separately proved by imports-api.test.ts;
| * core indexed store/concurrency proof is imports-run-store.test.ts. This suite
@@ -78,7 +78,7 @@ export interface Execution {
|  requests: { url: string; authorization: string | null; bytes: number }[];
|  openHandles: number;
|  input: { bytes: number; passes: number; records: number; peakBufferedBytes: number; maxPageRecords: number };
-  cost: GrowthSample['cost'];
+  counts: { 'sqlite statements': number; 'sqlite returned rows': number };
|}
|export interface CliDriver {
|  invoke(argv: string[], boundaries?: Invocation): Promise<Execution>;
```

### `specs/imports-cli.test.ts`

Before SHA-256: `2fbd6ba7979255d96a61037e06121803f2b85bb04b31677f3e9066c9f95a6dee`

After SHA-256: `51c168bf9898ad11105cf6303a4997e6c74719507331ba981f4da144f09a4707`

```diff
diff --git a/specs/imports-cli.test.ts b/specs/imports-cli.test.ts
index c5f593e379..8c3159886d 100644
--- a/specs/imports-cli.test.ts
+++ b/specs/imports-cli.test.ts
@@ -9,7 +9,12 @@ import {
|  type BatchWriteRequest,
|  type BatchWriteResult,
|} from '@rezics/definitions/bulk';
-import { assertGrowth, type GrowthSample } from '../services/kernel/test/support/growth-bound.ts';
+import {
+  countedSample,
+  countedViolations,
+  type CountedCheck,
+  type CountedSample,
+} from '../services/kernel/test/support/growth-counters.ts';
|import {
|  exit,
|  loadCliDriver,
@@ -208,9 +213,10 @@ class Harness {
|    expect(result.openHandles).toBe(0);
|    expect(encode(result.stdout + result.stderr).length).toBeLessThanOrEqual(4096);
|    for (const marker of markers) expect(result.stdout + result.stderr).not.toContain(marker);
-    expect(result.cost.statements).toBe(result.sql.length);
-    expect(result.cost.rows).toBe(result.sql.reduce((sum, statement) => sum + statement.rows, 0));
-    expect(result.cost.blocks).toBe(0); // SQLite buffers unavailable.
+    expect(result.counts).toEqual({
+      'sqlite statements': result.sql.length,
+      'sqlite returned rows': result.sql.reduce((sum, statement) => sum + statement.rows, 0),
+    });
|    for (const statement of result.sql) expect(statement.sql).not.toMatch(/\bCOUNT\s*\(|\bOFFSET\b/i);
|    for (const request of result.requests) {
|      expect(new URL(request.url).origin).toBe(origin);
@@ -493,8 +499,27 @@ test('overlapping same-source invocations report busy while a different source r
|
|test('fixed changes retain indexed bounded costs across three state scales and streaming stays proportional to supplied bytes', async () => {
|  await scenario(async (h) => {
-    const fixed: GrowthSample[] = [];
-    const streaming: GrowthSample[] = [];
+    const fixedCheck: CountedCheck = {
+      read: (result) => (result as Execution).counts,
+      bounds: { 'sqlite statements': 'constant', 'sqlite returned rows': 'constant' },
+      slack: {
+        'sqlite statements': { absolute: 0, relative: 0 },
+        'sqlite returned rows': { absolute: 2, relative: 0.1 },
+      },
+    };
+    const streamingCheck: CountedCheck = {
+      read: (result) => {
+        const { input } = result as Execution;
+        return { 'input bytes': input.bytes, 'input records': input.records };
+      },
+      bounds: { 'input bytes': 'linear', 'input records': 'linear' },
+      slack: {
+        'input bytes': { absolute: 2, relative: 0.1 },
+        'input records': { absolute: 0, relative: 0 },
+      },
+    };
+    const fixed: { scale: number; counted: CountedSample }[] = [];
+    const streaming: { scale: number; counted: CountedSample }[] = [];
|    for (const scale of [1, 8, 64]) {
|      h.state = resolve(h.directory, `scale-${scale}.sqlite`);
|      await h.driver.seed(h.state, scale);
@@ -512,7 +537,7 @@ test('fixed changes retain indexed bounded costs across three state scales and s
|          expect(statement.plan.length).toBeGreaterThan(0);
|        }
|      }
-      fixed.push({ scale, cost: result.cost });
+      fixed.push({ scale, counted: countedSample([fixedCheck.read(result, scale)]) });
|      const text = Array.from({ length: scale }, (_, i) => record('wikidata', 'Streaming title', 100 + i)).join('');
|      const stream = await h.run('wikidata', { stdin: chunks(text, scale) });
|      // A disjoint snapshot intentionally trips mass protection after the streaming pass.
@@ -520,9 +545,9 @@ test('fixed changes retain indexed bounded costs across three state scales and s
|      expect(stream.input).toMatchObject({ bytes: encode(text).length, records: scale, passes: 1 });
|      expect(stream.input.peakBufferedBytes).toBeLessThanOrEqual(65536 * 2);
|      expect(stream.input.maxPageRecords).toBeLessThanOrEqual(100);
-      streaming.push({ scale, cost: { rows: stream.input.bytes, statements: stream.input.records, blocks: 0 } });
+      streaming.push({ scale, counted: countedSample([streamingCheck.read(stream, scale)]) });
|    }
-    assertGrowth(fixed, { rows: 'constant', statements: 'constant', blocks: 'constant' });
-    assertGrowth(streaming, { rows: 'linear', statements: 'linear', blocks: 'constant' });
+    expect(countedViolations(fixedCheck, fixed)).toEqual([]);
+    expect(countedViolations(streamingCheck, streaming)).toEqual([]);
|  });
|});
```

### `services/importer/tests/cli-driver.ts`

Before SHA-256: `65deb2ae77dbf677fdce913358412c2adfb609d0889f4126fb17b44deef103be`

After SHA-256: `f34e2be95c4df8c378599c53b4a1608587f09e696b47d36b6ec49bdca6a71a7f`

```diff
diff --git a/services/importer/tests/cli-driver.ts b/services/importer/tests/cli-driver.ts
index 9383cba198..c52af06efd 100644
--- a/services/importer/tests/cli-driver.ts
+++ b/services/importer/tests/cli-driver.ts
@@ -27,7 +27,7 @@ type SqliteCapture = {
|  database: Database;
|  start(): void;
|  attachCoordinator(importer: Parameters<NonNullable<ImportCliObserver['onCoordinator']>>[0]['importer']): void;
-  finish(): { sql: Execution['sql']; cost: Execution['cost'] };
+  finish(): { sql: Execution['sql']; counts: Execution['counts'] };
|};
|
|function createSqliteCapture(database: Database): SqliteCapture {
@@ -37,7 +37,7 @@ function createSqliteCapture(database: Database): SqliteCapture {
|  let verified = false;
|  let verificationFailure: unknown;
|  const statementProxies = new WeakMap<object, object>();
-  let cachedFinish: { sql: Execution['sql']; cost: Execution['cost'] } | undefined;
+  let cachedFinish: { sql: Execution['sql']; counts: Execution['counts'] } | undefined;
|
|  const measure = <T>(operation: () => T): T => {
|    if (!enabled || depth > 0) return operation();
@@ -149,10 +149,9 @@ function createSqliteCapture(database: Database): SqliteCapture {
|        }));
|        cachedFinish = {
|          sql,
-          cost: {
-            statements: sql.length,
-            rows: sql.reduce((sum, statement) => sum + statement.rows, 0),
-            blocks: 0,
+          counts: {
+            'sqlite statements': sql.length,
+            'sqlite returned rows': sql.reduce((sum, statement) => sum + statement.rows, 0),
|          },
|        };
|      }
@@ -366,6 +365,15 @@ export async function createImportCliDriver(options: Options): Promise<CliDriver
|      active.delete(pending);
|    }
|    const evidence = capture?.finish();
+    if (
+      !evidence &&
+      (fileWrites.size > 0 ||
+        runners.length > 0 ||
+        tokenReads.length > 0 ||
+        requests.length > 0 ||
+        Object.values(input).some((value) => value !== 0))
+    )
+      throw new Error('Missing SQLite capture outside observed no-I/O preflight');
|    return {
|      code: result.code,
|      stdout: result.stdout,
@@ -377,7 +385,8 @@ export async function createImportCliDriver(options: Options): Promise<CliDriver
|      requests,
|      openHandles: result.openHandles,
|      input,
-      cost: evidence?.cost ?? { rows: 0, statements: 0, blocks: 0 },
+      // Only the observed no-I/O preflight above can have no capture.
+      counts: evidence?.counts ?? { 'sqlite statements': 0, 'sqlite returned rows': 0 },
|    };
|  };
|
```

Unchanged wrapper SHA-256 (before and after): `10a3dc095365f8a94582e424961407d61cf62f75017f79cd24a05bb9622993ed`.

All 13 scenario names are byte-for-byte unchanged:

- help is bounded and touches no network state or token even with nonexistent paths
- configuration rejects unknown source extra option bad threshold missing paths and unsafe origins before effects
- missing dump and account key files reject before state writes and network access
- redirects cannot downgrade or disclose the bearer to another origin
- every native source runs its independent real converter decoder and durable state with bounded counters
- file input explicit source alias reopen and changed bytes use the real runner without duplicate effects
- late malformed and truncated streams publish no earlier proposals or checkpoint
- mass disappearance has a dedicated nonzero exit and preserves the complete baseline
- 401 and 403 fail safely without anonymous fallback and token rotation is read at request boundaries
- 429 follows production Retry-After and bounded retry exhaustion rather than silent acceptance
- abort after durable preparation closes handles and replays original journal keys on rerun
- overlapping same-source invocations report busy while a different source remains runnable
- fixed changes retain indexed bounded costs across three state scales and streaming stays proportional to supplied bytes

## Terminal results

The focused wrapper ran at committed revision `372d553019` and exited 1:

```text
bun test v1.4.4-canary.1 (a0cc096ce)

services/importer/tests/cli-outcomes.test.ts:
killed 1 dangling process
(fail) all import CLI outcomes pass with real source pipeline [120030.41ms]
  ^ this test timed out after 120000ms.

 0 pass
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [120.05s]
```

Local complete log: `.temp/goal/checks/worker-check-2026-10-29T13-32-33.925Z-9c3cf4af.log`.
The wrapper did not return its child's output before its unchanged timeout, so none of the
13 child results is claimed as passing. There was no runtime rerun or timeout/host change.
Subsequent source review corrected only the reader parameter annotations to the shared
`CountedCheck` default (`unknown`, narrowed to `Execution`); this erases to the same runtime
JavaScript. The full diffs and hashes above describe that final source, not an earlier variant.
Root typecheck exited 0. It waited 550.412 seconds for its slot, then transferred the
worktree after the final reader correction was committed as `f7ea9f8a03` and ran all
13 workspace typechecks. The remote command completed in 75.151 seconds; no rerun or
infrastructure error was reported. Its terminal result was:

```text
check: exit status 0
check: log .temp/goal/checks/worker-check-2026-10-29T13-32-57.734Z-83a88bd7.log
```

The focused wrapper terminal result was:

```text
check: exit status 1
check: failure summary
(fail) all import CLI outcomes pass with real source pipeline [120030.41ms]
1 fail
check: log .temp/goal/checks/worker-check-2026-10-29T13-32-33.925Z-9c3cf4af.log
```

Both recorded checks are terminal; none remains running. Acceptance remains unproved
because the existing wrapper timed out. No passing base result is claimed, and no
business or timeout policy was changed to force a pass. The only subsequent changes
are this evidence record. No files outside the four declared paths changed.
