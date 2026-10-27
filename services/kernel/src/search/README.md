# Search

Search owns the subject search projection, indexing consumers, disclosure checks, query API, freshness and index
generations.

The optional `languages` request field is the reader's language chain, in priority order. Search follows semantic's
label choice rule for hit labels, requested descriptions and item fact labels, returning one entry per nonempty map.
Omitting `languages` keeps every language.

## Visibility, completeness and convergence

Search separates candidate discovery from current disclosure checks. Evidence from [OpenFGA, SpiceDB and
Sourcegraph](../../../../docs/research/search-visibility-witnesses.md) supports separating those stages, batching
checks, making consistency boundaries explicit and repairing derived state durably. It does not standardize Search's
resource limits: the 128 sampled values per property, one saved plus at most 32 alternative witnesses, 256 probes
per source call and at most three candidate rounds are local budgets. The [Semantic witness and dependency
design](../semantic/relation-facets-design.md) and [durable rebuild design](../semantic/relation-facet-rebuilds-design.md)
own witness selection, current evidence, invalidation routing and repair storage. Search owns candidate handling and
the integration behavior described here.

For relation predicates, `true` and `false` are definitive current results; `not_proven` is unknown, not false.
Boolean evaluation preserves that three-valued meaning through AND, OR and NOT, and only a complete current `true`
result may be disclosed. A candidate with no current proof is dropped and refilled, never returned. Candidate
discovery and current disclosure are separate guarantees: a safe check can reject stale candidates without proving
complete recall, a full page, or fresh indexed counts. In particular, bounded snapshots can underfill while repair
is pending. Absence from a nonoverflow snapshot may count as complete absence only after integration proves that the
snapshot is complete; this focused completeness proof/fix belongs to Semantic after its source task. Do not document
underfill as complete absence or broaden this into a redesign of all negative filters.

Index counts, including counts reported with `as_of`, describe indexed progress; do not call them live-authorized
exact cardinalities. Candidate supersets are not lower bounds on current matches. The existing `lower_bound` policy
for facet results is the separate policy in [Facet counts](#facet-counts); it does not introduce a count API or a
leak-protection guarantee. Keyset continuation consumes rejected and unproven candidates, including rejected
lookahead, before advancing, but does not promise an OpenSearch point-in-time snapshot. Whole-index replay and witness
repair may do work proportional to their finite input; there is no constant whole-rebuild cost or wall-clock
convergence SLA.
Finite convergence assumes writes stop, the affected identity and output sets are finite, invalidation routing is
complete, I/O eventually succeeds and durable cursors progress fairly. The real-source and default-worker
composition proof remains pending; the [outcome harness contract](../../test/search/README.md) defines the required
verification and does not claim it has passed.

## Cost

These are derivations from `src/search/`, `src/events/`, the called Access SQL, `db/search/` and the core/semantic
schema, not measurements or guaranteed PostgreSQL plans. Search owns the engine candidate and recheck contract.
Semantic owns relation-facet witness selection, current statement and fence truth, durable repair metadata, rebuild
work and its SQL cost derivation; the [semantic relation-facet design](../semantic/relation-facets-design.md) is the
authority for those details. Semantic source/worker composition and its final real-source claim remain pending.

The criterion is a bounded anchor neighbourhood per query, hit or change, with about changes × index depth work;
OpenSearch's internal query execution is an engine constant, but kernel enumeration and source reads are not.
`N` is total subjects, `P` rows in an anchor partition (including history and other consumers where relevant), `H`
outbox rows in one partition, `b` event changes in a batch, `h` candidates examined on a page, `s` requested results,
`d` page depth, `C` checkpoints for one consumer (at most 4,096), `k` rows/documents changed by an operation, and
`M` the number of activated vertical manifests in the active release together with the bundled catalogue. `F` is
facet-capable facts per indexed subject and `Q` qualifiers per fact. `ell` is the number of admitted filter leaves
(`ell <= 32`); each `IN` has at most 64 values. A relation facet has at most 128 distinct sampled values per
declared property. A source point call accepts at most 256 probes.

Write `L(x) = O(log(2+x))`: a unique B-tree probe examines constant rows and logarithmic shared blocks; a range
returning k rows costs `O(L(x)+k)` rows/index work and blocks on an indexed path. The partition map has 4,096
entries, routes map by `route >>> 4`, and checkpoint/outbox keys are `(partition_no,consumer)` and
`(partition_no,position,event_seq)` respectively.

Search uses the default 64-envelope limit; commands cap events per envelope at 1,000, hence `b <= 64,000` for
command-produced logs (the outbox DDL itself has no upper event-count check), and distinct changed subjects are at
most b. Search validates `1 <= s <= 100` (default 20); a page makes at most three rounds of
`min(200, 2 * remaining + 1)` hits, hence `h <= 600`; suggest returns at most 10 results from at most 20 candidates.
Search groups source work by anchor partition, sends no more than 256 relation probes per call, admits at most 32
leaves and 64 values per `IN`, and never scans relation degree or expands qualifier combinations per request.

Unless stated otherwise, an operation writes nothing, and rows/blocks mean kernel SQL examinations/shared blocks,
not merely returned rows; constant request counts exclude no hidden per-hit source SQL guarantee. Growth checks below
separate existing call-count assertions from SQL row/block checks; grow the total by adding unrelated subjects, then
grow the anchor partition independently while fixing its selected neighbourhood, payload sizes, consumer/generation
count and other named inputs. Test references identify coverage and verification requirements; they are not claims of
new measurements or passing tests.

Relay discovery, freshness, reconciliation and retirement use cross-partition SQL on a shared pool. Their fixed
4,096-partition cardinality does not make them executable on separately placed partition databases.

### Relay discovery

- Touches: `events/scan-partitions.sql` runs one statement per live consumer each tick (default 100 ms), reading the
  whole `core.partition` map and checkpoint `(partition_no,consumer)` probes, plus one `outbox_pkey` probe at
  `(partition_no, checkpoint + 1, 0)` for each of the `A` partitions ahead of the consumer to order them by the
  `recorded_at` of their first pending envelope, oldest first; returns at most 4,096 partitions and reads no
  subject/history. Grow N/P with C and consumer count fixed.
- Bound: Rows `O(4,096 + A)` with `A <= 4,096`; indexed blocks `O(4096*L(P) + A*L(H))`, one statement per
  consumer, independent of H/b; sort is `O(A log A)`. This is periodic global coordination, not a scan per change.
- Growth check: [test/relay-effects.test.ts](../../test/relay-effects.test.ts): “effects relay discovery stays within
  its bound as outbox history grows”.

### Outbox batch

- Touches: `projectBatch` reads one partition head by PK, generates at most 64 consecutive positions after the
  checkpoint, and reads every event at those positions through the outbox PK; no read from position zero. Grow H/N/P,
  fixing b, envelope count and selected payloads.
- Bound: `O(64+b)` rows, `O(64*L(H)+b+L(4096))` blocks, one log statement; parsing/deduplication is linear in b,
  and sorting is bounded batch data rather than history.
- Growth check: [test/growth-events.test.ts](../../test/growth-events.test.ts): “Batch log stays within its bound as
  H grows”; “Full batch log reads only the batch's outbox rows at every partition history” uses histories `[32, 256,
  2048]`.

### Checkpoint snapshot and advance

- Touches: `ensure-checkpoint.sql`, `lock-checkpoint.sql` and `compare-advance-checkpoint.sql` insert one
  `(partition_no,consumer)` row if absent, lock it with SKIP LOCKED, then compare-and-set after projection. One
  partition only; the snapshot transaction releases before source/engine calls. Grow N/P/H, fixing one consumer and b.
- Bound: Constant rows read and `k <= 1` row changed; `O(L(P))` blocks per probe/mutation. A successful nonempty
  batch uses six statements including BEGIN, ensure, lock, log read, COMMIT and CAS; busy/empty paths do less; retry
  repeats the batch.
- Growth check: [test/growth-events.test.ts](../../test/growth-events.test.ts): “Batch checkpoints stays within its
  bound as C grows” and “Batch log stays within its bound as H grows”.

### Source snapshot

- Touches: Indexing calls `SubjectSource.read(partition, ids)` at most once for up to b distinct IDs; disclosure
  reads once per candidate partition per round. The snapshot pairs the partition position with subject state, labels,
  aliases, descriptions, adopted Global descriptive statements and relation facets. Only outgoing relation
  properties declared as facets for the subject's current type contribute to the existing `statements` and nested
  `facts` fields; nonfacets and incoming edges do not. Each declared relation property contributes at most 128
  distinct visible values, with an overflow property marker when more values exist. Descriptive values keep their
  prior behavior. Relation qualifiers can remain stored data, but role/episode qualifiers are not relation-facet
  predicates; a qualified relation filter is invalid, while descriptive qualifiers keep their existing meaning.
  Semantic's visible-at-build witness pointer stays internal and is not a Search field. Semantic's source, witness,
  fence and SQL costs are owned by the linked design rather than restated here.
- Bound: Search snapshots and source calls are grouped by anchor partition; relation membership probes are capped
  at 256 per call. The relation projection is bounded by 128 distinct values per declared property, not the source's
  full relation degree; a missing value from a truncated sample never proves absence. A temporarily underfilled
  snapshot is also not evidence of complete absence. Treating nonoverflow snapshot absence as complete requires the
  integration proof described above. Semantic source and durable rebuild work still require their real-source
  verification; this README does not claim that composition or its measurements are complete.
- Growth check: Search projection coverage: [test/search/relation-overflow-mapping.test.ts](../../test/search/relation-overflow-mapping.test.ts),
  “the document keeps all 128 sampled relation values and omits empty overflow markers”. Semantic verification
  requirements (not completed measurements): [test/semantic/relation-facet-source.test.ts](../../test/semantic/relation-facet-source.test.ts),
  “a snapshot includes visible adopted outgoing relation facets but no nonfacet or incoming relations” and “a bounded
  witness probe suppresses hidden evidence and schedules finite rebuild convergence”; [test/semantic/growth-relation-facet-source.test.ts](../../test/semantic/growth-relation-facet-source.test.ts),
  “relation facet source and point probes stay bounded as relation degree grows” at `[64, 512, 4096]`, one warmup
  and three repetitions, and “relation facet witness rebuild stays bounded per durable page as degree and history
  grow” at `[64, 512, 4096]`, one warmup and three repetitions. Existing snapshot cost coverage remains
  [test/semantic/growth-search-source.test.ts](../../test/semantic/growth-search-source.test.ts): “Source snapshot
  stays within its bound as P grows” and “Source snapshot stays within its bound as a subject's history grows”,
  both at `[8, 64, 512]` with three repetitions; [test/search/indexing.test.ts](../../test/search/indexing.test.ts):
  “cost per batch is one snapshot read and one bulk request at every batch size” proves calls only.

### Document build, bulk and erasure

- Touches: `documentActions` builds one action per requested ID in its anchor partition; visible nonredirected
  subjects index into `subjects-g<generation>` by `_id`; missing, hidden, taken-down or redirected subjects delete by
  `_id`. External version is the snapshot partition position. After the subject snapshot, indexing reads public
  collection counts once for visible, nonredirected subjects it will index (one primary-key statement, at most b
  rows; no read when none will be indexed). At most one `_bulk?refresh=wait_for` request (none without relevant IDs),
  at most 2b NDJSON lines; no target traversal or SQL write. Grow N/P/H with b and subject payloads fixed.
- Bound: At most b root documents written/deleted. Each indexed subject costs 1 + F Lucene documents: the root
  plus one nested document per facet-capable statement. A relation property's contribution is at most 128 distinct
  values plus its overflow marker; repeated relation witnesses for the same pair do not multiply indexed facts.
  Bulk size still includes each fact's Q qualifiers, existing descriptive/name payloads and the subject's declared
  property set. Each indexing batch adds one listing read: one primary-key statement for at most b rows, constant in
  N stored subjects and number of Collections. There is no listing read when no documents will be indexed. Requests
  stay one snapshot read, one listing read when indexing documents, and one bulk request whatever F. No SQL writes.
  Kernel work is linear in selected fact/value bytes except sorting each subject's labels; there is no document byte
  cap, so growth checks fix payload sizes. Bulk item validation is `O(b)`; failure prevents checkpoint advance. The
  document adds an overflow property list only when needed and one integer listing-count field.
- Growth check: [test/search/indexing.test.ts](../../test/search/indexing.test.ts): “cost per batch is one snapshot
  read and one bulk request at every batch size” and “a later takedown deletes the document and replays are harmless”;
  [test/search/relation-overflow-mapping.test.ts](../../test/search/relation-overflow-mapping.test.ts): “relation
  markers stay on the source subject document and keep external versions” and “the document keeps all 128 sampled
  relation values and omits empty overflow markers”.

### Listing counts

- Touches: `subjectListingSource(pool).read(partition, ids)` runs `listing-counts.sql` once, selecting `subject_id,
  public_collection_count` from `library.subject_listing` by primary key `(route, subject_id)` for the ids in that
  partition. An id without a row is absent. Grow N and the number of Collections, fixing b.
- Bound: One statement per call: primary-key lookups of at most b rows, constant in N stored subjects and in the
  number of Collections. The document gains one integer field, `public_collection_count`, and no field per
  Collection.
- Growth check: [test/search/listing-source.test.ts](../../test/search/listing-source.test.ts): “the production
  listing source reads counts in the subject's partition”.

### HTTP authorization

- Touches: Search adds one `subject:read` check on the Global Context per request.
- Bound: One `subject:read` check on the Global Context per request. Its rows, blocks and statements are the Access
  bound in [src/access/README.md, Cost](../access/README.md#cost). Search adds no further authorization SQL and
  inherits Access's uncapped Global grant/denial and organization-membership neighbourhoods.
- Growth check: [test/access/growth-permission.test.ts](../../test/access/growth-permission.test.ts): “Permission
  preparation stays within its bound as O grows”; [test/access/growth-evaluator.test.ts](../../test/access/growth-evaluator.test.ts):
  “evaluator rows/statements are constant in G and blocks logarithmic at fixed K” and “evaluator rows/statements/blocks
  are at most linear in admitted K through cap1000 at fixed G”.

### Search planning and engine page

- Touches: Route validation, `text.ts`, `filter.ts`, `query.ts` and `subjects-search-v2` compile named clauses; one
  alias `_search/template` request per round, at most three per page. Index fields are `search_text`, `names.exact`,
  `names`, keyword type/statements and nested `facts`; sort is score then id (relevance), `name_sort` then id (name),
  id, or `public_collection_count` descending with missing as 0, then `name_sort` and id (collections). `_source`
  selects partition/security revision; totals track to 10,000. Relation positive and negative overflow clauses are
  compiled as safe candidate supersets. A named outer clause keeps exact-value and marker-only matches in the same
  matched-query lineage. Grow N/P/d, fixing s, query and current hits.
- Bound: A filtered request adds one active-release lookup (pointer read; release cached by digest); no lookup
  without a filter. Admission is linear in expanded leaves (`ell <= 32`) times the returnable types' bases; the
  all-types facet union is computed once per release. `O(h)` hit mapping, at most 600 hit documents, and at most
  three engine searches. Valid text is <= 512 bytes/64 leaves/depth 4; filters <= 32 leaves/depth 4, OR <= 16,
  `IN` <= 64 (bounded scalar sizes). Parsing rejected raw input still depends on input length. Nested leaves touch
  candidate subjects' facts only. Text syntax errors remain typed 422 errors. Qualified relation facets return 400
  `invalid_request` at the filter qualifier pointer; descriptive qualifiers retain their existing meaning. Code
  facets cost what item facets cost, minus value-subject reads. `descriptions` and `languages` project from the
  subject the final check already holds (no read; per hit, work linear in that subject's labels and descriptions,
  each description cut to 200 grapheme clusters).
- Growth check: [test/search/filter-overflow.test.ts](../../test/search/filter-overflow.test.ts): “overflow candidate
  queries retain true positive and negated matches beyond the sampled prefix” and “overflow candidate queries
  preserve boolean grouping and same-statement qualifiers”; [test/search/relation-qualifier-admission.test.ts](../../test/search/relation-qualifier-admission.test.ts):
  “qualified relation facet filters are 400 invalid_request without reaching the engine” and “unqualified relation
  facets and descriptive qualifiers retain their semantics”; [test/search/service.test.ts](../../test/search/service.test.ts):
  “each request makes at most three index requests and reads only the partitions of examined hits”; [test/search/overflow-service.test.ts](../../test/search/overflow-service.test.ts):
  “overflow service work stays bounded at stored degrees 128, 512 and 2048”.

### Search hit facts

- Touches: The hit subjects the final check already returned (no new read for them); the request's single
  active-release lookup, shared with filter admission; and item targets of the page's kept values: at most
  `s × P × 3` distinct ids (`s <= 100`, `P <= 4` requested properties, at most 1,200 ids). `discloseFacetValues`
  reads them once, one `subjectSource.read` per target partition with concurrency <= 8. No target read when no kept
  value is an item.
- Bound: Rows and statements are constant in N and P (partition rows) at fixed s and property count. Each source
  read has the Source snapshot bound at fixed ids; blocks are logarithmic. Per hit, one scan of its statements.
- Growth check: [test/search/growth-facets.test.ts](../../test/search/growth-facets.test.ts): “Search hit facts stay
  within their bound as N grows” at scale units `[1, 4, 16]`.

### Facet counts

- Touches: One active release lookup and one stored-template OpenSearch query; each of at most 8 facets samples
  matching subjects (`facetSample`, default 10,000), traverses their facts and asks for at most 40 terms for a
  requested size <= 20; the API returns at most the requested size. Item values are read back through the source;
  code values are not subjects. Type facets aggregate the keyword `type` inside the same bounded sample and ask for
  at most 40 buckets.
- Bound: The request has one engine aggregation. Item facets read at most 8 × 40 = 320 distinct value subjects;
  only visible, nonredirected anchors are returned. Code facets cost what item facets cost, minus value-subject
  reads; their values carry empty labels and are not read as subjects. `reverse_nested` counts subjects. When a
  filter can match overflow-marked relation candidates, the aggregation excludes every candidate carrying an
  overflow marker for any relation property in that filter and counts only the remaining definite contribution.
  Raw candidate-superset totals are not a lower bound after false positives. The total relation is `lower_bound`
  (“at least”) when filter candidates remain unresolved or the total exceeds the sample. Each facet relation is
  `lower_bound` when the total is lower-bound or that facet has overflow; otherwise it is exact. Per-facet overflow
  is checked outside the sampler, so an omitted
  sampled value cannot make a truncated facet look complete. Counts converge as source rebuilds update the sample
  and overflow marker. Rows and statements per request are constant in N and H; enumeration never grows beyond
  the sample.
- Growth check: [test/search/overflow-counts.test.ts](../../test/search/overflow-counts.test.ts): “facet counts with
  truncation are honest lower bounds and exclude unresolved filter candidates”; [test/search/overflow-service.test.ts](../../test/search/overflow-service.test.ts):
  “overflow facets exclude unresolved filter candidates and keep at-least counts” and “overflow service work stays
  bounded at stored degrees 128, 512 and 2048”; [test/search/growth-facets.test.ts](../../test/search/growth-facets.test.ts):
  “Facet counts stays within its bound as N grows” and “type facet stays within its bound as subjects grow”, both at
  scale units `[1, 4, 16]`.

### Disclosure and result projection

- Touches: `checkHits` rejects invalid anchors without reads, groups/deduplicates IDs by UUID partition, and reads
  each group once per round with concurrency <= 8. It checks current visibility, redirect, security revision and
  the complete filter truth. Every positive relation leaf gets a live unqualified point check even when its value
  is in the sampled prefix; a negative relation leaf gets the same check when its property overflows. Search sends
  anchor-partition batches of at most 256 probes and performs no relation-degree scan or qualifier Cartesian
  expansion. Semantic checks the stored witness and at most 32 further witnesses; if bounded evidence cannot prove
  membership, it returns `not_proven` and enqueues the registered
  `com.rezics.subject.relation_facet_changed.v1` event for the affected SOURCE. The adopted Semantic contract checks
  one saved witness and at most 32 alternatives, then rebuilds durable finite witness pages. Existing `subject.*`
  indexing consumes that source-partition event with external partition versions and
  `refresh=wait_for` checkpoint advancement. Search does not enqueue a second repair or rebuild the target's inbound
  neighborhood. Semantic owns current witness/fence truth and event/rebuild SQL details; see the linked design.
- Bound: A candidate page checks at most 200 hits per round and at most three rounds; any partition point call has
  at most 256 probes and concurrency is bounded. The source port returns aligned `true`, `false` or `not_proven`
  results. `true` and `false` are definitive; `not_proven` remains unknown
  through AND, OR and NOT, is dropped/refilled, and is never coerced to false or returned as a 503 merely because
  bounded evidence is uncertain. Only proven complete Boolean truth is disclosed. Search totals use only proved hits
  as a `lower_bound` when overflow or live rejection makes raw candidate totals unsafe; totals converge as the source
  rebuild updates the index. Actual I/O failures or malformed proof results remain retryable unavailable; a failed
  proof fails the whole response without a successful partial page. Per-hit result projection reads no new subject;
  labels/descriptions come from the checked snapshot.
- Growth check: [test/search/live-relation-facets.test.ts](../../test/search/live-relation-facets.test.ts): “positive
  relation matches are checked live even within the sampled prefix”, “AND OR nested NOT and shared positive and
  negative leaves use complete live Boolean evaluation”, and “fixed page and filter have constant read and point
  work at degrees 128 512 and 2048”; [test/search/not-proven-rechecks.test.ts](../../test/search/not-proven-rechecks.test.ts):
  “not-proven relation points are dropped and refilled without becoming negative matches”, “not-proven points
  preserve three-valued filter truth and keyset continuation”, “not-proven search work stays constant at stored
  degrees 128 512 and 2048” and “uncertain point batches retain the existing 256 bound and deduplicate shared
  leaves”. Semantic verification requirements (not completed measurements): [test/semantic/relation-facet-source.test.ts](../../test/semantic/relation-facet-source.test.ts),
  “relation facet point probe I/O failure remains typed unavailable” and “a bounded witness probe suppresses hidden
  evidence and schedules finite rebuild convergence”; [test/semantic/growth-relation-facet-source.test.ts](../../test/semantic/growth-relation-facet-source.test.ts),
  the source/probe and durable-page tests at `[64, 512, 4096]`, one warmup and three repetitions.

### Cursor and continuation

- Touches: Signed cursor binds canonical request hash, principal, operation, generation and last consumed sort values
  (<= 8). Each round/page sends `search_after`; no OFFSET, preceding-page enumeration or database cursor. A changed
  generation/expired token requires restart. Grow d/N with s, query, key ring and current hit payloads fixed.
- Bound: Constant SQL rows/blocks/statements (zero); constant sort tuple and bounded request hashing, independent
  of d; `O(h)` current-page consumption. No kernel `O(d*s)` read from the start. Dropped or unproven candidates are
  consumed before the next keyset continuation, so refill does not repeat them.
- Growth check: [test/search/service.test.ts](../../test/search/service.test.ts): “pages continue through signed tokens
  bound to the request and the principal” and “each request makes at most three index requests and reads only the
  partitions of examined hits”.

### Suggest

- Touches: GET validates 1–64 code points (<= 128 UTF-16 units), limit 1–10 (default 8); `subjects-suggest-v1`
  queries `names.typeahead` and its 2/3-gram fields in one alias template request. Reads <= 20 hits, then the same
  partition-grouped disclosure, projection, generation and freshness paths. Grow N/P with limit, text and selected
  facts fixed.
- Bound: One engine search, `h <= 20`, <= 20 source reads with concurrency <= 8; no own SQL. Each source read is
  one `subjectSource.read` with the Source snapshot bound, so rows and statements stay constant and blocks stay
  logarithmic at fixed ids. Not a separate per-hit authorization query.
- Growth check: [test/search/service.test.ts](../../test/search/service.test.ts): “typeahead suggests only subjects
  that pass the final check”; [test/search/disclosure.test.ts](../../test/search/disclosure.test.ts): “partitions are
  read once each with bounded concurrency”; [test/semantic/growth-search-source.test.ts](../../test/semantic/growth-search-source.test.ts):
  “Source snapshot stays within its bound as P grows” and “Source snapshot stays within its bound as a subject's
  history grows”.

### Freshness

- Touches: `freshness.sql` left-joins all partition heads to one consumer's checkpoints; each behind partition
  probes exactly `(partition_no,checkpoint+1,event_seq=0)` in outbox for its timestamp, then aggregates min/count.
  One statement per read; each `current()` call is answered from a read that began after the call, at most one read
  runs per reader and calls made while it runs share the next read. Rebuild polls default 500 ms until caught
  up/deadline (default 1 hour). Grow H/N/P with C and lagging partitions fixed.
- Bound: Constant 4,096 heads plus <= C checkpoints and <= 4,096 timestamp rows; indexed blocks
  `O(4096*(L(P)+L(H)))`, one statement, no H scan. The consumer-leading checkpoint index keeps the checkpoint
  lookup bounded. Behind without a retained next envelope fails. Statements per
  process and generation are at most `min(request rate, 1 / statement time)`. Polling repeats per interval, not per
  change.
- Growth check: [test/search/freshness.test.ts](../../test/search/freshness.test.ts): “the reader answers each call
  from a read that began after the call”; SQL: [test/search/growth-query.test.ts](../../test/search/growth-query.test.ts):
  “Freshness stays within its bound as H grows” (rows/blocks, also P/N).

### Generation discovery and bootstrap

- Touches: Runner resolves `subjects*` at startup and by default every 5 s, reads active mapping activation time,
  and restarts partition relays when the live generation set changes. Empty deployment: PUT index, PUT mapping, POST
  alias. Service resolves generation only for empty hits, cached/coalesced 1 s. Grow N/P with generation set fixed.
- Bound: One resolve plus <= 1 mapping read per discovery; bootstrap adds three requests; zero SQL except
  separately listed retirement. At most three generations per prefix, so discovery enumerates at most three; no
  subject-document enumeration. Definition uses one shard/zero replicas; that does not prove kernel locality.
- Growth check: [test/search/indexing.test.ts](../../test/search/indexing.test.ts): “the runner creates the first
  generation, feeds every generation and follows pause and new generations”; no new SQL check for metadata-only
  requests.

### Rebuild replay and activation

- Touches: Explicit `rebuildSubjects` invocation creates/resumes a generation, refreshes runner, replays outbox from
  zero checkpoints using the batch paths, polls freshness, reconciles, then PUTs activation mapping and atomically
  switches alias with one POST. Existing live generations also receive each change. Mapping changes, including the
  fixed overflow field, reach a running deployment through replay/reconcile into a new generation and alias switch.
  Grow H/N, fixing batch size and generation count.
- Bound: Whole-index maintenance: `O(H)` replayed event rows per partition over the run, `O(ceil(H/b))` batches
  for fixed batch occupancy plus their indexed probes; not `O(1)` per rebuild. Two activation requests, zero
  activation SQL. At most three generations per prefix, so the runner feeds at most three; rebuild exclusion uses a
  PostgreSQL session advisory lock keyed by alias, with two lock statements on one held connection; alias switching
  is delegated to OpenSearch and is constant-size.
- Growth check: Batch calls: [test/search/indexing.test.ts](../../test/search/indexing.test.ts): “cost per batch is
  one snapshot read and one bulk request at every batch size”; SQL replay: [test/growth-events.test.ts](../../test/growth-events.test.ts):
  “Batch log stays within its bound as H grows” and “Full batch log reads only the batch's outbox rows at every
  partition history”.

### Reconcile

- Touches: Per explicit rebuild, default <= 5 rounds: `reconcile.sql` twice reads all heads/checkpoints, then
  `source.count(partition)` for every nonempty partition (<= 4,096, concurrency 8), plus a count for any newly
  nonempty partition after the first snapshot. One generation `_search` with size 0 and partition terms aggregation
  size 4,096. Grow N/P/H, fixing round count and nonempty partition set.
- Bound: Two SQL statements: `O(4096)` rows, indexed `O(4096*L(P))` blocks; one engine aggregation; <= 4,096
  source count calls per round. Each `subjectSource.count` reads one `core.partition` position and one
  `semantic.partition_subjects` row by primary key: constant rows and statements, logarithmic blocks, independent
  of N and subjects in the partition. Whole-index operation, never per change.
- Growth check: [test/search/generations.test.ts](../../test/search/generations.test.ts): “each reconciliation round
  reads every non-empty partition count once and makes one index aggregation” proves stable-partition calls;
  [test/search/growth-indexing.test.ts](../../test/search/growth-indexing.test.ts): “Reconcile stays within its bound
  as P grows” (heads and checkpoints); [test/semantic/growth-search-source.test.ts](../../test/semantic/growth-search-source.test.ts):
  “Source count stays within its bound as P grows”.

### Retire

- Touches: Each discovery after default 15-minute activation grace deletes each old generation by index name, then
  `retire.sql` selects <= 4,096 checkpoints by consumer and deletes matching PKs; failures retry at later discovery.
  Newer generations/no activation timestamp remain. Grow unrelated N/P and other consumers, fixing retired consumer
  and `k <= C` checkpoint rows.
- Bound: One engine DELETE and one SQL statement per generation; k rows deleted with `O(k*L(P))` indexed mutation
  blocks. The consumer-leading index examines the retired consumer's k checkpoints in `O(k + L(C))` rows and
  blocks. Engine index deletion is whole-generation erasure, not per-hit work.
- Growth check: [test/search/retire.test.ts](../../test/search/retire.test.ts): “an older generation is retired
  after the grace period with its checkpoints, and the active one keeps indexing”; [test/search/growth-indexing.test.ts](../../test/search/growth-indexing.test.ts):
  “Retire stays within its bound as P grows” (unrelated consumers' checkpoint rows, selected k fixed).

### Search and facet counts across manifests

- Touches: `search` and `facets` each call `activeRelease`: one backward probe of `definition_activation_pkey` for
  route 0. The process cache is keyed by digest and stores the validated, frozen body, so a hit does not read
  `semantic.definition_release`. Admission uses the filter's type and that type's facets and bases. The all-types
  facet union is computed once per release object, not once per request. This shape sends one
  `subjects-search-v2` request and one `subjects-facets-v1` request; the immutable
  [subjects-search-v1 template](../../db/search/templates/subjects-search-v1.json) remains available. Item values are
  read back through the source port. Freshness is one coalesced read per request. Grow M; fix the filter, facet list
  (at most 8), sample and hit neighbourhood. A changed digest reads the release body once, absorbed by the
  unmeasured warm-up.
- Bound: Rows, statements and engine requests are constant in M. Blocks follow the activation pointer and are
  logarithmic in activation history. Release-sized work happens once per digest per process.
- Growth check: [test/search/expansion.test.ts](../../test/search/expansion.test.ts): “filtered search and facet
  counts stay within budget at 1, 10 and 100 vertical manifests”.

### Subject mapping across manifests

- Touches: [subjects.json](../../db/search/indices/subjects.json) is a strict mapping with fixed fields (`type`,
  `statements`, nested `facts`, and one `relation_facet_overflow` keyword field). Indexing any vertical writes those
  shared fields. There is no mapping field per relation property; sampled values use the existing statement/fact
  fields. Activating manifests does not change the mapping. Mapping changes still use replay/reconcile/new-generation
  alias switch.
- Bound: Mapping field count is constant in M; relation sample contribution is at most 128 distinct values per
  declared relation property plus the one fixed marker field.
- Growth check: [test/search/expansion.test.ts](../../test/search/expansion.test.ts): “indexing every vertical adds
  no mapping field”; [test/search/relation-overflow-mapping.test.ts](../../test/search/relation-overflow-mapping.test.ts):
  “overflow markers are fixed keyword fields and declared relation values retain statement and qualifier matching”.

### Hit label choice

Search hits, item facts, facet values and suggestions use the same label choice.

- Touches: the labels, descriptions and `schema:inLanguage` fact of subjects the final check already holds.
- Bound: no read, statement or engine request added; per returned subject, work linear in R ranges (at most 8) times its labels and descriptions.
- Growth check: none; no read changes. `test/search/facet-counts.test.ts`: "facet value labels follow the reader's language chain" and `test/search/service.test.ts`: "typeahead labels follow the reader's language chain" prove the choice.
