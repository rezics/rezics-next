# Search

Search owns the subject search projection, indexing consumers, disclosure checks, query API, freshness and index
generations.

The optional `languages` request field is the reader's language chain, in priority order. Search follows semantic's
label choice rule for hit labels, requested descriptions and item fact labels, returning one entry per nonempty map.
Omitting `languages` keeps every language.

## Deletion lifecycle

[Deletion](../../../../docs/deletion.md) governs user-owned data; [first public scope](../../../../docs/scope.md)
includes Search, facets and discovery. Search is a disposable public subject projection, never a second authority
for personal or private state. [Semantic](../semantic/README.md) owns subject/contribution truth,
[Content](../content/README.md) owns content and moderation, and [Accounts](../access/README.md) owns account erasure.
Those source owners enforce soft deletion, the 30-day restore window, legal holds and least-data purge, including
private-data removal and retained public-contribution de-identification. A hold preserves source evidence, not public
disclosure. Search neither starts a second restore clock nor preserves hidden data as evidence.

Search stores distinct record classes:

- OpenSearch subject documents copy public names, descriptions, fact values, security revisions and public Collection
  counts. They are replaceable projections, not user-owned source records or restoration backups.
- Each generation has a physical index, alias/mapping metadata and a relay consumer. Its PostgreSQL
  `core.consumer_checkpoint` rows contain partition progress, not source bodies. Active and rebuilding generations
  keep their checkpoints; retirement deletes an old generation’s index, then its checkpoints as described below.
- Versioned stored query templates are platform query configuration installed by `query.ts`, not saved user queries.
  Released template IDs/source remain immutable; installation does not expire older scripts. There is no template
  cleanup job or user delete/purge route. This retention differs from generation retirement.

`disclosure/check.ts` rejects missing, hidden, redirected or security-revision-mismatched candidates and evaluates
current filter evidence before returning hits; hit data is projected from the current source snapshot. Suggestions
and item facet labels also use current source checks. This suppresses stale results while relay repair catches up,
subject to the pending real-source/composition proof in [Visibility, completeness and convergence](#visibility-completeness-and-convergence).
It does **not** establish immediate count privacy: general search totals and facet bucket counts can still include
stale source subjects despite current hit/value checks. This is a known gap pending policy alignment with
[Deletion](../../../../docs/deletion.md), whose immediate suppression requirement remains authoritative. The existing
relation-facet lower-bound behavior does not resolve general totals or bucket counts.

Source delete, takedown and restore must publish the source changes consumed by `indexer.ts`. The relay re-reads
current state rather than replaying old bodies: a missing/hidden/redirected subject produces an engine delete, and a
visible subject produces a replacement document. Source restore advances the source partition position; the new
snapshot position becomes the external version for reindexing in every live generation, so earlier writes cannot
win over that newer version. Search does not restore documents independently of source eligibility. Complete
invalidation and default-worker convergence remain pending proof under the [outcome harness contract](../../test/search/README.md).

Physical cleanup uses existing operations only; there is no separate Search 30-day personal-data purge job:

- Per-subject bulk delete/replacement is bounded by the deduplicated affected IDs in one default 64-envelope batch
  (`b <= 64,000` for command-produced logs), one action per ID per live generation. See [Document build, bulk and erasure](#document-build-bulk-and-erasure)
  and [Outbox batch](#outbox-batch); this is asynchronous projection repair, not a source purge deadline or a promise
  about immediate reclamation of engine storage.
- Discovery defaults to every five seconds. Older generations remain live for the default 15-minute grace measured
  from the active generation's activation timestamp, then retirement issues one whole-index DELETE and one SQL
  deletion of at most 4,096 checkpoint rows per generation. Engine work scales with that index's stored data; SQL
  work is the [Retire](#retire) bound, not constant whole-index erasure. Failures retry on later discovery; absent
  activation timestamps and newer unfinished generations are retained. Rebuild admission caps generations at three;
  it does not impose an expiry on an active or unfinished generation.

These lifecycle rules add no operation and preserve the Cost bounds below.

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

## Scope source

`scope-source.ts` exports the additive `createSearchScopeSource` admission scaffold. Public Search and
`SubjectSource` remain unchanged. This is a contract and honest unavailable stub, not production prefix,
identity or leaf execution. Preparation parses, expands and admits the filter, requires a positive anchor and
calls the existing `compileFilter` once, then currently throws retryable `semantic_not_ready`. No prepared handle
or positive capability is minted. Valid native requests are not specified to remain unavailable forever.

The factory takes `{pool: Pool, client: OpenSearch, prefix: string, source: SubjectSource,
release?: () => Promise<FilterRelease | null>, evidence?: LeafOptions}`. The default release reader is
`activeRelease(pool)`. `LeafOptions` is imported directly from Semantic's `scope-leaf-evidence.ts`: the actual
`access`, `actor`, `routeKey`, `deadline` and optional `nativeT` closure used by the point reader. Neither a source
nor a principal string supplies an actor; there is no anonymous fallback. Raw prefix capability is independent
of missing point context. There are no pretend `SearchScopeNative` basis/identity/leaves callbacks. Following
runtime work must import actual `readIdentityBasis`, `readTerminalSubjectIdentity`, `readSubjectAliasGroup` and
`readScopeLeafEvidence` exports. A native evidence stub returning `not_ready` is not positive capability.

The exported method signatures are:

- `prepare(filter: FilterDocument): Promise<PreparedSearchScope>`.
- `prefix(prepared, {afterSubject: string | null, quota: number, budget: number}): Promise<SearchScopePrefix>`.
- `evaluate(prepared, subjects: readonly string[], reservation: ScopeEvaluationReservation): Promise<SearchScopeEvaluation>`.

`PreparedSearchScope` is opaque factory-local state with `readiness: 'ready'` and `basis: ScopeBasis`, never an
allow claim. `ScopeBasis` has `release`, `query`, `profile`, `canonical`, `generation` and `index`. Preparation
pins the physical index and generation even with zero hits. Missing native/index readiness is
`semantic_not_ready`/`index_not_ready`; changed generation or basis is `search_restart_required`, never silent
repinning. Ordinary partition positions are not structural identity generations.

`ScopeNativeBudget = Omit<LeafWork, 'keys'>` reuses Semantic's actual type: independent nonnegative safe-integer
`points`, `witnesses`, `rows`, `bytes`, `emptySeeks`. None is a raw candidate allowance.
`ScopeEvaluationReservation` has required `rawKeys: number`, required `native: ScopeNativeBudget` and optional
`progress?: ScopeEvaluationProgress | null`. `rawKeys` is the caller's explicit REMAINING shared reservation,
0..256, never a per-source default256. Zero remaining is valid and starts no native key work. IDs (including
duplicates), points, witnesses and rows cannot imply keys. Malformed, negative, noninteger and overlarge
reservations reject before I/O. Each native call receives only reserved remaining keys, hard maximum101,
and available native axes; actual `usage.keys` is subtracted before another call. Native calls require their
own positive axes and at most100 witnesses. Prefix candidates, alias windows and leaf/internal driver keys
all debit the SAME outer ledger, including rereads, discarded keys and reserved unused lookahead.

`SearchScopePrefix` returns `hits`, `basis`, `coveredThrough`, `exhausted`, `usage: {candidates: number}`. Hits
reuse actual engine `SearchHit`, including `matched`, index, partition, security revision and sort, rather than
public DTOs. Prefix is ascending stored canonical UUID order above `afterSubject`, before current filtering.
Reserve quota plus one lookahead (quota1..100, budget<=256); at most quota entries are covered. Unused lookahead
cannot advance `coveredThrough`. No hidden refill, synthesized hit or raw-ID normalization. Partial shards,
timeouts and failures are errors, never empty/exhausted. Empty nonexhausted output needs covered progress or
readiness/error. Raw private candidates remain service-internal.

`SearchScopeEvaluation` returns `values`, `basis`, `usage: {keys: number, native: ScopeNativeBudget}`, `evidence`
and required `progress: ScopeEvaluationProgress | null`. `values` aligns `true | false | 'not_proven'` with every
requested subject, including duplicates and engine misses. Evidence is request-local native references for
fresh final revalidation, never allow tokens. Runtime shares the complete admitted Boolean evaluator from
`disclosure/check.ts`; no fabricated Hit, separate interpreter, full renderer or unqualified snapshot can supply
current native evidence. AND/OR/NOT preserve unknown, and genuine matched queries only prioritize work. Partial
nonmatching facts cannot prove false without native coverage; unknown remains unknown under NOT. Original and
terminal authority and every earlier positive require fresh current checks before disclosure.

`ScopeEvaluationProgress` has exactly `subject`, `basis`, `leafOrdinal`, `phase`, `valueOrdinal`, `after`.
`subject` is the actual requested original, `basis` the composite owner digest. The structural slice reuses
`ScopeLeafPosition.leafOrdinal` and actual `LeafProgress` phase/value ordinal/after types, with deterministic
admitted leaf/value order. It carries ONE pending subject/leaf only; later unexamined values stay unknown.
There is no growing continuation vector, historical verdict, allow cache, native witness receipt vector or
serialized native basis. A CHARGED current leaf probe reconstructs the native leaf basis needed to recompute
and check the owner digest before resume; the composite digest cannot substitute for native `LeafProgress.basis`.

`sourceAfter` packs the agreed18-byte raw record through `scope-progress.ts` inside the existing encrypted list
position, with no new token codec. Version1/leaf ordinal occupy byte0, phase/value ordinal byte1; the remaining16
bytes hold sequence n+1 (zero means null) with zero padding, or a real witness UUID. Wirephase3 with allzero payload
means witness-start null, distinct from a nil UUID in phase2. Empty sourceAfter means whole null progress.
`aliasAfter` retains the actual original under evaluation: resume that original FIRST with current identity/source
checks, then resume the alias group strictly after it only once settled. No ninth position field or nested token.

Fixed-home identity basis work is separately charged at preparation, continuation and final phases: each
basis read pays two4096-home sweeps (8192 metadata rows plus core observations), never a per-subject free sweep or
hidden leaf usage. The canonical coverage reader below additionally charges its bracketing reads and home comparisons. Physical captures must identify actual operation phases when measuring these separately; no statement
exclusion or slack change may disguise the work.

### Final-proof status and cost evidence

The current Scope and leaf scaffolds remain unavailable, and production liveness for a worst admitted positive is
unproved. The independent analysis in
[`search-multileaf-final-proof-independent.md`](../../../../docs/research/search-multileaf-final-proof-independent.md)
validated a legal example with nine distinct material properties, 32 selected statements per property, nine
facets, and 289 total facts including one label. Each property's only matching statement is last in native
forward traversal. Fresh replay therefore has a conservative lower bound of 288 raw selected keys. Even granting
one ideally retained positive identity and one exact current reread, the other eight properties plus that reread
cost at least 257 keys, before candidate, alias, lookahead, or other final work. These are strategy lower bounds
for the specified access paths, not measured Scope SQL costs or an impossibility proof for every future access
layout. Request-local reuse and fused final reads are valid, but cannot share facts across these nine distinct
properties.

The owner has committed an actual coalesced relation-repair implementation, reviewed in the independent report;
it is absent from this development checkout. It maintains relation-pair hints, not material, range, code, or
qualifier matching hints, and does not provide universal final proof. A repaired relation hint or finite progress
through one leaf therefore does not establish finite composed proof. Foreign source/target authority, fences,
the original and terminal identities, and every earlier positive still require current checks; a native basis is
not a foreign-authority snapshot. Unknown remains unknown under NOT.

No source, storage, or policy remedy is adopted here. A production universal-liveness claim requires agreement on
a source-owned bounded-final-evidence capability and an actual cost proof for it. Any durable source-row or access
design remains a proposal until its native writes, rebuild/completeness behavior, foreign-proof obligations, and
all cost axes are implemented and measured. A batch wrapping 32 point reads still charges each key. Preserve the
256 shared-key ledger, full current admission, one 18-byte pending-leaf progress record, no serialized truth,
witness vector, allow cache, or PIT, and Search's sole Boolean/filter matcher. Do not exempt ledger work, reduce
admission, or treat readiness as successful completion.

Required native acceptance must prove a legal worst-admitted multi-leaf final `true` within 256 actual keys,
including points, witnesses, rows, bytes, and empty seeks, under finite quiescence, repair, and advancing
continuations. It must also cover 257- and 4096-alias groups with only the last original readable, current
revocation, and all source/target and original/terminal rechecks. Existing lower-level cases in
[`scope-leaf-evidence.test.ts`](../../test/semantic/scope-leaf-evidence.test.ts) cover relation witness bounds,
last-survivor discovery, current fences, typed range/qualifier matching, and candidate adoption; they do not
measure the multi-leaf composed 256-key proof. The supplemental analysis
[`search-multileaf-final-proof-deep.md`](../../../../docs/research/search-multileaf-final-proof-deep.md) is
additional evidence only. These native owner acceptance cases remain required; neither report claims they pass.

## Global rating order

The first public rating sort is limited to the public aggregate for the Global population and standard question.
[First public scope](../../../../docs/scope.md) defers Realm rating sorts; private Realm figures never enter the
public Search index. [Rating](../rating/README.md) owns the score formula, disclosure thresholds and privacy rules.
Search uses the published score and does not recompute or reinterpret that policy.

The rating source is the current public figure for a subject, read with that subject from the same anchor partition
and the same repeatable-read `core.partition.position`. A missing figure means unscored only after a complete,
successful source read. Source failure is unavailable evidence and fails closed. The current figure proof must also
confirm that the figure remains publicly eligible and that its score/revision still matches the indexed candidate;
an indexed score or matching epoch alone is not current eligibility proof. The runtime composition and its proof
remain pending, so this section records the contract rather than claiming production support.

The eligible Global prior has one frozen epoch identity. Below its 50-vote eligibility threshold the native state is
known ineligible and the selected epoch is null; an unavailable native read is an error, not null. Eligible epoch
identities are never reused after invalidation. The index publishes the epoch and score together from one public
figure. It accepts only one positive safe-integer epoch and one finite scalar score from 0 through 10; the mapping
uses a `long` epoch and a `double` score without coercion. Field existence is not a scalar-data validator, so the
source/document boundary enforces these invariants. Unscored state is absent/null; no numeric sentinel or
`null_value` substitutes for it.

For the common admitted search predicate `F`, let `P` mean that the selected epoch is non-null, the indexed figure
epoch equals it and `rating_score` exists. Phase A searches `F AND P`, ordered by score descending, normalized
`name_sort` ascending with missing last, then unique `id` ascending. Phase B searches `F AND NOT P`, where the
entire conjunction `P` is one complement clause, ordered by `name_sort` ascending with missing last, then `id`
ascending. A known null epoch makes A empty and B all of F. A real score of zero belongs to A; stale scores and
missing/null epochs or scores belong to B. The common query remains identical in both phases. This native order is
equivalent to scored-first ordering only for a fixed indexed state and the validated scalar-field invariants; it
uses no per-match rating script or fetched-prefix reranking. See the pinned OpenSearch 3.9.0
[field sort implementation](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/sort/FieldSortBuilder.java#L410-L449).

Resolve and pin one concrete physical generation before either phase and use it for both phases, count-only searches
and every refill, including searches returning zero hits. Read the selected native epoch before discovery, keep it
fixed throughout the response and read it again before returning. An observed epoch or active-generation change
restarts with HTTP 409; unavailable evidence fails closed. A null epoch at both ends proves only that the current
ordering rule is unscored at both reads: it does not prove that no eligible interval occurred between them. No
transition-history field is introduced.

Each refill round uses at most two native searches, including any count-only search. A shared raw-hit budget
`q = min(200, 2 * remaining_page_slots + 1)` applies across A and B; the page uses at most three rounds and 600
raw hits. Search advances from the last consumed native hit, including stale or rejected hits, and leaves an
acceptable lookahead unconsumed. Do not advance through an unconsumed A hit, strip the score from an A tuple to
make a B tuple, or synthesize a sort sentinel. A's raw tuple is `[score, name_sort|null, id]`; B's is
`[name_sort|null, id]`. Preserve the engine's null exactly. A short or empty successful response proves exhaustion
only for that phase after its tuple; timeouts, failed shards, partial responses or early termination do not prove
order or exhaustion. OpenSearch checks tuple arity against the selected sort and preserves returned null sort values
([`SearchAfterBuilder`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java#L124-L149),
[`SearchSortValues`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/SearchSortValues.java#L70-L110)).

Current-source rejection consumes and drops an unsafe hit; Search never exposes its old score, relabels it as
unscored in place or reranks it. The result is a safe ordered subsequence of the indexed candidates, not a complete
current-native order. There is no current top-N, PIT, snapshot traversal, duplicate-free traversal or completeness
promise while publication and index updates move keys. A/B phase totals are internal indexed observations under a
fixed-state theorem only. A rating-sort response's public `total` is always a `lower_bound` from unique, currently
verified and disclosed hits; never expose a sum of live phase counts as a public exact count or lower bound, since a
subject can move between phases between searches even when epoch and generation are unchanged.

Keep released `subjects-search-v2` source and ID unchanged. Reuse it if the fixed server-built phase filters, sorts,
physical target and zero-size count request fit its existing template contract; introduce a new template version
only if the stored source must change.

## Confidential cursor and bounded name sort

The Search cursor contract uses the shared encrypted list-cursor Search profile with AES-GCM. Its authenticated
binding covers the route/operation, canonical request hash and viewer. The viewer is a real lowercase account UUID
or null for anonymous readers. The encrypted position carries the concrete generation, selected Global question
and epoch, operation/sort-template version, phase and last consumed native tuple; authenticate the original request
first, then restart with HTTP 409 on a valid cursor whose current rating context has changed. Do not change the
authenticated request hash to the current epoch. All search positions use fresh random salt,
15-minute expiry including anonymous viewers and a 60-second future-time allowance. Profile cross-decode fails.
There is no HMAC-readable position or legacy plaintext fallback. The Search adapter still needs the encrypted
profile migration and outcome proof; this contract does not claim that runtime work is complete.

The bounded profile accepts at most 8 tuple keys, 2,560 UTF-8 bytes per key, 3,072 aggregate string bytes,
3,584 serialized bytes and 4,864 token characters; the HTTP cursor limit derives from this profile, with no legacy
4,096-character cap. Native tuples preserve exact type and value using the profile's `s` string, `n` finite-number
and `z` null encodings. Phase and tuple arity are validated; score zero remains a number, and neither tuple values
nor names are truncated, hashed or reconstructed from display data. Base64 inspection cannot recover a hidden sort
key or subject id. If an acceptable B hit is lookahead before any B hit is consumed, retain the last consumed A
tuple; the next request may confirm A exhaustion and request B within the same two-search budget. The cursor changes
to B only after a B hit is consumed.

For native name ordering, Search stores the full normalized name key only when it is at most 512 UTF-16 code units;
missing and oversized keys use null with native missing-last behavior and unique `id` ties. Do not truncate or hash
the key. Full names and `names.exact` remain unchanged. The index's `name_key` normalizer is applied to the complete visible name in a
bounded write-side `_analyze` pass before bulk indexing: deduplicate raw names and analyze at most 256 names per
request. Do not send hidden or deleted action names to analysis. Keep one bulk action and its anchor external version
per subject; if normalization fails, do not partially bulk or advance the checkpoint. Mapping `ignore_above: 512`
is only a defense: OpenSearch checks raw string length before applying the normalizer, so a short input can expand
past the normalized bound. See the pinned OpenSearch 3.9.0
[keyword mapping implementation](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/mapper/KeywordFieldMapper.java#L1023-L1031).
Existing oversized indexed keys require replay into a real new generation before bounded-read readiness; a mapping
update does not rewrite existing terms.

## Cost

These are derivations from `src/search/`, `src/events/`, the called Access SQL, `db/search/` and the core/semantic
schema, not measurements or guaranteed PostgreSQL plans. Search owns the engine candidate and recheck contract.
Semantic owns relation-facet witness selection, current statement and fence truth, durable repair metadata, rebuild
work and its SQL cost derivation; the [semantic relation-facet design](../semantic/relation-facets-design.md) is the
authority for those details. Semantic source/worker composition and its final real-source claim remain pending.

The criterion is a bounded anchor neighbourhood per query, hit or change, with about changes × index depth work;
kernel enumeration and source reads are bounded as described below. OpenSearch query, sort and count work can grow
with matching documents and shard merges; these request and candidate limits establish no O(1) engine-work or
latency guarantee.
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

- Touches: Route validation, `text.ts`, `filter.ts`, `query.ts` and `subjects-search-v2` compile named clauses. The
  existing non-rating path sends one alias `_search/template` request per round, at most three per page. The Global
  rating path uses native phases A and B against one pinned physical generation, at most two requests per round.
  Existing index fields are `search_text`, `names.exact`, `names`, keyword type/statements and nested `facts`; the
  current sorts are `_score` then id (relevance), `name_sort` then id (name), id, or `public_collection_count`
  descending with missing as 0, then `name_sort` and id (collections). The Global rating sort is described above.
  `_source` selects partition/security revision; ordinary totals track to 10,000. Relation positive and negative
  overflow clauses are compiled as safe candidate supersets. A named outer clause keeps exact-value and marker-only
  matches in the same matched-query lineage. Grow N/P/d, fixing s, query and current hits.
- Bound: A filtered request adds one active-release lookup (pointer read; release cached by digest); no lookup
  without a filter. Admission is linear in expanded leaves (`ell <= 32`) times the returnable types' bases; the
  all-types facet union is computed once per release. `O(h)` hit mapping, at most 600 hit documents, and at most
  three searches for the existing non-rating path; a rating page has at most six native phase searches and 600
  returned raw hits, with the 200-hit budget shared across phases per round. Native sorting and counting remain
  match-dependent engine work. Valid text is <= 512 bytes/64 leaves/depth 4; filters <= 32 leaves/depth 4, OR <= 16,
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
  “each request makes at most three index requests and reads only the partitions of examined hits” for the existing
  non-rating path; rating phase runtime outcomes remain pending. [test/search/overflow-service.test.ts](../../test/search/overflow-service.test.ts):
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

- Touches: The adopted Search contract uses the shared AES-GCM list-cursor Search profile, binding route/operation,
  canonical request hash and viewer, and encrypting generation, Global rating context, phase and last consumed native
  tuple. Each page uses `search_after`; no OFFSET, preceding-page enumeration or database cursor. See [Confidential
  cursor and bounded name sort](#confidential-cursor-and-bounded-name-sort). The runtime adapter migration and
  encrypted-token outcome proof remain pending.
- Bound: Zero SQL or engine I/O in the cursor codec; at most 8 tuple keys, 2,560 UTF-8 bytes per key, 3,072
  aggregate string bytes, 3,584 serialized bytes and 4,864 token characters. Position encryption uses a fresh random
  salt, a 15-minute lifetime including anonymous viewers and a 60-second future allowance. Codec and tuple size are
  independent of page depth; page consumption is `O(h)`. No kernel `O(d*s)` read from the start. Dropped or
  unproven candidates are consumed before the next keyset continuation, while acceptable lookahead stays unconsumed.
- Growth check: [test/search/service.test.ts](../../test/search/service.test.ts): “pages continue through signed tokens
  bound to the request and the principal” and “each request makes at most three index requests and reads only the
  partitions of examined hits” for the existing path. Encrypted-profile confidentiality and native phase cursor
  outcomes remain runtime proof requirements.

### Global rating phases

- Touches: Each page resolves one physical generation and brackets its native epoch context; each refill round sends
  at most two phase searches, including count-only work, then checks current figures in bounded source batches.
- Bound: At most 200 combined raw hits per round and 600 per three-round response; current-figure reads are batched
  by anchor partition, at most 256 figure IDs per source call. OpenSearch sort and count work is match-dependent;
  no SQL, latency or O(1) engine-work claim follows from these request bounds.
- Growth check: [test/search/growth-rating-query.test.ts](../../test/search/growth-rating-query.test.ts): “native rating
  candidate delivery remains within shared phase quotas as the real indexed matching population grows”. The test is
  present; its runtime pass status is unverified here. Its native phase request and returned-key quotas do not prove
  default worker/native vote composition, the current disclosed total, PIT/live top-N behavior, or constant engine
  postings, sort or latency work.

### Bounded native name sort

- Touches: The helper deduplicates distinct nonnull raw names and sends one `_analyze` request per name before bulk;
  hidden/deleted action names are not analyzed. Each subject keeps one bulk action and its anchor external version.
  Normalization failure prevents bulk and checkpoint advancement. The existing integration and batch contracts are
  covered by `test/search/bounded-sort-indexer.test.ts` (“default index relay and rebuild bound native sort values
  before visible writes and do not checkpoint failed normalization”) and `test/search/canonical-coverage.test.ts`
  (“source cap stays 256 and publication waits for every real source chunk and checkpoint outcome”); their pass
  status is unverified here.
- Bound: The helper permits at most 16 concurrent analysis requests and validates each single token's position and
  offsets; it does not infer alignment from multi-text output or cap its action set at 256. Helper work is
  `O(distinct names and their bytes)`, with one request per distinct name and zero SQL. Any eventual source chunking
  is a separate batch-contract bound. Retain only a complete normalized key of at most 512 UTF-16 code units; larger
  results use null. Display and exact names stay unchanged, and read-side sorting remains match-dependent with
  missing-last plus unique id.
- Growth check: `test/search/bounded-sort-keys.test.ts` (“native normalization bounds complete name sort values on
  writes while preserving full names and stable null pagination”) exercises the native helper; its pass status is
  unverified here. Pinned-engine/runtime evidence for overlong normalization becoming null, ordinary 250-CJK names
  retaining their full key, and replay repairing existing values before bounded-read readiness remains separate and
  pending. Source/replay/default-worker/native API readiness requires its own integration/runtime evidence.

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

### Scope raw prefix

- Touches: currently admission only, zero engine/source reads after an injected release. Future preparation reads
  the active release, native fixed-home basis and physical index metadata, including on zero hits; one prefix
  dispatch reads the pinned engine generation, with no refill. Grow indexed subjects/history with quota fixed.
- Bound: integer `1 <= quota <= 100`, aggregate caller candidate reservation `<= 256`; reserve `quota + 1 <= budget`
  before dispatch. Charge every examined raw key including lookahead, duplicates, rejects, rereads and internal
  keys. The caller reserves across sources; per-call validation cannot enforce aggregate accounting. Candidate
  bounds do not prove physical postings, latency or native SQL bounds.
- Growth check: `test/search/scope-source-contract.test.ts` permanently checks negative admission and reservations;
  native prefix/generation/partial-response positive and growth proofs are separate specification tasks, pending.

### Scope current points

- Touches: currently no native point reads. Future evaluation reads only admitted native identity/leaf evidence
  for explicit IDs and final revalidation; alias groups resume bounded windows. Grow aliases/witness history with
  the independent reservation fixed; no whole-subject render or enumeration hidden behind point calls.
- Bound: `ScopeNativeBudget` independently admits nonnegative safe-integer points, witnesses, rows, bytes and
  emptySeeks; returned usage uses those units. Every explicit ID, including duplicates, reserves a point. It does
  not multiply or borrow candidate256. Exhaustion yields unknown/readiness unless definitive evidence settles truth.
- Growth check: `test/search/scope-source-contract.test.ts` checks invalid native budgets and duplicate charging
  admission. Native witness/absence, alias-window and EXPLAIN/growth evidence remain required, not delivered.

### Hit label choice

Search hits, item facts, facet values and suggestions use the same label choice.

- Touches: the labels, descriptions and `schema:inLanguage` fact of subjects the final check already holds.
- Bound: no read, statement or engine request added; per returned subject, work linear in R ranges (at most 8) times its labels and descriptions.
- Growth check: none; no read changes. `test/search/facet-counts.test.ts`: "facet value labels follow the reader's language chain" and `test/search/service.test.ts`: "typeahead labels follow the reader's language chain" prove the choice.

## Canonical index coverage producer

Status: adopted specification with unavailable stubs in `coverage.ts` and `coverage-projection.ts`,
and staged native acceptance in `test/search/canonical-coverage.test.ts` and
`test/search/coverage-projection.test.ts`. Formatting acceptance does not establish native runtime delivery.
The existing source, indexer, lifecycle and default worker have not acquired this protocol through these types.
The original raw-prefix and scope admission tests remain unchanged. Search owns derived per-home coverage,
apply attempts and physical lineage; Semantic's current generation/pending/obligations remain the sole identity
owner. No identity SQL, permission engine, query engine or new native public signature is introduced.

A certificate means this physical index's stored original IDs are canonical under a real native structural
basis. It does not promise current visibility, complete ordinary recall or current matching facts. A legally
indexed B can remain a raw hit after an ordinary hide; current disclosure rejects it. Ordinary partition
positions witness catch-up only and never enter structural equality or the identity digest. A newer source
snapshot does not prove that the consumer visited all earlier structural anchor events.

### API and current schema

The independent Search exports are `initializeSubjectIncarnation(options, generation)`,
`createSubjectProjectionCoordinator(options)`, `readSubjectCoverage(options, { deadline })` and
`activateSubjectIncarnation(options, incarnation)` and `retireSubjectIncarnation(options, incarnation)`. Coordinator methods are `run(incarnation, partition)`,
`populate(incarnation)` and `certify(incarnation, { deadline })`. They accept actual pool/engine/source/listing
composition, never ready callbacks, supplied certificates, source bodies or invented checkpoint outcomes.
The stub throws `index_not_ready`; implementations may return `not_ready` only after actual observations.
The reader performs no population, replay, worker drain or raw search.

The storage slice implements two current-row tables and one bounded prefix allocator, without identity-table writes:

- `search.index_prefix_control`: primary key `(partition_no, prefix)`, `CHECK (partition_no = 0)`; monotonic `revision` and `issued_generation`, matching
  `CoveragePrefixControl`. Allocate only strictly increasing safe-integer generation numbers; retain this one
  fence when retired generation rows are reclaimed. No per-retired-name history is needed.
- `search.index_incarnation`: primary key `(partition_no, consumer, index_uuid)`, `CHECK (partition_no = 0)`, unique retained
  `(partition_no, prefix, generation)`;
  `index_name`, `protocol`, monotonic `revision`, `state`, `origin`, `population_partition`,
  `population_after`, `population_complete`. These are the fields of `IndexIncarnation` and
  `PopulationLineage`. The partition/keyset frontier is singular, bounded and durable.
- `search.index_home_coverage`: primary key `(partition_no, consumer, index_uuid)`; monotonic `revision`,
  nullable `current`, `fence`, `verified`, `covered_through`, `attempt`, with fixed shapes matching
  `HomeCoverage`. Add consumer/incarnation-leading retirement access. Tuple fields use bounded JSON objects;
  bigint fields encode canonical nonnegative decimal strings, with validated shapes and no arrays/history.
  Physical UUID/protocol are joined from the lifecycle row, never guessed from names or engine hits.

One current attempt occupies the home row. Competing writers return busy or wait without enrolling another
attempt; there is no persistent queue/history of attempts. Attempt identity is a UUID. Store its original
checkpoint range, actual observed source tuple, visible/ambiguous/completed outcome and checkpoint
pending/advanced/lost/stopped result. Native pending is checked live and is never cached as permission to publish.
Missing epoch/home/tuple/fence/provenance is unavailable, never inferred as zero or self. At most 4096 rows per live physical
generation and three live generations are admitted per prefix: 12,288 home rows plus bounded lifecycle control.
No actor, record, subject, filter or historical basis rows are retained. A single monotonic allocation fence per
prefix prevents generation/name reuse after retired rows are reclaimed; it is bounded control, not a tombstone
per historical generation.

`coverage-store.ts` exports only `createCoverageStore(pool)`, `CoverageStore`, `CoverageGuard`, `HomeGuard`
and `CoverageObservation`. The factory implements durable current state in PostgreSQL with short transactions,
closed bigint codecs and conditional lifecycle/home writes. `test/search/coverage-store.test.ts` exercises the
actual migrated database. These tests supply storage observations, not native readiness certificates. Native
Scope run/populate/certify remain unavailable until the actual producer lands.

The store methods are `readPrefix`, `allocate`, `readLineage`, `register`, `population`, `transition`, `reclaim`,
`readHome`, `enroll`, `outcome`, `complete` and `promote`, plus the unavailable `settleNoWrite` correction
specified below; their exact signatures are in `CoverageStore`.
All writes atomically compare full incarnation identity (prefix, generation, index, UUID, protocol, consumer) and
lifecycle revision; home writes additionally compare partition and home revision. Revisions start at 1, missing
rows compare as revision 0, and every successful mutation increments its row revision. CAS loss/absent or
ineligible state returns null (reclaim returns false), malformed input rejects without mutation. Reads of absent
or differently bound identities return null. Only `subject-coverage-v1` is valid. Control partition zero is internal,
never an additional caller field. Every authoritative primary/unique key starts with `partition_no`; secondary
retirement access is not a second authority. All mutation guards are checked inside the same short transaction,
including the prefix lock that serializes admission and retained-row counting.

Allocation accepts positive safe-integer generations strictly greater than the issued fence, without requiring
contiguity. Register requires the exact latest control revision/generation, never an arbitrary old allocation;
failed registration leaves the allocation fence advanced. Retrying an unbound latest allocation is allowed;
a preexisting physical index still requires actual replay/audit provenance. Initial lineage is populating, revision 1, partition 0, after null,
complete false. At most three retained lineage rows (including quarantined/retiring) per prefix are admitted;
reclamation deletes the retiring lineage rather than retaining retired history. Population advances a singular
monotonic partition/UUID keyset frontier, cannot regress or reopen completion, and completes only at partition
4096 with after null. It records the coordinator's actual replay/audit result; storage cannot establish provenance.
Only complete populating lineage can become live. Populating/live may become quarantined; any nonretired state
may become retiring. Retiring blocks enrollment, outcome, completion and promotion before cleanup. Reclaim compares
its revision, deletes at most 4096 homes and its lineage atomically, retains the prefix fence, and never performs
engine deletion or deletes core checkpoints. The lifecycle owner separately owns those external operations.

The following enrollment/outcome rules describe the existing runtime; the staged additive correction below
changes replacement and nullable-fence validation only when implemented.
Enrollment accepts only an enrolled/pending attempt with null source, a fresh UUID and ordered same-epoch
checkpoint range; its initial home has null current/fence/verified/coveredThrough. Only populating/live can enroll.
A completed slot may be replaced; any other slot blocks replacement indefinitely. Enrollment on an existing home
preserves current/fence and verified/coveredThrough. The durable slot and home/lifecycle revision CAS require
enrollment before source observation and prevent promotion across an unresolved prior attempt; the coordinator
must independently ensure that the new snapshot does not predate the verified tuple. Same-basis pending ordinary
work retains the existing certificate without proving a new basis. The reader still compares CURRENT native
tuple/pending against verified; a later structural generation invalidates it. Outcome records actual post-read source/fence observations and marks
enrolled as visible or ambiguous; ambiguous may become visible only on actual resolution, never expiry. A visible
outcome requires nonnull source/fence, matching partition/epoch/generation; a newer committed fence may exceed this batch through position,
which blocks promotion until a later completed attempt covers it;
ambiguous may retain null observations. An already recorded nonnull source/fence cannot be changed on resolution.
Outcome copies source/fence into current/fence and the attempt source. A different source tuple or fence generation
clears verified/coveredThrough; a same-basis outcome preserves them. An ambiguous/null outcome never creates
evidence, and neither timeout nor starting another attempt can verify an unknown older attempt.
Complete requires visible and the exact
attempt ID; it records advanced/lost/stopped from the real checkpoint operation and marks completed, without
advancing core itself. Completed attempts with any of those results may promote only after the coordinator has
independently established catch-up: live revision, matching observed source/current/fence generation and positive epoch,
matching home partition, coveredThrough equal to attempt through and at or beyond the committed fence. It cannot
promote across a changed tuple, unresolved slot or stale revision/attempt. Promotion writes verified and
coveredThrough atomically. None of these operations creates an allow cache or native identity authority.

Input and durable JSON objects are closed, with exactly the fields in the existing coverage types, nullable only
where those types permit; no arrays or additional fields. All bigint values are nonnegative PostgreSQL bigint
range (0..9223372036854775807), preserved as bigint at the TypeScript boundary and canonical decimal strings in
JSON (`0` or a nonzero digit followed by digits), never Number. Revisions are positive persisted bigints. Positions
may be zero. `CoverageHome.generation` and `StructuralFence.generation` accept observed native values
0..9223372036854775807, including actual generation 0 with pending 0 from the ready native producer.
Missing metadata or coverage remains unavailable; never infer zero from missing data. These storage observations
do not establish native Scope readiness: the producer and reader independently establish actual zero provenance.
Partitions are integers 0..4095 except the population completion sentinel. Physical `IndexIncarnation.generation`
and epochs remain positive safe integers (epochs fit PostgreSQL integer). Attempt IDs are lowercase UUIDs;
home/node identifiers and engine UUIDs are opaque nonempty UTF-8 strings <=128 bytes, preserving native spelling. Prefix and generation must satisfy existing
`subjectIndexName` validation. Index/consumer strings are bounded at 255/63 UTF-8 bytes; registration requires
exact existing `subjectIndexName` and `subjectConsumer` results. Well-shaped different names in read/mutation
guards return null as identity mismatches. Never bind a new generation to an old physical name.
Population after is a UUID or null. Validate nested shapes,
range ordering and these bounds on input and decode; malformed stored state fails closed, never coerces.

The storage implementation uses the owning migration/schema snapshot, `coverage-store.ts`, a closed codec
module and five typed point SQL modules for allocation, registration, home reads, attempts and promotion. Prefix
row locks serialize allocation/admission; a current allocation-bound bit prevents rebinding the last issued
name after its lineage is reclaimed, without retaining historical targets. Lifecycle row locks fence home CAS
and reclamation. Home reads also
bracket their point read with the lifecycle lock. Transactions contain database work only and release the
connection before any caller can perform engine I/O. The coordinator, reader and engine lifecycle remain
unavailable specification stubs; durable observations alone cannot certify native coverage.

### Event fence and producer state machine

Semantic owns `SUBJECT_IDENTITY_CHANGED` in `semantic/events.ts`, with type
`com.rezics.subject.identity.changed.v1`. Its subject is the actual changed original in its own home;
closed data is ONLY `{ generation: string }`, matching `^(0|[1-9][0-9]*)$`. The generation is the actual
`recordIdentityMutation` obligation version. Redirect insertion/removal/repoint, generation/pending and this
event commit in the same command transaction. Envelope epoch/position is the committed structural fence.
Merge, verify, unverify, removal and inherited repoint emit on actual mutations; no-op, receipt replay and
rollback emit none. Existing events remain. Schema registration is part of that native producer's delivery.
Search selects the original by this event's actual route/type, not by a survivor or `data.subjects` in link events.
No Number conversion or new native position API is needed.

1. Initialization creates a genuinely new physical name, reads its actual engine UUID, binds protocol and fresh
   consumer lineage, and establishes controlled writers before any source snapshot/HTTP. An already-existing
   index is not known empty, even with zero documents. Unknown old instances stay unavailable until complete
   retained replay or bounded source/index audit establishes missing AND extra key coverage. Equal counts are
   diagnostic only. Population completeness records its actual creation-log/retention boundary and advancing
   frontier; a gap stops progress. Imported anchors without complete creation provenance require audit.
2. `run` enrolls a durable home attempt conditionally on the live incarnation/revision BEFORE obtaining source
   snapshots or sending HTTP. A shared database guard serializes all participating processes, helpers and workers.
   Transactions are short; no database client, transaction or lock-holding connection spans external I/O.
   Native source home/epoch/generation are observed around the actual snapshot; changes require retry/unavailability,
   never stamping the newer tuple on an earlier batch. Every selected original is still checked natively.
3. Use the existing event runtime and document producer. Deduplicate actual event anchors; split source reads into
   at most 256 IDs, respecting the source's unchanged cap. All chunk actions must become refresh-visible before
   checkpoint completion. Preserve the 64-envelope cap and core `projectBatch` protocol. Enrollment and checkpoint
   outcome must be integrated around that existing runtime; no second worker or hand-written forced checkpoint.
   A 409 alone is insufficient: verify visibility of the superseding winner by a checked physical refresh before
   completing the attempt. Validate refresh shard completion and all bulk item outcomes, including missing deletes.
4. On confirmed visible work, record actual checkpoint CAS outcome, including CAS loss. CAS loss cannot erase an
   external effect. An ambiguous request keeps its attempt unresolved. No elapsed timeout, lease, dead process or
   checkpoint successor certifies completion. Same-tuple ordinary work may preserve an existing verified tuple;
   older/unknown-source work blocks new certification until genuinely resolved. A verified tuple cannot coexist
   with an unresolved write that may restore an older structural original beyond delete retention.
5. Certification obtains a real ready `readIdentityBasis` before and after capturing all native home tuples through
   existing `readIdentityHome`, each on a released same-client RR snapshot with the exact core position observation.
   These frozen catch-up barriers include committed structural events; known event generations must agree with
   their committed fences, not just a recent snapshot head. Catch up through every required fence/barrier using
   complete population/event provenance. Then independently revalidate the full basis, live UUID/protocol, all
   native pending/home/epoch checks and absence of dangerous attempts before conditional promotion. Reuse matching
   home evidence despite ordinary lag. This conservative three-basis-read capture uses unchanged native ports;
   no duplicate digest implementation or unreviewed native vector-returning handoff.
6. Activation independently checks certified coverage, exact UUID/protocol and live lifecycle revision before
   switching the actual alias. It cannot activate an incomplete population or a quarantined/retired target.
   Readers bracket all 4096 coverage-row observations with two actual full native basis reads. Between them,
   read each actual native home tuple through the unchanged home port and compare it with the verified row,
   including native pending/epoch/home. Equal ready bracketing bases and the physical incarnation are required.
   Preparation, continuation, engine-result bracketing and final use perform the required independent rechecks,
   including zero hits. Structural or alias/UUID change restarts a prepared traversal; pending/unavailable evidence
   fails readiness. No post-fetch canonical rewrite, reorder, drop-to-repair or per-candidate global sweep.
7. Quarantine ambiguous old targets; recovery creates a fresh controlled generation and completes real population.
   Retirement conditionally fences enrollment/publication before draining confirmed writes and deleting the engine
   index plus bounded coverage/checkpoint rows. Late completion cannot recreate retired control. Names of unresolved
   targets are never reused; automatic index creation must be disabled for those write targets and verified in
   deployment acceptance. Physical UUID checking alone does not prevent a late name-targeted write. This protocol
   introduces neither permanent public tombstone documents nor a silent change to external-version deletes.

### Internal projection seam and pending store correction

`coverage-projection.ts` exports exactly `createCoverageProjection(options: ProjectionOptions):
Pick<SubjectProjectionCoordinator, 'run'>`. Its `run(incarnation: IndexIncarnation, partition: number):
Promise<BatchResult>` is the internal producer entry. `coverage.ts` constructs it once and delegates `run`;
`populate` and `certify` remain unavailable. All imports from the public coverage module into the internal
module are type-only. The factory currently throws retryable `index_not_ready` with `Retry-After: 1`;
it does not allocate, enroll, observe native identity, call the engine or claim readiness.

The only new indexer option is optional `aroundApply?: SubjectApplyGuard`, exported from `indexer.ts`:
`(partition: number, envelopes: readonly Envelope[], apply: () => Promise<void>) => Promise<void>`.
It runs INSIDE the existing `projectBatch.apply`, before the existing anchor selection/source/listing/document/
bulk body. The callback executes that same body. With no hook, the existing path remains unchanged.
There is no other envelope read, parser, event filter, document builder or worker. Admission rejects on busy
or unavailable state; it must never return successfully without applying. The callback is single-use and cannot
start after the guard returns. Duplicate invocation rejects the batch even if the guard catches that error;
omitting apply also rejects. A successful guard cannot advance the checkpoint before its apply promise settles.
These checks prevent accidental double application; they supply no durable coverage proof themselves.

The actual producer will compose `createSubjectIndexer` with one guard and the real `createCoverageStore`.
All authoritative controlled helper/runner/worker writers must eventually use that composition. The coordinator
retains its enrolled attempt outside the guard so that it can record the actual returned `projectBatch` result.
No apply invocation plus `busy` means checkpoint snapshot contention, with no new slot. Guard admission contention
must return busy without advancing core; the coordinator handles its own internal admission rejection. After a
visible apply, returned `busy` means lost checkpoint CAS, and completes that exact visible attempt as `lost`.
A returned stopped valid prefix records `stopped`; the invalid tail is never included. Exceptions during apply
or checkpoint settlement propagate and retain the actual known state, never an invented CAS result. A failed
checkpoint call after visibility leaves a visible/pending slot for actual reconciliation, not safely aborted work.

The first parsed envelope is checkpoint+1: `read-log.sql` generates every position and `parseRows` stops at a
missing/invalid envelope or epoch transition. Enroll one durable slot before invoking the shared body, with
`from = { epoch: first.epoch, position: first.position - 1n }` and `through` from the actual last parsed envelope
in that SAME epoch. Never reread a moving checkpoint to reconstruct this range. Empty batches do not invoke the
guard and allocate nothing. Nonempty batches without selected anchors still enroll before the shared body,
then settle as no effect after the actual checkpoint result; they do not fabricate a source tuple or fence.

**Required minimal additive storage correction, before implementing this producer:** the current store cannot
release an enrolled slot when no engine write was sent, or complete a no-anchor apply without a source/fence.
`outcome(visible)` requires both, `complete` requires visible, and every noncompleted slot blocks replacement.
Marking these cases ambiguous would permanently strand ordinary native-pending retries. Add terminal
`ApplyAttempt.outcome` values `aborted` and `skipped`, and one home/lifecycle/attempt-ID CAS method:
`settleNoWrite(guard: HomeGuard, attemptId: string, result:
{ outcome: 'aborted'; checkpoint: 'pending' } |
{ outcome: 'skipped'; checkpoint: 'advanced' | 'lost' | 'stopped' }): Promise<HomeCoverage | null>`.
It accepts enrolled/pending/null-source only, retains null attempt source, preserves existing current/fence/verified/
coveredThrough, and makes the slot replaceable without authorizing promotion. `aborted` means positive local
knowledge that NO mutating engine request started; `skipped` means the shared body selected no actions and the
actual core outcome is known. The additive types and method are now staged: only `settleNoWrite` throws the existing retryable
`index_not_ready` with `Retry-After: 1`. Every preexisting store method, SQL path and codec remains unchanged.
`test/search/coverage-no-write.test.ts` stages real migrated-pool CAS, replacement, reopen and evidence tests;
these are implementation acceptance, currently red, not native readiness evidence. Formatting and root type
checking alone validate this specification stage. The actual store correction remains a build dependency
before the producer uses it. Also allow the already nullable `outcome(visible).fence` to remain null
when the real source tuple is known but no committed structural event fence has been observed. Visible sink
completion and core CAS settlement must be recordable without inventing that fence. Such a row cannot promote;
retain an existing matching committed fence when available, and never replace it with a source snapshot head.
A different source tuple clears old verified/coveredThrough evidence even when the new fence is absent.
The result is a closed discriminated shape: abort with a terminal checkpoint, skip with pending, unknown
fields and other malformed combinations reject without writes. Settlement compares the exact physical identity,
home, attempt ID, lifecycle revision and home revision in the same short atomic CAS as existing mutations.
Only an enrolled slot can settle; ambiguous, visible, completed or non-null-source attempts cannot be relabeled.
Terminal no-write slots admit a different attempt ID, never the same ID.
This relaxes only storage observation validation, not the requirement for genuine certification provenance.
Cost: one exact lineage guard and one exact home/attempt row, O(1) rows/statements using the existing
partition-leading indexed keys and one current slot; no queue, history or TTL scan. Existing native storage/growth
probes plus the fixed CAS/slot/reopen tests cover storage. Native producer and all-pool growth proofs remain
independently mandatory and are never implied by staged formatting.
A process crash before recording safe abort remains conservatively enrolled;
no lease or timeout proves that a request was never sent.

Native unavailability, source/listing/normalization failure or changed native metadata before ANY mutating engine
request permits safe abort and retry. After any chunk may have been submitted, failure/response loss is ambiguous,
even if earlier chunks were confirmed visible. A throwing transport cannot prove non-dispatch. Partial writes,
failed refreshes and uncertain later chunks cannot be safely aborted. Analysis/read-only metadata requests do not
constitute document writes. All actual source chunks stay <=256; every chunk and any conflict winner must become
visible before settling the envelope range. A 409 requires a checked refresh of the physical target and successful
shard results; accepting the conflict status alone is insufficient.

Within admission, use unchanged real `readIdentityHome` observations before and after EACH actual native source
snapshot, on released home observations; compare partition/epoch/home/generation and require current pending zero.
If they differ, discard those actions before HTTP and safely abort if no earlier chunk was submitted. Retain the
actual source snapshot position only as the external version. A current native tuple observed at snapshot head
cannot supply the committed structural fence: only genuine parsed `SUBJECT_IDENTITY_CHANGED` envelopes with
own-home original and closed lossless decimal generation supply event fences. Match a known fence to its exact
generation; if that fence is not known yet, record the actual source with a null fence and require later contiguous
catch-up before promotion. Do not stamp a newer native generation onto earlier selected anchors, guess a fence
from source head, or create a Source wrapper that purports to supply native identity. No native/core public signature changes and
no database client/transaction held across source or HTTP I/O are needed.

`test/search/coverage-projection.test.ts` specifies the real hook boundary and coordinator: durable slot observable
before source/bulk, separate competing instances, unrefreshed real 409 winner, safe source failure versus actual
applied/response-lost ambiguity, real CAS loss via a competing unguarded apply, empty/link-only batches, stopped
valid prefixes at gaps/invalid data, all >256 native anchors, and structural mutation around a real snapshot.
Setup observes an actual physical UUID and uses real allocation/register for **populating** lineage only; it
never supplies verified fields, promotes lineage, calls a readiness callback or claims Scope ready. The shared
fixture first validates real commands/Access/source/engine. Missing native identity or producer/storage code
leaves these exact tests red; formatting and typechecks are not evidence of runtime completion.

The smallest implementation surface is `coverage-projection.ts` plus the existing `indexer.ts` apply body for
phase observations, bounded chunking and checked write visibility; `coverage.ts` already delegates. Dependencies
are the actual CoverageStore including the correction above, unchanged native home observations and atomic
`SUBJECT_IDENTITY_CHANGED` producer/catalogue, existing `projectBatch`, native source/listing and shared engine
write helpers. Runner/work/helper composition, population/lifecycle, certificate reader and native identity
implementation remain separate follow-ups; this seam implements none of them.

### Helper setup and implementation slices

The existing raw-prefix setup's direct `client.bulk(documentActions(...))` has no coverage provenance. The concrete
replacement setup, for the later fixture-composition slice, is: create A/B/C with real commands; call
`initializeSubjectIncarnation`; repeatedly call the shared coordinator's bounded `populate`; obtain real `certify`
ready; call `activateSubjectIncarnation` and install the existing templates; capture genuine raw hits; pause this
producer; THEN hide B. All original assertions, lookahead/reservations, sort and matched data remain. The empty
fixture also uses real initialization and population before pinning. Arbitrary bulk writes never acquire lineage
retroactively. Prepare does not replay or drain B. This task leaves those existing tests untouched.

Implementation is split into bounded subsequent slices:

- Coverage storage: the current tables and prefix allocation fence, typed point SQL, CAS enrollment/promotion/retirement and bounded cleanup.
- Actual producer: shared coordinator around indexer source/bulk/checkpoint phases; integrate `runner.ts`,
  `work.ts` and actual helper population, with no second event consumer implementation.
- Lifecycle: `indices.ts`, `generations.ts` and retirement establish UUID/protocol, explicit replay/audit completion,
  activation, restart and fresh-target recovery. Counts do not certify.
- Scope composition: certificate reader, charged actual native basis checks and shared pinned engine dispatch.
  Existing native identity/alias/terminal/sealed-original signatures stay unchanged. A genuinely new internal/native
  handoff must first be proposed to the manager; none is required by this unchanged-port capture.

The staged native tests use migrated DB, real commands/Access/source/engine before checking any missing capability.
They require helper AND actual default-worker certificates, ordinary hidden raw B, structural lag, larger-survivor
merge/repoint, reversal events/replay, unknown UUID, source cap, concurrent writes, ambiguous timeout/recovery and
retirement/restart. They are red specifications, not evidence those prerequisites have landed. This base lacks
native identity-basis/maintenance modules and the agreed event export/schema; Search must not patch them by hand.

Focused additional executable acceptance belongs at `test/search/coverage-writers.test.ts` (409 before winner
refresh, all >256-ID chunks, old live write after real tombstone pruning, two actual worker processes and ambiguous
process exit), `test/search/coverage-lifecycle.test.ts` (known-empty DB, equal-count wrong-key audit, log gaps,
UUID/name reuse, late publication/retirement, home/epoch move), `test/search/growth-coverage.test.ts` (measured
native and storage work), and `test/semantic/identity-invalidation.test.ts` (atomic generation/route/schema,
rollback/no-op/replay and every actual writer). These slices exceed the four-file specification scope. The staged
short-retention schedule is a guard regression; final acceptance must force real engine tombstone pruning rather
than treat a short sleep as proof. Default-worker A/B/C certification is independently required even after helper
composition passes. Original frozen assertions and the existing thirteen plus six cases remain untouched.

### Independent default coverage composition acceptance

Both `test/search/coverage-lifecycle.test.ts` and `test/search/coverage-default-worker.test.ts` remain mandatory.
The focused lifecycle file retains bootstrap, UUID/lineage, activation and retirement races. Its implementation
acceptance does not depend on default registration or production rebuild. The independent default-worker file owns
the complete real-worker A/B/C certification and ordinary-hide case formerly in the lifecycle file, plus Search-only
pause/drain/restart, current API withholding, production rebuild and resource-ledger cleanup. Neither file imports
or registers the other. The existing canonical, writer and growth acceptances remain independently required.

Status: staged native specification, honestly red until production coverage composition exists. Its own
`createCoverageFixture` setup first proves real commands, source and engine baseline; it then uses the shared
`support/driver-client.ts` supervisor and actual default worker. Formatting and root typecheck stage this split;
they establish no native runtime, growth or default-worker pass. No manually driven coordinator or separate consumer
can satisfy the independent default-worker proof. Canonical coverage, current disclosure and estimated engine total
metadata are separate observations: a paused ordinary hide leaves raw B and its structural certificate unchanged,
withholds B through the real API, and requires the resumed worker to remove B and drain actual checkpoints.

Green native evidence requires `coverage.ts` lifecycle/population/certification/read delivery,
`coverage-projection.ts` guarded production apply and `indexer.ts` visibility/checkpoint integration on the existing
`coverage-store.ts` and core event runtime. Production `runner.ts` and `work.ts` must mount that coordinator, create
and certify the fresh controlled target before registration acknowledges readiness, and drain all owned work.
`generations.ts` must use the same guarded replay, reconcile native source partitions, certify a genuinely new
UUID/lineage and only then atomically publish. These depend on Semantic's actual `identity-basis.ts`
`readIdentityBasis(pool, { deadline })` / `readIdentityHome(client, partition)`, `semantic/identity-maintenance.ts`
metadata/hooks and `semantic/events.ts` identity invalidation, plus the unchanged `semantic/search-source.ts`,
`rating-source.ts` / `rating-subject-source.ts`, `library/listing-counts.ts` and structural-fence sources. `worker.ts`,
`work/modules.ts` and `work/registry.ts` provide real default mounting and the shared clock. The existing
`support/outcome-worker.ts`, `support/runner-slot.ts` and `support/outcome-supervisor.ts` must retain that composition
through actual pause/resume/rebuild/close; `SearchDriver.rebuild()` returns only `{ generation }`. The test adds no
fixture/control port or native/shared ABI. See [Default coverage composition proof](#cost-default-coverage-composition-proof)
for the independently charged composition work.

### Cost: default coverage composition proof

- Touches: actual default worker, guarded coordinator and production rebuild, isolated real runtime pools and
  actual engine target. Reuse the existing producer; no duplicate event consumer/indexer.
- Bound: production batches remain 64 envelopes, source chunks 256 IDs, at most three generations and 4096 fixed
  homes, with bounded discovery concurrency. Observe all current metadata and external-write work honestly;
  readiness is not a free callback. Replay, native partition reconciliation, certification and physical deletion
  retain their source/index population costs.
- Growth check: existing native coverage, writer and growth suites remain independently required. The default-worker
  file establishes production mounting/lifecycle, not postings or latency; stage formatting is not a growth/runtime
  pass. The [coverage writes and lifecycle](#cost-coverage-writes-and-lifecycle) bounds also apply.

### Cost: canonical coverage observation

- Touches: at each required prepare, continuation, engine-result bracket and final observation, one actual native
  basis read costs **8192 metadata observations plus core epoch/home observations**; charge rows, points, statements,
  transaction controls, empty/unavailable seeks, blocks and bytes. Separately charge 4096 coverage points, physical
  UUID/alias/protocol/control reads and response bytes. The reader brackets with two full basis reads
  (16,384 metadata observations plus core), and its unchanged-port comparison adds 4096 native home/core
  observations. No free vector hidden behind a digest.
- Bound: fixed-home O(4096) per independent observation plus indexed lookup depth, independent of candidates or
  unrelated subject history. Conservative cold certification reads three full bases (24,576 metadata observations
  plus core), an additional 4096 home/core-position capture, and up to 4096 checkpoint/coverage points per poll.
  Publication is separately bounded home work. Polling may repeat indefinitely under perpetual structural change.
- Growth check: `test/search/growth-coverage.test.ts` must measure all these axes at prepare, continuation and final,
  including zero-hit/error/empty seeks, while growing unrelated subjects/history and ordinary lag independently.
  Constant returned candidates are not evidence of constant native I/O.

### Cost: coverage writes and lifecycle

- Touches: store allocation/admission serializes bounded prefix controls and at most three retained lifecycle
  rows; point home mutations lock/read one lifecycle row and one home, then conditionally write that home.
  Each mutation includes BEGIN/COMMIT (or rollback); reclamation holds the prefix and lifecycle locks while
  deleting at most 4096 homes and the lineage. No transaction holds a connection across HTTP. Each real attempt
  performs enrollment, native source observations, bounded source chunks, actual bulk
  and refresh, checkpoint CAS outcome and conditional completion/promotion. Charge checkpoint, incarnation and
  attempt reads/writes separately, including failed/CAS-lost/ambiguous attempts. Source payload/history and physical
  engine work retain their existing costs.
- Bound: O(event anchors + payload + engine writes) per apply, source chunks at most 256 and batches at most 64
  envelopes; current storage O(4096 × live generations), at most 12,288 rows plus bounded lifecycle control.
  Replay/audit is O(retained log + source/index population) total in bounded steps. Retirement removes at most
  4096 home rows in store reclamation and separately at most 4096 checkpoint rows in lifecycle cleanup per
  generation; physical deletion/refresh is not constant work. A raw window's
  quota plus one bounds fetched keys only, not postings, sort work, latency or source history.
- Growth check: `test/search/coverage-writers.test.ts`, `test/search/coverage-lifecycle.test.ts` and
  `test/search/growth-coverage.test.ts` must independently grow actual changed anchors, source history, extra-index
  population, ordinary backlog and one through three generations, with fixed source chunk and candidate allowance.
