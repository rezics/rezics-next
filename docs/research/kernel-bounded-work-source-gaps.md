# Kernel bounded work: native work discovery

One repair class is ready for the kernel Work/SDK owner: **bounded results do not bound native workflow discovery**.
The mounted retention selector can examine growing completion/creation history before returning 1,000 IDs. The
mounted partitioned queue selector enumerates active keys before returning the worker's available slots; Commerce
puts one key per Checkout Session on that queue. Version filtering also permits a history walk within one hot key.
These are discovery costs, independent of the number of workflows actually deleted or started.

This is a source specification for Performance and the owning module managers. All execution is **UNRUN**:
no acceptance, compiler, native database, timing, capture, migration or installation was performed. Code below is
frozen acceptance **design**, not delivered tests, a passing result, or physical proof. Only this report changed.

## Source boundary

All repository citations refer to revision **`82cc706583ac96d998bac2dc01967d904cd6c881`**, including
[architecture](../architecture.md), the [Performance outcome](../goals/performance.md), the kernel
[cost derivations](../../services/kernel/README.md#cost), and the files linked below. The architecture's
multiversion-visibility exclusion applies: none of the findings depends on invisible versions, dead tuples, vacuum
lag, transaction overlap or an engine maintenance failure. Fixtures use ordinary visible committed rows.

The lockfile and [workspace manifest](../../services/kernel/package.json) pin DBOS `5.5.3-preview`, with the
[repository patch](../../patches/@dbos-inc%252Fdbos-sdk@5.5.3-preview.patch). Installed source was read, not executed.
For reproducible citations, `SDK/` below means
`services/kernel/node_modules/@dbos-inc/dbos-sdk/dist/src/`; installed bytes have these SHA-256 pins:

| Source                                        | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `SDK/system_database.js`                      | `7f8acb0c80120ad0afa59e7848bbebbfcae5d3f0754d459764b923c1b0343f2b` |
| `SDK/sysdb_migrations/internal/migrations.js` | `d187c8a19e4c3141392c73701899ca0005155febdabdfde481bf5782fe61daff` |
| `SDK/wfqueue.js`                              | `9be7bd806fb41bbb73d87b848a2c8ac1cb8bc8e615c6cadd7158bffb8b0698c5` |
| Repository SDK patch                          | `16f393956300e03b04794ec58058c98f6398bcac7d55fdbd68a6f8b84c359806` |

Supporting SDK source read: `client.js`, `dbos.js`, `system_database.d.ts`, `serialization.d.ts`, `wfqueue.d.ts`,
`telemetry/logs.d.ts`, and the package manifest. Installed source presence is an observation of these bytes, not a
dependency-completion receipt or evidence that migrations ran in a deployment.

The [Work README](../../services/kernel/src/work/README.md) names reference source. Read the exact read-only
`/home/edge/projects/rezics/rezics-next/.reference/INDEX.md` and
`search-worker-outcome-harness/dbos-transact-ts/src/{system_database,client,dbos,dbos-executor}.ts` under that
directory, revision **`980dc55095f445b189aecb59e7f3334345179f65`**. The reference confirms the list/deletion
delegation and creation/completion filtering surface; the installed patched bytes above determine this report's
runtime claims. No external documentation or third-party execution was needed.

## Coverage and dispositions

Here `H` is workflow/outbox history in the relevant relation, `P` active queue keys, `w` available worker slots,
`d` selected workflows, `c` their actually changed child rows, `b` envelopes and `k` events per envelope.
All row widths, configuration and operation inputs stay fixed while unrelated history grows.

| Surface inspected                 | Source result and evidence boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command execution and receipts    | [`runCommand`](../../services/kernel/src/command/command.ts) authorizes before receipt lookup, uses the full partition/principal/kind/key anchor in [`read-receipt.sql`](../../services/kernel/src/command/read-receipt.sql), then one partition fence and `k <= 1,000` event writes in [`fence.sql`](../../services/kernel/src/command/fence.sql). Hit, digest conflict and denied replay do not execute the body; a miss adds change-proportional work. At fixed key-ring size, `O(1+k)` rows and `O((1+k) log H)` indexed blocks per attempt remain the source shape. [`growth-command.test.ts`](../../services/kernel/test/growth-command.test.ts) covers new/replay/denial/contention; [`growth-command-wait.test.ts`](../../services/kernel/test/growth-command-wait.test.ts) covers waiting. Retry count follows the deadline/contention, not a history enumeration.                                                                                                                                                                                          |
| Admission and write rate          | [`Admission`](../../services/kernel/src/http/admission.ts) scans at most its configured queue (default 32; 8 normal plus 2 reserved permits); [`enterCommandGate`](../../services/kernel/src/command/gate.ts) has at most 64 waiters per partition. [`app.ts`](../../services/kernel/src/http/app.ts), [`write-rate-stage.ts`](../../services/kernel/src/access/write-rate-stage.ts), [`write-rate.ts`](../../services/kernel/src/access/write-rate.ts) and [`write-rate-counter.sql`](../../services/kernel/src/access/write-rate-counter.sql) lead to a routed identity/family upsert plus exact authenticated account/deletion-barrier probes. Expiry uses ordered route/expiry selection and exact locked TIDs, at most 1,000 counters/chunks combined in [`write-rate-expiry.sql`](../../services/kernel/src/access/write-rate-expiry.sql). Accounts owns native authorization/rate semantics and its `test/access/growth-write-rate*.test.ts`; no substitute Accounts contract is proposed.                                                                    |
| Anchored reads and keysets        | [`readPartition` / `readPartitions`](../../services/kernel/src/partition/partition.ts), [`partitionReadClients`](../../services/kernel/src/database/read-snapshot.ts), and [`withReadTransaction`](../../services/kernel/src/semantic/read.ts) bind exact homes in one physical snapshot. Fixed full-key sets give `O(q)` rows and `O(q log H)` blocks, including misses; moved homes refuse. [`subjectRoutes`](../../services/kernel/src/semantic/http/subjects.ts), mounted by [`createKernel`](../../services/kernel/src/http/kernel.ts), delegates actual subject/related/list hydration and disclosure to Semantic. The legacy [`pageSubjects`](../../services/kernel/src/semantic/page.ts) helper seeks `(route, subject_id)` and returns `size+1`, but is not called by current `subjectRoutes`: the cursor growth test's helper invocation is not mounted-list evidence. Native labels, candidates, links and disclosure remain Semantic's contract. No source defect follows merely from deferred owner proof.                                              |
| Session headers and cursor codecs | [`app.ts`](../../services/kernel/src/http/app.ts) decodes once, merges through [`session.ts`](../../services/kernel/src/tokens/session.ts) and retains 32 components. [`seal.ts`](../../services/kernel/src/tokens/seal.ts) rejects decode tokens over 4,096 characters; direct merge validates its supplied array, and encoding is not universally byte-capped. [`cursor.ts`](../../services/kernel/src/tokens/cursor.ts) permits eight after-keys but sorts binding parameter names and processes supplied string bytes. Their CPU follows input bytes/configuration, with zero SQL; this is not database-history growth. [`list-cursor.ts`](../../services/kernel/src/tokens/list-cursor.ts) has explicit profile-specific byte limits. [`growth-request.test.ts`](../../services/kernel/test/growth-request.test.ts) measures SQL, not a universal CPU bound; its `j` case holds database population fixed and its admission case calls health. These limitations do not create an additional repair class.                                                      |
| Outbox and relay                  | [`read-log.sql`](../../services/kernel/src/events/read-log.sql) generates at most 64 positions and probes `outbox_pkey` at those positions, with at most 1,000 events each. [`log.ts`](../../services/kernel/src/events/log.ts) preserves epoch, gaps, sequence and minimized markers; [`projectBatch`](../../services/kernel/src/events/log.ts) releases its snapshot before apply and compare-and-set advancement. [`scan-partitions.sql`](../../services/kernel/src/events/scan-partitions.sql) visits the fixed 4,096-home map and each next-envelope key, not outbox history. [`startRelays`](../../services/kernel/src/events/relays.ts) drains bounded batches; total drain work legitimately follows backlog. [`growth-events.test.ts`](../../services/kernel/test/growth-events.test.ts), [`growth-projection.test.ts`](../../services/kernel/test/growth-projection.test.ts) and [`relay-effects.test.ts`](../../services/kernel/test/relay-effects.test.ts) target these shapes, including deep positions, full batches and empty/busy/lost-CAS outcomes. |
| Effect registration and callbacks | [`registerEffects`](../../services/kernel/src/events/effects.ts) rejects a 33rd matching consumer per event type, counting duplicate types once. Both native admission and durable enqueue therefore have matching fanout at most 32 per event; total registration/type-list CPU is configuration-dependent. Deterministic workflow IDs, source-slot dispositions, position/event order and separate locator work are preserved. Completion uses unique workflow ID indexes in the schema. Native admission/run callbacks retain their actual owners: Accounts/History, Content, Semantic, Commerce, etc. Their native work is additional; a function type alone proves no callback bound. The queue discovery finding below concerns SDK scheduling, not an invented unbounded registration fanout.                                                                                                                                                                                                                                                                 |
| Work status and steps             | [`createWorkClient`](../../services/kernel/src/work/client.ts), `SDK/client.js` and `SDK/system_database.js:getWorkflowStatus/getAllOperationResults` use exact workflow identity and keyed step rows for ordinary fixed-limit reads. `OFFSET`/page inputs and returned step count are separate input axes. [`growth-work-client.test.ts`](../../services/kernel/test/work/growth-work-client.test.ts) distinguishes the ordinary fixed-page case from the legacy Realm-leave JSON join. That compatibility fallback explicitly allows linear history and is already assigned separate design research: no duplicate task here.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Work scheduling and retention     | [`startWorker`](../../services/kernel/src/worker.ts) passes the same native pool to Work and DBOS; [`composeWork`](../../services/kernel/src/work/registry.ts) persists the queue configuration before launch. All seven queues currently have worker concurrency limits, summing to **34**, including `workflows: 8`. Worker concurrency bounds starts, not discovery. The two manifestations below belong to one native discovery repair class.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Stale documentation, not product defects: the kernel README's final claim that effects have no fanout cap and its
`workflows` unbounded-concurrency/18-total description contradict current source. Even
[`work-queues.test.ts`](../../services/kernel/test/work-queues.test.ts)'s old title mentions an exception while its
assertion now expects no unbounded queue. This report does not edit those files. The README's qualified session
and cursor encoding statements are accurate. The growth harness numerical/classifier review is independently
owned and is excluded; missing native execution evidence is not a source failure.

## One complete repair class: native eligible-work discovery

**Owner:** kernel Work/DBOS producer, coordinated by Performance. Commerce owns its Session serialization and
financial behavior; Accounts, Content and Semantic retain their callbacks and native contracts. The common cause
is applying eligibility, ordering or random selection across an expanding relation before the bounded result is
known. Repair discovery and its SDK-owned derived access paths together, rather than adding independent consumer
workarounds. No new public API, queue, budget, deployment placement or authority is adopted here.

### Retention: creation order and completion eligibility diverge

Pinned caller chain:
[`KERNEL_WORK_MODULES`](../../services/kernel/src/work/modules.ts) always includes
[`workflowRetentionWorkModule`](../../services/kernel/src/work/retention.ts), which schedules
`kernel.workflowRetention` every ten minutes on `maintenance`. `runWorkflowRetentionSweep` fixes one `now`, runs
at most 60 batches and stops at a short deletion batch. `runWorkflowRetentionBatch/listInput` asks the SDK for:

```sql
-- SDK/system_database.js:#listWorkflows, lines 3808–4040, normalized parameters.
SELECT /* status fields, no input/output joins */ ...
FROM dbos.workflow_status
WHERE (application_name = ANY(ARRAY['rezics-kernel']) OR application_name IS NULL)
  AND status IN ('SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED')
  AND completed_at <= :cutoff_minus_one_ms
  AND created_at <= :cutoff_minus_one_ms
ORDER BY created_at ASC
LIMIT 1000;
```

The caller rechecks terminal/completion eligibility and deletes those IDs with `deleteWorkflows(ids, false)`.
Default retention is 30 days; configured integer periods 7–365, strict cutoff and application/unclaimed ownership
must survive. `SDK/sysdb_migrations/internal/migrations.js` supplies separate
`workflow_status_created_at_index(created_at)` and partial `idx_workflow_status_completed_at(completed_at)`;
the later in-flight/failed indexes do not cover arbitrary SUCCESS retention selection.

**Source counterexample:** in this same database/application, seed `H` SUCCESS workflows created 400 days ago but
completed yesterday, and `H` SUCCESS workflows created 200 days ago and completed 90 days ago. Keep row widths,
the selected earliest 1,000 eligible rows, deletion fanout and cutoff fixed as both histories grow. All rows satisfy
`created_at < cutoff`; only the second group satisfies completion eligibility. A creation-ordered index walk must
reject the `H` earlier noneligible rows. A completion-index selection must consume/sort the `H` eligible rows to
find the first creation-ordered 1,000. A full scan also follows `H`. A top-N sort saves output memory, not input
examination. This is visible logical work, even with no concurrent writers. Timeout/refusal is not successful
bounded retention.

**Existing oracle:** [`test/work/growth-retention.test.ts`](../../services/kernel/test/work/growth-retention.test.ts),
“a short retention batch stays bounded as retained workflow history grows”, grows long-lived/recent histories but
keeps only ten eligible rows, making the completion-index route selective. Its “one retention batch stays bounded
as retained and recent workflow history grow” grows eligible old history but places its warm-up and measured
1,000-row groups at creation age 401 days, before the age-400 history. The creation-index route can stop at that
prefix. Neither combines an older **ineligible** prefix with a growing later **eligible** backlog. Rows equal
across scales on these fixtures do not establish the conjunction/order bound.

Deletion itself is not a new scan finding: `SDK/system_database.js:deleteWorkflowsInternal` deletes exact IDs from
input/output/operations/status and uses native child cascades. Its work is `O(d+c)` changed rows and indexed
probes, not universally `O(d)` when a selected workflow has more child history. The current growth fixture has
status rows only; [`retention.test.ts`](../../services/kernel/test/work/retention.test.ts) separately checks all
eight owned row kinds. Preserve those deletions, `deleteChildren=false`, permanent writer fences and owner
custody. Do not remove children/compatibility to make the discovery test pass or transplant the scoped writer-
retirement execution limits into all historical workflows.

### Queue discovery: active Session keys and version history

Pinned implementation: `SDK/wfqueue.js:pollQueue` lines 672–693 takes the batched path for
`partitionConcurrency=1` without global/rate limits, passing `workerBudget` to
`SDK/system_database.js:findAndMarkStartablePartitionedWorkflows` lines 3600–3760. The candidate query recursively
walks every distinct ENQUEUED partition key, excludes keys with a PENDING owner, then performs
`ORDER BY random() LIMIT min(8192,maxTasks)` whenever the worker budget is below 8,192. Its lateral head probe
applies current-version eligibility **after** choosing keys. `8192` limits returned candidates, not recursive
seeks, pending probes or sort input.

**Actual mounted impact:** generic effect keys are `${effect.name}:${partition}` and thus at most the fixed
configured registration count times 4,096. That fixed fanout alone is not a growing-population defect. However,
[`commerceWorkModule`](../../services/kernel/src/commerce/work-module.ts) installs
[`createCommerceWork`](../../services/kernel/src/commerce/work.ts) when the existing commerce settings are
enabled. Its `sync` and legacy `applyCheckout` enqueue `commerce.checkoutSync` on **the same `effects` queue**.
[`checkoutPartitionKey`](../../services/kernel/src/commerce/work-contract.ts) includes provider namespace, live/test
mode and the actual Session ID. Distinct sessions therefore create arbitrarily many active keys at fixed worker
configuration. With Commerce disabled this Session-key manifestation is not mounted; do not claim it universally.
[`test/commerce/work.test.ts`](../../services/kernel/test/commerce/work.test.ts) explicitly requires the
Session-partitioned refresh. Hashing/coalescing sessions into kernel home buckets would change this contract.

**Source counterexamples, same class:**

- With `P` ready Session keys and one free worker slot, the recursive walk and random sort consume `P` keys to
  start one workflow. With one PENDING owner and one queued follower per Session, it examines `P` keys and pending
  probes to start **zero** workflows. These rows are live unrelated backlog, not terminal/MVCC history.
- Within one fixed key, put `H` earlier ENQUEUED workflows of another application version before one compatible
  head, or before no compatible head. The native index
  `idx_workflow_status_partition_dequeue_v3(queue_name,status,queue_partition_key,priority,created_at,workflow_uuid)`
  includes application ownership but does not key version. `headOf` filters version while walking that key's
  history before its `LIMIT 1`. This also affects fixed generic effect keys across versioned deployments. The
  nonpartitioned `findAndMarkStartableWorkflows/claimStartableWorkflows` (lines 3381–3599) uses the same residual
  version eligibility before its ordered limit through `idx_workflow_status_in_flight_v2`, also without a version
  key. `wfqueue.js:pollQueue` calls this branch for the mounted nonpartitioned queues, including `workflows`
  (Commerce's Stripe-event/reconcile parents) and `maintenance` (retention). Include it in the same repair and
  caller inventory, rather than fixing only partitioned queues.

**Existing oracle:** [`growth-effects.test.ts`](../../services/kernel/test/growth-effects.test.ts) grows SUCCESS
workflow/input/output/step history, which is absent from the partial in-flight index; it does not grow queued
Session-key cardinality, busy keys or incompatible ENQUEUED version prefixes. Its enqueue capture and keyed
persistence assertions do not bound every independent poll's discovery work. The kernel README explicitly
allows dequeue work linear in distinct active keys, despite bounding returned claims. The Commerce work and
Session-refresh suites test ordering/convergence on small populations, not these growth axes. The Work-client
and retention suites exercise different SDK calls. None supplies the missing queue oracle.

### Complete owner change and dependency boundary

One assignment must include the following connected surfaces; none requires changing native consumer authority:

1. Fix SDK-owned retention **and** queue eligibility discovery and every affected ordered/versioned head selector.
   Indexes/derived scheduling metadata must be maintained by all original SDK writers: transactional and ordinary
   enqueue, claim/completion, delay activation, resume/recovery/rewind, cancellation, version/application assignment
   and deletion. A caller's returned limit, timeout or fairness shuffle cannot stand in for bounded examination.
2. Keep the existing kernel Work adapters, default module registration and Commerce Session caller on the repaired
   native path. Preserve deterministic IDs/reuse, input compatibility, queue configuration and per-Session mutual
   exclusion. Keep exact admission locks/rechecks through claims, owner tokens and permanent writer fences.
3. Put any physical access-path changes in an additive SDK-owned migration/patch, preserving existing positional
   migration versions and old data. Existing workflows, null-version/unclaimed rows and old SDK writers must stay
   compatible. Any needed backfill is bounded/resumable and cannot become an unbounded startup step or a second
   source of eligibility truth. Installation and migration execution are later integration obligations.
4. Add the frozen designs below as new owner acceptance suites, retain all existing acceptance unchanged, and
   correct the affected README derivations/titles in the implementation class. Performance supplies the existing
   harness; no numerical-integrity/classifier changes are part of this class.

**Required cross-owner decisions before an algorithm changes semantics:** Work/SDK and Commerce must adopt the
fairness behavior of any replacement for exhaustive random key selection while preserving Session serialization
and eventual progress. Work must explicitly preserve creation-ordered eligible retention or adopt an owner
decision before changing it; completion order is not an authorized shortcut. If bounded traversal introduces
continuations, the Work owner must define persistence, restart/version behavior and how incomplete discovery
differs from an empty/short terminal batch. The existing sweep's `removed < 1000` exit must never silently strand
later work. This report freezes the current externally relevant outcomes and exposes these decision boundaries;
it does not choose a new scheduler, allowance, retention policy or authoritative membership store.

No Accounts/Content/Semantic implementation is a prerequisite for the source counterexamples: they use native
SDK fixture rows and the real Work/Commerce caller identities. Their owning acceptance remains required when an
integration touches their callbacks; absence of deferred native proof is not itself a new defect.

## Frozen acceptance designs — all UNRUN

Materialize these in new `test/work/growth-discovery-retention.test.ts` and
`test/work/growth-discovery-queues.test.ts` in the later implementation assignment. The snippets name existing
APIs, not proposed product APIs. Preserve original scales/physical populations: retention uses **49,152 rows per
axis × [1,4,16]**, and queue designs use **16 rows/keys per unit × [256,1024,4096]**, matching the existing effect
history scale. Seed and replenish outside capture, keep payload/ID widths fixed, settle through the shared
harness, and measure the actual SDK SQL on the supplied instrumented pool. Do not pin planner methods. Keep
discovery occurrences separate from deletion/dispatch while also retaining inclusive operation totals.

### Retention inversion reproducer

The following is the essential complete fixture/operation design, composed with the existing growth suite's
`openGrowthDatabase`, `createWorkClient`, teardown and migrated test-database lifecycle. `db` is that database and
`client` is `createWorkClient(databaseUrl, db.pool)`; no executor/provider is needed. Its current source is expected
to violate bounded examined work, not necessarily any particular plan-node choice.

```ts
import { expect, test } from 'bun:test';
import { runWorkflowRetentionBatch } from '../../src/work/retention.ts';
import { checkGrowth } from '../support/growth.ts';

const day = 86_400_000;
const now = new Date();
const root = `retention-inversion:${crypto.randomUUID()}:`;

async function put(group: string, count: number, createdAge: number, completedAge: number) {
  await db.admin.query(
    `
    INSERT INTO dbos.workflow_status
      (workflow_uuid,status,name,authenticated_roles,recovery_attempts,
       created_at,updated_at,completed_at,application_name)
    SELECT $1 || lpad(n::text,8,'0'), 'SUCCESS','retention.growth.fixture','[]',0,
           $2::bigint+n,$3::bigint+n,$3::bigint+n,'rezics-kernel'
    FROM generate_series(1,$4::int) n`,
    [root + group + ':', +now - createdAge * day, +now - completedAge * day, count],
  );
}

test('retention discovery is bounded with an older ineligible prefix and growing eligible backlog', async () => {
  await checkGrowth(db, {
    name: 'completion-inverted retention discovery',
    rule: 'series',
    scales: [1, 4, 16],
    repetitions: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    // Preserve the original full deletion-batch index-descent allowance.
    indexProbes: 4000,
    async grow(_db, scale) {
      await db.admin.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [root + '%']);
      await put('retained', 49_152 * scale, 400, 1);
      await put('eligible-backlog', 49_152 * scale, 200, 90);
      await put('warmup', 1000, 202, 90);
    },
    async warmup() {
      expect(await runWorkflowRetentionBatch(30, client, now)).toBe(1000);
    },
    async prepare() {
      await put('probe', 1000, 201, 90);
    },
    async operation() {
      expect(await runWorkflowRetentionBatch(30, client, now)).toBe(1000);
      // Assertions through admin are outside measured SQL, as in existing fixtures.
      expect(
        (await db.admin.query('SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [root + 'probe:%']))
          .rowCount,
      ).toBe(0);
    },
  });
});
```

Also retain native occurrence plans for the list statement: its own examined rows must be `O(1+d)`, blocks
`O((1+d) log H)` and statement count constant at fixed `d`; an aggregate delete allowance cannot conceal a
history-dependent list. Repetitions/cleanup must use fresh probes if increased. Fixture control rows created by
native writer guards remain in the isolated test database until normal teardown; never prune global fences.

### Queue discovery reproducer

Use a test-only native SDK handle over `db.pool`, with no executing workflow bodies or free-running poller:

```ts
import { SystemDatabase } from '@dbos-inc/dbos-sdk/internal/system_database';
import { WorkflowQueue } from '@dbos-inc/dbos-sdk/internal/wfqueue';
import { DBOSJSON } from '@dbos-inc/dbos-sdk/internal/serialization';
import { GlobalLogger } from '@dbos-inc/dbos-sdk/internal/telemetry/logs';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { WORK_APPLICATION } from '../../src/work/client.ts';

const logger = new GlobalLogger();
const native = new SystemDatabase(
  databaseUrl,
  logger,
  DBOSJSON,
  10,
  db.pool,
  'dbos',
  false,
  undefined,
  undefined,
  WORK_APPLICATION,
);
const effects = new WorkflowQueue(WorkflowQueue.recordFromParams('effects', WORK_QUEUES.effects));
const workflows = new WorkflowQueue(WorkflowQueue.recordFromParams('workflows', WORK_QUEUES.workflows));
// No DBOS launch/init or runtime dispatcher is needed for this native statement probe.
// Finally destroy the handle/logger and close the GrowthDatabase; do not end a foreign pool.
```

The fixture below pins each logical key to the real Commerce key encoder, not a made-up generic-effects shape.
Compose with `checkGrowth`, `expect`, `checkoutPartitionKey` and the lifecycle/imports used above.

```ts
const root = `queue-discovery:${crypto.randomUUID()}:`;
const workflowId = (id: string) => root + id.padEnd(24, '_');
const provider = { accountNamespace: 'acct_growth', livemode: false };
const sessionKey = (n: number) => checkoutPartitionKey(provider, `cs_test_${String(n).padStart(8, '0')}`);

async function queued(
  id: string,
  queueName: string,
  key: string | null,
  status: 'PENDING' | 'ENQUEUED',
  version: string,
  n: number,
) {
  await db.admin.query(
    `INSERT INTO dbos.workflow_status
    (workflow_uuid,status,name,queue_name,queue_partition_key,application_name,application_version,
     authenticated_roles,recovery_attempts,priority,created_at,updated_at)
    VALUES ($1,$2,'commerce.checkoutSync',$3,$4,'rezics-kernel',$5,'[]',0,0,$6,$6)`,
    [workflowId(id), status, queueName, key, version, 1_700_000_000_000 + n],
  );
}

for (const selector of ['partitioned', 'nonpartitioned'] as const) {
  for (const axis of ['keys-hit', 'keys-busy-miss', 'hot-version-hit', 'hot-version-miss'] as const) {
    if (selector === 'nonpartitioned' && !axis.startsWith('hot-')) continue;
    test(`one native queue discovery stays bounded: ${selector}/${axis}`, async () => {
      const queueName = selector === 'partitioned' ? 'effects' : 'workflows';
      const key = (n: number) => (selector === 'partitioned' ? sessionKey(n) : null);
      // One free slot is a real worker state. Exercise production-called SDK methods.
      const claim = () =>
        selector === 'partitioned'
          ? native.findAndMarkStartablePartitionedWorkflows(
              effects,
              'growth-discovery',
              'live-version',
              1,
              crypto.randomUUID(),
              true,
            )
          : native.findAndMarkStartableWorkflows(
              workflows,
              'growth-discovery',
              'live-version',
              undefined,
              7,
              0,
              crypto.randomUUID(),
              true,
            );
      let claimed: string[] = [];
      await checkGrowth(db, {
        name: `native queue discovery ${selector}/${axis}`,
        rule: 'series',
        scales: [256, 1024, 4096],
        repetitions: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(_db, scale) {
          await db.admin.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [root + '%']);
          // Materialization batches these identical fixture inserts outside capture, as seed() does.
          for (let n = 0; n < 16 * scale; n++) {
            const hot = axis.startsWith('hot-');
            await queued(`q:${n}`, queueName, key(hot ? 0 : n), 'ENQUEUED', hot ? 'other-version' : 'live-version', n);
            if (axis === 'keys-busy-miss') await queued(`owner:${n}`, queueName, key(n), 'PENDING', 'live-version', n);
          }
          if (axis === 'hot-version-hit')
            await queued('probe', queueName, key(0), 'ENQUEUED', 'live-version', 16 * scale + 1);
        },
        async prepare() {
          // Restore only our previous claims; preserve deliberately PENDING owners.
          await db.admin.query("UPDATE dbos.workflow_status SET status='ENQUEUED' WHERE workflow_uuid=ANY($1)", [
            claimed,
          ]);
        },
        async operation() {
          claimed = await claim();
          expect(claimed).toHaveLength(axis.endsWith('hit') ? 1 : 0);
          if (axis === 'hot-version-hit') expect(claimed).toEqual([workflowId('probe')]);
        },
      });
    });
  }
}
```

For materialization, batch `queued` fixture inserts in groups of at most 1,000 outside measurement; retain identical
rows/keys/scales. This is fixture efficiency, not a smaller population. Capture one actual candidate discovery
occurrence plus its claim transaction. On hit, `R=O(1+w)`, indexed blocks `O((1+w) log H)`, writes `O(w)` plus
unchanged keyed native writer-control work, and fixed statements at fixed `w`. On empty/busy/version miss,
returned IDs and writes are zero while examined rows remain constant and blocks logarithmic. The test must fail
on the native expanding recursive/key/head work, even if no workflow body starts. A queue timeout is a failure,
not an empty result. Do not replace the SDK query with a copied SQL implementation in the test.

### Required control and preservation matrix

Add these outcomes alongside the reproducers; not every control is expected to fail current source. Each scenario
keeps the same hot partition/key and fixed probe neighborhood while growing unrelated history independently.

| Axis                                            | Frozen assertion                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention hits `d=10` and `d=1000`; empty `d=0` | Grow both age-400/recently-completed and age-1/recently-completed histories with a fixed eligible set (or none). Preserve strict cutoff, null completion exclusion and all four terminal statuses; keep pending/enqueued/delayed work. Bound selection rows/statements independently of history, blocks logarithmically. These complement the inversion fixture, not replace it.                                           |
| Retention change size and children              | Independently vary `d=0,10,1000` and actual owned operation/event/history/message/stream rows at fixed unrelated history. Charge `O(d+c)` rows/writes and `O((1+d+c) log H)` blocks, fixed ID-batch statement structure. Assert every selected owned row kind is deleted, unselected workflows/descendants and permanent fences remain. Never classify legitimate changed child rows as unrelated scans.                   |
| Creation/completion inversions                  | Keep uniquely ordered probe creation times; shuffle eligible completion order, include creation ties without demanding a new tie authority, grow later eligible and earlier noneligible cohorts together. Native list examined work must stay independent of either cohort. Preserve creation-order behavior where unambiguous and the original strict cutoff at one fixed `now` throughout a sweep.                       |
| Queue depth versus key count                    | Run independent growth of one hot key's compatible backlog (fixed available slots), distinct active Session keys, busy keys, and SUCCESS history. Repeated polls must make progress without enumerating unrelated keys per poll. Terminal history alone is insufficient.                                                                                                                                                   |
| Version/ownership misses and hits               | Repeat partitioned and nonpartitioned selectors with incompatible ENQUEUED prefixes. Latest worker accepts current or null version; a non-latest worker accepts only its version. Preserve SDK own-application **or unclaimed** admission and cross-owner PENDING exclusion. Test foreign-application rows only as a supported SDK ownership control; their production presence is not assumed by the core counterexample. |
| Claims, races and failure                       | Two workers must not run two workflows for one Session; preserve native partition locks, fixed candidate recheck, row lock/skip behavior, owner token and per-key priority/creation ordering. Lost claims, rollback/retry and empty/busy polls retain bounded work. No serialization guarantee may be removed to lower examination.                                                                                        |
| Mounted Commerce                                | Extend the existing `work.test.ts`/Session-refresh journey with distinct Sessions plus repeated same-Session refreshes. Assert the original Session key, deterministic workflow IDs, replay/input compatibility, exactly-once native outcomes and ordinary authorization. Measure scheduler work separately from provider/domain callbacks; do not call Stripe in the scheduler-only fixture.                              |
| Migration/restart                               | On an old migrated fixture with existing queued, delayed, terminal, null-version and unclaimed rows, apply the additive migration through the supported SDK path; interrupt/resume any backfill, restart, then repeat hit/miss bounds and ownership cases. No unbounded startup census, lost existing work, removed compatibility or new authority is acceptable. Execution is deferred here.                              |

## Next complete implementation recommendation

Dispatch **kernel native eligible-work discovery** as one Work/SDK implementation and Performance acceptance
class, with Commerce reviewing Session/fairness preservation. Its concrete inputs are the pinned retention
conjunction/order query, native recursive queue candidate query, residual version head filters, existing SDK
migration/index definitions, actual default worker composition and Commerce Session enqueues. Those source chains
establish mounted reachability and supply deterministic logical counterexamples; managers need not repeat a
kernel-wide audit. Resolve the stated ordering/fairness/continuation decisions before an implementation relies on
changed semantics. Keep the legacy Work-client fallback and harness numerical review with their existing owners.
The report and snippets complete this source handoff only; native plans, physical bounds and original acceptance
remain UNRUN and required after integration.
