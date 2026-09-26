# Graph-integrated full-text acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| SEARCH01 | Join Realm-effective statements/rating, Main Version Chinese body and text query | One admitted ARQ/jena-text request yields correct binding and ranking scope. |
| SEARCH02 | First search candidates all fail graph condition | Prove the result within the profile's fixed call/work budget, or return the declared budget/asynchronous outcome. No open-ended refill, false empty answer or false complete Top-K. |
| SEARCH03 | Public title and private body contain different terms | Private text cannot affect hits/snippets/facets. |
| SEARCH04 | Join two valid standing-rating paths to one text MatchUnit and one path to another eligible unit | Exactly one result per effective Main Version, unchanged per-unit text score and total, exact current-slot rating sum/count, and no collapse of the second unit. Denied classification and stale continuation remain excluded/restarted; raw candidate overflow is a typed budget outcome. |
| SEARCH05 | Run policy search on unsupported multi-dataset/source path | Explicit unsupported/unavailable, not successful empty result. |
| SEARCH06 | Index/query Chinese, Japanese, Korean and mixed identifiers through public Main and Realm phrase lanes | The same versioned analyzer returns relevant matches bound to the exact selected Contribution revision and MatchUnit. Language filters exclude matching text in other tagged variants; source bodies and language tags remain exact. |
| SEARCH07 | Change joined author/classification/selection | Bounded affected-root refresh, not full-corpus sync. |
| SEARCH08 | Switch analyzer/backend generation during paging | Snapshot-bound cursor or explicit restart; rollback respects erasure. |
| SEARCH09 | Ask historical search on current-only index | Unsupported result, not mislabeled historical data. |
| SEARCH10 | Exhaust candidate/memory/time budget | Typed partial/budget outcome; count/facet precision independently stated. |
| SEARCH11 | A visible searched property coexists with a hidden matching property | Any-visible-property admission cannot reveal the hidden match, score, snippet or count. |
| SEARCH12 | Access/content epochs advance on opposite sides of query admission | The declared lease/fence behavior holds; no unqualified post-filter fallback. |
| SEARCH13 | Delete the last indexed triple in a named graph | Keep a nonindexed sentinel in that graph and verify it exists, then query text without an RDF join; a vanished graph must not mask a stale index entry. |
| SEARCH14 | One subject has title/body predicates with terms split across fields | Per-triple behavior is explicit; cross-field conjunction uses joined bindings with declared score aggregation. |
| SEARCH15 | Change one graph literal after pinning an index reader, or crash between store/index operations | No false complete fenced result; suspend/rebuild or use a qualified paired reader. |
| SEARCH16 | Page after a graph/index change or authority narrowing | Materialized handle with current disclosure or explicit restart; HTTP requests do not share a TDB2 snapshot. |
| SEARCH17 | Import RDF directly while bypassing the text wrapper | Search stays unavailable until offline rebuild and membership/frontier checks complete. |
| SEARCH18 | Increase corpus size, degree, rejected candidates, languages and payload sizes; run with cold caches, stale readiness, retries and cursor creation | End-to-end traces stay within the profile's numeric total-call, serial-stage, byte, fanout and retry caps, including Account/Access and nested adapters. Over-cap input is rejected/routed explicitly; no per-hit calls or automatic refill. Core admitted queries retain correctness and meet the elected mixed-load latency/error objectives rather than passing by rejection. |
| SEARCH19 | PostgreSQL body revision commits before graph adoption/index visibility; duplicate and reorder both owners' events | Only exact eligible adopted revisions contribute. Stale workers cannot replace newer text; missing units yield declared pending/unavailable, never false complete empty. Public/private and same-language variants remain distinct; sparse Realms do not multiply body copies. |
| SEARCH20 | Lose the RDF body projection and Lucene index, then restore with a changed Content cut and erasure frontier | Regenerate approved MatchUnits from exact PostgreSQL revisions plus graph references, then rebuild Lucene. Missing bodies keep affected search unavailable; erased or draft text cannot reappear. Indexer success alone does not prove source completeness. |

The adopted [statement aggregation](../contracts/search.md#statement-aggregation)
adds owner scenarios to the retained IDs; current bounded phrase-lane evidence
does not qualify these replacement reads:

- SEARCH01 and GRAPH01: a non-red-haired female lead plus a different red-haired
  supporting character must not match a red-haired-female-lead query. Exercise
  release/canon/time mismatch as well as a positive same-participant case.
- SEARCH04: multiple supporting statements, navigation paths and overlapping
  groups yield one qualified fact and distinct Work/character totals at the
  requested grain. Repeated relation occurrences remain distinct when counted.
- SEARCH03/SEARCH11: hidden or spoiler-protected statements, names and avatars do
  not affect public bucket keys, counts or suggestions.
- SEARCH07/SEARCH08/SEARCH16: source withdrawal, definition/decision change and
  group/selection generation changes invalidate affected results and continuations.
- SEARCH10/SEARCH18: counts cover the declared complete eligible population or
  disclose incomplete precision; support/avatar hydration has fixed batch budgets.
  Default facet counts retain all filters; an explicit self-filter-excluding mode
  reports its different population without dropping mandatory scope.

The shared [Context selection](../contracts/context.md) also refines:

- SEARCH01/SEARCH04: the same concept/label under different criteria produces
  separate qualified results; exact definitions shared by two Contexts may match
  the same meaning without pooling acceptance or voters. Broader union needs an
  admitted mapping and distinct-target counting, not a sum of context buckets.
- SEARCH03/SEARCH11: hidden Context definitions, private personal selection links
  and unavailable parent revisions cannot affect public terms, counts or previews.
- SEARCH07/SEARCH08/SEARCH16: a changed speaker default cannot retarget saved exact
  filters or authored statements. Explicit successor adoption and preference-only
  ordering changes invalidate only their relevant result/cursor dependencies.
- SEARCH10/SEARCH18: scope/definition resolution and shared hydration are bounded
  as consumer count and inherited depth grow. Ambiguity or incomplete semantic
  basis cannot become a complete zero or exact facet count.

These are pending owner requirements, not extensions certified by the recorded
v1 phrase-lane fixtures below.

The `public-search-unsupported` API fixture submits declared multi-dataset
`sourcePolicy` and historical `asOf` selectors to all six public phrase profiles
and their six page profiles. Every path returns a specific 422 problem before
native index access; unknown or malformed fields still return 400. This is a
negative boundary case only. It does not qualify multi-source or historical
matching, current authority over historical content, or federation capacity.

The isolated SEARCH20 fault fixture covers a changed Content cut, lost RDF unit,
offline Lucene replacement, restart, erased superseded revision, unpublished
draft and missing current body under quarantine. This is a fixture subset;
SEARCH20 remains absent from complete-case coverage until product erasure and
withdrawal operations and their authority frontier are exercised.

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.

The `SEARCH13` shared-stack fixture retains an RDF sentinel in the named graph,
deletes that graph's last indexed literal, confirms the graph still exists and
checks the text wrapper without an RDF property join. Its executed integration
case is the complete `SEARCH13` oracle in the QA coverage declaration.

The candidate SEARCH11/12 unit tests cover exact private subject binding,
private field isolation, missing projection/posting, Access-before-match
ordering, a changed native head or private write epoch at pre-send recheck,
receipt/abort distinction and fail-closed HTTP delivery. The cmd0.5.15 native
journey and its remaining falsification gates are described below. Source-only
tests do not qualify this lane.

The authored `private-search-native` fixture uses an isolated persistent QA
project with the product command-only Fuseki assembler and a disposable
PostgreSQL Access owner, so its recovery hold cannot affect parallel QA cases.
It exercises the private posting audit, a selected public
body beside a hidden draft, exact Contribution object/graph/index projection,
Access-before-match denial, two Access registry instances, pre-send head change,
expiry, recovery hold, principal/scope closure, final send-arm rejection,
and pre-arm abort versus a post-arm disconnect that stays unresolved through
closure.
It checks the HTTP route stays closed and passed merged QA
`20260925t085124-7fa328`;
the Content-owned private body path, concrete-subject Jena query plan,
cross-owner final check/arm race, and real socket cancellation remain separate
SEARCH11/12 qualification gaps. Neither ID is declared complete by this fixture.

The isolated `SEARCH02/SEARCH10` candidate-overflow fixture inserts 512 native
text postings with no eligible Main relation and requires a complete empty result.
One more posting must yield the public API's typed budget result. It exercises
the real text wrapper and query, while its synthetic
raw seed does not qualify the product command path or larger relation topology.

The current SEARCH03 fixture in
`tests/qa/integration/content-publication-native.test.ts` creates a public Work
title and a published Content body, then retains an unpublished draft with a
distinct search term. It compares public Content hits, scores, population and
response fields across the draft write, probes the native public text graph,
and repeats the private-term query after a different body is published. This
qualifies the installed body-only response surface when its isolated integration
tier passes. Title search, snippets and facets require separate cases if those
surfaces are added.

Merged selected integration `20260926t122802-263b0c` and the QA coverage unit
passed for this installed body-only lane. SEARCH03 is a complete-case candidate
pending one clean recorded backend QA; the selection remains a partial run.

The shared-stack `public-search-scale` fixture builds the rated Realm relation
through native Work, Contribution, selection, classification and standing-rating
commands. It directly observes two valid text/rating join paths for one selected
MatchUnit and one for a second, then checks the public result has two distinct
units, stable text scores and exact integer rating aggregates. It also checks
local classification rejection, a rated continuation invalidated by the second
rating, and a separate unit-level 513th-hit budget outcome. The fixture does
not qualify multi-field score combination or broader query descriptors.

The `WORK03/SEARCH07/SEARCH19` native selection fixture changes global and
Realm-local classification heads, then adopts, replaces and rejects one Realm's
selected Contribution. It checks the joined query results and exact RDF
MatchUnit triples for both Works at each boundary. An alternative public
Contribution has a different immutable author; adopting it changes the Realm's
author-scoped results while Main and the other Realm stay on the original author.
The 103-Work scale fixture also switches one Main selection to a new author,
compares every unaffected Work's selected head and MatchUnit identity, and counts
fixed Fuseki calls for the author-scoped phrase and joined rated reads. SEARCH07
remains partial. The cmd0.5.13 candidate journals actual public graph changes
and can replay bounded certified units on the command-only product service;
the QA assembler's general update endpoint forces the full inventory. Native
and Main unit cases cover no-op and replacement mutations, a 65th actual unit,
claim mismatch, duplicate Lucene document, contiguous replay, gaps, bypass and
restart. Later cmd0.5.15 evidence includes a 10-Work product-only diagnostic with
a bounded native delta, no full inventory and a private Contribution restart
probe; see the [execution plan](../plan/README.md#execution-program). These scoped
checks do not establish the complete growth bound. Follow
[complexity verification](complexity.md): vary unrelated corpus, affected units,
degree and rejected candidates independently, count native work as well as calls,
and require the new selection without a corpus-wide inventory. Large fixture
size is not a substitute for those assertions.

The same fixture exercises the public Main phrase page contract over 102 matching
Works, joins three pages without omissions or duplicates, and rejects an old
continuation after another product write. It also pages accepted Main and Realm
classification and a two-result rated Realm query through the public API. Unit
cases reject a changed query, Sense, RatingContext, threshold, ordered result or
index generation and an expired continuation. The Content continuation binds both
the graph and PostgreSQL Content owner positions; its two-variant HTTP
paging/restart case contributes to the partial P0.8 evidence recorded in the
plan. SEARCH08 and SEARCH16 remain partial: private paging, erasure rollback and
broader authority narrowing are not qualified by these public lanes.

P0.8 runs the selected PostgreSQL + Jena binding with mixed publication/query
load, common/rare terms, skewed relationships and representative Chinese text.
Retain complete-result oracles, query plans, all remote attempts, body-batch bytes,
TDB2 writer occupancy, projection lag and P95/P99 including failures/rejections.
The prototype's 100-unit inventory and a single HTTP request are not launch
performance evidence. A gate cannot pass by rejecting the ordinary core workload.
