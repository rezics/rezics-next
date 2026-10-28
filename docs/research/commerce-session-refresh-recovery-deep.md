# Session refresh, DBOS recovery and native command receipts

Research date: 2026-10-28. This is independent source evidence and a recommendation, not an adopted runtime contract.
The fixed direction is hosted Checkout, one direct Stripe account, native financial/benefit data, shared Access/DBOS,
and a fresh refresh for each trigger on the existing Session-partitioned `effects` queue. No timestamp ordering,
catalogue mirror, paid-order sweep, replacement workflow engine or implementation is proposed here.

## Finding

One combined provider-read/native-apply step fixes cached-read recovery, but does not by itself exclude an abandoned
step's native commit after cancellation or timeout. DBOS fences its own checkpoints; `runCommand` commits separately.
Keep the combined step and existing stable apply receipt. Add a small native admission/CAS composition using the
order's existing revision: for an uncompleted intent, advance it **before** each physical attempt's full provider read, then
apply only against that captured revision. Even a newer business no-op must leave its admission revision committed.
This uses existing native commands, receipts, events and row locks; it needs no lease, scheduler or queue table.

The guarantee is that an older admitted observation cannot change native truth after a newer admission commits.
Cancellation is cooperative execution control, not a distributed rollback. A commit that wins the order lock before
the next admission remains a preceding committed effect. Requiring cancellation acknowledgement itself to prohibit
every subsequent native write would require an additional shared cancellation/commit contract; the current SDK does
not provide that contract for an arbitrary `runCommand` call. That stronger interpretation needs explicit review.

## Provenance and source anchors

Application sources below are pinned to `997aefa21d8de4b1f5be8b2d741e28ccc01e5b93`; paths are repository-relative.
Installed SDK paths abbreviate `services/kernel/node_modules/@dbos-inc/dbos-sdk/dist/src/` as `SDK/`.
Reference paths abbreviate `/home/edge/projects/rezics/rezics-next/.reference/` as `.reference/`.
Only sources were read; no reference repository was installed, built, executed or instrumented.

| Source | Exact provenance and licence |
| --- | --- |
| Installed DBOS | `@dbos-inc/dbos-sdk@5.4.6-preview`, MIT, package `LICENSE`; [npm metadata](https://registry.npmjs.org/@dbos-inc/dbos-sdk/5.4.6-preview) gives `gitHead=980dc55095f445b189aecb59e7f3334345179f65`. |
| Published artifact | [Official tarball](https://registry.npmjs.org/@dbos-inc/dbos-sdk/-/dbos-sdk-5.4.6-preview.tgz), SHA-256 `e081bd0cffc54caabb4bb991019272934810d7710c32810fff00ef3b81cc00e1`; registry SHA-1 `a3c5b7ba8366d1d7547d35e9d2b2c231627e9d88`. |
| Artifact comparison | Byte comparisons against installed `system_database.js`, `dbos-executor.js`, `wfqueue.js`, `client.d.ts`, `package.json` and `LICENSE` all matched. Installed `system_database.js` SHA-256: `9769d642e1d9db8ee1da30dd546349f7f4d1d61e932d654767a1f4978c290516`. |
| DBOS source | Reused `.reference/search-worker-outcome-harness/dbos-transact-ts`, commit `980dc55095f445b189aecb59e7f3334345179f65`, [MIT](https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/LICENSE). Its placeholder package version is not version evidence; the artifact comparison and registry `gitHead` establish correspondence. |
| Stripe source | Reused `.reference/commerce-integrated-done/stripe-node`, v23.0.1, commit `3af59f7c86a2350a8ea5298473f258d622bd8651`, [MIT](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/LICENSE). |
| PostgreSQL source | Reused `.reference/library-shelf-maintenance/postgres`, commit `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, [PostgreSQL License](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/COPYRIGHT); `src/backend/executor/nodeLockRows.c` and `src/backend/access/heap/heapam.c` implement tuple locking/concurrent-update handling. |

DBOS permalinks used below: [system database][dbos-system], [executor][dbos-executor], [queue runner][dbos-queue],
[datasource helper][dbos-datasource]. Line references to `SDK/` refer to the compared installed artifact, not an
assumed release tag. Current official docs were checked against it on the research date.

## What the application actually does

- `commerce/work.ts:71-101` separately records `commerce.readCheckout` and `commerce.applyCheckout`, preceded by
  `commerce.clock`; `sync` is called by checkout sync, initial reconciliation and expiry. They use `workflows`,
  currently without Session partitioning. Paid orders are excluded by reconciliation/expiry guards.
- `work/queues.ts` already defines `effects` with `workerConcurrency:8, partitionConcurrency:1`.
  `events/effects.ts:85-92` supplies the real enqueue form:
  `DBOS.startWorkflow(fn,{queueName:'effects',enqueueOptions:{queuePartitionKey:key},workflowID,...})(args)`.
  `DBOSClient.enqueue` instead takes `queuePartitionKey` at the top level; `work/client.ts` returns that actual client.
- `commerce/commands.ts:349-417` checks the Session/order binding and runs a buyer-partition command with receipt
  kind `commerce.checkout.apply`, key `wf:{workflow}:apply`, digest **already** `{orderId}`. It does not hash the snapshot.
  `work.ts` supplies the `wf:` prefix; the helper in `commands.ts:41` only appends the step. The similarly named
  `work-contract.ts` helper supplies `wf:` itself: preserve the call-site convention, avoiding a doubled prefix.
- `command/command.ts` checks the receipt before the callback and commits its response, native writes and outbox
  atomically through the core partition fence. Its serializable contention loop reruns the callback, not the provider.
  `Unchanged` in the Commerce callback rolls back the transaction; it creates neither receipt nor observation watermark.
- `commerce/settlement.ts:62-119` ignores an earlier `observedAt`, preserves paid settlement, derives entitlement
  revoke/restore from refunds/disputes, and adds named transactions. `store.ts:277-374` locks and checks revisions
  captured by a native read **after** the provider read. This CAS currently protects native concurrent mutation,
  not the age of the provider observation. The adopted direction removes timestamp precedence.

## Exact queue and recovery semantics

The [queue documentation][queue-doc] describes cross-process per-partition concurrency. Its implementation uses
durable workflow status, not an OS/process mutex. In the configured batched path, `SDK/wfqueue.js:685-697` obtains
the worker budget, then `SDK/system_database.js:2845-2993` chooses one ordered head per partition having no `PENDING`
row, locks that fixed candidate using `FOR UPDATE SKIP LOCKED`, and changes it from `ENQUEUED` to `PENDING` with
an `owner_xid`. Head ordering is priority, creation time, workflow ID; this is not Stripe observation ordering.

| Situation | Verified guarantee and limit |
| --- | --- |
| Ordinary execution | One admitted `PENDING` workflow per queue/partition across executors; different Sessions can run concurrently. Ordinary retries stay within that workflow. Missing partition keys on `effects` do not dequeue. A direct start without the queue is outside this guarantee. |
| Physical executor exit | Its JavaScript no longer runs; an already submitted PostgreSQL transaction may still finish or roll back. The workflow remains `PENDING` until recovery changes its row, blocking the partition meanwhile. Process death is stronger than setting a DBOS status, but does not undo a committed native transaction. |
| Pending-work recovery | `SDK/dbos-executor.js:817-836` calls `reenqueueWorkflowsForRecovery`; `SDK/system_database.js:1143-1162` selects matching executor/version `PENDING` rows, clears ownership, and returns them to their existing queue. Atomic dequeue re-admits them. A mistaken recovery of a still-live executor can overlap its user code; ownership only protects DBOS outcomes. |
| Workflow error / exhausted recovery | Uncaught step failure records `ERROR`; dead-letter exhaustion records `MAX_RECOVERY_ATTEMPTS_EXCEEDED`, releasing the status gate. `resumeWorkflows` explicitly excludes `SUCCESS` **and `ERROR`**. Do not plan to resume an `ERROR` workflow; fork before the failed step, or rewind a terminal workflow. |
| Resume | `SDK/system_database.js:1391-1435` preserves checkpoints and the stored partition key, clears owner/deadline and re-enqueues non-`SUCCESS`/non-`ERROR` rows. It can move a running row as well as a cancelled/dead-lettered row. Without `queueName`, it uses the internal queue, bypassing the original queue's flow control; use `{queueName:'effects'}` for Session work. |
| Fork | `SDK/system_database.js:1689-1811` accepts an existing source without a terminal-status prerequisite, creates a new ID, copies inputs and outputs with `function_id < startStep`. It defaults to the internal queue and a null partition key; explicitly pass both `queueName` and `queuePartitionKey`. A copied provider-read output remains old truth. |
| Rewind | `SDK/system_database.js:1606-1688` rejects `PENDING`, `ENQUEUED`, `DELAYED`; terminal states are eligible, including `ERROR`. It deletes outputs at/after the cut and re-enqueues the same ID; queue/key default to internal/null. Native Commerce receipts and effects are not rewound. Cancelling first does not prove the old user function stopped. |
| Cancel / workflow deadline | `cancelWorkflows` clears `owner_xid`, `queue_name`, deduplication ID and start time and sets `CANCELLED`, except for `SUCCESS`/`ERROR` rows (`SDK/system_database.js:1363-1386`). Deadline sweeping performs the analogous update (`:2620-2646`). The partition's durable slot is available before uncooperative user work ends. |
| Step timeout | `SDK/dbos-executor.js:596-635` races the user promise with a timer, aborts `timeoutSignal`, and discards the late result. A retry can overlap the previous attempt inside the **same** `PENDING` workflow. The partition slot persists until workflow completion/error/cancellation; it need not persist until the abandoned promise ends. |

The supported public APIs and options are in `SDK/client.d.ts:207-245` and the official
[management tutorial][management-doc], [methods reference][methods-doc] and [client reference][client-doc].
Use actual `listWorkflowSteps().functionID` cuts. `ERROR` resume is a no-op, not failed-step retry.

`callStepFunction` checks cancellation and cached output before invocation (`SDK/dbos-executor.js:535-585`).
For an uncached attempt it awaits user async work; cancellation is a cooperative `cancelSignal`, not a forced race.
Automatic retries check cancellation, but do not acquire a native domain fence. Successful/error step recording
then calls `recordOperationResult`, whose transaction locks/checks `owner_xid` before storing an output
(`SDK/system_database.js:1248-1256,3831-3892`). Workflow outcome writes likewise require `PENDING` and the owner.
An old run that loses ownership adopts the stored outcome; local running entries are released when settled or parked
(`SDK/dbos-executor.js:421-449,470-526`). The batched partition path does not use local per-partition count to retain
a cancelled slot; spare worker capacity, especially on another executor, can admit the next Session workflow.

These protections cannot retract a prior, separately committed `commands.applyCheckoutSnapshot` transaction.
Current Commerce steps specify neither `timeoutMS` nor retry of `DBOSStepTimeoutError`; timeout overlap is a supported
SDK behavior to cover, not an assertion that today's Commerce registration already enables that retry.
The [step docs][step-doc] explicitly explain cooperative timeouts and discarded results. Workflow deadlines are
durable cancellation; queued duration timeouts start on dequeue. Parent cancellation defaults to not cancelling
children; `cancelChildren:true` is explicit. The timeout sweep acts on expired rows, rather than proving children or
their provider calls physically stopped. Check inherited deadlines at the actual child enqueue, not just its parent.

## Source-derived counterexamples and crash boundaries

**Cached read plus a newer no-op, including the current timestamp comparison:**

1. Native order is paid, entitlement active, observed time `t0`; charge transaction is recorded.
2. Refresh A at `t1 >= t0` records a `needs_response` dispute with no balance transactions (the existing fixture's
   `dispute(session,{withdraw:false})`). It revokes in `decideCheckout`, but A exits before native apply; its read survives.
3. Cancel A's remaining `PENDING` row to release the partition; `updateDispute(id,'won')` leaves the empty transaction
   list empty. B runs and sees paid/active and no new named transactions. B is a business no-op:
   it throws `Unchanged`, so no `t2` watermark or apply receipt is committed.
4. `resumeWorkflow(A,{queueName:'effects'})` is supported for `CANCELLED`. Cached A's read returns at its old step ID;
   A has no apply receipt. Native state still has `t0`, so A's old dispute can wrongly revoke after B's newer read.
   Forking A at the apply step also copies that old provider read, with a new workflow/apply receipt identity.

This is a code-derived executable schedule, not a claimed observed failure. `fake-stripe.ts:240-264,542-581` implements
that no-withdrawal dispute/win sequence; timestamp equality/backward movement makes ordering weaker.
It requires the status transitions above: an unrecovered `PENDING` A would keep blocking B on a partitioned queue.

**One combined step still needs a native fence under abandonment:** A captures an old revoking snapshot inside its
user function; cancel A while that function remains alive. The SQL cancellation releases its queue slot; B reads
current non-revoking truth and rolls back as a no-op. Release A: its ordinary native command can commit the stale
revocation before DBOS rejects A's checkpoint for lost ownership. For step timeouts, the analogous overlap is produced
by `Promise.race` and retry, without changing owner. Conversely an old paid snapshot can restore after B's later
refund if timestamps are equal/backward, or after timestamp precedence is removed. No SDK ownership guard encloses
that native commit. This is the precise gap; cancellation by itself is not evidence that a defect occurred.

| Boundary | Combined fresh step with current stable apply receipt |
| --- | --- |
| Crash after provider read, before native commit | Unrecorded whole step runs again and rereads provider truth. Sufficient if no older native operation can commit after its replacement; use admission CAS to cover that remaining case. |
| Crash after native commit, before DBOS acknowledgement | Retry may reread, but the same order-target receipt replays the committed result before the mutation callback. The snapshot must not be added to its digest. Native effects are not duplicated. |
| Combined step output already durable / copied by fork | The whole read-and-apply result is replayed; no old provider snapshot is subsequently applied. A new trigger needs a new durable ID to obtain new truth. |
| New business no-op | With the current rollback, it records no native ordering evidence. Queue serialization suffices only while no abandoned native-capable function can overlap; admission CAS supplies the missing evidence. |

## Recommended native composition

Use `commerce.purchase_order.revision`, already a native integer CAS, as an order-local admission fence. This is a
recommendation for adoption: it makes refresh admission a real observable order mutation, even when business truth
does not change. No new table or column is necessary; revision exhaustion fails visibly and must never wrap/reset.
The fence lasts for the order's lifetime, without expiry. Stable apply receipts must survive every supported replay:
`db/schema.sql` defines no receipt TTL, and no core receipt collector was found in `src`. Shared retention must preserve
these keys and safe financial locators while old histories remain replayable; DBOS history retention alone is insufficient.

1. Resolve only the order identity/Session binding. Within the **combined** step generate a fresh attempt UUID for
   each physical invocation, including automatic retry. Do not put admission or provider truth in reusable prefix steps.
2. New proposed `commands.beginCheckoutRefresh(orderId,sessionId,attemptIdentity,applyIntent)` uses `runCommand`, buyer
   attribution and an attempt-specific receipt. Lock the bound order, then check the stable apply receipt in this
   **same native transaction**. If already committed, return its outcome without advancing revision or reading Stripe.
   Otherwise conditionally increment revision and emit existing `com.rezics.commerce.order.updated.v1`; return revision.
   Same attempt key replays an ambiguous begin commit; each physical invocation gets a different key. The admission
   digest binds order, Session and apply intent; validate the core 255-character receipt-key bound.
3. Commit and release that connection before the full `StripePort.readCheckout`. The result is local to this physical
   invocation. Remove `settlement.ts`'s `observedAt` precedence guard; mint observation metadata inside the attempt.
4. Extend `applyCheckoutSnapshot` with an explicit required refresh admission revision on the production refresh path.
   Preserve the existing stable apply key/digest. Receipt replay runs first. In the callback lock the order, require
   its bound Session and exactly that captured revision before deciding effects, and retain the condition through
   update/commit. A stale revision aborts without writes or an apply receipt; return `superseded` to DBOS.
   Never silently substitute the revision just reread after the provider response. Internal serializable retries keep
   the original expected revision. Existing business `Unchanged` may still roll back: admission already persisted.
5. Compose one retry predicate for `StripeUnavailableError` and `COMMAND_STEP_RETRIES.shouldRetry`; do not overwrite
   either by spreading options. Bound total attempts explicitly. A superseded attempt is successful suppression,
   not an error to retry with the same old snapshot. Any genuinely retried whole attempt obtains fresh truth.

Why the fence closes the race: both admission and apply lock/update the same order row. If B's admission commits
first, A's older captured revision cannot pass; an already-open serializable A transaction either sees the new
revision or aborts on the concurrent row change. If A holds the lock first, its commit precedes B's admission, so
B then reads provider truth after A's effect. Native receipt/outbox atomicity survives both outcomes. PostgreSQL's
[row locking][pg-locks] and [isolation/retry rules][pg-isolation] support this reasoning; a pre-commit cancellation
check alone does not. A revision comparison only in an earlier read would leave a race and is insufficient.

An admission abandoned before provider read leaves only a higher revision; no cleanup or expiry is needed. A failed
provider call leaves the same harmless fence. A newer no-op retains its committed admission. A committed apply
invalidates its own revision and is subsequently acknowledged through the stable receipt. Cancel, resume, fork,
rewind, and timeout may leave old functions alive: each newly executing whole attempt admits before reading; copied
whole-step outcomes perform no new native apply. Fork before the step is a fresh intent; rewind keeps its original
receipt, so it cannot undo/reapply committed truth. Use a new trigger for repair after a completed intent.

Receipt-aware admission is necessary: an already-completed A retry must not advance revision and suppress an
inflight newer B, then merely replay A's old receipt. An unlocked preflight probe leaves a commit/probe race.
Propose a small shared `readOwnCommandReceipt(tx,{kind,key,digest})` helper, using the live command's principal/
partition and existing `command/read-receipt.sql`, checking digest exactly as `runCommand` does. It is **not an
existing export** and needs shared-kernel approval. Call it after the order lock, before any admission write;
a matching completion exits read-only (rollback sentinel or a true `noEffect` result), never a branded domain write.
The same order lock ensures an older apply cannot commit between this check and admission. Keep final apply replay.

Existing alternatives are insufficient here: `DBOS.stepStatus` abort signals reduce abandoned work but cannot fence
PG commit; a provider-held advisory lock consumes a connection across remote work; a separately cached begin token
repeats the stale-token problem. `assertStillOwnsWorkflow` exists in the SDK datasource API, but reads ownership
separately (`SDK/datasource.js:155-163`); its datasource checkpoint protocol is not installed around `runCommand`,
does not order distinct Session workflows, and does not fence overlapping timeout attempts with the same owner.
Do not add direct writes/locks to DBOS internal tables or claim a hidden shared DBOS/core transaction.

## Identity resolution, terminal accounts and repair boundaries

There is no global native Session-to-order index. The actual index is
`purchase_order_checkout_session(route,checkout_session_id) WHERE checkout_session_id IS NOT NULL`
(`db/commerce/schema.sql:423`); `store.readOrderBySession(client,route,sessionId)` needs the route first.
For known-order work, `routeOf(orderId)` plus `store.readOrder` and immutable recorded Session is already sufficient.
For a Session-only event, retrieve that Session **without expansions**, read `client_reference_id` as a locator, derive
its route, then point-read and verify the native order's recorded Session. Also check metadata order correlation and
payment mode in the proposed locator; the full snapshot must independently pass existing captured-price/order/Session checks.

This needs an explicit proposed `StripePort.resolveCheckoutOrder(sessionId)` implementation in `stripe.ts`; the
existing port exposes only create, full read, and PaymentIntent-to-Session lookup. Do not pretend this method exists
or use a pre-admission full snapshot later. A full read discarded before admission is safe but wastes its bounded
refund/dispute fanout. [Retrieve Session][stripe-session] supplies the locator; [list Sessions][stripe-sessions]
supports the existing `findCheckoutSession(paymentIntentId)` filter/limit. Unknown/mismatched locators grant nothing.

Resolver parents stay on `workflows`; all actual refreshes, including expiry and known-order repair, enqueue children
on `effects` with `commerce:checkout:{sessionId}`. Parents must not occupy every `effects` slot while awaiting children.
Keep royalty effects on their existing buyer-event/creator-command path. A signed event is an authenticated wake-up,
not financial truth: Stripe documents [unordered and duplicate delivery][stripe-webhooks]. Initial reconciliation
and expiry keep their existing create/record flow but delegate refresh. A bounded explicit known-order repair remains
eligible after payment; it needs a new authenticated operation identity rather than reusing completed initial IDs.
Provider-event repair accepts bounded named verified events/refs and uses this same child path; no global history scan.

For grant/restore, use existing `access/account-share.ts:shareAccount` inside the buyer command, before benefit writes;
its `FOR SHARE` conflicts with the terminal account update until commit. A plain `readAccount` is not that lock.
On its specific lifecycle denial, suppress creation/restoration of private benefits while allowing financial
reconciliation; do not suppress the entire accounting command or reinterpret deletion as a refund. Lock account
before order consistently. Existing entitlement revocation/disclosure and private minimization remain separate.
`commerce/README.md` records missing account-private cleanup; refresh fencing does not implement that cleanup.
The terminal buyer check must not gate creator `payouts.recordTransactions`: retained named financial evidence,
refunds/disputes and incremental royalty effects continue without recreating a buyer graph or restoring benefits.

## Cost

These are derived budgets and required measurements, not measured performance or numeric per-plan allowances.
Let `k<=256` be named order transactions, `a` physical step attempts, `r` network retries per request, `s` active
queue partitions and `h` explicitly supplied repair inputs. Charge discarded work and contention retries as well.

### Resolve and enqueue one trigger

- Touches: One signed body (webhook limit 256 KiB), one event workflow and one refresh child; at most one filtered Session-list request and one unexpanded Session retrieve, one order PK read, and DBOS input/checkpoint/status/index writes. Known-order input uses its native PK instead of the extra provider locator. No second home is held while resolving or enqueueing.
- Bound: Constant named native rows/statements per resolver attempt, plus provider/DBOS bytes. Input IDs, metadata retained, decoded body bytes and retries must be capped. The existing queue's admission cap bounds starts, not all database work: its loose distinct-partition walk and `ORDER BY random()` can examine `s` active keys before limiting the chosen set (`SDK/system_database.js:2864-2935`).
- Growth check: Grow unrelated orders and completed DBOS history independently, then active partition count/backlog separately; measure provider requests/bytes, DBOS examined rows/buffers/statements and native point probes. Fixed enqueue count is not a proof of constant shared dispatcher cost.

### One fresh admission/read/apply attempt

- Touches: One admission command, stable apply-receipt PK probe and, if uncompleted, attempt receipt/outbox/order revision write; one full Session retrieve, filtered refund pages (cap 100 objects), dispute pages (cap 10), expanded balance transactions; one apply command, account-share point lock, order/entitlement and named transaction probes/writes. No core connection or transaction spans a provider call.
- Bound: Successful non-repeated pages are at most 100 refund pages and 10 dispute pages when every page advances by at least one; the first retrieve adds one call. `MAX_ORDER_TRANSACTIONS=256` bounds flattened native keys and the existing total-count query's 257-row lookahead. HTTP attempts multiply by `a*(1+r)` (also count Stripe's special closed-connection retry); serializable retries multiply native statements within each command deadline. Existing provider defaults are 20 seconds/request and two retries, not a whole-refresh deadline or byte cap. Add remaining-deadline propagation, body-byte/nested-object limits and abort to the supported Stripe HTTP client hook before calling the path fully bounded.
- Growth check: Hold one order and named `k` fixed while growing unrelated buyer/creator data and order history to 1,64,255; measure examined rows, bytes, statements, buffers, duplicate/replay/no-op and superseded paths, provider pages/retries, pool acquire/hold time and abandoned calls. Test 256 success/257 refusal without weakening the existing cap.

### Recovery, cancellation and late completion

- Touches: Status/owner changes, copied/deleted checkpoints on fork/rewind, fresh admission receipts and outbox events per actual attempt; a late old apply incurs native receipt/order probes but no mutation after supersession. A fork can copy the source prefix, rather than constant work for arbitrary workflow length.
- Bound: This refresh workflow has one combined truth step and a bounded prefix; keep provider payload out of durable outputs. Charge `a` admissions and retained receipts/events even for business no-ops. SDK logical concurrency does not cap abandoned promises; use a bounded local transport semaphore with real abort/deadlines and finite attempt budgets, not another durable queue. Native attempts release their single pool checkout; use existing core deadlines/lock timeout and configured worker pool capacity, not a connection held as a remote-work lock.
- Growth check: Cancel/timeout one delayed call repeatedly within the finite test attempt budget; count simultaneously live HTTP work and native checkouts, prove eventual abort/drain, and verify final native rows/receipts independently of DBOS terminal status. Grow unrelated DBOS history and source prefix independently; no unbounded cancellation/fork storm is claimed bounded by `partitionConcurrency:1`.

### Bounded named repair and royalty continuation

- Touches: `h` admitted known-order/event inputs, their anchored locator/refresh work, then at most `k` named buyer transaction reads and creator royalty line/statement updates through `payouts.recordTransactions`; source connection is released before creator checkout.
- Bound: Per input use the preceding refresh bound; total work follows finite `h`, with input count/bytes validated before enumeration and durable progress where needed. Paid state is not a filter. Transaction IDs, royalty insert deltas and receipts retain the existing 256-key bound; no all-paid query, seller catalogue read or historical royalty rebuild is introduced.
- Growth check: Grow paid-order/creator history and repair backlog independently while fixing selected inputs and newly named keys. Measure every page, skipped/unknown input, provider call, source/creator statement and DBOS persistence operation; privacy-denied benefits must not hide financial work from accounting.

Stripe transport evidence: [RequestSender.ts][stripe-request] buffers responses and defines retry exceptions;
[FetchHttpClient.ts][stripe-fetch] supports supplied fetch and transport abort. `Stripe.createFetchHttpClient(fetch)`
and constructor `httpClient` are real hooks (`src/stripe.core.ts:1007,1189`, `src/lib.ts:64`). A capped transport wrapper
can combine provider timeout and step cancel/timeout signals, validate streamed bytes, and reject further calls at
the remaining deadline. This is proposed adapter work; current `StripePort` has no signal/deadline parameter.
Bind that context per operation, for example in a client/transport closure built for the call; a mutable shared
"current deadline" would mix concurrent Sessions. The process-local inflight bound is shared across those clients.

## Native acceptance sequences to add, without running them here

Use actual installed SDK plus `startWorker` with default `KERNEL_WORK_MODULES`, configured local Stripe HTTP endpoint
and existing Auth/Access fixture. `commerce/support/work-fixture.ts` currently launches a Commerce-only runtime;
extend a new harness to use the default worker, retaining `fake-stripe.ts` signed events and `work-stripe.ts` delayed
HTTP response control. Add a barrier for the final refund/dispute response: current `delayRead()` parks only Session
GET, before later list calls, so it does not freeze their truth. Drive signed HTTP/APIs as in `support/outcome-driver.ts`.
The driver controls transport/crash barriers and reads evidence; it must not implement queues, CAS or settlement.

| Sequence | Required native observations |
| --- | --- |
| Same / different Sessions | Park A's full read; a second trigger for that Session stays enqueued while an unrelated Session completes under available shared capacity. Inspect actual queue/key/status and provider trace. Release A, then observe B's fresh read. Both use production registration. |
| Live cancelled first application | Capture A after admission/provider read, cancel via actual client while user work remains alive, then run B. Make B the newer won-dispute no-op from the counterexample. Release A; its old revision must not mutate benefit/order/accounting or create an apply receipt. B's admission survives its business rollback. |
| Workflow / step timeout | Enqueue with real client `workflowTimeoutMS` and hold HTTP/native work past expiry; B can run while A is alive and A is fenced. Separately register a test SDK wrapper around the same exported production attempt with `DBOS.runStep(attempt,{timeoutMS,...})`; explicitly retry the timeout and verify overlapping native CAS without driver policy. Count abandoned calls and actual cancellation. |
| Cached read fork/resume | First demonstrate the old three-step schedule on compatible existing registration using actual `functionID` cuts; do not resume `ERROR`. For the replacement, crash before combined output, cancel/resume or fork at that step, change provider truth, and require another full read. Fork after a durable combined result must do no extra native apply. |
| Rewind / status rules | Resume `ERROR`/`SUCCESS` and observe no rerun. Rewind a terminal workflow with explicit queue/key at the combined step; stable receipt acknowledges prior native effects. Cancel a running workflow before rewind, keeping the old function alive; the replacement admission fences it. Use a new trigger to repair completed truth. |
| New no-op and later refund | Start paid/active; use the no-withdrawal dispute/win for a true no-op. Also extend HTTP refund fixtures for pending/failed with null balance/failure transactions: today's pending-refund helper always creates a balance transaction. Repeat with B a later refund/dispute mutation and A old paid truth; no stale restoration. Include equal/backward `observedAt`. |
| Crash before native commit | Stop only the fixture-owned child after read/admission while native apply is held; advance provider truth and restart. It must reread and admit anew. If the old PG transaction commits despite client exit, assert its ordering before the new admission, rather than assuming process exit rolled it back. |
| Crash after native commit | Pause DBOS acknowledgement after observing the exact native receipt/outbox commit; kill/recover the owned child. Expect one benefit/transaction/royalty effect and stable receipt replay. Also park newer B after admission, retry completed A, and prove A neither advances revision nor suppresses B. Use a test-owned system-DB transport/lock barrier outside the native transaction; never patch installed SDK files. |
| Duplicate / forgery / binding | Redeliver identical signed bytes and test a distinct valid trigger; IDs deduplicate only the former. Invalid signature, connected-account envelope, unknown Session, foreign locator, metadata mismatch and captured-price mismatch add no unauthorized native effect. Preserve refund/dispute payloads including null balance transactions. |
| Paid-order late repair | Omit a late refund/dispute delivery; authenticated named-order repair and bounded verified-event recovery each converge using a new trigger identity, although initial reconciliation already completed. No paid-order scan or reuse of its completed ID is allowed. |
| Terminal buyer / creator finances | Race real account tombstoning against grant/restore under `shareAccount`, then deliver refund/dispute and a reversal/repair. Private reads remain withheld, no buyer benefit/private graph is recreated, and named native financial/creator statement deltas still reconcile exactly once. Do not substitute a raw positive permission or test settlement model. |
| Bounds / denial | Cover 256/257 transactions, nonadvancing/repeated provider pages, oversized bytes/nested expansions, retry exhaustion, pool contention and unknown/denied inputs at three unrelated-data/history scales. Inspect real statements/buffers and HTTP/DBOS work, including discarded reads and admission no-ops. |

Existing `work.test.ts` and `checkout-workflow.test.ts` explicitly expect three cached steps and one provider read
after a worker crash; one concurrent test expects B to finish while A's same-Session response is parked. Those are
evidence of current semantics, not proof of the proposed serialization. Preserve frozen acceptance unchanged; an
implementation brief must resolve their compatibility/contract classification explicitly before changing registration.

## Bounded implementation slices and approval order

All names marked proposed above are additions, not claimed existing exports. Each slice below is at most 400
production changed lines and eight production paths; estimates exclude new acceptance tests and generated SQL types.

| Writer order | Production slice and actual shared call sites | Limit |
| --- | --- | --- |
| 0 | Shared receipt read: proposed export in `command/command.ts`, reusing `command/read-receipt.sql`; enforce live context, same principal/partition, key/digest validation. Only the native admission body calls it, after locking the order. Agree and approve this shared interface before the Commerce writer. | 50 lines / 1 path |
| 1 | Native admission/CAS: `commerce/{commands.ts,store.ts,store-order-refresh.sql,store-order-lock.sql,settlement.ts}`. Add the proposed begin command, revision lock condition and explicit apply input; keep stable receipt intent. `store-order-refresh.sql` is new. Coordinate all direct apply callers; expose no unfenced production refresh bypass. | 240 lines / 5 paths |
| 2 | Provider identity/bounds: `commerce/{model.ts,stripe.ts,stripe-transport.ts}`; new transport file owns supported fetch hook, byte/deadline/abort budget. Add the proposed locator and optional call context; update every structural `StripePort` fixture and consumer. Existing create/find/read methods remain the actual integration points. | 300 lines / 3 paths |
| 3 | Ordinary refresh wiring: `commerce/{work.ts,work-contract.ts,refresh.ts}`. New `refresh.ts` exports the real combined attempt for production registration/test timeout wrapper; wire all event/initial/expiry callers to it. Preserve `commerce/enqueue.ts` event API or include it as a fourth path if changing input shape. Retry predicate is composed once. | 300 lines / at most 4 paths |
| 4 | Terminal benefit fence: `commerce/{commands.ts,settlement.ts,store.ts}` calls existing `access/account-share.ts` guard; financial reconciliation remains independent. The commands/store writer follows slices 1 and 3's agreed interface; it does not modify Access lifecycle or retention rules. | 120 lines / 3 paths |
| 5 | Named-order / verified-event repair: `commerce/{work.ts,work-contract.ts,enqueue.ts,repair.ts,routes.ts}`. `repair.ts` and repair enqueue methods on `CommerceWork` are proposed additions; `enqueue.ts` implements them and `routes.ts` calls them with authenticated bounded input/new durable identity. HTTP schemas already live in `routes.ts`. The later `work.ts` writer follows ordinary wiring; client generation and any new Access action need separate declaration/approval. | 300 lines / 5 paths |

Before implementation, adopt the real admission write and revision churn in the Commerce owner document; resolve
frozen test compatibility and pin migration of old persisted workflows. Old split-step histories cannot be replayed
as a differently named combined step (`DBOSUnexpectedStepError`); compatible code versions, drained old executors
and an explicit fresh restart/fork boundary need review. An old binary capable of unfenced apply must not coexist
with the new correctness claim. This is a deployment compatibility requirement, not a restriction on cancel/fork/
resume/rewind of the new composition; those recovery modes remain covered by native admission CAS.

The proposed same-transaction receipt-read export needs supermanager approval. Other kernel-wide changes include
atomic cancellation-to-core commit exclusion, changing `runCommand`/`noEffect` semantics or shared queue/retention/
pool contracts, adopting a transactional datasource protocol or adding an Access lifecycle authority.
None is silently authorized by this recommendation.
`noEffect` may brand only a body with no domain write; a persisted admission revision must emit its real event.
Recovery helpers should supply the Session queue/key using supported APIs; native CAS still excludes stale effects
under bypassed queue dispatch, but arbitrary administrative bypass/fork floods have no bounded physical concurrency.

Remaining proof gaps are native execution of the schedules, DBOS dispatcher growth measurements, provider byte/
deadline/inflight enforcement, compatibility of retained financial locators after private cleanup, and migration of
frozen/current histories. Stripe's multi-object read is not documented as one atomic versioned snapshot; serialization
does not invent such a version or guarantee instant convergence without a later trigger. The shared source pattern
is durable orchestration/checkpoints plus native atomic mutation/idempotency; freshness across abandoned work needs
native admission CAS as well. Report existence proves none of these runtime behaviors or a native gate.

[dbos-system]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/system_database.ts
[dbos-executor]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/dbos-executor.ts
[dbos-queue]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/wfqueue.ts
[dbos-datasource]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/datasource.ts#L320
[queue-doc]: https://docs.dbos.dev/typescript/tutorials/queue-tutorial#partitioning-queues
[management-doc]: https://docs.dbos.dev/typescript/tutorials/workflow-management
[methods-doc]: https://docs.dbos.dev/typescript/reference/methods#dbosresumeworkflow
[client-doc]: https://docs.dbos.dev/typescript/reference/client
[step-doc]: https://docs.dbos.dev/typescript/tutorials/step-tutorial#step-timeouts
[pg-locks]: https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS
[pg-isolation]: https://www.postgresql.org/docs/18/transaction-iso.html#XACT-SERIALIZABLE
[stripe-session]: https://docs.stripe.com/api/checkout/sessions/retrieve
[stripe-sessions]: https://docs.stripe.com/api/checkout/sessions/list
[stripe-webhooks]: https://docs.stripe.com/webhooks#event-ordering
[stripe-request]: https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/RequestSender.ts#L328
[stripe-fetch]: https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/net/FetchHttpClient.ts#L49
