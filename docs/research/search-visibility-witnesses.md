# Search visibility witnesses: evidence and limits

Research inspected on 2026-10-27. This report is evidence for the owning Search and Semantic documents, not a
replacement for their accepted contracts. No product code, tests, or decisions are changed here.

The evidence supports separating candidate discovery from final authorization, batching checks, retaining unknown
as unknown, and repairing derived indexes asynchronously. It does **not** establish REZICS's particular combination
of one saved witness, 32 alternatives, 128 sampled values and finite witness recomputation as an industry pattern.
Those are local resource and availability choices. Their safety depends on current evidence checks; their recovery
depends on complete invalidation routing and a durable, progressing repair worker.

## Scope and method

The local baseline is commit `b83e8ec43c3056755cc6593b35dafa2e52f2e7f0`. The principal local sources are
[the source port][local-source], [final disclosure][local-check], [Search's cost contract][local-readme], and
[the relation witness handoff][local-design]. Additional reads of filter compilation, paging, counts, and the
production source distinguish declarations from implemented behavior. The handoff explicitly describes production
work still to be completed; this report does not certify that implementation or that its proposed tests pass.

Four reference repositories were shallow-cloned with blob filtering and sparse working trees. They were treated as
untrusted data: only Git metadata, licences and source text were read; no dependencies, builds, tests, scripts or
reference programs were run. No product code was copied. The inspected checkouts are retained at the reported
commits under `/home/edge/projects/rezics/rezics-next/.reference/search-visibility-witnesses/<project>/`; their
verified licences are indexed in `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`. Only this report is a
tracked change.

| Reference checkout                     | Inspected commit                           | Verified licence at that commit                                                                                                |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `security` — OpenSearch Security       | `f199729d604987b537336ab870b9d575c756e4ab` | [Apache-2.0, `LICENSE.txt`][os-license]                                                                                        |
| `sourcegraph` — public source snapshot | `c864f15af264f0f456a6d8a83290b5c940715349` | [`LICENSE` delegates to `LICENSE.enterprise`][sg-license]; [Sourcegraph Enterprise License][sg-enterprise] for inspected paths |
| `openfga`                              | `57b39bc3dcc12f92270602bc01eb933ca4accfbe` | [Apache-2.0, `LICENSE`][fga-license]                                                                                           |
| `spicedb`                              | `7e7420c3f541648971b70642691ef86cac00a6cc` | [Apache-2.0, `LICENSE`][spice-license]                                                                                         |

Sourcegraph's snapshot is dated 2024-08-22; the other three commits are dated 2026-10-26. Current official docs
provide context, not proof that every detail exists in the older snapshot. No superseding licence was found in the
inspected Sourcegraph search/database paths. It is a mature-system source reference, **not** permissively licensed
code available for copying under this repository's rule. Patterns may be followed freely; any future code copying
is limited to MIT, Apache-2.0 or BSD projects with attribution and applicable notices. Documentation was paraphrased.

## What the local mechanism actually claims

1. **Public candidate snapshots.** Only visible, nonredirected subjects are indexed, with adopted Global facts
   visible when built. This is not a private per-user ACL index. Relation samples contain at most 128 distinct
   values **per declared outgoing facet property** of the current source type. Incoming and undeclared relations
   are excluded. Qualifiers can remain stored metadata but are not relation predicates. The 129th rebuilt value
   sets the overflow marker; pair deduplication ignores slotKey multiplicity. See [the port][local-source] and
   [handoff, lines 6–23][local-design].
2. **Candidates are not authority.** Overflow broadens both positive and negative literals; negation is pushed
   down before broadening. A negative literal becomes candidate absence OR overflow, not NOT(candidate presence
   OR overflow). This preserves possible negative matches in overflowing sources. It does not recover an entirely
   missing new pair or a missing/stale overflow marker before indexing catches up. See [filter compilation][local-filter].
3. **Current disclosure.** The final check validates the UUID anchor and indexed partition, groups source reads,
   rejects hidden/redirected subjects and security-revision mismatches, and evaluates the complete admitted Boolean
   filter. Named matched clauses prioritize work; they are not proofs. Positive declared relation leaves use live
   point checks even without overflow; overflowing relation leaves use them for either sign. [Disclosure code][local-check]
   preserves tri-state results through NOT, AND and OR, and accepts only a top-level true result.
4. **Bounded existential evidence.** The handoff requires checking the saved statement identity first and at most
   32 additional identities for that exact source/property/value in stable index order; with no saved identity,
   at most 32. Each examined identity counts, including hidden adoption, candidate, source tuple or target evidence.
   Each proof checks current source/target visibility, Global adoption, moderation/retraction and imported provenance
   fences. Historical slotKey variants cannot expand the request budget. Witnesses remain Semantic-internal hints,
   absent from engine documents and mappings. [Handoff, lines 25–43 and 52–73][local-design].
5. **Unproven means repair, not absence.** A valid-source probe that finds no witness within its budget returns
   `not_proven`, including an empty bounded range. The port permits definitive false for cases such as a missing,
   hidden or redirected source; the handoff does not authorize inventing pair absence from exhausted hints.
   Unknown predicates cannot support disclosure under either sign. The source must durably coalesce a source-home
   rebuild request and registered source-only event before returning unknown. Ordinary uncertainty drops/refills;
   actual pool, partition and I/O failures remain typed unavailability. [Port][local-source], [handoff][local-design].
6. **Finite background recovery.** Registered source events and routed dependency invalidations enqueue affected
   sources. A durable cursor traverses all possible statement identities in bounded pages, retaining a visible
   witness per pair, including pairs beyond the Search sample. Partial pairs survive page boundaries. Staged
   publication/removal is also bounded. Active and requested generations prevent lost dirtiness and endless restart;
   completion emits a source change after durable publication. [Handoff, lines 82–113][local-design].

The concrete production `semantic/search-source.ts` at this baseline still exposes the descriptive snapshot/count
implementation, not the proposed witness point port or runner. These six items therefore combine existing Search
code with the explicit Semantic handoff, rather than asserting a finished end-to-end system. [Production source][local-semantic].

## What established systems support, and what differs

### OpenSearch Security: authorization inside the searchable view

Official [DLS documentation][os-dls] describes role-specific document restrictions expressed as queries, evaluated at
Lucene level or by query rewriting. [FLS][os-fls] restricts readable fields, including subfields; fields used by DLS
must remain available to its query. Neither feature is a promise to consult REZICS's current Semantic/Content fences.

The source confirms the distinction: [`DlsFlsFilterLeafReader.DlsGetEvaluator`][os-reader] derives permitted live-doc
bits from a DLS query and intersects deletions; [`applyFilterLevelDls`][os-filter] installs the restriction into the
search query and checks special hybrid branches. These operate on the index's readable state. If the document's
indexed public flag is stale, a correct query against that flag can still allow a now-hidden source document.
Changing roles can change a query restriction, but it does not independently update stale external fact evidence.

OpenSearch's [Search API documentation][os-search] also states that `post_filter` affects hits but not aggregations.
Consequently a post-filtered hit list cannot justify returning its original aggregation counts as authorized counts.
REZICS's application disclosure has the same accounting obligation even though it runs outside OpenSearch.

**Supported:** apply the restriction on every disclosure path, and examine counts separately. **Not supported:**
using DLS/FLS, a successful engine refresh, or an indexed public flag as a substitute for current source fences.

### Sourcegraph/Zoekt integration: repository scope and a mirrored authority

The inspected Sourcegraph path resolves private repositories through the application database:
[`privateReposForActor` and `GlobalTextSearchJob.Run`][sg-search]. The repository SQL installs authorization
conditions in [`repos.go`][sg-repos]; [`ApplyPrivateFilter` and `Generate`][sg-scope] intersect the resulting repository
scope with the Zoekt query. This is evidence for application authorization constraining search. This particular
path **prefilters repository scope**; it is not evidence for a universal live post-check of every code match.

The authority is also different. [Sourcegraph's permission-sync documentation][sg-sync] describes periodically
mirrored code-host permissions, on-demand jobs, bounded scheduling/concurrency and rate limits. Revocations can lag
until a complete sync cycle, and initial permissions can gradually add search results. Thus a check against its
local permissions database is not an instantaneous check against its upstream code host. That documented consistency
tradeoff does not justify accepting stale evidence under REZICS's next-read fence contract.

[`permission_sync_jobs.go`][sg-jobs] persists jobs and transactionally suppresses duplicate queued user/repository
jobs, replacing lower-priority work where necessary. This supports durable coalesced asynchronous refresh as a real
practice. It does not prove REZICS's in-flight generation rules, bounded witness traversal, source dependency routing
or eventual recovery of every filtered candidate. Those need local verification.

### OpenFGA: search then check, and explicit consistency choices

The closest direct evidence is [OpenFGA's search integration guide][fga-search]. It separates metadata filtering and
sorting from authorization, recommends batch-checking search results, and explicitly describes building a local
index from tuple changes followed by a final check to remove revoked permissions that have not reached that index.
That is strong support for REZICS's candidate-index/current-check separation. It is not evidence for a fixed witness
fallback count or a promise that checking candidates can recover objects absent from that index.

The inspected [`ListObjectsQuery.evaluate` fallback][fga-list] sends reverse-expansion candidates requiring residual
evaluation to Check and emits them only when allowed. It bounds concurrent work, results and elapsed time; it waits
for in-flight checks and handles deadlines. This file also has a newer optimized pipeline path. The cited fallback
demonstrates candidate verification, not a universal SQL-row bound, a paginated exact-total contract, or REZICS-style
unknown-and-repair semantics. A result/deadline limit alone cannot prove complete enumeration.

[OpenFGA consistency documentation][fga-consistency] says the default can use cached results while higher consistency
skips caches and reads the database. A cached allow after tuple revocation is not equivalent to REZICS checking its
current fences. [Read Changes][fga-changes] supplies ordered tuple additions/removals but excludes authorization-model
changes. Its [implementation][fga-changes-code] accepts page size and continuation state and retains the input token
when no new changes are found. These support incremental repair inputs, not automatic completeness of every derived
projection: model/release changes and dependency invalidation still require explicit coverage.

### SpiceDB: bounded batches are not bounded graph proofs

Authzed's [list-endpoint guide][spice-list] recommends fetching candidate pages, checking them in bulk, and using a
cursor. Its example continues until the output page fills; that loop has no fixed candidate-work ceiling. REZICS's
three-round stop is a stricter local budget that trades page fullness for bounded foreground work. It is not an
externally recommended number. The guide also recommends a common permissions revision across bulk calls.

Source [`lookupresources2.go`][spice-lookup] uses seek cursors and dispatch chunks, then performs residual checks for
intersections/exclusions. Crucially those checks carry the **same revision** as the lookup. Its check hints concern
known graph subproblems at that revision, not an old imported-statement identity that must be validated against
independent current fences. Caveated membership with missing context is also distinct from REZICS exhausting a
witness budget. Superficial similarity in the word “hint” does not establish equivalent authority or uncertainty.

[SpiceDB consistency documentation][spice-consistency] explains freshness tokens and the New Enemy Problem, and warns
that latency-oriented reads can be stale. Revision selection gives explicit temporal semantics; even fully consistent
reads use a snapshot selected at request start, not every later concurrent write. This supports stating a precise
read boundary. It does not require REZICS to introduce a token/proof cache, a publication barrier or graph storage.

## Shared patterns and the unsupported combination

| Evidence-supported pattern                | Applicability and limit here                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate discovery from authorization     | OpenFGA explicitly rechecks a change-fed index; SpiceDB checks candidate pages. REZICS must still check the authoritative current evidence.                                   |
| Batch or scope authorization work         | OpenFGA batches; Sourcegraph filters repository scope; SpiceDB chunks. Batch size/concurrency bounds are not proofs of bounded underlying rows or graph traversal.            |
| Treat consistency as part of correctness  | Sourcegraph documents upstream lag; OpenFGA exposes cache preferences; SpiceDB uses revisions. They offer different guarantees, not interchangeable definitions of “current.” |
| Repair derived state incrementally        | OpenFGA supplies change pages; Sourcegraph stores/coalesces sync jobs. Neither inspected implementation establishes this exact per-pair witness repair scheme.                |
| Keep pagination separate from eligibility | SpiceDB's integration guide uses cursors; OpenSearch documents sort-based continuation. Cursor progress does not guarantee full visible pages or complete recall.             |

No inspected source establishes the specific 128/32 limits, a saved-witness-plus-fallback contract, or guaranteed
finite recovery with independent imported fences. The combination is a locally reasoned algorithm requiring local
safety, cost and liveness evidence, not an externally standardized design. No performance benchmark was run here.

## Edge cases and verification obligations

### Multiple independent witnesses and safe negation

For one source/property/value, let statement A be the recorded witness and B another adopted statement, each with a
different imported source fence. Fencing A invalidates A, **not the pair**. If B is among the next 32 identities and
passes every current check, the answer is true. If 32 hidden identities precede B, the correct bounded answer is
unknown, even though the pair exists. Repair must carry this pair across pages and eventually record B. If every
witness is fenced, a stale saved identity must never authorize a hit; repair eventually removes the pair.

This is an existential fact: one current positive witness suffices; failure to find one in a prefix proves no
negative. [PostgreSQL's official three-valued truth tables][pg-logic] give a useful semantic precedent: NOT unknown
remains unknown, false AND unknown is false, and true OR unknown is true. REZICS's uncertainty is a resource/evidence
state, not SQL NULL, but the same Boolean rules prevent an unproved pair from turning into a proven NOT pair.
The final expression can be proven true by another OR branch; uncertainty need not reject an independently proven
whole expression. Operational errors must remain errors rather than becoming false or ordinary unknown.

There is a specific integration obligation: [the current final check][local-check] probes negative-only relation
leaves only on overflow; otherwise it uses snapshot absence. The handoff permits underfilled snapshots while repair
is pending. If invalid A is omitted while an unsampled B is still visible, “not in this snapshot” is not a current
absence proof. Verify this case through the production source and Search together, for **nonoverflow and overflow**
sources. The current tri-state evaluator is safe once it receives unknown; it cannot preserve uncertainty that the
source/snapshot interface has already collapsed into absence. This report identifies that proof obligation rather
than asserting that unfinished source behavior already supplies it. If it fails, adopt a narrowly scoped conservative
negative-path change through the owning contract; do not introduce a negative proof cache implicitly.

Also distinguish this from an index that still contains a removed pair: that stale positive can exclude a legitimate
NOT result before disclosure ever sees it. Final checks cannot fix that recall loss; repair and a later search can.
After a stable completed nonoverflow rebuild, complete snapshot absence can support normal negative filtering;
overflow absence can remain unproven indefinitely under the accepted no-negative-proof-cache contract.

### Bounded overfetch, consumption and totals

[The service][local-service] makes at most three rounds with at most 200 candidates per round, a conservative
600-candidate ceiling. It advances the cursor through consumed rejected candidates and stops before the next kept
lookahead hit once the output fills. Advancing only through returned hits would repeat rejects; advancing through
every fetched hit would skip an eligible lookahead. Verify both cases, including a page of only unknown results.
Search's README also contains an older 303-hit table entry; use the executable loop and conservative 600 bound for
this report, not that tighter unsupported entry. No acceptance test is altered here.

The 256-probe port cap is **per call**, not per page: disclosure splits a larger deduplicated set into calls. A
foreground witness-examination bound is at most `H × sum(distinct requested values per relation leaf) × 33`, before
deduplication, plus bounded snapshot/hint and evidence work. H, leaf count and IN width must all be admitted limits.
Each evidence check and dirty-job enqueue must itself be bounded; fetching 32 returned rows after scanning unbounded
history is not sufficient. Inspect actual examined SQL rows/statements and logarithmic index blocks as degree,
hidden history and same-pair slotKey multiplicity grow. Budget size alone is not a latency measurement.

[OpenSearch pagination docs][os-paging] require sort continuation and explain that stateless `search_after` can
reorder as documents change; a unique tiebreaker removes ties but not concurrent-update anomalies. PIT can stabilize
the engine view, not current external authorization. REZICS's signed request/principal/generation cursor constrains
continuation and generation changes, but does not freeze same-generation refreshes or independent source reads.
Do not promise an exact snapshot traversal, or reappearance on the same cursor after repair of an earlier reject.
At budget exhaustion a short or empty page with continuation is valid; only exhausted **candidates** justify no next
candidate cursor. Even candidate exhaustion says nothing about new facts not indexed yet.

| Quantity                         | Truthful interpretation                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current visible hit              | Supported by checks at their read boundaries; not a globally simultaneous snapshot of all partitions/fences.                                                                    |
| Candidate total                  | Count of engine matches at the engine's view. It may include stale revoked facts and omit new matches.                                                                          |
| Candidate superset from overflow | Conservative relative to the indexed sampled/overflow representation. It need not contain every current source match during lag. Its size is not a lower bound on live matches. |
| Disclosed-hit count              | Conservative evidence for matches actually disclosed on that response, under its read semantics; not an exact global cardinality or cumulative unique count across cursors.     |
| Sampled facet count              | An index/sample count with stated freshness and sampling limits; not automatically a live-authorized count.                                                                     |

[The service][local-service] switches to the current response's disclosed result length as a lower bound when
overflow/live relation rejection makes candidate totals unsafe, and carries known inexactness in its cursor binding.
Verify continuations do not regain an exact label. A candidate count of 100 with two proven results cannot truthfully
be relabeled “at least 100 live matches”; a proven subset can support two, subject to the stated temporal semantics.

[Facet query code][local-query] excludes overflow-unresolved subjects from its “definite” aggregate and marks affected
counts as lower bounds. That removes overflow ambiguity **inside the engine representation**, not stale external
fence ambiguity: a source can lose a visible fact before its marker/document updates. Rechecking a facet value's
target visibility does not prove that all counted source-to-target statements remain visible. Specify indexed
as-of/sampled semantics separately from any live total claim, and test revocation lag on nonoverflow contributors.
Neither an `exact` engine total nor an engine `gte` value alone proves a live lower bound after application checks.
A freshness label describes lag; it does not authorize disclosing counts that reveal now-hidden evidence. Verify
that aggregate disclosure meets its own accepted visibility contract, independently of safe hit bodies.

### Replay, coalescing and finite repair

The external change feeds and persistent queues support the building blocks, not an automatic liveness theorem.
For REZICS, the [handoff][local-design] requires registered events with the source anchor and source partition, never
a request to rebuild the target merely because it is a relation value. Foreign target/fence changes must route
affected **sources** through the separately owned reverse dependency mechanism. A removed hint is not a subscription:
restoration/new adoption must enqueue even when no pair hint survives and no search request touches the source.

Required crash/replay schedules include: enqueue committed but checkpoint not advanced; checkpoint retry;
duplicate point probes while a job is pending; a new invalidation during traversal; worker restart between pages;
and publication committed but its completion notification retried. Persist enqueue before checkpoint advance,
identify replay by envelope, preserve the highest requested generation, and distinguish completion from invalidation.
Coalescing must not clear an invalidation arriving during publication, and replay of an old event must not generate
fresh work forever. Completion events must make Search reread the source without perpetually dirtying the same job.

The finite-repair argument is local and conditional. After mutations stop, assume finite identities/output, complete
event delivery and dependency registration, eventual successful I/O, fair scheduling, and advancing durable cursors.
Finish the active generation, then any newer pending generation; do not reset the active cursor for every mutation.
Carry a partial pair across pages, finish staged output/deletions, publish, notify Search, let its consumer catch up,
and allow the engine to refresh. [OpenSearch refresh documentation][os-refresh] establishes that indexing completion
and search visibility are distinct; refresh does not perform the missing Semantic repair or dependency routing.

Under those conditions, an obsolete pointer with a surviving later witness is repairable in finite steps. For W
identities and O output changes, work remains proportional to W plus O across a stable traversal, with roughly
`ceil(W / pageSize)` identity pages plus publication/event work. Repeated generations add work. This is bounded per
step and finite after quiescence, **not constant total work**, not a wall-clock SLA, and not a proof that every absent
overflow pair will eventually yield false. Continuous writes, starvation, unavailable stores or missing dependency
events defeat the corresponding liveness claim without making a stale witness safe to disclose.
Further unknown reads after completion can request another same-state traversal, particularly for absent overflow
pairs. Finishing finite already-requested work is not a promise of permanent worker idleness under continuing reads
or a bound on aggregate repair amplification from those reads.

## Recommendation for adoption

Retain the candidate/current-proof split and the conservative `not_proven` result. Describe 128, 32, 256 and three
rounds as local budgets, and describe repair as finite background work under explicit progress assumptions. Keep
leak prevention, predicate accuracy, recall, page fullness and count freshness as separate promises.

Before claiming end-to-end coverage, require production-composed verification of independent same-pair fences,
late surviving witnesses, all-witness removal, 129-to-128 overflow clearing, and restoration after complete hint
removal. Include NOT/AND/OR, negative-only nonoverflow underfill, malformed/error point responses, rejected lookahead,
empty continuing pages, cursor generation changes, and count/facet lag. Assert real examined rows and bounded output
publication, durable restart/replay/coalescing, source-only registered events and dependency catch-up. These are
verification obligations for the existing design, not an assertion that the research acceptance executes them.

The evidence warrants only narrow owning-document clarification and, if those checks expose it, a conservative fix
for negative snapshot uncertainty or misleading count labels. It does not warrant silently adding a signature
catalogue, publication barrier, proof cache, exact-recall guarantee or unrelated authorization/storage redesign.
Unknown can deliberately reduce availability; asynchronous repair improves later recall. Neither implies complete
first-call recall, full pages, exact live counts, or authorization from a stale hint.

## Source links

[local-source]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/kernel/src/search/source.ts#L5-L110
[local-check]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/kernel/src/search/disclosure/check.ts#L49-L282
[local-readme]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/kernel/src/search/README.md#L9-L46
[local-design]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/kernel/src/semantic/relation-facets-design.md#L1-L180
[local-filter]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/kernel/src/search/filter.ts#L22-L56
[local-service]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/kernel/src/search/service.ts#L265-L378
[local-query]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/kernel/src/search/query.ts#L223-L273
[local-semantic]: https://github.com/rezics/rezics-next/blob/b83e8ec43c3056755cc6593b35dafa2e52f2e7f0/services/kernel/src/semantic/search-source.ts
[os-license]: https://github.com/opensearch-project/security/blob/f199729d604987b537336ab870b9d575c756e4ab/LICENSE.txt
[sg-license]: https://github.com/sourcegraph/sourcegraph-public-snapshot/blob/c864f15af264f0f456a6d8a83290b5c940715349/LICENSE
[sg-enterprise]: https://github.com/sourcegraph/sourcegraph-public-snapshot/blob/c864f15af264f0f456a6d8a83290b5c940715349/LICENSE.enterprise
[fga-license]: https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/LICENSE
[spice-license]: https://github.com/authzed/spicedb/blob/7e7420c3f541648971b70642691ef86cac00a6cc/LICENSE
[os-reader]: https://github.com/opensearch-project/security/blob/f199729d604987b537336ab870b9d575c756e4ab/src/main/java/org/opensearch/security/configuration/DlsFlsFilterLeafReader.java#L145-L188
[os-filter]: https://github.com/opensearch-project/security/blob/f199729d604987b537336ab870b9d575c756e4ab/src/main/java/org/opensearch/security/configuration/DlsFilterLevelActionHandler.java#L299-L363
[sg-search]: https://github.com/sourcegraph/sourcegraph-public-snapshot/blob/c864f15af264f0f456a6d8a83290b5c940715349/internal/search/zoekt/indexed_search.go#L656-L725
[sg-repos]: https://github.com/sourcegraph/sourcegraph-public-snapshot/blob/c864f15af264f0f456a6d8a83290b5c940715349/internal/database/repos.go#L1278-L1289
[sg-scope]: https://github.com/sourcegraph/sourcegraph-public-snapshot/blob/c864f15af264f0f456a6d8a83290b5c940715349/internal/search/zoekt/zoekt_global.go#L68-L87
[sg-jobs]: https://github.com/sourcegraph/sourcegraph-public-snapshot/blob/c864f15af264f0f456a6d8a83290b5c940715349/internal/database/permission_sync_jobs.go#L301-L406
[fga-list]: https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/pkg/server/commands/list_objects.go#L306-L700
[fga-changes-code]: https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/pkg/server/commands/read_changes.go#L71-L142
[spice-lookup]: https://github.com/authzed/spicedb/blob/7e7420c3f541648971b70642691ef86cac00a6cc/internal/graph/lookupresources2.go#L340-L660
[os-dls]: https://docs.opensearch.org/latest/security/access-control/document-level-security/
[os-fls]: https://docs.opensearch.org/latest/security/access-control/field-level-security/
[os-search]: https://docs.opensearch.org/latest/api-reference/search-apis/search/
[os-paging]: https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/
[os-refresh]: https://docs.opensearch.org/latest/api-reference/index-apis/refresh/
[sg-sync]: https://sourcegraph.com/docs/admin/permissions/syncing
[fga-search]: https://openfga.dev/docs/interacting/search-with-permissions
[fga-consistency]: https://openfga.dev/docs/interacting/consistency
[fga-changes]: https://openfga.dev/docs/interacting/read-tuple-changes
[spice-list]: https://authzed.com/docs/spicedb/modeling/protecting-a-list-endpoint
[spice-consistency]: https://authzed.com/docs/spicedb/concepts/consistency
[pg-logic]: https://www.postgresql.org/docs/18/functions-logical.html
