# Architecture map

## Model and ownership

- [Overview](overview.md): selected Semantic Web architecture and product spine.
- [Services](services.md): business owners, deployable processes and dependencies.
- [System invariants](../contracts/system-invariants.md): cross-domain correctness.
- [Semantic model](../contracts/semantic-model.md): identities, values and model admission.
- [Content adoption design](content-adoption.md): field meaning and admitted forms, derivation, references and the Recipe migration proposal.
- [Storage ownership](../storage/ownership-and-placement.md): one writer, multiple stores and placement.
- [Decision evidence](evidence.md): sources, selected lessons and remaining qualification.
- [Native API contract pilot](api-contracts.md): precision, ownership and compiler-cost evidence for separating contracts and handlers.
- [Actionable collections](actionable-collections.md): decided occurrence-based runs and optional ingredient sum/stock offset; contracts and outcome proofs follow.
- [Private scheduled plans](scheduled-plans.md): finite private occurrences, cancellation, due notifications and export over existing owners; contracts and proof follow.
- [Target architecture](target-architecture.md): cross-domain decisions and links to their owning contracts.
- [Shared capability exceptions](shared-capabilities.md): shared owners that still recognise a vertical or source, their repairs and required proof.
- [Audit module design review](audit-module-design-review-20261019.md): review draft of Source, conversion, native capability and consuming-module boundaries, with current implementation evidence and alternatives.

## Domain contracts

| Domain | Owners |
| --- | --- |
| Account and authority | [Identity/access](../contracts/identity-and-access.md), [connected applications](../contracts/connected-apps.md), [Account service](../services/account.md). |
| Space and community context | [Space](../contracts/space.md), [Context](../contracts/context.md), [classification](../contracts/classification.md), [Rating owner](../../services/main/src/modules/rating/README.md), [deferred rating query requirements](../contracts/ratings.md). |
| Content spine | [Main version](../contracts/main-version.md), [Work/release](../contracts/work-and-release.md), [composition](../contracts/composition.md), [structure history](../contracts/structure-history.md). |
| Catalogue of admitted types | One catalogue, not a fixed set of domains: [Work and release](../contracts/work-and-release.md), [recipe profile](../../model/definitions/recipe-structure-v1.ts), [Hub schema](../../services/main/src/modules/hub/schema.ts); optional [package management](../contracts/package-management.md) outside catalogue paths. |
| Sources and knowledge | [Source lifecycle](../contracts/source-lifecycle.md), [standards](../contracts/standards.md), [information verification](../contracts/information-verification.md). |
| Queries and interfaces | [Search](../contracts/search.md), [relationship graph](../contracts/relationship-graph.md), [API contracts](../contracts/api.md), [presentation](../contracts/presentation.md). |
| Durable effects | [Commands](../contracts/commands.md), [events/jobs](../contracts/events-and-jobs.md), [governance](../contracts/content-governance.md), [notifications](../contracts/notifications.md). |
| Operations and optional commercial rollout | [Recovery](../operations/recovery.md), [deployment](../operations/deployment.md#commercial-rollout), [Commerce owner](../../services/main/src/modules/commerce/README.md), [Realm policies](../contracts/realm-participation.md). |

## Reading rules

PostgreSQL Content/operations + Fuseki/TDB2/jena-text/Lucene and the Semantic Web
direction are selected. Object storage serves media/artifacts and large sealed
payloads. No separate search service is required initially. Engine qualification tests
how the selected design behaves; it does not reopen the database choice by default.
Main Version is a maintained product object. Immutable component manifests and
revision anchors implement exact history; TDB2 transaction snapshots do not provide
permanent historical reads. Adoption and publication remain explicit decisions.

Multi-service does not require one machine or database per service. Initial
placement favors concentrating principal services on one host; the other host
primarily handles API and unrelated workloads. Account placement remains an
assessment decision. No document may imply that either placement is deployed.

Retained product capabilities remain requirements even when a provider cannot
describe them. [The capability map](../product/capabilities.md) distinguishes the
first delivery sequence from later activation of hosted execution or commerce.
