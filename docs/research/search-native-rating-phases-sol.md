# Native phases for Global effective-rating search

Research date: 2026-10-28. Evidence and a proposed design, not adopted authority, a benchmark, or runtime proof.

## Answer and scope

**Yes, for a fixed indexed state and a fixed native prior selection:** concatenate the native current-epoch scored
phase, ordered by score descending/name/id, with its exact complement, ordered by name/id. This implements the same
total order as a conditional numeric script with an unscored sentinel below every valid score. It needs at most two
bounded phase searches per refill round, including count-only searches, and no rating sort script. The proof below
depends on explicit scalar-field, publication, generation and continuation invariants.

**It does not produce a complete order of all current native figures while publication lags.** A currently
ineligible figure can still be indexed in the scored phase. Current proof must reject that hit; the complement
cannot retrieve it as unscored until the index changes. The conditional script has the same limitation. Safe
discovery as an ordered subsequence is attainable; exact current-source recall and snapshot traversal are stronger
contracts. No point in time (PIT) or duplicate-free traversal under updates is claimed.

Scope is only the Global standard question, as specified in [scope](../scope.md), inspected at `805c8c13fa`.
The broader Realm language in `services/kernel/src/rating/README.md` does not expand this research. The comparison
is [search-rating-epochs.md](search-rating-epochs.md), inspected independently at repository commit
`bee5bb59d94a6f844ae9642278d26779137e0101`; its conditional-script recommendation is evidence, not authority.

## Primary sources and method

The implementation target is **OpenSearch 3.9.0**, pinned by `services/kernel/db/search/opensearch/Dockerfile`.
The following existing Git-object caches were reused under `/home/edge/projects/rezics/rezics-next/.reference/`.
Their revisions/licences already appear in `INDEX.md`; no new clone or metadata entry was needed.

| Project                                                                                                                             | Revision and cache path                                                                         | Licence                                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------- |
| [OpenSearch](https://github.com/opensearch-project/OpenSearch/tree/4ee42a94e87f66fbf1e62a9871b1b87f91e02472)                        | Tag `3.9.0`, `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`; `search-rating-populations/opensearch` | Apache-2.0, `LICENSE.txt`, `NOTICE.txt` |
| [Official documentation](https://github.com/opensearch-project/documentation-website/tree/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf) | `9bf360dee6e0930aa0bd66ba91e992b9ee2828bf`; `search-rating-populations/documentation-website`   | Apache-2.0, `LICENSE`, `NOTICE`         |

Sources were read with Git object inspection and official documentation URLs; reference software was never
installed, built or run. Current `/latest/` pages are explanatory and mutable; the pinned engine source below
anchors version-specific findings. No Elasticsearch-only feature or Lucene implementation assumption substitutes
for OpenSearch evidence. The proofs and pseudocode are this report's deductions, not copied implementation.

| Concern                  | Official documentation and pinned OpenSearch source evidence                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase predicates         | [Boolean queries][bool] define conjunction and exclusion. `server/src/main/java/org/opensearch/index/query/ExistsQueryBuilder.java:158–198` delegates existence to the mapped field; [`MappedFieldType.java:356–363`][exists-source] uses a native `FieldExistsQuery` for doc-valued fields.                                                                                        |
| Null and missing         | [Exists documentation][exists] distinguishes absent/null values from a configured `null_value` and from arrays with present values. Existence is neither a public-eligibility test nor a scalar/type validator. The proposed fields have both indexing and doc values enabled, avoiding the documentation's simplified `index:false` description.                                   |
| Field ordering           | [Sort documentation][sort] specifies lexicographic sort priority, explicit missing placement and multivalue modes. [`search/sort/FieldSortBuilder.java:410–449`][field-sort] obtains field data and constructs native sort fields.                                                                                                                                                  |
| Continuation             | [`search/searchafter/SearchAfterBuilder.java:124–149,177–229`][after-source] requires the tuple length to match the sort, preserves null and converts values to the comparator type. [`search/SearchSortValues.java:70–88,104–110`][sort-values] serializes returned numeric/string/null keys.                                                                                      |
| Shards and counts        | [`action/search/SearchPhaseController.java:224–240,848–884`][merge-source] merges field-sorted shard results, sums hit counts, propagates `gte`, and caps the reduced total. [`search/query/TopDocsCollectorContext.java:437–481`][collector-source] passes the continuation into the top-hits collector separately from the query/count; count shortcuts also use the whole query. |
| Query versus post-filter | [Filtering documentation][filters] distinguishes query filters, which constrain hits and aggregations, from `post_filter`, which leaves aggregations broader. [`search/query/QueryPhase.java:225–259`][query-phase] installs the post-filter as a top-hit filtering collector. Use query-level phase filters here.                                                                  |
| Generation resolution    | [Atomic alias operations][aliases] switch aliases atomically, but [`action/search/TransportSearchAction.java:1087–1137`][transport-source] resolves a search request's concrete indices/routing from cluster state. Separate requests are not one atomic alias read.                                                                                                                |

## Preconditions and fixed-state proof

Let `M` be the subjects matching the identical admitted text, subject filters and discovery scope in one physical
index generation. Fix those documents, shard readers, selected question and current native state for this proof.
Let `E` be the current eligible Global prior epoch, or null for **known** ineligibility. An unavailable native read
is an error, not null. Epochs are opaque exact keyword tokens, not floating-point identifiers. A valid eligible
epoch identifies its frozen prior; recovery must not attach changed prior meaning to an old token.

Dedicated Global standard-question fields `rating_prior_epoch` and `rating_score` are illustrative names, not existing schema.
Publish the epoch and its score together from the same public figure in one document replacement. Require one
scalar epoch and one finite nonnegative numeric score when scored; no indexed sentinel or `null_value` replacement.
Use a common numeric mapping, preferably `double`, and doc values; do not change types across shards. Producers must
not stamp an old score with a new epoch. The existing subject mapping is strict and lacks these rating fields:
an implementation needs a new compatible mapping/template version and readiness checks, not an edit to a released
template. An unmapped numeric sort can fail even when its filter matches no documents. [Field-sort source][field-sort].

Define `P(d) = E != null AND d.rating_prior_epoch == E AND exists(d.rating_score)`.
Phase `A = M ∩ P`; phase `B = M ∩ NOT P`. With eligible `E`, construct `P` as one `bool.filter` containing the
epoch term and score existence clause. Put that **whole conjunction** inside one `must_not` in B. Two separate
`must_not` clauses would mean `NOT epoch AND NOT exists`, losing current-epoch missing scores and stale numeric
scores. With null `E`, synthesize A empty and search B as all of M; never send a null-valued epoch term. [Boolean semantics][bool].
Wrap the unchanged common query in an outer `must` and add the phase as a filter. Adding filters inside an existing
text `bool` can change its default `minimum_should_match`. Keep `_score` out of both sorts and score tracking off.

1. **Disjoint and exhaustive:** `P ∧ NOT P` is false, and `P ∨ NOT P` is true; hence A and B partition M.
   Stale, absent or null epochs and absent/null scores remain in B. Real numeric zero is present and belongs to A.
2. **Order:** the effective key is `(scored first, score descending if scored, name_sort ascending, id ascending)`.
   Sort A by score/name/id and B by name/id, then concatenate. Every A key precedes every B key; the engine orders
   each phase exactly as that key requires. Equivalently, use score for A and `-1` for B in a conditional script.
3. **Totality:** use the indexed normalized keyword `name_sort`, explicitly `missing:"_last"`, and a mandatory,
   unique copied keyword `id` as the final key. One subject document per generation is required. Missing names tie
   with other missing names and are resolved by id. Do not rely on internal document or shard IDs for ties.

For example, current score `0` named Zulu precedes stale score `100` named Alpha. Two current equal scores use
name/id; all unscored subjects use name/id regardless of their old scores. A nullable score is not numeric zero.
Mixed shards do not change the proof: each shard's top-q phase prefix suffices for the coordinator's global top-q;
an omitted shard hit already has q predecessors on that shard. The unique final id removes merge tie ambiguity.
[Merge source][merge-source], [pagination documentation][pagination].

This is conditional equivalence, not malformed-data equivalence to the earlier script. For example, an indexed
score `-1` with epoch E passes the proposed `exists` predicate, whereas that script masks it; epoch arrays and score
arrays can match/select values differently from its scalar guards. Enforce scalar, finite, nonnegative publication
invariants. If malformed records must instead be tolerated, a range guard can exclude negative numbers, but
`exists` alone cannot prove scalar cardinality. That requires an explicit validation/mapping contract; do not
silently claim the candidate predicate has the script's defensive checks. [Exists][exists], [sort modes][sort].

## Bounded rounds, lookahead and raw continuation

Retain the repository's outer ceiling of three refill rounds and a **shared** raw-hit quota
`q = min(200, 2 * remaining_page_slots + 1)` per round. A phase search may use `size:0` for totals, with no source
fetch; a phase hit search uses at most q. These zero-size calls are supported engine searches, although the current
`query.ts` helper only permits positive sizes and would need an explicit implementation path.

```text
admit native E and one physical generation G; verify the signed cursor binding
for each permitted round:
  if phase A:
    fetch A after its raw tuple, size q (or synthesize empty A when E is null)
    check bounded current source proof; consume in native order
    if A is proven exhausted AND every fetched A hit was consumed:
      enter B; fetch B after no tuple, size q - fetched_A_count
    else:
      fetch B size 0 if its total is needed
  else:
    fetch A size 0 if its total is needed (or synthesize empty A)
    fetch B after its raw tuple, size q
  consume checked B hits if any; stop on acceptable lookahead or quota/round limit
recheck native E; return only if the admitted semantics still match
```

The count-only side may be omitted if the response already has suitable phase totals; never add a third search
to refill after using both calls. Thus each round has at most two phase searches, at most 200 returned raw hits
**combined**, and at most six phase searches/600 raw hits over three rounds. Metadata resolution and bounded native
reads are additional calls, not hidden inside this search count. Do not grant each phase its own 200-hit quota.

On complete successful responses, `hits.length < requested_size` proves no more hits **in that phase after that
tuple**, independent of capped totals. A full response does not prove exhaustion. Do not switch to B just because
current checks rejected every A hit or because a capped count appears reached. Timeouts, failed shards and
unjustified truncation cannot prove exhaustion: disable partial search results and validate response status.
Do not use `terminate_after` as a cost bound; it can destroy the top-q/completeness proof. [Search API][search-api].

Advance only to the last **consumed** native tuple, including rejected hits and rejected lookahead. Stop before an
acceptable lookahead when the output page is full; it must remain retrievable. Never advance to the last fetched
hit automatically. A short A page with an unconsumed acceptable hit is still A continuation. Once all A hits are
consumed and exhaustion is proven, a full output page may carry a B-start cursor with no B tuple; this avoids
discarding B's first result. A full A response may require another bounded round/page to prove exhaustion, even
if it actually ended exactly at q. Partial or even empty pages may have a continuation when budgets run out.

Example with page size two and q five: A returns one acceptable hit, so B can return at most four candidates.
Return the first acceptable B hit and leave the next acceptable B hit as lookahead. If B starts with rejected
hits, consume their raw tuples too. Conversely, if A returns five rejected hits, continue A next round; there is
no basis to return B ahead of unseen acceptable A hits. These are deductions, not captured engine responses.

The signed envelope must bind Global, the standard question identity, selected nullable native epoch, operation/
sort-template version, physical generation, canonical request, viewer and phase. Store only that phase's raw
engine `sort` array: A has `[score, name_sort, id]`, B `[name_sort, id]`. A B-start cursor has no `after`; never
convert an A tuple into a B tuple or a script-sentinel tuple. Reject wrong arity/types/phase. Preserve finite
numbers, strings, null names, normalized names and precision exactly. Numeric missing sort values can be extremes/
infinities rather than JSON null; A's existence invariant avoids missing numeric keys, and B has no numeric sort
at all. A defensive query-time finite `missing:-1` is different from indexing `-1`. [Missing-value source][missing-source].
The existing `search/cursor.ts` already preserves finite numbers, strings and null; its generation field does not
by itself bind a native prior epoch or phase. Reconstructing sort keys from displayed/current source values is unsafe.

## Honest capped totals

For cap C = 10,000, request `track_total_hits:C` on both phase queries, including a count-only phase when its hits
are not yet reachable. Phase totals count the whole phase query, not just the suffix after `search_after`; do not
sum totals repeatedly across rounds/pages. In fixed state, for `(a,ra)` and `(b,rb)`:

```text
value = min(C, a + b)
relation = eq only if ra == eq AND rb == eq AND a + b <= C; otherwise gte
```

The proof follows from the partition and each phase's exact count or lower bound. Examples: `(4,eq)+(6,eq)` is
`(10,eq)`; `(6000,eq)+(6000,eq)` is `(10000,gte)`; `(10000,gte)+(0,eq)` stays `(10000,gte)`;
`(4000,eq)+(6000,eq)` can honestly be `(10000,eq)`. Known null E contributes synthetic `(0,eq)` for A.
Never report only A's total or `min(a,b)`. Source reduction already handles per-shard threshold/cap propagation;
the application must still cap the sum **across phases**. [Count documentation][search-api], [count reduction][count-source].

These are indexed candidate totals. Current disclosure/figure rejection and unresolved filter overflow can make
candidate counts exceed actual publishable matches. A candidate superset count must not be renamed a current
lower bound. Extend the service's disclosed-hit lower-bound pattern to rating rejection/unknowns: only distinct
currently proven disclosed hits support that response lower bound. The current code has no rating rejection signal
yet. Otherwise identify totals as indexed progress, as `search/README.md` requires. Do not subtract only the observed
rejected prefix and call the remainder exact. Uninspected candidates may also fail.

Without a fixed state, even pinning G does not make A/B totals one snapshot: count a subject in A, republish it
into B, then count B, and the sum counts it twice. The reverse move can miss it. Equal epoch/generation checks
cannot detect every such move. An `eq` sum means exact only under the fixed-state premise (or describes the
constituent indexed observations), never exact live cardinality. A current live total needs additional consistency
machinery; two separate searches without PIT do not prove one.

## Generation and native-state safety

Resolve the alias **before** either phase into exactly one validated physical generation name G, then address that
name for both phases, count-only calls and every refill. Check a continuation's generation against the admitted
active generation; reject obsolete continuations under the restart policy. Require generation names never to be
reused for different physical indices, or additionally bind/validate index UUID. A missing/retired pinned index
fails or restarts; never silently retry the alias and combine generations. If alias filters/routing were used,
pin their semantics too; physical-name searches do not inherit them automatically. [Aliases][aliases], [resolution source][transport-source].

Counterexample to per-call alias use: A searches generation G1, the alias switches, and B searches G2. A subject
scored in G1 but unscored in G2 appears twice, and another can disappear; even zero-hit responses cannot identify
which generation was searched. `service.ts` currently infers generation from nonempty hits and resolves/caches the
alias after empty hits. That is insufficient for this plan. Carry G from pre-search metadata even for zero hits,
and use G for freshness. If an end-of-request alias check observes a switch, restart if the publication policy
requires that; otherwise the entire response must remain explicitly G and continuation must restart on the next
admission. An atomic alias switch does not freeze documents or make two alias searches atomic.

Read the selected native epoch/eligibility before discovery; use the same selection for all phase predicates,
checks and cursor construction. Re-read before returning; a visible E1→E2, E→null or null→E requires restart,
not changing parameters halfway through the response. A failed current-state read fails closed. These bracketing
reads prove observations, not a transaction spanning native storage and OpenSearch, nor protection against a change
immediately after the final read.

A null→eligible→null interval has the **same current unscored ordering rule** at both observed endpoints. A nullable
epoch proves that the prior was known ineligible at the read and all scores were masked then; it does not prove
that no eligible interval occurred, that no document/name changed, or that an earlier cursor was continuously valid.
Allowing the null cursor again is consistent with current-rule equality and the explicit live-pagination limits.
The comparison report's stronger requirement to invalidate on every intervening transition cannot be proved from
two nulls. That contract would need native history retained through null, such as a monotonic revision changed on
every relevant transition, and a cursor binding to it. This report does **not** introduce such a field. Unique
eligible epochs distinguish E1 from E2 after recovery but cannot distinguish null-before from null-after.

## Current figure eligibility and live movement

Never use an old indexed score, or even a matching prior epoch, as proof of current public per-figure eligibility.
For the bounded returned candidates, check native public eligibility and the needed figure revision/score witness,
as well as ordinary subject disclosure. A scored candidate that loses proof is consumed and rejected; its raw A
tuple remains the continuation. Do not expose the old score, relabel the hit as unscored in place, or scan all
matches through native storage. `service.ts` already supplies the consumed-hit/refill pattern; rating proof is an
additional proposed requirement, not something the current code already verifies.

Fixed-state counterexample to **complete current-source ordering**: x is indexed `(E,9,"Alpha")`, but its current
native figure is below the disclosure threshold; y is unscored with name Beta. A finds and rejects x; B excludes x
because the indexed P is still true. The current-source order would include x as unscored before y. Returning y
alone is safe under the existing discovery/completeness distinction, but is not that complete order. A newly
eligible native figure still indexed stale/missing similarly cannot be moved into the correct scored position by
checking a fetched prefix. Neither two native phases nor the proposed conditional script repairs this discrepancy.

During live republication, B→A movement can jump into an already-consumed A prefix or into already-finished A and be
missed; A→B movement can repeat an already-returned subject. The two requests in one round can also observe that
move; suppressing duplicate IDs within a bounded response is useful but cannot prove duplicate-free traversal.
Ordinary name/score/filter updates and deletes cause similar drift even with E and G unchanged. No reranking a
truncated prefix, stale-epoch exclusion, cursor signing, or bounded refill removes this limitation. [Stateless pagination][pagination].

## Cost, alternatives and recommendation

Native sorting removes the rating script comparator entirely. It does **not** make field sorting O(1): engine work
still includes text/postings evaluation, term/existence/complement filters, doc-value reads and comparisons for
visited matches, shard top-q selection, counting and coordinator merging. A straightforward collector can do work
proportional to matching documents, with priority-queue work up to roughly `O(M log q)` for top-q selection; this
is a cost model, not a promised engine plan. Index-sort/competitive skipping and caches can help, not universally.
Both searches may repeat common-query work; `size:0` avoids fetching hits but may still count many matches.
[Doc values][doc-values], [native collector][collector-source].

With S shards, bounded q at the REST response does not preclude roughly S×q shard candidates/queues and distributed
work. `search_after` avoids growing offset result windows but does not bound matched-document visits. The 600-hit
application ceiling bounds returned/source-check work, not engine complexity or latency. Source proof must remain
batched over those candidates, with no all-match native join. Conditional script evaluation can likewise grow with
visited matches; compilation caching does not cache their results. [`ScriptSortBuilder.java:413–442`][script-source]
executes the per-document numeric script through its comparator. No measured speedup is established here.

| Alternative                                                    | Assessment for this stack                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two native phases                                              | Recommended for the stated fixed-state effective order, with the explicit invariants, raw phase cursors, generation pinning and bounded rejection semantics above. Removes rating script execution at the cost of an extra phase/count search and boundary handling.   |
| Fixed conditional script                                       | Simpler one-sort/one-search pagination and one indexed count observation; extra comparator execution and defensive data guards. Equivalent on valid data and subject to the same native eligibility, generation and live traversal limits.                             |
| Raw score sort, epoch-first sort, or current-epoch-only filter | Incorrect: stale scores rank, epoch groups get the wrong name ordering, or stale/unscored subjects disappear. Sorting a fetched prefix cannot repair the missing global order.                                                                                         |
| Immutable complete generation                                  | Can supply a stable indexed order when the whole generation remains immutable and retained, with all unscored subjects included. Requires publication/storage/retention machinery; alias promotion alone does not create immutability or preserve current eligibility. |

The shared pattern in the primary sources is native predicates over indexed facts, doc-valued total-order keys,
explicit unique tie breakers, bounded top-hit delivery separate from counting, and explicit consistency boundaries.
Adopt the two-phase design for candidate discovery if those invariants and the existing eventual completeness
contract are retained. Keep current figure checks and restart on observed semantic changes; do not adopt the
stronger current-source complete-order or transition-history claims accidentally. Measure broad/selective queries,
epoch mixtures and shard counts on the pinned engine before making a performance claim.

Implementation verification should cover zero/current/stale/null/missing scores and epochs, missing names and
numeric sentinel avoidance, tied scores across shards, malformed scalar assumptions, zero/full/short A boundaries,
rejected lookahead, B-start/raw tuple signing, q shared across phases, both `eq`/`gte` count combinations and cap,
alias switches including zero-hit searches, mid-request epoch changes, current figure rejection, and both directions
of live phase movement. These are follow-up proof obligations, not tests or runtime evidence supplied by this report.

[bool]: https://docs.opensearch.org/latest/query-dsl/compound/bool/
[exists]: https://docs.opensearch.org/latest/query-dsl/term/exists/
[sort]: https://docs.opensearch.org/latest/search-plugins/searching-data/sort/
[pagination]: https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/
[search-api]: https://docs.opensearch.org/latest/api-reference/search-apis/search/
[filters]: https://docs.opensearch.org/latest/search-plugins/filter-search/
[aliases]: https://docs.opensearch.org/latest/api-reference/alias/aliases-api/
[doc-values]: https://docs.opensearch.org/latest/mappings/mapping-parameters/doc-values/
[exists-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/mapper/MappedFieldType.java#L356-L363
[field-sort]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/sort/FieldSortBuilder.java#L410-L449
[after-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java#L124-L229
[sort-values]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/SearchSortValues.java#L70-L110
[merge-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/action/search/SearchPhaseController.java#L224-L240
[count-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/action/search/SearchPhaseController.java#L848-L884
[collector-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/query/TopDocsCollectorContext.java#L437-L481
[query-phase]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/query/QueryPhase.java#L225-L259
[transport-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/action/search/TransportSearchAction.java#L1087-L1137
[missing-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/fielddata/IndexFieldData.java#L210-L235
[script-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/sort/ScriptSortBuilder.java#L413-L442
