# Commerce

Commerce owns offers, checkout orders, payment evidence, buyer entitlements and creator royalty statements.
This document specifies first-public behavior and identifies current implementation gaps. The
[Commerce Goal](../../../../docs/goals/commerce.md) owns completion evidence;
[shared deletion policy](../../../../docs/deletion.md) and
[Accounts' erasure contract](../access/README.md#erasure-consumers) remain shared authorities.
The [integrated review](../../../../docs/research/commerce-integrated-done-review.md) is historical evidence,
not proof that the current runtime or main satisfies this contract.

## Purchase journey and provider boundary

Use one direct US Stripe account, hosted Checkout and Managed Payments. REZICS is the catalogue authority:
Sessions receive the order's captured product and price inline; there is no Product/Price catalogue synchronization.
Inline `product_data` can create a provider Product; it does not mean that Stripe stores no provider objects
([pinned SDK](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/resources/Checkout/Sessions.ts#L5449)).
[The adapter](stripe.ts) sends one payment item, captured title/currency/amount/tax code, order correlation and
`managed_payments.enabled`. Its automatic-tax fallback exists but does not establish Managed Payments completion.
Points remain outside first public scope.

The minimum journey starts at a subject's purchasable benefit, reaches an active offer, completes hosted Checkout,
and lets the buyer later find the owned entitlement and understand its subject, benefit and active/revoked status.
Payment ownership is independent of private [Library holdings and reading history](../library/README.md): buying
must not silently create a holding or publish reading activity, and Library Undo cannot reverse payment truth.
This journey does not require a broad marketplace.

Current [routes](routes.ts) expose known-ID offer/order reads, order creation and entitlement read/list.
They have no subject-to-active-offer listing or buyer order-history list. The web has
[known-ID offer](../../../../apps/web/src/checkout/offer-page.tsx) and
[order-status pages](../../../../apps/web/src/checkout/order-page.tsx), but these do not supply the subject benefit
entry, later purchase/entitlement navigation or actual benefit-consumption authorization. The
[subject page](../../../../apps/web/src/features/pages/subject.tsx) has no purchase path, and an entitlement row alone does not prove access to its benefit. Those are remaining journey gaps.

### External maintainer setup

Stripe must confirm REZICS's direct-seller eligibility under its actual distribution arrangement for
[Managed Payments](https://docs.stripe.com/payments/managed-payments/eligibility) and activate the intended US account.
One API key and outside-Stripe creator royalties do not prove eligibility. Required actual configuration names are
`STRIPE_SECRET_KEY`, `STRIPE_MANAGED_PAYMENTS`, `CHECKOUT_SUCCESS_URL`, `CHECKOUT_CANCEL_URL` and HTTP endpoint
`STRIPE_WEBHOOK_SECRETS`; matching mode and endpoint secrets, migrations and the shared worker/effects relay must
be configured. `STRIPE_API_HOST` is the fixture override, not a production qualification step.
[Configuration](config.ts) rejects partial/invalid settings; without Commerce configuration, provider operations
are unavailable. Signed fixtures and implementation work do not wait for live keys.

Configure public HTTPS `POST /v1/webhooks/stripe` for this direct account, snapshot events matching
[the handled set](model.ts), and an API version compatible with the installed SDK. Thin notifications are not the
current classifier's input. Supply rotated signing secrets with overlap. Refunds, disputes and evidence management
stay in Stripe, including Stripe-initiated refunds. Creator payments occur outside Stripe; an agreed payout method
and actual external reference are operational conditions, not evidence supplied by a statement row.

### Checkout return URLs

Configure `CHECKOUT_SUCCESS_URL` and `CHECKOUT_CANCEL_URL` as absolute HTTPS URLs. Either URL may include `{ORDER_ID}`;
the kernel replaces every occurrence with the order ID for initial Session creation and reconciliation retries.
Stripe's `{CHECKOUT_SESSION_ID}` passes through unchanged. For example,
`https://rezics.com/orders/{ORDER_ID}?checkout=success` returns to the order page. Other brace placeholders fail startup.
A return URL never proves payment or grants a benefit.

## Commands, receipts and delisted concealment

Native command receipts remain principal-scoped: partition, verified principal kind/id, command kind and idempotency
key identify replay. Each target command must hash complete semantic intent, including `offerId` and other path
identifiers. Token bytes or receipt email are not identities. Every client replay reauthorizes at command time before
receipt lookup or disclosure, including revoked or suspended authority. Another principal cannot retrieve its result.
[Commands](commands.ts) use [the shared command envelope](../command/command.ts), not a Commerce receipt engine.

Actual defect: `reviseOffer` authorizes the target but hashes only `unitAmountMinor`. Two owned offers in the same
partition can therefore collide under one key; the second target can receive the first target's receipt. Its native
command port needs the target in the digest; there is currently no HTTP revise route. `createOrder` already includes
`offerId`, delist includes its ID, and [mark-paid](payouts.ts) includes statement ID and payment reference.
Trusted refresh preserves the stable `wf:{id}:apply` key and digest `{orderId}` in `applyCheckoutSnapshot`.
The immutable order/Session binding is verified natively; neither changing provider bytes nor a snapshot digest
belongs in that stable intent. Admission separately binds order, Session and apply intent to a physical attempt.

A public GET for a delisted offer, even by known ID and even by its seller, must match an unknown offer's `404`
problem body apart from `request_id`. Conceal before reading its subject summary. Keep generic internal offer reads
for authorized management and historical processing. Actual defect: [the public handler](routes.ts) checks existence
only and still returns a delisted row. New purchases already reject delisted offers with `409 offer_unavailable`.
Existing orders and Sessions keep their captured terms after price revision or delisting; neither delisting nor
Library Undo revokes a paid benefit or expires every outstanding Session.

[Checkout](checkout.ts) commits the order before the provider call and retries identical captured parameters with
`order:<orderId>`. This provider key is separate from principal receipts, event deduplication and accounting keys.
Provider idempotency is not permanent duplicate prevention; unresolved creation beyond provider key retention needs
identification/reconciliation, not automatic creation of another purchase.

## Session refresh and payment truth

[Webhook intake](webhook-routes.ts) verifies the exact raw signed bytes through [SDK verification](webhook.ts),
bounds the body at 256 KiB and awaits durable enqueue before acknowledging. Invalid signatures have no effects;
valid payload claims about payment never substitute for a provider read. Event-ID dedupe uses the durable identity
in [enqueue](enqueue.ts), independently of entitlement uniqueness and Balance Transaction accounting dedupe.

### Receipt-aware native refresh admission (implementation pending)

Every trigger resolves an immutable Checkout Session/order binding: direct Session events, PaymentIntent-derived
refund/dispute events, initial/expiry reconciliation, verified provider-event recovery and explicit known-order
repair. All actual refresh children use the existing [DBOS `effects` queue](../work/queues.ts) with
`partitionConcurrency: 1` and a namespaced provider-account/mode/Session `queuePartitionKey`. Each distinct trigger
retains a distinct durable refresh identity; one permanent Session workflow would suppress later refunds.
Different Sessions may progress concurrently. Resolver, event, order and expiry parents stay on `workflows`;
no parent occupies effects capacity while awaiting its own effects child. No new queue, process, scheduler,
catalogue mirror or global paid-order sweep is needed.

Known-order resolution uses its routable ID and one native order key. Native Session lookup requires a route;
there is no global Session-to-order index. Session-only events need an unexpanded provider Session locator,
checking `client_reference_id`, metadata correlation and mode against the native recorded binding. PaymentIntent
resolution also charges the existing filtered Session list. This narrow locator port is not implemented;
a locator grants no buyer authority, and a pre-admission full read cannot become the later apply snapshot.

Use one combined registered physical attempt: resolve the anchor, fresh native admission, fresh full provider
read, native apply. Neither an admission token nor provider truth is a separately memoized prefix step.

1. After normal service admission for the same immutable order/Session/apply intent, run a real short
   buyer-partition command. Lock the bound order and check the stable apply intent's completion under that
   same order lock, before any domain write, using the approved metadata-only
   [`hasOwnCommandCompletion(tx, {kind, key, digest})`](../command/README.md#metadata-only-own-completion).
   This helper is not implemented. Retain the original apply authorization policy; receipt ownership supplies
   no authority for another action/resource. Matching completion returns read-only completion, with no revision
   advance or provider read. It returns no historic response. Use native `noEffect` only if this transaction
   wrote no domain data, or a rollback sentinel. Never use an unlocked peek or Commerce-local receipt SQL.
   In particular, a completed retry A must not claim over admitted B and then replay A's old result.
2. Only for an uncompleted intent, advance existing `order.revision` with a native conditional `UPDATE` under
   the lock and emit the real existing `com.rezics.commerce.order.updated.v1` event, receipt and native envelope.
   This is a visible coordination mutation even if payment/benefit state will be unchanged. Generate a fresh attempt identity
   inside each physical invocation; native SQL retries reuse it, while a new physical retry claims anew.
   Its admission digest binds order, Session and stable apply intent; obey the native receipt-key limit.
   Preserve captured terms. Fail on revision overflow; never reset/recycle/expire authority or add a fence table
   or column. An ambiguous admission commit must be resolved or abandoned before reading with its token.
3. Commit admission and release the native connection before the fresh full Stripe read. Keep its bytes local
   to this invocation. Revalidate full identity, Session, mode and captured terms; multiple provider GETs are
   not one atomic Stripe snapshot. Later triggers provide convergence when provider state changes again.
4. Apply retains `commerce.checkout.apply`, stable `wf:{id}:apply` and digest `{orderId}`. Native receipt replay
   precedes the body and only acknowledges the old effect. In a fresh body, lock the order before deciding even
   a no-op; require exactly the captured revision and Session through mutation/commit. Never replace that
   revision with a later reread while retaining old provider bytes, including on SQL retry. A superseded apply
   has no effect or apply receipt; a genuine retry needs new admission and a new full read. Business unchanged
   may roll back apply, but its already committed admission remains. Remove timestamp/event-time ordering;
   `observedAt` is metadata. Do not brand a domain write `noEffect` or hide it in an authorization finalizer.
   Preserve atomic buyer-partition order, named transaction and entitlement changes with the receipt/outbox.

The lock proof is local: later admission B and earlier apply A serialize on the same native order row. If B
commits first, A fails the revision condition or its serializable transaction aborts; retrying with A's captured
revision cannot authorize it. If A wins the lock, its commit precedes B's admission and B's subsequent provider
read. Thus A cannot apply after later admission commits, even when B's business apply is unchanged, cancelled
or fails. A newer no-op never returns authority to an older observation. Stable completion lookup under that
same lock also prevents an older apply committing between the completion check and the revision claim.

### SDK recovery, cutover and physical bounds

The installed DBOS SDK is `5.4.6-preview`. Its queue admits one `PENDING` workflow per queue/Session key across
executors, not one physically live body forever. Pending recovery re-enqueues on the stored queue and clears
ownership; it does not certify physical death. Step timeout can abandon a promise and overlap its retry within
the same workflow. DBOS ownership fences checkpoints, not the separately committed native command.

- Resume preserves checkpoints and the stored partition key but defaults to the internal queue; explicitly use
  `queueName: 'effects'`. `SUCCESS` and `ERROR` resume do not rerun. Cancelled and recovery-exhausted histories
  can resume; use a supported fork/terminal rewind for an error, with actual `listWorkflowSteps().functionID` cuts.
- Fork creates a new ID, copies outputs below the cut and leaves the source runnable. Rewind requires terminal
  status, removes outputs at/after the cut and retains the ID. Both default to internal queue/null partition;
  explicitly pass `effects` and the Session key. A fork before the combined step claims/reads afresh; copying
  its completed output replays completion without another apply. Rewind cannot undo native receipts or money.
- Cancellation and workflow deadlines can release durable queue occupancy while user code is alive.
  Cancellation stays cooperative: bare DBOS status cancellation is not atomic exclusion from core commit and
  does not roll back money. Without a later native claim an already admitted body can still commit. There is
  no global cancel-to-commit contract. Parent cancellation does not cancel children by default; inspect actual
  child deadlines and explicit cancellation options.

Use the supported enqueue shape in [effects](../events/effects.ts): `DBOS.startWorkflow` takes the key inside
`enqueueOptions`; `DBOSClient.enqueue` takes `queuePartitionKey` at top level. Recovery operations must preserve
that routing. Existing split-step histories require compatible workflow-version cutover: physically drain old
unfenced executors and explicitly drain histories, fork at a supported fresh boundary, or retain an adapter
discarding cached snapshots and delegating with the original stable apply intent. Never replay old function IDs
against an incompatible step graph. A cancelled status alone is not physical drain. Preserve completion metadata
for supported replay lifetimes, coordinating minimization/retirement with shared retention owners.

Bound provider, transport and native attempts physically, including abandoned promises. A shared process-local
inflight admission may cap actually unsettled bodies; hold capacity until the real body settles and refuse excess
instead of accumulating an unbounded waiting list. It supplies no durable authority or queue engine. Combine
provider-unavailability and native command retry predicates with a finite attempt budget; spreading policies must
not discard either predicate. Charge SDK network retries, including its special closed-connection retry.
Propagate remaining deadlines through resolution, child admission, every provider page/retry and native attempts.
Reuse Stripe's supported constructor `httpClient` and `Stripe.createFetchHttpClient(fetch)` hooks for abort and
streamed byte limits, binding context per operation rather than a mutable shared deadline. Enforce input, nested
expansion, fee-detail and response-byte bounds before buffering unbounded data. Timeouts alone do not prove those
bounds; no numeric plan allowance is inferred. No native connection spans provider I/O.

Actual [work implementation](work.ts) uses the unpartitioned `workflows` queue and Session-plus-event child IDs.
It durably clocks, reads and applies in separate steps. Those identities deduplicate triggers but do not serialize
Session refreshes. [Settlement](settlement.ts) rejects an older `observedAt`, while a newer business no-op is rolled
back without retaining that observation. A delayed old pending-full-refund response with no Balance Transaction can
therefore revoke after a newer canceled-refund no-op. Equal clocks also supply no ordering proof. Receipt-aware
admission, mandatory apply revision checks, fresh combined retries, Session routing, provider locator/transport
bounds and compatible cutover remain unimplemented; neither existing timestamp tests nor the
[current](../../../../docs/research/commerce-session-refresh-recovery-current.md) and
[deep reports](../../../../docs/research/commerce-session-refresh-recovery-deep.md) prove runtime acceptance.

### Paid-order recovery

Paid orders remain repairable. Use bounded provider event recovery and bounded known-order/Session repair, including
paid orders, through this same refresh path. No global paid-history sweep or paid-order exclusion is permitted.
Recovery distinguishes unaccepted delivery (provider retry/resend or bounded outage-window event pages), accepted
but failed work (DBOS recovery or fresh repair), and events outside provider retention (known-order repair).
Batch continuations, exact event types and Event-ID dedupe must bound recovery. Each new named repair or verified
event recovery uses a new trigger identity; never reuse a completed initial reconciliation identity. Current
initial/expiry workflows exit for paid/failed orders; their completion shortcuts are not late-payment recovery.
There is no current explicit known-order repair route or implemented bounded event-recovery path in Commerce.

### Settlement, benefits and accounting

Settlement has `pending`, `paid`, `failed` and `unknown`; reconciliation is work, not a fifth state.
An order once paid remains paid. Benefit access follows current provider state separately:

- Complete and paid without a blocker grants/retains the benefit; unpaid completion never grants.
- Partial refunds retain access. Full pending/requires-action refunds provisionally revoke; full succeeded refunds
  stay revoked. Failed/canceled refunds restore the same entitlement when no other blocker remains.
- Active chargebacks revoke; won disputes restore absent a full refund; lost disputes stay revoked. Warnings,
  inquiries and prevented disputes retain access under the existing policy.
- At terminal buyer T, the fence always prevents benefit restoration or private reads, even when financial truth
  still needs reconciliation. Current trusted settlement does not implement that terminal-benefit fence.

Before grant/restore, use the real [`shareAccount`](../access/account-share.ts) barrier in the same native
transaction. Its account share lock serializes against tombstoning until commit; a plain account read does not.
Acquire account before order consistently wherever both locks are needed, then retain the order lock and exact
admission condition through apply. Catch only the actual `LifecycleDeniedError` to suppress benefit/private graph
recreation and recompute the remaining decision; do not swallow availability failures or skip financial accounting.
Financial truth survives terminal buyers and creators: permitted retained named transactions and incremental
royalty statements still reconcile, without recreating private relations. This barrier is not the whole financial
erasure participant and supplies no retention exemption.

Pending refund revocation is REZICS access policy, not proof money moved. Financial accounting uses actual signed
Balance Transactions once, including refund/dispute reversals, with separate currencies and integer shares.
[Royalty calculation](royalty.ts) has tax/FX/reversal assumptions that require supported provider fixture evidence;
missing evidence must fail visibly rather than silently justify unsupported payouts. Retained fees/tax can leave a
nonzero balance after a full customer refund; only exact reversal of every relevant movement implies zero totals.

[Payout recording](payouts.ts) incrementally aggregates newly inserted lines in [Commerce SQL](payout-record.sql),
placing late adjustments in the current recording UTC month while preserving paid prior statements. Mark-paid
records an external payment reference; it performs no Stripe transfer. Commerce already calls Accounts'
[`grantAccountRole`](../access/account-role-grant.ts) after statement upsert in the same creator transaction at command
T. The current grant is unchanged on redelivery. Modules never write Access SQL; preserve this implemented port and
its additional statement cost below.

## Terminal erasure and retained financial records

Account confirmation T immediately conceals private/unlisted reads, exports and counts and fences producers,
workers and late webhooks against recreating private data or benefits. Lawful financial truth may still be
reconciled inside its restricted retained subset. Payment facts and ordinary offer delisting, refund/dispute,
entitlement revocation and mark-paid transitions have no record Undo; account deletion never reverses them.

Financial Commerce is an explicit participant in Accounts' one versioned fixed-list erasure coordinator, separate
from Library. It must acknowledge actual minimized cleanup or attest no applicable data. Dispatch success is not
completion; overall completion requires every fixed participant and a minimal durable PostgreSQL completion record
outside DBOS history so an old event cannot reopen activity. Accounts owns that coordinator and its participant
contract; Commerce must not add a lifecycle engine, account restore, legal-hold engine or deletion service.
The current [Access consumer section](../access/README.md#erasure-consumers) still describes independent tombstone
effects without fixed-list completion; it does not demonstrate the required coordinator. The terminal event remains
`com.rezics.access.account-tombstoned.v1`. No Commerce erasure effect, participant acknowledgement, exact payload
locator inventory, cleanup SQL or retained-field expiry is currently registered in [Commerce work](work.ts).
[Shared authentication](../access/authenticate.ts) already rejects terminal/fenced actors on new requests; that
does not prove an admitted private read racing T or trusted settlement cannot recreate a terminal buyer's benefit.

Disposition applies to each Commerce store, with actual implementation still missing:

- `offer`: delist is a business mutation, not erasure. Minimize account-linked personal fields; no public retention
  exemption follows from being an offer. Current known-ID concealment also needs correction as described above.
- `purchase_order`: immediately conceal buyer-private reads; erase/minimize identifying buyer, target relations and
  Checkout payload except the restricted legally required subset. Captured-term immutability does not authorize retention.
- `entitlement`: fence benefit use and private reads at T; erase personal account/order/offer/subject relations.
  A later paid or won-dispute refresh cannot recreate them.
- `order_transaction`: retain only required payment/tax evidence with restriction and expiry, minimizing remaining
  personal fields. Its UPDATE/DELETE guard is not a blanket retention exemption.
- `royalty_line`: minimize creator/buyer-linked source relations and personal payload; retain only the required
  accounting subset under the same restriction/expiry rule. Its immutable guard grants no exemption either.
- `payout_statement`: conceal creator-private reads at T, minimize personal fields and external payment references
  except scheduled required evidence; keep a nonpersonal skeleton only where safe, otherwise erase it.

Commerce producers must enumerate exact receipt, outbox, write-basis and work payload locators. Their shared store
owners minimize those copies and acknowledge actual custody cleanup; Commerce cannot claim completion from local
row cleanup or blindly purge provider/shared history. Start from account-linked owner indexes, use bounded child
pages/checkpoints, bind terminal account and T, and persist cleanup progress and continuation atomically. No broad
principal/JSON/history scans, global sweeps or mass cascades. Required owner indexes and locator ports remain gaps.

The external retention schedule must specify jurisdiction, record category, fields, purpose and expiry for payment
and tax evidence. Do not invent a legal duration or retain every field behind an immutable trigger. Required retained
records remain restricted and expire; shared policy governs other erasure. Mandatory legal-hold checks and an early
platform-purge hypothesis are not first-scope Commerce requirements. Missing live keys or a not-yet-supplied legal
schedule does not stop fixture, fence, coordinator or bounded cleanup implementation work.

## Native acceptance and completion gaps

[The native entry](../../test/commerce/outcomes.test.ts) imports
[Commerce outcomes](../../../../specs/commerce-outcomes.test.ts) through
[the actual driver](../../test/commerce/support/outcome-driver.ts): migrated PostgreSQL, real Auth/Access personas,
production kernel, real DBOS and official Stripe SDK against the signed loopback provider fixture.
[The fixture](../../test/commerce/support/fake-stripe.ts) is a provider boundary substitute, not live qualification.
Keep frozen outcomes intact and add missing native evidence; a documentation acceptance executes none of it.
Use signed fixtures and API personas without live Stripe calls.

Remaining proof must cover buyer, another buyer in the same route, refunded buyer, seller/other seller, creator/other
creator, anonymous, suspended and terminal accounts, and an authorized/unauthorized repair operator. Require:

- Two owned offers in one partition: same-key same-target revision replays; changed target conflicts without changing
  the second offer; fresh key succeeds. Revoked authority denies replay before receipt disclosure; another principal
  sees no receipt. A refreshed token for the same verified identity/attribution creates no second order.
- Active known-ID offer reads for anonymous/buyer/other buyer/seller; delisted reads match unknown `404` ignoring only
  `request_id`. Existing Session settlement retains captured price/target after revision/delisting; private reads
  stay hidden from another account. Complete subject-to-benefit purchase and later entitlement discovery.
- Exact signed-byte replay before/after processing and executor restart; wrong secret, tampering, missing header and
  stale signature produce no durable change. A validly signed false-paid payload and public return URL never grant
  unpaid access; enqueue failure remains retryable. Preserve valid controls in the existing outcomes/webhook suites.
- Use actual `startWorker` with default `KERNEL_WORK_MODULES`, the installed SDK and native HTTP fixtures to prove
  same-Session exclusion and different-Session concurrency, inspecting actual queue/key, provider reads and native
  receipts/events. Barriers control timing and evidence, never implement queue/CAS/settlement policy or patch SDK
  caches. Cover distinct
  events and same-event redelivery, forged/foreign binding, metadata/mode mismatch and captured terms.
- Exercise cached split-read histories, cancelled/resumed/forked histories, terminal rewind and completed-step
  copies with actual SDK function IDs. `ERROR`/`SUCCESS` resume must remain a no-op. Live obsolete bodies,
  workflow deadlines and timed-out abandoned attempts must lose native authority after later admission, including
  bodies parked at the order lock. A newer no-op retains its real admission revision/event/receipt/envelope;
  unchanged apply adds no business effect. Repeat with equal/backward clocks, null pending/failed refund balance
  transactions, no-withdrawal dispute/win and later refund/dispute reversal; old truth cannot revoke or restore.
- Crash before native commit requires fresh admission/full read on recovery; crash after commit/before DBOS
  acknowledgement requires stable replay without duplicate financial/benefit effects. Retry completed A while B
  is admitted: A must neither advance revision nor read provider truth nor suppress B. Confirm exact native commit
  evidence before releasing acknowledgement barriers; process exit alone does not prove PostgreSQL rolled back.
  Existing [work tests](../../test/commerce/work.test.ts) and
  [checkout workflow tests](../../test/commerce/checkout-workflow.test.ts) assert cached reads and same-Session
  concurrency. Their contract alignment needs explicit authorization before implementation; preserve frozen tests
  and business assertions. Historical passes cannot establish the new contract.
- A paid order with missed late full-refund/dispute notification is repaired through authorized known-order work;
  order remains paid, benefit becomes inactive, duplicate requests produce one durable request, and another account
  learns no private fields. A fresh later repair observes reversals; revoked operators cannot replay receipts.
  Exercise bounded event recovery and provider failure/retry without global scans.
- Creator statements, exact worked totals, currencies/rounding, paid-reference authorization and denied replay,
  effect redelivery, later adjustments preserving prior paid statements, and refund/dispute reversal through the
  native API/worker boundary. Cover signed keyset pages, current-month mark-paid conflict, completed prior-month
  payment, same-intent replay and changed-intent conflict. The worked fixture is gross 1200, tax 200, fee 50, refund
  100: net 850, creator 765 and REZICS 85 at 90%. Add exact full reversal to zero, full refund with retained fees,
  retained tax without synthetic credit, and refund-failure/dispute-win reinstatement recorded once.
  [Payout tests](../../test/commerce/payouts.test.ts) and
  [royalty tests](../../test/commerce/royalty.test.ts) contain component evidence, not a fresh complete API run.
- Native terminal-T read-fence, concurrent producer exclusion, late-webhook no-resurrection, every fixed participant's
  real completion/no-data acknowledgement, exact shared-copy cleanup and retained-field expiry.
  Race real buyer tombstoning with grant/restore under the account share barrier and test terminal creator
  finances: named financial deltas and reversals converge once while benefits/private graphs stay absent.
- Measure real pool acquire/hold time, statement/buffer work, input and nested response bytes, provider retries,
  physically unsettled bodies and DBOS dispatcher/history growth at three legal scales. Include first, replay,
  superseded, no-op and completed-A paths, cancellation/timeouts and terminal races. These results are missing.

The integrated review's historical focused 23-case pass does not prove current main, whole Commerce completion,
payout lifecycle, erasure or the root gate. Record current candidate/check/promoted-main evidence through the
integration owner; neither source inspection nor this README's local acceptance supplies it.

## Cost

These are derivations from the commerce adapters and SQL, `src/work/`, `db/commerce/migrations/` and `db/commerce/schema.sql`, not measurements or guaranteed PostgreSQL plans.
The criterion is an anchor with a bounded number of hops and results, costing about changes times index depth.
`N` is total rows of the relevant relation kind; `P` is rows of that kind in an anchor's partition; `o` and `e` are one buyer's orders and entitlements; `c` is checkout receipts under one order's receipt-key prefix; `l` is transactions of one order or lines of one payout; `q` is one seller's sales in a payout period; `d` is page depth; `s` is page size; `k` is rows changed; multi-anchor bounds use the largest applicable P.
`L(N) = O(log(2+N))` shared blocks for a B-tree probe, with constant rows examined for a unique key; `k` indexed changes cost `O(k L(N))` blocks.
Bounds below distinguish rows examined (`R`), shared blocks (`B`) and SQL statements (`S`); all unqualified counts exclude the separately listed command envelope and authorization, which must be added where invoked.
`PK` means the relation's `_pkey`; commerce PKs are B-trees beginning with `route`, and a partition is `route >>> 4`, not a physically partitioned SQL table.
Index bounds assume selective indexed access and fixed row width; unbounded JSON fee details, provider arrays and receipt payloads add their byte/element costs, and cache warmth does not make block touches constant.
HTTP and store entitlement pages cap `s` at 100; HTTP and payout pages fetch at most `s+1 = 101` rows, while the entitlement store helper fetches at most 100.
The adapter and trusted snapshot command cap balance transactions at 256 per complete snapshot; the Stripe adapter also caps refund objects at 100 and dispute objects at 10. Settlement and royalty recording read only named transaction keys, at most 256 per run. Fee details remain uncapped.
The checkout recorder permits pending → unknown once, then a session or failed outcome; unchanged outcomes roll back, and session/failed/paid orders exit before counting, so successful numbered receipts have `c <= 2` (the range count itself has no LIMIT).

| Operation                              | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Growth check                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Command envelope                       | Every `runCommand`: command partition; 0–1 `core.receipt` via PK `(partition_no,actor_account_id,command_kind,idempotency_key)` before the body. One fence CTE updates 1 `core.partition` via PK, inserts 1 receipt, 0–1 `editorial.write_basis` via PK/unique partition-position, and events into `core.outbox` via partition-position-event-sequence PK. Commerce emits 1 offer/order/paid event, at most 3 settlement events, or one per updated statement (executor cap 1000). Time/settings/transaction statements are constant. Grow N and P, fixing command, payload and k.                                                                                                                                                                                                                                                                                                                                                               | R `O(1+k)`, B `O((1+k)L(N))`, S `O(1)` per attempt; replay has no body/fence writes. Three contention attempts maximum; fenced polling and checkout digest-conflict retries are deadline-dependent, not a fixed successful statement count.                                                                                                                                                                                                                                                                                 | `test/commerce/growth-orders.test.ts`: `Command envelope stays within its bound as P grows`                                             |
| Authorization                          | Bearer evidence: 0–1 `access.account` by PK; optional assignment/account PK join on the principal partition. One Access preparation and check per command attempt: `offer:create` on the route-0 root for offer creation, `order:create` on the parent offer for order creation, `offer:manage` on the offer for delist or price revision, and `payout_statement:mark_paid` on the route-0 root for mark-paid. Payout reads prepare and check once per request on the creator account: `payout_statement:list` for statement lists, `payout_statement:read` for a statement or its lines. Buyer read/list uses bearer scopes and hard account equality; create commands also re-read 1 buyer/seller account before receipts. Grow N and anchor partitions P, fixing identities, action and commerce rows; vary ACL history and organizations separately.                                                                                         | Identity points: R/S `O(1)`, B `O(L(N))`. Add the preparation and final permission-check bounds from [Access cost](../access/README.md#cost) for each invocation above, including exact direct, active-accounts and admitted group key probes and same-key interval history.                                                                                                                                                                                                                                                | `test/commerce/growth-orders.test.ts`: `Authorization stays within its bound as P grows`                                                |
| Offer creation                         | Seller partition: insert 1 `offer` via PK, prove its creation by 1 PK read (`command-offer-created.sql`, including xmin), insert 1 `access.resource_initialization` via PK and 2 `resource_role_grant` rows (owner and standing, temporal GiST PK) in 1 initialization statement; root authorization precedes child checkout. Add envelope with created event. Grow N/P, fixing seller, template and payload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Commerce R `O(1)`, B `O(L(N))`, S 3; initialization has constant result rows and logarithmic blocks for exact-key temporal GiST probes and `WITHOUT OVERLAPS` exclusion checks: at T an exact key matches at most one interval, GiST is height-balanced, and growth checks guard against the lack of a worst-case guarantee; add authorization/envelope.                                                                                                                                                                    | `test/commerce/growth-orders.test.ts`: `Offer creation stays within its bound as N grows`                                               |
| Offer read and delist                  | Offer read: read 0–1 `offer` by PK, then call `readSubjectSummaries` once for its target id. The summary reads that subject's PK and labels in one statement in its partition and reads the cover summary when present. Delist reads 1 and updates 1 via PK in 2 statements, plus offer:manage authorization and envelope with delisted event; no order/entitlement fanout. Grow N/P/o/e and unrelated subjects in the target subject's partition, fixing offer and permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | R `O(1)`, B `O(L(N) + L(S))`, S constant for offer read and 2 for delist, plus applicable release, Access and cover dependencies; independent of o/e and other subjects.                                                                                                                                                                                                                                                                                                                                                    | `test/commerce/growth-orders.test.ts`: `Offer read and delist stays within its bound as N grows`; unrelated subjects grow               |
| Order creation                         | Independently read 1 seller `offer` via PK during parent authorization; release that connection before buyer command. Insert 1 `purchase_order` via PK, snapshot price/royalty terms, no order grant initialization; buyer account point recheck and envelope with created event. Grow N/P/o, fixing buyer, offer, permissions and k=1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | R `O(1)`, B `O(L(N))`, body S 1 plus 1 parent offer read and dependencies; no buyer-history count.                                                                                                                                                                                                                                                                                                                                                                                                                          | `test/commerce/growth-orders.test.ts`: `Order creation stays within its bound as o grows`                                               |
| Checkout and receipt recording         | `checkout.ts`: create/replay order above, 1 current-order PK read before provider and 1 after. One Stripe session create with one item, stable order key, outside DB transaction. Each recorder attempt reads order once outside and once inside; `command-checkout-count.sql` ranges `core.receipt` PK by partition, buyer, kind and `[prefix,prefix+z)`, examining c entries; `command-checkout-record.sql` revision-checks/updates 1 order PK and checkout-session unique index. Envelope records numbered buyer receipt with outcome digest, full order response and updated event. Grow N/P/o, fixing order, outcome and c; exercise unknown then terminal outcome.                                                                                                                                                                                                                                                                         | Per recorder attempt R `O(1+c)`, B `O(L(N)+c)`, S 4 plus envelope; c<=2 makes this constant rows/logarithmic blocks. Full checkout adds order creation and 2 reads; conflicts repeat until the 5-second deadline.                                                                                                                                                                                                                                                                                                           | `test/commerce/growth-orders.test.ts`: `Checkout and receipt recording stays within its bound as o grows`                               |
| Order session and transaction reads    | Buyer/order partition: the order read returns 0–1 order via PK and its existing entitlement point read, then calls `readSubjectSummaries` once for the captured target id. The summary reads the subject's PK and labels in one statement in its partition and reads the cover summary when present. Session reads use the partial unique `purchase_order_checkout_session(route,checkout_session_id)`; transactions use one `order_transaction_order(route,order_id)` range for l rows, then sort by balance ID; the command invariant keeps l<=256. Grow N/P/o and unrelated subjects in the target subject's partition, fixing target order and l, then grow l with k fixed.                                                                                                                                                                                                                                                                  | Order/summary R/S `O(1)`, B `O(L(N) + L(S))`; transaction R `O(256)`, S 1, B `O(L(N)+256)` plus bounded `O(256 log 512)` spilled-sort block work. Release, Access and cover dependencies are also bounded.                                                                                                                                                                                                                                                                                                                  | `test/commerce/growth-orders.test.ts`: `Order session and transaction reads stays within its bound as o grows`; unrelated subjects grow |
| Order decision and settlement          | Before any commerce SQL, the adapter and trusted snapshot command reject more than `MAX_ORDER_TRANSACTIONS = 256` transactions with `CheckoutMismatchError`; the workflow fails without commerce writes. Read one order PK outside the command; inside, point-read order and entitlement and probe only the snapshot transaction IDs with `balance_transaction_id = ANY(:ids)` on the transaction PK (at most 256 keys). Before inserting new transactions, probe at most 257 stored keys on `order_transaction_order(route,order_id)` and reject if stored plus new would exceed 256. Lock/revision-check order and entitlement, update one order, insert only new transactions, and change at most one entitlement. Grant uses the order's immutable `targetSubjectId`, captured from the offer revision at order creation like the price; no seller-partition read. Grow N/P/l at fixed named keys and change k; replay rolls back the no-op. | For m named snapshot IDs, m<=256: R `O(1+m+k)`, B `O((1+m+k)L(N))`, S `O(1)` plus envelope; fulfilments that insert transactions add at most one `O(257)` index probe. Independent of unmentioned order history l. No cross-partition read. Decision CPU `O(m)` plus capped refund/dispute objects and supplied fee details.                                                                                                                                                                                                | `test/commerce/order-bounds.test.ts`, `test/commerce/growth-transactions.test.ts`                                                       |
| Entitlement grant change lock and read | Buyer partition: grant inserts 1 `entitlement` via PK, unique `(route,order_id)` and `entitlement_account_page`; revoke/restore/reason updates 1 via PK+revision; order lookup/lock returns 0–1 via unique order key, ID read via PK. Each primitive 1 statement; order lock precedes entitlement lock in settlement. Projection uses only returned row; these are internal settlement primitives, not separate public grant commands. Grow N/P/o/e, fixing order, entitlement and k<=1.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | R/S `O(1)` per primitive, B `O(L(N))`; no scan of buyer benefits or target resources, no membership write on grant.                                                                                                                                                                                                                                                                                                                                                                                                         | `test/commerce/growth-orders.test.ts`: `Entitlement grant change lock and read stays within its bound as e grows`                       |
| Entitlement list                       | Buyer partition: range `entitlement_account_page(route,account_id,entitlement_id)` below cursor, descending, s+1 rows; scopes/owner fixed. HTTP repeatable-read transaction adds 1 `core.partition` PK epoch read and BEGIN/COMMIT; signed cursor binds buyer/operation/epoch. Store helper is 1 range statement. No writes. Grow N/P/e/d, fixing buyer, s, row width and cursor validity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | R `O(s+1)`, B `O(L(N)+s)`, S 4 HTTP / 1 helper; independent of e/d except index depth, no OFFSET or scan from start.                                                                                                                                                                                                                                                                                                                                                                                                        | `test/commerce/growth-orders.test.ts`: `Entitlement list stays within its bound as d grows`                                             |
| Royalty computation and payout record  | One buyer-partition order PK read and one transaction PK key read of only the event's `transactionIds` (m<=256), filtered to that order; no history reread. Compute only these lines and run one creator-partition command. `payout-record.sql` probes only their `royalty_line` PK keys, inserts missing lines, aggregates only inserted lines, and incrementally upserts the creator/UTC-month/settlement-currency statement. Redelivery adds nothing and no-op rolls back its receipt/outbox position. After the upsert, `grantAccountRole` writes at most one creator-account owner grant from command T via the temporal GiST PK in the same command transaction; a grant current at T is unchanged. Grow N/P/l/q at fixed named keys and k.                                                                                                                                                                                                | Commerce and the Access port R `O(1+m+k)`, S 4 plus envelope, B `O((1+m+k)L(N))`, independent of unmentioned l and creator sales q; arithmetic is linear in m and supplied fee details. The temporal owner-grant GiST overlap-check guarantee remains separate. One statement row lock per command serializes that creator's royalty recording for the UTC month and currency; accepted because recording is an effect after checkout and never on the buyer path. Spread this row only if measured effect lag warrants it. | `test/commerce/growth-transactions.test.ts`, `test/commerce/payouts.test.ts`                                                            |
| Statement read and list                | Creator account authorization, then 0–1 `payout_statement` PK row with hard creator equality for read; list uses `payout_statement_creator_page(route,creator_account_id,statement_id)` descending below cursor, at most s+1 rows. Same creator partition; projection divides persisted weighted numerator, no royalty scan. Grow N/P/q/d, fixing creator, s and permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | R `O(1)` read / `O(s+1)` list, B `O(L(N)+s)`, S 1 plus authorization; independent of q/d.                                                                                                                                                                                                                                                                                                                                                                                                                                   | `test/commerce/growth-payouts.test.ts`: `Statement read and list stays within its bound as d grows`                                     |
| Payout lines page                      | Authorize creator and read 0–1 statement PK with owner filter, then `royalty_line_statement_page(route,statement_id,balance_transaction_id)` above cursor ascending, at most s+1 lines in creator partition; no writes or total count. Grow N/P/q/l/d, fixing statement, s and permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | R `O(s+1)`, B `O(L(N)+s)`, S 2 plus authorization; no depth or payout-size scan.                                                                                                                                                                                                                                                                                                                                                                                                                                            | `test/commerce/growth-payouts.test.ts`: `Payout lines page stays within its bound as d grows`                                           |
| Mark paid                              | Route-0 root authorization is prepared and checked at each attempt time, releasing root connection before creator transaction. Creator partition: 1 statement PK read and 1 conditional PK update (open, completed UTC month); guard inspects only OLD/NEW. Receipt replay reauthorizes; envelope emits paid event. No Stripe transfer or payout-line read. Grow N/P/q/l, fixing statement, k=1 and root permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | R `O(1)`, B `O(L(N))`, S 2 plus authorization/envelope; independent of q/l.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `test/commerce/growth-payouts.test.ts`: `Mark paid stays within its bound as q grows`                                                   |
| Webhook and commerce jobs              | Webhook verifies <=256 KiB body against configured secrets, no Access check or commerce SQL, then enqueues one DBOS workflow keyed by event ID. `commerce.stripeEvent` resolves at most 1 session (PaymentIntent filter, limit 1), clocks once (`work-clock.sql`, no relation, 1 result/statement), reads provider snapshot and applies settlement above. `commerce.reconcileOrder` reads at most 2 order PK rows, optionally creates/records checkout, syncs at most twice with 2 clocks and one durable sleep. Royalty effect passes the event transaction IDs to one `recordTransactions`; order-created effect enqueues one reconciliation delayed 900 seconds. `src/work/` registers fixed queues/modules against shared DBOS system DB. Grow N/P/o/q, fixing one job/ref, provider history l, k and retry configuration.                                                                                                                   | Wrapper SQL R/S `O(1)`, B `O(L(N))`, plus the invoked checkout/settlement/royalty bounds, with snapshot transactions capped at 256 and source reads restricted to named keys. Stripe steps retry at most 5 times; SDK defaults add network retries. DBOS persistence/index/block/statement bounds are not established by these wrappers; constant enqueue/step call count is not a DB cost proof.                                                                                                                           | `test/commerce/growth-orders.test.ts`: `Webhook and commerce jobs stays within its bound as N grows`                                    |
| Erasure                                | No commerce erasure command/job/SQL exists; order and royalty transaction DELETE/UPDATE triggers reject one attempted row, while offer delisting and entitlement revocation preserve records. No fanout deletion or erasure projection to derive. Grow N/P/o/e/q, fixing rejected point target.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Absent operation: R/B/S 0; a direct point-delete attempt on immutable transaction PK has R/S `O(1)`, B `O(L(N))`, then raises without changing rows. No bound is claimed for arbitrary administrative deletes.                                                                                                                                                                                                                                                                                                              | `test/commerce/growth-orders.test.ts`: `Erasure stays within its bound as N grows`                                                      |

Offer initialization and payout owner-grant insertion use temporal GiST constraints, whose worst-case block cost cannot be derived as a B-tree logarithmic probe.
Settlement snapshots are capped at 256 transactions before SQL; settlement and royalty recording probe only the keys named by their run, so unrelated accumulated order history does not increase rows or statements.
`test/commerce/growth-transactions.test.ts` uses one seed method for order transactions and their royalty lines at histories of 1, 64 and 255 transactions, then measures one newly named transaction. It compares statement counts and returned rows across those scales, checks the transaction PK key probes, and verifies that replay and royalty redelivery leave accounting unchanged; block bounds remain the index derivations above.
`test/commerce/order-bounds.test.ts` covers all 256 transactions, rejects 257 before SQL with a visible workflow failure, and grants an entitlement after a privileged fixture deletes the offer, proving that settlement uses the order's captured target.
Checkout's receipt-prefix count examines c entries rather than o orders, and its state-derived c<=2 cap prevents a buyer-history count on the exposed recorder path.
Payout recording aggregates inserted lines rather than q sales, while entitlement, statement and payout-line keysets seek directly to their cursor and do not grow with d.
Settlement grants use the target subject captured on the order at creation and read no seller-partition offer.
Every successful command serializes on its partition-wide `core.partition.position` counter (not a single all-partitions counter), and creator-period-currency payout upserts also contend on one statement row.
Parent/root authorization and royalty source reads are separate anchored checkouts rather than cross-partition joins, but the shared pool and shared DBOS system database in the current composition do not prove independently routed multi-machine execution costs.

### Native refresh admission and application

- Touches: one bound order lock and metadata-only stable completion PK lookup; if uncompleted, one real conditional
  revision claim, order-updated event, attempt receipt and envelope. Release before bounded provider identity/full
  reads. Apply adds native account share/order/benefit locks, named transaction probes/changes and stable receipt,
  plus incremental creator accounting and shared DBOS persistence. No history/catalogue scan or cross-home held
  connection; all retries, claims, no-ops, events, payload bytes and pool time are charged.
- Bound: constant keyed claim/lookup work plus bounded named apply work, using existing maximum 256 transactions
  and 257-key total-count lookahead. Current provider caps are 100 refunds and 10 disputes, with advancing-page
  validation; source pagination, nested expansion/fee-detail bytes, total sends and remaining deadlines need real
  enforced/measured bounds. Stripe steps currently allow five attempts plus SDK network retries; no combined
  attempt budget is implemented. Shared DBOS partition walks/sorts, backlog and fork/rewind history work require
  measurement; fixed wrappers or timeouts alone prove none of those bounds. No numeric plan allowance is invented.
- Growth check: retain the existing named-key histories 1/64/255 and 256/257 boundary evidence in
  [growth transactions](../../test/commerce/growth-transactions.test.ts) and
  [order bounds](../../test/commerce/order-bounds.test.ts). Require real SDK/native first and replay/superseded/
  no-op/completed-A attempts and named repair at three legal unrelated-data/history scales. Grow unrelated orders,
  creator history, provider history, DBOS backlog and partition count independently with selected keys fixed;
  include cancellation/timeouts and terminal races. Measure examined rows, buffers, statements, provider elements/
  bytes, pool time and persistence, including abandoned work and retries. These measurements are absent and this
  prose change executes none. The old growth-orders “Webhook and commerce jobs” case measures a known-order read,
  not a real signed-event queue run; its pass cannot fill this gap.

### Financial erasure participation

- Touches: exact account-linked owner indexes, the restricted retained subset and producer-owned exact shared
  receipt/outbox/work payload locators, plus Accounts' participant completion acknowledgement.
- Bound: bounded child pages and durable checkpoints, terminal fence before effects, byte/effect limits and actual
  cleanup/no-data acknowledgements. No global history/principal/JSON scan or mass cascade; index and locator design
  must precede a cost claim. The existing Erasure row measures rejected point deletion, not erasure participation.
- Growth check: require native T read-fence, late-webhook no-resurrection, full fixed-participant completion and
  retained-field expiry at three legal scales, growing account history and unrelated data separately while fixing
  child-page size. Measure source rows before filtering, retained/shared bytes, buffers, statements and retries.
  No such Commerce operation or measurements exist yet; this documentation change executes none of them.
