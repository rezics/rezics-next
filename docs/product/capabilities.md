# Product scope and capability coverage

## First delivery

Build Space (Realm and Zone), independently reusable Contexts, semantic classification/ratings and REZICS
Main Version as one foundation. Exercise books, software, media, recipes, Skills
and Prompts through native operations and current-source conversion. Universal
dependency/package management is selected, including resolution and installation
workflow semantics across Cargo/npm-family/Go/Nix/Minecraft/mod providers.

Collections/reading lists, comments, wikis, character and causal/background graphs
are composed uses of the same capabilities. They do not fragment identity or
become prerequisites to selecting the common architecture.

Individuals and Realms can share or specialize the same Context model, keeping
interpretation and preference separate. Global supplies a public baseline even
for specialist concepts; a default is a scoped selection. A Realm chooses its
own meaning when speaking about an object, while members retain their personal
interpretations. Naming another concept does not remove those local uses.

## Capability coverage

| Area | Required behavior | Contract owner |
| --- | --- | --- |
| M01 Foundation | Account, public Agent, representation, groups/roles, recovery, OAuth/MCP and private preferences. | [Identity](../contracts/identity-and-access.md), [apps](../contracts/connected-apps.md). |
| M02 Knowledge | Concepts/types/claims/evidence, shared versioned Contexts, personal/Realm interpretation choices, typed relations and bounded inference. | [Semantic model](../contracts/semantic-model.md), [Context](../contracts/context.md), [classification](../contracts/classification.md). |
| M03 Content | Documents/media, revisions, contributions, selection, publication and rights. | [Main Version](../contracts/main-version.md), [media](../contracts/media.md). |
| M04 Catalog | Five indexing domains, supporting entities, releases and source-free authoring. | [Catalog](../contracts/catalog.md). |
| M05 Creation/reading | Drafting, collaboration, Post chapters, translations, progress, citations and export. | [Creation](../contracts/creation.md), [composition](../contracts/composition.md). |
| M06 Community | Space, membership, Collections, discussions, polls, ratings, contextual statements, follows, favorites, messaging and governance. | [Space](../contracts/space.md), [community interactions](../contracts/community-interactions.md). |
| M07 Sources | Current acquisition, exact observations, mapping/adoption, refresh/withdraw and portable exchange. | [Sources](../contracts/source-lifecycle.md). |
| M08 Packages/Hub | Skill/Prompt/MCP catalog, dependency solving, lock/install/update/rollback and controlled execution. | [Packages](../contracts/package-management.md), [Hub](../contracts/skills-and-prompts.md). |
| M09 Query/operations | Graph-integrated full-text, filters, recommendation, event jobs, diagnostics, recovery and erasure. | [Search](../contracts/search.md), [operations](../operations/README.md). |
| M10 Commercial | Multi-plan subscriptions, independent gifts, Realm quotas/review and Pro application. | [Subscribe](../contracts/subscriptions.md), [Realm policy](../contracts/realm-participation.md). |

These identifiers preserve coverage, not physical service count or completed gates.
Each capability includes positive, denied, missing, stale, concurrency and recovery
outcomes. Provider omissions never remove native product requirements.

## Activation boundaries

Package management is in the selected target now. Executing a particular untrusted
artifact still requires an admitted executor/authority profile. Persistent hosting,
self-service third-party selling/payouts, broad information-verification campaigns,
full Wikidata/Schema.org corpus indexing and world-spatial experiences have separate
rollout/operating decisions. Their data foundations are compatible with this design.

## User journeys

1. Log in once, choose a public Agent per task, and act within explicit authority.
2. Enter a shared Work/Main Version, read an eligible language contribution and retain progress/citations through updates.
3. Select a shared or personal Context, contribute with an exact interpretation, and let a Realm independently adopt its own Context and accepted view through a Zone.
4. Query relations, context, ratings and full-text together with truthful completeness.
5. Import current provider data, preserve disagreements, adopt selected facts and refresh without losing local edits.
6. Resolve a package/environment, inspect why it is compatible, install/update and recover from interruption.
