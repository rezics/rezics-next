# Session refresh recovery and native receipts

Research evidence, inspected 2026-10-28; recommendations require adoption. Queue, Checkout and financial authority remain fixed.
This report establishes neither implemented behavior nor a native gate. Only report existence is checked.

## Finding

Use one combined fresh-read/apply step on the Session partition, retaining the existing native intent receipt.
That composition suffices after physical executor death and ordinary serialized retries, but does not alone
cover a cancelled, timed-out or recovered execution whose user code remains alive. DBOS fences its own
checkpoints, not the separately committed `runCommand` effect. A native compare-and-set boundary is necessary
if these supported operations remain available. The smallest candidate uses the existing order revision:
commit a revision advance before reading provider truth, then require that revision under the order lock
when applying. Even a business no-op must leave that preceding advance committed. This is a recommendation,
including its extra real mutation/event cost; it is not an adopted new protocol.

## Sources and provenance

- Repository source: commit `997aefa21d8de4b1f5be8b2d741e28ccc01e5b93`, AGPL-3.0-only (`package.json`).
  Paths below are relative to `services/kernel/` unless stated otherwise; no sibling report was consulted.
- Installed `node_modules/@dbos-inc/dbos-sdk/package.json`: `5.4.6-preview`, MIT (`LICENSE`).
  [Official npm metadata](https://registry.npmjs.org/@dbos-inc/dbos-sdk/5.4.6-preview) reports
  `gitHead=980dc55095f445b189aecb59e7f3334345179f65`; its
  [published artifact](https://registry.npmjs.org/@dbos-inc/dbos-sdk/-/dbos-sdk-5.4.6-preview.tgz)
  has integrity `sha512-91vg0zlcKYw33RB84ABeaBIxIcJ0ndVyggMMM0NRYfltTVsDr/BwDn5CJodTy3LFd3RBBXF+pI+DhRLYpdRHmw==`,
  matching `bun.lock`. The artifact was read in memory, never installed or executed. Its installed
  `system_database.js`, `dbos-executor.js`, `wfqueue.js`, `client.d.ts` and `LICENSE` are byte-identical.
- Installed source prefix below is `node_modules/@dbos-inc/dbos-sdk/dist/src/` (abbreviated **SDK**).
  SHA-256: `system_database.js` = `9769d642e1d9db8ee1da30dd546349f7f4d1d61e932d654767a1f4978c290516`;
  `dbos-executor.js` = `11b1c23302ef19696a5f737cc9378f52ab11418a48cf0242a49caf3e9d1a909e`;
  `wfqueue.js` = `0b28dac0cbd0aef345ff6b1c7c2dc3a141c075b095e40b14abbf1328bd9eeeb6`.
- Reused source clone: main checkout `.reference/search-worker-outcome-harness/dbos-transact-ts`, already
  indexed in `.reference/INDEX.md`, commit above, MIT. Its placeholder package version alone proves nothing;
  artifact provenance establishes the correspondence. Read its `src/system_database.ts`, `src/dbos-executor.ts`
  and `src/wfqueue.ts` alongside the installed JS. Permanent upstream links:
  [system database](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/system_database.ts),
  [executor](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/dbos-executor.ts),
  [queue runner](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/wfqueue.ts).
- `stripe` is pinned to `23.0.1`; inspected installed `esm/resources/Checkout/Sessions.js`,
  `esm/RequestSender.js` and `LICENSE` (MIT). Provider endpoints and behavior are checked against current
  [Session retrieve](https://docs.stripe.com/api/checkout/sessions/retrieve),
  [Session list](https://docs.stripe.com/api/checkout/sessions/list),
  [refund list](https://docs.stripe.com/api/refunds/list), [dispute list](https://docs.stripe.com/api/disputes/list)
  and [webhook documentation](https://docs.stripe.com/webhooks). Documentation is linked, not vendor code to port.
- Current official DBOS references: [queues](https://docs.dbos.dev/typescript/reference/queues),
  [methods](https://docs.dbos.dev/typescript/reference/methods),
  [steps](https://docs.dbos.dev/typescript/reference/workflows-steps),
  [client](https://docs.dbos.dev/typescript/reference/client). Installed code controls version-specific findings.
  PostgreSQL 18 [locking](https://www.postgresql.org/docs/18/explicit-locking.html) and
  [isolation](https://www.postgresql.org/docs/18/transaction-iso.html) explain the transaction proof;
  PostgreSQL uses the [PostgreSQL License](https://www.postgresql.org/about/licence/).

## Verified application boundary

`src/commerce/work.ts:46–98` registers separate `commerce.clock`, `commerce.readCheckout` and
`commerce.applyCheckout` steps. `sync` saves the clock before the provider call. Event children currently
use `WORKFLOWS_QUEUE`; expiry and reconciliation also call `sync` directly and skip paid orders.
`src/work/queues.ts` already defines `effects={workerConcurrency:8,partitionConcurrency:1}`.
`src/events/effects.ts:81` supplies the actual nested `enqueueOptions:{queuePartitionKey:...}` syntax.
Its `${effect.name}:${partition}` keys belong to ordinary effects; refresh needs a distinct Session namespace.

`src/commerce/commands.ts:349–418` already uses `commerce.checkout.apply`, digest `{orderId}` and
`wf:{workflow}:apply`. The stable intent is deliberately independent of provider response bytes.
It validates the Session/order binding, then runs settlement/benefit/transaction writes together with
the native receipt/outbox. `Unchanged` throws out of the command and rolls back: no successful observation
is recorded. `src/commerce/settlement.ts:67` still rejects a strictly older `observedAt`; equal times pass.
No-op decisions do not update `observedAt`; timestamp removal alone exposes the cases below.

`src/command/command.ts:406–619` uses a separate SERIALIZABLE transaction, receipt lookup before the body,
native partition fencing and a receipt/outbox commit after the body. A receipt replay bypasses that body.
Its core partition fence guards routing/writability, not provider observation order. `noEffect` explicitly
asserts no domain writes. DBOS and core sharing one database/pool does not make their transactions atomic.
`src/commerce/store.ts:284–365` locks order and entitlement revisions for a changed decision only;
that protects competing native writes, but the revision is currently read *after* the provider read.

## What partition concurrency actually guarantees

SDK `wfqueue.js:675–718` selects the batched partition-concurrency-one path for this queue configuration.
`system_database.js:2844–2988` finds one ENQUEUED head per partition, excludes partitions with PENDING rows,
locks the fixed candidate set with `FOR UPDATE SKIP LOCKED`, rechecks status/queue/key/version and atomically
marks claimed rows PENDING with `owner_xid`. Heads order by priority, creation time and workflow UUID.
`workerConcurrency` is per executor; PENDING exclusion supplies cross-executor partition exclusion. The general path
at `2670–2840` also counts PENDING rows and uses transactional conflict handling for shared budgets.

| Situation | Verified guarantee and limit |
| --- | --- |
| Normal execution | One admitted PENDING workflow per queue/Session key; ordinary awaited read then apply bodies serialize. Different keys may run concurrently. |
| Real process death | The JavaScript body is gone. PostgreSQL can still finish or roll back an already submitted transaction; native locking/receipts must settle that ambiguity. |
| Executor recovery | `reenqueueWorkflowsForRecovery` (`1143–1160`) changes matching PENDING rows to ENQUEUED and clears ownership. Queue admission runs again. This is not a physical-process-death certificate. |
| Failed workflow | Uncaught failure records ERROR and ends PENDING occupancy. Pending recovery does not retry ERROR. Maximum recovery exhaustion is a separate terminal status. |
| Resume | `resumeWorkflows` (`1391–1425`) ignores SUCCESS and ERROR; it resets other existing statuses, including CANCELLED/exhausted/PENDING. Missing IDs throw. Default is the internal queue, not the original queue. |
| Fork | `bulkForkWorkflows` (`1695–1838`) creates a new identity, copies outputs with function ID below the cut, and leaves the original runnable. Default queue is internal; partition key defaults to null. |
| Rewind | `rewindWorkflow` (`1606–1688`) requires terminal status, deletes outputs from the cut onward and re-enqueues the same ID. Cancel-first does not prove the old body stopped. Queue/key default to internal/null. |
| Cancellation | `cancelWorkflows` (`1363–1387`) sets CANCELLED and clears owner/queue on non-SUCCESS/non-ERROR rows. The partition's PENDING occupancy disappears immediately. |
| Workflow timeout | `cancelTimedOutWorkflows` (`2619–2646`) cancels active rows similarly; cancellation is status, not forced termination of user code. |
| Step timeout | Executor `601–634` races the attempt against a timer. It can retry while the abandoned async body is alive. Exhaustion can record ERROR and free occupancy. |

Cancellation watches expose `DBOS.stepStatus.cancelSignal`; `timeoutSignal` belongs to each step attempt.
The executor awaits an uncooperative body on ordinary cancellation, so that process may still count it
against its local worker budget. Other workers, or spare local capacity, can nevertheless admit the next
Session workflow after the DB row leaves PENDING. Step timeout discards the late result without joining
the body; a retry can overlap even while the *same* workflow remains PENDING. Both therefore permit slot
reuse before provider/PG work is gone. See SDK executor `588–730` and the official step-timeout reference.

SDK `recordOperationResultInternal` (`3831–3891`) locks/checks `owner_xid` before writing a step result;
workflow outcome recording (`1107–1140`) additionally requires PENDING. A superseded execution parks and
adopts the recorded outcome (`dbos-executor.js:410–520`). This prevents an obsolete DBOS acknowledgement.
It cannot undo an earlier independent native commit. Checking `cancelSignal` or status before that commit
has a race: cancellation can commit after the check. Physical shutdown, cooperative abort, DBOS ownership,
step memoization and native effect authority are five distinct facts.

`client.d.ts:209–246` confirms resume accepts only `queueName`; fork/rewind also accept `queuePartitionKey`.
Resume preserves the stored key, but cancellation cleared the queue. Explicitly resume onto `effects`;
explicitly supply both queue and Session key for fork/rewind. A completed combined step copied by a fork means completion replay, not a new refresh. Rewind cannot undo core receipts or financial transactions.
The client warns about independent datasource checkpoints; core commands here are not a DBOS datasource.

## Counterexamples and crash boundaries

These are source-derived sequences, not reproduced failures. Label native state N and provider snapshots A/B.

1. **Old read plus newer business no-op:** N is already paid with an active benefit. Workflow W durably saves
   A containing a revoking dispute without withdrawals, then crashes before apply. Cancel W to free PENDING;
   the dispute is won. V reads fresh B (active benefit, no new balances) and is a business no-op.
   V throws `Unchanged`: neither receipt nor observation advances. Resume W onto effects; A's time still follows N's.
   The executor returns the stored read, apply uses W's unused receipt, and settlement revokes.
   Session queue admission serializes the executions but cannot refresh the saved read. Even strictly
   greater B time would not help because V did not persist it. The exact HTTP fixture sequence is
   `dispute(sessionId,{withdraw:false})`, then `updateDispute(id,'won')`: no reversal is created without a
   withdrawal (`fake-stripe.ts:251–254`). This example needs neither invented Stripe versions nor balances.
2. **Later refund plus cached paid fork:** W saves paid A without refunds; cancel W. Another refresh applies full
   refund B and revokes the benefit. Fork W at its apply step, explicitly onto the same Session partition.
   The copied read is A; the fork has a different receipt key. With equal observation times, current
   settlement restores the benefit. With timestamp ordering removed, no clock assumption is needed.
   Ordinary `resumeWorkflow(ERROR)` would not execute this sequence: ERROR resume is a no-op; fork/rewind
   or recovery from a genuinely PENDING crash is the applicable API.
3. **Combined step alone, live obsolete body:** W reads A and is delayed before native apply. Cancel W:
   SDK clears PENDING/owner/queue but does not stop its body. V reads B and makes the newer no-op above
   (or applies a refund with equal/backward times). Release W: `runCommand` can commit A with W's unused intent
   receipt. Its later DBOS step-output write fails ownership, *after* the native effect. Step timeout can
   produce the same sequence with overlapping attempts and one workflow ID; a no-op V leaves no receipt
   for that ID either. An ERROR terminal result can coexist with a late native effect.

With one combined step and no live overlap, crash after provider read/before native commit leaves no
successful step result, so recovery reads Stripe again. Crash after native commit/before DBOS acknowledgement
also reruns the body and may read again, but the stable `{orderId}` receipt returns the prior effect.
Do not hash the refreshed snapshot: recovery could then conflict with its own committed intent.
A completed combined step replays as a whole. SERIALIZABLE alone cannot fix the live case: W can start after V ends,
so there is no database conflict linking A's older external read to V's newer read.

## Minimal native composition recommended for adoption

Retain queue ordering for the ordinary case; add a narrow native authority for overlapping recovery attempts.
Use existing `purchase_order.revision`. These signatures are proposals, not existing exports:
`claimCheckoutRefresh(orderId,sessionId)` returning the committed revision, and a required fence argument
on `applyCheckoutSnapshot(snapshot,intent,{orderId,sessionId,revision})`.

1. Acquire process capacity before provider I/O, resolve only the native anchor, then run a short buyer-home claim.
   Point-read/lock the order; require its immutable recorded Session. Increment revision using a conditional
   PK update; preserve settlement and provider metadata. Emit the existing order-updated event through
   `runCommand`. This is a real coordination mutation, including when settlement will be unchanged.
   Claim receipt, if used, has a fresh attempt key generated *inside* the combined step invocation; it must
   not reuse the stable apply key. Internal SQL retries can reuse this one attempt key.
2. Finish that command and release its connection. Only then obtain the complete provider snapshot. Keep
   claim, provider read and apply inside one registered step; neither claim nor snapshot is a separate
   memoized step. A new invocation/timeout retry claims again and reads again. An ambiguous claim commit
   is harmless: abandon its token and claim anew before reading; never read with an unacknowledged token.
3. Apply with the existing stable native intent receipt. After receipt replay handling, lock the order
   *before* deciding even a no-op; require the Session and exact claimed revision under that lock.
   Then read the bounded settlement neighbourhood and use existing native writes/events/receipt atomically.
   A mismatch returns an explicit superseded outcome with no business write, or throws a nonretryable
   superseded error; it must never refresh the token while keeping the old snapshot. Prefer the explicit
   outcome so the successor owns convergence. Distinguish it from business unchanged in internal results.
4. Business unchanged may still roll back its apply transaction. The earlier claim remains durable and
   invalidates older tokens. A changed application increments revision again. No observer may decrement,
   reset or recycle revisions; overflow must fail closed. Missing/purged orders reject, never recreate.
   Ordinary unrelated revision advances conservatively supersede a refresh and need a fresh trigger if
   convergence is still required. Do not erase a live claim's authority while keeping an applicable order.

Proof: let C be a later claim and A an earlier token. C and A's apply both lock the same order row.
If C commits first, A observes a mismatch or gets a serialization failure; retrying the native transaction
with the same A token cannot authorize it. If A commits first, C cannot finish its claim until after A's
effect, and C reads provider truth only after claiming. Thus A never overwrites truth read after C.
This also holds when C's apply is unchanged, fails or is cancelled/timed out: C never releases the revision
back to A. No lease expiry, wall clock or cancellation-check/commit gap is involved.

Native replay returns a historical response without applying it. A later trigger has a new identity;
a rewind retaining the same identity does not erase its
native receipt. A fork cut before the combined step gets a new claim/read; a cut after it only copies
completion. Resume, recovery and timeout retries have no reusable claim token outside the step body.
No-op followed by crash can claim again safely. A crash after claim/before read leaves an inert revision.
Retain receipt authority for all supported replay lifetimes, or explicitly coordinate its pruning with
workflow retirement; deleting a receipt while old work remains replayable invalidates exactly-once claims.

This establishes supersession safety, not a stronger cancellation API. Bare DBOS cancellation can still
allow one final native commit if no later native claim has superseded it. If “cancel returned means no
subsequent native commit” is required, a native revocation command must advance the same revision under
the same lock before cancellation acknowledgement, and late bodies must not reacquire. DBOS's direct
operator API alone cannot provide that guarantee. This stronger control-plane contract needs explicit
supermanager review; this report does not silently promise it or disable supported recovery operations.

## Anchors, lifecycle, capacity and shared interfaces

There is no global Session-to-order lookup in the native schema. `store.readOrderBySession(client,route,id)`
requires a route; `db/commerce/schema.sql:423` indexes `(route,checkout_session_id)`, not Session alone.
Known-order repair already has order ID: `routeOf` then `store.readOrder` is one bounded point read.
For an event containing only Session, propose `readCheckoutOrderIdentity(sessionId):Promise<string|null>`
on the actual `StripePort` in `model.ts:156` (this method does not exist today),
implemented in `createStripePort`: retrieve that Session without expansions, extract `client_reference_id`
and `metadata.order_id`, require agreement and a routable order ID, then point-read/verify the native binding.
`findCheckoutSession(paymentIntentId)` uses filtered Session list with `limit:1`; charge both lookups when needed.
Revalidate full snapshot identity, mode and captured terms after the claim; a locator confers no buyer authority.

Keep event resolution/reconciliation/expiry orchestration on `workflows`. Every actual refresh child goes
to `effects` with ``enqueueOptions:{queuePartitionKey:`commerce:checkout:${sessionId}`}``.
Parents must not occupy effects capacity while awaiting their own effects children. Ordinary event/royalty
effects retain their current partition keys; release buyer reads before creator commands and provider calls.
`WorkClient` is the real `DBOSClient` intersection, and `WorkModule.register` already receives it; no new port
is needed there. New repair invocations require a bounded caller request identity, not reuse of the completed
initial order-reconciliation ID. Deduplication applies to a trigger, not to all refreshes of a Session.

Benefits and financial evidence are separate. Existing `shareAccount(tx,buyerAccountId)` in
`src/access/account-share.ts` locks the same account row against tombstoning and returns active or throws
`LifecycleDeniedError`. Orders are on the buyer's route. Invoke it before grant/restore; on that specific denial
suppress benefit/private-state recreation and recompute business unchanged while continuing permitted
order/transaction accounting. Do not treat database unavailability as lifecycle denial. Financial receipt
replay causes no new benefit. Do not gate financial truth on a buyer or creator being active. Existing
`createPayouts().recordTransactions` reads named buyer transactions, releases them, then writes creator-home
lines/statements with its own receipt. Terminal privacy/minimization still needs its owning lifecycle work;
this fence does not authorize retaining personal data or rebuilding erased account relations.

`effects.workerConcurrency=8` does not cap abandoned async bodies. For a physical resource bound, hold a
small process-local refresh permit until the *actual body* settles, including abandoned timeout bodies;
cap permits at the existing effects worker capacity and reject excess admission rather than create an
unbounded waiting list. This capacity guard supplies no ordering, recovery or durable state. Keep it around
the whole combined body and each resolver call, releasing before awaiting children; do not release on the DBOS
race ending. PG pool max is 10, acquire timeout 200ms; `runCommand` has a fresh 2000ms default deadline, local
statement/lock limits and partition gate. Never hold its connection across provider I/O. Signals reduce
waste but are not correctness authority. Default refresh steps need no new DBOS timeout; fencing must still
pass tests with an explicit timeout and uncooperative work. Replica count multiplies per-process capacity.

## Cost: anchor resolution and trigger dispatch

- Touches: at most one PaymentIntent-filtered Session list and one Session identity retrieval, one native
  order PK probe, one parent/child enqueue identity and DBOS input/status/step records; no order-history scan.
- Bound: logical provider calls <=2 before full read, with SDK network retries charged; 0–1 native order row.
  DBOS partition dequeue walks partition keys, not just this Session; its 8192 sweep cap bounds heads dispatched,
  not keys examined. DBOS fork/rewind additionally touch copied/deleted workflow history proportional to the cut.
- Growth check: grow unrelated orders, same-Session backlog, distinct Session partitions and workflow history
  independently. Measure examined rows/buffers/statements/bytes, copied outputs, enqueue/dequeue work and calls;
  do not infer a DBOS storage bound from a constant wrapper count. Reject oversized repair input before enumeration.

## Cost: one combined refresh invocation

- Touches: one claim command/revision/event, then one expanded Session read plus refund/dispute pages, then one
  apply command; native receipt, order lock, optional account share/entitlement, named transaction probes/inserts,
  partition counter/outbox. Each command has a separate connection lifetime; the provider phase has none.
- Bound: `boundedList` caps refunds at 100 and disputes at 10; nonempty advancing pages mean <=111 logical
  full-read requests, usually three, plus anchor calls. Transactions <=`MAX_ORDER_TRANSACTIONS=256`; accumulated
  transaction-count guard examines at most 257 rows. Fee details/expanded response bytes are not currently capped.
  Claim is O(1) native rows/statements; apply is O(1+k) rows and O(1) batched statements for k<=256, plus envelope.
  Stripe default network retry cap 2 gives <=3 sends/call; with configured zero, closed-connection retry still
  permits a second send (`RequestSender._shouldRetry`). A single combined retry policy must explicitly union
  `StripeUnavailableError` and `COMMAND_STEP_RETRIES.shouldRetry`, retaining a finite adopted maxAttempts;
  spreading policies loses a predicate. Eight attempts is a candidate reuse of the current command policy,
  not an existing combined policy. SQL contention/fence retries are deadline-dependent, not a fixed count.
- Growth check: measure provider requests/bytes, native rows/buffers/statements, receipts/events, pool occupancy,
  physical bodies and DBOS outputs at fixed k with growing unrelated data and histories. Charge every retry,
  including discarded bodies/reads and new claim events. Manual resume/fork/rewind multiply work; no finite
  lifetime retry bound follows from maxAttempts. Byte and SQL-retry-count caps remain approval/proof gaps;
  wall-time limits alone do not establish them. No numeric per-plan allowance is inferred.

## Cost: known-order repair and incremental accounting

- Touches: caller-supplied bounded order IDs, each PK order/Session binding, one fresh child identity per repair,
  and the refresh above. New immutable balance transaction IDs feed existing buyer-to-creator royalty effects.
- Bound: O(m) point anchors for an explicitly capped input m, processed in finite bounded slices; no paid-order
  sweep. Each royalty effect reads <=256 named source keys and inserts only new lines/upserts affected statements;
  buyer and creator checkouts are sequential. Financial no-op emits no new royalty work, though refresh claim does.
- Growth check: hold m/k fixed; grow paid history, unrelated buyers/creators and statement history separately.
  Check no duplicate lines/outbox/empty later statements, account terminal denial, and no provider payout calls.

## Native acceptance to commission, not executed here

Use `startWorker(readWorkerConfig(env),undefined,env)` from `src/worker.ts` with `workerTestEnv`, as in
`work-module.test.ts`; retain default modules/real SDK. The signed HTTP fixtures are
`test/commerce/support/{work-fixture,work-runtime,work-stripe,fake-stripe}.ts`. `delayRead()` captures actual
HTTP response bytes before release; `pay`, `refund`, `failRefund`, `dispute`, `updateDispute` provide provider
states. Observe `WorkClient.getWorkflow/listWorkflowSteps`, receipts, outbox, order/entitlement and accounting
through native fixtures/APIs. Driver barriers/delays/worker kills may control timing, never implement policy.

| Sequence | Required observation |
| --- | --- |
| Concurrent same Session, then different Sessions | Normal same-key read/apply order serializes; different keys progress under shared capacity; actual queue/key inspected. |
| Park A after provider capture; cancel A; deliver B; release A | B's claim wins even if B is business unchanged; A cannot revoke/restore afterward. Repeat with spare worker/process capacity and step timeout retry. |
| Timed-out body blocked at native order lock | Retry/B claims and applies; released old transaction rolls back or reports superseded. Late DBOS-result discard alone is insufficient evidence. |
| Cached split-read recovery/fork | Reproduce the two counterexamples using actual checkpoint IDs; ERROR resume remains ERROR. New combined flow rereads at the cut; copying a completed combined step causes no apply. |
| Cancel/resume; terminal rewind; fork | Explicit effects queue/key, both same and new native identities; original may remain alive. Exhausted-recovery resume works; SUCCESS/ERROR resume does not rerun. |
| Crash after read, before native commit | Kill only owned worker, await its exit; restart default runtime. Provider reads increase and new truth wins; no stale saved read reused. |
| Crash after native commit, before DBOS acknowledgement | Test-only acknowledgement barrier after observing the real native commit; kill/restart. One business effect, existing stable receipt replay, no duplicated balance/royalty line. |
| New no-op; equal/backward `observedAt`; later refund | Claim persists despite apply rollback; native ordering is independent of clock. Paid state is retained while refund/dispute revokes benefit. |
| Duplicate valid events and forged signature | Same event/child/receipt effect once; forgeries enqueue/apply nothing. Include valid event with foreign Session/order binding and captured-price mismatch. |
| Missed late refund/dispute on paid order | New authenticated known-order repair or recovered provider event produces a new refresh identity and updates financial evidence/benefit; no scan. |
| Terminal buyer during delayed application, terminal creator | Race real Access tombstone with native apply; no grant/restore/private resurrection after barrier. Permitted buyer/creator financial truth still converges idempotently. |
| Resource/shape limits | Existing 256/257 transaction cases, null balance transactions, refund reversal/dispute reinstatement, pagination failures and retry overload retain fail-closed behavior. |

Existing `checkout-workflow.test.ts:96` and `work.test.ts:178` assert cached-read recovery (including one
provider read). That expectation conflicts with fresh precommit replay; the acceptance owner must reconcile
it before implementation dispatch. A worker must not weaken a frozen test to make the new design pass.
The after-commit acknowledgement barrier and adversarial timeout registration need test-only fixture support;
they must call the real combined export/SDK and must not substitute a settlement model.

## Reviewable implementation slices and writer order

Each slice is <=400 production lines/eight paths including tests; paths expand under `services/kernel/`.
They form one integration set. Generate SQL types normally; settle frozen assertions before dispatch.

1. **Native authority first (~180 production lines, 8 paths):** `src/commerce/commands.ts`, `store.ts`, `settlement.ts`,
   `model.ts`, new `store-order-refresh-claim.sql`, existing `store-order-lock.sql`. Add claim/CAS signatures,
   retain apply digest/key, lock before no-op, drop timestamp ordering and reuse `shareAccount` for benefits.
   Plus new `test/commerce/{refresh-fence,refresh-terminal}.test.ts`. Adopt claim event/revision semantics first.
2. **Direct consumers (0 production lines, 7 paths), after slice 1:** `test/commerce/{commands,growth-orders,
   growth-transactions,http,order-bounds,payouts}.test.ts` and new `support/checkout-refresh.ts`: the six actual
   direct snapshot-command consumers. Obtain native claims and add the locator to the payouts StripePort stub.
   Preserve all business assertions; no optional authority bypass. `src/commerce/work.ts` migrates next.
3. **Fresh serialization (~260 production lines, 8 paths), after slice 2:** `src/commerce/work.ts`, `work-contract.ts`,
   `model.ts`, `stripe.ts`. Add the narrow locator to `StripePort`/`createStripePort`, combined step, composed
   retry predicate/capacity permit and Session enqueue helper; event, initial and expiry callers all use it.
   Other paths: `test/commerce/{work,checkout-workflow,work-module,work-bounded}.test.ts`. Preserve receipt prefixes.
4. **Recovery fixtures (0 production lines, 5 paths), after slice 3:** `test/commerce/support/{work-runtime,
   work-stripe,work-fixture}.ts` and new `test/commerce/refresh-recovery.test.ts`: HTTP/acknowledgement barriers,
   multiple owned workers and timeout registration. Add locator HTTP coverage in `test/commerce/stripe.test.ts`.
5. **Repair (~120 production lines, <=6 paths), after slice 3's `work.ts` writer:** `src/commerce/work.ts`,
   `work-contract.ts`, `enqueue.ts`, and the adopted authenticated repair entry point. No such repair export
   exists today: adopt its Access action binding first. New `test/commerce/{known-order,provider-event}-repair.test.ts`.
   Permit paid orders, fresh per-request identities and bounded explicit targets; provider-event repair reuses signed
   classification/resolution, while known-order repair starts at the native PK. No catalogue or history sweep.

Before cutover, adopt the report's coordination write/event and replay/cancellation meanings in the owning
Commerce document. Changing global cancellation acknowledgement or native receipt retention is kernel-wide
and requires supermanager approval; no such shared contract change is necessary for the stated supersession
invariant. Keep all supported fork/resume/rewind operations, with their actual SDK semantics documented.
Deploy compatible workflow code: physically drain/stop pre-fence binaries before relying on mandatory CAS.
For persisted split-step workflows, retain a compatibility apply-step adapter that discards the saved snapshot
and invokes the new Session child with the old native intent, or explicitly migrate them through the supported
versioned fork path. Do not replay old step positions against a new step graph or call status cancellation a drain.

Unresolved proofs: native acceptance above has not run; aggregate DBOS dequeue/history/byte costs are not
established; Stripe's multiple GETs have no documented atomic cross-object snapshot or monotonic version token.
The recommendation prevents reuse/overwriting by obsolete observations, not Stripe changing after a GET.
Subsequent triggers repair changes. Financial retention/minimization and repair authorization remain owner work.
