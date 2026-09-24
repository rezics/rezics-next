# Full-text as a graph-query operator

## Required semantics and bootstrap

Main compiles admitted REZICS query descriptors to SPARQL 1.1 with ARQ's
`text:query` property function. Fuseki executes the graph/text joins over a TDB2
dataset wrapped by jena-text and its local Lucene index. Main uses TypeScript/Bun and
calls Fuseki through HTTP; one Fuseki JVM owns the dataset and index. Lucene is a library in that
JVM, not a separately deployed search service. [Storage binding](../storage/jena.md)
owns the topology and write protocol.

A representative query finds Works whose Main Version has eligible Chinese text,
whose Realm-effective classification matches a concept, whose Realm rating meets
a criterion, and whose readable text matches the query. The final result limit
applies after that relation, authorization and deduplication. Main owns the typed
context, publication and score-aggregation rules; Jena does not infer them.

The first delivery profile indexes currently public, eligible MatchUnits and
admits bounded graph/text templates. Private content remains available through
admitted resource reads; private full-text is explicitly unsupported until its
pre-match enforcement and statistical isolation are qualified. This is a launch
profile, not a change to the complete query contract. Unsupported shapes return
capability errors, never a successful empty answer or a silently weakened filter.

The installed Main default and Realm-effective phrase lanes project exact public
selected-body MatchUnits in the same guarded transaction as their respective
selection. Each query counts **all** current public MatchUnits and joins a
predicate-specific jena-text match with effective selection in one TDB2 read
snapshot. It admits at most 100 public units across all contexts and requests
101 Lucene hits, so later context, current-selection and language checks cannot
hide an eligible hit within that bound. A larger population returns a budget
error. A Realm with no local choice uses its Main Version default; a local
choice shadows that default in the requested Realm. An explicit local rejection
also shadows the default and contributes no text hit. These lanes do not qualify
broader typed filters or private full-text required below.

The first `public-main-classified-phrase-v1` and
`public-realm-classified-phrase-v1` lanes add one active shared Sense to those
bounded phrase queries. They complete the public text relation first, then keep
only Main Versions whose effective direct classification is accepted. A Realm
local rejection suppresses an accepted Global decision; absent local state can
inherit Global acceptance. Each classification read must have the same graph
epoch and sequence as the phrase relation, or the whole query returns
unavailable. The result names the Decision and whether it was Global, local or
inherited. The whole-public-corpus bound still applies before either filter.
This first implementation uses additional graph reads at a checked source
position; it does not yet satisfy the single ARQ request, rating join or broader
typed-filter acceptance below.

`public-realm-classified-rated-phrase-v1` admits one active Realm, one active
shared Sense, one standing RatingContext owned by that Realm, a literal phrase,
optional language and `minimumMeanTimes10` from 10 through 100. The integer
criterion expresses a mean to one decimal place without floating-point threshold
rounding: a score population passes exactly when `10 * sum >=
minimumMeanTimes10 * count`. The current head of each Account-principal standing
slot contributes at most one value; withdrawn slots have no value. A zero
available count does not pass any threshold. The one ARQ request binds public
text, effective Realm publication, effective direct classification and current
rating heads, and applies the criterion before returning MatchUnits. It counts
the entire public MatchUnit population (maximum 100) and all slots for the
selected RatingContext (maximum 100) before result filtering. The Lucene hit cap
is 101. A Realm-local classification Decision overrides Global; otherwise a
Global acceptance is inherited. The response reports the graph source position,
classification provenance and exact integer rating sum/count. The query audits
the selected question's whole bounded slot population for one current revision,
valid availability/value pairs and unique slots; incomplete heads return
unavailable. Unlike the separate aggregate read, this joined query does not
verify immutable object manifests. Its bounded
scope does not yet cover the broader admitted query descriptor language below.

## RDF binding and match grain

Materialize a small RDF `MatchUnit` for each exact title/name/body/chapter/chunk
value selected for search. Its metadata records Resource, immutable RevisionAnchor,
selection generation, occurrence/representation when applicable, disclosure scope,
context, source, language, field and exact selector. Units have stable identified
subjects within a generation and one coherent disclosure boundary. A unit's value
is not the whole changing Resource and cannot combine a public title with a
private body. Current searchable projection and immutable history have different
roles: historical payloads are not automatically indexed as current text.

Configure jena-text's entity map with subject identity, a unique triple identifier
for deletions, graph and language fields, the explicit indexed predicate map and
stored values if returning literals/highlights. All indexed changes pass through
the text-wrapped dataset. A direct write or bulk load into bare TDB2 requires a
rebuild before search is available.

The native result identifies indexed RDF facts; it does not supply all REZICS
metadata. The adapter joins their subject to the MatchUnit mapping. The admitted
shape below illustrates the binding positions, not an independently public endpoint:

```sparql
PREFIX text: <http://jena.apache.org/text#>
PREFIX search: <https://rezics.com/vocab/search/>

SELECT ?unit ?score ?literal ?graph ?predicate
WHERE {
  GRAPH <urn:rezics:search:public> {
    (?unit ?score ?literal ?graph ?predicate)
      text:query (search:title search:body "query terms") .
  }
}
```

The graph IRI above is selected by Main from its admitted public projection.
The initial assembler has no union default graph: an unscoped text query cannot
be assumed to search named graphs.

Bind subject, score, matched literal, source graph and matched predicate only when
the pinned jena-text release/configuration supports those outputs. The metadata
join must preserve literal language/datatype, exact field and graph identity;
never treat two equal strings in different scopes or revisions as one authorized
match. Stored literals and highlighted fragments are separate response fields;
escape rendering output and do not treat highlighted text as authoritative data.

Default jena-text integration makes one Lucene document for each indexed RDF
triple. Several predicates on one subject do **not** become a multifield document.
Cross-field conjunction uses separate `text:query` bindings joined at the declared
unit or Resource grain; consecutive predicate IRIs in the argument list mean
alternative predicates. They are not a nested RDF list. The reviewed
[TextQueryPF parser](https://github.com/apache/jena/blob/509136074c4bd8b4771c08d20da4b2821fccdf37/jena-text/src/main/java/org/apache/jena/query/text/TextQueryPF.java)
consumes consecutive URI arguments before the query literal and exposes five
output positions. This pinned source review is not release/runtime qualification.
Define score combination and multiplicity before grouping. A future custom entity
index has separate indexing, deletion, disclosure and rebuild acceptance; it is
not required for launch. These native binding/index rules are documented by
[Jena text search](https://jena.apache.org/documentation/query/text-query.html).

## Limits, ranking and continuation

| Admitted lane | Completion obligation |
| --- | --- |
| Bounded complete relation | Evaluate every eligible text/graph match within a declared admission bound, then aggregate, order and limit. |
| Graph-bound text scoring | Bind exact eligible subjects/graphs and qualify the actual operator plan before text evaluation; account for all candidate units. |
| Ranked scan with residual checks | A later capability requiring a stable reader and a continuation/completion proof; default `text:query` alone does not provide this. |
| Equivalent indexed filters | A later optimization that must preserve Resource/occurrence, context and disclosure semantics. |

The optional integer inside `text:query` caps Lucene hits **before** later SPARQL
filters. Thus retrieving 10 text hits and filtering for a Realm can miss the true
10 best Realm results. Raising that integer or repeatedly growing it is not by
itself a stable exhaustive cursor. The initial implementation accepts only bounded
complete shapes it can finish, or returns explicit budget exhaustion/partial
results where the API allows them. It cannot claim exact global Top-K from a
truncated candidate set. Omitting a text limit is also not permission to perform
unbounded work; qualify any release-specific default cap and reject populations
whose completeness cannot be established.

Order final results explicitly, with deterministic tie-breaking after the declared
score aggregation. Counts/facets cover the full specified eligible population or
report their precision/incompleteness. SPARQL `LIMIT`/`OFFSET`, a Lucene score and
the application's data fence do not retain the same snapshot across HTTP calls.
Initial pagination either materializes the complete bounded ordered result under
one admitted request into an expiring Main handle, or uses a new-query/restart
contract. Do not label ordinary offset pages snapshot-bound. Handles bind subject,
authority, context, query digest, data/index generation and expiry; delivery still
checks current disclosure. A later retained-reader/custom cursor needs its own
resource budgets and recovery design.

## Analyzer contract

Use a versioned Lucene CJK analyzer profile as the initial Chinese/mixed-script
baseline, explicitly configured in jena-text; English-oriented defaults are not
a CJK acceptance result. Lucene's [CJKAnalyzer](https://lucene.apache.org/core/10_3_1/analysis/common/org/apache/lucene/analysis/cjk/CJKAnalyzer.html)
uses normalization and CJK bigrams. That is a practical starting mechanism, not
proof of domain relevance or word segmentation quality. Pin the Jena distribution,
its compatible Lucene artifacts, analyzer class, stopwords/dictionary digests,
normalization, language routing, positions/offsets and field profile. Do not force
the documentation's example Lucene version onto another Jena dependency graph.

The local Fuseki 6.2.0 assembler now pins `cjk-bigram-v1` with the bundled
`org.apache.lucene.analysis.cjk.CJKAnalyzer` for both indexing and queries.
The scoped Account/Access/Main/Fuseki HTTP flow creates a private Chinese-tagged
mixed-script Contribution, confirms it has no public hit before selection, then
selects it in Realm B. Chinese, Japanese, Korean and `Galaxy42` phrases bind
the exact Realm B MatchUnit; the joined Realm text/classification/rating query
also binds the Chinese phrase. Main and Realm A return zero for that phrase,
and a `ja` language filter excludes the `zh` literal. A native text binding
returns its original body and language. The mixed-cut drill still passes with
this assembler. This qualifies those selected-body fixtures, not relevance,
stemming, analyzer migration or every SEARCH06 language/identifier case.

Index/query analysis must agree. Retain original text; simplified/traditional
conversion, case folding and transliteration are derived search forms, not identity
equivalence. Missing analyzer resources fail activation. Any analyzer, dictionary,
field-map or relevant format change builds a new index generation. Evaluate names,
mixed scripts, punctuation, identifiers, phrase behavior and highlight offsets;
SmartChinese, Kuromoji or Nori are later compatible-profile candidates when evidence
justifies them, with required modules pinned. No Rust tokenizer bridge is required
for the bootstrap.

## Authorization before matching

Fuseki endpoint authentication and named graphs do not implement REZICS Access
rules. Main must admit participating graph facts and text units before matching,
scoring, aggregation, snippets or suggestions. Arbitrary client SPARQL, raw Lucene
query syntax, `SERVICE`, dataset selectors and update endpoints are not exposed.
Compile typed supported descriptors, parameterize literals/IRIs and constrain graph
and field selections. See the [authorization bridge](../implementation/authorization-bridge.md).

For the initial profile, the Lucene corpus contains only eligible public units;
protected triples use nonindexed predicates/storage projections. Narrowing a public
scope first fences Main query admission and old handles, then removes affected
indexed values and verifies the new reader generation before reopening affected
search. Do not allow stale text through snippets or counts during cleanup. A future
private index requires an admitted graph/subject-bound execution path and a corpus
statistics policy; filtering privileged results only after matching is insufficient.

## Freshness and generation lifecycle

Track the authoritative application fence `{datasetId, dataEpoch, sequence}`, the
projection's applied input fence and the qualified index reader generation
separately. `dataEpoch` is an opaque random lineage identifier, not a counter;
`sequence` is a decimal string. A TDB2 receipt does not certify that a
Lucene reader includes the corresponding change, and a receipt fence cannot reopen
an old engine read transaction. Read-after-write may wait to a deadline for the
required projection/index fence or return pending/unavailable. Historical search
requires separately prepared exact historical units and current disclosure; the
head index is not historical search.

Use root-local projections plus explicit reverse dependencies for joined fields.
Selection/classification changes schedule bounded affected roots and invalidate
ineligible units first. Workers carry fencing tokens and idempotent checkpoints.
The lifecycle is `building -> catching_up -> ready -> active -> draining -> retired`.
Manifests pin source snapshots, model/projection/analyzer versions and backend
format. For launch, a controlled maintenance rebuild with search unavailable is
sufficient: stop writers, capture a consistent source, rebuild, verify, reopen.
Do not run another JVM against the live TDB2 directory. Online generation switching
is an optional later implementation, with independent paths and explicit fencing.

After a crash or restore, keep search unavailable until the index/source pairing
is verified or rebuilt. Rollback never restores erased/revoked text. Multiple
sources retain a vector of positions rather than one invented global sequence.

## Response and acceptance

Return actual data/projection/index generations, exact/partial ranking,
count/facet precision, completion reason and the continuation mode actually used.
Budgets cover candidates, joins, memory, time, bytes and fan-out; output LIMIT does
not bound those costs. [Search acceptance](../testing/search.md) must qualify
multilingual relevance, post-filter completeness, publication changes, mixed
visibility, crash/rebuild and pagination. This document defines target behavior;
no earlier Fluree benchmark validates the Jena composition.
