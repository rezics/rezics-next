# Acceptance design

All cases in this directory are prospective requirements for the selected
architecture. They are not reports of current implementation or past passes.
Use [the plan](../plan/README.md#acceptance-gates) for gate definitions and
[system invariants](../contracts/system-invariants.md) for shared correctness.

## Test owners

| Owner | Scope |
| --- | --- |
| [Model](model-contracts.md) | Identity, values, types, definitions and exact references. |
| [Identity/access](identity-and-access.md) | SSO, representation, roles/groups, privacy, revocation and recovery. |
| [Classification](classification.md) | Space/context, SKOS/native meaning, fallback and inference. |
| [Work](native-work.md), [Book](book-and-creation.md), [composition](content-composition.md) | Main Version, contributions, occurrences, history and publication. |
| [Search](search.md), [graphs](relationship-graph.md), [ratings/time](ratings-and-event-time.md) | Combined query semantics, populations, exactness and budgets. |
| [Sources](source-conformance.md), [packages](packages.md), [Hub](ai-hub.md), [recipes](recipes.md) | Current inputs, native conversion and domain-specific operations. |
| [Wiki](wiki-composition.md), [recommendations](recommendations.md) | Composed views and bounded derived generations. |
| [Integration](backend-integration.md), [Subscribe](subscriptions-and-pro.md), [verification](information-verification.md) | Cross-owner effects and activated product applications. |
| [Operations](operations.md) | Installation, failures, upgrades, restore and practical load. |
| [Complexity verification](complexity.md) | Path inventory, derived cost contracts, work counters, engine plans and small multi-scale counterexamples across owners. |
| [Presentation/addressing](presentation-and-addressing.md), [governance/delivery](governance-and-delivery.md) | Route/rendering boundaries, exact reports, rights, notification and erasure cases. |

## Execution levels

Pure tests cover parsing, IR, exact values and deterministic policies. Real engine
tests cover Fuseki/TDB2 transactions, application revision recovery, jena-text queries
and guarded candidate validation and PostgreSQL owner
constraints. Stateful API tests carry actual producer IDs/receipts. Cross-service
tests exercise network/commit ambiguity and recovery. Experience checks follow
the authorized rendered scope. Live-source checks refresh inputs each run and
distinguish acquisition, conversion, native mapping and export outcomes.

## Evidence contract

The [executable harness](test-harness.md) turns these cases into tests named by
acceptance ID and records each run's commit, configuration, host, seeds, outcomes
and failures. `yarn qa --record` publishes per-ID status on the
[qualification page](../plan/qualification.md). This design collection contains
acceptance contracts, not an implementation progress archive. Unexecuted, skipped, unavailable
and failed are never a pass. Documentation checks prove links/structure only.

Do not weaken integrity expectations to close a gate. Use representative skew and
small growth tests to detect violations of derived bounds. The current 500M
business entities/documents and future 3B scenario are separate capacity claims
under [workload policy](../storage/workload-budgets.md), not minimum daily fixture
sizes. Qualify actual rollout capacity before claiming it. Temporary fixtures
stay in isolated task-owned storage and must not reset unrelated data.
