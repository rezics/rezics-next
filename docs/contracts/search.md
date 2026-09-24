# Full-text as a graph-query operator

## Required semantics and bootstrap

Main compiles admitted REZICS query descriptors to SPARQL 1.1 with ARQ's
`text:query` property function. Fuseki executes the graph/text joins over a TDB2
dataset wrapped by jena-text and its local Lucene index. Main uses TypeScript/Bun and
calls Fuseki through HTTP; one Fuseki JVM owns the dataset and index. Lucene is a library in that
JVM, not a separately deployed search service. [Storage binding](../storage/jena.md)
owns the topology and write protocol.

The adopted startup pair is PostgreSQL + Jena. PostgreSQL owns bodies and their
revisions; Jena holds the searchable representation and relationships locally.
OpenSearch and PostgreSQL text extensions are not startup dependencies. The
installed bounded lanes below describe existing evidence, not launch capacity.

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
selection. The readiness gate qualifies the complete RDF/index membership at a
graph epoch, sequence, text generation, Fuseki JVM instance ID and native
public-search write epoch. It retains one process-local proof while that write
epoch is stable and even. Metadata commands can advance the graph sequence
without changing public MatchUnit membership; public-search writes invalidate
the proof. A changed JVM or text generation also requires another audit. Phrase
queries join a predicate-specific jena-text match with effective selection in
one TDB2 read snapshot. The audit admits at most 20,000 public units across all
contexts. A phrase inspects at most 513 raw Lucene hits **before** context,
current-selection and language filters. Finding the 513th returns a typed budget
error even if later filters would yield zero. At most 512 raw candidates can
produce a complete relation within the 1 MiB Fuseki response budget. A Realm
with no local choice uses its Main Version default; a local
choice shadows that default in the requested Realm. An explicit local rejection
also shadows the default and contributes no text hit. These lanes do not qualify
broader typed filters or private full-text required below.

The installed runtime text gate also powers a distinct readiness endpoint,
`GET /health/search-ready`. A successful response names the graph `dataEpoch`,
`sequence` and text index generation. The first request for a public-search write epoch
checks all MatchUnits against the index's exact `rv:searchBody` literal, subject
and named graph. Later requests at that write epoch reuse the qualification while
checking the bootstrap's index profile, generation, public graph anchor and
indexed Chinese probe. The phrase relation must return the same epoch, sequence
and generation as the gate read. Health must show the same JVM and even native
write epoch before and after the audit and phrase. A missing or inconsistent index returns
`503 search_index_unavailable`; a public RDF or index population above 20,000
returns `422 query_budget_exceeded`. `/health/ready` continues to report graph
readiness separately. A Fuseki restart invalidates the qualification. A graph
sequence change caused by metadata alone does not repeat the corpus audit;
public-search writes still do. The Content inventory has a separate exact graph
sequence, Content-source, JVM and native write-epoch key because
publication/eligibility heads can change before public MatchUnits. It may still
repeat a corpus audit under Content
metadata writes. Existing datasets without the bootstrap marker
remain text unavailable until a qualified rebuild and generation activation.

The installed query plan has numeric request ceilings. Only a proven movement of
the anchored graph position, Content source, or native public-search write epoch
is retried. Missing index facts, a missing anchor, corrupt membership and a
stalled Content projection fail with their existing typed outcomes. At most three
complete read attempts share one 1,500 ms wall deadline, with 75 ms then 250 ms
waits after proven movement. When native health still reports an active public
index writer, a retry waits in 75 ms health polls within the same deadline and
call budget. A Main, Realm or joined phrase uses at most seven Fuseki requests
at a cold graph position and six at a
qualified position: admission, two JVM health reads, control, optional index
audit, phrase relation and a final JVM health read. Classified phrases add one
scope read, at most one batched decision read and one final three-request
readiness check: at most 12 Fuseki requests cold or 11 warm. Content phrase adds
one profile health read, one graph admission read, at most one cached Content
inventory audit, and six PostgreSQL owner/cursor reads: at most 16 remote
attempts cold or 14 warm. Movement checks can add health or anchored-control
reads. Three full attempts plus bounded writer-health polls admit at most
**72 Fuseki calls** and **18 PostgreSQL owner/cursor reads** (3 × 6), or 90
remote attempts total. The Fuseki client enforces the 72-call ceiling and
**8 MiB of total Fuseki response bytes** across all attempts. Each
phrase or Content-inventory response has a 1 MiB cap and each
readiness or command-health response a 64 KiB cap. Exhausting a call or byte
budget returns typed `422 query_budget_exceeded`; exhausting the wall deadline
returns `503 search_index_unavailable`. Graph position and native health are
checked again after phrase evaluation. These are ceilings for the installed code
path, not measured 10,000-Work latency. PostgreSQL returns only fixed owner and
cursor position rows here; their bytes and final HTTP serialization are outside
the Fuseki counter. An explicit aggregate cross-store/output byte budget and
the 10,000-Work mixed-write latency qualification remain open.

The deployed Fuseki profile exposes the query and private command endpoints,
not a general update endpoint. The ordinary isolated QA profile exposes a
text-wrapped `/rezics/update` for fixture setup. A separate persistent QA
`--raw-update` assembler adds `/raw-rezics/update` against the same bare TDB2
resource. That alias bypasses both jena-text and the native write epoch; its
fault-injection test first quarantines public search. It must not run alongside
a cached search certification. An operator performing an offline import must
quarantine search and complete the controlled rebuild before reopening it.
Restarting Fuseki changes the JVM instance ID and forces a fresh audit, but the
instance ID alone does not prove that an offline import followed the rebuild
protocol. An import that bypassed the wrapper in the same live JVM would defeat
a cached write-epoch proof; SEARCH17 still needs its explicit import/rebuild drill.

The first `public-main-classified-phrase-v1` and
`public-realm-classified-phrase-v1` lanes add one active shared Sense to those
bounded phrase queries. They complete the public text relation first, then keep
only Main Versions whose effective direct classification is accepted. A Realm
local rejection suppresses an accepted Global decision; absent local state can
inherit Global acceptance. Each classification read must have the same graph
epoch and sequence as the phrase relation, or the whole query returns
unavailable. The result names the Decision and whether it was Global, local or
inherited. The phrase bound applies before either filter, and classification
decisions for at most 256 distinct Main Versions are read in one batch. Malformed
or ambiguous decision heads make the query unavailable. This implementation uses additional graph reads at a checked source
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
the raw phrase candidates (maximum 512) and all slots for the selected
RatingContext (maximum 100) before result filtering. The Lucene hit probe is
513. A Realm-local classification Decision overrides Global; otherwise a
Global acceptance is inherited. The response reports the graph source position,
classification provenance and exact integer rating sum/count. The query audits
the selected question's whole bounded slot population for one current revision,
valid availability/value pairs and unique slots; incomplete heads return
unavailable. Unlike the separate aggregate read, this joined query does not
verify immutable object manifests. Its bounded
scope does not yet cover the broader admitted query descriptor language below.

## PostgreSQL body projection

For the initial implementation, reuse jena-text's maintained RDF-literal binding:
extract versioned plain text from exact PostgreSQL Content revisions and write
derived MatchUnits through the Fuseki command/text wrapper. Keep structured JSON,
drafts and authoritative Content history in PostgreSQL. The resulting RDF text
copy and Lucene index are rebuildable; their storage amplification, extraction
cost and TDB2 writer occupancy are explicit qualification costs.

Jena also supports externally indexed content without storing its text as RDF.
That is a later alternative binding, not an automatic PostgreSQL connector or a
reason to open Lucene files from a second process. Adopting it requires an owned
ingestion/deletion protocol and a rebuild path using PostgreSQL plus semantic
metadata; `jena.textindexer` alone only scans RDF. The first binding avoids that
extra index-maintenance implementation. [Jena external content](https://jena.apache.org/documentation/query/text-query.html#external-content).

The projection worker consumes both Content and semantic outboxes. Events name
owner epoch/position, operation, exact revision and projection recipe; consumers
deduplicate events and reject obsolete expected publication generations. Fetch
source bodies in bounded item/byte batches, not per-hit at search time. Extract
outside the TDB2 writer; guarded projection commands check the publication,
disclosure and erasure dependencies before activation. No SQL/network call runs
inside a graph write transaction. A received event is not proof of index readiness.

One unit identifies an exact revision, language variant, field/selector and
bounded chunk within its disclosure domain. Reuse it across Realm selections
when allowed; join sparse selection/reject records in SPARQL. Do not create a
copy for every Resource/Realm pair, duplicate private text into a public unit or
inflate scores by counting the same text once per matching relationship.
Predicate labels and other semantic text use the same language/field conventions.

Publication may commit before search catches up. Activation records the verified
text generation and exact dependencies. Search must use a coherent declared
publication view: a newly selected revision whose units are missing is pending
or unavailable, not absence, fallback to another body or a complete empty result.
Serving an older view requires an explicitly supported complete generation and
current disclosure checks; a sequence label on overwritten data cannot supply it.
Multi-batch staging remains fenced until all required units are verified.
The existing per-request inventory scan is a bounded prototype; the launch
readiness mechanism must not scan the entire corpus on every request.

The admitted data path is one graph/text request completing relation/Realm/rating
eligibility, Resource grouping, ranking and pagination. Fetch requested exact
body revisions afterward in at most one bounded PostgreSQL batch. Cards can be
served from the query result alone. Authentication, Access, readiness, cursor and
retry calls are additional parts of the same fixed whole-request budget.
No body availability check or residual filter may trigger candidate refilling;
unavailable dependencies follow the response's declared availability contract.

Rebuild extracted units from retained PostgreSQL revisions and approved semantic
publication references; then rebuild Lucene from the resulting RDF using the
pinned recipe. Reconcile erasure and disclosure before either step. Do not index
all Content history merely because it exists. SEARCH01, SEARCH07–08,
SEARCH15–20 and the Content recovery cases qualify this target binding.
The isolated SEARCH20 drill now takes a new source cut after an admitted Content
replacement and public eligibility decision, resumes a quarantined rebuild,
and checks that only the new exact revision is searchable. Its old revision is
still retained; the drill verifies that the old MatchUnit and public body do
not return. A separate missing-byte drill proves that erased source bytes stop
replay under quarantine. A product command for physical erasure or withdrawal
has not been implemented, so lifecycle-wide erasure reconciliation remains a
distinct acceptance frontier.

## RDF binding and match grain

Materialize a small RDF `MatchUnit` for each exact title/name/body/chapter/chunk
value selected for search. Its metadata records Resource, immutable RevisionAnchor,
language variant, extraction generation, occurrence/representation when applicable,
disclosure scope, source, language, field and exact selector. Context and selection
resolve through publication records, rather than requiring one body copy per
Realm. Units have stable identified
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

Every interactive search profile follows the
[fixed round-trip policy](../storage/workload-budgets.md#fixed-bounds-for-interactive-requests).
Its whole request plan has numeric request, stage, byte and work ceilings,
including authorization, readiness and cursor setup. A final page limit does not
bound candidates inspected or remote calls. Unbounded candidate refilling is
not an admitted search strategy, even if it eventually produces a correct page.
The existing bootstrap's corpus bounds are not proof of a production-scale plan.

| Admitted lane | Completion obligation |
| --- | --- |
| Bounded complete relation | Evaluate every eligible text/graph match within a declared admission bound, then aggregate, order and limit. |
| Graph-bound text scoring | Bind exact eligible subjects/graphs and qualify the actual operator plan before text evaluation; account for all candidate units. |
| Ranked scan with residual checks | No open-ended synchronous cross-store scan. A future interactive variant needs fixed maximum calls/work as well as a stable reader and completion proof; otherwise use explicit asynchronous materialization. Default `text:query` alone provides neither guarantee. |
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
stemming or every SEARCH06 language/identifier case. An
[isolated offline rebuild](../../tests/recovery/evidence/2026-09-24-cjk-rebuild.json)
also carries a StandardAnalyzer index to an empty CJK replacement with the
documented indexer and verifies current and deleted text. Main's runtime
generation/readiness gate remains pending.

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

The current Content phrase lane indexes public eligible body revisions only. A
Content draft remains in PostgreSQL and its text never becomes a public MatchUnit
until an exact publication and eligibility decision is projected. The Work title
is public RDF metadata, but title text is not yet indexed by this body phrase
lane. Its response exposes result identity, score, count and population; it does
not expose snippets or facets. The SEARCH03 native fixture compares those
observable values before and after a retained private draft, checks the raw
public jena-text graph for the private term, and repeats the public query after
a different body is published. Title search and future snippet/facet surfaces
need their own disclosure qualification when introduced.

## Freshness and generation lifecycle

Track each authoritative owner position, the graph fence `{datasetId, dataEpoch, sequence}`, the
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
