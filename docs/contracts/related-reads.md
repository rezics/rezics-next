# Bounded related-resource reads

## Contract

Related lists specify relation meaning, direction, target grain, context, ordering,
coverage and disclosure. Credits, releases, chapters, source mappings and mentions
have different relation identities. Bind all role filters to the same occurrence;
do not cross-join unrelated participants.

## Execution

Use one-request Fuseki snapshots and admitted inverse projections. Exact historical
reads resolve sealed component manifests. Multi-request paging binds a materialized
result or restarts if relevant generations change; a dataset fence alone cannot
reopen a TDB2 read transaction. Page by stable
order/key with bounded batched hydration; high-degree targets do not justify
whole-list loads or exact global counts. Report continuation and unavailable
members without leaking suppressed titles/counts. Ranking generations bind cursors.

Projection writes derive only from owner events and retain source revision/epoch.
Failed rebuilds preserve active generations. Query correctness and bounded work
must survive sparse/private candidates and repeated targets in different contexts.
