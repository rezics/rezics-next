# Selected follows graph

## Question

What is the graph whose acyclicity `wdt:P155` declares, and what native boundaries can break it through Context selection or identity merging?

## Findings

The current game catalogue declares `wdt:P155` (`follows`) with inverse `wdt:P156` and `acyclic: true` in `packages/definitions/catalogue/game.yaml`. The [P155 description](https://www.wikidata.org/wiki/Property:P155) points from an item to the immediately prior item; [P156](https://www.wikidata.org/wiki/Property:P156) points to the immediately following item. Normalize inverse reads into the P155 direction once before comparing edges. Wikidata releases its structured property data under CC0; its help prose is CC BY-SA 4.0 ([licensing policy](https://www.wikidata.org/wiki/Wikidata:Licensing)).

The old Semantic relation-properties paragraph says a write that closes a cycle is refused (`services/kernel/src/semantic/README.md`, prior wording). The released property metadata and that sentence are not implementation evidence. Inspection of `candidate-proposal.ts`, `candidate-decision.ts`, `candidate-adoption.ts`, `identity-adapters/identity-epoch-contract.ts` and `merges.ts` found no consumer of the relation's `acyclic` flag or selected-graph check. `candidate-adoption.ts` resolves and writes one subject's slot in its routed command. Existing Context behavior is covered by `services/kernel/test/semantic/context-relations.test.ts`; that fixture does not cover follows cycles.

Use the effective selected graph, not the set of raw claims. For a particular release and Context, include the selected Global edges inherited into the Context, plus its local replacements and suppressions. Vertices are current canonical Subject identities. A canonical self-loop and any directed cycle violate the invariant. Raw candidates, source references, original endpoint identities, disputes and history remain evidence even when graph endpoints are normalized.

Identity quotienting is not cycle preserving. Given A→B→C, merging A and C maps the path to A→B→A; an existing A→C edge also maps to A→A. Therefore a merge must reconcile affected selected edges before its result is treated as a conforming graph. It cannot assume redirects alone preserve the DAG.

## Design implications

| Approach | What it establishes | Limit |
| --- | --- | --- |
| Read-time graph traversal | Detects self-loops and longer cycles in the selected Context view. PostgreSQL recursive CTE `CYCLE` records a path and marks a repeated vertex ([PostgreSQL 18 query docs](https://www.postgresql.org/docs/current/queries-with.html#queries-with-cycle-detection); [PostgreSQL License](https://www.postgresql.org/about/licence/)). | Detection after separate commits does not prevent two independently routed, concurrent selections from forming a cycle. A query also needs an explicit traversal bound or an operational budget for large graphs. |
| Per-subject adoption check | Can validate a replacement against the visible graph before writing that slot. | Two opposite edges on different subject partitions can each pass against the same old graph. The check and publication need a shared serialization/fencing boundary to prevent this race. |
| Shared serializable mutation boundary | PostgreSQL Serializable makes successful transactions equivalent to a serial order; applications must handle serialization failures (`40001`) ([PostgreSQL 18 isolation docs](https://www.postgresql.org/docs/current/transaction-iso.html); [PostgreSQL License](https://www.postgresql.org/about/licence/)). | The guarantee applies only when all conflicting selection and merge writes participate in that boundary. This repository routes subject writes by partition, so the native witness should establish the actual boundary before selecting an implementation. |
| Topological-sort check | NetworkX exposes DAG checks using topological ordering ([DAG API](https://networkx.org/documentation/stable/reference/algorithms/dag.html)). The inspected source is `.reference/selected-follows/networkx/networkx/algorithms/dag.py` and [the pinned source file](https://github.com/networkx/networkx/blob/c32b376b53229f2b2a2d06029c25a852737efdc2/networkx/algorithms/dag.py), clone commit `c32b376b53229f2b2a2d06029c25a852737efdc2`; its license is [BSD 3-Clause](https://github.com/networkx/networkx/blob/c32b376b53229f2b2a2d06029c25a852737efdc2/LICENSE.txt) (`.reference/selected-follows/networkx/LICENSE.txt`). | This is a useful reference for a graph oracle and offline verification, not a transactional write protocol. The clone was read only; no code is proposed for copying. |

The Wikidata property-constraint system is useful as a distinction: its official help describes suggestions and mandatory constraint status as different report severities, which is separate from a repository write protocol ([constraint portal](https://www.wikidata.org/wiki/Help:Property_constraints_portal/en)). Here `acyclic: true` is a hard product invariant for follows, not proof that current writes enforce it.

## Recommendation for this repository

Record follows as the first hard-DAG family in the Semantic owner contract. Normalize P156 into P155 orientation, evaluate effective selection by Context and current canonical identity, and keep raw source evidence intact. Establish native outcomes for sequential closure, concurrent opposite selections on distinct subject partitions, Global inheritance with a community reverse edge, and A→B→C followed by merging A/C. The driver is `services/kernel/test/semantic/selected-follows-native.test.ts` with route operations and independent forward/inverse reads.

This research adopts the graph contract only. It does not add proposal or merge refusals, pick a factual winner, or assert broad enforcement. The native test is intentionally not run by the source worker; production enforcement design follows the integrated native result. That deferred result must include the exact revision and operation outcomes.
