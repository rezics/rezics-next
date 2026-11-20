# Economy

## Outcome

A person individually admitted to Economy can see and use a wallet, move eligible units, follow the lifecycle of money
and item trades, and resolve failures without double effects. Authorized operators can reconcile and repair obligations.

## Done when

- Wallets show exact per-asset posted, available, held, restricted and pending values with an auditable statement.
  Issuance, spend, transfer, partial capture, final capture, expiry and release uphold conservation under concurrency,
  lost responses, retries and restart. Unavailable or unauthorized calls disclose no wallet facts.
- Points and credits have versioned eligibility, source, transfer, expiry and redemption. Funding, refunds, disputes,
  creator accrual and payability, withdrawal and settlement use separate identities and reconciled evidence. Ambiguous
  external operations recover under their existing identities. A duplicate provider event cannot repeat an effect.
- Eligible items can be held, listed, bought, canceled, delivered or repaired through a durable trade decision.
  Spot instruments match admitted orders with bounded continuations, exact fees, protected partial fills and idempotent
  settlement. Own statements and price history distinguish recognized, pending and completed outcomes.
- Every Economy request and capability disclosure is gated by current explicit per-account platform admission in the
  production composition. Native cases prove closed default, ordinary-login denial, authorization for the granted
  principal only, denial after revocation, and denial of another account's receipts. Production stays inactive by default.
- Source, native API, any served wallet/market/operator journeys, growth, reconciliation and restore evidence are tied to
  the integrated candidate. Test funding and withdrawals use deterministic provider evidence. Live instrument activation
  requires its financial and operating approvals.

## Scope

The [Economy owner contract](../economy.md) defines the later private track. Deliver ledger, wallet and admission first,
then issuance and Commerce evidence, external settlement, item market, spot exchange and operating readiness. Implement
behind grants and test rails throughout. [First-public scope](../scope.md) owns release exposure.

## Ownership and dependencies

Economy owns `services/kernel/{src,db,test}/economy/**` and later wallet and market journeys. Platform/Accounts owns
admission and current-account authority. Commerce owns its source evidence and existing entitlements. Content and Access
own resource use. Kernel owns composition and durable work. The credited, reserved and settled balances always have one
ledger owner.

## Acceptance

Run outcome cases at the owner ports and through the real, granted Kernel routes. Exercise double spend, exact replay,
concurrent transfer, holds racing expiry, conflicting provider data, outage after external acceptance and interruption
at each cross-owner settlement step. Prove page and statement bounds as unrelated data grows, and measure hot book and
instrument contention. Reconcile independent totals and restore in-flight obligations before any activation. Follow
[phase ownership](../development/delivery.md#implementation-and-acceptance) for integration and native validation.
