# Domain and protocol contracts

Contracts describe required behavior, failure states and invariants. Storage and
service owners implement them; UI, SDK and MCP adapters preserve their meaning.

| Area | Contract |
| --- | --- |
| Shared identity and meaning | [Semantic model](semantic-model.md), [data map](data-contract-map.md), [standards](standards.md), [system invariants](system-invariants.md). |
| Identity and security | [Identity/access](identity-and-access.md), [connected apps](connected-apps.md), [quotas](quotas.md), [license grants](license-grants.md). |
| Product spine | [Space](space.md), [Context](context.md), [Main Version](main-version.md), [Work/release](work-and-release.md). |
| Knowledge | [Classification](classification.md), [judgments](classification-judgments.md), [ratings](ratings.md), [event time](event-time.md), [information verification](information-verification.md). |
| Creation | [Creation](creation.md), [composition](composition.md), [structure history](structure-history.md), [media](media.md), [content languages](content-languages.md). |
| Indexing and packages | [Catalog](catalog.md), [source lifecycle](source-lifecycle.md), [package management](package-management.md), [Skill/Prompt](skills-and-prompts.md), [recipes](recipes.md). |
| Queries | [Search](search.md), [relationship graph](relationship-graph.md), [filters](filter-documents.md), [related reads](related-reads.md). |
| Durable operations | [API](api.md), [commands](commands.md), [events/jobs](events-and-jobs.md), [lifecycle](platform-lifecycle.md), [correction](identity-correction.md). |
| Community and presentation | [Governance](content-governance.md), [rules](governance-rules.md), [notifications](notifications.md), [presentation](presentation.md), [addressing](addressing.md). |
| Commercial application | [Subscribe](subscriptions.md), [Realm participation](realm-participation.md), [scoped delivery](realm-delivery.md). |

Each operation names its input identity, selected context, current authority,
preconditions, transaction boundary, idempotency, visible outcome and recovery
path. Missing, denied, stale, unsupported, partial and unavailable are distinct.
