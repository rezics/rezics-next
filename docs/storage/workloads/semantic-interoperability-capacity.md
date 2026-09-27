# Source graph interoperability workload design

## Planning inputs

Source objects versus facts/statements/qualifiers, original bytes, lexical residuals, change streams and export generations.

The owner axes are declared as [checked load inputs](../../../scripts/load/budget.ts);
owner fixtures and measured capacity still need qualification.
Derive this owner's facts and retained history separately from the global
[capacity scenario](../workload-budgets.md#capacity-planning).

## Bounded implementation

Stream acquisition and bounded joins; separate source from product dataset load; detect retention gaps. Full source-corpus indexing is a separately admitted workload.

## Initial qualification and growth

Use [multi-scale work observations](../../testing/complexity.md) before
qualifying an owner threshold or rollout capacity. Current small fixtures do
not establish 500-million-entity capacity.
