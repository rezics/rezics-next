# Public facet discovery

This document owns the approved count-free property/value facet continuation wire and the narrow
[kind-count exception](#kind-count-exception). [Search](../services/kernel/src/search/README.md)
owns execution; [Filtered lists](filtered-lists.md) owns admission, useful pages, privacy and numerical budgets.
The additive [type-only contract](../services/kernel/src/search/facet-discovery-contract.ts) describes the adopted
transport, not the current service response or an executable shared ABI.

## Transport and values

Keep `POST /v1/subjects:facets`, with existing optional `text`, `filter` and `languages`. The request contains
`facets`, an array of one to eight closed objects `{ property: string, size?: number, cursor?: string }`.
Properties must be distinct. Size is an integer from 1 through 20, default 10. Each property's cursor is optional;
sibling facets may start or resume independently. Existing text/filter admission and language semantics remain.

## Second-scope request and readiness

The additive scoped request uses `scope: { kind: 'realm' | 'collection', id: string }` and optional `conditions`,
carrying the same semantic condition tree as the corresponding Search request. The unscoped request shape remains
unchanged. Scoped condition validation and authorization belong to the shared Search scope admission; it must
authorize every resource reference in the complete tree, including references under `NOT` and otherwise unrelated
`OR` branches.

The adjacent `readScopedFacetDiscovery` adapter consumes the existing `ScopedFacetAdmission` from
`scoped-facet-source.ts`, returned by shared Search admission. The identity hashes its source, admitted meaning,
population and authorization observations; the Search consumer context carries the existing deadline. The adapter
binds the submitted scope and complete condition tree into the static cursor request, then treats changed dynamic
admission or released metadata as `search_restart_required`. A different principal, static query, scope reference,
language or size cannot authenticate the cursor. Shared admission runs before cursor validation or provider I/O.

Readiness remains partial: native facet plans already carry an admitted scope, and native storage consumes it only
through the optional `ScopedFacetSource` ports. Missing or unready scoped ports leave the request preparing and the
existing runtime returns `503 index_not_ready`; it never falls through to Global values. The public service handler
does not yet call this adjacent adapter, so the public endpoint remains unscoped. Once wired, configured native
scope ports can execute the admitted capture. The unscoped route keeps its existing wire, eight-distinct-property
limit, sizes 1 through 20, count-free values and native value ordering.

Decision: scoped facets use the additive Realm/Collection reference and the same Search condition tree through shared `ScopedFacetAdmission`; until the public route adopts the adapter, it remains unscoped and native unready work fails closed.

The successful `200` envelope is:

```ts
{
  facets: [{ property: string, values: [{ value: string, labels: Record<string, string> }], next: string | null }],
  as_of: string
}
```

Return one facet for each requested property, in request order. `next` is required on every facet; `as_of` retains
the existing date-time freshness meaning and does not certify privacy or completeness. No `count`, `total`,
`relation` or `estimate` field, count-based ordering, zero substitute or row-length substitute is permitted.

Values enumerate the current eligible distinct values for the same effective text/filter predicate. Order by
ascending native value key, deterministically across pages: canonical item identity under the published identity
epoch, actual code keys and actual type IDs. Never order by labels or contribution counts. No duplicate canonical
item/code/type values within or across a continuation. Labels are currently disclosed labels selected by the
existing reader language chain; omitting `languages` keeps all languages. Each value is selectable through the
existing released statement/type filter grammar. Hidden targets or ineligible contributors cannot establish
membership; a curator's or editor's private authority cannot widen this public result.

A successful page fills its requested size or proves final exhaustion for its identified observation.
`next: null` means proved exhaustion. A genuinely exhausted initial query may return an empty final page;
continuation must not produce an empty successful page. Sampled buckets, dropped private candidates and sorting
a truncated preview cannot establish terminal exhaustion. If useful output or exhaustion cannot be established,
use the actual shared preparing/readiness transport and retained finite-progress plan required by Filtered lists.
There is no facet-specific preparing DTO here. Missing producer/schema ports remain prerequisites, never a
successful preview fallback or a stub successful callback.

## Confidential continuation and privacy

Use the existing opaque confidential [Search cursor profile](../services/kernel/src/search/README.md#confidential-cursor-and-bounded-name-sort)
and bounded native keyset machinery. This adoption adds no crypto allowance or codec. Bind operation, principal,
effective text/filter, property, language chain, effective page size, release/meaning context, published identity
epoch and actual physical generation/observation. A property's token cannot resume a sibling or another
query/principal. Do not expose raw private or consumed keys, offsets, returned-ID vectors, native observation
locators or reusable permission. Separate authenticated static request binding from dynamic current privacy checks.

Follow ordinary Search policy: malformed, tampered or request/principal-mismatched tokens produce `400
invalid_request` with `invalid_format` at that facet's cursor pointer. Expired tokens and authenticated tokens
whose generation, identity or queried observation has changed require `409 search_restart_required`. Authenticate
the original request before comparing dynamic context; do not change its hash to the current epoch. Unsafe
unchanged observations require preparation/readiness rather than stale disclosure.

Query privacy protects positive and negative membership, value contribution, order, labels and cursor information,
as well as current original/terminal own-row checks. Check source/Collection authority, Access, consent, targets
and tuple fences. Local reductions and FOREIGN source/target/consent/Collection reductions require actual dependent
repair. Observe safety before execution and revalidate before disclosure, detecting changes during the query even
if they have already been ACKed at final validation. A live ACK never authorizes an older query.

Bind safety to the exact physical incarnation and queried immutable PIT or prepared observation, with its retained
meaning and identity context. A physical name, ordinary checkpoint, index refresh, returned-ID check or completed
epoch alone is insufficient. No universal 256-key allowance, home certificate, head-vector sweep or mandatory
final raw-fact replay is revived. Source's 256-probe/ID limit remains **per call**, not a page safety budget.
The [Source specification](../services/kernel/src/semantic/public-filter-source-contract.md) and
[Search consumer specification](../services/kernel/src/search/public-filter-consumer-contract.md) remain separate
owner ports. Their exact native factory, Source and immutable-observation dependencies must exist before runtime
implementation; this wire invents none of those APIs.

## Released property roster

Use the actual exported `facetProperties(release, types)` from `@rezics/filter`, including structural bases, for
the full declared property roster. Its own/base traversal and deduplication are specified by the
[filter package](../packages/filter/README.md#admission-and-saved-filters). Do not substitute the preview allowlist.
This is released schema discovery, not a population aggregate. Preserve actual datatype/operator distinctions:
range, quantity and time fields retain their released operators and units. Do not invent numeric statistics,
extrema or new properties, or claim that every datatype uses item buckets. The existing admitted item/code/type
discovery enumerates values; released range fields remain available independently.

Group supported properties within the existing eight-property request limit. Report the actual Book roster even
when it is smaller; do not fabricate more fields or increase limits to fit a demonstration.

## Kind-count exception

Only universal search kind chips may carry counts under [Universal search conditions](search-conditions.md#kind-facets-and-generic-hits).
Property/value facets above and public search totals remain count-free. This exception does not add counts to
`subjects:facets`, permit count ordering or certify current sampled type buckets.

Disjunctive counts remove ONLY the designated kind leaf directly under top-level AND. Keep nested OR/NOT kind
leaves and every other predicate; without that designated leaf count the unchanged query. Authorize and charge
the potentially broader count population separately, with whole-query current privacy including excluded rows.

`{value, exact:true}` requires certified complete canonical membership; `exact:false` requires a certified
positive lower bound displayed `N+`. Unknown/unavailable is omitted or explicitly unavailable, never zero; do
not show a zero lower-bound badge. Exact zero requires proved authorized absence. Fixed maintained evidence
must represent the exact query population and update atomically with membership/privacy reductions. Capped
fully checked enumeration is exact only on complete exhaustion. Unchecked buckets, estimates, occurrences,
page lengths and full-match direct aggregates are not evidence.

Kind metadata is a fixed bounded page in configured order, with data ID/localized label/icon and one More kinds
control for continuation. Counts are attempted once on the initial query and retained across hit continuations;
changed conditions start a new query. Later metadata pages may mark counts unavailable. The research values
Smax=2/C=2/K_page=8 remain proposals pending first native measurement, not frozen output or engine bounds.
Metadata continuation does not exclude unshown kinds from hits or authorize another hit/count enumeration.

## Implementation status and native acceptance prerequisites

The public service consumes count-free continuation through `facetProvider` from the default public runtime.
Prepared facet captures keep the admitted text/filter and add the requested property to `overflowProperties`
(name order for item labels). Sampled `countFacets` is not the public path. Missing native generation or
meaning still returns `503 index_not_ready`.

Native catalogue acceptance must consume this adopted wire and the actual committed suspended-persona driver and
released discovery fixture before retrying or freezing its assertions. Native results and hashes are separate
evidence; formatting and typechecking cannot establish native, renderer, web or client capability.
Existing frozen persona/assertion files remain unchanged by this adoption.

Before native closure, use Semantic-approved extra public Concepts, an adopted scheme and Books through the one
shared [released fixture](../services/kernel/test/support/released-discovery.ts)'s existing `createSubject`, `adopt`
and `request` operations and released `schema:keywords`. Include at least 12 extra controls, real IDs, public labels
and citations. No shared builder writer, test-only release/property, second fixture registry or imported-harem or
real-world completeness claim is authorized. The existing small catalogue does not claim production provenance.

Required future native cases cover:

- Actual continuation over at least 21 eligible values, exceeding both default 10 and maximum 20; default-size,
  size-2 and maximum-size filled/final pages with no duplicates, counts or sampled terminal assertions.
- Every selectable value refined through actual typed filters; the full declared roster including bases, with
  independent released quantity/time range and unit cases.
- Hidden contributors and targets, positive/negative predicates, value contribution/order/label privacy, local
  and FOREIGN barriers, current own-row checks and changes during execution even when ACKed before final.
- Sibling/query/principal cursor binding, malformed/expired tokens, generation/identity changes and exact physical
  incarnation and immutable-observation safety, including an old PIT after live repair.
- Actual bounded direct/prepared admission, finite useful progress, interruption/replay and measured native growth.

These are implementation closure requirements, not native cases supplied or passed by this formatting acceptance.

## Cost

### Discover or continue requested facet values

- Touches: effective query admission and released roster; actual native keyset/value enumeration; candidate
  contributors and targets; original/terminal own rows, Access, consent and foreign dependencies; current labels;
  physical/identity/meaning context; safety start/final observations; retained preparation, repair and cursor work.
  Charge all sibling facets, metadata, permission work, rejected/duplicate/lookahead candidates, retries and rereads.
- Bound: admit filter + source + value order together under the current [Filtered lists budgets](filtered-lists.md#budgets).
  Derive actual per-plan and whole-request units before execution, without treating each sibling as a free read or
  granting an independent allowance. Direct plans require page-derived bounds including engine work; match-linear
  sorting/counting is not direct. Otherwise use bounded retained preparation with finite input progress, quota and
  expiry, or reject with `422` before enumeration. Existing ceilings include direct `min(600, 6s + 3)` candidates,
  ready-result `2s + 2` candidates and two index reads, and composed pages of at most 16 distinct reads and 128
  total slots. All current point, examined-row, block, statement/connection, byte and preparation-step budgets
  apply; this wire adds no numerical allowance. No feasibility claim is made before measurement.
- Growth check: actual API/native captures at 64/512/4096 with fixed query, requested properties and page size;
  grow unrelated population/history, contributing values, aliases and dependencies independently. Capture engine
  iterator work and every backend's actual counters, including denied/empty/deep pages, sparse matches and repair.
  Prove useful filled/final pages and finite retained preparation under the current three-scale limits. Sampled
  terms, bounded output length and formatter/type passes cannot establish these bounds.

### Initial universal kind counts and metadata

- Touches: configured metadata, designated-leaf transformation, broader source authorization/population,
  maintained evidence or checked witnesses, whole-query safety, original/terminal support and retained cursor work.
- Bound: share [Universal search Cost](search-conditions.md#mixed-kind-ranked-page-and-kind-counts) and
  [Filtered lists budgets](filtered-lists.md#budgets); no per-kind/source allowance. Counts include raw rejects,
  duplicates, lookahead, shard/iterator work, SQL, Access and bytes. Proposed C=2 permits one physical enumeration
  only in a spare third round, at most `min(C,2*remaining+1)` raw candidates total across kinds; a full page
  permits one. Never reset remaining slots. Hit refill or a broader source set that cannot fit means unavailable
  counts. Maintained fixed evidence also shares the fixed/statement/byte budget. These are proposal constraints,
  not measured native bounds. No repeated count enumeration on hit continuation. At ten million matches use
  exact fixed maintained evidence, capped fully checked witnesses or unavailable; sparse `terminate_after` is
  no examined-work proof.
- Growth check: Search's native merged-page capture at 64/512/4096 grows matches, corpus, kinds and reductions
  independently at fixed page size. Cover dominant/rare kinds, broader disjunction, nested OR/NOT, exact zero,
  certified positive lower bounds, unavailable evidence, partial shards and excluded-row reductions arriving and
  ACKed during execution. Capture actual iterator/SQL/Access/byte cost and served share, without native claims
  from formatting. Metadata continuation must not add per-kind queries or repeat hit-continuation counts.
