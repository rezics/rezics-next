# Economy system design proposal

Wallets and balances are required for the later Economy track. The implementation target includes wallet spending,
issuance, transfers, settlement, a fixed-price item market and an exchange for eligible fungible assets. Develop and
verify each flow end to end under internal admission. Activate real-money, custody and market capabilities separately
according to the approved instrument, operating policy and provider evidence. First-public Commerce is defined by its
[existing Goal](../goals/commerce.md#scope). This proposal uses the [Commerce module map](../commerce-modules.md)
as the owner contract and recommends decisions for the later track.

## Recommended architecture

Build the Economy module in the existing Kernel with a REZICS-owned PostgreSQL ledger as its first adapter. Keep its
contract, business rules, application operations and storage adapter behind declared module entries under
`services/kernel/{src,db,test}/economy`. Bind them in Kernel composition and reuse the native command, history, outbox
and durable-work infrastructure. Give each initial program one compatible book containing the accounts and assets
needed for its atomic transfers. Compatible programs can share a book within the same accountable entity and
environment. Include a book key in every ledger operation. Route by book so an atomic group has one native transaction
boundary.

| Authority | Owns and exposes |
| --- | --- |
| Ledger book | Accounts by asset, immutable transaction groups and postings, authoritative account positions, reservations and their allocations. Accepts named internal posting operations and provides bounded statement and reconciliation reads. |
| Wallet and asset policy | Account-to-wallet mapping, denominations, issuer, permitted funding/spend/transfer/redemption, restrictions, limits and expiry. Exposes wallet summary, statement, funding, spending, transfer and withdrawal journeys. Uses ledger-confirmed availability at the write boundary. |
| Commerce and payment integration | Offer, order, payment evidence, entitlement and attributed creator earnings. Supplies authenticated and versioned economic evidence. The ledger owns recognized payable, clearing and settlement balances. |
| Item custody | Stable item home, holder, transfer eligibility and ownership generation. Supplies current generation and eligibility to the existing Access decision. |
| Market and exchange | Listing and trade intent, quotes and fee rules, instrument order sequence and fills. Issues named reserve and settle instructions and exposes lifecycle and market data. |
| Reconciliation and operations | Provider and bank evidence, book-to-external comparisons, disputed and ambiguous operations, close, approved adjustments and recovery. Access supplies actor, platform and operator authorization. |

Wallet, payment, market and exchange applications initiate named business actions. The Ledger translates the admitted
action into a versioned posting rule. A wallet caller never needs debit/credit accounts or a generic posting API. Keep
one authoritative writer per book, with one native command returning a recorded result or a typed conflict, rejection
or unavailable outcome. Commerce and Economy exchange owner events and versioned evidence; Commerce order and
entitlement fulfillment remain separate from money custody.

## Ledger and wallet contract

- Identify an asset by its issuer, program and denomination, with an immutable integer scale. Keep issuance, transfer,
  redemption, conversion and expiry as versioned policy. Represent amounts exactly with bounded integers in storage
  and lossless decimal strings across JSON. Check the bounds on both individual legs and accumulated positions. Keep
  balances with distinct custody, redemption or expiry terms in separate assets or restriction buckets. Preserve tender
  and restrictions through gifts, refunds, trades and seller proceeds. Conversion needs its own approved policy and
  recorded rate, rounding and fee terms.
- Key a transaction by book and stable economic operation, with a versioned digest of its normalized operands and
  evidence. Capture account and asset IDs, posting sides, source references, policy version, source occurrence time,
  recorded time and an optional correction link. Every asset balances independently. Post corrections and reversals
  as new entries with explicit links and limits. Represent incomplete evidence as an unresolved obligation.
- Use an owner-scoped economic identity distinct from the HTTP receipt, provider event ID and DBOS workflow ID. An
  authorized identical retry returns the original result. Reusing a key for different operands returns a conflict.
  Keep the economic identity under the ledger retention policy even if a transport receipt expires. An uncertain
  transport outcome resolves by querying or retrying with the same identity.
- Commit postings, account positions, the reservation transition, the economic key and any outbox event together.
  Prepare position and control rows or handle concurrent creation, lock the finite affected keys in canonical order,
  check policy and resulting positions, and commit with protected write privileges. Validate the complete posting
  vector at this boundary and independently replay it for reconciliation. A row `CHECK` can enforce local predicates;
  group balance needs the whole vector. Keep provider I/O outside native transactions. [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html) · [Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- Use exact book/account/asset keys for spend decisions, bounded account-leading statement windows, and a stable
  account-position revision for pagination. Bind activity cursors to account, asset selection and access scope.
  Index outstanding holds and reconcilable obligations by owner, state, deadline and stable key. Fix command caps
  for legs, allocations and policy counters before implementation from admitted flow shapes. With fixed caps and
  page size, each action seeks named rows or advances an indexed window even as unrelated accounts and history grow.
  Measure contention on shared issuer, fee and clearing accounts separately from unrelated-data growth.

The wallet shows **posted**, **held**, **restricted**, **available** and, where relevant, **incoming pending** amounts
by asset. For an ordinary nonnegative wallet, posted equals available before additional spend restrictions, plus held
and restricted. A freeze or limit can reduce current spendability further. Incoming funds join posted after an admitted
evidence transition. Keep aggregate position and its statement entries tied to the same commit; notification and search
projections can lag. The first normal wallet has no overdraft. If externally imposed losses exceed an account's
available balance, process the evidence against the adopted reserve, receivable or loss policy and restrict new outbound
actions as needed.

Reservations support reserve, partial capture, final capture, release and expiry. Maintain the invariant that the
original amount equals unallocated value, protected fill allocations, captured value and released value combined.
Every capture and release is an idempotent operation. For a wallet with 100 and a 70-unit hold, a 30-unit partial
capture leaves 70 posted, 40 held and 30 available. A deliberate final capture or order cancellation releases its
eligible remainder. A committed fill keeps its protected allocation across order cancellation and expiry. TigerBeetle
resolves a pending transfer once and releases its unused remainder on partial post. An adapter needs independent
fill reservations or an equivalent atomic model to preserve the wallet contract. [TigerBeetle partial posts](https://docs.tigerbeetle.com/coding/two-phase-transfers/) · [Formance Wallets hold behavior](https://docs.formance.com/modules/wallets/managing-holds)

## Complete delivery sequence

Each increment delivers domain rules, its normal Kernel API or owner entry, native acceptance, and usable wallet,
creator or operator surfaces where a person needs them. Use internal grants and deterministic provider adapters to
exercise external flows while the operating policies are being adopted. Record acceptance in the owning contract
before assigning implementation.

| Increment | Deliverable and decisive outcome |
| --- | --- |
| **1. Ledger and wallet** | Open a wallet, issue a test asset, view per-asset balances and statement, fund or spend through named commands, transfer between two authorized wallets in the same book, reserve and partially capture, release and expire. Two concurrent spends cannot consume the same balance. A lost response and exact retries yield one economic move and a stable receipt. |
| **2. Issuance and Commerce bridge** | Implement points and promotional credits, program limits, mint/burn, eligible transfer, redemption and any selected expiry/top-up policy. Preserve issuer liability and supply reconciliation. Ingest known Commerce charge, refund and dispute economics; map clearing, fees, tax, revenue and creator payables through approved templates. Preserve separate purchase, entitlement and payment facts. |
| **3. Funding, withdrawal and settlement** | Deliver top-up, pending funds, creator statements and payouts, permitted withdrawal, payout failure/return and exception review. Reserve value before dispatch. Keep the original external attempt on ambiguous responses and reconcile with fresh evidence. Compare provider balance movements, bank deposits, wallet liability and creator payable detail independently. A provider payout may cover multiple movements. [Stripe balance movements](https://docs.stripe.com/reports/balance-transaction-types) · [Payout reconciliation](https://docs.stripe.com/payouts/reconciliation) |
| **4. Transferable items and fixed-price market** | Register eligible owned items, transfer or gift by generation, list, cancel, buy, and view completed purchases and price history. Freeze the quoted asset, amount and fees. A crash at any owner boundary recovers the same trade decision and changes holder and seller balance at most once. Existing Access uses current item generation where items confer a benefit. |
| **5. Fungible exchange** | Start with an admitted spot pair and limit orders with price-time priority, cancel, partial fills, self-trade policy, integer tick/lot/fee rules and bounded matching. Reserve both deliverables or their authorized order capacity before matching. Slice protected allocations by fill identity. Settle same-book fill legs atomically, balance each asset independently, and publish executed and settled states. Add cross-book clearing by explicit policy when a product requires it. |
| **6. Controlled launch and extraction readiness** | Exercise close, statements and trial balances, reconciliation, access revocation, account closure, claims outstanding across restore, operator approvals, cutover and enablement by instrument. Load-test full journeys and hot accounting keys. Change deployment or engine only after the replacement passes the same conformance, recovery and operational exercises. |

For independent item and book homes, the trade owner records one durable commit or abort decision after obtaining
protected reservations. Both owners bind their prepared reservations to the trade identity and generation and enforce
the decision on replay. Expiry can initiate abort before commitment. A prepared allocation can release only after
the release decision is fenced; a committed allocation remains protected through recovery. After commitment, move
funds into clearing/escrow, complete ownership delivery, and release proceeds and fees when the item owner acknowledges
delivery. An incomplete committed trade remains a visible obligation for reconciliation. When both deliverables genuinely
live in one book, paired postings can settle atomically in that transaction. Cross-book settlement instead needs
locally balanced due-to/from legs, common settlement identity, counterparty limits or prefunding, and reconciliation
through final acknowledgment. [Commerce custody proposal](../commerce-modules.md#one-home-effects-and-financial-custody)
· [Mojaloop transfer protocol](https://docs.mojaloop.io/technical/reference-architecture/boundedContexts/transfers/#concluding-comments)

For exchange orders, reserve the maximum deliverable amount including fees. At each fill, allocate the exact amount
and release eligible price improvement. Each fill records the instrument sequence, both order identities, quoted
terms and protected allocations. Bound price levels and fills per step. Persist the continuation at that sequence so
recovery and subsequent orders respect price-time priority. Publish volume and price history from completed settlements.

Before allowing real funds and transferable assets, adopt issuer/custody, product eligibility, recognized event and
accounting policy, dispute and negative exposure handling, provider capabilities and each applicable jurisdiction's
activation conditions. Use least-privilege move/issue/refund/repair grants, current authorization before private receipt
reads, and separate approval for adjustments that move value. Keep provider identifiers and personal identity mappings in
restricted owner storage. At closure, block new user-authorized movements, keep outstanding financial duties in their
owner workflows, and apply the financial field and expiry schedule and account erasure fences.

## Reconciliation, cutover and engine choice

Select evidenced reconstruction or reconciled opening positions per disjoint scope, such as accountable entity,
provider account and mode, and asset. Record the source high-water marks, the source of each opening position, and
unresolved items. Replay the overlapping tail in shadow, reject changed economics by key, and compare control totals,
per-account balances, holds, provider cash and bank or payout evidence. Release a scope after reconciling to zero
unexplained difference, with remaining identified exceptions assigned to suspense and excluded from spendable value.
At cutover freeze admission, drain or carry forward accepted work, and use a writer epoch to fence stale executors.
Restore from a verified boundary and replay the gap through the same operation identities. After the first accepted
live movements, recovery must carry the new journal and outstanding obligations forward. Keep recorded accounting
periods stable while preserving the source occurrence date of late events.

Use the same acceptance corpus for any adapter. Include posting conservation and reconstruction, conflicting replay,
parallel first use and overspend, capture racing expiry, cancellation racing settlement, duplicate and out-of-order
provider evidence, chargeback after spending, payout response loss and late return, and process loss after every
cross-owner acknowledgment. Exercise currentness and disclosure with several accounts and operators. Restore with
active holds, prepared trades and ambiguous external payments, then replay and match independent control totals. Measure
bounded reads and writes as unrelated history grows, and load-test actual hot books, clearing accounts and instruments
with lock waits, transaction latency, WAL, outbox delay and recovery time. Use end-to-end load and recovery results for
selection.

Ship one PostgreSQL adapter. Compare TigerBeetle if measured
hot-book contention or the required recovery/isolation envelope warrants a separate ledger engine. Compare Formance
if versioned, programmable accounting flows offer a concrete advantage. Require proven hold and fill semantics,
stable business idempotency after unknown commit, complete ordered export and replay, wallet statement consistency,
and recovery of in-flight obligations across the provider, book and item homes. Require a tested service authorization
boundary and operational restore in the chosen topology. Extract service deployment separately through the existing
versioned owner contract when operational isolation warrants it. This recommendation is based on source inspection;
latency, throughput and compatibility with the REZICS runtime require measurement at representative admitted load.

### Local contention sample

On candidate `3525bbc0a53`, eight local clients each completed 16 commands against disposable PostgreSQL 19rc1.
Wallet transfers from separate debit positions completed at 916 operations per second. One shared debit position
completed at 602 operations per second, with all 128 transferred units accounted for. For spot, each command placed
an ask and ran native matching to rest it on an empty opposing side. Eight independent instruments completed 496
orders per second. One shared instrument completed 105 orders per second, returning 743 busy responses before the
128 orders rested. Its p95 completion time including retries was 166 ms, compared with 21 ms across independent
instruments. This measures native commands with immediate matching. At that revision, ordinary submission waited for
a scheduled sweep before the first match. The later signed HTTP and DBOS exercise advanced the committed order in
2.1 seconds with the periodic sweep paused. The schedule still recovers accepted work after enqueue failure.

## Pinned source references

Read-only clones are indexed under `.reference/economy/`. The revisions are for design and test reference. Refer to
upstream contribution and licence terms before using any code.

| Upstream | What to study at the pinned revision |
| --- | --- |
| TigerBeetle 0.17.9 | Atomic linked events, immutable transfer IDs, pending resolution, balance invariants and safety under recovery. Production topology and the application metadata split matter to deployment. [State machine](https://github.com/tigerbeetle/tigerbeetle/blob/cc1c06a924e49b11089c521b2209d34c92caaf18/src/state_machine.zig) · [Cluster operations](https://github.com/tigerbeetle/tigerbeetle/blob/cc1c06a924e49b11089c521b2209d34c92caaf18/docs/operating/cluster.md) |
| Formance Ledger v2.4.18 | Account/asset locking, initialization and committed balances on PostgreSQL. The consistency notes identify the write cost of synchronous hash chaining and historical effective-volume maintenance. [Balance implementation](https://github.com/formancehq/ledger/blob/83cd8dc7a66ba02a0418a36ec45663b19e26dcb3/internal/storage/ledger/balances.go) · [Consistency notes](https://github.com/formancehq/ledger/blob/83cd8dc7a66ba02a0418a36ec45663b19e26dcb3/CONTRIBUTING.md#data-consistency) |
| Formance Ledger v3.0.0-rc.4 | Raft/Pebble implementation and versioned deployment/recovery concerns. Treat engine generations separately in a bake-off. [Architecture](https://github.com/formancehq/ledger/blob/fda3a57231ae68bd99ba2cf51d691c9e90105075/README.md) · [Release notes](https://github.com/formancehq/ledger/releases/tag/v3.0.0-rc.4) |
| Apache Fineract 1.16.1 | Savings hold and release with current account checks, and a distinct cash-based journal mapping. Study wallet controls and GL integration as separate concerns. [Savings commands](https://github.com/apache/fineract/blob/c643dab306fe29798951591ce825fd5e5272923e/fineract-provider/src/main/java/org/apache/fineract/portfolio/savings/service/SavingsAccountWritePlatformServiceJpaRepositoryImpl.java#L1880-L1969) · [Journal mapping](https://github.com/apache/fineract/blob/c643dab306fe29798951591ce825fd5e5272923e/fineract-provider/src/main/java/org/apache/fineract/accounting/journalentry/service/CashBasedAccountingProcessorForSavings.java) |
| Exchange Core 0.5.3 | Order-book fills and cancel/reduce, reserved value incorporating fee limits, and replay. The old tag serves as an algorithm reference. [Order book](https://github.com/exchange-core/exchange-core/blob/21b25d02e37edecdaa845e7231970a32f84d28b8/src/main/java/exchange/core2/core/orderbook/OrderBookDirectImpl.java) · [Risk engine](https://github.com/exchange-core/exchange-core/blob/21b25d02e37edecdaa845e7231970a32f84d28b8/src/main/java/exchange/core2/core/processors/RiskEngine.java) |
| Stellar Core | A co-located settlement comparison. The offer operation checks asset authority, crossing and offer liabilities inside one ledger transaction. [Offer implementation](https://github.com/stellar/stellar-core/blob/35bd0f9f66d3a1e5fe04ef34b32fc6ba81340692/src/transactions/ManageOfferOpFrameBase.cpp#L225-L559) |
