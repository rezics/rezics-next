# Native rating phases across mixed prior epochs

Research date: 2026-10-28. Independent evidence and recommendation; not an adopted contract or engine runtime proof.

## Answer

**Yes for the fixed-state, epoch-gated indexed order:** concatenate two native query streams, current-epoch scored subjects first and their exact complement second. This is equivalent to the conditional numeric-script order when valid scores are nonnegative and the script gives every other document the same negative sentinel. Native filters and field comparators can implement both streams in OpenSearch 3.9.0 without a rating script per matching document. At most two phase searches per bounded candidate round suffice, including both phase totals. The proof below depends on one concrete physical generation and one admitted native prior state across both searches. [Boolean queries][bool], [field sorting][sort], [native comparator construction][field-sort].

**This does not prove complete ordering by current native figures during projection lag.** A current-epoch indexed score can outlive its figure's public eligibility. Bounded current-source checks must consume and reject that candidate; the two phases cannot then recover it at its proper unscored position without updated indexed evidence. The same limitation affects the conditional script in [the earlier epoch-mechanism report](search-rating-epochs.md). Neither mechanism supplies snapshot pagination or a current native top-N. This distinction is essential to the recommendation.

## Authority, method and assumptions

[Scope](../scope.md) limits this research to the Global population's standard-question public aggregate. [Rating's README](../../services/kernel/src/rating/README.md) supplies public-figure thresholds, the same-question/population Bayesian prior and its 50-vote minimum. Its broader Realm language does not expand that scope. The frozen-epoch and asynchronous republication model comes from the research contract; it is not inferred from OpenSearch. No product document, schema, implementation or existing acceptance test is changed here.

The recommendation was derived from the candidate, the permitted epoch-mechanism evidence, repository code and primary engine sources. Other native-phase comparison reports and their conclusions were not read. Repository observations refer to base `7a0bac51baaf3bd973f92be43680297c4f5a7345`. The engine image is pinned to 3.9.0 in [its Dockerfile](../../services/kernel/db/search/opensearch/Dockerfile).

| Primary project | Pinned revision and reusable cache under the main checkout's `.reference/` | Licence |
| --- | --- | --- |
| [OpenSearch](https://github.com/opensearch-project/OpenSearch/tree/4ee42a94e87f66fbf1e62a9871b1b87f91e02472) | Tag `3.9.0`, `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`; `search-rating-populations/opensearch` | Apache-2.0, `LICENSE.txt`; `NOTICE.txt` |
| [OpenSearch documentation](https://github.com/opensearch-project/documentation-website/tree/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf) | `9bf360dee6e0930aa0bd66ba91e992b9ee2828bf`; `search-rating-populations/documentation-website` | Apache-2.0, `LICENSE`; `NOTICE` |

Existing `.reference/INDEX.md` entries already identify these projects/revisions; no clone or index metadata addition was needed. Git source inspection and official documentation were used, including the pinned paths linked below. One uncached documentation blob could not be fetched through the cache's promisor remote; the official [Boolean-query page][bool] supplied that evidence instead. No reference project was installed, built or run, and no source files or long passages are proposed for copying. Current documentation URLs can change; the pinned source governs version-specific implementation claims.

The fixed-state theorem assumes:

- One physical generation contains one document per subject, with a required unique copied keyword `id`. All shards use compatible mappings and the same sort definitions. `name_sort` is an optional normalized keyword with explicit `missing: "_last"` in both phases.
- `rating_score` is a single finite, valid nonnegative numeric value or absent/null; `rating_prior_epoch` is one exact epoch identity or absent/null. They describe the Global standard question and are published together in one document update. Numeric doc values remain enabled; no `null_value` turns absence into a number. Arrays and malformed producer data are outside this invariant.
- A trusted current-native read selects eligible epoch `E`, or the unscored state `null`. Non-null identities are not reused after invalidation/recovery. Unavailable authority is an error, distinct from a successfully read ineligible state.
- The common candidate predicate `F` is identical in both searches, including text, admitted subject filters and their existing overflow handling. Its meaning is fixed for the proof; no phase-specific text cutoffs, rescoring, random predicates or separately evaluated relative times change membership.
- The theorem freezes indexed documents, admitted prior state and relevant source evidence. The later sections explicitly remove that assumption for live operation.

The present [mapping](../../services/kernel/db/search/indices/subjects.json) does not yet declare these rating fields. This report assumes the owning implementation introduces the required projection/mapping; it does not claim current production support. `exists` tests field values, not native eligibility or singleton cardinality: the [exists builder][exists-source] delegates to mapped-field existence queries, and [mapped-field source][mapped-field] uses `FieldExistsQuery` with doc values. A custom numeric null replacement or a stored negative sentinel would count as present and violate the stated projection invariant. [Exists semantics][exists], [null replacement][null-value].

## Partition and ordering proof

Let `D` be all indexed subjects satisfying `F` in the pinned generation. Define:

```text
P(d) = E is non-null AND d.rating_prior_epoch = E AND exists(d.rating_score)
A = {d in D | P(d)}             sort: rating_score DESC, name_sort ASC, id ASC
B = {d in D | NOT P(d)}         sort:                    name_sort ASC, id ASC
effective(d) = rating_score(d) if P(d), otherwise a common negative sentinel
```

For an eligible epoch, the native predicate is `P = bool.filter([term(epoch,E), exists(score)])`; A applies `F AND P`, B applies `F AND NOT P`. Crucially, B uses **one** `must_not` clause containing the whole conjunction. `must_not: [term(epoch,E), exists(score)]` means neither clause may match and incorrectly loses stale documents that still have scores. Missing/null epochs fail the term predicate and therefore enter B. When native state is ineligible/null, use `P = match_none`: A is empty and B is all of D, regardless of old indexed scores. [Boolean semantics][bool], [exists semantics][exists].

Disjointness follows because no document satisfies both P and its negation; exhaustiveness follows because every member of D satisfies one. Every A score, including **zero**, exceeds the unscored sentinel. Thus every A document precedes every B document. Within A, native score/name/id sorting equals effective-score/name/id sorting. Within B, effective scores are equal, so name/id alone is exactly the remaining comparator. The required unique id resolves equal scores, equal names and multiple missing names. This proves `sort(A) ++ sort(B)` equals the complete effective order, without truncating and reranking a combined prefix.

| Indexed state under eligible E | Phase and comparator consequence |
| --- | --- |
| Epoch E, score 8 or 0 | A; 8 precedes 0, and 0 precedes every unscored subject |
| Old epoch, score 10 | B; the old 10 has no ordering or public-eligibility force |
| Null/missing epoch, numeric score | B; name/id only |
| Epoch E, null/missing score | B; name/id only |
| Old/null/missing epoch and no score | B; same name/id order as every other B document |
| Any indexed state, native E is null | B; A has no hits |

For example, an old-epoch score 10 with name `a`, current score 0 with name `z`, and missing score with name `b` order as current zero, old `a`, missing `b`. Raw score sorting and dropping all old epochs fail that example. Epoch-then-score sorting separately fails when B contains two different old epochs: an epoch ordered earlier with name `z` must still follow an epoch ordered later with name `a`. The two-phase construction succeeds because B ignores every stale epoch and numeric value.

This is a multi-shard proof too. OpenSearch constructs native field comparators in [`FieldSortBuilder.java:421–449`][field-sort]; [`TopDocsCollectorContext.java:384–394`][collectors] passes the sort and `FieldDoc` boundary to `TopFieldCollectorManager`; [`SearchPhaseController.java:224–245`][merge] merges field-sorted shard results using that sort. For each phase, a shard's first q remaining hits suffice to contain its contribution to the global first q: any later local hit already has q earlier competitors. Concatenation then applies to the merged phase streams. Internal shard/document tie order is immaterial only because the application tuple is unique. The repository currently configures one shard; multi-shard behavior still needs integration coverage before any stronger implementation claim.

Missing `name_sort` must use the same placement in both phases. Preserve its returned null; do not replace it with a display name, empty string or id. A excludes absent scores, so no numeric missing sentinel is needed for real A hits, and B has no score component at all. If a defensive sort specifies numeric `missing: -1`, that is comparator configuration, not a number to insert into B's cursor or store as a real score. Numeric `_last` can map to infinity/extreme values rather than JSON null; [missing-value source][missing-source] shows the distinction. A finite-score invariant avoids those keys in A. [Sort-value serialization][sort-values] preserves numbers and formatted keyword values.

An unmapped rating field needs an explicit readiness decision: sorting can fail even if the phase has no matches. Prefer a generation with the declared compatible mapping; if compatibility is deliberately supported, allowlist a matching `unmapped_type` rather than suppressing errors. [`FieldSortBuilder.java:567–579`][unmapped-source] also shows that arrays default to max for descending/min for ascending; those defaults cannot enforce the single-score/single-epoch invariant. For example, epochs `[E,old]` and scores `[1,10]` allow A to match E while sorting on 10. Reject such projection data at publication rather than calling it a current score.

## Bounded rounds, lookahead and raw continuation

Use the existing service's candidate quota `q = min(200, 2 * remainingResultSlots + 1)` and at most three rounds. **q is the combined raw-hit quota for A and B**, not a quota for each. Count-only requests use `size: 0`; the present `searchSubjects` helper rejects zero and targets the alias, so a new phase-aware helper/template version would be required. This is an implementation follow-up, not a change to a released template. [Current query code](../../services/kernel/src/search/query.ts), [service loop](../../services/kernel/src/search/service.ts).

```text
admit native E; resolve and pin concrete generation G; validate signed binding
for at most 3 rounds:
  if position.phase == A:
    a = search(G, F AND P, A_sort, size=q, after=A_after)
    aEnd = len(a.hits) < q
    b = search(G, F AND NOT P, B_sort, size=(q-len(a.hits) if aEnd else 0))
    stream = tagged(a.hits, A) ++ tagged(b.hits, B)
  else:
    a = search(G, F AND P, size=0)  // total only, no boundary
    b = search(G, F AND NOT P, B_sort, size=q, after=B_after)
    stream = tagged(b.hits, B)
  check at most q raw candidates against current source; consume in stream order
  stop before the next acceptable lookahead once the result page is full
  advance only consumed tuples; cross A->B only after all remaining A was consumed
recheck native E and active generation; fail/restart on observed binding changes
```

Both requests set `track_total_hits: L` (`L = 10000`) when obtaining this response's phase-total pair. Subsequent rounds may omit redundant count work; never accumulate totals from repeated searches. For count-only requests omit `search_after` and unnecessary sort configuration. If E is known null, A's total and exhaustion are known zero and its request can be omitted. No extra `_count` request is required. The second request is sequential where its hit quota depends on A; packaging both in an unconditional multisearch does not itself solve that dependency. [Search API][search-api], [size-zero collector][count-collector].

A response shorter than q proves exhaustion only for a complete successful search. Exactly q hits does **not** prove whether A has another hit; stay in A until a later short/empty result, rather than spending a third probe. When A has fewer than q hits, B receives only the remaining quota. A full page may finish within A even though B was fetched; those B candidates remain unconsumed and must not move the cursor. No B result may be emitted while an earlier A result remains unconsumed.

Continuation is `(phase, rawAfter?)`. A uses exactly the returned `[numericScore, normalizedNameOrNull, id]`; B uses `[normalizedNameOrNull, id]`. A->B begins **without** an after tuple; it does not strip the score from the last A hit and reuse that name/id. If A is consumed and exhausted while the first B hit is acceptable lookahead, encode B-start with no tuple. If no A exhaustion is known, keep the last consumed A tuple. Never fabricate a tuple for a start position or use native displayed score/name to reconstruct one. [`SearchAfterBuilder.java:124–149`][after] checks tuple length, converts values and preserves null; the pinned [`SearchAfterIT.java:233–250`][after-test] explicitly tests a null keyword boundary. The repository's [cursor codec](../../services/kernel/src/search/cursor.ts) already distinguishes finite numbers, strings and null, but needs explicit phase/start-position binding and validation.

Consume rejected hits too, including rejected lookahead, until stopping before an acceptable lookahead or exhausting the fetched prefix. That is the existing service's important rule: otherwise a rejected tail can be scanned forever. For example, with one result slot, a rejected A hit followed by an acceptable A hit consumes both; the next acceptable A or B candidate stays for the next page. If all candidates fail source proof, bounded rounds may return an empty/partial page and a continuation from the last consumed tuple. A budget-limited continuation is not a promise that another visible result exists. Return no continuation only when all relevant remaining streams have been proven exhausted and consumed.

The fixed-state pagination proof is induction on consumption: each round fetches a prefix of the unconsumed ordered suffix, and only consumes a prefix of that prefix; phase switching starts at exactly the B suffix's beginning. Rejected hits remove elements while preserving the relative order of retained elements. Unconsumed lookahead is fetched again because its predecessor, rather than the lookahead itself, is the signed boundary. This proves traversal of the accepted subsequence under fixed evidence; it does not relocate a rejected A subject into B.

## Honest capped total

Let complete phase responses be `(vA,rA)` and `(vB,rB)`, where `r` is `eq` or `gte`. Since A and B partition D, a candidate total is:

```text
value = min(L, vA + vB)
relation = exact       iff rA == eq AND rB == eq AND vA + vB <= L
           lower_bound otherwise
```

Thus `6000 eq + 6000 eq` becomes `10000 lower_bound`, `0 eq + 10000 gte` remains a lower bound, `4000 eq + 6000 eq` is exactly 10000, and two exact zeros give exact zero. Do not turn `gte` into `eq` when capping, return 20000, or report A's total as the whole search total. Even while A supplies all page hits, the unused phase must supply its total through the second size-zero search, or an equivalent already valid fixed-state count. Starting in B still needs A's whole-population count; omitting it undercounts.

`search_after` limits returned hits, not the matching population's total. The pinned [null-boundary test][after-test] asserts total 2 with one remaining returned hit. [Top-doc collection][collectors] separates the boundary from hit-count tracking; [`SearchPhaseController.java:838–884`][totals-source] sums shard counts, propagates lower-bound relations and applies the request's cap. Per-shard counting thresholds are not a global work ceiling. The formula is an additional application cap across two already reduced phase totals.

These are **indexed candidate totals**, not proved current-public-result totals. If relation overflow, filter false positives or current rating/visibility rejection makes the candidate count unsafe as a result-count lower bound, apply the service's existing relation-overflow conservative pattern: report only distinct proved disclosed hits as `lower_bound` (and propagate that uncertainty in continuation). Rating checks would be new; existing code does not implement them or downgrade totals for every visibility rejection. Removing one known rejection from a capped total does not account for unknown rejections. Existing [search count limitations](../../services/kernel/src/search/README.md) also do not establish immediate general count privacy; this proposal does not silently add that guarantee.

Reject failed shards, timed-out/partial or deliberately early-terminated searches as proofs of order, exhaustion or exact count. Request `allow_partial_search_results: false` and inspect completion metadata; do not add `terminate_after` as a cheap cost cap, because it can cut off better sorted matches. The Search API distinguishes counting limits from early termination and describes potentially partial timeout results. [Search API][search-api], [query collector setup][query-phase].

## Native state, generation and live changes

Read native prior state before discovery, keep E fixed for **all** phases/rounds, and reread before responding. If E1 changes to E2 after A, B must not silently use E2: a document can satisfy A(E1) and B(E2), producing overlap; the inverse can create omissions. Invalidate the whole response on an observed change, rather than mix results or repeatedly retry inside an unbounded request. Unavailable authoritative evidence must fail closed. A final read is evidence at that read, not a transaction spanning PostgreSQL and OpenSearch or a promise about later events.

Sign the Global population, exact standard question/revision identity, nullable selected epoch, sort/template version, canonical request, viewer/principal, generation, phase and raw phase tuple/start marker. Validate tuple shape against phase and restart on observed epoch/generation changes. A cached eligible epoch or a matching old indexed score is never current public-eligibility proof. Below the native prior threshold, A is empty immediately in the query plan even before asynchronous document clearing.

For a **null -> eligible E -> null** interval, both null endpoints define exactly the same current unscored comparator, for the same indexed subjects/name/id values. Nullable E detects an observed eligible/unscored difference and a changed non-null identity; it does not prove that no eligible interval happened between reads. Consequently null-endpoint equality is sufficient for comparator compatibility under the fixed-state theorem, but cannot establish uninterrupted invalidity, unchanged documents or invalidation of every cursor spanning every transition. A stronger historical rule requires an authoritative monotonic transition revision/invalidation identity covering null transitions, or equivalent retained native history. This report does not invent that field or require it for the narrower comparator contract. Eligible recovery must not reuse an old non-null E, or even eligible-endpoint invalidation becomes undetectable.

Resolve the read alias to exactly one physical `subjects-gN` **before either phase**, validate its generation against the cursor, then send both phase requests and later rounds directly to that same concrete name. Do not search the alias twice and infer identity from hits. An alias can atomically switch from G1 to G2 between calls: A(G1)+B(G2) is not a partition of either generation, even when one phase has zero hits. At zero hits there is no `_index` witness; the pre-resolved target still identifies G. Reject absent/ambiguous resolution and a missing/retired concrete index; never fall back to a newer alias mid-request. Treat generation names as nonreusable physical identities. [Atomic alias operations][aliases], [Resolve Index API][resolve].

The current [query helper](../../services/kernel/src/search/query.ts) always targets the alias, while [service generation detection](../../services/kernel/src/search/service.ts) infers nonempty-hit generations and resolves empty hits through a one-second cache. Those are insufficient for the proposed two-search proof: an empty A on G1 followed by alias-switched B on G2 must not be assigned one identity retroactively. Pinning addresses this directly. A fresh final alias check can preserve restart-on-observed-promotion semantics; it cannot detect every switch-and-switch-back, but both searches still used G. The repository promotes an unfiltered, unrouted alias; any future alias filter/routing would have to be reproduced when targeting physical indexes. [Promotion code](../../services/kernel/src/search/generations.ts).

Budget metadata separately: one initial resolve and at most one final active-generation check per response, plus at most six phase searches over three rounds; native state reads and bounded source checks are separate. Template installation/readiness is existing setup, not a hidden third phase search. Pinning does not freeze the index, replicas, source evidence or current native state. With no PIT, a document moving B->A above the consumed boundary can be missed, A->B can repeat, and name changes can cross either boundary. [Stateless pagination][pagination].

Live totals have an additional two-request hazard: if the only document moves A->B between phase searches, both phase counts can be `1 eq` although D contains one document throughout. The fixed-state sum then says 2, which is neither a current exact count nor a current lower bound. Unchanged native E and generation do not detect this. Treat a live pair only as separate indexed observations; if the public total must remain an evidence-backed current lower bound without a snapshot/immutability guarantee, use distinct source-proved returned subjects instead of advertising that sum as `exact` or `lower_bound`. The one-stream script avoids this particular cross-phase counting window, though it supplies no general live traversal snapshot either. This is a limitation of extending the fixed-state total proof to updates, not a reason to claim that capped counting freezes data.

Current per-figure eligibility requires its own bounded authoritative proof: Global prior eligibility alone does not show that a work still has five votes, that a finer-grain figure still has ten, or that an indexed numeric score still matches its current public revision. Consume and reject an unsafe ranked hit; do not disclose its old number, change its tuple to a sentinel, or insert it into the current page's B prefix. On unavailable required proof, fail the response under the established typed-error pattern. No per-matching-document native join is proposed.

A concrete counterexample to the **stronger current-native order**, even with state static during a request: indexed subject x has `(epoch=E, score=9)` but its now-current figure is below threshold. Native effective order would include x unscored by name; P still puts x in A and excludes it from B. Rejecting x is safe but incomplete; exposing its 9 is unsafe. Similarly, an eligible current score not yet projected cannot be discovered by the query. Only repaired/stronger indexed evidence, or a separately designed authoritative ordering mechanism, can close that gap. This does not refute the indexed mixed-prior-epoch proof; it limits what “exact” may mean.

## Cost, comparison and recommendation

Native does not mean O(1). For a phase with M matching documents, field sorting can still visit many/all matches, advance doc values, compare candidate tuples and maintain top-q collectors; query conjunction/complement and text evaluation add engine work. Field comparators can skip noncompetitive work in applicable cases, but this report establishes no universal bound independent of M. Shards retain/merge bounded top-q candidates; that bounds retained result structures, not all matching-document work. Counting to L can also incur work per shard; size-zero searches avoid hit/source fetches but still perform query/count work. [Native collectors][collectors], [native field sort][field-sort], [count collector][count-collector].

Two phases may evaluate the common predicate twice and perform separate counts. They avoid the conditional script's per-evaluated-document epoch/score program and can use native filter/comparator optimizations, but are not proved faster. [`ScriptSortBuilder.java:413–442`][script-sort] sets the document and calls the numeric script when the comparator requests its value; compilation reuse does not eliminate that execution. The repository declares no `index.sort.*` setting. Compatible physical index sorting can help selected sorts at an indexing/merge cost, but one layout does not automatically match both score/name/id and name/id sorts. `search_after`, L=10000, three rounds and a 600-candidate ceiling do not make engine work constant. [Index sorting][index-sort].

Returned/source work is separately bounded: at most 200 combined candidates per round, 600 per response, with current disclosure/figure reads grouped by those candidates' partitions and no source lookup for count-only hits. Carry forward existing source concurrency and payload bounds; any new rating-proof API needs its own bounded batch contract. This is a call/payload budget, not a benchmark, SQL-plan proof or guarantee about matched-engine complexity.

| Alternative | Assessment for this stack |
| --- | --- |
| Conditional numeric script | Same fixed indexed comparator in one stream; simpler tuple and phase handling. Requires per-document script evaluation and its operational permissions/cache handling. Does not solve per-figure projection lag, generation races or live key movement. |
| Two native phases | Exact fixed mixed-epoch candidate order without a rating sort script; up to two phase searches, explicit phase cursor and total composition. Requires the safeguards above. Recommended candidate for the owning implementation. |
| Current-epoch filter only / raw score sort / reranked prefix | Incorrect: respectively loses unscored subjects, ranks stale scores, or can miss a globally earlier subject outside the prefix. |
| Immutable published generation | Can support stable index traversal if actually immutable and retained; alias promotion alone does not make it immutable or prove current native eligibility. More publication/retention coordination. |
| Epoch-specific fields or reused slots | Possible materialization tradeoff with bounded retention and cursor lifetime coordination; no need to introduce them for the proved phase construction. Unbounded field growth or overwriting a live cursor's slot is not a safe shortcut. |

The shared primary-source pattern is to express membership with indexed predicates, order by doc values with a unique tie breaker, preserve returned continuation values, and distinguish counted matches from fetched hits. Aliases atomically change routing, not the identity of a sequence of independent searches. These patterns support native phase concatenation as an alternative the earlier script recommendation did not analyze; they provide no measured performance result.

**Recommend adopting the native two-phase design for the specified fixed-state epoch-gated order**, retaining current-source rejection and explicitly eventual live traversal. Keep the script as a simpler one-stream fallback if implementation complexity outweighs measured savings. Before landing runtime support, the owner should verify on pinned 3.9.0: complement truth table; zero/stale/null scores and epochs; missing names and exact tuple round trips; equal-score/name ties across shards; all quota boundary/lookahead/rejected-tail cases; capped `eq`/`gte` combinations; prior changes between phases; null-endpoint compatibility; same-epoch per-figure rejection; alias promotion between requests including empty phases; retired generations; and timeout/shard-failure handling. Measure broad/selective queries and mixed-epoch distributions before claiming a latency improvement. This report supplies a conditional proof and counterexamples, not those runtime tests or a stronger product decision.

[bool]: https://docs.opensearch.org/latest/query-dsl/compound/bool/
[sort]: https://docs.opensearch.org/latest/search-plugins/searching-data/sort/
[exists]: https://docs.opensearch.org/latest/query-dsl/term/exists/
[null-value]: https://docs.opensearch.org/latest/mappings/mapping-parameters/null-value/
[pagination]: https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/
[search-api]: https://docs.opensearch.org/latest/api-reference/search-apis/search/
[aliases]: https://github.com/opensearch-project/documentation-website/blob/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf/_api-reference/alias/aliases-api.md
[resolve]: https://docs.opensearch.org/latest/api-reference/index-apis/resolve-index/
[index-sort]: https://docs.opensearch.org/latest/im-plugin/index-sorting/
[exists-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/query/ExistsQueryBuilder.java#L158-L198
[mapped-field]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/mapper/MappedFieldType.java#L356-L363
[field-sort]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/sort/FieldSortBuilder.java#L421-L449
[unmapped-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/sort/FieldSortBuilder.java#L567-L579
[collectors]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/query/TopDocsCollectorContext.java#L384-L481
[count-collector]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/query/TopDocsCollectorContext.java#L137-L171
[merge]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/action/search/SearchPhaseController.java#L224-L245
[totals-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/action/search/SearchPhaseController.java#L838-L884
[missing-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/fielddata/IndexFieldData.java#L210-L235
[sort-values]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/SearchSortValues.java#L70-L110
[after]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java#L124-L149
[after-test]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/internalClusterTest/java/org/opensearch/search/searchafter/SearchAfterIT.java#L233-L250
[query-phase]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/query/QueryPhase.java#L225-L259
[script-sort]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/sort/ScriptSortBuilder.java#L413-L442
