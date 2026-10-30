# Commerce

Commerce owns the purchase journey: offers, captured orders, payment evidence, account-bound benefit entitlements
and attributed creator royalty statements. This is the current owner contract, adopted from the delivered
[ownership and benefits research](../../../../docs/research/commerce-ownership-entitlements-benefits.md) and
[payment evidence research](../../../../docs/research/commerce-payment-evidence-settlement.md).
Research is evidence; this document owns purchase behavior. The [Commerce Goal](../../../../docs/goals/commerce.md)
owns delivery, native acceptance and promotion requirements. [Library and Collections](../../../../docs/library-and-collections.md)
owns personal facts; the separate [Library Goal](../../../../docs/goals/library.md) retains those obligations under
the same commerce manager. [Future modules](../../../../docs/commerce-modules.md) owns the unimplemented financial
module map. Specified behavior, source presence, native proof and delivery on main are separate states.

## What is bought

Keep these identities separate:

- A **subject** is the public catalogue identity, not protected content or authority to sell it.
- An **offer** is a creator-owned acquisition proposal with a revision, price and terms.
- An **order** records one buyer's accepted, immutable offer terms and acquisition intent.
- **Payment evidence** records provider observations and financial movements; it is neither an entitlement nor cash
  available to pay a creator.
- A **benefit** identifies exactly the promised target, action and immutable delivered version. A purchase-derived
  **entitlement** records that buyer's current eligibility for that benefit through existing Access.
- Library states, copies, labels, progress, Collections and follows are independent personal facts.
- A future **transferable item** has its own identity and ownership generation. Today's licence is not such an item.

The first sale is one-time, account-bound, **one immutable fixed-version benefit, quantity one**, at a positive price.
No bundles, gifts, subscriptions, consumables, wallet, issued token/points, market, exchange or ledger implementation
is included. This adopts the research's fixed-version recommendation without adopting its illustrative benefit-kind
union, update-channel promise or proposed shared API signatures. There is no general benefit-kind registry to build.

The creator home owns the immutable captured Content-edition terms alongside its offers; Content owns the actual edition definition and publication. Its immutable version must identify the subject,
exact owner resource/version, adopted action, delivery promise and accepted terms. Offer publication needs both
Commerce selling authority and the target owner's current authority to license that target; an offer grant or a
subject reference alone is insufficient. Accounts owns the Access mechanism and the target owner owns final use.

An order captures offer ID/revision, creator, subject, title, currency, unit amount, tax code and royalty basis.
The benefit extension must also capture the exact benefit/version, quantity, target/action and terms/delivery
promise. Repricing or delisting changes future acquisition, never captured terms or a paid order's identity.
Current account eligibility, target availability, rights restrictions and takedown remain separate current facts.
Historic subject-only orders have **UNKNOWN benefit mapping** until an explicit authorized creator/target-owner
mapping is adopted and recorded. Show “purchase recorded; benefit unavailable” rather than grant all subject content.
Buying creates no Library copy, state, progress or public activity; Library Undo cannot reverse payment truth.

## Journey, APIs and native homes

Commerce delivers its journey pages with Web's shell, shared UI and patterns. Web owns navigation, design-system
patterns, Storybook organization and visual review; its existing checkout/history producers remain handoffs to
integrate, not duplicate rewrites. Shared subject-page changes coordinate with its owner. Every journey needs real
API/storage behavior plus reviewed pages; an interim fake or an entitlement row is not final-use proof.

| Person's step                      | Existing surface and remaining work                                                                                                                                                                                                                                                                                                                                              | Native authority                                                                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find a benefit on a subject        | Subject page needs a bounded subject-to-active-offer discovery port and entry. Its signature/producer are pending shared adoption below. Public descriptions and private ownership use separate responses/cache keys.                                                                                                                                                            | Semantic owns subject identity/disclosure; creator homes confirm exact active offer/benefit keys. No all-creator or buyer scan.                                                                             |
| Review the offer                   | `GET /v1/offers/:offerId`, existing `/offers/$id` page. Add the captured benefit/version, delivery promise and terms display using the adopted native target.                                                                                                                                                                                                                    | Creator home; `offer:read`, `gate:purchases`, subject disclosure separately. Delisted public reads match unknown `404`, even for the seller, before subject-summary reads.                                  |
| Accept and pay                     | `POST /v1/orders` accepts the observed offer revision under the sole offer-consent delivery. Its adopted request is `{offerId, expectedOfferRevision}`; the command digest includes that revision. The consent writer owns implementation; the current base still exposes the older request. This benefit delivery does not introduce a competing writer. No fresh Checkout is available while the Content authority adapter is unavailable. | `order:create` on the offer, `gate:purchases`, verified active buyer; buyer-home order/receipt before provider I/O. Selling/target authority is confirmed through owner ports, never a cross-home SQL join. |
| Return and find the purchase later | Existing `/orders/$id`, `/orders`, `GET /v1/orders/:orderId`, `GET /v1/orders`. Display captured terms, pending/unknown honestly and link current entitlement. Redirects have no fulfilment power.                                                                                                                                                                               | Buyer home; actor equality and `order:read`. No arbitrary buyer selector, including accounts sharing a route.                                                                                               |
| Inspect owned benefit              | `GET /v1/entitlements` and `GET /v1/entitlements/:entitlementId` exist. Complete private owned-benefit navigation and detail with mapped benefit/version, active/revoked/unavailable explanation and a disclosed use link.                                                                                                                                                       | Buyer home, authenticated owner and `entitlement:read`; other owners supply permitted target summaries. History or a cached entitlement response grants no use.                                             |
| Actually use it                    | Target-owner page and protected server endpoint must enforce existing Access with current exact-benefit eligibility. The exact edition/action/version is adopted; native producer and Access use integration remain pending.                                                                                                                                                                     | Buyer home supplies current eligibility; target home owns resource/action/lifecycle and final protected serialization or delivery. No second Access engine.                                                 |

Creator minimums are an offer/benefit editor and owned-offer list, a bounded private sales view, and statement/detail
views. Existing HTTP mutations are `POST /v1/offers`, `PATCH /v1/offers/:offerId` (price), and
`POST /v1/offers/:offerId:delist`, under `offer:create`/`offer:manage` and `gate:selling`.
Owned-offer listing, benefit publication/versioning and creator-sales projections are still missing interfaces;
no guessed route or signature is adopted here. Creator-home sales projections use stable buyer-order effects,
show lag/unknowns and only necessary accounting/order locators, not buyer email, Library activity or use telemetry.
They cannot authorize use or establish complete provider settlement. Existing statement APIs are
`GET /v1/payoutStatements`, `GET /v1/payoutStatements/:statementId`,
`GET /v1/payoutStatements/:statementId/lines` and `POST /v1/payoutStatements/:statementId:markPaid`, with the existing
`payout_statement:list/read/mark_paid` checks. A statement read grants no arbitrary buyer-order access.

### Adopted native Content edition and delivery state

The first target is native `content.edition`, action `edition:read`, naming an actual authored Content post revision
by `{revisionId, sha256}`. Edition ID, source tuple, creator and immutable revision licence never retarget. Creating
another edition is necessary to sell another revision. Images, origins, URLs, Library copies and generic subject
permission are not this product. The selected edition must have an actual native subject binding; an unrelated
public subject cannot relabel it. Fresh `POST /v1/offers` accepts `contentEditionId` and ordinary commercial terms,
not client-supplied benefit/source/version/creator/licence/action/subject or a sale-authority boolean.

Content owns immutable edition creation/publication and the sole current sale port
`content/edition-sale.ts:readContentEditionSaleAuthority`. It must establish authenticated creator equality with
both native post/revision authors, current `edition:sell` and `post:revise`, exact source/digest/licence, active
account, creator-readable current ancestry, and available published or explicitly protected source. A delegated
publisher, moderator, imported author field or ordinary grant cannot establish authorship or copyright. This
metadata is a declared licence, not an exclusive rights claim. Commerce does not implement that verifier.

The closed benefit type is `ContentEditionBenefit` in [model](model.ts). Commerce's captured DTO is:

```ts
type CapturedContentEdition = Readonly<{
  benefit: ContentEditionBenefit;
  creatorAccountId: string;
  targetSubjectId: string;
  source: Readonly<{threadId: string; postId: string; licence: string}>;
  saleTermsReference: string;
  delivery: 'fixed-content-edition';
  acquisition: 'one-time-account-bound';
  quantity: 1;
}>;
```

`contentEdition` on offer/order/entitlement HTTP reads is this object with `source` projected to `{licence}`
(or explicit null). Source thread/post IDs stay internal; Content alone discloses source metadata with current
native authority. The public terms DTO never contains a revision body. Creator/title/subject,
offer revision, accepted currency/price/tax/royalty terms remain captured by the existing order fields. Capture is
stored atomically in creator-home offer and buyer-home order/entitlement rows, never an authoritative cross-home
join. The JSON is bounded to 4096 UTF-8 bytes; licence/terms reference are at most 256 characters each; revision
body is forbidden. Immutable SQL guards include null historical mapping. No migration infers an edition from
subject, newest revision, label or payment metadata. Historical reads/authorized receipt replays retain identity;
a new subject-only create cannot silently create a benefit. Price changes never change the capture.

**Source delivered, producer pending.** This base has no `content/edition-sale.ts` or closed callable declaration.
[benefit](benefit.ts) exposes only the typed `content-edition-sale-port-pending` unavailable state, with no
injected verifier or synthetic success. Ordinary current Commerce create authorization and receipt replay happen
before fresh target admission. Fresh offer/order/Checkout creation fails closed; the adapter must be replaced by
the real Content import with its actual dependencies/result before any sale is enabled. Source licence and sale
terms reference must be mapped from that producer, not invented from request input. Capture/recheck call sites
bound the work; no foreign client is held across provider I/O and no earlier check is reusable permission.

Paid financial truth, named evidence and refund/dispute revocations still apply when target authority is missing.
Absent/revoked entitlements cannot be granted/restored without complete paid evidence AND current Content sale
authority. A last-verified active entitlement is preserved through transient target unavailability; unavailable
mapping does not fabricate payment failure/refund or erase history. Full-refund/dispute revoke the same row with
its original binding; partial-refund and terminal account/receipt/admission rules remain unchanged.

The native Accounts consumer reader is
`store.readContentEditionEntitlement(client, buyerAccountId, entitlementId): Promise<Entitlement | null>`.
It uses one exact `(buyer route, entitlement id)` query, owner equality, mapped capture and no revocation. This is
Commerce data, not an authenticated opaque Access fact. Accounts separately issues its own current exact
buyer+edition+version+action fact through existing `preparePermission/checkPreparedPermission`; Commerce does not
invent that ABI or imply an active row authorizes bytes. Content independently checks edition version, exact
source/licence/digest/lifecycle/security fences, ancestry and Realm/Space before preparation and final disclosure.
Unpublish/erasure makes delivery unavailable without inventing a refund; no alternate revision is substituted and
no Library record is created. Subject discovery, real native sale/use proof, reviewed UI and promoted-main journey
remain pending. The local kernel compiler typecheck passes for this source delivery. No acceptance, unit, native, database,
browser or remote check was run; the temporary compiler database was used only by that typecheck. This is not
whole-journey acceptance. Generated OpenAPI/client artifacts and native/interface gates remain controller work.

### Private buyer history

`order.list` uses `gate:purchases` and `order:read` before private SQL. It returns `{orders,next}`, default 20,
maximum 100, descending immutable routable order UUIDs and a strict exclusive keyset. Its signed expiring cursor
binds operation, viewer and partition epoch; changed epoch yields `stale_cursor`. Limit may change between pages.
Malformed/foreign cursors fail closed. The generated caller is `client.orders.get({query:{limit,cursor}})`.
Rows contain captured terms, nullable fulfilled tax, settlement, creation/Checkout navigation and entitlement ID.
History reads no current offer, price, subject summary or provider Session and cannot revive a delisted offer.

One read-only repeatable-read snapshot reads epoch and `(route,buyer_account_id,order_id)` keyset, at most `k+1`
orders, followed by at most one same-route unique-order entitlement probe per selected row. No count, offset,
history walk, global Session index or client held across foreign/provider reads. Indexed blocks are
`O((k+1) * L(N))` with bounded page sorting, not constant physical latency.

## Seller and provider boundary

Use one direct US Stripe account, hosted Checkout and Managed Payments with **REZICS as direct licensed seller**.
Creator royalties occur outside Stripe; Connect is not required merely to pay those royalties. Actual distribution
rights, business/product eligibility, account activation and setup are **EXTERNAL and unproved**. This model does
not authorize collecting on behalf of independent sellers. Stripe's MoR services cover the supported payment/tax,
refund and dispute responsibilities described in the provider report; REZICS still owns lawful supply, product
support, fulfilment, creator agreements and residual obligations outside that coverage. Ordinary automatic tax
is a different merchant-responsibility configuration, not MoR approval. Preserve its existing compatible fixture
without treating the fallback as first-slice Managed Payments qualification.

REZICS remains catalogue authority: captured inline `price_data`/`product_data`, one item and no Product/Price sync.
Inline product creation can still create a Stripe Product. The pinned dependency is **stripe 23.0.1**, whose default
request/type version is **2026-09-30.endive**. The webhook snapshot endpoint version is configured separately and
must be explicitly recorded/validated; the actual deployed endpoint version is not established here.
`event.api_version` is diagnostic provenance, not an upgrade mechanism.
An older Event's snapshot does not become current by retrieval. No silent SDK, API or status-union upgrade.
Bounded evidence of actual Session Managed Payments configuration is required before claiming deployment readiness.

External configuration: `STRIPE_SECRET_KEY`, `STRIPE_MANAGED_PAYMENTS`, `CHECKOUT_SUCCESS_URL`,
`CHECKOUT_CANCEL_URL`, `STRIPE_WEBHOOK_SECRETS`, configured `STRIPE_ACCOUNT_NAMESPACE` (default `direct`) and
`STRIPE_LIVEMODE` (default `false`, explicitly set for live). Namespace/mode come from configuration, never payload
or key text. Current config accepts `sk_test_`/`sk_live_`; restricted-key support is not established.
`STRIPE_API_HOST` is a fixture override. Missing/invalid/partial config leaves provider operations unavailable.
Public HTTPS ingress, trusted arrival time, endpoint-specific rotating secrets, migrations and the existing
worker/effects relay are external setup; signed-fixture implementation does not wait for private keys.

Success/cancel URLs are absolute HTTPS, allow `{ORDER_ID}` substitution and pass Stripe's `{CHECKOUT_SESSION_ID}`
through; other brace placeholders fail startup. Provider bank payout (`po_`), account transfer (`tr_`) and an external
creator payment reference remain separate identities. Neither a Stripe payout status nor a statement row proves
an outside-Stripe creator payment.

## Commands and creation uncertainty

Use shared native command receipts, scoped by partition, verified principal kind/ID, command kind and key.
Hash complete semantic intent including path targets. Reauthorize client replay before receipt lookup/disclosure;
changed tokens do not change principal identity. Revoked/suspended authority cannot replay private results.
Create-order includes the offer; revise/delist include their offer; mark-paid includes statement/payment reference.
Generic internal offer reads remain for authorized management/history; public delisting concealment is separate.

Commit immutable order/receipt before external creation. The required creation correction captures first physical
attempt time, exact key `order:<orderId>`, parameters, resolved return URLs, tax mode and expiry in the buyer home
before I/O. HTTP and worker paths must share it, release native clients before I/O and reuse exact captured semantics
after configuration changes. Provider idempotency, native receipt lifetime, Event dedupe and movement uniqueness
are distinct. Retry must never change parameters/key or outlive the safe idempotency/expiry window.

The local safety policy is earlier of first attempt +23 hours and captured expiry -30 minutes, reserving another
20 seconds for provider work. Expiry remains order creation +1 hour, not a renewed promise. A never-started expired
intent can fail without creating; a started or historically uncertain intent without trustworthy attempt evidence
stays unknown and requires reconciliation. Lost success response is not permission for a fresh Session/key.
A definitive no-creation rejection must be supported for this attempt and cannot erase prior uncertainty.
**StripeIdempotencyError, mismatched old retry, in-flight conflict, cached server failure and network loss are
unknown/unavailable, not definitive no-session rejection.** Ambiguity is never rejection.

A recorded Session uses exact native binding. Lost binding recovery needs an authorized exact Session candidate
validated against order, configured namespace/mode and provider correlations; there is no public arbitrary binding
API, metadata-based buyer selection or global search. Automatic creation stopping does not prove the payment failed.

## Signed ingress, refresh and recovery

`POST /v1/webhooks/stripe` verifies exact raw bytes before JSON/domain routing, with a 256-KiB body limit,
8192-byte UTF-8 signature limit and at most four distinct nonempty configured secrets. Oversize/invalid signatures
have no durable/payment effect. Pinned SDK tolerance rejects age over 300 seconds against trusted arrival time;
it is not a symmetric future-skew rule. Await durable enqueue before acknowledging. Signed body payment claims
schedule fresh reads; they do not fulfil orders. Event ID dedupes delivery, not every future change of its object.
Retain bounded type/object/version/account/mode provenance; validate object kind/type and correlation.

Resolve direct Session, PaymentIntent-derived adverse events, initial/expiry, event recovery and named repair to
one immutable native order/Session binding. Locator fields are untrusted correlation, never buyer authority or
financial truth. The existing unexpanded `readCheckoutLocator` and exact-order resolver validate routable order,
matching client reference/metadata, configured mode and recorded Session before full financial reads.
PaymentIntent routing additionally charges a filtered Session list. Missing/foreign correlation is unavailable,
never a successful empty anchor or a sweep. No native client spans provider I/O.

Use existing DBOS `effects`, `partitionConcurrency:1`, with
`commerce:<configured-account>:<live|test>:<Session>` keys; event/order/expiry/repair parents stay on `workflows`.
Different Sessions can progress concurrently. Each trigger has a distinct stable refresh identity: completing one
Session workflow forever would suppress later refunds. Queue occupancy alone does not exclude overlapping abandoned
bodies, timeouts or recovery; native revision fencing remains authoritative.

<a id="receipt-aware-native-refresh-admission-implementation-pending"></a>

One combined physical attempt resolves, admits, reads fresh provider evidence and applies:

1. Take buyer `shareAccount` before exact order lock. Authorize the immutable service apply intent and, under that
   lock, use shared `hasOwnCommandCompletion` metadata before any write. Completed intent exits read-only without
   old response, revision claim or provider read; an old completed A cannot claim over admitted B.
2. For an uncompleted intent, conditionally advance order revision, emit the real order-updated event and commit
   native receipt/envelope. It is a coordination write even if business state will not change. Generate fresh physical
   attempt identity; SQL retries retain it. Fail on overflow/ambiguous admission; no authority from an uncertain claim.
3. Release the connection, then read and validate current Session/payment/adverse evidence against captured terms.
   Separate provider GETs are **not an atomic multi-object snapshot**. Changed/mixed observations need convergence,
   reconciliation and another fresh attempt, never event/arrival timestamps as object revisions.
4. Apply `commerce.checkout.apply` with original `wf:{id}:apply` and digest `{orderId}`. Receipt replay precedes body.
   Fresh body locks order, keeps the captured revision/Session through commit and SQL retry, and atomically changes
   buyer order, named transactions, entitlement and receipt/outbox. Superseded apply rolls back without apply receipt;
   retry requires new admission/read. Business no-op rolls back apply but retains committed admission.

`beginCheckoutRefresh` and `applyClaimedCheckoutSnapshot` in [commands](commands.ts) supply this native contract;
legacy `applyCheckoutSnapshot` retains timestamp behavior for compatibility and is not the production guarantee.
The local order lock ensures old evidence cannot commit after a newer admission, even when the newer apply fails,
is cancelled or does nothing. `observedAt` and `event.created` are diagnostic, not authority.

DBOS `5.4.6-preview` recovery/cancellation may overlap live bodies; checkpoint ownership is not a native commit fence.
Resume/fork/rewind must preserve `effects` and Session routing explicitly. Fork preserves the source; rewind requires
terminal history and cannot undo native money/receipts. Cancellation is cooperative, not an atomic cancel-to-commit
barrier. Physically drain old unfenced binaries before relying on admission. Retained old split-step adapters discard
cached financial output and delegate with the original stable apply intent; supported function cuts and recorded
application version must be preserved. No new queue/runtime/receipt engine is introduced.

Paid orders remain repairable through `enqueueKnownOrderRepair(orderId,name)` with a new bounded repair identity;
reusing a name dedupes it. Initial/expiry paid/failed shortcuts are not late-payment recovery.
`recoverSignedEventPage` admits at most 100 signed deliveries, verifies the whole page before dispatch, and returns
count/last Event ID. Each delivery keeps the raw-body/signature limits and current valid signature. Use real resend;
never synthesize signatures, bypass stale signatures or widen tolerance for archived bodies.

Authenticated provider Event enumeration/retrieval is a **different, pending recovery port**, requiring explicit
account/mode/version provenance and the same bound refresh path. It is not signed HTTP ingress. Recommended outage
slices of 24 hours, 100 Events per invocation within provider Event retention, checkpoint/continuation and operator
escalation require owner/Root adoption before runtime bodies. Outside retention or missing metadata remains visible
unresolved debt; use exact known-order repair where possible. No global paid-history sweep or promised resolution time.

## Historical payment and current entitlement

Settlement is `pending | paid | failed | unknown`; reconciliation is work, not a fifth state. `paid` is monotonic
historical purchase payment, not bank settlement, current access or irreversible financial finality. Unpaid/processing
never grants; failed describes the current attempt, not permanent impossibility of later verified payment.
Positive-price offers do not admit `no_payment_required` as fulfilment.

Grant/restore requires correctly bound complete paid evidence and complete adverse-state evidence. The
[adapter](stripe.ts) validates the payment-mode Session → expanded PaymentIntent → expanded Charge, including
identity, mode, presentment currency, positive integer amounts and captured paid evidence. Before flattening,
each Refund/Dispute must match that exact PaymentIntent and Charge. Both adverse lists must be complete under the
100-refund/10-dispute and 111-logical-read bounds; charge refund totals and adverse lists must agree. Validation is
O(k) over bounded evidence and does not expand the existing transaction, request, byte or deadline caps.

Missing/unexpanded required associations, foreign association/currency, unsupported adverse status, malformed,
repeated, nonadvancing or capped pagination, and mixed/incomplete evidence are unavailable through the existing
sanitized `StripeUnavailableError`. Nullable associations never prove adverse-none for a historically paid order.
Both native apply ports validate after current authorization, receipt replay and claim fencing. Unavailable evidence
writes no settlement/entitlement/transaction decision or apply receipt: active stays active, revoked stays revoked,
historical payment truth and committed admission remain, and durable retry/reconciliation debt stays visible.
It grants/restores nothing and never speculatively classifies an unsupported dispute as active, lost, won or absent.
A currently revoked entitlement **never restores from unavailable evidence**. Missing a Balance Transaction alone
is separate from paid/use evidence: a complete associated paid purchase may grant before provider cash is available;
financial incompleteness can hold accounting without inventing an unpaid purchase. Record only actual associated
balance movements, never a debit/reversal inferred from status. These requirements retain the delivered
[payment-evidence corrections](../../../../docs/research/commerce-payment-evidence-settlement.md#findings-requiring-a-correction-or-explicit-adoption)
without claiming a new native or promoted-main result.

Compatible indivisible-benefit policy:

- Partial refunds retain the whole benefit. Aggregate full same-charge/currency pending or requires-action refunds
  provisionally revoke; full succeeded refunds revoke. Failed/cancelled refunds may restore only with complete current
  evidence and no other blocker. Provisional revocation does not manufacture a cash debit.
- Known active (`needs_response`, `under_review`) and lost disputes revoke. Verified won may restore absent other
  blockers; “lost” is blocking while lost, not a promise that a late verified win is impossible. Warnings/inquiries
  and prevented disputes retain access under current policy. Unsupported future status is unavailable, preserving
  last verified state; it cannot mask known active/lost evidence or restore a currently revoked entitlement.
- Terminal buyer T always prevents grant/restore and private reads. Use the real account share barrier in the same
  transaction, account before order, reacquired on retry. Catch only actual `LifecycleDeniedError` to remove personal
  benefit effects; availability/SQL/deadline errors roll back. Permitted financial reconciliation continues without
  recreating private relations. This barrier is not whole-account erasure proof.

## Financial evidence and creator statements

Use actual signed Balance Transaction economics once per scoped movement ID, including refund/dispute reversals.
Status alone creates no debit/credit. Compare retained order association, source/kind, currency, signed amount,
fee/net, FX, provider creation time and fee classifications/amounts. Fee-detail order and mutable descriptions do not
change immutable economics. Exact duplicates have one transaction/creator-line/aggregate effect, including later
months. Conflicting retained economics require typed integrity failure, rollback and reconciliation, never overwrite
or silent skip. A real correction/reversal has its own evidenced movement identity.

Creator attribution independently binds creator, order, offer, captured royalty rate, provider time and calculated
amounts. Named buyer evidence feeds creator-home immutable lines and incremental per-UTC-recording-month/currency
statements, not cross-partition joins/transactions. Late adjustments enter the recording month and never rewrite
paid prior statements. Existing Accounts `grantAccountRole` after statement upsert stays in the creator transaction;
modules do not write Access SQL.

Keep these distinct: **provider cash movement**, **historically paid purchase**, **current entitlement**,
**attributed creator earnings**, **reserves/payability**, **external payment attestation**. Order-linked movements
are not the full Stripe account ledger: standalone fees, reserves, adjustments, availability and bank payout batches
need their own reconciliation, not allocation to arbitrary buyers.

Current [royalty calculation](royalty.ts) is identified compatibility policy: it separates documented withheld tax,
uses a Session-derived conservatively rounded tax reserve when withheld evidence is missing, treats `tax` fee detail
as fee tax, and excludes non-withheld dispute-movement fees from creator deductions (REZICS bears them). These are
local allocation/reserve assumptions, **not provider facts**. Preserve actual provider gross/fee/net separately;
unknown classifications/FX/tax evidence cannot justify payment. A full customer refund need not zero net receipts
or earnings because tax/fees may remain. Do not fabricate tax credits, zero fees or full reversal evidence.

Further commercial/shared adoption is required before runtime bodies: explicit tax-exclusive captured/displayed
prices and Stripe-supported currency/unit mapping; separate integration/presentment/settlement amounts; provider
allocation versus reserves, release conditions, same-currency negative carry and positive evidence-complete payable
rules; and richer external attestation with actual date/method/amount/currency/reference. These are the provider
report's recommendations, not hidden adopted economics. Reserve duration, clawback, thresholds, partial external
payment, correction states and FX netting remain unchosen. Existing mark-paid records an authorized external reference
on a statement; it sends no Stripe transfer and does not prove payability or external finality.

The [module map](../../../../docs/commerce-modules.md#preserve-todays-facts-for-a-later-ledger) owns future immutable
party/capacity, benefit/terms, money/unit, source/effect and royalty evidence requirements. Historical incomplete
facts stay unknown. Future reconstruction versus reconciled opening balances is an explicit accounting choice;
no synthetic historical balanced postings or current ledger implementation.

<a id="deletion-and-account-private-minimization-first-public"></a>

## Privacy, lifecycle and cost

Orders, entitlements and use history are private; public offer/subject caches exclude private ownership.
Disclosure/rights stay with existing Access and target owners. [Shared deletion](../../../../docs/deletion.md) and
[Accounts erasure](../access/README.md#erasure-consumers) govern T, restricted retention and fixed-participant completion.
Financial Commerce is separate from Library's erasure participant. It must acknowledge actual minimized cleanup
or no applicable data, never mere dispatch; minimal completion outside workflow history prevents late resurrection.
No account restore, hold engine or new lifecycle service is authorized.

At T conceal private orders/statements/entitlements and fence late producers. Minimize offer party data, buyer/target
relations and Checkout payloads, entitlement relations, immutable transaction/royalty source relations and statement
payment references except the restricted legally necessary fields with purpose and expiry. Immutable guards do not
create retention exemptions. Enumerate exact shared receipt/outbox/write-basis/work payload locators; actual store
owners minimize and acknowledge them. Account-linked indexed child pages and atomic checkpoints must replace global
principal/JSON/history scans. Full financial erasure participant, shared custody and retained-field expiry remain
undelivered; the account barrier alone does not close them. A jurisdiction/category/field retention schedule and
provider metadata deletion limits are external conditions, not a reason to omit deterministic fence/cleanup work.

Every provider attempt charges all sends/retries/body parsing, expansions, abandoned work and capacity until physical
settlement. Existing transport limits are a shared 20-second maximum deadline (respect shorter caller deadline),
256-KiB per body, 16-KiB request/response headers and aggregate input strings, no redirects, at most two network retries,
4096 nested containers/depth 16 and 256 total fee details. Full read admits at most 111 logical requests
(1 Session +100 refunds +10 disputes), other operations one; total sends are at most logical maximum times
`max(2,1+retries)`, with shared logical-maximum-times-256-KiB byte budgets. Eight physically unsettled provider operations
share process capacity; eight physical refresh bodies per worker registration are separately bounded. Native apply
admits at most 256 named transactions (257-key lookahead). Caps are local work limits, not provider population promises;
exceeding one returns unavailable with visible reconciliation debt, never truncation to “no adverse evidence.”

Native reads/writes name owner-leading indexed keys; creator recording touches only named movements and incremental
aggregates. Charge account/order/receipt/outbox probes, partition counter contention, provider work and DBOS system
persistence separately. No constant-row/cross-machine claim follows from key predicates or timeouts. Existing locator
and combined-refresh growth evidence contains unresolved native/DBOS examined-row failures; queue/backlog/partition
fanout and full erasure bounds remain unproved. Do not raise allowances or subtract workflow work to disguise them.

## Delivery and acceptance

The four current product-fix directions are creation uncertainty, evidence completeness, immutable movement economics,
and bounded signature/secret input. Source in [creation attempt](creation-attempt.ts), [Stripe adapter](stripe.ts),
[settlement](settlement.ts), [payouts](payouts.ts), [webhook](webhook.ts) and [configuration](config.ts) contains work
in these areas; this adoption is not their owner delivery receipt or implementation/native/main proof. Keep their
focused outcome evidence with the owning deliveries. Offer concealment/revise HTTP and buyer-history navigation
are present in source; old research descriptions of their absence are superseded, not reasons to rewrite them.

Retain [frozen Commerce outcomes](../../../../specs/commerce-outcomes.test.ts) and
[native entry/driver](../../test/commerce/outcomes.test.ts). Signed loopback provider fixtures substitute only for
Stripe, while native acceptance uses real Auth/Access personas, kernel, PostgreSQL, DBOS and official SDK.
The narrow accepted test-contract exceptions are idempotency/mismatched-old-retry uncertainty and unavailable future
dispute status with last verified state preserved. No other frozen Root outcome changes are claimed or authorized.

Remaining owner deliveries must prove buyer/same-route other buyer, refunded buyer, seller/other seller,
creator/other creator, anonymous, suspended/terminal and authorized/unauthorized repair personas; exact-byte forgery,
replay/restart, enqueue failure, lost creation/cutoff, complete adverse association/cap cases, conflicting movements,
partial/full refund and dispute changes, terminal no-restoration, receipt reauthorization, native revision/queue
recovery races and three-scale physical cost. Subject discovery, benefit capture, owned navigation, actual protected
use and creator views also require API-to-storage-to-page evidence under the adopted shared target. Final native,
reviewed interface and promoted-main completion remain obligations; this docs-only adoption runs no check campaign.
