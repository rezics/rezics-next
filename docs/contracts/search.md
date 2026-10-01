# Graph-integrated full-text search

## Why this binding

REZICS selected PostgreSQL plus Jena/TDB2 with jena-text and local Lucene.
PostgreSQL owns Content bodies and revisions; Jena owns semantic relationships
and the searchable representation. One graph/text query can bind selected text
to the same Work, Realm, Statement, rating and Context facts that qualify it.
This avoids a cross-store ranked scan whose first text hits may all fail graph
conditions. OpenSearch and PostgreSQL text extensions are not startup dependencies.
The [storage decision](../research/storage-architecture.md) records the alternatives.

Main compiles typed profiles and owns admission, disclosure, count grain and
failure meaning. Fuseki executes bounded graph/text reads; it does not decide
REZICS authority. The [authorization bridge](../implementation/authorization-bridge.md)
explains the cross-owner fence. PostgreSQL Content eligibility is projected from
exact adopted revisions; an index posting alone cannot prove a body is current.

## PostgreSQL body projection

The [Content projection](../../services/main/src/modules/content-publication/search.ts)
checks its owner position against the graph and reader generation.

## Current boundary

Public Main, Realm, Content, grouped Statement and disclosed-field profiles are
bounded slices. A separate native Contribution draft phrase profile uses an
Access receipt-fenced WebSocket. The [private admission decision](../research/private-search-admission.md)
explains its delivery boundary. Broader private, historical, multi-source and
inferred-group queries require their own admission and qualification. Unsupported
selectors have typed refusal outcomes; a missing capability is not an empty hit set.

The authored limits and readiness proof live in
[search-readiness.ts](../../services/main/src/modules/work/search-readiness.ts),
[search-grouped.ts](../../services/main/src/modules/work/search-grouped.ts) and
[Content search](../../services/main/src/modules/content-publication/search.ts).
The Work and Content continuation types bind complete relations and owner/index
positions in [Work paging](../../services/main/src/modules/work/search-continuation.ts)
and [Content paging](../../services/main/src/modules/content-publication/search-continuation.ts).
Every page re-evaluates its bounded relation; HTTP requests do not share a TDB2
reader. [SEARCH01–20 declarations](../../scripts/qa/cases/search.ts) retain the
required outcomes and pending extensions, while
[coverage declarations](../../scripts/qa/coverage/search.ts) identify asserted tests.

Ranked catalogue pages report a lower-bound count while more candidates remain,
and their continuation is valid only within one Lucene commit: score ties follow
document order inside that commit, so any later commit requires a restart rather
than a page that may skip or repeat hits. The native writer fences every
text-wrapper commit, including private and metadata writes, because Lucene may
publish a merge on those commits.

## Statement aggregation

The [grouped profile](../../services/main/src/modules/work/search-grouped.ts)
binds direct active occurrences and supports at an explicit count grain.
Broader inference and display grouping remain pending SEARCH subcases.

Logical candidate, call and byte ceilings are code contracts. They do not prove
physical engine work or mixed-load latency at rollout scale. The
[complexity procedure](../testing/complexity.md) and
[recorded qualification](../plan/qualification.md) carry measured scope and runs.

## Multilingual retrieval direction

Decision 18, product manager under maintainer delegation, 2026-09-29.
Build one retrieval capability on Jena/Lucene: per-language analysis, aliases
and readings, Simplified/Traditional folding, and Works, people, Realms, posts
and Concepts in cross-entity results. Main owns typo recovery and discovery with
real explanations and reader controls. Introduce a dedicated search engine only
after a measured advantage.

The reason is to preserve shared graph/disclosure semantics while improving
language relevance, rather than duplicate them in a second service prematurely.
[Jena text](https://jena.apache.org/documentation/query/text-query.html)
provides the binding; language quality, recovery and mixed-load performance still
require REZICS measurements under the selected language contract.
