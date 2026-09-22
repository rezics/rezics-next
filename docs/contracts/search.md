# Full-text as a graph-query operator

## Required semantics

Fluree owns the combined query plan. Full-text produces bindings for match unit,
Resource, selected content/revision, source and score that participate in graph
joins, context resolution, authorization, grouping and aggregation. REZICS does
not use a detached search-first application pipeline as its main query model.

A representative query finds Works whose Main Version has eligible Chinese text,
whose Realm-effective classification matches a concept, whose Realm rating
meets a declared criterion, and whose readable text matches the query. The final
limit applies after the requested relation/filter/deduplication semantics.

## Execution lanes

| Lane | Correctness obligation |
| --- | --- |
| Equivalent filter pushdown | Prove that the indexed filter preserves the graph predicate's identity, occurrence and context semantics. |
| Graph candidates to full-text | Rank inside a snapshot-bound candidate relation; do not truncate before applying it. |
| Ranked scan with residual graph checks | Continue until the required result is proved or budget is exhausted; report incompleteness explicitly. |
| Bound text scoring | Score eligible graph-bound text values in the same query, with explicit field/score aggregation. |

Candidate budget, internal search limit and final result limit are different.
Joins preserve multiplicity until the query explicitly deduplicates. Existence
filters may admit rank-preserving continuation; score-changing joins, grouping
and facets need their own completion proof. Approximate vector/hybrid candidates
cannot be described as exact global Top-K. Counts and facets refer to the complete
specified match population, not merely the returned page.

## Initial implementation

Use native property-level full-text and dedicated BM25 Graph Sources where their
qualified behavior fits. Add versioned CJK analysis across indexing, querying,
incremental updates and remote adapters. The dedicated BM25 surface is FQL;
do not present its search predicates as standard SPARQL syntax. A future SPARQL
extension must lower to the same IR and operators.

The Fluree integration owns query IR, candidate injection, source capabilities,
snapshot binding and result completeness. Main owns REZICS context/selection
rules and supplies trusted inputs; do not hard-code Realm names into a generic
engine. When native retrieval lacks required phrase/field/facet capabilities,
integrate Tantivy as a Graph Source/backend under the same plan. OpenSearch is
not an initial deployment dependency.

## Analyzer contract

Persist analyzer ID/version, dictionary digests, normalization, language routing,
token positions/offset behavior and indexed field profile. Start with jieba-rs
for Chinese and Lindera dictionaries for Japanese/Korean; evaluate names, scripts,
identifiers, mixed text and user vocabulary. Retain original text. Simplified/
traditional conversion, transliteration and case folding create derived search
forms, not replacement authoritative literals or automatic identity equivalence.

Do not silently fall back to English when a selected analyzer is unavailable.
Index/query analyzers must agree. An analyzer or dictionary change creates a new
generation. Compare relevance and token/highlight behavior on authored multilingual
cases and current domain examples before activation.

## Search documents and security

A match unit is a coherent disclosure and content-selection unit: exact body,
title/name value, eligible published chapter or bounded chunk. Record Resource,
revision, occurrence/representation where relevant, context, language, field,
source and selector. Avoid one triple per result or one unbounded book string.

An accessible title cannot authorize a private body's matching terms. Permission
must constrain participating text, snippets, counts, suggestions and facets.
Recheck delivery eligibility while preserving query completeness semantics.
Keep statistics isolated when shared ranking statistics would violate the elected
privacy boundary. Cache/candidate handles bind authority, snapshot and context.

Cross-ledger policy search is enabled only with an implemented enforcement path.
An engine path that conservatively hides all hits is surfaced as unsupported or
unavailable, not a successful empty result. Initial main-product queries can stay
within one qualified product ledger; source observations need not be unioned into
every native search.

## Projection and freshness

Track authoritative commits, indexed input watermarks and the reader's actual
snapshot separately. Multi-source indexes retain a vector of source positions;
one minimum integer is not a global snapshot. Read-after-write can wait for a
specified source fence or return pending/stale with a deadline. Historical search
requires a qualified historical index snapshot; a fresh head index is insufficient.

Use root-local text projection records and an explicit reverse-dependency index
for joined fields. A changed author/selection/classification schedules bounded
affected roots, coalesced by generation. Avoid complex indexing queries that
silently trigger full-corpus rebuild on every commit. Published-selection changes
and erasure invalidate the exact affected units before stale text can be disclosed.

## Generation lifecycle

`building -> catching_up -> ready -> active -> draining -> retired`.
The manifest pins source snapshots, projection/model/analyzer versions and backend
format. Build separately, catch up, compare, atomically switch a logical pointer,
retain a rollback window and eventually collect unreferenced artifacts. Workers
carry fencing tokens. Rollback does not restore revoked disclosure or erased text.
This supports official Fluree -> patched build -> official build transitions.

## Response and admission

Return used generations/source positions, exact/partial ranking, count/facet
precision, completion reason and snapshot-bound continuation. Budgets cover
candidates scanned, graph expansion, memory, time, bytes and fan-out; LIMIT alone
does not bound execution. Unsupported query shapes are explicit errors.

## Evidence and qualification

[Fluree BM25](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/indexing-and-search/bm25.md)
documents integrated FQL bindings and limits on policy/multi-ledger queries and
incremental source shapes. [Operator code](https://github.com/fluree/db/blob/82dbcec3e435d6ed1d45bc0ed929432323b6b201/fluree-db-query/src/bm25/operator.rs)
shows candidate truncation before later checks. These observations select the
implementation work above, not a reason to abandon graph-integrated search.
[Tantivy](https://github.com/quickwit-oss/tantivy) is a library, so its service,
snapshot and recovery integration remains REZICS work. See [search acceptance](../testing/search.md).
