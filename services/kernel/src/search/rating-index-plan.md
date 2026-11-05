# Global-only rating search implementation proposal

Status: **PROPOSAL, awaiting manager adoption**. This is an implementation/task split, not runtime delivery or a
new source authority. [First public scope](../../../../docs/scope.md) supersedes the Realm search-sort wording in
[Rating Display](../rating/README.md#display): first public search sorts only the public Global standard-question
aggregate. Realm sorts are deferred. One public subject index family carries one Global figure per subject; its
existing bounded generations are retained. No population-specific indices, private Realm routing, caller-selected
question/population, recommendations, profile work or subject-page work belongs to these slices.

## Existing surface and fixed decisions

Paths below are relative to `services/kernel/` unless explicitly prefixed otherwise.

- `src/search/source.ts` remains Semantic's subject authority. `src/semantic/search-source.ts` already enforces
  256 same-partition IDs and reads body and `core.partition.position` in repeatable read. Keep its interface and
  subject read/disclosure behavior. Do not add a shared Semantic signature or copy its authority into Rating.
- `src/search/indexer.ts` handles subject and library-listing events, deduplicates IDs, reads a whole body and
  writes strict external versions through `document.ts`. Its single source call can exceed 256 IDs today; chunk
  it as part of rating integration. `events/log.ts::projectBatch` releases its snapshot before `apply`, then
  compare-and-advances only to the last consumed envelope, not to the later source snapshot head.
- `src/rating/aggregate-effect.ts` applies native changes in target-partition commands but its existing
  `com.rezics.rating.aggregate.applied.v1` contains only `{ applied }`, without a subject. Voter-partition vote
  events cannot stand in for committed subject-anchor publication. `src/command/command.ts` and
  `src/command/fence.sql` commit state, partition head and outbox together. Content owns new bounded invalidations.
- `src/rating/aggregate-read.ts` is not the incoming Bayesian source: its current mean uses storage units and its
  figure includes a histogram. Search must consume the independently landing `src/search/rating-source.ts`
  contract: `PublicRatingSource.read(partition, ids)` accepts at most 256 and returns
  `{ partition, position: bigint, figures: Map }`; `epoch()` returns
  `{ questionId, populationId, priorEpoch: null | positiveInteger }`. These are fixed public keys, never inputs
  selected by the request. The standard question is `STANDARD_QUESTION_ID` in `src/rating/votes.ts`.
- Each typed public figure has `questionId`, `populationId`, `subjectId`, `count`, `mean`, `score`, `priorEpoch`,
  bigint-decimal `revision`, and `asOf`. Mean and score are independently nullable display-unit 0–10 values.
  Preserve the source's published precision; do not derive a mean from a score or recompute a prior in Search.
  Validate keys, routed IDs, safe nonnegative count, finite display values, epoch and decimal revision.
- Subject publication thresholds are 5 votes for work/release and 10 for finer grains. Population prior eligibility
  requires at least 50 native votes of this same question and Global population. A publishable mean does not
  imply an eligible score. Content owns native aggregate/prior inputs, fixed `m` per epoch, grain resolution and
  below-50 invalidation. Imported statistics never become native votes. Score zero is scored; null/absent is not.
- Candidate order is current published Bayesian score descending, unscored last, then `name_sort`, then `id`, both
  ascending. The index stores numeric nullable `rating_score` and its prior epoch, plus only necessary public
  figure provenance. No raw sum, histogram, voter key, own vote, Realm count or Realm identifier enters it.
  Keep existing response fields; this sort does not require a new card/figure response schema.

## Coherence and effective order gates

A local Search decorator can read Semantic and Rating independently in repeatable read, compare the **same partition**
positions, and retry the entire pair at most three times per <=256-ID chunk. Accept only matching requested and
returned partitions, equal positions, and a position at least the last consumed envelope position for that partition.
Build every replacement body and figure from that accepted pair, and use that position as its external version.
Never take `max(bodyPosition, figurePosition)`, use figure revision as an engine version, or attach a newer figure to
an older body. A typed snapshot-unavailable error after mismatch/exhaustion leaves the checkpoint unchanged; no
partial chunk success permits advancing the batch. Reject unsafe numeric external versions as `document.ts` does.

This equality is sufficient for anchor-owned state **only if** every change to the indexed figure, including prior
republication, changes the subject partition head in the same transaction as that publication. A voter head, aggregate
revision, relay checkpoint or timestamp is not that fence. Equal positions in two RR snapshots then denote the same
committed anchor state; newer native effects receive a later anchor position. Read-ahead is safe: later relay batches
reread current state and equal/older strict external conflicts cannot overwrite it. This does not make separate
snapshots globally atomic. Cross-partition epoch changes require the separate metadata checks below. Existing
cross-partition Semantic fences, repair and current disclosure checks remain necessary; head equality alone does not
prove their completeness. Separately read library counts are not a new rating coherence guarantee.

Content must confirm that its figure snapshot meets this anchor invariant. If it computes a new score directly from
mutable remote prior state at the same local position, equality is insufficient. Require durable anchored publication
or a bounded composition port from Content before implementation proceeds; do not invent a shared Semantic interface.
Missing figure means unscored only when the source guarantees a complete successful read; source failure is unavailable.

Read native `epoch()` before engine admission and again before response/cursor issuance, without reusing the last
cached nonnull epoch as proof of current eligibility. A changed tuple restarts the operation; bounded exhaustion is
retryable unavailability. A below-50 state has null epoch, even if a prior used to exist. An epoch must not be reused
after invalidation: otherwise a cursor issued before 50→49→50 could become valid again. This needs a Content guarantee.
The tuple alone also cannot distinguish two null-eligibility intervals separated by a valid epoch. Before offering
null-epoch continuation, resolve this ABA case with a durable validity marker covering the native point read or an
adopted restriction on those continuations; do not claim the nullable tuple proves transition history.

Define effective score for document d and current epoch e as d.rating_score only when e is nonnull, the document's
prior epoch equals e, and its score is present; otherwise it is unscored. Thus old-epoch documents cannot outrank
current unscored subjects. A plain descending nullable field sort does **not** implement this rule.

Two engine alternatives await the separately dispatched primary-source epoch research and manager selection:

- A conditional static script supplied with trusted current epoch/eligibility, producing effective score order plus
  the existing name/id ties. Prove missing/null/zero handling, allowed script context, returned keyset types and
  behavior on the pinned engine. This is a candidate, not a recommendation or a script implementation from memory.
- Materialized epoch-consistent generations: prohibit rating queries until a generation has complete current-epoch
  materialization and reconciliation; switch the alias only after proof. While current epoch is null, all subjects
  can use name/id unscored order without consulting stored scores. During eligible-epoch repair, return retryable
  unavailability rather than ranking stale values. Prove the synchronization and readiness barrier durably.

In either case, source publication thresholds and its declared freshness bound apply to subject changes; no claim
of synchronously live vote order follows. Current subject disclosure still drops/refills hidden/taken-down hits.
Rereading and sorting only a truncated candidate page cannot repair global rating order or complete recall.

## Proposed implementation slices

Each numbered slice is medium-sized, with its own failing tests before implementation. New test paths/titles below
are dispatch requirements, not tests delivered by this document. Content ports and engine selection are external
landing gates; slice numbers are local dependencies, not assigned task identifiers.

### 1. Typed Global document projection

Paths: `src/search/document.ts`, `db/search/indices/subjects.json`,
`test/search/rating-document.test.ts` (new), `test/search/index-definition.test.ts` (add cases).
Depends on the independently landing `src/search/rating-source.ts`, not a replacement reader designed here.
Add the typed Global decorator/projection with numeric `rating_score`, epoch and minimal provenance. Use no
truthiness coercion; retain delete behavior and clear previously scored fields on a successful null/missing figure.
Failing titles: “Global rating projection preserves score zero and separates mean from score”; “unpublished and
missing figures cannot leave a previous score indexed”; “private or mismatched figure keys are rejected”.

Cost:

- Touches: one semantic body and at most one public figure per ID; no population enumeration or vote reads.
- Bound: O(u) transformation and document bytes for u selected IDs with fixed existing body budgets; <=256 per call.
- Growth check: grow unrelated subjects, votes and Realm figures with u/body size fixed; assert identical public
  field set, numeric mapping and payload bound, including absence of all private fields.

### 2. Coherent bounded snapshot decorator

Paths: `src/search/rating-snapshot.ts` (new local helper), `src/search/indexer.ts`,
`test/search/rating-snapshot.test.ts` (new), `test/search/indexing.test.ts` (add cases).
Depends on slice 1 and Content's anchor-position guarantee. Implement the paired reads, partition checks, batch
chunking and bounded retries above without changing `SubjectSource`. Preserve Semantic authority and current deletes.
Failing titles: “a newer figure never versions an older semantic body”; “snapshot mismatch exhausts bounded retries
without advancing the checkpoint”; “more than 256 changed subjects are indexed in bounded chunks”.

Cost:

- Touches: b event changes, u distinct subject IDs, <=3 paired source reads per chunk, existing listing reads.
- Bound: O(b + u) kernel work with <=6 ceil(u/256) paired-port calls; each port must independently prove its SQL bound.
- Growth check: increase unrelated and same-partition history fixing b/u and selected facts; observe statements,
  examined rows/shared blocks and retries, not just returned map length. Check ahead-of-envelope and wrong-partition cases.

### 3. Publication invalidations and replay

Paths: `src/search/indexer.ts`, `test/search/rating-indexing.test.ts` (new).
Depends on slice 2 and Content's committed subject-anchored event schema. Consume the actual new registered event,
coalescing subjects across semantic/library/rating changes; never fabricate an event type or parse aggregate `{ applied }`
as a subject. Content owns registration and publisher changes under `src/rating/` and `src/events/`; their actual
paths and task assignments await its port landing. Preserve `refresh=wait_for`, per-item validation and checkpoint CAS.
Failing titles: “coalesced publication events reread the newest complete subject”; “late and duplicate rating events
cannot resurrect a hidden subject or older score”; “partial bulk failure and snapshot unavailability retain checkpoint”.

Cost:

- Touches: <=64 envelopes per `projectBatch`, b events, u deduplicated anchors and u full replacement/delete actions.
- Bound: O(b + u) plus source bounds and engine writes; command-produced batches allow b<=64,000, not 256 total IDs.
- Growth check: grow outbox history fixing b/u; inject late events, crash after refresh before CAS, restore, takedown
  and duplicate execution. Assert consumed-envelope checkpoint, not read-ahead head, and eventual replay convergence.

### 4. Current epoch ordering and stored template

Paths: `src/search/query.ts`, new `db/search/templates/subjects-search-v3.json`,
`test/search/rating-query.test.ts` (new), `test/search/query.test.ts` (add template cases).
Depends on slice 1 and adopted engine research/alternative. Preserve released v1/v2 template files and IDs.
Install/version the new template through `installTemplates`; encode parameters with the existing safe `toJson`
conventions. Implement effective score above across the full engine candidate set, never a text-prefix rerank.
Failing titles: “rating order is score descending then name and id with zero before null”; “stale prior documents
are unscored under the current epoch”; “an all-unscored population uses deterministic name and id continuation”.

Cost:

- Touches: one existing public alias per engine round and constant epoch parameters; no extra population index.
- Bound: existing <=3 rounds, <=200 candidates per round; engine execution cost must be measured for the selected
  alternative and is not O(600) merely because at most 600 hits return. Materialization is affected-set background work.
- Growth check: grow engine documents and stale-epoch fraction with page size fixed; record query profile/latency,
  candidate budgets, keyset parity and readiness failures. Verify actual pinned-engine behavior, not mocked sort JSON alone.

### 5. API admission and signed cursor eligibility

Paths: `src/search/service.ts`, `src/search/cursor.ts`, `src/search/http/routes.ts`,
`test/search/rating-service.test.ts` (new), `test/search/contract.test.ts` (add cursor cases).
Depends on slices 2 and 4 plus the native epoch point read. Add `sort: 'rating'` validation on both existing search
routes; retain existing result schema, authorization, disclosure, consumed lookahead and inexact-total cursor binding.
Bind signed continuation to fixed Global population, standard question, CURRENT prior eligibility/epoch, generation,
canonical request and principal. Valid incompatible tokens require `search_restart_required`; signatures remain
validated and malformed/forged tokens remain invalid input. Recheck epoch before emission, including empty pages.
Failing titles: “rating cursors restart after prior change or below-50 invalidation”; “rating continuation binds
Global question generation request and viewer”; “caller population and question overrides are rejected on both routes”.

Cost:

- Touches: two bounded public epoch point reads per attempt, engine candidates, existing partition-batched subject
  disclosure; never enumerate memberships, questions or populations. Metadata failure returns retryable unavailability.
- Bound: propose at most two whole-operation attempts on epoch change; existing limit<=100 and h<=600 per attempt.
  Native metadata is a public indexed point read of one fixed question/Global key, constant rows and logarithmic
  index blocks, not a vote aggregation on each request; Content must prove that SQL path.
  No offset/page-depth scan, live exact count claim or point-in-time search promise is added.
- Growth check: grow N/page depth fixing h and selected resources; observe SQL rows/blocks and source-call ceilings.
  Test null epoch versus cached old nonnull epoch, 50→49→50, epoch change mid-request and existing token tampering.

### 6. Generation replay, reconciliation and alias readiness

Paths: `src/search/generations.ts`, `src/search/runner.ts`, `src/search/indices.ts`,
`test/search/rating-generations.test.ts` (new), `test/search/generations.test.ts` (add cases).
Depends on slices 3–5 and Content's bounded subject-anchor publication/republication pager. Carry ratings through
all live generation consumers, replaying semantic creation for unrated subjects too. Existing quiet-head count checks
prove subject membership only; add rating publication/epoch progress reconciliation, including pages completed with
no count change. Persist readiness/progress so restart cannot certify an incomplete generation. Preserve mapping
metadata when writing `activated_at`; atomic alias switch, old-cursor restart and retirement still use existing paths.
The runner's immediate first empty-generation activation cannot itself certify rating readiness.
Failing titles: “equal subject counts do not activate an incomplete rating epoch”; “rebuild restart reconciles
Global figures and preserves unrated subjects”; “alias switch invalidates rating cursors and retires only old generations”.

Cost:

- Touches: <=3 live generations, 4,096 partition coordination entries and bounded Content publication pages.
- Bound: each proposed Search page admits <=256 anchors; total rebuild/epoch rotation scales with affected subjects,
  history replay and live generations. No full subject scan is permitted on one vote or HTTP request.
- Growth check: independently grow total subjects and partition history fixing page size; observe page SQL blocks,
  durable continuation, generation checkpoint progress and bounded concurrency. Interrupt before/after alias switch.

### 7. Default worker, server and CLI composition

Paths: `src/search/work.ts`, `src/search/runner.ts`, `src/server.ts`, `scripts/search.ts`,
`test/search/rating-composition.test.ts` (new), `test/search/support/outcome-worker.ts` (rebuild control).
Depends on slices 3, 5 and 6 and Content's actual factory export. Inject that factory into the default Search starter
and HTTP service; the API does not start a relay. CLI `rebuildSubjects` currently takes only Semantic source/counts
and a no-op refresh (the worker discovers generations); wire epoch readiness through that real path too. The outcome
worker's direct rebuild control must use identical dependencies. `src/work/modules.ts` already includes Rating and
Search: do not add a duplicate module, change their order, or assume registration order synchronizes effects.
Failing titles: “configured server default worker and CLI use the same fixed Global publication”; “rebuild control
cannot bypass rating readiness”; “shutdown drains the active replacement Search runner”.

Cost:

- Touches: configured readers and existing generation consumers; normal server starts no indexing worker.
- Bound: one public family, <=3 live generations; existing shared-pool partition discovery remains global coordination,
  not evidence that independently placed partition databases work. No growth with number of Realms.
- Growth check: observe real registrations/start counts, startup failure cleanup and sequential/concurrent fixture
  isolation; grow unrelated Realms and verify identical Search services, index families and coordination bounds.

### 8. Native-vote API outcomes and bounded-growth proof

Paths: new `test/search/rating-outcomes.test.ts`, new `test/search/growth-rating.test.ts`,
`test/search/support/outcome-supervisor.ts`, `test/search/support/driver-client.ts`,
`test/search/support/outcome-worker.ts` (test-only controls/provisioning where necessary).
Depends on all preceding slices and native Content prior/publication readiness. Use the existing isolated Auth
supervisor and real `startWorker` child with the entire imported `KERNEL_WORK_MODULES`; preserve IPC deadlines,
resource ownership, one SDK per process and drain-before-cleanup. Existing driver/support code now has these paths;
the harness README's pending verification is not proof that native rating outcomes passed.
Failing titles: “native votes change public rating order through the default worker”; “threshold and prior loss
remove scores through real publication”; “rating order converges after outage replay rebuild and source restore”.
Use actual vote/change/clear including zero, subject 4/5 and 9/10 where native grain permits, population 49/50,
suspension/reinstatement, controller rekey, merge survivor/removed target, account erasure, target takedown/restore,
Search-only pause/resume and replacement stop, engine outage/recovery and crash recovery. Cover simultaneous semantic
rename and rating change; a high-rated subject beyond an initial text prefix; private Realm changes never leaking
fields or substituting figures. Inject faults at transport/lifecycle boundaries, not fake native aggregates or direct
index/checkpoint writes. Content must supply any missing native grain/prior controls, not a Search-only fake.

Cost:

- Touches: real vote→aggregate→anchored publication→Search relay→HTTP chain plus isolated SQL/engine instrumentation.
- Bound: 16 native shards, <=256 anchors per source/page call and fixed candidate/retry budgets above. Population-wide
  prior repair and account erasure have finite affected-set work, not constant total work or a universal latency SLA.
- Growth check: independently grow unrelated subjects, same-partition rows/history, native voters and Realm figures,
  fixing the selected neighborhood/page. Assert examined rows/shared blocks, statements, payloads, affected anchors,
  engine targets and full finite convergence after writes stop. Include pinned-engine stale-epoch ordering proof.

Preserve the exact frozen original **13** cases in `specs/search-outcomes.test.ts` and **6** cases in
`specs/search-relation-facets.test.ts` (repository-root paths). Run their unchanged `test/search/outcomes.test.ts`
and `relation-facet-outcomes.test.ts` wrappers with every declared case executed, zero skipped/todo, plus
`test/search/real-source-composition.test.ts` and the new rating API suite on both existing routes. Do not edit or
weaken frozen suites to accommodate rating. Run `bun run --cwd services/kernel check` for the eventual runtime
integration, honoring queued test slots; unit mocks or starter construction alone cannot establish the API proof.

## Remaining landing gates

Content must name the native factory, committed subject event schema and bounded publication/page exports, confirm
same-position immutability, complete-read missing semantics, revision/asOf precision and pending-update/freshness
behavior, and supply epoch invalidation/nonreuse plus durable republication progress. Null-epoch continuation needs
the transition-history gate above; do not add an unapproved field to the independently landing interface. The small `rating-source.ts`
contract is independently landing; these requirements do not authorize Search to redesign it. Exact Content task
assignments remain pending. An arbitrary population/query selector is never a missing dependency.

The separately dispatched primary-source engine research must resolve conditional sort feasibility/performance versus
materialized readiness, null keyset representation, durable reconciliation metadata and alias races on the pinned
engine. This proposal intentionally leaves that choice open; it recommends no unverified OpenSearch mechanism.
All-unscored/null-epoch order and retryable unavailability during unsafe eligible-epoch repair are the proposed safe
behaviors for adoption. Profile/pages and Realm product behavior remain independent work. Only this proposal changes;
no product, tests, shared interfaces, authority documents or frozen files are delivered or amended here.
