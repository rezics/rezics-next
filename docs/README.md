# REZICS architecture and implementation design

REZICS is a shared semantic knowledge and content platform. Native resources,
community perspectives and maintained main versions let people classify, create,
discuss and reuse content without fragmenting its identity across editions,
languages, sources or communities. Fluree is the selected native fact store and
graph query engine; full-text matching participates in its query plans.

These documents specify the desired system and how to build and qualify it.
They are design contracts, not claims that software or deployments are complete.

## Start here

1. [Product scope and capabilities](product/capabilities.md).
2. [Architecture overview](architecture/overview.md) and [service boundaries](architecture/services.md).
3. [Context and classification](contracts/context.md), [Space](contracts/space.md) and [classification](contracts/classification.md).
4. [Main versions and revisions](contracts/main-version.md).
5. [Graph-integrated search](contracts/search.md) and [package management](contracts/package-management.md).
6. [Implementation sequence](plan/README.md) and [acceptance](testing/README.md).
7. [Implementation blueprints](implementation/README.md): graph records, API/events,
   authorization bridge and recoverable package/vertical workflows.

## Document roles

| Owner | Responsibility |
| --- | --- |
| [Product](product/capabilities.md) | Outcomes, scope, complete capability coverage and user journeys. |
| [Architecture](architecture/README.md) | System boundaries, selected technologies and cross-domain invariants. |
| [Contracts](contracts/README.md) | Identity, operations, state transitions, authority and observable outcomes. |
| [Services](services/README.md) | Service interfaces, owned data, dependencies and failure handling. |
| [Implementation blueprints](implementation/README.md) | Concrete target representations and producer-to-consumer protocols. |
| [Storage](storage/README.md) | Engine bindings, placement, history, indexing and workload budgets. |
| [Experience](experience/README.md) | How clients expose the same capability without losing meaning. |
| [Operations](operations/README.md) | Deployment assessment, installation, recovery, erasure and incidents. |
| [Testing](testing/README.md) | Prospective scenarios and evidence required to qualify the target. |
| [Development](development/README.md) | Repository organization, generation, development workflow and frontend code boundaries. |
| [Plan](plan/README.md) | Dependency order, active documentation scope and qualification status. |
| [Research](research/README.md) | Questions that still affect implementation choices. |
| [Legal](../legal/user-agreement.md) | Published agreement and [privacy text](../legal/privacy-policy.md); engineering design does not amend them. |

## Implementation and verification

Each behavior has one contract owner. Service and storage documents link to that
owner and specify its realization rather than redefine its meaning. Schemas,
APIs, SDKs, commands and adapters must implement the same operation contracts.

External-site validation obtains current inputs on every live run and retains
the run's exact observations for reproduction. A stable test does not require a
permanently pinned upstream package release. Engine builds, normative vocabulary
artifacts and deployment dependencies are versioned separately.

The first product gate checks semantics, concurrency, bounded work and recovery
on available hardware. The 500M-row baseline and 3B-row estimate guide long-term
planning; reproducing those volumes is not an initial delivery prerequisite.
See [workload policy](storage/workload-budgets.md).

Maintainer prose is English; quoted source data retains its language. Do not use
temporary discussion files as maintained dependencies. Design evidence belongs
beside the decision, and prospective tests must never be described as passes.
Documentation tooling is described in [development](development/README.md).
