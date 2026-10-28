# Search multi-leaf final-proof bound

Research evidence, 2026-10-28. This report recommends no product decision and changes no runtime.

## Finding

The current native Scope evaluator has **no implemented final-proof unit**: Search preparation,
prefix, service binding and Semantic leaf execution remain unavailable scaffolds. The adopted
contracts also do not prove that a future evaluator can finish every admitted multi-leaf query
within one shared 256 raw-key reservation.

There is a concrete admitted shape that defeats fresh replay. Nine independent, non-relation
material-property leaves can each have 32 current selected candidates, with the one matching
candidate last in the actual selection order. Proving the positive AND costs at least
`9 × 32 = 288` selected-candidate keys in a fresh evaluation. Even granting one previously
discovered matching identity as an ideal persisted position, the other eight leaves require
`8 × 32`, and that one positive must be revalidated for at least one more key:
`8 × 32 + 1 = 257`. Both exceed the 256-key ceiling before Search's candidate/lookahead,
alias-group work, identity checks or other final checks. This is a counterexample to the specified
replay and one-progress-record design, not a proof that every conceivable source-owned access
layout is impossible.

The existing coalesced `requestFacetRebuild` is not production code in this branch. Its design is
for relation-pair witnesses and cannot establish a bounded final unit for every material, code,
range and qualifier leaf. Completed relation maintenance can improve a matching hint, but it does
not remove the need for fresh source/target authority checks and does not transport earlier truth
across requests.

**Recommendation:** keep the current readiness response and preserve the 256 limit, admission
and no-cache rules until Semantic and Search agree on a source-owned, current selected-evidence
access seam with a measured worst final debit. Keep `compileCurrentFilter` and the current leaf
matchers as Search's only Boolean/range/qualifier interpreter. Require the native acceptance at
the end of this report before claiming liveness for either UUID Scope/Zone union or ordered
TypeList residual traversal.

## Scope and implementation status

This review is against `dev` / worktree base `f9f1c2179be15c6342ca004f1b3c167542348966`.
The relevant committed owner changes reachable from all local refs were also checked:
`b1da296be1` (Scope admission scaffold), `5f75fe673d` (Semantic leaf types),
`4108b9abf7` (Scope reservations and progress), `b5c978717f` (shared Boolean plan),
`430c5d6a1c` (shared leaf matcher), `c711d5b4c8` (relation-facet witness contract), and
`3e87e9b465` (relation-facet rebuild design). The latter commits specify contracts/tests; no
reachable owner commit adds a native Scope or relation-facet rebuild implementation. The current
dev code was read directly; absence was checked across reachable refs, not inferred from the docs
alone.

| Area | Actual code on `dev` | What it establishes |
| --- | --- | --- |
| Admission | [`packages/filter/src/filter.ts`](../../packages/filter/src/filter.ts#L1), [`scope-source.ts`](../../services/kernel/src/search/scope-source.ts#L118) | Filter limits are 32 leaves, 64 values per `IN`, depth 4 and OR width 16. `prepare` parses, admits and invokes the existing Search compiler, then returns retryable `semantic_not_ready`; it does not create a ready native scope. |
| Shared Boolean meaning | [`current-filter-plan.ts`](../../services/kernel/src/search/current-filter-plan.ts#L5), [`current-leaf.ts`](../../services/kernel/src/search/current-leaf.ts#L9), [`disclosure/check.ts`](../../services/kernel/src/search/disclosure/check.ts#L90) | Leaves are deduplicated by normalized clause and property/value/range/qualifier meaning. The plan requires one `true | false | not_proven` result per leaf. `holdsCurrentStatements` checks ranges and all qualifiers on the same statement; a partial window cannot prove false. Matched-query names only order work. |
| Scope budget/progress | [`scope-source.ts`](../../services/kernel/src/search/scope-source.ts#L19), [`scope-progress.ts`](../../services/kernel/src/search/scope-progress.ts#L7) | `rawKeys` is explicitly shared, can be 0..256, and is independent from points, witnesses, rows, bytes and empty seeks. The progress record names one subject and one leaf/value/phase/after position. Its encoded native record is exactly 18 bytes. |
| Search execution | [`scope-source.ts`](../../services/kernel/src/search/scope-source.ts#L88), [`service-scope.ts`](../../services/kernel/src/search/service-scope.ts#L11) | `prefix` and `evaluate` validate reservations and then fail closed. The service handoff still throws `index_not_ready`, even for a registered runtime. No positive Search Scope evaluation executes. |
| Semantic leaf | [`scope-leaf-evidence.ts`](../../services/kernel/src/semantic/scope-leaf-evidence.ts#L1) | The real exported types include a selected fact, current selection/empty-pair coverage, progress and six actual-usage axes. The only production implementation validates basic budget/revalidation shape and returns `not_ready` with zero usage; it does no SQL or Access work. |
| Current selection | [`candidates.ts`](../../services/kernel/src/semantic/candidates.ts#L557), [`slots.ts`](../../services/kernel/src/semantic/slots.ts#L71), [`slots-read-selection.sql`](../../services/kernel/src/semantic/slots-read-selection.sql#L1) | A real Global replacement adoption accepts up to 32 distinct candidate IDs. Expanded selection resolves those IDs in their persisted selection-array order. Compact slot resolution applies assertion/retraction operations. These are real write/read paths, not a hypothetical schema. |
| Relation hints and rebuild | [`relation-facets-design.md`](../../services/kernel/src/semantic/relation-facets-design.md#L1), [`relation-facet-rebuilds-design.md`](../../services/kernel/src/semantic/relation-facet-rebuilds-design.md#L85) | Both files say their production acceptance is red or describe new tables, SQL and runner paths. `relationFacetRebuilds`, `relation_facet_statement`, `facet_rebuild_request` and `requestFacetRebuild` are absent from the production source/schema in this checkout. The native tests dynamically require the exports after real commands; their fixture is a contract, not an implemented port. |

The Semantic current-leaf contract explicitly says to reuse the current `slots.ts` selection
machinery, read at most 32 expanded selected candidates, and keep compact operations within their
native 33-operation bound. It says range and qualifier predicates are not SQL filters, current
selected facts are evidence only, and every positive must receive current final revalidation
([Semantic README, current leaf evidence](../../services/kernel/src/semantic/README.md#current-leaf-evidence)).
Those are the assumptions used below. The actual `readScopeLeafEvidence` remains a stub, so this
report does not describe it as though its future SQL exists.

## Admitted native counterexample

The example uses an actual supported storage/write shape:

1. Define one active type with nine different material properties in its `properties` set and
   `facets` set. Nine is below the current 16-facet-per-type release bound. Define them as
   multivalued, non-relation item properties with current eligible target types. The filter
   validator admits item-value `IN` clauses on declared facets; item values must be real UUIDs.
2. For each property, create 32 valid candidates through the existing Semantic command path and
   select all 32 with `adoptCandidates({mode:'replace'})`. The production writer rejects only
   selections longer than 32, validates each candidate against the real slot, and persists the
   current selection. The slot reader fetches the selected candidates by the stored ordinal.
3. Admit an AND of the nine distinct statement clauses. Give each `IN` list 64 valid UUIDs. For
   each property, the 31 earlier selected candidate values are outside that list; only selection
   ordinal 32 is in the list. All nine final selected facts are current, visible and authorized.
   Each target has a real current foreign subject/visibility observation. Use properties without
   `relation` metadata, so the relation-facet pair hint path is not available. This is a valid
   release, filter and write shape, not an impossible synthetic limit combination.

The shape follows the actual contract limits (`FILTER_LIMITS.leaves = 32`, `in = 64`), the
actual release facet bound, the actual 32-entry adoption guard, and the real selection-array
reader. The existing current-leaf fixture builds releases and candidates through
`proposeStatement`/`adoptCandidates`; it already uses real selected properties, typed material
values and foreign subjects. Extending that fixture to nine independent declared properties does
not require direct insertion into an impossible schema.

### Key debit

Each distinct property needs its own selected slot evidence. The 32 selection entries for one
property are 32 distinct candidate identities and each must be examined to find the last matching
fact or to establish complete selection coverage. The 9 properties do not share evidence:

| Work | Lower-bound raw keys |
| --- | ---: |
| Fresh current selected-candidate replay: 9 properties × 32 selected facts | 288 |
| Ideal retained one positive identity; replay eight other properties | 256 |
| Exact current revalidation of that retained positive | 1 |
| Ideal one-progress-record final request | **257** |

This is deliberately favorable to the implementation. It excludes one raw Search candidate,
prefix lookahead, every original/terminal alias key, identity-group rereads, source selection
drivers, native empty-seek keys, and any separate final checks for the other eight positives.
The same ledger counts these work items; batching SQL, deduplication across distinct properties,
discarded evidence, or no public row does not make their native keys free. A request-local batch
can share one actual selected fact across clauses when properties/identities overlap. These nine
properties are distinct, so it cannot share any of the 288 selected facts. Reusing a loaded fact
inside one request avoids a duplicate read but still charges its one underlying key. Reusing facts
from an earlier request is not current evidence.

The three-valued Boolean plan cannot soundly complete this candidate from fewer than nine positive
leaf results. In this case every leaf is true, so an AND cannot settle early on a false child.
`compileCurrentFilter.evaluate` also requires a complete result array aligned with every
deduplicated leaf. A partial selected window with no current coverage is `not_proven`, including
under NOT; treating an unexamined candidate as false would change the contract.

The 18-byte record stores only a deterministic leaf ordinal, phase, value ordinal and one native
after position. It does not encode prior leaf truth or a list of witness identities. The
`SearchScopeEvaluation.evidence` field is request-local opaque evidence, not a continuation vector.
Consequently a new request must rediscover the earlier positives. If a candidate had been true in
an earlier call, the local source/selection identity alone is not enough: a foreign target or
Content fence can change while the local slot is unchanged. Final revalidation must read the
previously discovered opaque witness against current selection, source, target and Access state.
That is at least one raw key for the ideal single retained identity and can be more for current
fence/target evidence.

This is a liveness counterexample under a fixed finite ready state. An evaluator that spends the
256 keys replaying the first eight true leaves has no key left to advance the ninth. On the next
request it cannot skip those eight using prior truth; a fresh current proof again costs 256 before
the ninth. Returning unchanged empty progress forever is not finite progress. A different leaf
ordering does not change `8 × 32 + 1`. An 18-byte cursor starting at a later leaf can retain one
after position, not eight independent positives. This proves the candidate repair/replay scheme
does not meet the always-fits requirement; it does not prove no new source-owned data layout could.

The same lower bound applies before composing the result into either caller. UUID Scope/Zone union
still needs current owner union membership and subject Access. Ordered TypeList residuals still
need the native candidate tuple, current TypeList result and current Zone membership. Aliases,
lookahead and final disclosure checks add keys, so they cannot rescue the one-candidate bound.
The first integrated Zone TypeList report already calls the multi-leaf final-proof unit unresolved;
this concrete source/write shape supplies the missing counterexample. The independent order report
also correctly marks Search leaf/identity and Commerce sources unavailable rather than treating
their contracts as runtime proof ([current report](zone-type-list-order-current.md), [independent
report](zone-type-list-order-independent.md)).

## `requestFacetRebuild` does not close the gap

There are two separate facts:

* **Implementation status:** this branch has no `requestFacetRebuild` function, durable request
  table, relation-facet migration, production `relationFacetRebuilds` export, or
  `facet-witness-evidence.sql`. The design documents specify proposed code and the native tests
  intentionally require missing exports. No current finite quiescence/rebuild completion can be
  claimed.
* **Designed scope:** the relation-facet design concerns declared outgoing relation `(property,
  value)` pairs. It proposes a bounded possible-identity pair index, one current witness hint per
  rebuilt pair, current per-witness checks, and a source-home coalesced request. The durable runner
  pages relation witness identities and publishes a completed source generation. It is not a
  material-slot index for every code, time, quantity, qualifier or non-relation item predicate.

Even if that relation repair were implemented exactly as designed and fully caught up, a pair hint
would be evidence for that relation pair only. A hint miss on a nonempty historical pair is not
definitive absence; the Semantic contract says to return `not_proven` unless complete coverage
exists. A positive witness still needs current candidate selection and current foreign
source/target fence checks. The relation design itself states that a saved witness or completed
rebuild never authorizes disclosure and that hide/restore fences take effect on the next read.
Range and qualifier matching still belongs to Search's pure matcher, not SQL. The material
counterexample above has no relation metadata and cannot be served by this pair index at all.

The README's proposed `empty_pair` coverage is narrower than general slot coverage: it certifies
an exact empty pair in the complete possible-witness superset after write/bootstrap coverage; it
does not certify every missing selected material value. One local source generation also cannot
summarize foreign target/fence state. Thus quiescence plus completed relation maintenance is not a
bounded final-proof unit for the required admitted filter set.

## External primary-source check

OpenSearch's official pagination documentation distinguishes live `search_after` pages from a
fixed view: search-after results can shift under concurrent indexing/deletion, and stable
tie-breaking requires a unique final sort field. Its recommended fixed-view route combines
`search_after` with Point in Time. The Point in Time documentation says the PIT freezes the
engine dataset for consistent paging. The pinned OpenSearch source (`SearchService.java`) builds
the continuation from the supplied sort and the exact supplied `search_after` values; the
`SearchAfterBuilder` converts those values using the current sort field formats. These sources
support exact raw tuple continuation and clear snapshot semantics. They do **not** supply a
Semantic truth cache or prove current foreign authorization. Rezics explicitly does not retain a
browser PIT across requests, so the PIT consistency guarantee cannot be imported into this design.

PostgreSQL's official ordering documentation identifies B-tree as the index type that can return
sorted output; its pinned `nbtree/nbtsearch.c` implements a bounded first/next index scan. This is
the right class of source-side access primitive for a selected-slot seam: use real current keys and
measure examined rows/blocks. An ordered scan or a complete index is not a Boolean result and does
not discharge Search's current evidence matcher or foreign authority checks. That last sentence is
an inference from the cited access behavior and the repository's ownership contract.

Shared pattern: mature stores separate the continuation key from the snapshot boundary, and
indexes bound how data is found but do not turn a possibly stale fact into current authority.
OpenSearch obtains cross-page consistency with an explicit PIT; PostgreSQL exposes ordered index
access, not application-level truth. Rezics' no-PIT/current-revalidation policy therefore requires
fresh source evidence on each final request, and the 256 proof must count the resulting keys.

## Smallest honest remedies and ownership

The report does not change an owner contract. These are the smallest plausible options for the
manager to review; each requires an explicit native bound before implementation.

| Remedy | Owner files / contract that must change | Benefit | Cost and constraint |
| --- | --- | --- | --- |
| **Source-owned current selected-slot batch access (preferred for preserving 256).** Add an additive Semantic read for all distinct current selected slots requested by one admitted Search plan. It returns selected data/provenance and complete selection coverage only; Search applies `holdsCurrentType`, `holdsCurrentStatements` and `compileCurrentFilter`. For the raw-key budget to improve, the access path must have a real bounded key unit at slot granularity (for example, a materialized current selected-slot record), not merely batch 32 separate candidate lookups and call them one key. Charge complete fact payload rows/bytes, native points, foreign checks and final positive revalidation independently. | Semantic: `scope-leaf-evidence.ts` plus an additive source-owned reader in `search-source.ts` or adjacent file, reusing `slots.ts`; if a slot record is needed, update `candidates.ts`, `write-facts.ts`, the actual bulk/import write paths, migration and `db/semantic/schema.sql`. Search: `scope-source.ts`/`service-scope.ts` must batch the plan through the same service and current `LeafOptions`; preserve `current-filter-plan.ts` and `current-leaf.ts` as sole interpreter. Revise the relevant native leaf and Scope sections of `semantic/README.md` and `search/README.md`. | Could reduce one current selection lookup per distinct property instead of one lookup per selected candidate, while still exposing facts rather than truth or permission. Final target/source revalidation remains live. This is the only option here that plausibly keeps the current 256 ceiling and full filter admission. | It is a real source data-shape and synchronous maintenance decision, not the existing relation-pair hint table. Prove stale-selection handling on compact assert/retract, expansion, adoption, import, moderation, deletion and replay; include max facts/bytes and all foreign checks. If a slot row only wraps 32 candidate reads at request time, the 288-key example still fails. Do not change raw-key accounting by declaration alone. |
| **Explicitly increase the outer raw-key bound.** Keep the present source/selection algorithm and set a cross-owner maximum large enough for the exact maximum leaf replay, positive revalidation, Search prefix/lookahead, alias identities and Zone union work. | Search: `ScopeEvaluationReservation.rawKeys` and the `<=256` guards in `scope-source.ts`; Search README. Zone: `docs/zone-membership.md` and its shared-ledger owner contract. Semantic: `semantic/README.md` leaf limits and all callers' reservation math. Existing 18-byte cursor can remain only if progress still strictly advances. | Directly retains the existing selected-fact shape and avoids a cached Boolean or witness vector. | The nine-leaf floor is 288 replay keys, or 257 in the ideal one-witness reuse case. At the full 32-leaf/32-selected shape, fresh selected replay alone is 1,024 keys, before up to 32 positive revalidations and outer work. No exact replacement cap is justified until all alias/Zone/source branches have a derived maximum. This violates 256 and needs an explicit supermanager policy decision; a small increase to 288 is not sufficient. |
| **Narrow the admitted work combinations.** Retain 256 but reject filter/source combinations whose proven final cost cannot fit, using a declared weight/cost admission rule. | Filter owner: `packages/filter/src/filter.ts` (`FILTER_LIMITS`, saved-filter expansion/admission); Search and Semantic README contracts; Zone owner docs and every route that admits the filter. Update native validation tests without changing existing frozen cases. | Can make a fixed budget meaningful without storing prior truth. | It reduces currently admitted 32-leaf/64-value combinations and may change saved-filter/query behavior. This is a product-contract change, not a hidden implementation optimization; no reduction is recommended by this report. |

A continuation-side vector of prior truth/witnesses or a server-side allow cache would avoid some
replay but conflicts with the task's no-cache constraint and the adopted 18-byte one-pending-leaf
layout. Neither is recommended. An additive source seam must use the same current selection and
authorization runtime, provide only evidence, and return real independent usage receipts; it must
not introduce a private query/holder/permission engine or a second Boolean interpreter.

## Required independent native acceptance before adoption

Add the tests to the owning Search/Semantic/Zone acceptance suites when a manager adopts a repair;
do not weaken frozen tests. The fixtures must use actual command writes, releases, selection,
Semantic source/Access, source fences, foreign targets and the real coalesced worker.

1. **Worst admitted multi-leaf final proof:** seed 32 independent admitted leaves with up to 64
   values each, plus the concrete nine-property case above. For each code/item/range/qualifier
   shape the owner claims to support, arrange the last selected/current witness to be the only
   matching candidate. Capture every physical selected-candidate/slot key, duplicate, driver,
   lookahead and exact revalidation. A positive AND must complete under the one shared 256 raw-key
   ledger; otherwise return genuine advancing progress/readiness and state that the admitted shape
   is not live. Separately capture points, witnesses, rows, bytes and empty seeks. Repeat through
   multiple native leaf calls in one evaluation to catch resetting a leaf to a fresh 256.
2. **One-record, no-prior-truth test:** stop after an earlier request returns several positive
   leaves, then resume with only the real encrypted 18-byte pending leaf record. Prove the runtime
   neither relies on a serialized leaf vector nor an uncharged server cache. The resumed final
   debit must include rediscovery and current revalidation, not only the last leaf.
3. **Real alias degree:** use actual identity/merge data with 257 aliases, then 4,096, and only the
   final alias readable. Include an alias whose leaf itself crosses requests. The same 256 ledger
   includes alias windows, unused lookahead, pending-original rereads, selected data and final
   checks. The last readable original must be found; no repeated empty cursor may claim progress.
4. **Only-last-readable and current revocation:** create a positive on a foreign target, then revoke
   target visibility/source fence or subject Access while keeping the local selected slot
   unchanged. The final request must perform exact opaque-identity revalidation against current
   selection, both source/target authority and current fences. Old truth, a local generation or a
   rebuild hint cannot return the hit. Repeat for every positive leaf in an AND.
5. **Repair coverage and negatives:** run real coalesced repair to finite completion for every
   supported material/code/range/qualifier case and show which actual source index supplies its
   current hint and definitive negative. Record a closed-form maximum final debit, including
   current foreign checks, no greater than 256. A relation `(property,value)` hint alone cannot
   satisfy this case. A missing or stale hint remains unknown until a real coverage certificate
   or repair result makes it definitive.
6. **Caller composition:** exercise both UUID Scope/Zone union and ordered TypeList residuals
   with the same evaluator. Include actual 16-scope/16-mount union bounds, candidate and native
   alias windows, TypeList sort tuple/lookahead, and final DTO disclosure in the same ledger. A
   separate long-name cursor fit, public Search page or engine total is not evidence for this raw
   proof bound.

The current native fixture already has useful lower-level expectations for 257/4096 relation
witnesses, last surviving witness, current fence revalidation, typed range/qualifier matching and
real candidate adoption (`test/semantic/scope-leaf-evidence.test.ts`). Those cases do not measure a
worst admitted multi-leaf Scope request or the composed 256 ledger. The two Zone TypeList order
reports likewise require an independent final-proof acceptance. Keep these separate red gates
until the native evidence port exists.

## Primary sources and licences

Repository contracts own meaning. External sources below provide patterns only.

| Source | Finding used | Licence / pin |
| --- | --- | --- |
| [OpenSearch pagination documentation](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/) and [Point in Time documentation](https://docs.opensearch.org/latest/search-plugins/searching-data/point-in-time/) | `search_after` is live/stateless without PIT; a unique final tiebreaker is required for defined page boundaries; PIT plus search-after supplies a fixed engine view. Retrieved 2026-10-28. | Official documentation; docs source is [OpenSearch documentation website](https://github.com/opensearch-project/documentation-website), Apache-2.0, commit `9bf360dee6e0930aa0bd66ba91e992b9ee2828bf` (LICENSE/NOTICE). |
| [OpenSearch `SearchService.java`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/SearchService.java#L1734-L1742) and [`SearchAfterBuilder.java`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java#L190-L229) | Uses exact sort plus supplied `search_after` values; the cursor is a native tuple, not a current predicate result. Inspected at pinned source commit. | OpenSearch 3.9.0 source, Apache-2.0 (`LICENSE.txt`, `NOTICE.txt`), commit `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`; reused clone at `/home/edge/projects/rezics/rezics-next/.reference/search-rating-populations/opensearch/`. |
| [PostgreSQL 18: Indexes and `ORDER BY`](https://www.postgresql.org/docs/18/indexes-ordering.html) and PostgreSQL [`nbtsearch.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/nbtree/nbtsearch.c#L865-L885) | B-tree ordering and first/next index traversal are source-access tools, not application-level current truth. Retrieved/inspected 2026-10-28. | PostgreSQL License (`COPYRIGHT`), commit `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; reused clone at `/home/edge/projects/rezics/rezics-next/.reference/library-shelf-maintenance/postgres/`. |
| Local repository | Filter, selection, Scope and source ownership contracts cited above. | REZICS package declares AGPL-3.0-only; current source base `f9f1c2179be15c6342ca004f1b3c167542348966`. |

The reference clones were read only; nothing was installed, built or run from them.
