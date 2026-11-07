# Financial commerce erasure participant

The default commerce work module registers `commerce_erasure` on the native account tombstone even when Stripe
is unconfigured. The effect durably enqueues `commerce.eraseAccount` with identity
`commerce:erasure:{accountId}:v1`. The existing executor and workflows queue own it. Dispatch is not acknowledgement.
The native version 1 obligation and current deleted account are required for every page.

A child phase reads and removes at most 100 raw keys (at most 1,600 UUID key bytes) from one account-leading index
per page, including entitlements and acquisition slots. Reylo locator and page statements yield one row or a list;
the participant normalizes both before paging or purging. Physical deletion, sticky evidence that data applied, and
the next cursor/phase commit in the same platform command. Progress contains only account/barrier identity,
cursor, phase, a fixed blocker and explicit retention metadata; it never copies a source payload. It survives
DBOS history expiry and is not a second coordinator. Replay cannot reopen a terminal phase or coordinator outcome.
The participant acknowledges an actual local outcome only after its owned pages commit. The unused-actor `none` path
still requires real shared-history and foreign-role coverage; local absence never attests whole-account no-data. The
native unused-account fixture therefore asserts `pending` with an explicit history gap until that coverage exists. A
data-bearing buyer can acknowledge a configured finite local Checkout exception while shared, foreign and provider
custody remains independently pending.

## Native ownership evidence and unknown custody

Indexed, account-home existence probes establish positive local evidence for offers, buyer orders, entitlements, acquisition slots,
creator royalty lines and statements. `had_data` records only this observed evidence, sticky across local purge;
`false` means no local root was observed, never that all roles or custody were empty. An account with no observed
local roots finishes the available page work with `COMMERCE_CUSTODY_BLOCKER`, explicitly recording UNKNOWN custody.
Data-bearing accounts stay pending unless every local obligation has an explicit disposition. A successful local
Commerce acknowledgement does not close other participants or unknown custody.

Seller/creator copies on buyer homes cannot be disproved by these local probes. Commerce does not add creator-leading
cross-home indexes or query all Core receipts, Access operator slots, workflow inputs or JSON payloads. Accounts owns
shared-history evidence for admission/apply receipts, outbox, write-basis, operational intents and DBOS copies,
including acting-human/operator attribution. The delivered History application owner-coverage port is consulted
after local cleanup commits and releases its connection. Its actual Commerce registry/progress gaps are persisted
for accounts without observed local data. This consumes the shared runtime without treating registration, an empty
prefix or a pending result as full coverage. Commerce command/outbox/durable producer conversion, write-basis and
operational-intent minimizers, historical foreign-role locators and aggregate routing proof remain incomplete.
The generic late-item/frontier primitives do not supply that inventory or a Commerce artifact minimizer.

Ordinary offer creation, revision and delisting and order creation now declare their exact receipt and event
associations through `declareCommandHistory` before mutation. Permanent Commerce kind IDs 1000–1003 are loaded by
both API callers and the default worker, including the unconfigured-Stripe path. Native captured creator and buyer
roles are unioned with the actual Access attempt's principal/actor/acting-human/delegate evidence; no account is
inferred from a subject or edition identifier. The shared sink owns local seal locks and atomic receipt/outbox
locators, including foreign creator associations on buyer homes. No family coverage or downstream disposition is
declared: these public graphs and their copied custody remain retained pending real consumer completion proof.

Checkout creation/refresh/apply and royalty/payment reconciliation remain unconverted. Their `order.updated`
envelopes still reach creator-sale native admit. Missing shared-history locator inventory stays a pending
projection gap: admit records the receipt and must not fail the effects checkpoint, or later tombstones on that
buyer home never run. The delivered shared sink rejects production after its local seal; applying it to those
financial commands would prevent required late money reconciliation. Their conversion needs the shared producer's
exact late-copy custody/settlement protocol and trusted service-identity evidence, rather than a reconstructed
Actor or a local replacement. Existing named DBOS identities also cannot use `stageHistoryWork`'s UUID-only request
port without the owning durable migration. This is an unavailable binding, not a claim that an unregistered
financial copy is absent or minimized.

Before enabling `none`, the actual producer must supply sealed complete role/custody coverage with exact physical
store/owner locators. Effect-written locators must close their account-home fence before paging; each locator
transaction locks that fence and records a late item after close, with no ordinary payload recreation. Resolution
follows committed minimization. Commerce's own final ACK must then use the delivered `acknowledgeErasure` API in a
separate account transaction after its own obligations, without waiting for overall/all-participant completion.
Overall completion also requires the real late-item/frontier and registered failed-work closure, not just relay
checkpoint delivery. No guessed adapter, default successful proof or test callback fills the missing producer.

## Immediate fence and actual minimization

Ordinary account creation commands hold their own native account against T through Access `shareAccount`.
Remote offer management and payout marking use actual Access prepare/admission/finalization, without foreign actor
account SQL in the target transaction. Seller terminal availability is prepared on the existing offer's home at
command T, and that source connection is released before the buyer transaction. The body checks that prepared
availability after receipt replay; existing captured terms and authorized receipts remain valid.

Begin-refresh retains its exact order lock through metadata-only stable-completion lookup and revision claim.
Apply authorization verifies immutable order/buyer/Session/intent binding through an anchored point read. Each fresh
claimed or legacy apply then takes actual buyer `shareAccount` before its first order lock and checks the exact
claimed revision before business no-op. Only `LifecycleDeniedError` suppresses entitlement grant/restore; database,
deadline and other availability failures propagate and roll back. Service authorization for money reconciliation
does not require an active buyer. Replays acknowledge the original financial effect without making a new claim.

Royalty recording fences its creator on that creator's home before royalty/statement/role effects, and only then
uses actual `grantAccountRole` when permitted. Lifecycle denial suppresses the private role while financial
reconciliation continues. Reconciliation checks the native buyer before another provider creation. No DBOS
cancellation acts as a commit fence. Old bearers and typed private readers still require the native current fence.

Entitlements and acquisition slots are private benefit records, so bounded erasure removes them without inventing
a refund/dispute reason. Slots have actual `(route, buyer_account_id, slot_id)` custody locators; their incumbent
order IDs and exact benefit keys are removed together. Terminal financial refreshes do not recreate slots.
Verified acquisition disposition belongs to the existing `(route, buyer_account_id, order_id)` financial root
and its retained-field obligation, rather than an additional unlocated copy.
No financial root is deleted by this participant. Without a supported explicit order-retention policy, the order
phase stays pending. Unobserved foreign/shared custody remains UNKNOWN; exhausting private children is not whole-graph
erasure.

## Explicit native test order-retention composition

`prepareCommerceOrderRetention(pool, { orderId, expiresAt })` is the trusted Commerce owner callable for the native
fixture. It locks the active buyer and exact genuine order, attaches the fixed `commerce.purchase_order_retained`
policy before T, and rejects inconsistent per-buyer expiry, purpose or fields. No HTTP caller supplies a policy and
there is no production default. The fixture purpose is `Finite native test retention of the exact original Checkout
capability.` and the exact fields are `buyer_account_id`, `checkout_url` and `expires_at`. This deterministic test
policy is not production legal approval.

For a configured order, the participant copies only these Checkout fields to the restricted owner table and clears
`purchase_order.checkout_url` and `checkout_expires_at` under the exact current T proof. Copy, source minimization,
policy removal and progress checkpoint commit in one buyer-home command. Durable progress stores only store, fields,
purpose and deadline. Entitlements, acquisition slots and copied `money_observation` evidence are removed in
account-leading pages of at most 100 keys. Exact private readers and new Checkout writes remain fenced at T.

The retained Checkout row is inspectable only by an exact internal owner locator; there is no buyer-facing read.
Deadline instants are projected as UTC ISO with microseconds (`YYYY-MM-DDTHH24:MI:SS.USZ`), the same form as
command T, so inspect, Access acknowledgement and `Date.parse` keep the configured millisecond. At
its configured deadline, the existing Commerce workflow waits on durable work, purges eligible retained rows in
bounded pages, and commits that purge before calling Access `resolveRetention` in a separate platform command. A
restart between minimization/checkpoint or purge/resolve replays the durable phase and exact owner locator. Late paid
and refund reconciliation may update settlement and immutable transaction truth, but cannot restore benefits,
Checkout URLs or deleted provider observations.

The accounting `purchase_order` remains as the financial root needed to preserve accepted terms, payment identity and
later reconciliation; its amount, currency/unit, signs and payment meaning are unchanged. Its retained financial
fields and payment-reference duration remain subject to the unresolved production jurisdiction, category, field
and expiry schedule below. The fixture's finite Checkout exception does not approve that broader retention or
discharge shared-history, foreign seller, provider or backup custody.

Commerce ACK is limited to its finite local Checkout exception; shared, foreign, provider, backup and production financial custody remain pending.

## Remaining producer blockers and retained records

The production payment/tax schedule is undecided: it must specify jurisdiction, record category, fields, purpose
and expiry for orders/captured terms, transactions/fee details, creator royalty lines, statements and external paid
references. None of these entire rows is approved for indefinite retention. Until the schedule and field minimizers
exist, they remain restricted behind account fences and the participant stays pending, without invented exceptions.
The committed Access API accepts `retained?: readonly RetentionException[]` only with outcome `erased`:
each exception has `store`, `fields: readonly string[]`, `purpose` and `expiresAt: Date`. It permits at most 16
unique stores, validates identifiers and requires expiry strictly after T. These validation limits are not legal
approval. The native fixture supplies only its fixed Checkout exception; unconfigured production financial policy
remains unresolved. After a real expiry purge commits, its owner must separately call
`resolveRetention({ pool }, { accountId, participant: 'commerce', store })`;
Access requires expiry to have arrived. Passing time or dispatching the purge does not resolve retention.
No fixture policy is lawful production approval and no live Stripe call/key is required for native acceptance.

Complete financial acknowledgement also requires these actual owned/shared APIs:

- Commerce: broader bounded field minimizers for offers and archived captured terms, payment references, immutable
  transaction payloads and royalty lines/statements/references, with exact role inverses and custody locators
  surviving any parent purge. The native Checkout URL exception does not supply a production financial schedule;
  current immutable accounting guards are not erasure APIs.
- Shared history: registered commerce artifact minimizers for exact receipt keys, outbox envelope/event keys,
  write-basis transaction keys, and all DBOS workflow/step/input/result/event/message records. Provider dispatch
  and terminal workflow retention are not minimization. Acting-human and operator history needs exact locators.
- Stripe/provider custody: exact Session, PaymentIntent, Charge, BalanceTransaction, Refund, Dispute and inline
  Product locators, plus any provider idempotency/response copy disposition and unresolved external-write proof.
  An order's session ID alone is not a complete provider inventory.
- Delivery/operations: backup expiry and any external logs/caches holding commerce payloads need named custody and
  minimizers/expiry proof. Unknown custody remains incomplete.

These remain the parent account-erasure launch gate. Unconfigured or unsupported data-bearing accounts retain a
durable `pending` phase with a concrete blocker. The supported fixture exception acknowledges only its exact local
retained Checkout record, not a whole-account disposition.

## Native fixture boundary

Genuine purchase targets are published Content editions on Content's isolated native system. Access grants
`board:create`/`offer:create` as account subjects on Global through the ordinary grant command after the governance
account holds `board:create` via the native local-showcase bootstrap. Buyer `order:create` uses the same grant command
after the governance account holds that action on the offer. Genuine-order editions live on a public Realm published
board, the same buyer sale-capture composition acquisition uses. Realm minting keeps Access page ports
through the derived extra-check adapter so Global `realm:create` and host `space:manage` share that
typed parent path. Global showcase board current-role projection remains
Accounts' Diagnostic7 repair. Protected source threads are not a public read floor;
the native fixture seeds `thread:read` for each buyer on those exact threads, matching acquisition's sale-authority
setup, because `grant.create` cannot admit that action. It also seeds `board:read` on that Realm board so buyer
sale capture does not depend on the unrepaired showcase projection. Grants, publication and Commerce HTTP share one composed
kernel. Content's native Access is already compiled from that complete catalogue, including Commerce, and
authenticates through Score `nativeAuth.handler`. The composed kernel reuses that same Access instance and the
ordinary Auth client (which omits `media:complete`). A second Access on the same pool is what produced
Diagnostic7: published board, current `content.board.owner`, board/subject read scopes and ownerActions, with
`boardAllowed=false` and `boardRead=null` because compiled role/resource/current-actor operands disagreed with
the board projection. Shared-database board-read current-role projection repair stays with Accounts.
`grant.create` re-authenticates the governance bearer on that Access so command admission binds the same actor
snapshot; Content's `native.auth.issue` actor object is not admitted there.
Order and Checkout sale capture use the same Auth consent reader as offer create.
Paid genuine-order settlement for this fixture is applied through that same parent Access and
Auth-database consent reader. The worker child compiles a second Access and cannot restore mechanical
sale authority while Accounts' board current-role projection remains unrepaired; its webhook then
replays the committed payment.
`prepareNativeRetainedOrder` is the Accounts terminal-graph export. Fresh `POST /v1/offers` sends only
`contentEditionId` and ordinary commercial terms; `targetSubjectId` is the historical-replay body and is rejected
on the same object. Native `POST /v1/orders` binds `expectedOfferRevision` from public `GET /v1/offers/:offerId`;
seller create and mutation DTOs stay revisionless. Acceptance is that one purchase/retention/expiry case on two
quantity-one editions, so refund and late paid keep distinct genuine orders, plus unused-actor operator history.
No extra stories: those two cases pin paid minimization, expiry purge, restricted readback and late paid/refund. A living buyer still acquires the
paid edition after the deleted buyer's entitlement is gone; seller termination then refuses a new order.

The Auth/persona/fresh-deletion fixture stays in the test parent. Only kernel worker setup runs in a child using
actual `startWorker`/`readWorkerConfig` against the same owned database and loopback Stripe endpoint. The child
keeps live default composition (Content ambient and the Semantic domain) through startWorker's module decorator,
not an eagerly composed `KERNEL_WORK_MODULES` list. That constant remains a registration-name pin only. The
decorator unsubscribes every tombstone consumer except `commerce_erasure`, including Semantic's overflowing
Subject-source page, so unfinished foreign participants cannot occupy the shared effects executor. Content
collection schedules are removed after launch, as in the financial outcome driver. Readiness is the ready line,
the existing 5ms queue poll, and an effects consumer that has ticked with no pending envelopes. Paid-order checks
wait for committed entitlement and settlement rows, not a moving partition head. After concurrent late-pay and
deletion release their Checkout and entitlement holds, the parent waits for that same catch-up before SIGKILL so an
in-flight buyer-home envelope cannot occupy expiry restart. The parent reaps the child with
SIGKILL because retention coordinators sleep. Seller Global grants are `board:create` and `offer:create` only:
Content's native identities already install `subject:create`, `space:create` and `realm:create`. Positive purchase
targets are real subjects created through the native API from released metadata on that public Realm board. One
native journey plus unused-actor operator history pins paid minimization, expiry purge, restricted readback and late
paid/refund; the independent terminal-benefit cases remain unchanged. Neither topology correction nor local pure
settlement tests prove the missing custody outcome. The composed kernel uses the 30-second native test request
deadline so Access parent-creation evidence stays live through sale-capture prepare; the production two-second default
is not this fixture's admission budget.

## Cost

### Attach native order-retention policy

- Touches: lock the active buyer and the exact order, insert one policy row with the fixed fields, purpose and expiry.
- Bound: constant statements and rows; logarithmic blocks as unrelated orders grow.
- Growth check: deferred with the parent financial erasure measurements; this fixture does not add a second growth suite.

### Minimize retained Checkout fields

- Touches: one buyer-home keyset of at most 100 orders, copy of the declared Checkout fields, source URL/expiry
  clearing, policy removal and progress checkpoint in one command.
- Bound: at most 100 raw keys and 1,600 UUID key bytes per page; constant statements per page.
- Growth check: deferred with the parent financial erasure measurements.

### Purge expired retained Checkout rows

- Touches: one buyer-home keyset of at most 100 retained rows whose deadline has arrived, physical delete, then Access
  `resolveRetention` in a separate platform command after that purge commits.
- Bound: at most 100 keys per page; resolution is one keyed update in the account partition.
- Growth check: Access `test/access/growth-erasure-coordinator.test.ts` covers resolution; Commerce page growth is
  deferred with the parent financial erasure measurements.
