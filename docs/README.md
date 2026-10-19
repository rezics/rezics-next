# REZICS document index

Use this index to load the owner of the current task. Entries describe intent
and reading triggers; schemas, tests and commands define executable behavior.
Design documents do not claim that a capability or deployment is complete.

- [Repository instructions](../AGENTS.md) — Always-loaded essentials and instruction precedence.
- [Active Goals](../GOAL.md) — Goal owners and outcomes; read to locate active delivery work.

## On-demand procedures

- [api-ui-design](../.agents/skills/api-ui-design/SKILL.md) — Design or review REZICS capability/API contracts and GUI interactions. Use for semantic or information-organization changes, not routine edits.
- [aspire](../.agents/skills/aspire/SKILL.md) — Operate or diagnose Aspire-managed resources and edit AppHost topology. Use for Aspire CLI, lifecycle, integration or telemetry work; ordinary application code, repository organization and documentation do not trigger this skill merely by mentioning Aspire.
- [external-content-value](../.agents/skills/external-content-value/SKILL.md) — Write, revise or audit REZICS external content, including UI copy, localization, public documentation and showcase metadata. Use when changing audience-facing text; internal logs, tests, comments and maintainer documentation are outside scope unless their audience value is explicitly under review.
- [goal-management](../.agents/skills/goal-management/SKILL.md) — Start or enroll a REZICS Goal manager, handle its event turns, checkpoint it, and close it. Use for manager lifecycle work, not ordinary product implementation.
- [goal-wave](../.agents/skills/goal-wave/SKILL.md) — Implement a REZICS wave build task or run its authorized prove phase on a shared wave branch. Use only when the brief or current task selects wave work.
- [goal-worker](../.agents/skills/goal-worker/SKILL.md) — Run a REZICS Goal worker's targeted checks and recorded jobs, inspect failures, and prepare its handoff. Use during worker execution; wave build/prove work uses goal-wave.
- [local-development](../.agents/skills/local-development/SKILL.md) — Start or refresh local REZICS stacks, prepare signed-in browser fixtures, acquire optional datasets, or perform launch accessibility checks. Load the matching procedure; ordinary code and document edits do not need a stack.
- [product-audit](../.agents/skills/product-audit/SKILL.md) — Find class-level product problems in REZICS before users do. Use at each milestone, before calling an area complete, and whenever one defect is reported, to find every surface that breaks the same principle.
- [research-and-validation](../.agents/skills/research-and-validation/SKILL.md) — Research and evaluate substantive designs, technical proposals and uncertain engineering choices. Routine edits do not trigger this workflow.
- [storybook-ui-review](../.agents/skills/storybook-ui-review/SKILL.md) — Inspect new or changed REZICS UI through Storybook and actual screenshots, then fix issues within the task. Use for visible component, layout, style or copy changes; not research-only requests or nonvisual code changes.

## Goal protocols and state

- [Goal program](goals/README.md) — Goal ownership, shared-host coordination and convergence; read for orchestration.
- [Goal manager charter](goals/manager.md) — Manager authority and standing policy; read when managing a Goal.
- [How work is defined, proved and landed](goals/method.md) — Outcome rows and landing criteria; read when defining or proving work.
- [Waves: build, then prove](goals/wave.md) — Build and prove phase boundaries; read only for wave work.
- [Goal worker protocol](goals/worker.md) — Worker authority and handoff; read when assigned a Goal task.
- [Frozen import outcome specification](goals/audit-remediation-20261019/import-outcomes.md) — Pending two-source import fidelity, conservative coverage and fixture prerequisites; read before reviewing or proving the import outcome rows.
- [Information outcome specification handoff](goals/audit-remediation-20261019/information-outcomes.md) — Pending supporting information and ordered reads, proposed shared contracts and deferred baseline prerequisites; read before reviewing or proving these rows.

## Architecture

- [Architecture map](architecture/README.md) — Architecture map; read when changing that capability or its implementation boundary.
- [Actionable collections and ingredient reconciliation](architecture/actionable-collections.md) — Actionable collections and ingredient reconciliation; read when changing that capability or its implementation boundary.
- [Activity duration and estimates](architecture/activity-duration.md) — Activity duration and estimates; read when changing that capability or its implementation boundary.
- [Private anchored journals and return state](architecture/anchored-journals.md) — Private anchored journals and return state; read when changing that capability or its implementation boundary.
- [Native API contract pilot](architecture/api-contracts.md) — Native API contract pilot; read when changing that capability or its implementation boundary.
- [Bounded community automation](architecture/community-automation.md) — Bounded community automation; read when changing that capability or its implementation boundary.
- [Field meaning, content forms and adoption](architecture/content-adoption.md) — Field meaning, content forms and adoption; read when changing that capability or its implementation boundary.
- [Design evidence and qualification boundaries](architecture/evidence.md) — Design evidence and qualification boundaries; read when changing that capability or its implementation boundary.
- [Selected architecture](architecture/overview.md) — Installed owner boundaries and topology; read before cross-owner changes.
- [Private plans and scheduled actions](architecture/scheduled-plans.md) — Private plans and scheduled actions; read when changing that capability or its implementation boundary.
- [Service boundaries and dependency contracts](architecture/services.md) — Service boundaries and dependency contracts; read when changing that capability or its implementation boundary.
- [Target architecture](architecture/target-architecture.md) — Cross-domain target decisions and unresolved qualification; read for architecture changes.

## Contracts

- [Domain and protocol contracts](contracts/README.md) — Domain and protocol contracts; read when changing this domain's meaning, authority or API outcomes.
- [API, SDK and MCP direction](contracts/api.md) — API, SDK and MCP direction; read when changing this domain's meaning, authority or API outcomes.
- [Catalog grain still to qualify](contracts/catalog.md) — Catalog grain still to qualify; read when changing this domain's meaning, authority or API outcomes.
- [Classification, spoilers and measurements](contracts/classification-judgments.md) — Classification, spoilers and measurements; read when changing this domain's meaning, authority or API outcomes.
- [Objects, semantic statements and contextual classification](contracts/classification.md) — Objects, semantic statements and contextual classification; read when changing this domain's meaning, authority or API outcomes.
- [Client synchronization and offline editing](contracts/client-synchronization.md) — Client synchronization and offline editing; read when changing this domain's meaning, authority or API outcomes.
- [Commands and cross-owner consistency](contracts/commands.md) — Commands and cross-owner consistency; read when changing this domain's meaning, authority or API outcomes.
- [Community interactions and messaging](contracts/community-interactions.md) — Community interactions and messaging; read when changing this domain's meaning, authority or API outcomes.
- [Content composition](contracts/composition.md) — Content composition; read when changing this domain's meaning, authority or API outcomes.
- [Connected applications, OAuth and MCP](contracts/connected-apps.md) — Connected applications, OAuth and MCP; read when changing this domain's meaning, authority or API outcomes.
- [Content governance and rights complaints](contracts/content-governance.md) — Content governance and rights complaints; read when changing this domain's meaning, authority or API outcomes.
- [Content languages and selection](contracts/content-languages.md) — Content languages and selection; read when changing this domain's meaning, authority or API outcomes.
- [Shared Contexts, interpretation and preferences](contracts/context.md) — Shared Contexts, interpretation and preferences; read when changing this domain's meaning, authority or API outcomes.
- [Native creation and reading](contracts/creation.md) — Native creation and reading; read when changing this domain's meaning, authority or API outcomes.
- [Executable Zone themes](contracts/custom-theme-execution.md) — Executable Zone themes; read when changing this domain's meaning, authority or API outcomes.
- [Distribution and editions](contracts/distribution.md) — Distribution and editions; read when changing this domain's meaning, authority or API outcomes.
- [Editorial protection and reviewed corrections](contracts/editorial-protection.md) — Editorial protection and reviewed corrections; read when changing this domain's meaning, authority or API outcomes.
- [Committed events and recoverable jobs](contracts/events-and-jobs.md) — Committed events and recoverable jobs; read when changing this domain's meaning, authority or API outcomes.
- [Governance rules and decisions](contracts/governance-rules.md) — Governance rules and decisions; read when changing this domain's meaning, authority or API outcomes.
- [Identity, representation and authorization](contracts/identity-and-access.md) — Identity, representation and authorization; read when changing this domain's meaning, authority or API outcomes.
- [Identity correction, merge and split](contracts/identity-correction.md) — Identity correction, merge and split; read when changing this domain's meaning, authority or API outcomes.
- [Claims, evidence and information verification](contracts/information-verification.md) — Claims, evidence and information verification; read when changing this domain's meaning, authority or API outcomes.
- [Rights declarations and license offerings](contracts/license-grants.md) — Rights declarations and license offerings; read when changing this domain's meaning, authority or API outcomes.
- [Main Version and Work continuity](contracts/main-version.md) — Main Version and Work continuity; read when changing this domain's meaning, authority or API outcomes.
- [Media assets, representations and uses](contracts/media.md) — Media assets, representations and uses; read when changing this domain's meaning, authority or API outcomes.
- [Metadata-only resources](contracts/metadata-only.md) — Metadata-only resources; read when changing this domain's meaning, authority or API outcomes.
- [Standard vocabulary profiles and application responsibility](contracts/model-profiles.md) — Standard vocabulary profiles and application responsibility; read when changing this domain's meaning, authority or API outcomes.
- [Names, identifiers and editorial authority](contracts/names-and-authority.md) — Names, identifiers and editorial authority; read when changing this domain's meaning, authority or API outcomes.
- [Notifications](contracts/notifications.md) — Notifications; read when changing this domain's meaning, authority or API outcomes.
- [Package management intent](contracts/package-management.md) — Package management intent; read when changing this domain's meaning, authority or API outcomes.
- [Package ecosystem profile decisions and remaining boundaries](contracts/package-profiles.md) — Package ecosystem profile decisions and remaining boundaries; read when changing this domain's meaning, authority or API outcomes.
- [Resource lifecycle and platform operation](contracts/platform-lifecycle.md) — Resource lifecycle and platform operation; read when changing this domain's meaning, authority or API outcomes.
- [Resource presentation and Blocks](contracts/presentation.md) — Resource presentation and Blocks; read when changing this domain's meaning, authority or API outcomes.
- [Queries, facets and filters](contracts/queries.md) — Queries, facets and filters; read when changing this domain's meaning, authority or API outcomes.
- [Quota and request-budget boundaries](contracts/quotas.md) — Quota and request-budget boundaries; read when changing this domain's meaning, authority or API outcomes.
- [Read ranking population cuts](contracts/ranking.md) — Read ranking population cuts; read when changing this domain's meaning, authority or API outcomes.
- [Deferred rating query requirements](contracts/ratings.md) — Deferred rating query requirements; read when changing this domain's meaning, authority or API outcomes.
- [Realm-scoped delivery still to qualify](contracts/realm-delivery.md) — Realm-scoped delivery still to qualify; read when changing this domain's meaning, authority or API outcomes.
- [Realm participation and organizational authority](contracts/realm-participation.md) — Realm participation and organizational authority; read when changing this domain's meaning, authority or API outcomes.
- [Recipe file exchange](contracts/recipe-exchange.md) — Recipe file exchange; read when changing this domain's meaning, authority or API outcomes.
- [Remaining recipe classification contract](contracts/recipes.md) — Remaining recipe classification contract; read when changing this domain's meaning, authority or API outcomes.
- [Recommendation and ranking generations](contracts/recommendations.md) — Recommendation and ranking generations; read when changing this domain's meaning, authority or API outcomes.
- [Relationship graph API and views](contracts/relationship-graph.md) — Relationship graph API and views; read when changing this domain's meaning, authority or API outcomes.
- [Graph-integrated full-text search](contracts/search.md) — Graph-integrated full-text search; read when changing this domain's meaning, authority or API outcomes.
- [Source graphs and portable semantic exchange](contracts/semantic-interoperability.md) — Source graphs and portable semantic exchange; read when changing this domain's meaning, authority or API outcomes.
- [Native semantic model](contracts/semantic-model.md) — Native semantic model; read when changing this domain's meaning, authority or API outcomes.
- [Hub content rollout gaps](contracts/skills-and-prompts.md) — Hub content rollout gaps; read when changing this domain's meaning, authority or API outcomes.
- [Source observations, support and native adoption](contracts/source-lifecycle.md) — Source observations, support and native adoption; read when changing this domain's meaning, authority or API outcomes.
- [Space, Realm, Zone and curation](contracts/space.md) — Space, Realm, Zone and curation; read when changing this domain's meaning, authority or API outcomes.
- [Spatial annotations and world views](contracts/spatial-annotations.md) — Spatial annotations and world views; read when changing this domain's meaning, authority or API outcomes.
- [Standards and semantic profiles](contracts/standards.md) — Standards and semantic profiles; read when changing this domain's meaning, authority or API outcomes.
- [Structure history and revision anchors](contracts/structure-history.md) — Structure history and revision anchors; read when changing this domain's meaning, authority or API outcomes.
- [Structure change work](contracts/structure.md) — Structure change work; read when changing this domain's meaning, authority or API outcomes.
- [Subject associations and contextual reading](contracts/subject-association-reading.md) — Subject associations and contextual reading; read when changing this domain's meaning, authority or API outcomes.
- [System invariants](contracts/system-invariants.md) — System invariants; read when changing this domain's meaning, authority or API outcomes.
- [Votes, references and community accountability](contracts/votes-and-references.md) — Votes, references and community accountability; read when changing this domain's meaning, authority or API outcomes.
- [Native Work and release grain](contracts/work-and-release.md) — Native Work and release grain; read when changing this domain's meaning, authority or API outcomes.
- [Work read sessions](contracts/work-read.md) — Work read sessions; read when changing this domain's meaning, authority or API outcomes.

## Development

- [Local stack workflow](development/README.md) — Local stack workflow; read when changing or using that development surface.
- [Rezics UI and Rezics Aura](development/design-system.md) — Rezics UI and Rezics Aura; read when changing or using that development surface.
- [Primary-source retrieval](development/external-sources.md) — Primary-source retrieval; read when changing or using that development surface.
- [Hidden ids](development/hidden-ids.md) — Hidden ids; read when changing or using that development surface.
- [Launch journey accessibility](development/launch-accessibility.md) — Launch journey accessibility; read when changing or using that development surface.
- [Local real-world datasets](development/local-datasets.md) — Local real-world datasets; read when changing or using that development surface.
- [Disposable local web authorization](development/local-web-auth.md) — Disposable local web authorization; read when changing or using that development surface.
- [platform-gates](development/platform-gates.md) — platform-gates; read when changing or using that development surface.
- [Repository organization](development/repository-structure.md) — Repository organization; read when changing or using that development surface.
- [Component review](development/storybook.md) — Component review; read when changing or using that development surface.
- [Toolchain and root commands](development/toolchain.md) — Pinned tools and generated command inventory; read before adding or replacing tools.
- [Web feature organization](development/web-features.md) — Web feature organization; read when changing or using that development surface.

## Plan

- [Plan](plan/README.md) — Delivery routes, gates and completion; read when choosing a work area.
- [Frontend direction](plan/frontend.md) — Main and Accounts product behavior; read before changing a screen or flow.
- [Low-priority work](plan/low-priority/README.md) — Low-priority work; read when changing that capability or its implementation boundary.
- [CurseForge acquisition](plan/low-priority/curseforge-acquisition.md) — CurseForge acquisition; read when changing that capability or its implementation boundary.
- [Steam Workshop acquisition](plan/low-priority/steam-workshop-acquisition.md) — Steam Workshop acquisition; read when changing that capability or its implementation boundary.

## Product

- [Product scope and capability coverage](product/capabilities.md) — Product scope and capability coverage; read when changing that capability or its implementation boundary.
- [Decisions](product/decisions.md) — Decisions; read when changing that capability or its implementation boundary.
- [Demand study](product/demand-study.md) — Demand study; read when changing that capability or its implementation boundary.
- [Product, API and GUI design principles](product/design-principles.md) — Product, API and GUI design principles; read when changing that capability or its implementation boundary.
- [REZICS goal](product/goal.md) — REZICS goal; read when changing that capability or its implementation boundary.
- [Markets and growth](product/markets-and-growth.md) — Markets and growth; read when changing that capability or its implementation boundary.
- [Platform thesis](product/platform-thesis.md) — Platform thesis; read when changing that capability or its implementation boundary.
- [URLs and search indexing](product/urls-and-seo.md) — URLs and search indexing; read when changing that capability or its implementation boundary.

## Implementation

- [Implementation blueprints](implementation/README.md) — Implementation blueprints; read when changing that capability or its implementation boundary.
- [Adding API and event surfaces](implementation/api-and-events.md) — Adding API and event surfaces; read when changing that capability or its implementation boundary.
- [Access-to-Jena authorization bridge](implementation/authorization-bridge.md) — Access-to-Jena authorization bridge; read when changing that capability or its implementation boundary.
- [Graph records, shapes and history resolution](implementation/graph-records.md) — Graph records, shapes and history resolution; read when changing that capability or its implementation boundary.
- [Interaction graph and cache bootstrap](implementation/interactions-and-cache.md) — Interaction graph and cache bootstrap; read when changing that capability or its implementation boundary.
- [Profile compilation, validation and command binding](implementation/model-profile-validation.md) — Profile compilation, validation and command binding; read when changing that capability or its implementation boundary.
- [Cross-owner workflow obligations](implementation/vertical-workflows.md) — Cross-owner workflow obligations; read when changing that capability or its implementation boundary.

## Storage

- [Storage design](storage/README.md) — Storage design; read when changing that capability or its implementation boundary.
- [Apache Jena storage and query binding](storage/jena.md) — Apache Jena storage and query binding; read when changing that capability or its implementation boundary.
- [Data ownership and physical placement](storage/ownership-and-placement.md) — Data ownership and physical placement; read when changing that capability or its implementation boundary.
- [Shared database substrate for QA](storage/qa-shared-databases.md) — Shared database substrate for QA; read when changing that capability or its implementation boundary.
- [Model, schema and index evolution](storage/schema-evolution.md) — Model, schema and index evolution; read when changing that capability or its implementation boundary.
- [Workload and capacity decisions](storage/workload-budgets.md) — Workload and capacity decisions; read when changing that capability or its implementation boundary.
- [zone-home-erasure-ordering](storage/zone-home-erasure-ordering.md) — zone-home-erasure-ordering; read when changing that capability or its implementation boundary.

## Testing

- [Acceptance design](testing/README.md) — Acceptance design; read when selecting or implementing its verification.
- [Pending catalogue release and media outcomes](goals/audit-remediation-20261019/releases-and-media.md) — Exact release selection, source media, navigation contracts and their retained fixture prerequisites.
- [Pending public Recipe and Book outcomes](goals/audit-remediation-20261019/public-domain-outcomes.md) — Source-qualified fixture prerequisites and six-persona contracts; read before implementing or proving these audit outcomes.
- [Identity and reader preparation handoff](goals/audit-remediation-20261019/identity-reader-handoff.md) — Supported Book publication commands, reader corrections and remaining genuine-corpus proof.
- [Complexity verification](testing/complexity.md) — Complexity verification; read when selecting or implementing its verification.
- [seed-build-command-cost](testing/seed-build-command-cost.md) — seed-build-command-cost; read when selecting or implementing its verification.
- [Live source conversion and conformance](testing/source-conformance.md) — Live source conversion and conformance; read when selecting or implementing its verification.
- [Shared audit corpus preparation](testing/audit-corpus.md) — Source pins, command stages, stopped backup and isolated manifest restore ownership for pending audit proofs.
- [Executable test harness](testing/test-harness.md) — Executable test harness; read when selecting or implementing its verification.

## Operations

- [Operation design](operations/README.md) — Operation design; read when preparing or operating that lifecycle.
- [Executable theme review and incidents](operations/custom-theme-review-and-incident-response.md) — Executable theme review and incidents; read when preparing or operating that lifecycle.
- [Production deployment](operations/deployment.md) — Production deployment; read when preparing or operating that lifecycle.
- [Account email operations](operations/email.md) — Account email operations; read when preparing or operating that lifecycle.
- [Erasure, retention and exact revisions](operations/erasure.md) — Erasure, retention and exact revisions; read when preparing or operating that lifecycle.
- [External conditions for going live](operations/external-conditions.md) — External conditions for going live; read when preparing or operating that lifecycle.
- [Install the local REZICS stack](operations/installation.md) — Install the local REZICS stack; read when preparing or operating that lifecycle.
- [Launch market gates](operations/market-gates.md) — Launch market gates; read when preparing or operating that lifecycle.
- [Observability, health and diagnosis](operations/observability.md) — Observability, health and diagnosis; read when preparing or operating that lifecycle.
- [First installation and launch intake](operations/production-install.md) — First installation and launch intake; read when preparing or operating that lifecycle.
- [Backup, restoration and index recovery](operations/recovery.md) — Backup, restoration and index recovery; read when preparing or operating that lifecycle.
- [Release and rollback](operations/release.md) — Release and rollback; read when preparing or operating that lifecycle.
- [Search index qualification](operations/search-index.md) — Search index qualification; read when preparing or operating that lifecycle.
- [Security and disclosure boundaries](operations/security.md) — Security and disclosure boundaries; read when preparing or operating that lifecycle.
- [TDB2 integrity: the node-table out-of-bounds fault](operations/tdb2-integrity.md) — TDB2 integrity: the node-table out-of-bounds fault; read when preparing or operating that lifecycle.
- [Trust and safety operations](operations/trust-and-safety.md) — Trust and safety operations; read when preparing or operating that lifecycle.

## Services

- [Account service](services/account.md) — Account service; read when changing that capability or its implementation boundary.

## Research

- [Implementation questions and experiments](research/README.md) — Unresolved implementation questions and source routes; read when a design needs evidence.
- [Access depth, organizational representation and voting authority](research/access-depth-representation-and-voting.md) — Access depth, organizational representation and voting authority; read when evaluating the corresponding design question.
- [Access storage, object authority and ordered policy evaluation](research/access-storage-and-policy.md) — Access storage, object authority and ordered policy evaluation; read when evaluating the corresponding design question.
- [Agent-efficiency tooling re-evaluation](research/agent-efficiency-tooling.md) — Agent-efficiency tooling re-evaluation; read when evaluating the corresponding design question.
- [Controlled execution and hosting design questions](research/ai-hub-execution.md) — Controlled execution and hosting design questions; read when evaluating the corresponding design question.
- [Application runtime and frontend selection](research/application-stack.md) — Application runtime and frontend selection; read when evaluating the corresponding design question.
- [Private search admission decision](research/private-search-admission.md) — Private search admission decision; read when evaluating the corresponding design question.
- [AO3 and VNDB: tags, filters and the reverse query](research/reference-ao3-vndb.md) — AO3 and VNDB: tags, filters and the reverse query; read when evaluating the corresponding design question.
- [Social reading and comfortable feeds](research/reference-social-reading.md) — Social reading and comfortable feeds; read when evaluating the corresponding design question.
- [Games, mods and software directory references](research/reference-stores.md) — Games, mods and software directory references; read when evaluating the corresponding design question.
- [Web-novel platforms for readers and authors](research/reference-webnovel.md) — Web-novel platforms for readers and authors; read when evaluating the corresponding design question.
- [Semantic Web coverage and local model decisions](research/semantic-web-model-coverage.md) — Semantic Web coverage and local model decisions; read when evaluating the corresponding design question.
- [Source data reuse under U.S. law](research/source-data-rights.md) — Source data reuse under U.S. law; read when evaluating the corresponding design question.
- [Storage architecture decision](research/storage-architecture.md) — Storage architecture decision; read when evaluating the corresponding design question.
- [Mature toolchain survey](research/toolchain-survey.md) — Mature toolchain survey; read when evaluating the corresponding design question.

## Legal drafts

- [README](legal/README.md) — README; read when changing that policy or its product obligations.
- [acceptable-use-policy](legal/acceptable-use-policy.md) — acceptable-use-policy; read when changing that policy or its product obligations.
- [ai-policy](legal/ai-policy.md) — ai-policy; read when changing that policy or its product obligations.
- [api-and-agent-terms](legal/api-and-agent-terms.md) — api-and-agent-terms; read when changing that policy or its product obligations.
- [child-safety-policy](legal/child-safety-policy.md) — child-safety-policy; read when changing that policy or its product obligations.
- [content-ratings-and-age-policy](legal/content-ratings-and-age-policy.md) — content-ratings-and-age-policy; read when changing that policy or its product obligations.
- [copyright-and-dmca-policy](legal/copyright-and-dmca-policy.md) — copyright-and-dmca-policy; read when changing that policy or its product obligations.
- [creator-distribution-agreement-outline](legal/creator-distribution-agreement-outline.md) — creator-distribution-agreement-outline; read when changing that policy or its product obligations.
- [ncii-takedown-policy](legal/ncii-takedown-policy.md) — ncii-takedown-policy; read when changing that policy or its product obligations.
- [privacy-policy](legal/privacy-policy.md) — privacy-policy; read when changing that policy or its product obligations.
- [terms-of-service](legal/terms-of-service.md) — terms-of-service; read when changing that policy or its product obligations.
