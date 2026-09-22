# Quota admission, metering and budgets

## Separate responsibilities

API rate limits protect fairness and resources. Domain quotas admit a business
operation. Metering records usage. Commercial charging settles a declared purchase
or entitlement. These have separate units, identities and failure semantics.

## Reservation protocol

An admitted operation atomically reserves its bounded maximum or validated estimate
within the quota owner. Record operation ID, beneficiary/scope, unit, policy revision,
validity and settlement state. Completion settles actual usage; cancellation or
failure releases/compensates under explicit policy. Retry reuses the reservation,
and concurrent final-capacity requests cannot both overspend it.

Long jobs renew leases or reserve bounded stages; expiry does not silently erase
already consumed usage. Duplicate provider callbacks or worker ACKs cannot charge
twice. Unknown external outcomes remain reconciliation work rather than assumed
failure or success. Gifted benefits and purchased plans retain independent ledgers.

## Request budgets

Bound query candidates, graph expansion, memory, result bytes, batch fan-out,
source fetches, solver work and queue retention. A client Filter/preset cannot
raise the server ceiling. Shared composed requests share one budget rather than
reset it per nested Block or service hop. Return retry/backoff, partial or budget-
exhausted outcomes with safe diagnostic context.
