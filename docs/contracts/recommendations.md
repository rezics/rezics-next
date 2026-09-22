# Recommendation and ranking generations

## Inputs and meaning

Declare admitted content/activity signals, counting population, time decay,
context and score policy. Imported source aggregates retain origin and do not
create native votes. Private exclusions/preferences narrow delivery independently
of public ranking. Popularity is not classification truth or authorization.

## Computation and reads

Build partitionable sparse scores from bounded signal batches. Coalesce updates,
checkpoint progress and avoid one synchronous exact global counter. A generation
pins input/policy revisions and can be activated only after complete validation
and catch-up. Failed/stale workers cannot replace a valid active generation.

Query positive scores and eligible zero-score fallback under declared ordering,
deterministic tie-break and shared candidate budgets. Cursors bind generation,
context and disclosure. Expired/stale generations yield explicit restart or the
declared fallback, never mixed-order results. Recheck current content visibility
without leaking suppressed titles/counts or claiming an incomplete page is exact.

Retention bounds old generations and replay requirements. Erasure/revocation
invalidates affected delivery immediately and recomputes asynchronously. Qualify
skew, repeated snapshots, stale leases, sparse/private candidates and recovery in
[recommendation acceptance](../testing/recommendations.md).
