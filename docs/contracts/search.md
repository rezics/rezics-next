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
Each page checks current graph selection and disclosure; HTTP requests do not
share a TDB2 reader. [SEARCH01–20 declarations](../../scripts/qa/cases/search.ts) retain the
required outcomes and pending extensions, while
[coverage declarations](../../scripts/qa/coverage/search.ts) identify asserted tests.

Ranked catalogue continuations pin the committed Lucene reader that supplied
their first page, including its candidates, scores and document tie order.
Later writes and merges do not expire that basis or add new matches to its
pages. The basis lasts up to five minutes from its original admission; replay
does not extend it. A deferred first page retains the same basis and starts
before its first candidate. A fresh search sees the latest committed index.

Every page still checks current publication, Realm adoption, disclosure and
presentation policy. A retained posting grants no access: an entry that loses
eligibility is omitted. Counts are lower bounds while a further deliverable
result may remain, and become exact when the bounded lookahead proves the
traversal exhausted. The count describes delivered results from that basis;
`sourcePosition` describes the current page's graph check, while
`indexGeneration` names its original ranking generation.

Expiry or loss of a retained basis returns HTTP 409 with
`search_restart_required`; the client restarts without a cursor. Data restore
or a native process restart also invalidates its cursors. The native owner
retains at most 64 distinct reader generations, sharing a generation across
searches. When admission is full it refuses a new basis with HTTP 503, preserving
active traversals until expiry. Expired reader references are released on reads
and by periodic cleanup. Current graph and authority fences remain in force
during each request; an unrelated write between pages is not a restart reason.

## Public Work typeahead

`public-work-typeahead-v1` walks the native prefix directory for title and
author-credit candidates, including published source-author names. Each request
examines at most four directory entries per suggestion slot, advancing past
rejected or hidden entries. It never scans names, including when the directory
is unavailable: an unqualified directory produces a typed 503 refusal.

The walk's cursor binds its native reader generation. A generation change
during matching or card hydration restarts the snapshot read; no mixed-generation
page is returned. Graph selection, disclosure and presentation retain their
freshness fences. The optional `language` selects card presentation; candidate
matching uses the walk's `null` language scope across selected languages.

## Statement aggregation

The [grouped profile](../../services/main/src/modules/work/search-grouped.ts)
binds direct active occurrences and supports at an explicit count grain.
Broader inference and display grouping remain pending SEARCH subcases.

Logical candidate, call and byte ceilings are code contracts. They do not prove
physical engine work or mixed-load latency at rollout scale. The
[complexity procedure](../testing/complexity.md) and
[recorded qualification](../plan/README.md#current-state) carry measured scope and runs.

## Multilingual retrieval direction

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
