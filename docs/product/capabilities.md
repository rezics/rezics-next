# Product scope and capability coverage

REZICS builds Space (Realm and Zone), independently reusable Contexts, semantic
classification and ratings, and the Main Version as one native foundation,
exercised by books, software, media, recipes, Skills and Prompts. Collections,
comments, wikis and character or background graphs compose these capabilities
rather than fragmenting identity. People and Realms share or specialize the same
Contexts: a Realm chooses its own meaning when it speaks about an object while
members keep their interpretations, and Global supplies a public baseline.

## Capability coverage

The identifiers preserve scope, not service count or completed gates. Every
capability includes denied, missing, stale, concurrent and recovery outcomes;
provider omissions never remove a native requirement.

| Area | Scope | Owner |
| --- | --- | --- |
| M01 Foundation | Account, public Agents, representation, groups and roles, recovery, OAuth/MCP, private preferences. | [Identity](../contracts/identity-and-access.md), [apps](../contracts/connected-apps.md) |
| M02 Knowledge | Concepts, claims and evidence, shared versioned Contexts, personal and Realm interpretation, typed relations, bounded inference. | [Semantic model](../contracts/semantic-model.md), [Context](../contracts/context.md), [classification](../contracts/classification.md) |
| M03 Content | Documents and media, revisions, contributions, selection, publication, rights. | [Main Version](../contracts/main-version.md), [media](../contracts/media.md) |
| M04 Catalog | Five indexing domains, supporting entities, releases, source-free authoring. | [Work and release](../contracts/work-and-release.md), [catalog](../contracts/catalog.md), [source conformance](../testing/source-conformance.md) |
| M05 Creation and reading | Drafting, collaboration, Post chapters, translations, progress, citations, export. | [Creation](../contracts/creation.md), [composition](../contracts/composition.md) |
| M06 Community | Space, membership, Collections, discussions, polls, ratings, statements, follows, favorites, messaging, governance. | [Space](../contracts/space.md), [interactions](../contracts/community-interactions.md) |
| M07 Sources | Acquisition, exact observations, mapping and adoption, refresh and withdrawal, portable exchange. | [Sources](../contracts/source-lifecycle.md) |
| M08 Packages and Hub | Skill/Prompt/MCP catalog, dependency solving across Cargo, npm-family, Go, Nix, Minecraft and mod providers, lock/install/update/rollback, controlled execution. | [Packages](../contracts/package-management.md), [Hub schema](../../services/main/src/modules/hub/schema.ts), [Hub flows](../contracts/skills-and-prompts.md), [execution](../research/ai-hub-execution.md) |
| M09 Query and operations | Graph-integrated full-text, filters, recommendation, event jobs, diagnostics, recovery, erasure. | [Search](../contracts/search.md), [operations](../operations/README.md) |
| M10 Commercial | Multi-plan subscriptions, gifts, Realm quotas and review, Pro application, Person/Realm beneficiaries and third-party sellers. | [Commerce](../../services/main/src/modules/commerce/README.md), [Realm policy](../contracts/realm-participation.md) |

## Deferred rollouts

Each needs its own rollout decision; the data foundations already fit:
executing an untrusted artifact (needs an admitted executor and authority
profile), persistent hosting, seller onboarding and payouts, broad verification
campaigns, full Wikidata/Schema.org indexing and world-spatial experiences.
