# REZICS architecture and implementation design

REZICS is one open, multilingual platform on one shared graph. Every work,
person, organization, place, event and model has one identity across domains,
languages and communities, and any community can build a complete Zone site
over that graph. Its flagship is **wiki+**: franchise wikis of correctly
modelled facts, with native lists, tracking, ratings and discussion on the same
graph. The [goal](product/goal.md) states why and how success is judged.

Native resources, community perspectives and maintained main versions let
people classify, create, discuss and reuse content without fragmenting its
identity across editions, languages, sources or communities. Apache Jena
Fuseki serves SPARQL over TDB2; jena-text integrates Lucene full-text matching
with graph queries. PostgreSQL owns document bodies/revisions,
drafts and private/operational state; Main provides one history contract with
owner-specific adapters and asynchronous exact-revision publication.

These documents specify the desired system and how to build and qualify it.
They are design contracts, not claims that software or deployments are complete.

## Start here

Start with the [goal page](product/goal.md) and the
[platform thesis](product/platform-thesis.md); for a local stack, follow
[installation and graph quickstart](operations/installation.md). Development uses the [toolchain lock](development/toolchain.md) and the
[executable test harness](testing/test-harness.md). Main, Account, the web app and
the Accounts site exist in part.

For sustained implementation, use the root [Goal](../GOAL.md) and
[task reading routes](plan/README.md#task-reading-routes). The maintainer starts
a Goal explicitly. Its manager follows the [manager charter](goals/manager.md)
and runs worker processes, claims and integration waves through the
[Goal program](goals/README.md); workers follow the [worker protocol](goals/worker.md).

1. [Goal](product/goal.md), then [product scope and capabilities](product/capabilities.md).
2. [Architecture overview](architecture/overview.md) and [service boundaries](architecture/services.md).
3. [Context and classification](contracts/context.md), [Space](contracts/space.md) and [classification](contracts/classification.md).
4. [Main versions and revisions](contracts/main-version.md).
5. [Graph-integrated search](contracts/search.md) and [package management](contracts/package-management.md).
6. [Implementation sequence](plan/README.md) and [acceptance](testing/README.md).
7. [Implementation blueprints](implementation/README.md): graph records, API/events,
   authorization bridge and recoverable package/vertical workflows.

Lasting product decisions: [goal](product/goal.md), [platform thesis](product/platform-thesis.md),
[markets and growth](product/markets-and-growth.md), [URLs and SEO](product/urls-and-seo.md),
and [trust and safety operations](operations/trust-and-safety.md). These pages
retain intent and evidence independently of the active Goal; installed contracts
remain in code and the contract owners linked by the Goal's decision index.

## Document roles

| Owner | Responsibility |
| --- | --- |
| [Product](product/capabilities.md) | Scope, capability coverage and the [design principles](product/design-principles.md) for capabilities, APIs and screens. |
| [Architecture](architecture/README.md) | System boundaries, selected technologies and cross-domain invariants. |
| [Contracts](contracts/README.md) | Identity, operations, state transitions, authority and observable outcomes. |
| [Services](architecture/services.md) | Service boundaries, owned data and the [Account service](services/account.md) procedures. |
| [Implementation blueprints](implementation/README.md) | Concrete representations, extension procedures and producer-to-consumer protocols. |
| [Storage](storage/README.md) | Engine bindings, placement, history, indexing and workload budgets. |
| [Frontend](plan/frontend.md) | Product decisions for the main and Accounts sites; stories and browser tests carry the flows. |
| [Operations](operations/README.md) | Deployment assessment, installation, recovery, erasure and incidents. |
| [Testing](testing/README.md) | Test practice, the harness and complexity verification; scenarios live in `scripts/qa/cases/`. |
| [Development](development/README.md) | Repository organization, generation, development workflow and frontend code boundaries. |
| [Plan](plan/README.md) | Current state, task reading routes, acceptance gates and the frontend direction. |
| [Research](research/README.md) | Questions that still affect implementation choices. |
| [Legal drafts](legal/README.md) | Terms, privacy, ratings, AI, copyright, takedown, child-safety, API and creator-agreement drafts adapted from openly licensed policies (2026-09-29). Not reviewed by counsel; the [safety and legal-readiness decision](operations/trust-and-safety.md#safety-and-legal-readiness) records the accepted risk until counsel is affordable. |

## Implementation and verification

Each behavior has one contract owner. Service and storage documents link to that
owner and specify its realization rather than redefine its meaning. Schemas,
APIs, SDKs, commands and adapters must implement the same operation contracts.

External-site validation obtains current inputs on every live run and retains
the run's exact observations for reproduction. A stable test does not require a
permanently pinned upstream package release. Engine builds, normative vocabulary
artifacts and deployment dependencies are versioned separately.

The first product gate checks semantics, concurrency, derived cost bounds and
recovery. [Complexity verification](testing/complexity.md) uses small multi-scale
counterexamples and observed work. The current corpus is 500M business
entities/documents; 3B is a future scenario. Neither is a daily fixture size.
Qualify actual storage/import/service/recovery capacity separately before claiming
that deployment scope. See [workload policy](storage/workload-budgets.md).

Maintainer prose is English; quoted source data retains its language. Do not use
temporary discussion files as maintained dependencies. Design evidence belongs
beside the decision, and prospective tests must never be described as passes.
Documentation tooling is described in [development](development/README.md).
