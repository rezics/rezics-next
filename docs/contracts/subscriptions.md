# Subscriptions, plans and independent benefits

## Product model

An offering identifies seller, eligible beneficiary/target, plan groups, prices,
benefit definitions and lifecycle. Replaceable plans and parallel plans have
explicit semantics. A purchased entitlement and a complimentary/gifted award are
independent grants; receiving a higher gift must not prevent buying a lower plan
or silently change payment/cancellation state.

## Commercial commands

Quote, purchase, change, cancel, settle, refund and reconcile use exact offering/
price revisions, operation IDs, provider references and current eligibility.
Provider callbacks are verified and idempotent. Unknown settlement remains pending
reconciliation; duplicate delivery cannot charge or fulfill twice. Record commercial
state separately from the effective benefit projection.

## Benefit resolution

Resolve eligible grants by target, beneficiary, group, period, source and policy.
Expiry/revocation applies to that grant, not every overlapping benefit. Access
receives an explicit effective entitlement bridge with freshness/fence semantics;
a payment record alone is not domain authorization. Account enforcement and
resource policy remain conjunctive.

## Rollout and qualification

Rezics Pro is an ordinary operated Realm using [participation policies](realm-participation.md)
and [scoped delivery](realm-delivery.md). Generic Person/Realm targets remain
representable; arbitrary third-party seller onboarding/payouts and persistent
hosting need separately selected operating arrangements. Elect payment provider,
currency/tax/collection/refund policies before enabling real transactions.

Use PostgreSQL for commercial accounting/settlement control and graph projections
for eligible product metadata. Preserve audited intent/receipt history and recovery.
Test overlapping purchase/gift, plan switches, expiry, refund, duplicate callbacks,
quota settlement and unavailable providers. Do not promise legal or financial
outcomes merely from a stored provider status.
