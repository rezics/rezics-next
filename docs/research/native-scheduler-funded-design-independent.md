# Native discovery: autonomous funding, finite progress and admission limits

Research date: 2026-11-02. Repository source pin:
`129bf1ff7be77f5ceec93f503d77ba870bcea9d6`.

## Finding and recommendation

The adopted accounting boundary is usable: Work can own an autonomous invocation
without manufacturing a Source invocation. The complete production implementation
and its inclusive default numerical admission do **not** exist at this pin.
The owner agreements settle who may pay; they do not supply the missing callable
authorities, native bodies, input bounds or composed prices.

A concrete direction is available for the changed queue contract: maintain exact
application/version membership, traverse commit-ordered finite membership epochs,
and check the shared PENDING veto when visiting a Session. Charge one bounded visit
even when it finds nothing. This avoids the rejected version fanout and makes
incomplete discovery useful. It does not make an incomplete visit proof of empty.
For retention, a fixed-depth completion-prefix access family can preserve creation
order without scanning the creation/completion inversion. It has substantial write
and index costs and unresolved native input-domain and deletion composition limits.

Neither construction below is labelled an admitted implementation. In particular,
there is no honest literal finite **full-path** reservation to put into production
from the currently available owner interfaces. Sections on prices give exact
available literals, their componentwise sums, algorithmic operation counts, and the
precise unpriced operands. Unknown operands are unavailable, never zero. Supplying
a large allowance or reusing a narrow identity-custody verifier's allowance would
conceal these gaps. This is a negative admission finding about the available
composition, not a proof that bounded native discovery is impossible.

Recommend that the manager adopt the algorithm and interface requirements as a
design direction, keep implementation admission closed until the listed bodies and
prices are received, and retain every existing physical acceptance condition.
This report changes no owning specification, consumer authority or acceptance.

## Boundary and evidence custody

Only this research report is a tracked deliverable. No product, SDK patch,
configuration, README, fixture or test was changed. No database query, compiler,
generator, package installation, native invocation, growth run, browser, provider
workflow or stopped-attempt recovery was performed. All assertions, typing and
native/growth acceptance are **UNRUN**. Documentation alone changes no workspace
typing input. The launch policy defers acceptance execution; the report's existence
command is not evidence of native behavior.

The original implementation remains STOPPED/current2 at
`36b3bb204ca0b31783372593d964d65222c89a0e`, with earlier paid
`77460ab6e1` and original `83134` custody retained. Its 143-line
`.temp/native-discovery-continuation-accounting.md` was read through Git at that
commit, not sought as a current main-checkout file. Its undeclared temporary
evidence path remains a historical discrepancy. No third admission or check follows
this report. No independent report draft or live worker was consulted.

The following complete manager documents were read by exact absolute path below
`/home/edge/projects/rezics/rezics-next/`:

| Document                                                                            | Controlling consequence                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `.temp/goal/performance/decisions/native-discovery-owner-contract.md`               | Complete native class, revised queue outcomes, unchanged retention and custody |
| `.temp/goal/performance/native-discovery-approved-continuation.md`                  | Original retained acceptance and stopped continuation scope                    |
| `.temp/goal/performance/decisions/native-scheduler-accounting-boundary-20261101.md` | Static autonomous call-chain finding; owner exchange boundary                  |
| `.temp/goal/commerce/native-scheduler-work-reservation-disposition-20261102.md`     | Actual default Work admission, full inclusive costs, no fallback               |
| `.temp/goal/search/native-scheduler-source-owner-disposition-20261102.md`           | Source authority and original same-frame accounting survive                    |
| `.temp/goal/semantic/native-scheduler-accounting-owner-disposition-20261102.md`     | Missing costs unavailable; numerical funding is not lifecycle authority        |

Committed evidence was read at its specified revision, including superseded
requirements as historical evidence rather than current instructions:

| Revision and path                                                                            | Use here                                                                          |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `aa9428eb40e82bffeb05afefbd4060043c8bed12:docs/research/kernel-bounded-work-source-gaps.md`  | Full 434-line source specification, inversion, native paths and frozen scales     |
| `49803a1c4d772bfb596170fe890e650b08391089:docs/research/native-eligible-key-index-design.md` | Full 634-line rejected-index analysis, cross-version veto and custody obligations |
| `36b3bb204ca0b31783372593d964d65222c89a0e:.temp/native-discovery-continuation-accounting.md` | Full 143-line stopped accounting evidence                                         |

AGENTS, the development entry point and linked Goal definitions, architecture,
scope, the rezics-workflow skill and design reference, and the complete
`services/kernel/README.md` were read. The Work registry, client, retention,
worker, queue configuration and native retirement adapter were read in full.
Source's maintenance frame, its configuration and History's actual reservation and
durable maintenance bodies were inspected rather than inferred from interface names.

### Source pin, installed dependency and divergences

All repository claims refer to the source pin above. Relevant tracked files had no
delta from that pin when inspected. Installed dependency files are a separate
observation; their presence is not a new owner dependency receipt.

The lock and installed package identify `@dbos-inc/dbos-sdk@5.5.3-preview`.
The official npm version metadata identifies upstream Git commit
`627990fc59619d3584ce88511ab546bc7483f4b9`, MIT, and artifact integrity
`sha512-X3lLxn1yPQVm4LJw8uJwQ6FM8Yx73ePZD9DY7ARZCV6/hUPZf9SMXfg4VwliQOXEm8BEJUfwAKKuHZxvgT75EQ==`.
Metadata: [exact npm release](https://registry.npmjs.org/@dbos-inc%2fdbos-sdk/5.5.3-preview).
The original release source was shallow-fetched into the permitted reference area
and read; none of its code was installed, built or run.

| Observed file                                      | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `patches/@dbos-inc%2Fdbos-sdk@5.5.3-preview.patch` | `16f393956300e03b04794ec58058c98f6398bcac7d55fdbd68a6f8b84c359806` |
| Installed `dist/src/system_database.js`            | `7f8acb0c80120ad0afa59e7848bbebbfcae5d3f0754d459764b923c1b0343f2b` |
| Installed `dist/src/wfqueue.js`                    | `9be7bd806fb41bbb73d87b848a2c8ac1cb8bc8e615c6cadd7158bffb8b0698c5` |
| Installed `dist/src/client.js`                     | `9031a6d260650e4e39f225e366e43eac8d7646fb799ab8270d7117ad0826a971` |

The entire installed patch was read. It adds permanent writer fences, native
restore-domain checks, client retirement APIs and guarded resume/rewind/fork
paths. It does not install discovery indexes, epoch cursors or autonomous funding.
The original scheduler and native writer bodies are from the exact release source,
with the installed compiled bodies and patch used to identify the added guards.

An older reused DBOS reference at
`980dc55095f445b189aecb59e7f3334345179f65` is **not** the release pin:
its scheduler includes periodic delayed-transition logic that the exact release's
schedulerLoop does not contain. It also predates the release's dequeue-scope path.
No behavior was silently imported from that reference. Delayed transition remains
a native writer requiring coverage wherever it is called.

The kernel README's worker cost row still describes 18 bounded executions plus an
unbounded workflows queue. Actual `work/queues.ts` has seven bounded queues totaling
34: governance 2, effects 8, locator-effects 8, workflows 8, delivery 4, import 2,
maintenance 2. These are concurrency limits, not work allocations. Its ordinary
retention plan description does not prove the adopted inversion requirement.
Comments naming SDK 5.4.6 also do not override the installed 5.5.3-preview bodies.

## Primary upstream comparison

Reference locations below are beneath the main checkout's permitted `.reference/`.
Existing clones were reused where possible; the exact missing DBOS release was
fetched under `native-scheduler-funded-design/dbos-transact-ts/`.
The shared reference INDEX records topic, URL, revision, licence and date.

| Source          | Pinned revision; licence; local path                                                                         | Relevant primary bodies                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| DBOS TypeScript | `627990fc59619d3584ce88511ab546bc7483f4b9`; MIT; `native-scheduler-funded-design/dbos-transact-ts/`          | `src/wfqueue.ts:710–960`; `src/system_database.ts:1647–2160,2498–3170,4279–4905,5723–5990`; `src/sysdb_migrations/internal/migrations.ts` |
| Temporal Server | `3eb5fb80523443d8583bcec463843275908f1bbc`; MIT; reused `delivery-tooling/temporal/`                         | `common/tasks/rate_limited_scheduler.go`; `service/history/queues/iterator.go`; `service/history/queues/queue_base.go:262–418`            |
| PostgreSQL      | `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; PostgreSQL licence; reused `library-shelf-maintenance/postgres/` | `src/backend/access/nbtree/README`; `src/include/access/nbtree.h:155–175`; `COPYRIGHT`                                                    |

Links to the pinned bodies:
[DBOS scheduler](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/wfqueue.ts),
[DBOS database](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/system_database.ts),
[Temporal admission](https://github.com/temporalio/temporal/blob/3eb5fb80523443d8583bcec463843275908f1bbc/common/tasks/rate_limited_scheduler.go),
[Temporal queue checkpoint](https://github.com/temporalio/temporal/blob/3eb5fb80523443d8583bcec463843275908f1bbc/service/history/queues/queue_base.go),
[Temporal iterator](https://github.com/temporalio/temporal/blob/3eb5fb80523443d8583bcec463843275908f1bbc/service/history/queues/iterator.go),
[PostgreSQL B-tree](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/nbtree/README).

DBOS separates queue polling from workflow execution. Its lanes limit overlapping
polls; worker budgets limit selected executions. The recursive distinct-partition
walk can nevertheless enumerate the whole partition population before its result
limit. The fast path rereads heads under partition locks, locks a fixed candidate
set and conditionally updates that set. Preserve these safety properties while
replacing discovery. Queue configuration controls are documented separately from
resource accounting in the [official queue tutorial](https://docs.dbos.dev/typescript/tutorials/queue-tutorial).

Temporal places rate admission before submission and deliberately does not return
a consumed token when the underlying scheduler is busy. That is a useful precedent
for charging unsuccessful attempts. Its optional disabled/shadow behavior, and its
Submit path's log-and-continue on reservation failure, are unsuitable for this
contract's mandatory fail-closed accounting. A request-rate token is also not a
proof of bounded SQL rows or bytes. The [worker performance documentation](https://docs.temporal.io/develop/worker-performance)
discusses slots and rate controls; neither supplies this repository's five-axis
reservation or Source authority.

Temporal's queue iterator advances an explicit remaining range after a returned
task. Its queue base admits a new finite high-water range and persists reader
scopes. Checkpoint code deliberately range-completes before saving the newer
watermark, avoiding forgotten deletion after failure. This is evidence for explicit
progress, replay and effect-before-checkpoint ordering, not evidence that Temporal
uses one PostgreSQL transaction for the proposed Work cursor and claim.

PostgreSQL supports ordered index scans, but a result LIMIT does not bound residual
filter work. Row locking with SKIP LOCKED can omit unavailable rows; it does not
certify that a queue is empty. See [PostgreSQL 18 SELECT](https://www.postgresql.org/docs/18/sql-select.html).
Index-only access may still visit the heap for visibility, as documented in
[index-only scans](https://www.postgresql.org/docs/18/indexes-index-only-scans.html).
The accounting boundary excludes engine MVCC visibility work, not visible records
traversed by a user-designed tree, index residuals or explicit payload conversion.

The shared pattern is to separate admission, finite discovery progress and actual
execution ownership. None of these projects supplies an interchangeable literal
five-axis price or permission to erase Source-owned copies. Recommend implementing
these patterns in the existing PostgreSQL/TypeScript/DBOS stack; no upstream files
or long passages should be copied.

## Required class and actual call sites

The class is larger than a balance object. It includes admission, queue registry
reconciliation, queue selection/claim, retention, every native writer, migration,
coverage, restore, copy inventory and owner-authorized removal.

| Existing call site                 | Required proposed change and payer                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `worker.ts:startWorker`            | Construct one Work issuer using the exact created Pool; install it before any DBOS launch I/O requiring Work funding                                               |
| `work/registry.ts:composeWork`     | Receive the issuer explicitly; queue registration and module registration retain their actual launch caller; pass required native admission into SDK configuration |
| `DBOS.launch` / runner setup       | Pay bounded queue/version discovery before the first selector; startup is not an unbounded migration window                                                        |
| `WFQueueRunner.runDispatchLoop`    | Initial refresh is a paid resumable registry page, not free setup                                                                                                  |
| `schedulerLoop`                    | Choose a finite action, obtain one admission, and await settlement; timers do not mint child balances                                                              |
| `scheduleDueQueues`                | Maintain due work from bounded registry pages; avoid sorting an unbounded DB-backed queue registry inside one priced action                                        |
| `runQueuePoll`                     | Own one invocation through result classification, committed progress and cleanup; keep lane release separate from funding settlement                               |
| `pollQueue`                        | Explicitly pass invocation to version/scope/selector/claim; propagate three outcomes instead of boolean contention alone                                           |
| `systemDatabase` selectors         | Reserve complete SQL plus triggers before dispatch; preserve fixed candidate ownership and conditional native claims                                               |
| `runWorkflowRetentionSweep`        | Admit its autonomous Work invocation before selection; keep one original cutoff and a durable sweep state                                                          |
| `runWorkflowRetentionBatch`        | Return progress plus selected/deleted counts and authoritative exhaustion; a short incomplete page is not final                                                    |
| Additive migration/backfill/repair | Separate admitted bounded steps, with durable committed coverage; never charged retrospectively to a later poll                                                    |
| Original Source maintenance entry  | Use its exact Source token, callbacks, Pool, deadline and inclusive aggregate, without calling the autonomous issuer                                               |

The existing default chain is `startWorker → createWorkClient → composeWork →
work.launch → DBOS.launch → runner → schedulerLoop → scheduleDueQueues →
runQueuePoll → pollQueue → systemDatabase`. Workflow bodies begin after native
selection. `composeWork` installs the shared systemDatabasePool and disables SDK
automatic migrations. The proposed admission must therefore be a required real
native launch option/port, not just a wrapper around the WorkClient API.

Mounted partitioned queues use partitionConcurrency=1 without queue-wide or
partition rate limits. Other native configurations, shards and provider engines
need their own complete finite selector bodies. Do not let unsupported configuration
fall through to `getQueuePartitions` and an unlimited shuffle. Refuse that dispatch
before I/O and identify the unavailable mode; do not claim this delivers a generic
replacement for every DBOS deployment.

### Issuer, settlement and identity

The following is a proposed Work interface, **not installed source**:

```ts
type NativeAmount = Readonly<{
  rows: number;
  points: number;
  statements: number;
  bytes: number;
  engineRequests: number;
}>;
type Action =
  | 'registry-page'
  | 'queue-visit'
  | 'queue-empty-seal'
  | 'retention-page'
  | 'retention-delete'
  | 'coverage-row'
  | 'repair-row';
type Invocation = opaque; // process-private WeakMap brand, never caller JSON

async function invokeWork(pool, action, body) {
  const proof = exactBodyPriceTable[action];
  // Required default policy: no optional unmetered branch.
  if (!proof || !proof.complete || !proof.authoritiesAvailable) return REFUSED;
  const issued = issuer.admit(pool, action, proof.inclusiveMax);
  if (!issued) return REFUSED;
  // issuer, not the callback, fixes UUID, Pool, allocation, original deadline.
  try {
    return await body(issued.invocation);
  } finally {
    issuer.settleAndInvalidate(issued.invocation);
  }
}

function dispatch(invocation, pool, dispatchId, args, connection) {
  const f = liveFrames.get(invocation);
  require(f && f.active && f.pool === pool && now() < f.deadline);
  require(currentWorkFrame() === f); // explicit native parameter remains required
  const price = pricedDispatches[dispatchId];
  require(price && price.authoritiesValid(args, connection));
  require(allFiveAxesAreSafeNonnegativeIntegers(price));
  require(componentwise(f.used + price <= f.allocation));
  f.used += price; // synchronously, before query or callback
  return sendOnce(connection, dispatchId, args, f.deadline);
}
```

One invocation's parent vector is the componentwise sum of reached dispatch
maxima, including its cleanup path. The issuer records the allocation as committed
to that invocation; actual dispatched charges are retained on failure and settlement.
Unused capacity cannot refill it. Reserve the potential rollback slot before BEGIN
or connection-dependent I/O that can require cleanup; cleanup after expiry uses
that already authorized slot and cannot issue another business operation.

The real issuer must be a default operational policy with finite allocations and a
finite original deadline. It needs an owner-approved capacity/admission source,
not a test-injected ledger or a configuration switch that defaults to unmetered.
The pin contains no such issuer or complete price table. Consequently the only
source-supported current behavior of this proposed interface is refusal; calling
that a working production scheduler would be false. A positive numeric default
cannot be selected until the full vectors below are available.

Bind the Pool by object identity, not a connection string. Bind every borrowed
connection to that Pool and the invocation in private state. Native SDK calls carry
the opaque invocation and dispatch capability explicitly; SQL hooks execute only
as transitive prepriced work inside that call. No SQL session setting alone grants
funding or mutation authority. A native path lacking the required capability must
refuse rather than silently omit its reservation.

Concurrent children atomically debit the same vector before awaiting. No child
may call admit, renew its deadline, retain the frame after settlement or use an
unrelated ALS frame. SDK retries must be removed from the autonomous one-attempt
port or individually reserved within the same original invocation. The release's
`@dbRetry` wrappers are not a bounded one-attempt body.

A later scheduler wake may receive a distinct, explicitly paid admission. That
is legitimate only after the earlier invocation has ended and under ordinary
scheduling policy. It cannot be a catch/exhaustion loop that reissues balances
until the old operation finishes. Durable progress belongs to the queue domain,
not to a retained funding token; new invocations resume data, never old authority.

### Source path remains separate

`identity-source-consumer-maintenance.ts` requires the exact active ALS frame,
same Pool and original live deadline. Its WeakMap token disappears at settlement.
`history/agent-identity-inventory-work.ts:reserveIdentityHistoryWork` asks for that
current frame and throws `identity-history-native-funding-unavailable` if absent.
Do not change this behavior, wrap the scheduler in
`withIdentitySourceConsumerMaintenance`, or retain its token.

An entry whose caller is original Source maintenance must keep its existing reserve
callback and aggregate. Work exhaustion is not a reason to try Source, and Source
absence/expiry/exhaustion is not a reason to try Work. Select the payer by the actual
authorized entry path, not by whichever ledger currently has money.

For autonomous operations invoking a Source-owned hook, a separate owner-approved
callable must accept the exact native transaction, explicit Work payer capability,
original deadline and owner authorization. Its complete transitive body must be
priced in the Work parent. No such autonomous callable is installed at the pin.
The owner agreements authorize the accounting separation, not that callable or a
Source mutation, lifecycle transition, copy removal or all-copy absence receipt.

## Queue algorithm: factor membership, visit fairly, validate natively

This section specifies a candidate native algorithm and its proof conditions. It
replaces whole-population discovery, not native claim authority. Its finite step
counts are concrete; its unproved input/trigger/copy prices are identified later.

### Exact eligibility domains

Use tagged NULLs, never an ordinary string as a NULL sentinel. Match native text
equality/collation exactly. A named worker means a nonempty configured native name;
the release treats unset/empty application filters as unrestricted. For application A and version v,
eligible applications are A and NULL. A latest worker accepts v and NULL versions;
an older worker accepts only v. Latest means the actual native version lookup over
that application's own and unclaimed version records; absence of a registered
version counts as latest. A named peer's deploy cannot demote this worker.

The native nameless-application filter is unrestricted, not NULL-only. Support it
through a second projection ignoring application, with its own version buckets and
head index. Each ENQUEUED workflow contributes to exactly two projections: its
tagged exact application/version bucket and the all-application/version bucket.
That is constant writer work, independent of the number of registered versions.
Do not enumerate applications when a nameless worker polls.

| Worker              | Membership streams                          | Head predicates                                   |
| ------------------- | ------------------------------------------- | ------------------------------------------------- |
| Named, nonlatest    | `(A,v)`, `(NULL,v)`                         | Exact queue, key, status, application and version |
| Named, latest       | Previous two plus `(A,NULL)`, `(NULL,NULL)` | Same, with each NULL branch explicit              |
| Nameless, nonlatest | `(ANY_APPLICATION,v)`                       | Application unrestricted, version exact           |
| Nameless, latest    | Previous plus `(ANY_APPLICATION,NULL)`      | Application unrestricted; two version branches    |

The original cross-application/version PENDING veto uses queue plus actual Session
partition key and native scope only. It must not use these eligibility buckets.
A tight `(queue_name,status,queue_partition_key)` existence probe returns at most
one PENDING row. No Ready bit is copied into every version bucket when this gate
changes. The poll pays to discover a blocked member and returns incomplete.

### Additive schema sketch

These are proposed tables/indexes, not executed DDL. Native text storage and index
width admissibility remain explicit conditions; a UUID hash cannot replace exact
identity or silently resolve a collision.

```sql
-- Nullable components are represented by (is_null,value), with a canonical
-- empty value ONLY when is_null=true; exact non-null empty text stays distinct.
CREATE TABLE dbos.discovery_bucket (
  bucket_id bigint PRIMARY KEY,
  queue_name text NOT NULL,
  application_mode smallint NOT NULL CHECK (application_mode IN (0,1)),
  application_is_null boolean NOT NULL,
  application_value text NOT NULL,
  version_is_null boolean NOT NULL,
  version_value text NOT NULL,
  last_ticket bigint NOT NULL,
  mutation_revision bigint NOT NULL,
  restore_generation uuid NOT NULL
  -- exact UNIQUE on the complete tagged bucket tuple
);
CREATE TABLE dbos.discovery_member (
  bucket_id bigint NOT NULL REFERENCES dbos.discovery_bucket,
  session_key text NOT NULL,
  ticket bigint NOT NULL,
  enqueued_count bigint NOT NULL CHECK (enqueued_count > 0),
  PRIMARY KEY (bucket_id,session_key),
  UNIQUE (bucket_id,ticket)
);
CREATE TABLE dbos.discovery_contribution (
  workflow_uuid text PRIMARY KEY,
  native_revision bigint NOT NULL,
  exact_bucket_id bigint,
  any_application_bucket_id bigint,
  session_key text,
  restore_generation uuid NOT NULL
);
CREATE TABLE dbos.discovery_queue_revision (
  queue_name text PRIMARY KEY,
  revision bigint NOT NULL,
  restore_generation uuid NOT NULL
);
CREATE TABLE dbos.discovery_epoch (
  domain_id uuid PRIMARY KEY,
  queue_name text NOT NULL,
  worker_application text,
  worker_version text NOT NULL,
  latest_observation_revision bigint NOT NULL,
  restore_generation uuid NOT NULL,
  phase smallint NOT NULL,
  round_robin_slot smallint NOT NULL,
  queue_revision_at_open bigint NOT NULL,
  coverage_revision_at_open bigint NOT NULL,
  saw_unavailable boolean NOT NULL
);
CREATE TABLE dbos.discovery_epoch_stream (
  domain_id uuid NOT NULL REFERENCES dbos.discovery_epoch,
  slot smallint NOT NULL CHECK (slot BETWEEN 0 AND 3),
  bucket_id bigint,
  epoch_end bigint NOT NULL,
  after_ticket bigint NOT NULL,
  revision_at_open bigint NOT NULL,
  done boolean NOT NULL,
  PRIMARY KEY (domain_id,slot)
);
-- Both head indexes have literal ENQUEUED predicates and exact branch equality.
-- Tagged application/version equality is expanded into native = / IS NULL SQL.
-- Exact-app index:
-- (queue_name,application_name,application_version,queue_partition_key,
--  priority,created_at,workflow_uuid) WHERE status='ENQUEUED'
-- All-app index:
-- (queue_name,application_version,queue_partition_key,
--  priority,created_at,workflow_uuid) WHERE status='ENQUEUED'
-- Shared gate:
-- (queue_name,queue_partition_key) WHERE status='PENDING'
```

The contribution row is a bounded reverse ownership record, not permission to
retain account-bearing metadata forever. Bucket dictionary creation must itself
be bounded, exact, funded and included in copy inventory. A dictionary based on
hashes plus an unlimited collision chain does not meet these requirements.

### Commit-monotone membership maintenance

One native status change reconciles its prior contribution against the NEW status
and key/application/version tuple. It locks the contribution and affected bucket
allocator rows in a globally consistent order. A newly nonempty bucket/Session
membership increments the bucket allocator **under a transaction-held row lock**,
then publishes that ticket in the same native transaction. Existing nonempty
membership keeps its ticket. A zero count removes the member and its Session copy.

Do not allocate tickets from a sequence before taking that serialization lock:
transaction T1 can obtain ticket 10 and stall while T2 publishes 11; a scanner
can pass 11 before 10 commits. A captured maximum alone would then forget T1.
With the allocator row held through COMMIT, a visible allocator high-water implies
all earlier published tickets have committed or rolled back. Rolled-back increments
and contribution changes disappear together.

Each changed workflow has at most two old and two new projections. This bounds the
writer's membership work by four projection actions, not V actions. Priority or
creation changes update native head indexes and revisions without changing stable
membership tickets. Queue, key, application, version and status changes reconcile
old and new memberships. PENDING entry/exit changes the shared queue revision;
it does not rewrite membership for other versions.

For migration compatibility, install native row triggers for status INSERT,
UPDATE and DELETE, including direct SQL/COPY/old clients; make guards ALWAYS where
the installed writer protocol requires it. This cannot be achieved solely by new
TypeScript enqueue wrappers. The same-transaction contribution update is idempotent
against the stored contribution and native revision, so a replayed backfill does not
increment counts twice. Locking an absent contribution must serialize with a writer
on the same actual ID; a naive SELECT-for-update on a nonexistent row is insufficient.
Use the existing status row/writer identity lock or a unique keyed insert lock.

Counter widths and ticket rollover are not free details. The sketch's BIGINTs are
conditional on nonoverflow. A bounded rebase/namespace protocol preserving all
active epochs is still required for an unrestricted lifetime; silently refusing
new versions or Sessions at a chosen counter cap would violate this contract.
Neither a fixed version cap nor a fixed population cap is recommended here.
This is one reason the sketch is not claimed as a completed uniform implementation.

### Literal queue visit steps

Choose one membership visit per admitted native step. More visits require that
many prepaid steps within the original invocation, not hidden refill. A logical
poll may therefore return no claim even when an eligible Session exists elsewhere.
The maximum number of streams is four, independent of V and N.

| Step | Concrete operation                                                                                        | Maximum result / fixed work                                                               |
| ---- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Q0   | Validate live invocation, mode and exact Pool; prepay cleanup and full chosen branch                      | No DB I/O on refusal                                                                      |
| Q1   | BEGIN; set remaining original statement deadline and finite lock wait                                     | One transaction; no renewed deadline                                                      |
| Q2   | Lock domain cursor NOWAIT; read restore/coverage and latest-version observations                          | One domain; at most four stream records; two eligible owner version heads for a named app |
| Q3   | If new epoch, capture each allocator high-water/revision and queue/coverage revision                      | At most four buckets; one queue clock; no member enumeration                              |
| Q4   | Select next non-done stream round-robin; seek its first ticket after cursor and at/below epoch_end        | One indexed member result or one paid miss                                                |
| Q5   | If miss, mark only that stream done; otherwise try original native partition lock for this one Session    | One fixed Session; contention is incomplete                                               |
| Q6   | Under partition lock, probe the shared native PENDING gate                                                | One existence result across all apps/versions                                             |
| Q7   | If clear, read top head from each compatible exact branch for this Session                                | At most four native head rows, ordered priority/created/actual ID                         |
| Q8   | Merge those at most four heads; lock the single fixed winning actual ID SKIP LOCKED                       | Never LIMIT-and-slide to a later same-Session workflow                                    |
| Q9   | Reread/recheck native queue/key/status/app/version/latest/restore and shared gate before conditional flip | One fixed ID, one shared existence probe; a lost candidate is incomplete                  |
| Q10  | UPDATE exact candidate to PENDING with original owner token/executor/version/app claim/deadline rules     | At most one status row plus all native and new writer hooks                               |
| Q11  | Persist advanced stream ticket and domain rotation; COMMIT                                                | Progress and claim commit together                                                        |
| Q12  | On error, use prepaid ROLLBACK; return incomplete with no uncommitted cursor advancement                  | Failed work stays charged; no internal retry                                              |

A blocked/missing member or a lost fixed claim advances the visited ticket only
when its bounded no-claim attempt commits. A failure to lock the domain cursor
advances nothing. Rollback advances nothing. If a member disappears after the seek,
the visit is still paid and may commit its cursor; any later new membership has a
newer ticket. Reading an earlier head before locking is not authoritative; Q7 is
performed under the actual native partition lock, not trusted from a cache.

Keep the installed native lock expression and scope identity. Native advisory hash
collisions may conservatively cause contention, but may not merge Session identity.
Keep actual row locks, owner_xid, conditional rechecks, recovery attempt changes,
application COALESCE and original saturated workflow timeout/deadline calculation.
The Work invocation deadline limits this maintenance call; it is not a substitute
for the workflow's persisted execution deadline.

All relevant writers must serialize their membership/gate changes consistently
with this native claim. In particular, a new PENDING row in another application
cannot evade Q9. A final anti-EXISTS under READ COMMITTED alone cannot exclude a
concurrent insert. Use the same actual partition lock for native claim-affecting
writers, with fixed lock order and NOWAIT/SKIP LOCKED on the candidate path to avoid
waiting behind an oppositely held status lock. Installing these native trigger
bodies and preserving original writer semantics is a required implementation item,
not something a queue counter proves by itself.

### Outcomes and authoritative empty

```ts
type QueueResult =
  | { kind: 'claim'; ids: readonly string[]; ownerXid: string; progress: Receipt }
  | { kind: 'incomplete'; reason: string; progress: Receipt | null }
  | { kind: 'empty'; domain: ExactDomain; observation: EmptyReceipt };
```

Claims identify only committed native flips. A batch wrapper preserves already
committed claims even if a later paid step fails, as the original SDK does for
earlier committed batches. The caller dispatches those IDs with their original
owner tokens after funding settlement; workflow execution uses its own authority.
The scheduler must not discard committed IDs because a subsequent step exhausted
its balance. A no-slot worker returns incomplete/no-capacity, never empty.

Finishing one epoch is normally incomplete. To prove empty, open an epoch with
authoritative coverage and record the queue mutation revision, bucket revisions,
latest-version observation and restore generation. Complete all its finite streams.
Every visited member must have an authoritative no-claim observation, not a lock
failure or unavailable hook. Then run a separate prepaid empty-seal transaction:

1. Lock the same domain and the exact queue/version/coverage/restore revision rows.
2. Require complete coverage for that restore domain and all streams done.
3. Require every captured relevant revision unchanged and no unavailable visit.
4. Require no committed claim in the observation interval.
5. Commit an empty receipt scoped to that domain and observation point.

All relevant native mutations increment the queue clock in the same transaction;
version registration/timestamp/adoption and coverage publication have their own
same-transaction revision. This conservative clock may invalidate a seal for
unrelated version activity, but never induces V writer fanout. A dirty seal returns
incomplete. It does **not** reset a partially completed fairness lap on each write.
An empty receipt is an observation, not a promise about future enqueue commits.
Uncommitted concurrent arrivals can be linearized after that observation.

Q4 LIMIT, a migration boundary, budget/deadline exhaustion, lock conflict, failed
claim, missing mode, changed gate/version/restore or an ended epoch cannot produce
empty. `runQueuePoll` and `pollQueue` must preserve this classification through
their error handling and backoff. An incomplete result continues ordinary future
discovery; it cannot terminate a drain or suppress future polls.

### Finite-epoch opportunity argument

When opening an epoch, each stream's visible high-water is finite and commit
ordered. Later new memberships get tickets beyond it. A continuously present
Session has a fixed ticket in at least one compatible stream. Fair round-robin
selection advances each active stream through its finite prefix, at one paid visit
per step, without restarting it for new arrivals or gate changes. Restart resumes
the same committed cursor. Thus that ticket receives a visit in a finite number
of committed steps, conditional on future admitted execution and cursor access.

After reaching all frontiers, open the next finite epoch. A gate that was PENDING
when visited is revisited in a later epoch without any version fanout. Membership
deletion/reinsertion receives a new ticket and is covered in a later epoch.
An older/nonlatest versus latest transition changes the precise domain observation;
retain prior committed progress where still meaningful, explicitly add/drop the
bounded compatible streams, and never certify empty from stale version coverage.
Restore invalidates old-domain coverage and resumes only after current-domain repair.

The lock-availability condition needs a precise scheduler interpretation. Merely
having infinitely many instants when a lock is free does not ensure a poll hits one:
an adversary can hold it at every Q5. The defensible guarantee is eventual claim
opportunity for a continuously eligible Session under fair visits and eventual
lock availability at an attempted acquisition, or a sufficiently persistent free
interval. There is no wall-clock promise or success under permanent/adversarial
exclusion. The contract's opportunity language should be used without strengthening
it into lock-scheduling magic.

### Nonpartitioned and other native paths

Nonpartitioned queues retain original priority/creation selection across all their
eligible rows. Use the same at-most-four exact branch head indexes without a Session
prefix, merge in native order, and operate on a fixed bounded candidate set. A
locked/lost candidate does not cause an unlimited refill query. Native shared
concurrency and rate controls need maintained bounded aggregates and their original
advisory locks if enabled; the mounted configuration does not exercise those modes.
No generic bounded rate/global-concurrency body is installed or priced here.

Registry reconciliation likewise needs a commit-ordered page/coverage protocol,
not `listQueues` returning all records before filtering. A due-queue priority
structure can choose bounded work, with explicit reconciliation and removal
progress. Its key bytes, dictionary, restart reconstruction and owner costs belong
in admission. Fixed mounted queue count is evidence for this deployment, not a
population cap that repairs the SDK's general registry path.

## Retention algorithm: preserve creation order and both cutoffs

The unchanged policy is 7–365 days, default 30. One sweep fixes its original `now`
and cutoff. Eligibility is all four native terminal statuses: SUCCESS, ERROR,
CANCELLED and MAX_RECOVERY_ATTEMPTS_EXCEEDED; completion must be non-NULL;
`completed_at < cutoff` and `created_at < cutoff`; application is the owning
application or unclaimed according to the actual native filter. Results stay in
ascending creation order. A deterministic actual-ID tiebreaker may totalize equal
creation timestamps without substituting completion ordering.

Current code sends cutoff minus one millisecond to inclusive SDK `completedBefore`
and `endTime`, rechecks completion, limits to 1,000 and calls
`deleteWorkflows(ids,false)`. A sweep permits at most 60 batches. Preserve these
values and the ten-minute schedule. A cursor must retain the original cutoff;
recomputing it on every continuation can change the set it purports to exhaust.

### Fixed-depth prefix family

A concrete selection construction uses the actual BIGINT completion domain. Map
signed completion time to unsigned order by flipping its sign bit. The strict
interval `[0,unsigned(cutoff))` decomposes into at most 64 disjoint binary prefixes:
for each set bit in the cutoff, use the preceding equal bits followed by zero.
This is exact for negative timestamps as well; it does not assume modern dates or
that completion follows creation.

Maintain a native-transaction projection with one row per terminal workflow whose
completion is non-NULL, and
64 expression B-tree indexes on that projection, one per prefix depth 1 through
64, each ordered by exact application, prefix value,
created_at and workflow_uuid. Literal partial predicates include the four terminal
statuses and non-NULL completion. A query for a prefix uses the matching literal
depth expression and exact app/NULL branch, with a creation range and keyset bound.
An all-application variant is needed only if the retention entry actually supports
the native nameless application mode; do not interpret that mode as NULL-only.

```sql
CREATE TABLE dbos.retention_projection (
  workflow_uuid text PRIMARY KEY,
  status text NOT NULL,
  application_name text,
  created_at bigint NOT NULL,
  completed_at bigint NOT NULL,
  native_revision bigint NOT NULL,
  restore_generation uuid NOT NULL
);
-- One instance for each literal d in 1..64; generated here as design notation.
-- Native code must use the same immutable expression in query and index.
CREATE INDEX retention_prefix_d ON dbos.retention_projection
  (application_name,
   (substring((completed_at::bit(64) # X'8000000000000000') from 1 for d)),
   created_at, workflow_uuid)
  WHERE status IN ('SUCCESS','ERROR','CANCELLED',
                   'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
    AND completed_at IS NOT NULL;

-- A single stream head, with exact application or its separate IS NULL branch:
SELECT workflow_uuid,created_at
FROM dbos.retention_projection
WHERE status IN ('SUCCESS','ERROR','CANCELLED',
                 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
  AND completed_at IS NOT NULL
  AND application_name = $app
  AND substring((completed_at::bit(64) # X'8000000000000000')
                from 1 for d) = $prefix
  AND created_at < $original_cutoff
  AND (created_at,workflow_uuid) > ($after_created,$after_id)
ORDER BY created_at,workflow_uuid LIMIT 1;
```

The illustrative `d` is an emitted literal in each DDL/query, not a SQL column or
runtime parameter whose planner implication is assumed. For an initial head there
is no after predicate. Use separate NULL and named application streams so there
is no residual owner filter over other applications' rows. Every qualifying row
belongs to exactly one queried prefix, although its projection row is maintained
in all 64 depth indexes.

There are at most 128 named-application stream heads. Fetch one head per stream,
merge the bounded heads by creation/ID, and refill only the winning stream.
For 1,000 selected results, at most 128 + 1,000 = 1,128 head seeks suffice if the
implementation performs the final refill even on the last emitted result; it may
omit that unnecessary final refill. At most 1,128 design-visible head rows cross
these probes. This is not a complete reservation: index maintenance, transaction
control, native rechecks, fences, deletion and byte widths are additional.

No completion-first substitution occurs. The prefix restriction proves completion
eligibility before ordered creation access; the creation range proves the other
cutoff. The creation/completion inversion cannot add live residual candidates to a
stream. A 64-deep auxiliary prefix table would instead add 64 account-bearing heap
copies per workflow and explicit row work; it is a different, more expensive copy
design and is not hidden inside this expression-index proposal. The one projection
heap row and all 64 index copies in this proposal remain actual owned copies.

### Literal retention steps and continuation

| Step | Concrete body                                                                                                 | Required outcome                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| R0   | Validate policy and original cutoff; admit full selected branch                                               | Invalid policy refuses before I/O                                      |
| R1   | Read/lock sweep state and current restore/coverage revision                                                   | Incomplete coverage cannot prove exhaustion                            |
| R2   | Decompose cutoff into at most 64 prefixes; choose at most two application branches                            | Fixed CPU domain, no history enumeration                               |
| R3   | Read at most 128 stream heads through the matching indexes                                                    | All exact status/application/cutoff predicates                         |
| R4   | Merge and refill winning stream up to 1,000 selected IDs                                                      | Original creation order, bounded result count                          |
| R5   | Before deletion, obtain actual owner authorization and permanent native writer closure for each actual ID     | Numerical Work money is not that authority                             |
| R6   | Execute funded native `deleteWorkflows(ids,false)` one-attempt body                                           | Four explicit families and four native FK families; no child workflows |
| R7   | Remove derived contributions/copies in the same authorized native transaction; persist progress with deletion | No receipt for an uncommitted deletion                                 |
| R8   | Commit or prepaid rollback; classify progress separately from exhaustion                                      | Error/rollback work charged, no renewal                                |

Short results caused by price limits, unavailable owners, migration, races or lock
loss return incomplete and retain continuation. Fewer than 1,000 deletions does
not by itself end the sweep. Exhaustion requires authoritative completed coverage
and a current observation that no eligible stream has another row. Keep a distinct
exhausted bit/receipt, not a numeric overload of deleted count. At the 60-batch
limit, persist pending work for ordinary later paid invocation rather than draining
without limit. A retention workflow replay may recover data progress; it may not
recover the settled funding token.

A mutable row can become terminal or change into an earlier creation position
behind a stored cursor. Do not permanently skip it: index maintenance increments
the retention revision in the same native transaction. A final exhaustion seal
checks that revision, restore and coverage. On change, perform a new creation-ordered
lap at the original cutoff; do not claim that a dirty prior lap exhausted the set.
For each batch, rebuilding the at-most-128 stream heads from current indexes avoids
returning stale cached head order. If selection and deletion race, revalidate the
fixed selected IDs and original predicates under native locks; do not fill holes
by scanning an unlimited number of replacement rows.

The prefix construction has two material unresolved admission questions. Composite
index keys may be wider than originally valid native rows allow, and maintaining
64 indexes may exceed the frozen physical block allowance. Neither question is
answered by its constant live-row shape. Native proof must retain the original
40/4,000 index-probe allowances and physical matrix; this report increases neither.
Its expensive writes are disclosed rather than moved to an unbounded startup job.

## Native writers, coverage, repair and copies

The projection form above permits empty-table additive migration: create the new
tables and all indexes while empty, install compatible native maintenance, and
populate through bounded pages. Building 64 indexes directly over the populated
native status table would instead perform a history-sized index build per DDL.
`CREATE INDEX CONCURRENTLY` changes lock behavior, not that work bound. It is not
a prepaid constant startup step. The projection adds one account-bearing heap copy
per terminal workflow plus index copies; all must be inventoried and removed.

### Complete native mutation inventory

The original release's `src/system_database.ts`, native migration SQL writers and
the installed patch are the authority for this inventory. A status-row native hook
must compare OLD and NEW, not infer behavior from a public method's name.

| Native entry / mutation                                    | Required maintained effect and original safety                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initWorkflowStatus`, standalone and transaction forms     | Insert status plus input in the original transaction; maintain actual initial ENQUEUED/PENDING/DELAYED state; no-op conflict still pays its attempted guard                                    |
| `initChildWorkflowStatus`                                  | Preserve parent owner check and operation receipt; count child status/input/parent-related guards and contributions in the same transaction                                                    |
| `enqueueWorkflows`                                         | All actual 500-row chunks and input rows; no arbitrary-length caller array as one fixed price; preserve dedup/conflict behavior                                                                |
| `#assignBatchCreatedAt` / `#maxPartitionKeyCreatedAt`      | Replace first-seen-key MAX/GROUP BY over active history with bounded exact top-1 access or maintained per-key cursor; original creation ordering survives restart                              |
| Native SQL enqueue function in migration history           | Same status/input hooks and fence checks as client writes; old SQL callers cannot bypass maintenance                                                                                           |
| `insertWorkflowStatus` and conflict reuse                  | Reconcile only committed native change, retain returned actual ID and existing owner; charge BEFORE-trigger work even when conflict resolves to a no-op                                        |
| `recordWorkflowOutput/Error`, CTE and fallback transaction | Preserve owner-qualified PENDING update and conditional output write; remove gate contribution and maintain terminal projection only on actual update                                          |
| `updateWorkflowStatus` / `setWorkflowStatus`               | Reconcile every changed status/application/version/queue/key/priority/creation/completion field, including recovery failure status                                                             |
| `deadLetterWorkflows`                                      | MAX_RECOVERY_ATTEMPTS_EXCEEDED is terminal; maintain completion eligibility exactly as actually stored, not assumed from status alone                                                          |
| `reenqueueWorkflowsForRecovery`                            | PENDING to ENQUEUED removes shared veto and adds membership; original executor/version/app scope; original bulk UPDATE needs bounded ordered steps                                             |
| Nonpartitioned and partitioned claims                      | ENQUEUED to PENDING; owner token, app adoption and version assignment may move projections; shared gate becomes visible atomically                                                             |
| `setWorkflowPriority`                                      | Reorder exact head access and invalidate observation without replacing stable membership ticket                                                                                                |
| `setWorkflowDelay`                                         | Preserve DELAYED-only condition; maintain due-time access and revisions                                                                                                                        |
| Debounce update plus input upsert                          | Preserve capped delay and name/class/app match; application COALESCE may change exact bucket; charge both writer guards                                                                        |
| `transitionDelayedWorkflows`                               | Due DELAYED to ENQUEUED, clearing debounced dedup key; use bounded due-time page and same-transaction hooks; original UPDATE is unbounded                                                      |
| `cancelTimedOutWorkflows(limit)`                           | Preserve native active statuses, deadline order and fixed limit; all returned IDs and status hooks paid                                                                                        |
| `cancelWorkflows` / `resumeWorkflows`                      | Preserve exact legal no-ops and existence checks; queue moves, completion reset and gate changes; arrays/descendant traversal must be bounded by actual admitted input                         |
| `rewindWorkflow`                                           | Preserve terminal precondition, event-history undo, stream sentinel/message/operation/output removal and conditional ENQUEUED update; its history work is additional, not one status-row price |
| `forkWorkflow` / `bulkForkWorkflows`                       | New actual IDs, original/fork guards, input and copied operation/stream/history/event rows; no aggregate copied history bound follows from one fork ID                                         |
| Application rename/adopt-unclaimed                         | Queues, schedules, version metadata, active status and terminal/status/operation batches all retain native ownership; move exact-app projection only, keep all-app projection consistent       |
| Version create/timestamp/owner adoption                    | Maintain latest lookup/revision; no per-version Ready rewrite and no version cap                                                                                                               |
| Input replacement and output/operation writes              | Existing eight-family fence/copy protocol applies even if queue eligibility is unchanged; their payload bytes cannot be priced as zero                                                         |
| Events/history/notifications/streams                       | Original owner checks, actual destination ID and ALWAYS guards; no workflow-wide row cap inferred from one operation/key                                                                       |
| `deleteWorkflows(ids,false)`                               | Remove input/output/operations/status and four FK-owned families; same-transaction new projection/contribution removal; leave child workflow statuses independent                              |
| Delete with descendants                                    | Not retention's path; recursive child discovery is separately bounded/authorized, never silently charged as false                                                                              |
| Direct SQL, COPY and restore                               | Native guards and contribution reconciliation execute for supported old writers; restored derived rows are not authoritative merely because they exist                                         |

All actual native status values remain meaningful. Only ENQUEUED contributes queue
membership, PENDING contributes the shared veto, DELAYED uses due-time activation,
and terminal status with NULL completion is excluded from retention. SUSPENDED and
all other native states must not be coerced into terminal or enqueue membership.

Permanent writer fences remain independent of execution-row lifetime. The installed
ALWAYS INSERT/UPDATE guards cover status, input, output, operations, events, event
history, destination notifications and streams. Status INSERT also guards parent
and fork source; UPDATE guards changed relationships and old/new actual IDs.
DELETE has no such writer trigger; its cascades and new removal hooks still cost
work. Never cascade away `workflow_writer_fences`, downgrade generation 2, remove
closure receipts or erase the restore-domain row during retention or migration.

### Bounded resumable coverage protocol

Use a separate native coverage record per family/restore generation, with a finite
committed source frontier and phase. It must not be a process-local boolean.

| Phase     | One admitted body                                                                                                 | Commit rule                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Install   | Create empty additive relations/indexes and native functions/triggers without renumbering SDK migration history   | Explicit migration payer and finite catalog/body prices required           |
| Capture   | Under native writer serialization, capture a committed source boundary/revision                                   | Never publish complete coverage here                                       |
| Scan      | Read at most 100 existing status IDs after the saved native PK boundary, projecting only required scalar fields   | Each row's actual derived writes and guards are prepaid before applying it |
| Reconcile | Lock one actual ID, compare current native revision and existing contribution/projection, apply the exact delta   | Native row and contribution serialize with concurrent old/new writer       |
| Advance   | Save last fully reconciled source position in the same transaction                                                | Error/rollback cannot advance coverage                                     |
| Repair    | Process one fixed dirty identity/revision; acknowledge only if still at that revision                             | A newer dirty revision survives old acknowledgment                         |
| Seal      | Verify source boundary, complete scan and all required current-domain writer/repair coverage under revision locks | Publish authoritative coverage only after these checks                     |

The 100-row page is the repository's existing bounded-job page unit, not evidence
that 100 copies of the missing body fit any current price. An implementation may
admit fewer rows but must expose incomplete progress. A native PK cursor over old
rows does not by itself cover later inserts whose textual IDs sort before it;
the installed same-transaction writer hook covers those arrivals. Concurrent delete
must remove or suppress stale backfill, not resurrect a projection after deletion.
Direct writes that lack the necessary hook leave coverage incomplete.

Backfill must inspect a fixed list of IDs and recheck each under its native lock,
not use a LIMIT query that slides arbitrarily past changed/locked rows. A batch
with unavailable identities records bounded incomplete progress/repair; it does
not certify completeness from a short page. Orphan input/output/operation/event
families require their own bounded inventory/reconciliation; status coverage alone
does not prove their absence. No startup sweep enumerates every orphan first.

The scan-frontier and commit-order rules need actual SQL and concurrency proof.
A trigger installed after an unprotected capture can miss the installation gap.
Installation must serialize the capture/enable transition with writers or record
that interval as untrusted and explicitly repair it before coverage publication.
Unbounded validation scans cannot be renamed a constant seal.

### Restore

The supported restore boundary preserves current permanent fences and advances
the installed writer restore generation before restoring/re-admitting work. Match
the existing domain revision/UUID in every contribution, coverage and epoch
observation. Invalidate old derived coverage and cursors; rebuild from current
allowed native rows with the bounded protocol. A restored projection cannot
reopen a closed actual ID. COPY, replication-role sessions and old executors still
meet the ALWAYS native fence protocol.

There is no guarantee for whole-database rollback that discards current permanent
closures. A new discovery generation cannot reconstruct lost authority. Restoring
native status and stale derived metadata in different phases must keep discovery
incomplete until reconciliation commits. Rotation itself, native restore writers,
dirty recording and every rebuild step require prices; restore is not a blanket
unmetered administrative escape hatch.

### Account-bearing copy inventory and authorized removal

| New copy                                                    | Reverse owner / deletion rule                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Contribution workflow ID, Session key and bucket references | One actual-workflow reverse key; remove in its authorized native delete transaction                                                       |
| Membership Session key, count and ticket                    | Shared owner union represented by current contributions; decrement exactly this workflow, remove only at zero                             |
| Bucket application/version/queue and allocator state        | Shared references; remove obsolete identity-bearing data only after no owned contribution/progress references remain                      |
| Epoch domain app/version/queue and stream references        | Bound to real polling domain; minimize obsolete identity-bearing state by an owner-approved lifecycle, not permanent scheduler tombstones |
| Retention projection and its 64 index entries               | One workflow reverse key; native row removal drops every associated index entry atomically                                                |
| Dirty/coverage/frontier records and any dictionaries        | Inventory actual identifiers and scopes; a progress table is not outside identity accounting                                              |

The existing `hasRetainedWorkCopies` probes exactly eight SDK families. It does not
know these new families. The existing identity History inspector likewise has an
explicit eight-family inventory. Both actual absence definitions and their original
reservations must be extended through their owners before anyone claims all-copy
absence. An SDK FK cascade over eight families cannot erase a ninth family's
identity-bearing cursor or dictionary copy by implication.

Keep reverse lookup bounded by the designed constant contribution multiplicity.
Removing a member/bucket shared with other executions must preserve their copies
and authority. It must not enumerate all workflows/versions referencing the same
Session to recompute a count. A per-workflow reference contributes a constant delta;
shared counters and reference lifetimes must be updated in that same transaction.
An aggregate node retaining an account's identifier after its last authorized
reference disappears is still a retained copy, even if it helps scheduling.

There is no installed owner-approved autonomous removal/readiness callable for
this enlarged inventory. Existing Source closure functions require their original
Source frame and History authority. Work cannot synthesize those from a balance.
This is an exact interface gap, not a reason to debit the existing Source frame
from an autonomous poll or to assign the hook a zero price.

## Literal accounting and full-path admission

### Actual axes and meanings

The existing native reservation vector is `(rows, points, statements, bytes,
engineRequests)`, from `semantic/identity-epoch-contract.ts`. Source's live frame
validates nonnegative safe integers and cumulatively debits those five fields.
Rows are charged design-visible native work, not merely returned rows. Reads and
writes both count; a row read and then changed can contribute both operations.
Points include unsuccessful indexed point/range-head attempts. Statements include
transaction control, nested native SQL and failed dispatches. Internal/exchanged
bytes need the complete actual operand bounds. PostgreSQL calls are not search
engine requests; the shown SQL-only bodies have engineRequests=0 because they
contain no such call, not because database work is free.

Source's separate Library ledger has eight axes: candidateKeys, nativeRows,
identityMetadataRows, emptySeeks, nativePoints, witnessKeys, statements and bytes.
Do not silently collapse these into the native five. A SQL-only queue body does
not by itself call a Library operation, so it has no Library dispatch; an approved
Source/Library hook would need its actual eight-axis receipt and parent composition.
The `engineWork` field on `SDK_TRANSACTION_FENCE_COST` is a differently named
adapter field; it cannot be mistaken for an extra native balance or omitted cost.

The current Source native defaults/hard ceilings are 577 rows, 577 points,
173 statements, 630,784 bytes and 0 engine requests. Its Library defaults are
1 candidate key, 0 identity metadata rows, 8,192 native rows, 128 native points,
1 witness key, 128 statements, 1,048,576 bytes and 2 empty seeks. These are facts
about a different existing admission, **not** proposed Work scheduler allocations.
The directory sub-envelope and its child split also confer no Work budget.

### Exact available single-attempt SDK literals

The installed adapter `work/sdk-retirement-fence.ts:SDK_MAINTENANCE_DISPATCH`
names the exact supported one-attempt dispatches below. The native body in the
installed patch performs these steps and calls reserve before dispatch. These
literals are existing source declarations for that body's narrow custody bounds:
64 operation outputs, 8 event keys, 64 event-history rows, zero notifications and
zero stream rows, payload 65,536 bytes, metadata 4,096 bytes, and its actual
writer-state input validation. They are not a generic retention deletion tariff
or independently executed physical evidence. Their declared byte accounting must
also be distinguished from the stricter inclusive internal-byte requirement below.

| Dispatch                          | Rows | Points | Statements |  Bytes | Engine requests |
| --------------------------------- | ---: | -----: | ---------: | -----: | --------------: |
| Prepaid possible rollback         |    0 |      0 |          1 |      0 |               0 |
| BEGIN                             |    0 |      0 |          1 |      0 |               0 |
| Settings                          |    1 |      0 |          1 |    128 |               0 |
| Native writer-state lock/check    |    4 |      2 |          4 |  8,192 |               0 |
| Retire native writer              |    8 |      5 |          9 | 32,768 |               0 |
| COMMIT                            |    0 |      0 |          1 |      0 |               0 |
| Delete input                      |    1 |      1 |          1 |      0 |               0 |
| Delete output                     |    1 |      1 |          1 |      0 |               0 |
| Delete operation outputs          |   64 |      1 |          1 |      0 |               0 |
| Delete status and native cascades |   73 |      5 |          5 |      0 |               0 |

Full componentwise sums of those declared finite dispatch paths, including
possible cleanup, are:

```text
retire:
 rows       = 0 + 0 + 1 + 4 + 8 + 0                  = 13
 points     = 0 + 0 + 0 + 2 + 5 + 0                  = 7
 statements = 1 + 1 + 1 + 4 + 9 + 1                  = 17
 bytes      = 0 + 0 + 128 + 8192 + 32768 + 0          = 41088
 engineRequests                                      = 0

delete under the narrow verified inventory:
 rows       = 0 + 0 + 1 + 4 + 1 + 1 + 64 + 73 + 0   = 144
 points     = 0 + 0 + 0 + 2 + 1 + 1 + 1 + 5 + 0     = 10
 statements = 1 + 1 + 1 + 4 + 1 + 1 + 1 + 5 + 1     = 16
 bytes      = 128 + 8192                             = 8320
 engineRequests                                      = 0
```

The 73 status/cascade rows are status 1 + events 8 + history 64 + notifications 0

- streams 0. Its five points/statements are the keyed delete plus four FK families.
  The original payload/operation tables have no cascading FK and are explicitly
  deleted. Stored payload bytes remaining inside PostgreSQL are not wire output
  bytes; explicit payload conversions and new copy work would still count where
  their actual accounting definition includes them. No DELETE writer guard was
  added by the existing patch, so one must not charge an imaginary INSERT/UPDATE
  guard there or forget newly proposed actual removal triggers.

The native state check's four rows/statements include its outer call, restore
domain lock, actual fence lock and returned observation. The retirement body
includes status locking, fence upsert, owner-token revocation, nested status writer
guard, permanent closure update and return/control work. The existing literal is
evidence for those exact bodies and bounds; reproducing its value on a changed
body without rederivation would not be evidence.

### Exact available History inspection composition

`history/durable.ts:inspect` first prepays a read-only transaction/control envelope
`(1,0,4,128,0)`. It then probes a literal family inventory, each at LIMIT plus one,
charging `(limit+1,1,1,(limit+1)*80,0)` before the query:

| Family        | Supported count | Probe count including overflow sentinel |
| ------------- | --------------: | --------------------------------------: |
| Status        |               1 |                                       2 |
| Input         |               1 |                                       2 |
| Output        |               1 |                                       2 |
| Operations    |              64 |                                      65 |
| Events        |               8 |                                       9 |
| Event history |              64 |                                      65 |
| Notifications |               0 |                                       1 |
| Streams       |               0 |                                       1 |
| Total         |             139 |                                     147 |

The body returns scalar inventory/size/validity observations, not all payloads.
Its actual existing declared reservation total is therefore:

```text
inspect = (1+147, 8, 4+8, 128+147*80, 0)
        = (148, 8, 12, 11888, 0)

inspect + retire + delete + inspect
        = (148+13+144+148, 8+7+10+8, 12+17+16+12,
           11888+41088+8320+11888, 0)
        = (453, 33, 57, 73184, 0)
```

This last vector is a complete sum of the **four named sub-bodies only**, not of
the durable identity minimizer. That minimizer also invokes current Source consumer
maintenance, custody binding, role/readiness checks, History commands, Source and
SDK observations, sealing, guards, invalidation/wake and absence verification.
For example, available `AGENT_IDENTITY_HISTORY_GUARD_COST` is
`(92,87,11,40960,0)` and `AGENT_IDENTITY_HISTORY_ABSENCE_COST` is
`(9,9,9,0,0)`; `IDENTITY_HISTORY_COMMAND_CONTROL` is `(3,1,8,256,0)`.
They are charged in addition at their actual call sites. The role query explicitly
reads up to 65 and refuses more than 64. It does not authorize general workflow
retirement merely because an ID has few SDK child rows.

The inspector itself explicitly constructs `to_jsonb(bounded_row)`, renders
`value::text` and renders payload-stripped metadata before returning those scalars.
The 80-byte-per-result declaration does not derive bounds for those internal
materializations. Even under the narrow payload domain, they can exceed the scalar
wire result size; an overflow/oversize row is inspected before rejection. Thus
11,888 is the existing reservation sum, **not** an inclusive proof under this
research contract's internal-byte requirement. The same distinction applies to
the four-sub-body sum. Do not use it as an admitted new price merely because its
arithmetic is exact. A complete new derivation needs actual bounded internal
operands and the precise accounting interpretation, including the rejection path.

The full currently available identity body cannot be called autonomously with Work
money: `advanceAgentIdentityConsumerMaintenance`, recorded History authority and
owner.readiness remain original owner operations. Their existing Source-only
composition is not the missing autonomous hook. Assigning the four-body sum to
the scheduler would both omit work and invent authority.

### Concrete algorithm counts versus unavailable prices

The following counts come from the explicit algorithms above. They are deliberately
not labelled complete NativeAmount vectors: a query count is not a row/byte price,
and a fixed result limit is not a plan proof.

| Finite proposed body               | Traceable bounded operands                                                                                                                               | Additional work that must be included before admission                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Queue epoch open                   | Domain 1; stream rows at most 4; bucket high-waters at most 4; queue revision 1; named latest heads at most 2; fixed restore/coverage observations       | Exact SQL/function bodies, native locks/control and all byte widths                                                     |
| One Session visit                  | Member seek 1; partition lock 1; shared gate probes at most 2; head branches at most 4; fixed candidate lock/read/update at most 1 each; cursor update 1 | Contribution trigger, permanent guard, bucket/dictionary transitions, version/coverage validation, rollback, copy hooks |
| Membership reconciliation          | One old contribution; at most 2 removals + 2 additions; at most 2 new memberships/allocator increments; at most 2 affected queues                        | Exact existing/new-path SQL, zero-count delete, unique conflicts and native ID/payload conversion bytes                 |
| Terminal projection reconciliation | At most one prior and one new projection row for one status; 64 expression index entries per present row                                                 | All index descents/writes, reverse inventory, old/new bytes and native writer guard                                     |
| Retention selection                | At most 64 disjoint completion prefixes × 2 app branches + 1,000 refills = 1,128 head seeks                                                              | Up to 1,000 native fixed-ID predicate/fence rechecks; merge/control/frontier bytes; owner readiness                     |
| Retention native deletion          | At most 1,000 IDs; 4 explicit delete statements per native batch plus native FK descendants                                                              | No general finite per-ID descendant bound exists in this contract's original native input domain                        |
| Coverage page                      | At most 100 source IDs; one actual reconcile per reached ID; frontier commit once                                                                        | All per-row writer/copy/index/owner costs and all failed/rollback paths                                                 |
| Repair step                        | One dirty identity; current native revision; one exact reconciliation; conditional acknowledgment                                                        | Newer dirty revision, locks, no-op/error and nested hooks remain paid                                                   |

Every point/seek above counts even when empty, busy or incompatible. Rows read for
the four heads are additional to rows visited by membership, version, coverage,
gate and fence queries. A status UPDATE also executes its actual permanent guard
and proposed contribution/projection maintenance. Returning a single workflow ID
does not make that update a one-row total price.

If a proposed full path consists of dispatches D1 through Dk with mutually exclusive
success/error branches, its reservation must use the componentwise maximum over
the complete finite paths, summing all reached operations on each path. Include
the possible rollback slot even on the successful parent allocation. A second
attempt consumes a second full attempted path from the **same** original remaining
balance. Neither rollback nor returning fewer IDs refunds a dispatch.

For the known narrow bodies, two retire attempts require at least
`(26,14,34,82176,0)`; two deletes require `(288,20,32,16640,0)`.
These products derive from an explicit repetition count of 2. An SDK retry loop
with no finite attempt count has no corresponding complete finite literal from
these operands, even if every individual query is a point operation.

No complete full-path vector can currently be evaluated for Q0–Q12 or R0–R8.
Writing `headCost + hookCost` without a bounded actual hook operand would not
resolve this. The table identifies exactly which bodies must replace those
unavailable entries; it is not a symbolic default allocation proposal.

### Input limits and precise counterexamples

The repository's bounded-job contract has page 100, segments 100, deadline 5,000 ms,
at most eight continuation scalars/2,048 JSON bytes, and 4,096-byte workflow
arguments/results. Those constraints apply to that supported repository job path.
They are not a native SDK-wide schema constraint. Original SDK migrations use TEXT
for workflow ID, queue/partition key, application/version, input/output and many
metadata fields. Class/configuration names have separate varchar limits; int4
function IDs and stream offsets do not imply 64 total children. The added native
writer-state port validates IDs at 1,024 UTF-8 bytes; original enqueue and arbitrary
native retained rows do not acquire that bound retroactively.

PostgreSQL TEXT is not a user-domain finite short key; the implementation has an
engine value limit. See [PostgreSQL 18 character types](https://www.postgresql.org/docs/18/datatype-character.html).
Even a finite engine value limit does not establish the repository's intended small
uniform byte reservation, or bound all child-row multiplicities. Engine build,
page size, collation and original accepted input domain must be named when deriving
conditional bounds. Do not substitute 4,096 bytes or the new 1,024-byte port bound
for every existing native TEXT operand.

Concrete source counterexamples are:

1. **Generic delete versus the narrow literal.** Give one retained workflow 65
   distinct operation outputs, each with a legal distinct int4 function ID. Native
   `deleteWorkflows([id],false)` deletes all 65. The narrow delete component above
   prepays only 64. With K legal child rows its actual work includes K even though
   the selected ID count is one. This refutes using that literal for generic
   retention, not every possible finite bounded deletion design. Notifications,
   event/history and stream cardinality can independently exceed the narrow limits.
2. **Bulk delayed activation.** The original
   `transitionDelayedWorkflows` is one UPDATE with no LIMIT. K due DELAYED rows in
   the actual application's scope cause K status updates and their native guards.
   One statement is not a fixed-row action. A finite due-time page body must replace
   it wherever an autonomous bounded caller invokes it.
3. **Hidden bytes in a guard.** Installed
   `guard_workflow_writer_row` extracts the ID through `to_jsonb(NEW)` and, on UPDATE,
   `to_jsonb(OLD)`. These expressions materialize more than the ID, including wide
   native text fields. An input/output/status row with a legal large TEXT payload
   defeats a price derived only from a 36-byte ID. This is explicit body work, not
   excluded MVCC visibility. A compatible guard using direct actual-ID fields can
   avoid this conversion, but would be a new body requiring review and derivation.
4. **Composite prefix index width.** A terminal status with no active partition can
   have individually valid, incompressible roughly 1,500-byte ID and application
   strings. An ID PK and separate owner access can accept each; a new combined
   application/prefix/created/ID B-tree item can exceed the engine's per-item limit.
   The exact PostgreSQL source `BTMaxItemSize` derives that limit from BLCKSZ and
   tuple/page headers, approximately one third of a page. Thus the proposed
   composite index is conditional on original-domain fit; do not impose a new
   input truncation, hash collision assumption or user-key cap to conceal it.
5. **Unbounded original retry wrapper.** Native deletion and several administrative
   methods use `@dbRetry`. A changed wrapper reserving only one attempt but calling
   that original retried method can execute multiple BEGIN/delete/rollback paths.
   Original finite Work deadline must reach an actual one-attempt body; a timer
   checked only before entering the wrapper is insufficient.

These are independent of the solved absent-Source-frame question. They do not
assert a universal lower bound, import the earlier report's conditional OMv
discussion as a theorem, or claim that one rejected prefix/dictionary design
exhausts possible implementations.

## Exact unavailable interfaces and remaining receiving work

This is the admission checklist for the manager's normal substantive receiving,
not a request to repeat the settled accounting-owner exchange.

| Required artifact              | Available at source pin? | Exact missing item                                                                                                                                        |
| ------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default autonomous Work issuer | No                       | Actual startWorker/composeWork/SDK option, capacity source, finite deadline policy, positive inclusive price map and settlement implementation            |
| Funded native runner ABI       | No                       | Required invocation passed through setup, registry, schedulerLoop, runQueuePoll, pollQueue, native selectors/claims and cleanup; no unmetered default     |
| Bounded native queue bodies    | No                       | All contribution/clock/epoch SQL, locking, fixed rechecks, one-attempt native claim and three-outcome caller propagation                                  |
| Native mutation funding        | No                       | Each old/native writer's actual parent payer and inclusive charge for added hooks before I/O; an AFTER trigger alone supplies maintenance, not funding    |
| Retention selector             | No                       | Concrete admissible original-domain access representation and body, including 64-index cost acceptance or a better proved representation                  |
| Funded native deletion         | Narrow port only         | General `deleteWorkflows(ids,false)` one-attempt dispatch with complete per-ID inventory, transitive deletion/cascade/removal prices and owner authority  |
| Autonomous Source/History hook | No                       | Owner-approved callable accepting the real transaction, explicit Work payer, original deadline and exact authority; complete nested five/eight-axis costs |
| Enlarged copy absence          | No                       | Actual owned inventory and same-transaction removal for all new families; updated original absence probes and their reservations                          |
| Migration/repair/restore body  | No                       | Actual bounded install/capture/scan/reconcile/seal bodies and prices, writer-install gap handling, current restore-domain authority                       |
| Counter/dictionary uniformity  | No                       | Exact original key-domain representation, collision/width handling and bounded ticket/revision rollover preserving active domains                         |
| Whole physical proof           | UNRUN                    | Original fixed populations, budgets, plan capture, write amplification and mounted consumer proof                                                         |

The existing patched `maintainWorkflowOnce` and
`checkWorkflowWriterStateInTransaction` really are installed narrow callable
surfaces. They must not be conflated with the unavailable generic ports above.
The separate WorkClient pending locator and owner-hook work has no satisfied
source-presence receipt in this launch context. No implementation from it is
assumed, imported or made a scheduler prerequisite.

The unresolved questions are concrete: which autonomous owner body may remove
the new copies, what bounded original-domain native representation is admitted,
and what full path vector that actual body derives. If the manager chooses a
domain restriction, staged generic deletion authority or a different physical
retention representation, that adoption belongs in the owning document with its
owners. This report does not make such a product decision or weaken existing
inputs. Numerical ownership itself is already decided.

An owner may instead supply a maintained per-workflow inventory with exact child
counts/bytes, charged by every original writer. That could support dynamic prepaid
deletion or an explicitly authorized bounded staged-removal protocol. It would
need the complete bounded inventory lookup, counter limits, writer funding,
rollback/recovery and final native deletion composition. A COUNT scan performed
before reserving its K child rows merely moves the unpriced work earlier.
Likewise, a large generic child-count ceiling guessed from machine capacity is
not a native contract bound. No such inventory or staged authority is claimed
installed here.

## Future complete proof design — no execution authorized here

The following is the future proof plan for a completed producer. It preserves the
original source specification and frozen tests. The incompatible one-fixed-poll
find-or-prove-empty queue assertions alone were replaced by the adopted three
outcomes and finite-epoch proof. This report authors no executable test, changes
no fixture and runs none; that is the explicit research-only launch scope.

### Retention matrix

Keep the actual native DBOS status/input/output/operation/event/history/
notification/stream relations, not a stand-in selector table populated without
native writers. Grow each original long-lived/recent history axis from 49,152 rows
at scales 1, 4 and 16. Keep separate eligible warm-up and measured populations,
ten selected/deleted short-batch rows and 1,000 full-batch rows. Retain frozen
constant rows/statements and logarithmic blocks with original indexProbes 40 and
4,000, respectively. A new projection's own writes/rows must also be captured.

Keep the source specification's creation/completion inversion: many older-created
but newly completed rows must not force a creation scan, and old-completed rows
must not substitute completion order for original creation order. Independently
vary irrelevant history depth, eligible result size, child-row inventory and
application distribution. Every four-status and NULL-completion case is required;
strict equality at both cutoffs must be excluded. Check defaults, days 7 and 365,
invalid policy refusal, fixed original cutoff through continuation and all original
short-batch/fence controls.

Observe the actual native `deleteWorkflows(ids,false)` and native closure path.
Children remain independently retained. Retention cannot resurrect a permanently
fenced ID through resume, rewind, fork-source reuse, late input/output writes,
COPY or restore. A legal no-op must still meet fence semantics. Failed/rolled-back
deletes retain their full attempted charge and advance no durable progress.
Include a short incomplete page followed by further eligible work, a short
authoritatively exhausted page and a 60-batch pending continuation as distinct cases.

Capture selection reads and native writes separately. A prefix projection may
have bounded live reads while its 64 index changes fail the original physical
ceiling; that is a real failure of this candidate, not grounds to alter the ceiling.
Preserve real retained history and actual native trigger work in warm-up and probe
capture. No plan assertion may erase failed statements or unobserved work by
recording it as zero. Engine MVCC visibility exclusions remain the original ones.

### Queue matrix

Keep 16 units and populations 256, 1,024 and 4,096. Keep the actual worker,
composeWork, DBOS runner and native systemDatabase selector/claim calls. A unit
test calling the proposed helper directly does not prove native installation.
Preserve original fixed returned slots, native owner token, Session partition,
same-Session priority/creation/ID order and exact app/version controls.

Add the required independent V/N grid: vary the number of distinct exact versions
while fixing Session population, then Session population while fixing versions,
and vary incidence separately. A new PENDING row in a different application or
incompatible version must veto the same actual Session without V writer updates.
Populate blocked, incompatible, eligible and busy members independently; one paid
visit must stay bounded even if it finds no claim. Latest-version changes must
include unclaimed version rows, peer deployments, no registered version, exact
older versions and NULL versions. Include the native nameless-app behavior if that
mode is claimed supported.

For every poll record one of claim, incomplete or authoritative empty. Exhausting
a step budget, missing coverage, an epoch boundary or a lost fixed candidate must
be incomplete. Verify ordinary subsequent paid scheduling continues without
renewing the exhausted invocation. Test empty-seal revision races separately from
fairness: dirty observations need not certify empty, but cannot reset progress and
starve a continuously eligible member.

Construct arrivals just beyond captured ticket high-waters and continue arriving
while a fixed eligible Session waits. Force process restart between every major
cursor transition. Verify committed frontiers only advance and eventually present
that Session to native claim under the stated lock-availability assumption.
Force out-of-order sequence allocation as a negative control to distinguish a
commit-ordered allocator from a merely increasing sequence. Include membership
deletion/reinsertion, gate changes, bucket creation, same-Session head changes,
latest-domain changes, domain lock conflict and restore invalidation.

Exercise the original writer/race/rollback controls through each inventory entry:
enqueue and conflict, old/native SQL writer, priority and input update, app/version
movement, claim versus cancel/recovery/delay/completion, rewind/fork/delete and
restore. A fixed candidate lock loss may not slide past its head. Cross-application
PENDING insertion must serialize with the actual native claim. An error after an
earlier committed claim must still dispatch that claim with the correct owner token.

### Funding, coverage and mounted Commerce

Verify the actual default launch admits before first affected I/O, with no
test-only injection. Missing/unknown action, wrong Pool, settled invocation,
expired original deadline, insufficient any-axis balance and unapproved hook all
refuse before dispatch. All nested SQL/control/index/frontier/copy bytes and
failed/rolled-back/repeated paths remain in the same receipt. Debit each axis
independently so a missing byte or point charge cannot hide behind a row total.
Keep Source-called maintenance on the exact original frame and aggregate, including
its own child/Library receipts; missing Source never selects Work fallback.

Observe native migration through bounded pages while old/new writers race. Crash
after effect but before commit, after commit but before result acknowledgment,
and during revision acknowledgment. Replays cannot duplicate contributions or
skip dirty identities. Cover pre-mapping orphans and every new identity-bearing
family in the original owner absence proof. Restore must preserve fences, advance
the actual writer generation and reject stale coverage/closure observations.

Finally use mounted Commerce's actual dispatch and workflow behavior, including
replay/authentication, deterministic identities, financial exactly-once and all
original consumer controls. A scheduler opportunity does not authorize a duplicate
financial effect or Source lifecycle transition. Preserve all unrelated frozen
acceptance. Native, growth and mounted-consumer execution is deferred to the
manager's integrated proof boundary; this report supplies no passing receipt.

## Decisions made in this research

- Treat the full launch contract and complete current owner agreements as authority;
  retain stopped evidence as history, without reopening the solved funding owner.
- Pin native release analysis to npm's exact Git revision, and distinguish the older
  reused reference and installed local fence patch explicitly.
- Use exact membership plus paid finite visits as the candidate queue direction;
  reject eager per-version Ready maintenance and unlimited residual polling.
- Treat end-of-epoch and short-result conditions as incomplete unless separately
  sealed authoritative observations prove emptiness/exhaustion.
- Show an exact fixed-depth completion-prefix retention direction, disclose its
  64-index write amplification, migrate through an empty native projection, and
  withhold admission until key-domain and original physical limits are proved.
- Preserve original Source frame and mutation/copy authority; do not infer installed
  WorkClient ports or autonomous owner hooks from lifecycle prose or empty receipts.
- Publish exact known narrow literal sums, and mark unavailable full native operands
  rather than manufacture a positive default admission price.

There are no tracked changes outside this report. The sole external administrative
write is the permitted `.reference/INDEX.md` update and the exact DBOS release
reference clone, retained for subsequent work. They are research evidence, not
product source or an additional implementation task.
