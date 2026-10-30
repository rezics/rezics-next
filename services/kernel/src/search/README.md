# Search

Search owns the subject search projection, indexing consumers, disclosure checks, query API, freshness and index
generations.

The optional `languages` request field is the reader's language chain, in priority order. Search follows semantic's
label choice rule for hit labels, requested descriptions and item fact labels, returning one entry per nonempty map.
Omitting `languages` keeps every language.

The approved [public facet discovery contract](../../../../docs/search-facets.md) is the single owner of the
count-free continuation wire, with additive types in `facet-discovery-contract.ts`. The current facets query is a
sampled, count-ordered preview with unsafe count metadata. Count removal is separate work; complete count-free
continuation, admission, Source/privacy integration and preparation remain **UNIMPLEMENTED**. This specification
adoption supplies no runtime or native acceptance evidence.

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
current filter evidence in the existing partial implementation; hit data is projected from the current source snapshot. Suggestions
and item facet labels also use current source checks. This suppresses stale results while relay repair catches up,
subject to the pending real-source/composition proof in [Indexed membership, current disclosure and convergence](#indexed-membership-current-disclosure-and-convergence).
It does **not** establish immediate count privacy: general search totals and facet bucket counts can still include
stale source subjects despite current hit/value checks. The initial Search public response omits all totals,
including verified rating lower bounds. Unsafe engine totals and facet counts must be omitted under [Filtered lists](../../../../docs/filtered-lists.md), without approximate/as_of, zero or row-length fallback. The immediate suppression authority remains
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

## Indexed membership, current disclosure and convergence

[Filtered lists](../../../../docs/filtered-lists.md) owns the shared list contract. Search owns compilation,
preparation and freshness over existing OpenSearch/PostgreSQL machinery. Semantic supplies complete public facet
projections and disclosure dependencies; Commerce owns owner-local private plans; Performance sets numeric budgets.
State, labels, progress and holdings never enter public Search. The shared pure matcher remains the conformance
reference; mandatory request-time raw-fact replay is superseded. Typed, parameterized SQL ranges/qualifiers may
execute the same released semantics. Same-statement qualifiers, datatypes/units and unknown under NOT remain.

Membership uses a complete, identified index observation for the admitted population/predicate, not a sample or
possible-witness hint. Ordinary catalogue edits become filterable within 60 seconds in healthy operation. More than
five minutes of actual source-to-searchable lag gives readiness. Engine refresh alone is not pipeline freshness.
Owner writes appear on the owner's next read. Privacy reductions, takedowns, consent/source revocation have no lag.

### Query-level privacy safety

Current disclosure covers membership, exclusion, order, fields, source metadata and cursor-visible information.
Check current source/Collection authority, original AND terminal eligibility, Access, consent, foreign targets and
tuple fences. An index revision, prepared result or completed identity epoch is never permission.

Query-level privacy-reduction invalidation and acknowledgement is required **in addition to candidate checks**.
Local reductions invalidate public use in their authoritative transaction. Foreign source-fence, target, consent
and Collection reductions invalidate affected public use immediately. Acknowledgement covers actual refresh-visible
projection repair including dependent foreign repair. Observe required current safety state before execution and
revalidate before disclosure. Unsafe, changed, missing or pending acknowledgement means preparation/readiness,
never stale exclusion/order/results. Ordinary checkpoints, `securityRevision`, complete ordinary generations,
returned-ID checks and omitted counts cannot certify this seam.

Withholding a harem tag must protect positive harem results and **NOT harem**: returned-row checks miss the subject
excluded by a stale tag. Paused-indexer negative/order/count cases must stay preparing until acknowledgement covers
the local reduction and all affected foreign repair. This is a required abstract producer/consumer contract, not a
certificate store, safety-token ABI, new permission authority or global identity/home sweep. Current native ports
do not yet implement the complete seam. Omit unsafe engine totals/facet counts over unchecked populations; neither
approximate/as_of labels nor zero/row-length substitutes repair privacy.

### Scope and composed-page admission

Admit filter + source + order together. The prose plan names are direct catalogue index, direct owner index,
prepared public result and prepared owner result; they are not new executable discriminants. A direct plan requires
a page-derived work bound, including engine work. Otherwise use bounded retained preparation on existing stores and
durable work, with finite input progress, quota and expiry; otherwise reject with 422 before enumeration. A composed
Zone page has aggregate admission, at most 16 distinct reads and 128 TOTAL output slots. No LIMIT or timeout proves
an engine bound. Current source checks remain required for ready results.

Successful pages fill the requested size or are genuinely exhausted final pages. If admitted work cannot establish
either, return explicit preparation/readiness. Sparse matches must produce useful pages after finite preparation;
no successful short/empty-page chain over raw nonmatches and no permanent preparing on finite ready input. Preserve
settled work after crash/replay; an essential unknown cannot become false, EOF or a silently skipped interval.

The service-bound Scope runtime must use the same real Search service/compiler and immutable released meaning,
including pin A after activation of B. Collection candidates are not fabricated Search Hits and Commerce does not
supply a second interpreter. Full native execution/default composition/growth remain required. Current
`scope-source.ts`, `service-scope.ts`, `scope-progress.ts` and leaf/final-replay exports are superseded unavailable
scaffolding, not evidence of indexed/prepared capability. Existing code and frozen tests remain until replacement
native acceptance permits removal. The old universal 256 raw-key ledger, whole-selected-slot observation,
one-pending-leaf final replay and bans on derived query/index state or typed SQL are removed as list rules.
Unrelated native batch/string/byte/cursor limits remain in force.

### Canonical lists and transport

Maintain canonical-ID indexes, one public terminal document and unique prepared result rows per generation and
canonical ID. The shared identity epoch stays pending throughout serialized durable merge/unmerge/repoint work;
lists prepare while pending and cursors restart after publication changes. Group admission is at most 4,096
originals before effects, with direct published redirects to active terminals. Do not walk all aliases or repeat
all-home identity-basis sweeps at request time. Original and terminal disclosure still applies. Stored personal
IDs/notes/multiplicity remain; canonical browsing and occurrence editing have distinct obligations under the
[identity authority](../semantic/README.md#identity).

Preserve Search's encrypted cursor profile, stable request/viewer binding, exact native tuples and fresh-start
behavior for unusable Zone POST progress. Reauthorize the principal and sources on every continuation. Zone POST
uses the existing transport: complete common page 200, explicit preparation 202 `{next}`, or no-progress/unavailable
503 Problem + Retry-After without cursor. No partial common page. Web follows at most four 202 steps then renders
private/no-store preparing with continuation retained. Progress names retained preparation/current generation,
never cached permissions, per-leaf verdicts or a client result vector. No schema/codec/status change is selected.
The [Search supervisor](../../test/search/support/outcome-supervisor.ts) calls `createSemanticDriver` in the
[Semantic outcome driver](../../test/semantic/outcome-driver.ts), which creates its own named `suspended` account,
issues an ordinary Auth bearer, then calls the real `createSuspensionCommands.suspend` with an authenticated
governor and native Access. The [Pages outcome driver](../../test/presentation/outcome-driver.ts) wraps that driver.
None calls `createPersonas`; the canonical [personas fixture](../../test/support/personas.ts) demonstrates the same
native suspension contract with a separate builder and account instance. These drivers do not synthesize SQL
suspension state or tokens. Accounts suspension advances the
[authentication floor](../access/authenticate.ts) before session revocation
([suspension command](../access/suspension.ts)), so Search and Pages reject the pre-suspension bearer with JSON
401 `invalid_credentials` and `WWW-Authenticate: Bearer error="invalid_token"`; it never downgrades to anonymous.
Auth mints active accounts only. A correct-password sign-in for a suspended account returns 403 `ACCOUNT_SUSPENDED`
without issuing a session, while a wrong password remains ordinary 401; Accounts owns that native producer case,
pending its native acceptance receipt. Kernel 403 `account_suspended` for a hypothetical verified suspended bearer
is a defensive branch, not the native suspended-persona outcome.

Owner-document adoption supplies no native pass. The prior native acceptance ran once and failed inherited
default-module startup and the Pages deadline; those failures remain required evidence. The prior root typecheck
recorded exit 0. No native, full or root check is rerun for this adoption; the full main/root gate remains unproven.
Native closure still requires all original cases and actual new persona/sign-in receipts, with no skips.

The [integration audit](../../../../docs/research/semantic-integration-audit-zone-composition.md) establishes the
resource substrate, not actual membership/page/default execution or Zone-specific withholding/purge/account/
scheduler completion. Typed schemas, loaders, cursor capacity and helper setup prove their own boundaries only.
Preserve native two-release pins, canonical cross-page ordering, current grant/source/fact revocation, cursor
restart/session/cache, persona/API/default composition and growth requirements. Old SAME256, final replay,
alias-window and home-certificate remedies in evidence reports are superseded by indexed/prepared/epoch behavior.

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

The existing phase implementation below retains its native request quotas; these do not admit a complete list
plan or replace Performance allowances. Each refill round uses at most two native searches, including any count-only search. A shared raw-hit budget
`q = min(200, 2 * remaining_page_slots + 1)` applies across A and B; the page uses at most three rounds and 600
raw hits. Search advances from the last consumed native hit, including stale or rejected hits, and leaves an
acceptable lookahead unconsumed. Do not advance through an unconsumed A hit, strip the score from an A tuple to
make a B tuple, or synthesize a sort sentinel. A's raw tuple is `[score, name_sort|null, id]`; B's is
`[name_sort|null, id]`. Preserve the engine's null exactly. An engine short or empty response proves exhaustion only for that phase after its tuple; the API must still fill the requested page, establish final exhaustion or return preparation/readiness; timeouts, failed shards, partial responses or early termination do not prove
order or exhaustion. OpenSearch checks tuple arity against the selected sort and preserves returned null sort values
([`SearchAfterBuilder`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java#L124-L149),
[`SearchSortValues`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/SearchSortValues.java#L70-L110)).

Current-source rejection consumes and drops an unsafe hit; Search never exposes its old score, relabels it as
unscored in place or reranks it. This phase behavior alone does not establish query-level privacy or complete
current-native order; the required safety observation and acknowledgement govern disclosure. This existing phase implementation does not prove current top-N or complete canonical traversal. Adopted lists require canonical cross-page uniqueness and epoch restart, with preparation where the direct plan cannot establish useful pages. A/B phase totals are internal indexed observations under a
fixed-state theorem only. The initial public response has no rating total, including `lower_bound`; neither live
phase counts nor a disclosed-hit row-length fallback supplies a safe aggregate. A future separately proved safe
aggregate contract may admit counts. A subject can move between phases between searches even when epoch and
generation are unchanged.

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
The service factory accepts the kernel's optional domain clock, defaulting to the actual system clock. Search
and facets sample it once at their request boundary; an explicit numeric `now` keeps its existing meaning and
bypasses that default. HTTP search (including rating order) and facets pass the resolved kernel clock to the
service. Cursor lifetime comparisons remain inclusive at 15 minutes and 60 seconds of future skew. Facets
currently return values without continuation tokens. Source timestamps and `as_of` remain native observations;
authorization evidence and wall-time request deadlines keep their existing clocks and guards. Sampling the clock
adds no SQL, engine request or Source read.

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
bounded write-side `_analyze` pass before bulk indexing: deduplicate distinct nonnull raw names and send one
`_analyze` request per name, with at most 16 requests in flight. Do not send hidden or deleted action names to
analysis. Keep one bulk action and its anchor external version
per subject; if normalization fails, do not partially bulk or advance the checkpoint. Mapping `ignore_above: 512`
is only a defense: OpenSearch checks raw string length before applying the normalizer, so a short input can expand
past the normalized bound. See the pinned OpenSearch 3.9.0
[keyword mapping implementation](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/mapper/KeywordFieldMapper.java#L1023-L1031).
Existing oversized indexed keys require replay into a real new generation before bounded-read readiness; a mapping
update does not rewrite existing terms.

## Cost

This inventory describes existing native components and their partial implementation bounds, not admission of a
complete list plan. Old refill/drop behavior, sampled facets and counts described as current below do not satisfy
[Filtered lists](../../../../docs/filtered-lists.md). Production list admission must bind the actual internal cost
object, shared harness counters, useful-page behavior and query-level privacy acknowledgement before acceptance.
Native batch limits keep their units; there is no universal 256-key page allowance.

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

- Touches: Indexing calls `SubjectSource.read(partition, ids)` in chunks of at most 256 deduplicated IDs in one
  partition. For `u` requested anchors, `c = ceil(u/256)` calls are made, with zero calls for `u = 0`; the ordinary
  64-envelope/1,000-event command bounds give at most 64,000 event anchors and 250 source calls per batch. Every
  call is its own native repeatable-read snapshot and returns that chunk's partition position. The snapshot pairs
  the partition position with subject state, labels,
  aliases, descriptions, adopted Global descriptive statements and relation facets. Only outgoing relation
  properties declared as facets for the subject's current type contribute to the existing `statements` and nested
  `facts` fields; nonfacets and incoming edges do not. Each declared relation property contributes at most 128
  distinct visible values, with an overflow property marker when more values exist. Descriptive values keep their
  prior behavior. Relation qualifiers can remain stored data, but role/episode qualifiers are not relation-facet
  predicates; a qualified relation filter is invalid, while descriptive qualifiers keep their existing meaning.
  Semantic's visible-at-build witness pointer stays internal and is not a Search field. Semantic's source, witness,
  fence and SQL costs are owned by the linked design rather than restated here.
- Bound: For `u` distinct requested anchors in one partition, indexing makes `c = ceil(u/256)` source calls,
  at most `c` listing reads and at most `c` actual bulks; all are zero when `u = 0`. Every index/delete action uses
  exactly the partition position from its own chunk snapshot as its external version. Chunks are processed so each
  bulk is refresh-visible before checkpoint advance; no DB client or transaction spans engine HTTP. A later chunk
  failure prevents checkpoint advance, and normal replay handles any visible prefix. The separate shared
  visibility-409-winner proof is not implemented by this chunking. Counts and native facts retain their input and
  history costs. Relation membership probes are capped at 256 per call. The relation projection is bounded by 128 distinct values per declared property, not the source's
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
  “cost per batch is one snapshot read and one bulk request at every batch size” describes the existing <=256 case
  and proves request counts only. The ControlledSource/provider-boundary suite is [test/search/indexer-source-batches.test.ts](../../test/search/indexer-source-batches.test.ts): “one admitted event envelope with more than256 subjects converges through bounded source chunks and checkpoints only after every visible write” and its “later transport failure and genuine retry” case. The real Semantic source regression is [test/search/source-batching-native.test.ts](../../test/search/source-batching-native.test.ts): “native event anchors use exact chunk snapshots through later transport failure and replay”. Control-plane acceptance recorded all eight tests in that native file passing, including the six target-size cases. These call-count assertions are not end-to-end growth measurements; Semantic native SQL growth checks remain separately scoped.

### Document build, bulk and erasure

- Touches: `documentActions` builds one action per requested ID in its anchor partition; visible nonredirected
  subjects index into `subjects-g<generation>` by `_id`; missing, hidden, taken-down or redirected subjects delete by
  `_id`. External version is the snapshot partition position. After the subject snapshot, indexing reads public
  collection counts once per chunk for visible, nonredirected subjects it will index (one primary-key statement, at
  most 256 rows; no read when none will be indexed). At most one `_bulk?refresh=wait_for` request per nonempty chunk
  (none without relevant IDs),
  at most 2b NDJSON lines; no target traversal or SQL write. Grow N/P/H with b and subject payloads fixed.
- Bound: At most b root documents written/deleted. Each indexed subject costs 1 + F Lucene documents: the root
  plus one nested document per facet-capable statement. A relation property's contribution is at most 128 distinct
  values plus its overflow marker; repeated relation witnesses for the same pair do not multiply indexed facts.
  Bulk size still includes each fact's Q qualifiers, existing descriptive/name payloads and the subject's declared
  property set. For `c` nonempty source chunks, each indexing batch adds at most `c` listing reads, each one
  primary-key statement for at most 256 rows, constant in N stored subjects and number of Collections. There is no
  listing read when no documents will be indexed. Requests stay `c` snapshot reads, at most `c` listing reads and
  at most `c` bulks whatever F. No SQL writes.
  Kernel work is linear in selected fact/value bytes except sorting each subject's labels; there is no document byte
  cap, so growth checks fix payload sizes. Bulk item validation is `O(b)`; failure prevents checkpoint advance. The
  document adds an overflow property list only when needed and one integer listing-count field.
- Acknowledgement binds every native item, in submitted order, to the action's operation, `_id` and selected
  physical `_index`. A successful index/delete must return exactly the submitted safe external `_version`, a
  consistent status/result pair (`201/created`, `200/updated`, `200/deleted`, `404/not_found`), safe native sequence
  and primary-term metadata, and complete successful shards with no failures. Optional `forced_refresh` remains
  native metadata; ordinary `refresh=wait_for` success does not require that field. Success with an error, wrong or
  missing identities, duplicate/reordered/partial items, partial shards and contradictory top-level `errors` fail
  the entire batch. A native missing-document delete proves a delete operation, rather than a generic 404 success.
- A keyed `409/version_conflict_engine_exception` retains the actual engine error shape, including its physical
  index and shard identity. It has no winning version or success shard metadata. Only this native failure is
  accepted, followed by the existing whole physical-index `_refresh` and explicit complete shard validation.
  Neither the error text nor a guessed winner body is interpreted as proof. No per-document Source reread or new
  database relation is introduced. Malformed responses, native failures and response loss leave `projectBatch` at
  its old checkpoint; genuine replay can conflict with already executed writes and settles only after visibility.
- Added adapter cost: inspect the submitted actions and aligned native response once, `O(b)` items and response
  bytes with fixed native fields per action. One bulk plus at most one existing conflict refresh per chunk;
  no target-population or historical-receipt traversal. Explicit refresh still performs native engine work.
  [Native receipt tests](../../test/search/bulk-visibility.test.ts) record full request/result identities and parsed
  response byte/call accounting at unrelated populations `[4, 32, 256]` with fixed actions, multi-key conflicts,
  rejection and response-loss/replay. This measures the adapter request bound, not Lucene ingestion cost or timing.
  [Checkpoint recovery tests](../../test/search/indexer.test.ts) include the original indexing/source-chunk suites
  and real PostgreSQL failure/replay schedules, including partial native item failure and response loss after write.
  Their controlled Source isolates this boundary; it does not certify Source completeness, Auth/Access, disclosure,
  physical incarnation or prevention of resurrection after native delete-version pruning.
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
  deduplicates by anchor, then chunks each home to at most 256 IDs. For home `p` with `u_p` targets, it makes
  `sum_p ceil(u_p/256)` source calls; homes run with concurrency <= 8 and chunks within each home are sequential.
  No target read when no kept
  value is an item.
- Bound: Rows and statements are constant in N and P (partition rows) at fixed s and property count. Each source
  read has the Source snapshot bound at fixed ids; blocks are logarithmic. A same-home 320-target label operation
  makes two source calls; 1,200 hit-property targets in one home make five when admitted by the product. Multi-home
  input uses the sum of per-home ceilings, not a ceiling over the total. Empty input makes no calls; a later source
  failure rejects the operation. Chunking creates neither a privacy/absence certificate nor a cross-chunk
  transaction. Per hit, one scan of its statements.
- Growth check: [test/search/growth-facets.test.ts](../../test/search/growth-facets.test.ts): “Search hit facts stay
  within their bound as N grows” at scale units `[1, 4, 16]`.

### Facet counts

- Touches: existing aggregation machinery samples matching subjects and reads item value labels through the native
  source. Those label checks do not check every contributing subject or fact.
- Bound: the initial public Search wire omits all totals, including verified rating lower bounds. Omit unsafe engine
  totals and facet counts over unchecked populations. Existing sample/overflow lower-bound behavior describes
  partial implementation, not a privacy-safe aggregate; approximate/as_of and zero/row-length substitutes are not
  permitted. Future safe aggregates require separately admitted complete disclosure dependencies
  and query-level privacy acknowledgement. The adopted count-free discovery wire is owned by
  [Public facet discovery](../../../../docs/search-facets.md); it does not make this preview complete.
- Growth check: existing facet/overflow tests retain their scoped evidence. Native paused-indexer local/foreign
  reduction, NOT and order/count cases and three-scale engine/native captures remain required before safe aggregate
  claims; the shared matrix in [Filtered lists](../../../../docs/filtered-lists.md#shared-acceptance-matrix) owns outcomes.

### Disclosure and result projection

- Touches: current source/Collection, original and terminal eligibility and Access; complete fact/source/target/
  consent/fence dependencies; summary fields; query-level safety observation before execution and before disclosure.
- Bound: derive per admitted direct/prepared plan, charging duplicates, rejects, lookahead, rereads, all dependency
  points and backend work. Existing per-call Source caps remain. The current `checkHits` sampled-witness/drop/refill
  path is partial implementation; it cannot certify query exclusions/order or useful pages. Missing, changed,
  unsafe or pending privacy acknowledgement means preparation/readiness. No cached permission or mandatory whole
  raw-fact replay is required by the replacement contract.
- Growth check: actual native/API first/deep/sparse pages at three scales, current fact/source/grant revocation,
  paused indexer with NOT/order/counts, dependent foreign repair, current cursor reauthorization and all owner pools.
  Existing relation-witness tests remain scoped evidence, not proof of the new complete list contract.

### Cursor and continuation

- Touches: The adopted Search contract uses the shared AES-GCM list-cursor Search profile, binding route/operation,
  canonical request hash and viewer, and encrypting generation, Global rating context, phase and last consumed native
  tuple. Each page uses `search_after`; no OFFSET, preceding-page enumeration or database cursor. See [Confidential
  cursor and bounded name sort](#confidential-cursor-and-bounded-name-sort). The runtime adapter migration and
  encrypted-token outcome proof remain pending.
- Bound: Zero SQL or engine I/O in the cursor codec; at most 8 tuple keys, 2,560 UTF-8 bytes per key, 3,072
  aggregate string bytes, 3,584 serialized bytes and 4,864 token characters. Position encryption uses a fresh random
  salt, a 15-minute lifetime including anonymous viewers and a 60-second future allowance. Codec and tuple size are
  independent of page depth; page consumption is `O(h)`. No kernel `O(d*s)` read from the start. Only settled result positions advance; an unresolved interval requires retained preparation/readiness.
  Acceptable lookahead stays unconsumed.
- Growth check: [test/search/service.test.ts](../../test/search/service.test.ts): “pages continue through signed tokens
  bound to the request and the principal” and “each request makes at most three index requests and reads only the
  partitions of examined hits” for the existing path. Encrypted-profile confidentiality and native phase cursor
  outcomes remain runtime proof requirements.

### Global rating phases

- Touches: Each page resolves one physical generation and brackets its native epoch context; each refill round sends
  at most two phase searches, including count-only work, then checks current figures in bounded source batches.
- Bound: At most 200 combined raw hits per round and 600 per three-round response; current-figure reads are batched
  by anchor partition, at most 256 figure IDs per source call. The initial public response omits totals, including
  verified `lower_bound` ratings. OpenSearch sort and count work is match-dependent;
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
  alias. Each listing resolves and pins the active generation, reads its bounded-sort mapping format, and resolves
  the alias afresh after all query, Source, cursor and freshness work, including empty results. Only concurrent start
  observations coalesce; the final observation belongs to that request. Grow N/P with generation set fixed.
- Bound: One resolve plus <= 1 mapping read per discovery; bootstrap adds three requests; zero SQL except
  separately listed retirement. At most three generations per prefix, so discovery enumerates at most three; no
  subject-document enumeration. Definition uses one shard/zero replicas; that does not prove kernel locality.
- Growth check: [test/search/indexing.test.ts](../../test/search/indexing.test.ts): “the runner creates the first
  generation, feeds every generation and follows pause and new generations”; no new SQL check for metadata-only
  requests.

Native metadata admission requires HTTP 200 and complete object/collection shapes. Resolve accepts at most three
unique exact `subjects-g<positive safe integer>` physical names, at most one exact `subjects` alias with one target
in that observed set, and no data streams. Physical attributes must describe an open index, optionally hidden;
closed, frozen and data-stream indices are unavailable. Native omission of an empty per-index `aliases` field is
valid. A present alias must agree in both the physical index's aliases and the alias receipt. Foreign names,
duplicate records (even identical ones), contradictory memberships, malformed or missing fields and oversized sets
raise `SearchUnavailableError` before admitting a query or rebuild. Empty namespaces and bounded initial,
rebuilding and retained older sets without an active alias remain valid discovery observations. Read helpers issue
no creation requests.

A concrete mapping response must contain exactly the requested physical name, an object mapping and object
properties. Missing legacy `_meta`/format or a well-formed unsupported nonnegative integer format yields no supported
format; malformed metadata is unavailable. The existing supported format check remains mandatory before queries and
rebuild publication. Mapping admission inspects metadata structure, not every field's schema or document population.

The native controls in [generation tests](../../test/search/generations.test.ts) and
[query generation tests](../../test/search/query-generation.test.ts) clone actual executed responses and retain raw
and corrupted receipts in the check log. They cover refused query starts with no native search or Source work,
refused final observations with populated and empty native hits, rebuild refusal, valid lifecycle states, physical
query pinning and restart409 after alias switches. Metadata observation uses one resolve, or one concrete mapping
request, with work linear in returned bounded metadata; unrelated index populations of 1, 4 and 16 add no requests.
This structural proof does not establish complete physical incarnation population, same-name/new-UUID safety,
source key equality, copy completeness, late-write pruning or erasure. No name/UUID cache supplies that proof.

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

### Scope direct and prepared plans

- Touches: named indexed matching streams or ready unique result rows, generation/control/epoch and privacy safety
  state, current source and disclosure dependencies, summaries, preparation frontier/result writes when needed.
- Bound: derive page work for filter + source + order, then aggregate the composed page (16 distinct reads,
  128 total output slots). Each page/step supplies the internal cost object and harness evidence specified by
  [Filtered lists](../../../../docs/filtered-lists.md#cost). Otherwise use admitted bounded preparation or reject
  before enumeration. No raw candidate256 or fixed-home sweep requirement is carried forward.
- Growth check: real same-service native API/default composition at three scales, first/deep/sparse results,
  two-release pins, epoch pending/restart, current foreign disclosure, interruption/replay and finite useful pages.
  Existing Scope admission/reservation tests describe superseded scaffolding and do not prove native execution.

### Hit label choice

Search hits, item facts, facet values and suggestions use the same label choice.

- Touches: the labels, descriptions and `schema:inLanguage` fact of subjects the final check already holds.
- Bound: no read, statement or engine request added; per returned subject, work linear in R ranges (at most 8) times its labels and descriptions.
- Growth check: none; no read changes. `test/search/facet-counts.test.ts`: "facet value labels follow the reader's language chain" and `test/search/service.test.ts`: "typeahead labels follow the reader's language chain" prove the choice.

## Producer integrity and remaining native delivery

The prior identity-home certificate/coverage storage, coordinator and no-write settlement exports are superseded
scaffolding, not the authority for the adopted indexed/prepared/identity-epoch lifecycle. Existing code and frozen
acceptance remain until reviewed native replacement acceptance permits removal. No repeated 8192-row basis sweeps,
per-page original walking or cancelled certificate ABI is required. Storage observations, helpers and format/type
checks do not prove complete identified population, current query privacy or actual default composition.

The following producer gaps remain required, independent of that superseded architecture:

- Complete Source chunking at **at most 256 IDs per native call**, including every tail and exact per-chunk source
  external version. No checkpoint before all actual writes are refresh-visible; later-chunk failure/replay cannot
  silently lose earlier or remaining work. The 64-envelope batch remains a separate native limit.
- Exact keyed sink operation results, rejecting wrong keys and success-with-error bodies. A 409 alone cannot prove
  visible success: establish the real superseding winner's refresh visibility and shard success before checkpoint.
- Actual bounded native name normalization in every default writer and replay/rebuild, preserving full display
  names, exact source versions and null/missing-last ordering for oversized normalized keys. Helper and cursor
  capacity proof does not establish default wiring or analyzer/ICU behavior.
- The canonical routeKey and current source-fence filtering in default worker, CLI and rebuild. Default composition
  must actually start the Semantic producer; no fake source or no-op module starter establishes that integration.
- No late older-write resurrection after real native delete-version pruning. A lost core CAS does not undo an
  external sink effect. Native competing-worker, ambiguous-response, crash/replay and actual pruning schedules must
  prove fencing under the adopted epoch/index lifecycle; do not invent a safety-token store to fill this gap.
- Complete identified new-generation population before atomic alias publication, including missing and extra keys,
  native partitions and actual physical identity. Empty targets or equal metadata counts do not prove correct keys.
  Preserve actual engine UUID, generation/name lifecycle and prevention of late accidental auto-creation. Keep
  per-partition reconciliation; counts alone cannot certify population.

`coverage.ts`/`coverage-projection.ts` unavailable exports and existing `coverage-store.ts` do not close these gaps.
Actual native acceptance/default composition/growth remain required through real commands, Access, source, engine,
worker and production rebuild, including pause/drain/restart/retirement and all owner pools. Existing adversarial
outcomes remain useful evidence; old protocol-specific home-certificate proof is not the replacement gate.

### Producer and generation maintenance cost

- Touches: shared outbox/runtime, actual bounded source chunks, normalization, keyed sink actions and refresh,
  checkpoint settlement, complete population/reconciliation, identity-epoch mapping/index maintenance and retirement.
- Bound: retain 64-envelope batches, 256 IDs per Source call and at most three live generations per prefix.
  Separately admit each step's actual keys, points, rows, statements/connections, bytes and engine operations and
  retain durable progress. Total replay/audit may follow finite source/log/index input; refresh/deletion are engine
  work, not constant metadata operations. No transaction holds a database connection across external I/O.
- Growth check: three geometric scales with real native/default-worker/API captures, all pools, first/deep/sparse
  pages, history/alias/duplicate axes, source tails, wrong-key outcomes, actual winner refresh, late writes after
  pruning, crash/replay and privacy changes. Performance supplies numeric allowances and captures. Existing
  certificate storage, helper or 256-proof checks do not establish this acceptance.
