# Product scope and capability coverage

The [goal](goal.md) states what REZICS is for and how its success is judged;
this page records the delivery scope that serves it.

REZICS builds Space (Realm and Zone), independently reusable Contexts, semantic
classification and ratings, and the Main Version as one native foundation,
exercised by books, software, media, recipes, Skills and Prompts. Collections,
comments, wikis and character or background graphs compose these capabilities
rather than fragmenting identity. People and Realms share or specialize the same
Contexts: a Realm chooses its own meaning when it speaks about an object while
members keep their interpretations, and Global supplies a public baseline.

## First scenarios

Selected by the product manager under maintainer delegation, 2026-09-29.

Chosen for recurring use and REZICS's intended combined advantage
(native multilingual, versions and translations, community interpretation,
API- and agent-first):

1. **Multilingual series tracking**, led by light novels: what is available,
   owned, read and next, per edition, translation and language.
2. **A portable reading library**: reading sessions across editions and formats,
   DNF, pauses, rereads, ownership and loans, faithful import and export.
3. **Serial fiction**: dependable drafting, scheduling, calm reading, resuming
   and chapter discussion.
4. **Visual-novel discovery by usable release**: language, platform and
   translator provenance.
5. **A franchise wiki Zone built with holders' agents**: the holder runs an
   independent open-source local toolkit with their own agent, which extracts
   characters, places, relationships and events chapter by chapter with
   evidence; reviewed proposals publish into the Work's wiki Zone, the Work
   page's deep end, which readers browse up to their own position
   ([wiki owner](../contracts/information-verification.md#a-big-franchise-wiki-for-every-work)).

The maintainer added the fifth on 2026-09-30 and made it the flagship of the
first launch, next to library tracking, because it is the most visible proof
of the goal's three values ([wiki+](goal.md#wiki-the-flagship)).

Reviews, catalogue correction, communities and structured organisation (saved
views) serve all five, and the Work page gathers them as the hub, as Bangumi's
subject page does. The Light Novels and ACGN Zones present them over one
catalogue. Every Zone stays visible and truthful about what it supports.

Beyond these scenarios: the same wiki build reaches every Work, not only the
flagship franchise; authors get a world bible that replaces separate
worldbuilding tools; agents, official and third-party, keep REZICS's knowledge
current through one open contribution protocol; REZICS distributes books and
games directly to fund itself; and communities reward helpful contribution.

The [platform thesis](platform-thesis.md) explains why these share an engine;
[markets and growth](markets-and-growth.md) owns recruitment and later verticals.
These are delivery choices, not a claim that the capability inventory below is
fully implemented or that every listed commercial/package feature launches now.

## Capability coverage

The identifiers preserve scope, not service count or completed gates. Every
capability includes denied, missing, stale, concurrent and recovery outcomes;
provider omissions never remove a native requirement.

| Area | Scope | Owner |
| --- | --- | --- |
| M01 Foundation | Account, public Agents, representation, groups and roles, recovery, OAuth/MCP, private preferences. | [Identity](../contracts/identity-and-access.md), [apps](../contracts/connected-apps.md) |
| M02 Knowledge | Concepts, claims and evidence, shared versioned Contexts, personal and Realm interpretation, typed relations, bounded inference. | [Semantic model](../contracts/semantic-model.md), [Context](../contracts/context.md), [classification](../contracts/classification.md) |
| M03 Content | Documents and media, revisions, contributions, selection, publication, rights. | [Main Version](../contracts/main-version.md), [media](../contracts/media.md) |
| M04 Catalog | One catalogue of admitted types, supporting entities, releases, source-free authoring. | [Work and release](../contracts/work-and-release.md), [catalog](../contracts/catalog.md), [source conformance](../testing/source-conformance.md) |
| M05 Creation and reading | Drafting, collaboration, Post chapters, translations, progress, citations, export. | [Creation](../contracts/creation.md), [composition](../contracts/composition.md) |
| M06 Community | Space, membership, Collections, discussions, polls, ratings, statements, follows, favorites, messaging, governance. | [Space](../contracts/space.md), [interactions](../contracts/community-interactions.md) |
| M07 Sources | Acquisition, exact observations, mapping and adoption, refresh and withdrawal, portable exchange. | [Sources](../contracts/source-lifecycle.md) |
| M08 Packages and Hub | Skill, Prompt and MCP entries as ordinary catalogue types. Optional capability outside catalogue and Zone paths: dependency solving across Cargo, npm-family, Go, Nix, Minecraft and mod providers, lock/install/update/rollback, controlled execution. | [Packages](../contracts/package-management.md), [Hub schema](../../services/main/src/modules/hub/schema.ts), [Hub flows](../contracts/skills-and-prompts.md), [execution](../research/ai-hub-execution.md) |
| M09 Query and operations | Graph-integrated full-text, filters, recommendation, event jobs, diagnostics, recovery, erasure. | [Search](../contracts/search.md), [operations](../operations/README.md) |
| M10 Commercial | Multi-plan subscriptions, gifts, Realm quotas and review, Pro application, Person/Realm beneficiaries and third-party sellers. | [Commerce](../../services/main/src/modules/commerce/README.md), [Realm policy](../contracts/realm-participation.md) |

## Deferred rollouts

Product manager under maintainer delegation, 2026-09-29. Each needs a separate
rollout decision, despite appearing in the capability inventory:

Direct messages, Pro subscriptions, package installation and execution,
institutional voting, Zone custom CSS, 500-million-entity qualification, Redis,
large-scale import runs, native apps, general offline collaboration,
unrestricted formulas and templates, specialist collector and study tools, full
wiki-host migration, streaks and attendance rewards, webhooks, character polls
and tournaments, an open marketplace, keys, DRM and launchers, and acquisition
campaigns for music, recipes, software, mods and AI resources (their Zones stay
visible and truthful).

Persistent hosting, seller onboarding and payouts, broad verification campaigns,
full Wikidata/Schema.org indexing, [image Works and image indexing](../contracts/media.md#images-in-the-semantic-graph)
(behind a platform grant even after rollout) and world-spatial experiences
beyond the selected private-world tools also retain separate rollout gates. Untrusted execution requires
an admitted executor and authority profile. The reason is to qualify recurring
reader/creator tasks before taking on another operating model.

**First-launch cut lines** (product manager, 2026-09-30, for the 25-hour
production-readiness push). The first launch is light novels and visual novels
as two views over one catalogue and library, each with franchise wikis, in the
eight UI locales, on phone and desktop. These stay closed, and truthfully
labelled, until after that launch: the LLM index and Measured beyond what
exists; events and geography (PostGIS); distribution, commerce and Stripe;
points and credit; worldbuilding; developer extras; Agent mode; the split
workbench and batch merge queues; serial scheduling beyond what exists; the
science-fiction and interactive-fiction manifests; the withheld-domain
expansion acceptance run; adult (R18) opt-in; classification suggestions,
saved views, Simple/Advanced density, in-app telemetry and recognition, which
ships only if cheap after the production gates pass.

Package solving stays an optional capability even after its rollout: no
catalogue read, Zone route or other domain may depend on it, because it is the
largest domain-specific mass in the backend
([backend one, frontend free](goal.md#backend-one-frontend-free)).
