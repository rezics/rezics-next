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
| [Presentation/addressing](presentation-and-addressing.md), [governance/delivery](governance-and-delivery.md) | Route/rendering boundaries, exact reports, rights, notification and erasure cases. |

## Execution levels

Pure tests cover parsing, IR, exact values and deterministic policies. Real engine
tests cover Fluree transactions/history/queries/validation and PostgreSQL owner
constraints. Stateful API tests carry actual producer IDs/receipts. Cross-service
tests exercise network/commit ambiguity and recovery. Experience checks follow
the authorized rendered scope. Live-source checks refresh inputs each run and
distinguish acquisition, conversion, native mapping and export outcomes.

## Evidence contract

Record tested commit/build/configuration/profile, hardware, source capture,
commands, expected/actual outcomes, failures and scope. Keep runtime evidence in
the owning run/artifact system; this design collection contains acceptance
contracts, not an implementation progress archive. Unexecuted, skipped, unavailable
and failed are never a pass. Documentation checks prove links/structure only.

Do not weaken integrity expectations to close a gate. Use representative skew and
growth tests on available machines; large-volume 500M/3B qualification is deferred
under [workload policy](../storage/workload-budgets.md). Temporary fixtures stay in
isolated task-owned storage and must not reset unrelated data.
