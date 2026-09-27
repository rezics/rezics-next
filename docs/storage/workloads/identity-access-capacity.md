# Identity and Access workload design

## Planning inputs

Principals/Agents, groups/roles/bindings, representation path depth, effective-member expansion and revocation fan-out.

Measure resource-hierarchy, group-membership, selected-representation and
dependent-grant depths separately from compiled evaluator depth. Record reached
states/edges, per-subject memberships, policy intersections/exclusions, freshness,
negative decisions, hot owners, bulk/list sizes and mutation skew.

The owner axes are declared as [checked load inputs](../../../scripts/load/budget.ts);
owner fixtures and measured capacity still need qualification.
Derive this owner's facts and retained history separately from the global
[capacity scenario](../workload-budgets.md#capacity-planning).

## Bounded implementation

Use selective subject/target/scope indexes, batched decisions, bounded impact planning and immediate scope fences before cleanup. Do not make the entire private directory a per-request join.

Validate selected proof dependencies in consistent batches. Share request-local
subproblems with keys that preserve action, target, context, revisions and limits.
Bound distinct states, database rows/bytes, statement time, memory, queueing,
per-tenant concurrency and total bulk work as well as depth. Enforce budgets
inside execution; a counter checked after an unbounded SQL scan is insufficient.

Admit only supported policy/topology profiles. Requalify or migrate affected
profiles before lowering operational limits. Unresolved budget exhaustion is
unavailable and cannot become a fall-through allowance or a false proof that no
authority exists. Keep expensive discovery/impact/list work bounded or paginated.

Selectively materialize ancestry where measured read benefit warrants it. Budget
storage by the sum of tree depths or the actual graph closure, not by assuming
constant-size indexes. Reparenting and revocation can multiply ancestor/subtree
updates; stage index generations and preserve independent support on deletion.

## Initial qualification and growth

Use [multi-scale work observations](../../testing/complexity.md) before
qualifying an owner threshold or rollout capacity. Current small fixtures do
not establish 500-million-entity capacity.

The [depth study](../../research/access-depth-representation-and-voting.md)
explains why these initial experiment profiles need qualification: 32-edge
group/resource hierarchies,
8-edge representation/dependency chains, 64 evaluator levels, 2,048 decision
states, a 50 ms evaluation deadline and 100-target ordinary batches. These are
unqualified tuning candidates, not production limits or achieved task coverage.

Test depths 1/2/4/8/16/32 and rejected profiles; vary branching independently using
bounded sparse graphs, diamonds, invalid cycles and hot groups. Compare positive
and negative checks, cold/warm inputs, ordered exclusions, grant churn, root/middle
revocation, delayed indexes, rebuilds and multi-target/search requests on durable
storage. Measure p50/p95/p99, throughput, errors, reads/round trips, CPU/memory,
queueing, index bytes, write amplification and revoke-to-denial delay.

Any evaluator comparison preserves policy, freshness and list completeness.
Report 99% legitimate-task coverage as a separate product target using representative
task weights and per-family/tenant-size results; a small successful chain probe
cannot establish that percentage.
