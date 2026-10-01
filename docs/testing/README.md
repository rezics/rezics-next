# Acceptance design

Acceptance cases are declared under `scripts/qa/cases/`; the declarations
state required behavior and pending subcases, and the coverage files under
`scripts/qa/coverage/` name the tests that complete them.
Use [the plan](../plan/README.md#acceptance-gates) for gate definitions and
[system invariants](../contracts/system-invariants.md) for shared correctness.

## Test owners

| Owner | Scope |
| --- | --- |
| [Model](../../scripts/qa/cases/model-contracts.ts) | Identity, values, types, definitions and exact references. |
| [Identity/access](../../scripts/qa/cases/identity-and-access.ts) | SSO, representation, roles/groups, privacy, revocation and recovery. |
| [Classification](../../scripts/qa/cases/classification.ts) | Space/context, SKOS/native meaning, fallback and inference. |
| [Work](../../scripts/qa/cases/native-work.ts), [Book](../../scripts/qa/cases/book-and-creation.ts), [composition](../../scripts/qa/cases/content-composition.ts) | Main Version, contributions, occurrences, history and publication. |
| [Search](../../scripts/qa/cases/search.ts), [graphs](../../scripts/qa/cases/relationship-graph.ts), [ratings/time](../../scripts/qa/cases/ratings-and-event-time.ts) | Combined query semantics, populations, exactness and budgets. |
| [Sources](source-conformance.md), [packages](../../scripts/qa/cases/packages.ts), [Hub cases](../../scripts/qa/cases/ai-hub.ts), [recipe cases](../../scripts/qa/cases/recipes.ts) | Current inputs, native conversion and domain-specific operations. |
| [Wiki](../../scripts/qa/cases/wiki-composition.ts), [recommendations](../../scripts/qa/cases/recommendations.ts) | Composed views and bounded derived generations. |
| [Integration](../../scripts/qa/cases/backend-integration.ts), [Subscribe](../../scripts/qa/cases/subscriptions-and-pro.ts), [verification](../../scripts/qa/cases/information-verification.ts) | Cross-owner effects and activated product applications. |
| [Editorial protection](../../scripts/qa/cases/editorial-protection.ts) | Pending subcases of existing MODEL/LIVE/FACT/GOV/SYS/OPS coverage: atomic protection, independent review, source control, bypass rejection and recovery. |
| [Operations](../../scripts/qa/cases/operations.ts) | Installation, failures, upgrades, restore and practical load. |
| [Complexity verification](complexity.md) | Path inventory, derived cost contracts, work counters, engine plans and small multi-scale counterexamples across owners. |
| [Presentation/addressing](../../scripts/qa/cases/presentation-and-addressing.ts), [governance/delivery](../../scripts/qa/cases/governance-and-delivery.ts) | Route/rendering boundaries, exact reports, rights, notification and erasure cases. |

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
and failures; `task qa -- --record` writes per-ID status for a clean complete
run. This collection holds test practice, not an implementation progress archive. Unexecuted, skipped, unavailable
and failed are never a pass. Documentation checks prove links/structure only.

Do not weaken integrity expectations to close a gate. Use representative skew and
small growth tests to detect violations of derived bounds. The current 500M
business entities/documents and future 3B scenario are separate capacity claims
under [workload policy](../storage/workload-budgets.md), not minimum daily fixture
sizes. Qualify actual rollout capacity before claiming it. Temporary fixtures
stay in isolated task-owned storage and must not reset unrelated data.
