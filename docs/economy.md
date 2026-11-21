# Economy

Economy is a later, private Kernel capability with a PostgreSQL ledger. Marketplace, asset issuance, wallets and
creator settlement use one ledger contract. Commerce owns offers, orders, provider purchase evidence and purchase
entitlements. The [Commerce module map](commerce-modules.md) defines the owner seams for checkout, item custody and
external evidence. The [Economy Goal](goals/economy.md) owns delivery and acceptance.

## Private admission

Every Economy route and surfaced view requires an authenticated actor and an explicit account-specific Economy platform
grant. Normal client scopes, account ownership, current account status and operator authority apply in addition to the
platform grant. Platform-wide visibility, anonymous access and a valid session alone grant no admission. Gate discovery,
API responses, private receipts and mutations use the same decision. Recheck authorization before replay. Internal
owner workflows authenticate their source and complete only named, previously admitted obligations. Use test assets and
deterministic provider adapters for development. The deployed system starts closed and real-money execution requires a
separately authorized instrument, provider and operating policy.

Grant `gate:economy` directly to the active account on the Global Context through the existing access controls. Register
only the required client actions with Auth. Wallet access uses `wallet:read` and `wallet:transfer`. Spot uses
`spot:read`, `spot:place` and `spot:cancel`. The fixed-price market uses `market:read`, `market:list`, `market:buy`
and `market:cancel`.

`KERNEL_ECONOMY_BOOK_ID` selects the installed book and `KERNEL_ECONOMY_NODE` selects the local native owner. Both
settings are required to bind the wallet and spot adapters. Fixed-price market requests also require
`KERNEL_ECONOMY_MARKET_ITEM_HOME_ID`, `KERNEL_ECONOMY_MARKET_FEE_ACCOUNT_ID`, `KERNEL_ECONOMY_MARKET_FEE_BPS`
and `KERNEL_ECONOMY_MARKET_POLICY_VERSION`. Native requests lock the current account and direct grant in the same
transaction as protected reads and writes. Both sides of a wallet transfer and of a new market purchase require the
current grant. Provision assets and balances through trusted owner operations in the configured test environment.

## Book and wallet

The configured book is the native home of an atomic transaction, its asset accounts, positions and holds. A wallet
belongs to an account and maps to one position per admitted asset. Use exact integer minor units carried as decimal
strings. Denomination and scale are fixed on issuance. Wallet positions have nonnegative posted and held balances,
and a debit checks current availability in the same commit. Issuance uses a named source account. A transfer posts
both legs in the same book and asset. Immutable journal entries, balance changes, hold state and the durable economic
identity commit together. Corrections append linked entries.

Economic identities scope replay by business operation and authorized initiating principal. The same key and operands
return the same outcome. A semantic change with the same key conflicts. The ledger verifies balanced groups and
amount bounds before committing. Lock affected keys in a consistent order. Provider I/O and foreign owner work run
after the local transaction. Statements paginate by stable account position and translate internal references into an
authorized view. Visibility may lag in derived views, while spend checks read current ledger positions.

A hold moves value from available to held. Partial capture transfers the captured amount and keeps the remainder
occupied. Final capture releases unused value. Release or expiry frees eligible outstanding value. A durable fill
allocation remains protected until settlement or a fenced abort. Capture, release, expiry and funds checks serialize
at the protected position. Policy-restricted units preserve their restrictions through refunds and transfers.

## Points and promotional credit

One immutable programme version owns one asset, an issuance source, enrolled award recipients and an outstanding
supply cap. New versions use new asset identities. Mint and redemption source references name one journaled effect
across versions of the same programme. Redeeming returns the consumed units to the issuer. Transferable point
programmes use the wallet transfer rules. Expiring promotional credit is non-transferable and uses redemption
where the programme permits it. Native time makes expired units unavailable, and a named expiry posting returns
the remaining units to the issuer. Provider funding uses independently issued assets.

## External funds and trading

Ingest authenticated, distinct external movements by provider namespace, mode and movement ID. Pending or ambiguous
movements remain reconciliation obligations. The wallet reports queued and uncertain deposit units separately as
pending credit. Confirmation or refusal removes those units in the same transaction as the outcome. Spendability
follows confirmed wallet postings. Funding posts against distinct provider-clearing and chargeback-receivable accounts.
Withdrawal confirmations use the protected allocation after ordinary hold expiry, and a chargeback recovers only the
locked spendable value before posting any shortfall separately. Deposit, refund, dispute, reserves, available creator payable and actual
payout are separate facts. Withdrawal reserves value before rail submission; retry reuses its original dispatch
identity. Late returns and shortfalls receive explicit accounting adjustments. Use reconciled source watermarks and
one fenced writer when switching an authoritative book.
Creator accruals recognize an independent payable and expense. A payout reserves that payable, records the exact
confirmed movement against the named reservation, and releases a refused reservation. Returns are separate journaled
events capped by their original payout. Wallet funding and creator payout use one provider movement identity guard.

Unique items transfer by generation at their item home. A trade protects both its item and its funding reservation
before recording a durable commit or abort. After commit, reconcile ownership delivery and then release clearing
funds to seller and fee accounts. Same-book fungible delivery can settle as a balanced multi-asset journal group.
Matching follows price-time priority with stable fill identities and protected allocations for partial fills. A bounded
step can resume before crossing subsequent instructions. A canceled order frees only its unallocated remainder.
Public price and volume derive from completed settlements and remain behind Economy admission.

## Book reconciliation and restore

A native audit reconstructs journal totals, positions, holds, reserved creator payables and pending deposits on one
read-only repeatable-read snapshot. Treat absent books, page-limited scans and mismatches as separate outcomes. An
incomplete audit returns diagnostic findings and a snapshot identity. External clearing reconciliation still uses
independently verified provider statements and watermarks.

Run `bun services/kernel/scripts/economy-book-restore.ts` to exercise a PostgreSQL custom dump and restore in disposable
databases. The exercise restores an uncertain synthetic withdrawal and an escrowed fixed-price trade. It fences the
source before resuming the previously accepted operations, then verifies the original withdrawal identity, item
delivery, seller proceeds and fee posting.

The [engine and implementation research](research/economy-system-design-codex.md) records the alternatives and pinned
reference source. Engine replacement or deployment separation must preserve the ledger and operating contract.
