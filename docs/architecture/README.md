# Architecture map

## Model and ownership

- [Overview](overview.md): selected Semantic Web architecture and product spine.
- [Services](services.md): business owners, deployable processes and dependencies.
- [System invariants](../contracts/system-invariants.md): cross-domain correctness.
- [Semantic model](../contracts/semantic-model.md): identities, values and model admission.
- [Data contract map](../contracts/data-contract-map.md): complete domain coverage.
- [Storage ownership](../storage/ownership-and-placement.md): one writer, multiple stores and placement.
- [Decision evidence](evidence.md): sources, selected lessons and remaining qualification.
- [Coverage and invariant traceability](coverage.md): capability realization and prospective acceptance.

## Domain contracts

| Domain | Owners |
| --- | --- |
| Account and authority | [Identity/access](../contracts/identity-and-access.md), [connected applications](../contracts/connected-apps.md), [Account service](../services/account.md). |
| Space and community context | [Space](../contracts/space.md), [Context](../contracts/context.md), [classification](../contracts/classification.md), [ratings](../contracts/ratings.md). |
| Content spine | [Main version](../contracts/main-version.md), [Work/release](../contracts/work-and-release.md), [composition](../contracts/composition.md), [structure history](../contracts/structure-history.md). |
| Indexing domains | [Catalog](../contracts/catalog.md), [recipes](../contracts/recipes.md), [package management](../contracts/package-management.md), [Skill/Prompt](../contracts/skills-and-prompts.md). |
| Sources and knowledge | [Source lifecycle](../contracts/source-lifecycle.md), [standards](../contracts/standards.md), [information verification](../contracts/information-verification.md). |
| Queries and interfaces | [Search](../contracts/search.md), [relationship graph](../contracts/relationship-graph.md), [API contracts](../contracts/api.md), [presentation](../contracts/presentation.md). |
| Durable effects | [Commands](../contracts/commands.md), [events/jobs](../contracts/events-and-jobs.md), [governance](../contracts/content-governance.md), [notifications](../contracts/notifications.md). |
| Operations and optional commercial rollout | [Recovery](../operations/recovery.md), [deployment](../operations/deployment.md), [Subscribe](../contracts/subscriptions.md), [Realm policies](../contracts/realm-participation.md). |

## Reading rules

Fuseki + TDB2 + jena-text/Lucene and the Semantic Web direction are selected. Engine qualification tests
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
