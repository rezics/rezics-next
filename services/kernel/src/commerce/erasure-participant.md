# Financial commerce erasure participant

The default commerce work module registers `commerce_erasure` on the native account tombstone even when Stripe
is unconfigured. The effect durably enqueues `commerce.eraseAccount` with identity
`commerce:erasure:{accountId}:v1`. The existing executor and workflows queue own it. Dispatch is not acknowledgement.
The native version 1 obligation and current deleted account are required for every page.

A page reads at most 100 entitlement UUIDs and 100 acquisition-slot UUIDs from their account-leading indexes,
then removes at most 100 merged child UUIDs (1,600 raw key bytes) using a shared keyset cursor.
Physical child deletion, sticky evidence that data applied, and the next cursor/phase commit in the same
platform command. Progress contains only account/barrier identity, cursor, phase and a fixed blocker. It survives
DBOS history expiry and is not a second coordinator. Replay cannot reopen a terminal phase or coordinator outcome.
There is currently no acknowledgement path: local absence cannot attest native no-data. The required unused-actor
`none` acceptance remains unsatisfied until the real shared-history and foreign-role proof producers are delivered.
This is an incomplete participant, not a successful replacement of that outcome with permanent pending.

## Native ownership evidence and unknown custody

Indexed, account-home existence probes establish positive local evidence for offers, buyer orders, entitlements, acquisition slots,
creator royalty lines and statements. `had_data` records only this observed evidence, sticky across local purge;
`false` means no local root was observed, never that all roles or custody were empty. An account with no observed
local roots finishes the available page work with `COMMERCE_CUSTODY_BLOCKER`, explicitly recording UNKNOWN custody.
Known local use records `FINANCIAL_ERASURE_BLOCKER`. Neither result acknowledges `none` or `erased`.

Seller/creator copies on buyer homes cannot be disproved by these local probes. Commerce does not add creator-leading
cross-home indexes or query all Core receipts, Access operator slots, workflow inputs or JSON payloads. Accounts owns
shared-history evidence for admission/apply receipts, outbox, write-basis, operational intents and DBOS copies,
including acting-human/operator attribution. The delivered `history/receiving.ts` owner-coverage port is consulted
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

Checkout creation/refresh/apply and royalty/payment reconciliation remain unconverted. The delivered shared sink
rejects production after its local seal; applying it to those financial commands would prevent required late money
reconciliation. Their conversion needs the shared producer's exact late-copy custody/settlement protocol and
trusted service-identity evidence, rather than a reconstructed Actor or a local replacement. Existing named DBOS
identities also cannot use `stageHistoryWork`'s UUID-only request port without the owning durable migration. This is
an unavailable binding, not a claim that an unregistered financial copy is absent or minimized.

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
No financial root is removed by this participant. Observed local data remains pending after this partial cleanup;
unobserved foreign/shared custody remains UNKNOWN. Exhausting private children is not whole-graph erasure.

## Remaining producer blockers and retained records

The production payment/tax schedule is undecided: it must specify jurisdiction, record category, fields, purpose
and expiry for orders/captured terms, transactions/fee details, creator royalty lines, statements and external paid
references. None of these entire rows is approved for indefinite retention. Until the schedule and field minimizers
exist, they remain restricted behind account fences and the participant stays pending, without invented exceptions.
The committed Access API accepts `retained?: readonly RetentionException[]` only with outcome `erased`:
each exception has `store`, `fields: readonly string[]`, `purpose` and `expiresAt: Date`. It permits at most 16
unique stores, validates identifiers and requires expiry strictly after T. These validation limits are not legal
approval. This participant supplies no exceptions while the schedule is undecided. After a real expiry purge
commits, its owner must separately call `resolveRetention({ pool }, { accountId, participant: 'commerce', store })`;
Access requires expiry to have arrived. Passing time or dispatching the purge does not resolve retention.
No fixture policy is lawful production approval and no live Stripe call/key is required for native acceptance.

Complete financial acknowledgement also requires these actual owned/shared APIs:

- Commerce: bounded field minimizers for offers and archived captured terms, checkout URL/session/intents,
  orders, immutable transaction payloads and royalty lines/statements/references, with exact role inverses and
  custody locators surviving any parent purge. Current immutable accounting guards are not erasure APIs.
- Shared history: registered commerce artifact minimizers for exact receipt keys, outbox envelope/event keys,
  write-basis transaction keys, and all DBOS workflow/step/input/result/event/message records. Provider dispatch
  and terminal workflow retention are not minimization. Acting-human and operator history needs exact locators.
- Stripe/provider custody: exact Session, PaymentIntent, Charge, BalanceTransaction, Refund, Dispute and inline
  Product locators, plus any provider idempotency/response copy disposition and unresolved external-write proof.
  An order's session ID alone is not a complete provider inventory.
- Delivery/operations: backup expiry and any external logs/caches holding commerce payloads need named custody and
  minimizers/expiry proof. Unknown custody remains incomplete.

These are the parent account-erasure launch gate. The participant deliberately acknowledges neither `erased` nor
retention completion for data-present accounts. Its durable `pending` phase records the concrete blocker without
claiming missing proof is complete.

## Native fixture boundary

The Auth/persona/fresh-deletion fixture stays in the test parent. Only kernel worker setup runs in a child using
actual `startWorker`/`readWorkerConfig` and the default module list against the same owned database and loopback
Stripe endpoint. The child owns and closes its pool/client on SIGTERM. Positive purchase targets are real subjects
created through the native API from released metadata. Business assertions, including unused-actor `none`, replay,
private concealment and late paid/refund money outcomes, remain required. The independent terminal-benefit cases
remain unchanged. Neither topology correction nor local pure settlement tests prove the missing custody outcome.
