# Search second scope

Readers should be able to refine the full released catalogue, search a meaningful source, rank by a readable
Realm's rating, and find public Collections, reviews and Spaces in the same discovery journey. The scope authority
is [public scope](../scope.md), opened by `fba75760f6` and present in this worktree's clean base `66b9e2b45b`.
The [Search Goal](../goals/search.md) and its linked execution owners remain authoritative. This plan assigns
remaining product delivery; existing declarations and passing compilation do not establish native readiness.

Decision: reuse delivered facet/Global-rating implementations and their queued acceptance; assign seven API
product slices, keep existing grants, and leave interface integration with Web. Newly admitted kind domains and
native Realm ordering are adopted in [conditions](../search-conditions.md#second-scope-producer-boundaries).

## Outcomes and ready briefs

Each continuation has goal/manager `search`, implementation kind, default placement, a focused native outcome
command, real source/test/owner paths and a 350–500-line product estimate. Tests should remain smaller than the
implementation. A ready native owner population must produce useful first/next/final pages; an unavailable seam
is a truthful dependency, never completion of the user outcome. Workers update the named owner in their change.

| Reader outcome | Existing authority and retained implementation | Assignment |
| --- | --- | --- |
| Discover and refine all released facets, including later values and typed ranges | [Facet wire/roster](../search-facets.md#released-property-roster), [facet runtime plan](../search-facet-runtime-plan.md), [native operations](../../services/kernel/src/search/facet-discovery-operations.ts), [default composition](../../services/kernel/src/search/public-runtime.ts) | Reuse delivered count-free runtime, storage and default provider. Existing facet continuation/code/native acceptance owns proof; no second runtime writer. Web owns full-roster controls and range editors. |
| Search my Library or a readable Collection, intersecting ordinary text/conditions | [Conditions](../search-conditions.md#current-authority-and-preparation), [Library consumer contract](../library-owner-queries.md#scoped-subject-search-consumption-required-runtime-pending), [Scope owner](../../services/kernel/src/search/README.md#scope-and-composed-page-admission) | [01 Library/Collection scope](../../.temp/continuation/01-library-collection-scope.md), 450 product lines. Deliver verified request/native scope composition; retain the one-positive-owner-scope preparation exception. |
| Find subjects discussed in a readable Realm | [Resource meaning](../search-conditions.md#conditions-and-resource-meaning), [Content](../../services/kernel/src/content/README.md), [Community](../../services/kernel/src/community/README.md) | [02 Realm scope](../../.temp/continuation/02-realm-discussed-scope.md), 400 lines. Consume current discussion/review membership, with thread, opening, board, place and subject disclosure. |
| Search subjects selected by a Zone's actual configured lists | [Resource meaning](../search-conditions.md#conditions-and-resource-meaning), [configured lists](../../services/kernel/src/presentation/README.md#configured-catalogue-lists), [list admission](../filtered-lists.md#admission-and-useful-pages) | [03 Zone scope](../../.temp/continuation/03-zone-page-scope.md), 350 lines. Consume Semantic's current compiled PAGE-LIST predicates; refuse nonrepresentable unions before enumeration. |
| Rank subjects by Global rating or a selected readable Realm | [Search rating order](../../services/kernel/src/search/README.md#global-rating-order), [native figures](../../services/kernel/src/rating/README.md#public-figure), [rating privacy](../../services/kernel/src/rating/README.md#thresholds-and-privacy) | Reuse Global order and its existing native acceptance. [04 Realm rating](../../.temp/continuation/04-realm-rating-sort.md), 500 lines, adds separately bound native population ordering, preserving Global guards and score phases. |
| Find public Collections as resources | [Kind contract](../search-conditions.md#one-request-and-configured-kinds), [Collection privacy](../../services/kernel/src/library/README.md#privacy), [mixed foundation](../../services/kernel/src/search/README.md#mixed-kind-foundation) | [05 Collections](../../.temp/continuation/05-public-collection-discovery.md), 500 lines. Public metadata only; Collection membership remains a different capability. |
| Find public reviews and open their native threads | [Kind contract](../search-conditions.md#one-request-and-configured-kinds), [reviews](../../services/kernel/src/rating/README.md#reviews), [Content](../../services/kernel/src/content/README.md), [primary identity](../feeds.md) | [06 Reviews](../../.temp/continuation/06-public-review-discovery.md), 500 lines. Review-only thread production with current opening/parent/target checks; no private current votes. |
| Find public Spaces without duplicate Realm hits | [Kind contract](../search-conditions.md#one-request-and-configured-kinds), [Realm presentation](../../services/kernel/src/community/README.md#realm-presentation), [Home dimensions](../feeds.md#home-dimensions) | [07 Spaces](../../.temp/continuation/07-public-space-discovery.md), 450 lines. One Space identity, including Realm-less places; carried Realm metadata remains currently guarded. |

## Dependencies and ownership

All seven briefs consume existing compiler, canonical identity, useful-page, budget and confidential cursor
contracts. They do not require one another's new code, so their `after` arrays are empty. Shared-file overlap
requires sequencing writers, not a fictitious code dependency. In particular, serialize registry/document/hydration
edits for the three discovery adapters and service/scope edits for source adapters. Each independently extends the
existing [mixed foundation](../../services/kernel/src/search/README.md#mixed-kind-foundation); there is no separate
framework-only prerequisite. The controller can assign independent files first and sequence overlapping writers.

| Native prerequisite | Consumer and resulting user capability |
| --- | --- |
| Commerce's verified logical-owner authorization, complete private Source and admitted Members/Kind preparation | 01: source-restricted Library/Collection search. Existing Members declaration/cost work retains its files; this slice binds the foreground request. |
| Content's complete Realm-to-subject population and current association disclosure | 02: subjects discussed in a Realm. Home's Space publication population is a different relation and cannot substitute. |
| Semantic's Zone head/release-keyed compiled PAGE-LIST population | 03: Zone page scope. Mounts, samples and raw membership are not this predicate. |
| Content's population-specific standard-question figures, frozen prior and seekable native order or retained evaluation | 04: Realm rating order. A figure point read is insufficient enumeration/order evidence. |
| Commerce's complete public Collection metadata population and visibility reductions | 05: public Collection hits. Sitemap candidates and subject listing counts cannot certify the population. |
| Content's complete public review population and current review/opening/board/place/target reductions | 06: public review hits. Known-subject review pages do not establish global discovery. |
| Content's complete public Space population and current carried-Realm binding/reductions | 07: public Space hits. Popular/Trending Realm activity lists do not establish Space enumeration. |
| Existing Semantic complete public Source, physical generation and whole-query safety | Facets, Global rating and all public mixed adapters retain their native readiness obligations, including excluded/order-only rows. |

Missing upstream code is handled through its documented contract or a minimal typed seam. Each implementation must
name that seam and remaining native producer in its owner update. An empty successful page, a synthetic observation
or a returned-row check cannot stand in for missing population, ranking or whole-query privacy. No slice creates a
new private index in the public family, increases work limits or promises completion from source inspection.

Web consumes the same native Search/discovery responses for facets, scope/population controls, generic result cards
and Home. Content owns feed composition and owner producers; Commerce owns public Collection truth; Semantic owns
catalogue/Zone meaning. These briefs add no feed lane, client federation, personalised recommendation, saved-query
editor or ordinary discussion discovery. Their interface stories belong to Web's second-scope plan, not duplicate
Search assignments.

## Base and queue reconciliation

The base already contains the second-scope scope change, the mixed Account/catalogue foundation, count-free facet
runtime/storage/default wiring, Scope runtime declarations and Global rating phases. The plan file was absent.
The search README and capability manifest still contain older Realm/deferred wording; current scope takes
precedence. The Realm-rating brief updates the runtime owner when delivering that capability, without claiming
that opening scope supplied implementation or native evidence.

`git log dev` and the current Goal status were inspected. Queued/running Search work covers analyzer setup,
transport/response admission, relay/default-worker/public-rating consumption, disclosure/privacy/cursors, growth,
coverage/rebuild/publication, facets, recent/trending search, generic catalogue discovery and presentation checks.
The direct Members source declaration/cost files also have active writers. Those are retained work, not new
second-scope assignments. Existing facet continuation and native rating outcome tests stay with their current
writers; the seven slices use new focused test files and preserve frozen suites. The other running second-scope
plans belong to Web, Content and Commerce and do not transfer their modules to Search.

The continuations' acceptance scenarios require useful ready pages as well as denial, sparse populations and
withdrawal during lag. Kind counts remain unavailable without their independent certified evidence; property
facets remain count-free. Existing tests that assert a Global-only request surface must be updated only where the
explicit Realm selector changes that behavior, keeping all unchanged Global validation assertions.

## Sources inspected

- [Scope](../scope.md), [Search Goal](../goals/search.md) and its [capability inventory](../goals/search.capabilities.md).
- [Search execution owner](../../services/kernel/src/search/README.md): mixed foundation, Scope, Global rating and default runtime; [presentation](../../services/kernel/src/presentation/README.md#configured-catalogue-lists) and [composition](../../packages/composition/README.md#read-planning).
- [Conditions](../search-conditions.md), [facets](../search-facets.md), [facet runtime plan](../search-facet-runtime-plan.md), [mixed-kind plan](../search-mixed-kind-plan.md), [filtered lists](../filtered-lists.md#admission-and-useful-pages), [Collections](../library-and-collections.md#indexed-filtering-and-disclosure) and [feeds](../feeds.md#home-dimensions).
- Native [rating](../../services/kernel/src/rating/README.md), [Library](../../services/kernel/src/library/README.md#scoped-subject-search-status), [Content](../../services/kernel/src/content/README.md) and [Community](../../services/kernel/src/community/README.md) owner sections; existing facet operations, default discovery composition and public-rating validation.
- Existing [Realm discovery](content-realm-discovery-design.md) and [rating/review design](content-ratings-reviews-design.md) research sections, as context rather than new authority.

No external reference implementation is named by this contract. This decomposition reuses adopted owner semantics;
it does not import a topic from the discussion repository or make new comparative product claims.
