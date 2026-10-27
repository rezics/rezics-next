# Population rating search implementation proposal

Status: **PROPOSAL**. This is a task split for review, not delivered runtime, an adopted source contract, or a new
authority. Shared decisions below require adoption before dependent implementation. Authority remains
[first public scope](../../../../docs/scope.md), [Rating thresholds, privacy and display](../rating/README.md), and
[Search](README.md). Content's bounded figure source contract is pending; this proposal specifies required ports
without designing or copying its storage tables. No product code or acceptance tests are delivered here.

## Observed integration surface

- `source.ts` exposes `SubjectSource.read(partition, ids)` and `count(partition)`. Semantic's
  `../semantic/search-source.ts` rejects more than 256 IDs and reads subjects and partition position in one
  repeatable-read transaction. Its `search-source-position.sql`, `search-source-subjects.sql` and
  `search-source-count.sql` use the partition head, routed subject probes and maintained partition count.
- `indexer.ts` currently collects subject events and `com.rezics.library.subject.listed.v1`, not rating events.
  It passes all distinct batch IDs to one source call, so a large envelope can exceed the actual 256-ID limit.
  `document.ts` replaces whole documents using snapshot position as strict external version, including deletes.
  It rejects versions above JavaScript's safe integer range. Listing counts are read separately; that pattern
  cannot establish a coherent semantic-plus-rating snapshot.
- `../rating/aggregate-effect.ts` applies changes through target-partition commands, sums at most 16 component
  shards, and emits `com.rezics.rating.aggregate.applied.v1` containing only `{ applied }`.
  `../rating/aggregate-component-apply.sql` keys by route/question/population/target/shard;
  `../rating/aggregate-read.sql` also probes population freshness. A vote event in the voter partition is not a
  search-ready target event. `../rating/aggregate-read.ts` publishes a different figure with histogram and a
  two-decimal mean in storage units; it is not the proposed Bayesian source.
- `query.ts` supports relevance/name/id/collections, using a subject alias and stable IDs; `service.ts` validates
  those sorts, batches current disclosure, refills for at most three candidate rounds and signs continuations.
  `cursor.ts` binds canonical request and principal, with generation in the signed payload. No rating epoch exists.
- `generations.ts` replays through generation consumers, waits for checkpoints, compares partition counts over
  quiet heads, then switches the alias. Count equality alone cannot detect stale rating values. `runner.ts`
  starts with an immediately active empty first generation and retires old generations after a grace period;
  neither behavior proves population completeness or prior coherence.
- `work.ts` actually mounts `startSearchIndexing` with Semantic and listing sources when configured.
  `../work/modules.ts` includes both rating and search modules; registration order does not order asynchronous
  effects. `../server.ts` mounts `createSearchService` with `subjectSource(pool)`, and no rating source.
  `../http/kernel.ts` mounts search routes. `http/routes.ts` admits a Global subject-read resource and passes
  principal plus body to the service; no authorized routed population context is passed today.
- Inspected tests include `test/search/indexing.test.ts`, `generations.test.ts`, `service.test.ts`, `server.test.ts`,
  `real-source-composition.test.ts`, `growth-facets.test.ts` and `test/rating/aggregate-http.test.ts`,
  `public-reads.test.ts`, `eligibility.test.ts`, `segment-job.test.ts`, `growth-votes.test.ts` (all under
  `services/kernel/`). Existing source mocks and worker construction are not proof of native-vote rating search.
  The outcome harness README explicitly distinguishes its contract from passing real-worker evidence.

## Candidate ports and invariants

Propose a content-owned immutable `PublishedRatingFigure`:

```ts
type PublishedRatingFigure = {
  questionId: string;
  populationId: string;
  subjectId: string;
  count: number;
  mean: number | null;
  score: number | null;
  priorEpoch: number | null;
  revision: string; // Canonical nonnegative bigint decimal, never a JS number.
  asOf: string;
};
```

The standard question stays fixed, including in a Realm (`STANDARD_QUESTION_ID` in `../rating/votes.ts`, currently
`00000000-0000-7000-8000-000000000001`). Its current question grain is not permission to combine other questions
or episode/release measurements; content must supply the correct target-grain contract. Global is the general site's population; a Realm-routed
site or Zone uses its authorized Realm population. No custom-question discovery or recommendation service is added.
Convert native 0–20 units to displayed 0–10 before publishing: `mean = sum / n`,
`score = (C * m + sum) / (C + n)` in displayed units, with `C = 5` for work/release and `10` for finer grains.
Round published mean and score to four decimals; sort the published score, not a hidden higher-precision value.
`m` is fixed for one epoch and derived from at least 50 native votes of that same question and population.
Below the subject grain threshold, mean and score are null; below 50 population votes, score and priorEpoch are
null even if a subject mean is publishable. Zero votes are unscored. A valid score of zero remains scored.
Count remains public subject-aggregate count under the population read policy, including below threshold;
no histogram, sum, voter identity or private counting key enters the search document or hit.
Reject negative/unsafe counts, nonfinite scores and malformed revisions instead of silently rounding identifiers.

Candidate exact search-facing ports, to align with content's eventual contract:

- `RatingFigureReader.readInSnapshot(client, { partition, subjectIds, populationId, questionId, priorEpoch })`
  returns aligned figures or explicit zero figures for at most 256 same-partition subjects. Missing source,
  incomplete publication and unauthorized population are errors, not zero figures or Global fallbacks.
- `RatingPartitionPager.page({ partition, populationId, questionId, afterSubjectId, limit })` returns at most
  500 current subject anchors, a durable continuation and a snapshot watermark. This is a background rebuild
  port, not an HTTP candidate list; semantic enumeration must include unrated readable subjects as well.
- `RatingPublicationState.read({ populationId, questionId })` returns active prior epoch, validity revision,
  publication readiness and source watermarks. A small indexed metadata read must detect an invalid prior
  before engine admission and again before response/cursor emission.
- `PopulationSearchAdmission.resolve(trustedRoute, actor, authorization)` produces an internal authorized
  population/question binding. The transport and route shape remain undecided; a caller-supplied population
  field or invented header cannot implement this port.
- A composed `RatedSubjectSnapshotReader.read(partition, ids, binding)` returns semantic subject state, rating
  figures and one partition position from the **same** anchor snapshot. Extend Semantic's transaction through
  an injected snapshot reader or expose a shared transaction-scoped reader; sequential independent reads do
  not qualify. The content publisher must first commit subject-anchor publication plus an anchor event and
  advance that partition position atomically. Its revision is not itself the engine version.

Every full replacement in a population index must include semantic body, visibility/security revision, figure,
epoch and invalidation state covered by that single position. Reading body at position 40 and rating/head at 42
must never produce a version-42 document. Equal external versions must imply identical indexed payloads.
Population metadata that lives elsewhere needs durable anchor publication before replacement; attaching a newer
head afterwards is unsafe. Fail publication rather than converting an unsafe bigint version to a number.

Rating application ordering is: native vote command → aggregate effect → committed figure/anchor publication
and outbox event → search snapshot → successful refresh-visible bulk items → checkpoint compare-and-advance.
Crash/retry must leave publication invalidations durable and idempotent; failed bulk items cannot advance the
checkpoint. Extending the aggregate event must name affected subject/question/population, including clears,
merge survivor and removed target. Search must not acknowledge a vote event before its aggregate is applied.

## Population isolation and lifecycle

Candidate preference: a physically separate subject-search index family per admitted population, with the full
searchable semantic projection and exactly one standard-question figure per subject. The public subject family
may carry Global only. Private Realm values, including counts and membership markers, never enter that family.
All reads, generation discovery, freshness and retirement must be scoped to the admitted family. Engine credentials
stay internal; current Realm readability and current subject disclosure are checked before returning figures.

Compared alternatives: unbounded per-subject Realm arrays fail bounded payload/update requirements and risk private
disclosure. A shared private-only population-keyed document family avoids one index per Realm but requires mandatory
population isolation on every operation and duplicates semantic bodies too; shard sharing and deletion isolation
need an adopted design. Fetching top text candidates then sorting their figures misses a higher-rated subject
outside the prefix. A rating-only index cannot apply arbitrary existing text/facet predicates without an actual
supported join; no engine join is assumed. None of these alternatives licenses public fallback for private scope.

Explicit isolation has real cost: for `R` provisioned Realms and `g <= 3` generations per family, primary shards
are `(R + 1) * g * s` for `s` primaries per generation, multiplied by `1 + replicas` for shard copies. Duplicating
all `N` subjects costs `O((R + 1) * g * N)` documents. Even restricting to Realm-rated subjects would lose unrated
search results. A semantic edit can fan out to every provisioned family; the voter membership cap of 100 Realms
does **not** bound that fanout. A durable family registry/reverse dependency pager must dispatch bounded pages,
with total work proportional to affected families and generations. Provisioning quotas and shard strategy need
adoption; no constant global update cost or wall-clock convergence promise follows from bounded pages.

Fixed `m` prevents every vote from reranking the whole population. A 50→49 transition invalidates the epoch in
one metadata operation; admission suppresses the obsolete score ordering until a ready replacement exists.
Do not synchronously rewrite every subject, or keep using a stale prior while repair runs. Requalification,
scheduled epoch changes and prior erasure use resumable partition pages and a staging generation; no request scans
population votes. A 5→4 or 10→9 target transition updates that anchor's figure to null. Prior invalidation and
security changes must also invalidate continuations. Recheck state after in-flight engine reads. For a subject
privacy-threshold crossing, propose one family validity-barrier update coupled durably to the anchor publication,
then release serving only when active-generation refresh/checkpoint evidence covers that invalidation. This bounds
the synchronous invalidation, although it can temporarily block the family's rating sort; ordinary score changes
retain the declared asynchronous freshness. A final hit-only check cannot prevent stale private scores affecting
candidate order. Adoption must settle the barrier coupling across partitions; no cross-partition atomicity is assumed.

Rebuild/replay must reconcile epoch, per-partition publication watermarks and figure revisions/digests as well as
visible counts; publish an alias only after semantic and rating replay plus durable fanout are caught up. Initial
provisioning must use this barrier too. Keep old consumers until retirement is safe, but reject cursors incompatible
with the newly active family generation/epoch. Source restore must replay current anchor state and fence stale
pre-restore events; takedown, merge, account erasure and membership removal must invalidate publication before
disclosure, durably remove/recompute affected figures and copies, and converge through normal workers. A source
statistic import is never a native vote. Restrict erasure rebuilds to their indexed affected anchors/populations;
whole-population epoch rebuilds are explicit asynchronous work, not hidden point operations.
Replay after engine delete-tombstone expiry needs a durable source/version fence or fresh generation: a delayed old
index action must not resurrect an erased document because the engine no longer retains its delete version.
Include that case in outcome tests.

## Proposed independently testable tasks

Paths below are literal candidate edits, not permission to edit frozen assets. New versioned mapping/template files
are used instead of changing released templates. Estimates are implementation lines excluding test fixtures;
each task has a failing test to add in its named test file. Tasks can develop against agreed ports independently;
the dependencies name the integration gates, not a claim that all can land unordered.

### 1. Composed snapshot port (about 280 lines)

Paths: `services/kernel/src/search/source.ts`, `services/kernel/src/search/rating-source.ts` (new),
`services/kernel/src/semantic/search-source.ts`, `services/kernel/test/search/rating-source.test.ts` (new).
Depends on adopted content snapshot/publication ports. Expose the composed transaction and validate aligned IDs,
partition, figure shape and epoch, without owning content's tables.
Failing test: “rated subject snapshots never attach a newer position to an older semantic body”.

Cost operation: snapshot read.

- Touches: one partition head, up to `b <= 256` semantic anchors and their selected population figures; at most
  16 aggregate shards per anchor if the adopted source reads components, plus constant publication metadata.
- Bound: indexed point/range work `O(b * (L(P) + 16))`, not a population or Realm enumeration; retain Semantic's
  separately documented fact/witness budgets. `L(x) = log(2+x)`; `P` is partition data size.
- Growth check: grow unrelated subjects and same-partition history independently with b, facts and figure shards
  fixed; assert SQL rows/shared blocks and statement counts, not only returned rows.

### 2. Rating publication event bridge (about 300 lines)

Paths: `services/kernel/src/search/rating-events.ts` (new), `services/kernel/src/search/indexer.ts`,
`services/kernel/test/search/rating-events.test.ts` (new).
Depends on task 1 and content's committed target-anchor events, including threshold invalidations. Consume only
committed publication events, coalesce IDs by partition and chunk source calls to 256; aggregate/event producer
changes remain content-owned prerequisites rather than a second implementation here.
Failing test: “rating publication retries refresh-visible writes before checkpoint advance across 257 anchors”.

Cost operation: event projection.

- Touches: bounded outbox batch, changed anchor IDs, one selected family per dispatched job and bulk results.
- Bound: `O(b)` coalescing and document writes per family; source batches at most 256. Current relay permits
  64 envelopes with up to 1,000 command events each, so b is not inherently 256; envelope checkpoint waits for
  all chunks. Cross-family fanout uses a resumable page of at most 256 families, never an in-memory full list.
- Growth check: replay duplicate/out-of-order publication after newer edits; grow outbox history and family count
  with selected page fixed; measure anchor SQL rows/blocks and record total fanout completion separately.

### 3. Population projection and engine ordering (about 250 lines)

Paths: `services/kernel/src/search/document.ts`, `services/kernel/src/search/indices.ts`,
`services/kernel/src/search/query.ts`, `services/kernel/db/search/indices/subjects-rating-v1.json` (new),
`services/kernel/db/search/templates/subjects-rating-search-v1.json` (new),
`services/kernel/test/search/rating-index.test.ts` (new).
Depends on task 1 and an adopted isolation choice. Store only that family's permitted figure; order by published
score descending with null/missing last, then subject ID ascending. Zero-count rows must have null score.
Failing test: “rating ordering includes candidates beyond the text prefix and keeps scored zero ahead of null”.

Cost operation: index write and query.

- Touches: b complete single-population documents on write; one engine search on the admitted family per round.
- Bound: `O(b)` payload at fixed existing semantic payload limits, one fixed-size figure each; no Realm arrays,
  candidate truncation/resort or request SQL scan. Engine work depends on shard count and query selectivity.
- Growth check: grow N and provisioned families; assert constant figure payload and one family addressed; compare
  full ordered results including equal rounded scores, missing figures, nulls and zero scores.

### 4. Durable family fanout and rebuild (about 380 lines)

Paths: `services/kernel/src/search/rating-generations.ts` (new), `services/kernel/src/search/generations.ts`,
`services/kernel/src/search/runner.ts`, `services/kernel/test/search/rating-generations.test.ts` (new).
Depends on tasks 1–3 and content's paged anchors/publication watermarks plus adopted durable family registry.
Add staged first activation, repair/replay, invalid-prior barrier, reconciliation and retirement. Persist page
continuations through the adopted registry port; its storage must be separately specified before this task lands.
Failing test: “a 50 to 49 prior invalidation blocks stale ordering through rebuild crash and alias activation”.

Cost operation: rebuild, epoch invalidation and semantic fanout.

- Touches: one validity record on invalidation; background pages of at most 500 anchors per partition, split into
  source batches of 256; at most 256 family dispatches per fanout page; up to three generations per family.
- Bound: point invalidation `O(L(P))`; page `O(L(P)+500)` anchor enumeration plus snapshot/write costs; total
  rebuild `O(N)` per family/generation and edit fanout `O(R * g)` worst case. Periodic reconciliation spans up to
  4,096 partitions, like existing SQL; it is not per-request or portable cross-database SQL by implication.
- Growth check: grow N/R/history independently; assert page SQL rows/blocks and durable cursor progress, crash
  between pages, same-count stale-score mismatch, resume without duplicate effects and no premature alias switch.

### 5. Authorized population admission (about 200 lines)

Paths: `services/kernel/src/search/http/routes.ts`, `services/kernel/src/search/service.ts`,
`services/kernel/test/search/rating-admission.test.ts` (new).
Depends on adopted routed-context port; coordinate its actual transport integration separately. Pass the resolved
binding into search, fix the standard question, and reject unreadable/unready populations without data fallback.
Failing test: “a caller cannot select a private Realm population by body fields or replaying another route”.

Cost operation: admission and final population check.

- Touches: one trusted routed-context resolution, bounded Access checks and one publication-state key; never
  enumerate the viewer's memberships or readable populations to choose a headline.
- Bound: constant selected resources plus existing Access costs, independent of R; revocation is rechecked before
  response. Exact route and authorization batching remain owned by the shared admission contract.
- Growth check: grow unrelated Realms/memberships with selected route fixed; assert authorization SQL probes and
  no public-family engine query on denied, private or unavailable context.

### 6. Rating cursors and response projection (about 300 lines)

Paths: `services/kernel/src/search/cursor.ts`, `services/kernel/src/search/service.ts`,
`services/kernel/src/search/hits.ts`, `services/kernel/src/search/http/routes.ts`,
`services/kernel/test/search/rating-service.test.ts` (new).
Depends on tasks 1, 3, 5 and adopted invalidation semantics. Bind signed cursor to population, fixed question,
prior epoch/validity revision, family generation, canonical request and viewer. Incompatible valid continuation
requires `search_restart_required`; forgery remains invalid input. Reuse current subject disclosure and consume
rejected lookahead. Include only approved count/mean/score/epoch/revision/asOf with the population mark.
Failing test: “rating cursors restart on epoch generation or route change and never disclose a revoked figure”.

Cost operation: result page.

- Touches: current subjects and selected-population figures for examined hits, not all candidates in the index;
  publication validity before and after search. Count/as_of describe indexed progress, not live-authorized totals.
- Bound: existing limit 100, at most three rounds of at most 200 candidates (`h <= 600`), per-partition source
  chunks <=256. Preserve possible underfill and asynchronous ordering; do not claim a point-in-time snapshot or
  complete live order by re-sorting current figures after candidate truncation.
- Growth check: grow N and page depth with h fixed; assert source SQL rows/blocks, cursor scope tampering, empty
  results, rejected lookahead, threshold crossing and revoked Realm between engine read and response.

### 7. Default runtime composition (about 180 lines)

Paths: `services/kernel/src/search/work.ts`, `services/kernel/src/server.ts`,
`services/kernel/src/http/kernel.ts`, `services/kernel/test/search/rating-server.test.ts` (new).
Depends on tasks 1–6 and adopted route wiring. Inject actual publication/admission ports into API and worker;
install rating family consumers in the existing search service, without starting a relay in the API process.
Failing test: “the configured server and default worker share rating publication and population bindings”.

Cost operation: startup and relay discovery.

- Touches: configured publication readers, durable family pages and each live family's generation consumers.
- Bound: startup/discovery is paged, but total consumers/coordination grows with provisioned families × g;
  current shared-pool partition/checkpoint SQL is a real deployment limitation, not a constant per-family-free cost.
- Growth check: count real module registrations/service starts, grow admitted families, verify page ceilings,
  shutdown/drain and failed initialization ownership without creating duplicate relays.

### 8. Native-vote outcome and growth proof (about 120 implementation lines plus test scenarios)

Paths: `services/kernel/test/search/rating-outcome.test.ts` (new),
`services/kernel/test/search/growth-rating.test.ts` (new),
`services/kernel/test/search/support/outcome-worker.ts`,
`services/kernel/test/search/support/outcome-supervisor.ts`.
Depends on all integrations. Extend the existing isolated default-worker harness, preserving its real registrations
and ownership ledger; public commands, current API responses and actual checkpoints/aliases are the observations.
Failing test: “native votes converge to population-isolated rating order through replay restore and erasure”.
Exercise vote/change/clear including a real zero, threshold 4/5 and 9/10, population 49/50, Realm join/leave/ban,
suspension/reinstatement, controller rekey, merge, target takedown/restore and account erasure. Pause/drain/resume,
engine outage, partial bulk failure and rebuild crash must converge without manual checkpoint or index injection.
Use at least two populations whose ranking reverses and a candidate beyond an initial text prefix.

Cost operation: convergence and growth evidence.

- Touches: real native vote→aggregate→publication→anchor event→default search worker→API chain, plus isolated
  EXPLAIN/statement instrumentation for each source, fanout, page and query operation above.
- Bound: fixed vote membership cap (Global plus at most 100 counted Realms), 16 shards, 256 source IDs, 500
  rebuild anchors and bounded fanout pages; total erasure/epoch/family work scales with its actual affected set.
- Growth check: independently grow total subjects, same-partition rows/history, votes, population count and shard
  families while fixing selected neighbourhood/page; assert SQL examined rows/shared blocks, statements, payloads
  and engine targets. Prove full finite convergence after writes stop, not a universal latency SLA.

## Decisions awaiting adoption

1. Content must define exact source ports, standard-question target-grain resolution, revision/asOf semantics,
   population prior input set and pending-update behavior. Counterexample: averaging subject means weights a
   five-vote subject like a thousand-vote subject; counting removed votes keeps a revoked prior alive.
2. Adopt fixed-m epoch creation/rotation, validity metadata and unavailable-order response behavior. Proposed safe
   default is no rating-sort response while invalid/unready, rather than old scored results. Counterexample:
   50→49 leaves thousands of otherwise valid subject documents carrying a now-unpublishable prior.
3. Choose isolated family provisioning, quotas, shard sizing and registry/fanout storage, or explicitly approve a
   private shared family design. Counterexample: one semantic label edit in a million provisioned Realms is a
   million-copy job even though one voter's membership fanout is capped at 100.
4. Adopt trusted route-to-population admission and authorization invalidation semantics with the route owner.
   Counterexample: an authenticated caller supplies an unreadable Realm ID on the Global search endpoint.
   This proposal creates no header, kernel-wide route shape or caller population override.
5. Adopt current-vs-indexed figure disclosure during lag, including count privacy, threshold invalidation and
   source restore fences. Proposed behavior checks current publication permission, omits unsafe figures and
   restarts incompatible ordering instead of substituting Global or quietly sorting a candidate prefix.
   Counterexample: a currently four-vote subject retains its indexed five-vote score; dropping only its label
   still exposes the score through position. Even suppressed values can affect order unless admission blocks
   the invalid epoch or a new coherent generation is ready. Specify the freshness bound before a runtime claim.
6. Confirm public hit schema and whether to expose mean and score together; both require population/count labels,
   and histogram remains absent. Counterexample: displaying Bayesian score as an unlabeled arithmetic mean changes
   the meaning of existing cards. Four-decimal published ordering and subject-ID ties are proposed here.

No external engine/library recommendation is inferred from memory. No rating-specific research report was found
in the inspected rating/search sources; adoption can incorporate a separately supplied report. These unresolved
choices are implementation gates, not blockers to producing this proposal and not assertions of delivered behavior.
