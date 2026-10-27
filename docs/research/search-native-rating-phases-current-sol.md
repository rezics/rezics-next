# Native phases for Global rating order

Research date: 2026-10-28. Evidence and recommendation for the owning Goal; not an adopted specification or runtime proof.

## Answer

**Yes, conditionally.** Two native queries give an exact disjoint partition and exact total order for one fixed OpenSearch projection, when both queries use the same captured current Global-prior state, the same physical index generation, and valid scalar projection fields. Phase A sorts the current-epoch numeric scores; phase B is the exact complement and sorts by name and ID. Score zero stays in A and therefore precedes every unscored result. Old-epoch, null-epoch, and missing-score documents go to B. No per-document script sort is needed.

This answers the fixed-state question for asynchronously mixed **prior epochs**. It does not make the asynchronous index a current native authority. If a subject's public figure has become ineligible while its current-epoch indexed score remains present, source validation can safely reject that hit, but cannot put it into B or preserve an exact current-native order. The page and phase totals then describe candidates, not the current eligible result set. This limitation also applies to the conditional-script approach.

Two searches per round bound the number of engine requests, not the engine work. Field sorts still read and compare native sort values for matching candidates. With no PIT, pinning an index generation and signing a raw search_after cursor do not freeze changes within that generation; no duplicate-free or omission-free live traversal follows.

## Scope and assumptions

The scope authority is [docs/scope.md](../scope.md): this question covers only the Global standard-question public aggregate. Realm ratings remain outside this comparison. The rating contract supplies the public figure and same-question Global prior semantics; this report does not change those rules.

For the proof below, assume:

- A request reads one native Global prior state before searching. It records both whether the prior is currently eligible and its opaque epoch token. Treat an ineligible or null-epoch state as no current epoch.
- A fixed physical generation contains one document per subject. All shards in it use compatible mappings. The indexed prior epoch is a scalar keyword; the score is a finite scalar numeric public score in the valid nonnegative rating range, with doc values. A score that is not public is absent, not represented by a numeric placeholder. Neither field uses a null replacement that can make an absent value look current or scored.
- The indexed prior epoch and score are a coherent projection of the same public figure. In particular, a current-epoch score field cannot remain present after that figure has lost current public eligibility if the response is to claim an exact current-native order.
- name_sort has one stable keyword sort value under the repository's name convention. The id sort field is keyword/doc-values backed and globally unique across the physical generation. The normal indexed document has one id and is not duplicated across shards.
- All subject, visibility, text, and user filters are identical in both phases. A filter rejection after retrieval is consumed as a raw engine hit, but it is not silently relabeled or reordered.

The current strict mapping at services/kernel/db/search/indices/subjects.json:48-95 has id and name_sort but not rating_score or rating_prior_epoch. The v2 template is also an existing released search template. Implementing this research direction would need an additive mapping and a new trusted template/version in the owning implementation work; this report makes no such edit.

## Partition proof

Let F(d) be the common subject/text/filter predicate. Let E be the captured native epoch, and let eligible be true only when the native Global standard-question prior is known eligible and E is non-null. Define:

- P(d) = eligible AND d.rating_prior_epoch equals E AND d has an indexed rating_score.
- A(d) = F(d) AND P(d).
- B(d) = F(d) AND NOT P(d).

A native term filter plus exists for rating_score expresses P. Put the exact same P under bool.must_not for B, outside the same F used in A. For every document satisfying F, P is either true or false, so A and B are disjoint and their union is exactly F. The per-document criterion is the whole P predicate: negating only the epoch term or only score existence is not its complement.

Sort A by rating_score descending, name_sort ascending, id ascending. Sort B by name_sort ascending, id ascending. Since every valid score is nonnegative, concatenating the complete A order before the complete B order is the requested order: descending score for scored subjects, then name and id for ties, then all unscored subjects by name and id. A real score of 0 remains in A and precedes B without relying on a synthetic sort sentinel.

If native state is known ineligible or its epoch is null, set eligible false and make P false for every document. A is then empty and B is all of F. Do not send a null epoch term as an attempted eligibility test, and do not fall back to an old indexed epoch. If native state cannot be read, fail closed instead of substituting cached/indexed eligibility.

OpenSearch documents that exists is based on an indexed value: a missing field, explicit null, or empty array normally has no value, while a configured null_value or an array with a non-null member does. That makes exists suitable for absent scores only under the mapping assumptions above. A numeric placeholder such as -1 is still an existing numeric value and would incorrectly enter A. Do not store an unscored sentinel in rating_score. A null_value of 0 would also misclassify missing scores as real zero. [Exists query][exists], [field mappings and doc values][doc-values].

## Query and continuation protocol

For each bounded refill round, issue at most one search for each phase against the same concrete physical index:

1. A uses F and P, sorted by score descending, name_sort ascending, id ascending.
2. B uses F and the exact complement of P, sorted by name_sort ascending, id ascending.
3. Both use the same request-wide text, filters, captured E/eligibility, capped hit-count threshold, and physical generation. When A is still able to fill the page, B can be a size-zero count search; once A is exhausted, B supplies the remaining page. When the response is in B, A can be size zero for its count. This keeps the search calls at two per round while preserving phase order.
4. Use a page-size-plus-one bounded lookahead, further capped by the repository's per-round maximum. Append B only after A is exhausted under the fixed state. If a phase returns a full bounded window, do not infer exhaustion from its count relation; continue that phase in a later bounded round if the refill budget allows. If the budget runs out, return the existing bounded partial behavior rather than scanning without limit.

The current Search service has a three-round ceiling and at most 200 raw hits per round (its page calculation is min(200, 2 * remaining + 1)); those are useful local request/source budgets, not an OpenSearch engine-complexity bound. A phase design can stay within two searches in each of those rounds. In the phase that is not supplying hits, size zero still counts as a search request.

Use the engine sort tuple exactly as returned. A cursor needs a phase tag because A's tuple is [score, name_sort, id] and B's is [name_sort, id]. Keep an independent raw search_after value for each active phase. Advance only from the last raw hit actually consumed, including a source-rejected hit; do not advance past an acceptable lookahead that was not returned. Once A is exhausted, start B with no previous B tuple; after that, continue only B. Do not reconstruct tuples from displayed names, round or stringify numeric scores, replace null with zero, or use a source label in place of the actual name_sort key. OpenSearch validates that search_after has one value per sort key and retains numeric, keyword, and null tuple values; its docs require a unique final sort field to stabilize ties. [Pagination documentation][paginate], [SearchSortValues.java][sort-values], [SearchAfterBuilder.java][after-builder].

Bind the signed cursor to the fixed Global question, captured prior eligibility and epoch/invalidation identity, physical generation, canonical filters/text/sort, viewer, phase, and the raw tuple(s). Reject continuations after the selected native state or generation changes. Do not reuse an epoch identity after a below-threshold loss and recovery: the same nullable/current value can otherwise hide an intervening transition from an old cursor. Recheck the native state before returning a response; if it changed during the phase searches, restart/fail instead of mixing two current epochs. This detects transitions visible to the reads, but it is not an atomic transaction across native storage and OpenSearch and cannot detect an ABA transition if the authority reuses its identity.

## Totals

Let C be the user-visible total cap. Ask both phase searches to track totals at C+1. For complete, non-timed-out searches with no failed shards or early termination:

- If both phase counts are exact and their sum is at most C, return that sum with relation eq.
- If either phase reports a lower bound at the C+1 threshold, or the exact sum exceeds C, return C with relation gte.
- Otherwise, where the exact sum is below C, return the exact sum with relation eq.

At C+1 the engine has enough information to distinguish every total at or below C from any total above C. This retains useful exact totals below the cap and never converts a lower bound into an exact count. OpenSearch's Search API defines eq as exact and gte as a lower bound, and applies an integer track_total_hits threshold to the number of matching documents. Partial, timed-out, failed-shard, or terminated responses cannot be promoted into an exact phase count. [Search API and track_total_hits][search-api], [SearchPhaseController.java:840-885][total-source].

That sum is an exact/capped count of the disjoint **engine candidate set** only while P matches current per-subject public eligibility. If application source checks reject candidates, do not return the phase sum as an exact count of currently eligible public results. A rejected candidate proves that indexed rating eligibility lagged the source; the count can then only be reported under the API's honest lower-bound semantics or the request must fail/restart. Counting only hits fetched for the page cannot recover an exact full result count.

## Edge cases and counterexamples

| Case | Phase result or requirement |
| --- | --- |
| Mixed epochs E1/E2, native current state eligible at E2 | E2 documents with a score go to A. E1, null/absent epoch, and missing-score documents go to B even if they retain an old numeric score. |
| Current native prior ineligible, or current epoch null | A is empty; every F hit is B. Old matching-looking document fields do not override native ineligibility. |
| Score 0 and scored ties | Zero is in A, ahead of every B item. Equal scores are ordered by the same name_sort/id suffix; B uses that suffix alone. |
| Missing name | The current indexer uses an explicit MISSING_NAME string in name_sort. If a mapped document can instead have a truly missing value, configure and keep one explicit missing-value order; the raw tuple may contain null. id must still be unique and the null must round-trip unchanged. |
| Numeric score sentinel | A numeric -1 or other placeholder satisfies exists and enters A. This breaks the partition's intended meaning unless disallowed by mapping/projection or expressly filtered as invalid. Use absence for unscored state; the negative sentinel in the conditional-script design is a computed sort value, not an indexed score. |
| Multivalued epoch, score, name, or id | exists may match an array and native sorting chooses a sort mode (min for ascending and max for descending by default). That is not the single public figure/name/id order. Enforce scalar values at projection and reject detectable violations; do not infer single-valued behavior from a field's mapping type alone. [Sort mode documentation][sort]. |
| Multiple shards | OpenSearch reduces shard hit windows by the supplied sort order. The same mappings and sort direction must apply on each shard, and the final id field must uniquely distinguish all subjects across the generation. A non-unique id leaves equal tuples dependent on internal shard/doc order. |
| Missing mapped field across physical indices | Keep one stable mapping in the selected generation. If an alias spans old/new mappings, unmapped fields or numeric type conflicts can change query/sort behavior. Do not use a multi-index alias as a substitute for a single generation. |
| Current per-figure eligibility lost but indexed epoch and score remain | This is a counterexample to exact current-native order. A contains the subject, B excludes it, then current-source validation rejects it. Consuming A's raw tuple prevents retry loops, but the subject is absent rather than appearing in B by name/id. Never disclose the old score or mutate its tuple into a B tuple. The two-phase filter alone therefore proves the order of the projection, not of a newer unprojected figure. |
| Prior state changes between phase requests | Both searches must use the one captured state. Re-read the authority before emitting the response and reject/restart if its non-reused state identity changed. If each query independently reads "current", A and B can overlap or leave a gap. |
| Alias switches between A and B | Alias actions are atomic, but separate searches by alias name resolve in separate requests and can see different active generations. Select generation G before A and issue both phases by G's physical index name. Retain G for the cursor lifetime or return restart-required if it is retired. |
| Zero-hit generation | Choose G before either search and bind it even when no hit supplies an _index value. Do not infer generation from the first hit or reread the now-active alias after an empty result. |
| Within-generation updates | A score/epoch/name change between requests can move a document across a consumed boundary, causing an omission or repeat. A generation number prevents alias mixing; it does not freeze document contents. No PIT means no duplicate-free traversal claim under live updates. |

Nullable epoch has a deliberately small meaning: when read as current native state, null means there is no current prior epoch token to match, so no document score can be admitted by P. In a fixed current order, a null-to-eligible-to-null history has the same present unscored placement as any other currently unscored subject. Null does not prove that the prior was never eligible, that an old score was removed, or that no transition occurred since a cursor was issued. A stronger transition/cursor contract needs a separate monotonic invalidation or state-revision identity that advances across loss and recovery. Auditing whether an epoch was ever eligible would require retained history; do not silently add either field to the candidate algorithm.

## Cost and comparison with a conditional script

The two phases avoid a script-sort evaluation for every matching candidate, but native sorting is not free. Doc values are column-oriented field values used for sorting. Each request still evaluates its common predicate and phase filter on shards, collects a bounded top-hit window per shard, reads/compares native sort values for competitive matches, and merges shard windows at the coordinator. Since both queries repeat F, combined engine work can approach two broad-filter passes even though A and B's returned sets are disjoint. Search-after and a small response limit reduce deep-offset and returned-hit work; they do not make matching/filtering/sort work independent of F. A capped hit total bounds exact count tracking, not all search and sort work. [Doc values][doc-values], [Sort results][sort], [pagination and search_after][paginate].

Compared with the conditional-script recommendation in docs/research/search-rating-epochs.md, the phase plan trades a stable one-query numeric-script sort for two independently filtered native-field sorts. It avoids running conditional Painless sort code per matching document and avoids the script's missing/unmapped field guards, but requires phase-aware cursors, two phase totals, strict complement construction, and physical-generation pinning across requests. The script approach has one ordered candidate stream and can mask a stale prior epoch without pre-clearing its score; its script-sort cost still grows with matching candidates. Neither approach repairs per-figure eligibility lag, freezes live keys, or proves a current-source total from index counts alone. The conditional-script evidence used for this comparison is a prior research input, not runtime proof or authority.

Returned and source work stays separately bounded: the application can cap each engine hit window and its rounds, then disclose/check only retrieved candidates in bounded source batches. Those limits say nothing about how many docs the engine must examine to determine each sorted top window. Do not label a native field sort O(1), infer an engine-complexity ceiling from a 200-hit window, or turn a source-candidate budget into an OpenSearch cost guarantee. No benchmark, cluster experiment, or runtime test was performed here.

The shared pattern across OpenSearch documentation/source and the conditional-script evidence is to keep executable/query structure fixed, make the selected epoch explicit input, sort on supported native values with a unique final tie-breaker, and treat alias/index state as an application binding. Materialized fields can reduce query-time script work, but do not turn the search index into the authority for current rating eligibility. A design should keep these distinctions while using the repository's own TypeScript, signed-cursor, and OpenSearch template stack.

## Recommendation

Adopt the two-phase plan as a candidate no-script implementation for the **fixed indexed-projection order** if the owning spec accepts these explicit preconditions:

1. One captured, non-reused Global prior identity applies to both phases and is cursor-bound.
2. Current public per-subject score eligibility is represented coherently in the queried generation, or a source rejection downgrades the response to partial/lower-bound semantics. A rejected phase-A hit is consumed, never disclosed, and never silently moved into B.
3. Both searches use one retained concrete generation, with a phase-tagged raw cursor and a per-phase capped total.
4. Exactness is claimed only for a fixed projection state. Live mutation can produce repeats or omissions without PIT; stronger traversal semantics would need an explicit immutability/snapshot contract.

Prefer it to the conditional script when avoiding per-matching-document script sort work is worth a second shard fan-out and the additional phase/cursor logic. Prefer the script's single stream if the owning Goal values one request path more and accepts measured script-sort cost. If the product requires the exact order of current native per-figure eligibility despite asynchronous indexing, neither choice is sufficient by itself; the authority must decide whether to delay/reject search until projection is coherent or specify a stronger versioned native witness. Do not add a nullable-history field without that decision.

## Evidence, versions, and method

OpenSearch is pinned to 3.9.0 in services/kernel/db/search/opensearch/Dockerfile. I reused the existing read-only source caches under /home/edge/projects/rezics/rezics-next/.reference/search-rating-populations/; their metadata already appears in that checkout's .reference/INDEX.md. Only Git object inspection and official documentation reads were used. Reference code was not installed, built, executed, or copied.

| Project | Inspected revision and cache | Licence |
| --- | --- | --- |
| OpenSearch source | Tag 3.9.0, commit 4ee42a94e87f66fbf1e62a9871b1b87f91e02472; cache search-rating-populations/opensearch | Apache-2.0, LICENSE.txt and NOTICE.txt |
| OpenSearch documentation source | Commit 9bf360dee6e0930aa0bd66ba91e992b9ee2828bf (2026-10-27); cache search-rating-populations/documentation-website | Apache-2.0, LICENSE and NOTICE |

The cited source paths below are relative to those pinned repositories. Documentation pages were checked against the documentation-source commit above on 2026-10-28. The official docs URLs use the site's latest route and can change; the pinned documentation-source commit preserves the inspected page text.

| Evidence | Primary source |
| --- | --- |
| Stateless search_after, unique final tie-breaker, field values carried in sort tuples, and live-update pagination limits | [Pagination documentation][paginate]; [OpenSearch 3.9 SearchAfterBuilder.java:124-229][after-builder]; [SearchSortValues.java:70-110][sort-values] |
| Exists/missing/null behavior and bool complement | [Exists query][exists]; [Boolean query][bool-query] |
| Native field sorting and multivalue sort modes | [Sort documentation][sort]; [IndexFieldData.java:221-235][fielddata-source] |
| Capped total and eq/gte semantics | [Search API][search-api]; [SearchPhaseController.java:840-885][total-source] |
| Alias changes are atomic as one alias operation | [Manage Aliases API][aliases] |
| Scope and public rating semantics | [First public scope](../scope.md); [Rating README](../../services/kernel/src/rating/README.md) |
| Current strict search fields/template, generation naming, and bounded search rounds | [subjects mapping](../../services/kernel/db/search/indices/subjects.json); [search template/query](../../services/kernel/src/search/query.ts); [search service](../../services/kernel/src/search/service.ts); [search generation names](../../services/kernel/src/search/indices.ts) |

[exists]: https://docs.opensearch.org/latest/query-dsl/term/exists/
[bool-query]: https://docs.opensearch.org/latest/query-dsl/compound/bool/
[doc-values]: https://docs.opensearch.org/latest/mappings/mapping-parameters/doc-values/
[sort]: https://docs.opensearch.org/latest/search-plugins/searching-data/sort/
[paginate]: https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/
[search-api]: https://docs.opensearch.org/latest/api-reference/search/
[aliases]: https://docs.opensearch.org/latest/api-reference/alias/aliases-api/
[fielddata-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/index/fielddata/IndexFieldData.java#L221-L235
[after-builder]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java#L124-L229
[sort-values]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/SearchSortValues.java#L70-L110
[total-source]: https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/action/search/SearchPhaseController.java#L840-L885

### Official documentation URLs

- [Paginating results with search_after](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/)
- [Sorting results](https://docs.opensearch.org/latest/search-plugins/searching-data/sort/)
- [Exists query](https://docs.opensearch.org/latest/query-dsl/term/exists/)
- [Search API and track_total_hits](https://docs.opensearch.org/latest/api-reference/search/)
- [Manage aliases API](https://docs.opensearch.org/latest/api-reference/alias/aliases-api/)
