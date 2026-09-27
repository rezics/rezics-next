# Subscriptions and participation workload design

## Planning inputs

Plans, grant overlap, reservations, settlement callbacks, review jobs and scoped publication candidates.

The owner axes are declared as [checked load inputs](../../../scripts/load/budget.ts);
owner fixtures and measured capacity still need qualification.
Derive this owner's facts and retained history separately from the global
[capacity scenario](../workload-budgets.md#capacity-planning).

## Bounded implementation

Index by beneficiary/target/period, make reservations atomic locally, reconcile providers idempotently and stage review/derived generations. Never recompute all beneficiaries synchronously.

## Initial qualification and growth

Use [multi-scale work observations](../../testing/complexity.md) before
qualifying an owner threshold or rollout capacity. Current small fixtures do
not establish 500-million-entity capacity.
