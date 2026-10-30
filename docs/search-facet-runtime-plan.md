# Complete count-free facet runtime plan

This is the implementation proposal for the adopted [facet wire](search-facets.md).
It supplies the complete remaining in-row design and two whole implementation briefs.
It supplies no runtime, native outcome, permission, measurement or catalogue provenance proof.
The wire and `facet-discovery-contract.ts` remain authoritative and unchanged.
[Filtered lists](filtered-lists.md) owns meaning, privacy, useful pages and all numerical ceilings.
The [Search consumer](../services/kernel/src/search/public-filter-consumer-contract.md) and
[Semantic Source](../services/kernel/src/semantic/public-filter-source-contract.md) own native custody.

All new cross-owner choices below are **proposals pending owner adoption**.
Search owns the proposed runtime, retained result and call-site changes.
Semantic owns complete value population, selection, identity and Source extensions.
Performance owns verification of existing budgets, without a proposed increase.
Accounts, Content and rights owners retain their current authorities.
A missing producer is an implementation prerequisite, not a reason to redesign this wire.
Implementation must consume the owners' landed declarations; this plan does not recertify them.

## Outcome and implementation boundary

A reader can enumerate every eligible item, code or type value for one effective query.
They can select any returned value using the existing typed filter grammar.
Each successful page fills its requested size or proves exhaustion of its identified observation.
A property can start while a sibling continues, without transferring its cursor or allowance.
The complete released roster remains available, including independent range controls.
No public property facet response contains counts or a substitute for counts.
Universal kind chips remain governed exclusively by the exception in `search-facets.md`.
This plan neither adds kind-count work nor changes that exception.

| Surface | Specified now | Current implementation boundary | Required closure |
| --- | --- | --- | --- |
| Facet HTTP wire | Adopted count-free continuation | Route has no cursor or required `next` | Runtime brief |
| Population | Complete eligible distinct values | Sampled relation projection and terms | Complete retained preparation |
| Identity/order | Canonical item/native code/type order | Count-ordered preview | Canonical unique retained keys |
| Privacy | Whole query and current disclosure | Candidate/label checks are insufficient | Actual Source/consumer custody |
| Roster | `facetProperties(release, types)` | Web truncates at eight | Group full roster; separate ranges |
| Native catalogue | Released shared fixture | Existing acceptance writers own older cases | Native closure brief below |
| Renderer | Adopted wire consumption | Preview-oriented values and no continuation | Web consumer closure, no new DTO |

### Why the current value population is incomplete

`query.ts:countFacets` executes a shard sampler and count-ordered terms aggregations.
It asks for twice the requested output size, not a complete ordered value population.
Its unsampled overflow probe detects possible incompleteness; it cannot enumerate missing values.
`facets.ts:discloseFacetValues` checks target rows and labels, not every contributing subject.
`service.ts:facets` strips counts, checks some labels and slices the preview.
It neither issues continuation tokens nor proves exhaustion.
`live-facets.ts:readLiveFacets` also counts values from a bounded hit population.
Its `complete` input cannot make a sampled subject's statement projection complete.

The current `SubjectSource.read` accepts at most 256 IDs per call.
`IndexedSubject.statements` samples at most 128 outgoing relation values per declared property.
`relationFacetOverflow` says that sample was truncated.
`matchRelationFacets` accepts at most 256 **already named** membership probes per call.
A true/false probe can verify a known value; it cannot discover an unnamed 129th value.
`not_proven` is uncertainty and cannot establish absence, including below NOT.
Increasing terms size, sorting sample keys, retrying probes or removing counts leaves this gap.
Enumerating all returned subjects' sampled arrays still leaves it.
A finite hit stream without a complete per-subject value stream still leaves it.

Select **retained preparation** for the general facet operation.
Do not enable a live terms/composite aggregation as a direct production plan in this slice.
An aggregation's bounded response does not bound matching documents, nested rows or shard iterators.
A future direct plan requires its own page-derived proof under the unchanged budget.
There is no direct-preview fallback while that proof or complete population is missing.

## Exact keys, identity and labels

A retained read definition contains the expanded admitted filter, parsed text, release pin,
source/population definition, facet property, datatype and identity context.
A build is immutable after publication and has one value row per distinct native key.
The order is ascending key order within that property's identified build.

| Kind | Stored unique/order key | Public `value` | Equality/refinement |
| --- | --- | --- | --- |
| Item | Canonical terminal UUID's 16 unsigned bytes | Lowercase canonical UUID | Existing statement `in` |
| Code | Exact UTF-8 bytes, binary lexicographic, shorter prefix first | Unchanged released code string | Existing statement `in` |
| Type | Exact UTF-8 bytes of actual released type ID | Unchanged released type ID | Existing type `in` |

UUID byte order equals lexical order for validated lowercase fixed-width UUID text.
Use PostgreSQL `uuid` ordering for item keys and `bytea` for string key ordering.
Never rely on database locale, `localeCompare`, labels, frequency or contribution count.
Do not lowercase, normalize Unicode, trim or decode a code into a target subject.
Only released registered patterned strings are catalogue code facets.
Admission still applies the code pattern and current scalar limits from `@rezics/filter`.
Type enumeration contains types actually contributing eligible subjects to this query.
It is distinct from the complete released property roster and universal kind metadata.

Canonicalize contributors and item targets under the published identity epoch.
Retain original and terminal identities for native routing and disclosure custody.
Two eligible originals mapping to one terminal establish only one value row.
A redirected original alone is not an eligible contributor.
Canonicalization uses maintained owner indexes, never a request-time group-member sweep.
Identity pending or incompatible meaning makes a build unpublishable.
A published identity change invalidates the old continuation with restart semantics.
Do not silently translate the old key to a new epoch and continue behind it.

The retained value row stores the key, kind, canonical value and a bounded witness locator.
It stores no cached permission and no publicly reusable native observation locator.
All support/dependency routing is retained internally, including currently ineligible inputs.
A witness is a locator to real selected evidence, not an asserted `allowed: true`.
Multiple support records can establish one key; they never create repeated output.
Removing one support record does not remove another eligible support record.
Repair recomputes only affected value membership through indexed support routing.

Item labels come from current eligible original/terminal target reads.
Use `validateHitOptions`, `chooseTexts` and the existing reader language chain.
Omitted languages retain every currently disclosed language.
Codes carry `{}` labels, as the current code path does.
Types use the exact pinned release's public type labels and the same language selection.
Missing labels do not justify sorting by an alternative label or inventing a display value.
An eligible item with an empty disclosed label map can carry `{}`.
An ineligible target cannot establish a value even if its label was once public.
A current label change does not reorder native keys but still belongs to final disclosure work.

### Cost

- Touches: release construction, native canonical mapping, retained value key, selected support, current target labels and original/terminal checks.
- Bound: key construction and labels are charged to the admitting page or preparation step; 256 IDs/probes remains a per-Source-call constraint, never an extra page quota. Alias groups are not traversed per value; existing scalar, byte and point ceilings apply.
- Growth check: native key comparisons and current labels at 64/512/4096 aliases, duplicate supports and unrelated labels; stable key order and unique canonical output must hold with fixed page size and no group-sized page work.

## Binding and immutable observation custody

Use `encodeSearchCursor` and `decodeSearchCursor` with the existing confidential Search profile.
Their current signatures accept binding `{operation, request, principal}` and generation/after tuples.
They already authenticate the stable request binding and encrypt the native position.
They do not themselves register a PIT, prepare a result or validate privacy.
No new codec, public key field or crypto allowance is proposed.

For one property the binding request is exactly the normalized effective input:

```ts
{
  text: parsedTextOrNull,
  filter: expandedAdmittedFilterOrNull,
  property: requestedProperty,
  languages: validatedLanguageChainOrNull,
  size: effectiveSize,
  source: retainedPublicCatalogueReadDefinition
}
```

Use stable operation `POST /v1/subjects:facets` and the actual authenticated principal.
Preserve AST array order in canonical JSON; do not invent logical equivalence rewriting.
Omitted size and explicit 10 normalize identically.
Omitted languages and a supplied language chain remain distinct.
Tokens and sibling descriptors are excluded from a property's request binding.
Moving an unchanged property to another request index is valid.
Adding or removing a sibling is valid after whole-request admission.
Changing the property's size, text, filter, language chain or principal is invalid.
Copying its token into a sibling property is invalid at the recipient pointer.

The encrypted after tuple is proposed as five strings:

```text
["facet-v1", retainedObservationId, retainedBuildId, buildGenerationDecimal, lastConsumedNativeKey]
```

Use the existing cursor epoch for the actual Search generation number.
Encode item keys as canonical UUID text and string keys as their exact strings.
The retained observation resolves release/meaning, identity epoch, physical target/index UUID,
consumer/projection generations, source definition, covered cut and immutable build generation.
These values belong to the encrypted position or retained state, not a freshly rewritten hash.
This tuple fits the existing eight-key limit; validate every string and total encoded capacity.
Current Search limits are 2560 bytes per after key, 3072 total after bytes,
3584 plaintext bytes and 4864 token characters; lifetime is 15 minutes.
Do not enlarge them or put a returned-ID vector, head vector or private fact body inside.
The existing filter/code scalar limits leave the actual value key within these limits.
Locators must be bounded identifiers, not serialized plans.

Authenticate static original binding first, then resolve retained dynamic context.
Malformed, tampered and static request/principal mismatches return `400 invalid_request`.
The error is `invalid_format` at `/facets/i/cursor`.
An authenticated expired token returns `409 search_restart_required`.
So does an authenticated token whose generation, identity, meaning or observation is lost/changed.
Unchanged but unsafe retained observations return existing readiness, never stale success.
Do not regenerate the old binding with today's identity/release before authentication.
Do not return a private consumed key or observation locator in a problem body.

The exact existing type-only `PublicFilterQueriedObservation` is the custody type.
It identifies a registered native consumer and either a PIT or immutable prepared build.
The consumer identity includes actual engine index UUID/incarnation, not just its name.
The covered cut belongs to this retained copy, never the newer live target's ACK.
Renewing a PIT may change its native PIT ID only after validating the same observation.
A prepared replacement gets a new observation and generation.
The native no-resurrection and retained-copy obligations stay with the existing owner contracts.
This plan does not choose a soft tombstone, SQL owner bypass or replacement cut algorithm.

### Cost

- Touches: confidential codec, retained observation/build lookup, static request binding, dynamic generation/meaning/identity reads and token failure paths.
- Bound: one bounded tuple per requested property inside current Search profile capacity and 15-minute lifetime; metadata and invalid/expired work share whole-page statements, points and bytes. No retained-vector or 4096-head lookup allowance exists.
- Growth check: actual default/size-2/max tokens, changed siblings/principals, deep pages and expired/lost observations at 64/512/4096; capture rejected requests' real work and token size without token-content disclosure.

## Whole-request admission

Validate the entire body before a build, engine enumeration or Source permission read.
Accept one through eight distinct closed facet descriptors with integer sizes 1 through 20.
Default each omitted size to 10; validate text/filter/languages using existing semantics.
Reject unknown fields and private owner leaves, including under NOT/OR/saved expansion.
Use the current released `facetProperties` and filter admission, rather than a copied allowlist.
The synthetic `type` facet is separate from released statement properties.
A range field in the roster is not an item/code enumeration request.
Return `422 unsupported_query` for requesting range buckets through this wire.
The renderer keeps its existing typed range control available independently.

Let `R` be requested distinct property reads and `S` their summed output sizes.
This proposal charges each property as a distinct read of one common page.
All siblings share the existing `R <= 16`, `S <= 128` common-page envelope.
Here `R <= 8` follows from transport; it does not reset any budget.
Eight descriptors of size 20 have valid syntax but cannot be admitted as a 160-slot page.
Return `422 unsupported_query` before enumeration; clients can group into smaller requests.
Preparation cannot make 160 output slots fit one response.
A request with eight size-16 siblings fits 128 slots if all other bounds fit.
Metadata, authentication, safety start/final and disclosure batches are shared once.
Do not call a separately budgeted service method eight times and concatenate results.

Only ready prepared results are selected for initial production admission here.
The direct figures below are ceilings for any later admitted direct optimization, not its proof.
Use actual candidates `c`, including rejects, duplicate supports, lookahead and rereads.
Charge every underlying backend call, including failure and retry work.

| Per-property size | Direct candidate ceiling | Ready candidate ceiling | Ready points | Ready rows |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 15 | 6 | 64 | 160 |
| 10 | 63 | 22 | 192 | 416 |
| 20 | 123 | 42 | 352 | 736 |

Direct candidates are `min(600, 6s + 3)` with three refill rounds.
Each round asks at most `2 * remaining + 1`, not a fresh full-page quota.
Direct engine searches are at most six per read, two per round.
Ready candidates are `2s + 2`, with at most two index reads per property.
Both paths use points `16 + 8c`, rows `64 + 16c`, and six blocks per budgeted row.
Response bytes are `16 KiB + 4 KiB*c`; requests `64 KiB + 1 KiB*c`.
A one-read page has at most 12 statements per PostgreSQL backend.
A composed page has at most `8 + 4R` statements per backend and one connection per backend.
Connections must be released before another owner or engine I/O.

At eight size-16 properties the direct candidate sum is at most 792.
It yields at most 6464 points, 13184 rows and 48 engine searches.
The ready sum is at most 272 candidates, 2304 points, 4864 rows and 16 index reads.
Both have at most 40 statements per backend, with shared control work included.
The outer common-page ceilings remain 816 candidates, 6784 points and 14080 rows.
Do not add per-property fixed allowances beyond the summed formulas.
A renderer issuing roster groups still accounts for its common page's total reads and slots.

The privacy subset is shared across all siblings, inclusive of query plus final status.
It has at most two statements and `64 + 2*(behind homes + changed homes)` examined rows.
Logical coverage includes all 4096 homes through indexed behind/changed access.
Use the exact owner SQL role comments for start/final and separate keyed own-row work.
Separate own-row work stays in whole-page totals; it cannot replace population coverage.
No home-vector sweep, home certificate or universal 256-key page grant is admitted.

### Cost

- Touches: all descriptors, expanded filter/text, release roster, common-page slot/candidate reservations, actual control and native safety work.
- Bound: `1 <= R <= 8`, `S <= 128`, per-read and shared literal ceilings above; reject an over-budget shape with 422 before enumeration. Ready admission reserves at most `sum(2s+2)` candidates, two index reads per property and `8+4R` statements per backend including shared work.
- Growth check: one/two/eight siblings, eight size-16 and rejected eight size-20 requests at 64/512/4096; record actual whole-request totals and all raw backend counters, including unavailable/denied requests, rather than eight independently passing reads.

## Complete retained preparation algorithm

### Read definition and finite input

Keep one public read definition per effective query, facet property and pinned meaning/identity context.
Equivalent requests can share derived public computation, never principal authority or disclosure verdicts.
Page size and language selection bind cursors but need not duplicate the underlying value population.
Different sibling properties may use different immutable builds of the same effective query.
Each must separately identify and validate its observation; all share the request's cost ledger.

The source population is the complete immutable catalogue observation admitted by Search.
It includes eligible contributors, excluded contributors relevant to privacy and complete target dependencies.
It is not the preview index's sampled `facts` arrays.
Cold population requires a complete native subject-key stream and a creation/change bridge.
A subject's finite projection then uses `readPublicFilterProjectionPage` until **complete**.
That declaration already retains a frontier, typed statements, dependencies and ineligible repair locators.
A progress page does not certify subject exhaustion.
A subject count cannot establish that all native keys were enumerated.
A privacy log alone cannot establish ordinary creation or non-reducing additions.

The exact missing population operation is described in the proposed adapter section below.
It must capture finite membership/upper fences and preserve source epoch/ownership.
Use durable frontier traversal of all native homes during preparation, not per served page.
An empty home advances the retained frontier only after an authoritative empty-page result.
A moved/unavailable home suspends the build; it never becomes empty by default.
Late insertion behind a key frontier must enter the creation/change bridge before publication.
Drain a captured finite ordinary-change window and dependency window before the final CAS.
Continuous later changes feed a replacement generation; they do not extend this build forever.
An observation loss or a retained-log gap aborts this build and starts a fresh identified build.

### Bounded phases

The durable job stores phase, input boundary, subject/projection frontier and generation CAS.
All rows are derived in existing Search PostgreSQL storage and existing durable work.
No new service, scheduler, permission store or raw-fact authority is introduced.
The logical row/index names below are proposed names, not existing database objects.

1. **Capture:** retain complete population/meaning/identity/consumer context and its finite fences.
2. **Enumerate:** seek next anchored subject keys; retain the last examined key, including rejects.
3. **Project:** exhaust the complete selected-public projection for the current subject in bounded pages.
4. **Evaluate:** use the shared admitted predicate over complete typed evidence; unknown remains unknown.
5. **Contribute:** for a proven eligible matching contributor, stage every requested property's value evidence.
6. **Canonicalize:** resolve maintained canonical keys and current original/terminal eligibility.
7. **Index:** idempotently insert unique value keys plus complete internal support/dependency routing.
8. **Catch up:** apply captured ordinary changes and relevant local/FOREIGN repair to the build.
9. **Seal:** certify finite input exhaustion and immutable observation custody, then CAS publication.

Each transition persists one frontier with its effects; rollback persists neither.
A subject with many statements spans projection and contribution phases.
Do not keep a full high-fanout subject in memory and call it one input candidate.
Retain bounded typed evidence in private staging and reuse it across that subject's predicate/value work.
No second parser or ad hoc JavaScript interpretation replaces the shared filter/text semantics.
Use the existing Search compiler/native predicate execution for text and complete typed filter semantics.
If membership execution itself needs bounded phases, retain them in the same job and cost ledger.
Never run a match-linear search synchronously in a served page.
Native preparation must show finite total engine work over its captured finite input.

Staging value order is maintained by the unique index as contributions arrive.
Do not collect every value into a vector and sort it at request time.
Do not use request-time `DISTINCT` over an unbounded support relation.
Use indexes on `(definition, generation, native_value_key)` for ready value seeks.
Support uniqueness includes source subject, selected slot/candidate, property and canonical value.
Dependency reverse indexes route reductions and ordinary changes to affected definitions and values.
Support rows include ineligible repair locators internally so restoration remains discoverable.
They are not public facts and cannot be used to disclose a hidden value.

A preparation step selects its input limit from **all** write and byte ceilings.
For example, two new result/support rows per contribution permit at most 500 such contributions.
Additional dependency rows reduce that limit further; 1000 is a ceiling, not a batch default.
If a single record's dependencies exceed a step, retain a dependency sub-frontier and continue later.
Register those dependencies completely before making the value/build visible.
A native uniqueness conflict is an idempotent duplicate, not new output membership.
Charge its attempted insert, examined rows and input key.
Distinct membership needs only existence; do not calculate contribution counts for this wire.

### Publication and maintenance

The publication CAS checks the captured identity/release/source epochs and current build lease.
It checks all retained input phases complete, all dependency registration complete and actual sink custody.
It uses the owners' native start/final/covered-cut protocol, not caller-supplied success booleans.
LOCAL and all dependent FOREIGN repairs must be refresh-visible before ACK/publication.
A foreign privacy position is not a subject external version.
The dependent subject's own anchored version must advance and its repaired winner be visible.
A same-version 409 alone cannot prove that repair.
Ambiguous write responses, late registration and losing CAS cannot publish assumed completion.

A ready generation is immutable; a replacement is built alongside it.
Publishing the replacement swaps current/building by CAS and invalidates old-generation cursors with 409.
Drain old in-flight use and clean retired rows in bounded steps; do not retain a third usable generation.
Relevant reductions make the retained observation unsafe immediately, including exclusion/order effects.
Serving the old ready generation while repair proceeds is forbidden when its observation is unsafe.
Unrelated reductions may serve only when the native indexed routing establishes irrelevance.
Do not scan definitions or all results to discover affected builds.
Use the complete reverse routing retained by projection and query-dependency registration.
Ordinary additions can leave an identified older observation valid within existing freshness rules.
Privacy reductions have no freshness grace.
Healthy source-to-searchable lag remains 60 seconds; over five minutes requires readiness.
Do not infer those times from engine refresh alone.

Public preparation retains one current and one building generation per admitted read definition.
Idle prepared results expire after 24 hours under the existing policy.
Do not apply the owner-only 32-result quota as a new public per-account quota.
Do not invent an unlimited public cache: use existing admission/storage capacity and overload transport.
When capacity cannot reserve a building generation, return existing overload/readiness before enumeration.
Deduplicate simultaneous builds of the same definition by lease/CAS.
Do not replace an active building generation to bypass the one-building quota.
Expiry/cancellation marks a generation unavailable before bounded cleanup starts.
Cleanup uses retained indexed row frontiers and the same per-step ceilings.
No full-table deletion or uncharged background collection is introduced.
Existing deletion/account/rights owners govern minimization and suppression; this is derived-state cleanup.

### Cost

- Touches: finite native subject keys, complete selected projection, predicate/text execution, canonical mapping, support/value/dependency writes, captured change windows, publication CAS, maintenance and cleanup frontiers.
- Bound: each durable step reads at most 1000 input keys, writes at most 1000 result rows and one frontier, uses at most eight Access/dependency points per input, `64+16*input` examined rows, six blocks per budgeted row, 16 statements per backend, four engine searches, one connection per backend and 4 MiB response bytes. Reduce batch size for write/dependency/byte fanout. Retain one current/one building public generation and 24-hour idle expiry; no new numeric storage quota is implied.
- Growth check: native preparation at 64/512/4096 subjects, values, hidden prefixes, relation depth/history and dependency fanout independently; finite total relevant-input traversal, bounded steps, at most one step reread after interruption, actual maintenance/cleanup cost and served share under rising reduction arrival.

## Serve or continue a ready page

Reserve the whole request, authenticate every supplied property token and authorize the public source.
Reauthorize the actual current principal; a token is never a bearer permission.
Resolve every descriptor to its immutable prepared observation or a retained preparation job.
If any sibling cannot safely produce a filled/final page, return shared readiness for the request.
Do not expose already computed siblings in a partial `200`.
Do not advance their public cursors on a failed/readiness response.
A retry may reuse immutable preparation but repeats current authorization and safety checks.

Take the native safety start once for the common page and retain all sibling observation bindings.
The native adapter must join each retained observation's covered cut, not merely current live ACK.
Seek `key > after` on each unique ready value index.
Batch candidate/witness/target reads across siblings and native owners within the common ledger.
Check source authority, original/terminal own rows, Access, source tuples, consent and targets.
Do not read every support record of a popular value in the page request.
Whole-query custody establishes complete contribution membership for the identified observation.
A witness that becomes unusable triggers bounded repair/preparation unless a bounded alternative is available.
A saved witness/label is not permission to skip the current native checks.

Keep accepted values plus one eligible lookahead per property, within `2s+2` candidates/two reads.
A unique eligible lookahead proves that `next` is non-null.
Do not consume that undisclosed eligible key into the public position.
The position may advance past rejected keys only after they are examined and safely classified.
An engine/storage page ending because it hit its limit does not prove exhaustion.
The native ready keyset must explicitly prove end of that immutable key range.
When exactly `s` eligible values exhaust the range, return all `s` and `next: null`.
When fewer than `s` remain and exhaustion is proved, return that final nonempty page.
An initial truly empty population may return `values: []` with `next: null`.
A continuation cannot return an empty successful page.
If changed disclosure removes its entire tail, return readiness/restart as applicable.

Choose current labels, obtain existing date-time `as_of`, then revalidate immediately before disclosure.
The final native observation must detect relevant reductions committed after start even if ACKed now.
Perform the exact observation's own covered-cut check as well as changed-since-start detection.
Current clean pending heads do not authorize an unsafe older build or PIT.
No output, labels or tokens are sent until all siblings pass final validation.
Encode tokens only for facets with an eligible undisclosed tail and validated custody.
Return facets in request order with exactly `property`, `values`, `next` and envelope `as_of`.

### Cost

- Touches: all ready value seeks, support locators, current source/original/terminal/target checks, shared population start/final, current labels, freshness and confidential cursor work.
- Bound: `c <= 2s+2` and two index reads per property, summed inside `S<=128`, `8+4R` statements and one connection per backend. Points/rows/blocks/bytes follow the admission formulas; both native observations share two statements and `64+2*(behind+changed)` rows. Every failed sibling and reread remains charged.
- Growth check: native filled/final/empty-initial/deep/hidden-tail cases at fixed size and 64/512/4096 unrelated population, supports and history; actual ready seeks must avoid support-sized scans, and reductions ACKed before final must prevent unsafe `200`.

## State transitions and failure rules

| State | Input/event | Result | Retained effect |
| --- | --- | --- | --- |
| Absent | Admitted initial request | Existing readiness | Reserve one building generation |
| Captured | Finite population and complete custody available | Building | Retain fences and native observation |
| Building | One bounded successful step | Building | Atomic effects plus one frontier |
| Building | Source/projection progress | Building | Resume exact subject sub-frontier |
| Building | Rollback or no effect | Building | No frontier advance |
| Building | Crash after committed step | Building | Replay from committed frontier |
| Building | Ambiguous external effect | Repairing | Resolve native winner before advancement |
| Building | Input exhausted and final CAS wins | Ready | Immutable published generation |
| Building | CAS loses to valid winner | Ready or Building | Use persisted winner, discard losing staging |
| Ready | Static invalid cursor binding | 400 | No page/cursor advance |
| Ready | Relevant pending/change/unsafe covered cut | Readiness | Retain indexed repair work |
| Ready | Generation/identity/observation lost | 409 | New query must capture new observation |
| Ready | Current public source denial | Existing denial | No successful empty substitute |
| Ready | Safe filled/final page | 200 | Last consumed key only in confidential cursor |
| Ready | Ordinary relevant addition | Ready plus replacement | Existing lag policy; no in-place mutation |
| Any retained | Idle expiry/cancel | Expired | Block new reads, drain owned use, bounded cleanup |
| Any retained | Owner moved/unavailable/deadline | Existing readiness/unavailable | Preserve frontier, never certify emptiness |

Retry only within the caller's real deadline and remaining cost reservation.
A retry does not reset candidate, statement, connection or byte counters.
A failed final check discards public output; it cannot publish a partial sibling response.
There is no effectful page offset to roll back; cursor publication is the commit to the client.
Token replay rereads the same immutable range and rechecks current authority.
It does not consume a server queue or mutate another client's position.
A replay is equivalent only when dynamic privacy and current labels remain equivalent.
Crash recovery uses persisted build/lease/frontier state, never a process-local progress vector.
A stale worker cannot publish after lease/generation CAS loss.
Close only observations/resources this runtime owns, after draining in-flight use.
Never close supplied pools, Source or unrelated workers.

### Cost

- Touches: native failures, rollback/replay, leases, retained effects, repair routing, observation release and bounded cleanup.
- Bound: failed/replayed work uses the same page/step ceilings; recovery rereads at most one step of input. Cleanup is a charged durable step, and replay has no fresh quota. No transaction spans external engine or another owner I/O.
- Growth check: crash at frontier/effect/publication seams at 64/512/4096, CAS losers, lost responses, expired observations and cleanup restart; record actual discarded/reread work, resources and eventual useful pages.

## Exact declarations and proposed native adapters

The following are currently callable exports, with the limits described above:
`facetProperties(release, types)`, `parseFilter`, `admitFilter`, `walkFilter`,
`validateHitOptions`, `chooseTexts`, `encodeSearchCursor`, `decodeSearchCursor`,
`subjectSource(...).read/count/matchRelationFacets`, and the existing Search service/HTTP path.
Only `facetProperties` owns structural roster traversal and deduplication.
The type-only facet wire is available; it is not an installed validator or runtime factory.

`PublicFilterSource` declares `readPublicFilterProjectionPage`, `readPrivacyReductionHeads`
and `readPrivacyReductionPage`; its production factory is not supplied by those declarations.
`PublicFilterConsumerOperations` declares `capture`, `query`, `repairStep`, `readStatus`,
`closeObservation`, and `close`.
The selected future factory name `createPublicFilterConsumerOperations` remains a prerequisite.
Its current `query` returns `SearchResult`, not a value enumeration page.
Its capture input is a subject `SearchPlan`, not a facet descriptor.
Do not cast a facet operation into these subject signatures or fabricate a successful adapter.
The Source population request's consumer/start input still needs its exact observation join.
Trust the owner closure of that gap; do not implement an alternate SQL safety oracle here.

### Proposed population extension, pending Semantic adoption

Add a separately reviewed complete population page to the native Source boundary.
The names in this fence are **proposed**, not imports available to the runtime today.
It enumerates anchored subject identities, not public response values or permission verdicts.
Its retained window is native custody with ordinary creation/change coverage.

```ts
// Proposal only; Semantic chooses the owning module and adopts the declaration.
type FacetPopulationRequest = Readonly<{
  population: string; // registered complete native catalogue definition
  frontier: string | null; // opaque retained finite-window frontier
  inputLimit: number; // examined keys, 1..1000, including rejects/lookahead
}>;
type FacetPopulationPage =
  | Readonly<{
      status: 'progress' | 'complete';
      observation: string; // retained immutable population/window, not authority
      subjects: readonly Readonly<{ partition: number; subject: string }>[];
      frontier: string;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed' | 'unready' | 'unavailable'; cost: PublicFilterCost }>;
type ReadFacetPopulationPage = (request: FacetPopulationRequest) => Promise<FacetPopulationPage>;
```

The implementation validates current owners/epochs and native registered population internally.
The caller cannot supply head vectors, allowed IDs, claimed complete flags or arbitrary SQL.
`complete` closes the retained finite population plus its captured creation/change bridge.
It is not an empty current home and not a count comparison.
Projection pages still independently exhaust each enumerated subject's selected evidence.
The Source owner may adopt an equivalent existing internal declaration instead of this spelling.
Search must then record and consume that exact callable; no guessed method is permitted.

### Proposed facet consumer extension, pending Search and Semantic adoption

Extend the native consumer's admitted plan family with a closed facet plan.
Keep `PublicFilterQueriedObservation` as the one queried-observation type.
The proposed extension retains real facet contribution/order dependencies and source context.
It must share the owner's start/final protocol across all siblings within one page.

```ts
// Proposal only; these names are absent from the current runtime.
type FacetNativePlan = Readonly<{
  filterDocument: FilterDocument | undefined;
  text: TextNode | undefined;
  property: string;
  valueKind: 'item' | 'code' | 'type';
  meaning: PublicFilterProjectionMeaning;
}>;
type FacetPageExecution = Readonly<{
  queried: PublicFilterQueriedObservation;
  execution: string; // retained actual start, plan, rows and native value reads
  property: string;
}>;
```

The factory derives dependency keys from the full expanded AST and facet property/order.
It includes text names/aliases/descriptions, qualifier association, target label and identity inputs.
It includes subject-wide original/terminal reductions and ineligible repair locators.
No caller callback, public `safe` flag or ACK setter is added.
The implementation may add typed facet capture/query operations to the existing native factory.
It must not change the existing subject query contract or create a second observation type.
Before coding that integration, owners freeze its actual function signatures and native cases.
This adoption work is part of the runtime brief, not a new product decision or research round.

### Preparing/readiness transport

No new facet-specific preparing DTO is selected.
Initially use the existing `503 index_not_ready` problem with `Retry-After: 1`.
Retain and schedule real finite preparation on existing durable work before returning readiness.
Repeated identical initial requests locate that admitted read definition/build and its real frontier.
They must not restart preparation at subject zero on every request.
A cursor whose unchanged observation is unsafe can receive this same readiness outcome.
If the native shared retained preparation transport is adopted before implementation lands,
consume its exact committed transport instead; never manufacture a successful callback.
The shared Zone `202 {next}` protocol is not automatically a facet service API.
A missing factory produces readiness/unavailable, never preview values with `200`.
A quiescent, finite admitted population must eventually produce a useful filled/final page.
Permanent readiness or runtime placeholders cannot pass either implementation brief.

### Cost

- Touches: native population frontier, complete projection and actual facet consumer extension, retained jobs and readiness lookup/scheduling.
- Bound: population/projection/build work executes only inside the stated preparation-step limits; readiness lookup and scheduling are charged request work. No new numerical allowance or method-shaped permission grant follows from these proposed declarations.
- Growth check: real factories and current Source implementations at 64/512/4096, including sparse values and missing/moved owners; capture full native execution plus final status, not a type-only adapter or callback.

## Whole implementation brief: continuation runtime

The following is one coherent runtime assignment, pending owner adoption of the proposed extensions.
It includes transport, complete population, retained execution, current disclosure and generated closure.
It does not split a runtime stub from the behavior needed to make it safe and useful.
Estimate 1200 implementation lines across at most 24 files after owner ports are available.
If the real diff requires more, reshape a complete bounded implementation boundary with the manager.
Do not replace complete behavior with TODO factories to meet a line estimate.

### Dispatch metadata

```yaml
---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/src/search/**
  - services/kernel/db/search/**
  - services/kernel/test/search/**
  - services/kernel/src/server.ts
  - services/kernel/src/work/modules.ts
  - contracts/openapi.json
  - packages/client/src/kernel/**
  - packages/client/tests/*
riskAreas: [authorization, disclosure, rights, deletion, account]
acceptance:
  command:
    - bun
    - run
    - --cwd
    - services/kernel
    - check
    - test/search/facet-continuation-native.test.ts
    - test/search/facet-preparation-native.test.ts
    - test/search/growth-facet-continuation.test.ts
  tests:
    - complete count-free property pages and independent confidential cursors
    - current local and foreign privacy across immutable observations
    - finite retained preparation, recovery and unchanged whole-page budgets
  failing: true
estimate: { lines: 1200, files: 24 }
criticalPath: false
waiting: []
after: []
---
```

These test paths are proposed new files for the implementation owner to freeze before implementation.
No imported broken module is created by this specification.
The brief's callable prerequisites are complete Source projection/population and native consumer custody.
Coordinate exact owner declarations before consuming them; do not encode overlapping writers as after edges.
Existing privacy producer/consumer acceptance writers retain their own frozen tests.
This assignment adds facet outcomes at those seams, not a second producer acceptance suite.

### Runtime files and closure obligations

Update `facets.ts` validation to consume the adopted requested-facet type.
Preserve existing text/filter/language error semantics and own-property handling.
Validate cursor type and Search profile token length at `/facets/i/cursor`.
Keep all eight descriptors closed and reject duplicates before Source/engine I/O.
Use an explicit discriminated internal item/code/type plan, not arbitrary property string execution.
A released range property remains a range control; it does not enter value enumeration.

Replace `service.ts:facets` use of `countFacets` with whole-request retained admission/execution.
Retain the injected clock, current release supplier, actual Source and current authenticated principal.
Add native runtime dependencies through existing service/server composition.
Do not instantiate a test Source in production or silently use a missing optional producer.
A configured unavailable runtime yields existing readiness, with no preview path.
Subject search and suggestions keep their existing response contracts.
Universal kind counts are not added by this change.

Add a proposed `facet-runtime.ts` for request admission and atomic sibling output.
Add proposed retained storage/query SQL only where needed by the adopted native adapter.
Use existing migration conventions and native generated SQL interfaces.
Do not edit a released stored template's existing ID/source.
If a native engine query/template is needed, add a new version rather than rewrite released templates.
The old `countFacets` helper can remain for its existing internal tests but cannot serve this route.
Do not rename the sampled helper into a complete enumeration API.

Update `search/http/routes.ts` to accept optional per-property cursor.
Require `next: string | null` in every successful facet schema.
Keep count/total/relation/estimate absent from the response schema.
Expose existing `409 search_restart_required` alongside current errors.
Keep source Access, scope, suspension and bearer handling on the ordinary route stack.
A curator/editor bearer must not widen public value contribution.
Do not bypass the route by adding a direct SQL read endpoint.

Wire retained preparation into the existing Search work registration.
Preserve default module list order and one invocation of each original registration.
Use existing durable work and deadlines; do not add a second scheduler or indexer.
Persist jobs, generation CAS and effect/frontier custody before exposing readiness.
Close only this runtime's observations and drain on worker shutdown.
Do not stop shared services to make an isolated test pass.

Regenerate kernel OpenAPI and client declarations through their existing generators.
`contracts/openapi.json` is the generated HTTP authority consumed by external clients.
`bun run --cwd services/kernel openapi` owns the OpenAPI output.
`bun run --cwd services/kernel client` owns `packages/client/src/kernel/**`.
Generated Search service/routes declarations must include cursor and required `next`.
Their import closure must remain service-source-free under `scripts/client.ts` rules.
Do not hand edit generated `.d.ts` files or introduce a second hand-written public Facet DTO.
Keep generated schema/response literals count-free.

Web `apps/web/src/search/search.tsx` currently takes `facetProperties(...).slice(0,8)`.
Its type facet path asks for size 20 and drops continuation.
It requires a coordinated consumer change to retain per-property next and full roster groups.
`search-params.ts`, `search-queries.ts` and `sort.tsx` must preserve selectable typed conditions.
`apps/web/src/library/collection-filter-params.ts` also truncates the roster at eight.
That shared consumer must consume the same full structural roster policy.
`apps/web/src/kernel/fake/search-facets.ts` and corresponding stories must match recorded native responses.
These are Web-owned call sites, not permission to create a separate public wire.
The runtime assignment hands exact typed responses to the native closure/consumer work below.
A backend pass cannot be reported as Web completion.

### Concrete native operation proposal and phase custody

Adopt these additive operations on the existing native consumer factory, rather than cast subject plans.
The following names/signatures are proposals; current imports remain exactly those listed earlier.
The factory owns native storage, Source, engine, clock and public-source registration.
It never receives an authorization/refresh/completion callback from a request or test.

```ts
// Proposed additive methods; not current exports.
type FacetNativeRead = Readonly<{
  plan: FacetNativePlan;
  queried: PublicFilterQueriedObservation;
  size: number;
  after: string | null;
}>;
type FacetNativeReadyFacet = Readonly<{
  property: string;
  values: readonly FacetDiscoveryValue[];
  after: string | null;
  hasMore: boolean;
}>;
type FacetNativePageResult =
  | Readonly<{
      status: 'ready';
      facets: readonly FacetNativeReadyFacet[];
      asOf: string;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'preparing'; cost: PublicFilterCost }>
  | PublicFilterConsumerUnavailable;
interface FacetNativeOperations {
  captureFacet(
    request: Readonly<{ plan: FacetNativePlan }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerCapture>;
  pageFacets(
    request: Readonly<{ reads: readonly FacetNativeRead[] }>,
    context: PublicFilterConsumerContext,
  ): Promise<FacetNativePageResult>;
}
```

`captureFacet` resolves/reserves the real definition and its one-building generation.
Its captured result refers only to an actually ready immutable build, never partially staged rows.
Its preparing result returns a persisted existing `PublicFilterConsumerJob` for durable work.
Run it through the existing declared `repairStep(job, context)` after owner adoption.
`pageFacets` owns admission, actual start, native value reads, current checks and final validation.
Its `ready` branch follows all final native checks and contains the exact candidate-derived key position.
`hasMore` is true only for an eligible undisclosed lookahead, never for a capped storage page alone.
The HTTP service encodes that position with its authenticated per-property binding.
Neither `hasMore` nor the result object is accepted back as native safety evidence.
Authentication failures/restart/denial use the existing ProblemError path, not a new public union.
A mixed safe/unsafe request returns preparing/unavailable without any ready sibling payload.

During preparation, derive all filter leaves from `compileCurrentFilter` on the expanded AST.
Retain one three-valued match accumulator per admitted leaf, at most the existing 32 leaves.
Fold each complete selected statement into the matching property/range/qualifier leaves once.
Qualifiers must be satisfied on that same statement; separate statements cannot cross-match.
Keep unknown/withheld evidence uncertain until the complete Source boundary proves its meaning.
At subject completion, use the existing plan evaluator; only proven true contributes values.
Complete semantic unknown cannot make either a positive or NOT predicate true.
Incomplete coverage or unavailable evidence retains preparation; it is never semantic absence.
Retain bounded contribution records until that subject's membership is proven; do not publish early.

Text membership uses the same compiled text AST and analyzer on the registered immutable native PIT.
Evaluate a bounded enumerated subject-key batch against that PIT, with a terms-ID restriction,
`track_total_hits:false`, no sampler, no aggregation and no sampled statement filter.
Only the engine's actual matching subject IDs establish the text operand for that batch.
Bound batch size by the step's candidate/point/byte allowance; include every engine iterator cost.
Ordinary creation/text change bridges and projection version checks reconcile this retained batch.
A lost PIT or incompatible subject/projection generation invalidates staged publication.
No JavaScript string search, alternate analyzer or failed engine request becomes text false.
This is preparation work over captured finite input, never a claimed direct page optimization.

The captured source generation must join each subject's complete projection observation/version.
A `changed` projection abandons that subject's staged effects and follows its retained replacement.
Captured ordinary changes are applied through their finite bridge before sealing the generation.
No old/new partial projections are concatenated into one supposedly complete subject.
The publication CAS verifies this join through the existing owner observation custody.
A quiet finite input must complete; continuous changes cannot hide a repeatedly restarted prefix.

### Frozen runtime scenario: complete item page

Seed the released native fixture through ordinary create/adopt APIs.
Let `K[0]` through `K[22]` denote the actual 23 returned Concept UUIDs sorted by native key.
They are variables bound from native API responses, not invented routable IDs.
All 23 have eligible public support in the admitted Book population.
Each has label `{en: "Facet control NN"}` using its recorded fixture label.
Let `B` be the exact typed Book query below.

```json
{
  "filter": { "type": { "in": ["schema:Book"] } },
  "facets": [{ "property": "schema:keywords" }]
}
```

The first successful response has exactly these fields and values:

```ts
{
  facets: [{
    property: 'schema:keywords',
    values: K.slice(0, 10).map(value => ({ value, labels: labelsById[value] })),
    next: tokenA
  }],
  as_of: actualDateTime
}
```

`tokenA` is the actual confidential string; `actualDateTime` is the actual freshness result.
Capture them from the HTTP response; never substitute literal test tokens or fixture timestamps.
Readiness responses before this `200` use the real retained preparation path.
Continue with the same request and `{property:'schema:keywords', cursor:tokenA}`.
The next success is `K[10..19]` and a non-null `tokenB`.
Continue with `tokenB`; the final success is `K[20..22]` and `next:null`.
Compare complete ID arrays and exact envelope keys, not just page lengths.
The concatenation equals `K`, with no duplicate terminal identity.
Replaying `tokenA` under unchanged current context returns the same key range.
It does not consume or skip `tokenB`'s range.

A second fresh query uses size 20.
Its first success returns `K[0..19]` and a non-null token.
Its second returns `K[20..22]` with `next:null`.
A third fresh query uses size 2.
It returns eleven filled two-value pages, then one final one-value page.
No successful continuation is empty.
For exactly 20 eligible values at size 20, the first page is full and final.
For zero eligible values, only the initial page may be empty and final.
For an absent 24th value, do not invent a lower-bound bucket or count.

### Frozen runtime scenario: actual failure envelopes

For a valid request with `facets[0].cursor` replaced by a malformed string, require this body.
Only `request_id` is populated from the actual request context; no private locator appears.
The existing problem handler owns content type and any normal correlation headers.

```json
{
  "type": "https://rezics.com/problems/invalid_request",
  "title": "Invalid Request",
  "status": 400,
  "code": "invalid_request",
  "retryable": false,
  "effect_status": "not_applicable",
  "request_id": "<actual request id>",
  "errors": [{ "pointer": "/facets/0/cursor", "code": "invalid_format" }]
}
```

An authenticated expired/lost-context token instead requires this body:

```json
{
  "type": "https://rezics.com/problems/search_restart_required",
  "title": "Search Restart Required",
  "status": 409,
  "code": "search_restart_required",
  "retryable": false,
  "effect_status": "not_applicable",
  "request_id": "<actual request id>"
}
```

An admitted build not yet ready returns the existing 503 `index_not_ready` problem.
Its type/title/status/code are respectively `https://rezics.com/problems/index_not_ready`,
`Search Index Not Ready`, `503`, `index_not_ready`; `retryable` is true.
It has the same ordinary `effect_status`/actual `request_id` fields and `Retry-After: 1`.
It contains no facet values, public native job, fake token or exhaustion claim.
For the oversized 160-slot common page use 422 `unsupported_query`, not syntax 400.
Its ordinary problem fields come from the existing problem handler and `retryable` is false.
The route action is `subject:read`, so its POST problems retain `effect_status:not_applicable`.
All such failures leave previously published public cursor positions replayable under current safety.

### Frozen runtime scenario: canonical and code/type order

Create two originals resolving through ordinary native identity operations to one eligible terminal.
Use that terminal through separate eligible contributions where the contract permits them.
Facet output contains the terminal once, ordered by its canonical UUID bytes.
Do not select a label as the canonical key.
Change the published identity epoch between pages; the old token returns 409.
Pending identity work returns readiness before a page is published.
The native identity owner supplies these controls; no test SQL identity rewrite is authorized.

For released `schema:inLanguage`, create Book statements through ordinary adoption.
Use all 23 valid codes listed below on eligible Books:

```json
["ar","bg","cs","da","de","el","en","es","fi","fr","he","hi","hu","id","it","ja","ko","nl","pl","pt","ro","ru","sv"]
```

The complete value order is exactly this array under binary UTF-8 ordering.
Every value carries `{}` labels.
Run default-size, size-2 and size-20 walks and compare every key.
Refine each code using `{statement:{property:'schema:inLanguage',in:[code]}}`.
No UUID parse, language-label lookup or case folding may change the code.
Unsupported spelling remains an admission error under the existing release pattern.
A code outside the actual matching population is not emitted just because its schema permits it.

For `type`, create eligible subjects through ordinary APIs for actual released types.
Enumerate all types present in that controlled query population.
Sort actual type IDs by binary UTF-8 key, with released labels in the requested chain.
Refine each using `{type:{in:[returnedType]}}`.
Do not infer an instance's base classes as additional contributed type values.
Do not fabricate 21 released types to manufacture a transport demonstration.
The more-than-20 proof is required for item and code populations; type uses its actual population.
The same native algorithm and final-page logic must apply to all three kinds.

### Frozen runtime scenario: siblings and request atomicity

Request keyword size 2, language size 10 and type size 20 together.
The request has three reads and 32 output slots.
Start all three, then continue only keywords while restarting language and omitting type.
Its keyword token remains valid because unchanged siblings are not static binding inputs.
Reorder the descriptors and verify each output follows request order.
Insert the keyword token into language: 400 at that language descriptor's cursor pointer.
Change the keyword size from 2 to 10: 400 at its cursor pointer.
Omitted size and explicit 10 are interchangeable for a default-size token.
Change filter/text/languages or use another principal: 400 at the token pointer.
Do not compare today's identity hash before authenticating these invalid bindings.

Request eight supported properties at size 16 using real released properties/types.
When the current Book roster supplies fewer discrete properties, use a real broader released query.
Do not invent new fields for this test.
Admit only a supported query with 128 slots and capture its one common cost ledger.
Request the same eight at size 20: 422 before population/permission enumeration.
If no actual released query supports eight discrete properties, test the real supported roster
and freeze the eight-way budget reservation at the native planner layer without a fake release.
The API must still reject the 160-slot shape.
A malformed ninth descriptor fails structural admission, without starting preparation.
A sibling readiness/final safety failure returns no partial facet `200`.
Retry must neither skip already computed sibling values nor create duplicate public output.

### Frozen runtime scenario: local and FOREIGN privacy

Use the actual native fixture controls already owned by Source/consumer acceptance.
Pause ordinary indexing only through its real Search worker control.
Hide a contributor establishing the first keyword value.
The value must not survive solely because its target remains readable.
Hide a target while its contributor remains readable.
The value and its labels must not leak through membership, order or cursors.
Use two contributors for the same value; remove one and keep the other eligible.
A genuinely repaired replacement may retain that value once.
Do not scan every support of that value in the page request.

Withhold a selected tag used by the query's positive predicate.
Execute both positive tag and NOT tag queries against the lagged observation.
Both stay readiness until actual relevant local and dependent FOREIGN repair completes.
Returned-subject checks alone cannot certify NOT's excluded population.
Include source tuple, foreign target, consent and Collection source reductions where applicable.
Record the actual dependent source-key routing and original/terminal own-row checks.
A foreign target's own unrelated property name cannot prove source-key irrelevance.
Selected but ineligible dependencies remain internally routed for restoration.

Pause the actual execution after start and before final validation.
Commit a relevant reduction, repair it and let the real consumer ACK before releasing final.
The response still cannot publish this old execution.
Then run a new execution on the same older unsafe observation: it still cannot publish.
A new safe replacement observation may serve after complete custody and repair.
Repeat with zero returned values and an excluded relevant contributor.
Zero output does not exempt the query from the population safety check.
Repeat with an unrelated key reduction whose irrelevance native routing can prove.
That case can serve; globally preparing every request is not closure.

### Frozen runtime scenario: physical and retained-copy custody

Capture an actual PIT and its native registered observation.
Repair the live target and advance its genuine ACK.
Query the old PIT; the live ACK does not authorize that older copy.
Recreate the same physical index name through owned fixture lifecycle.
Its actual native index UUID changes; an old token/observation cannot inherit safety.
Keep actual meaning/read definition and consumer/projection generations in the comparison.
A fabricated matching physical name or generation number is insufficient.
A validated PIT renewal keeps the same observation and covered cut.
A lost or expired PIT requires existing readiness/restart, not alias recapture under the old token.

Use actual native sink hold/lost-response controls, not fabricated successful receipts.
Crash after sink effect before acknowledgment, then resume the durable repair job.
No ACK/publication occurs before the actual winner and dependent refresh visibility are established.
Release a delayed old write after live repair and exercise retained-copy custody.
Source/sink fencing must prevent unsafe resurrection before old observation use is admitted.
Do not substitute a checkpoint, final raw-fact replay or permanent soft tombstone for that proof.
These facet cases consume the existing physical custody boundary and frozen producer suites.
They do not duplicate or weaken those suites' writer scenarios.

### Frozen runtime scenario: retained preparation and useful progress

Seed more eligible native values than default/max pages and more raw inputs than one step.
Put size-plus-one matching values behind a growing hidden/nonmatching prefix.
The first request returns actual readiness and schedules one retained build.
Repeat the same query and observe that its durable frontier advances rather than restarts.
No request returns a short successful preview to avoid preparation.
No successful page is based on `relationFacetOverflow === false` alone.
The complete input/projection stream must establish every value, including beyond 128 on one subject.
Use at least 129 distinct keyword targets on one real eligible Book for that discriminator.
Every target is created/adopted ordinarily and included in complete projection custody.
The 129th value must be selectable and eventually enumerated.

Interrupt between source/projection input and effect/frontier commit.
Rollback leaves neither staged result nor frontier progress.
Interrupt after commit; recovery rereads at most one step and deduplicates effects.
Run competing builders; only the valid generation/lease winner publishes.
Expire an idle result after the actual 24-hour policy using the existing trusted clock control.
An old public cursor is unusable; bounded cleanup drains only owned retained state.
A new request can prepare a current build within existing capacity.
At quota/capacity denial, return current overload/readiness without half-published rows.
Do not introduce a public 32-per-owner quota or a second expiry clock.

### Native growth and cost capture

Run one discriminatory axis per native capture at 64, 512 and 4096.
Hold the effective query, released meaning, requested properties and sizes fixed.
Grow unrelated catalogue population independently of matching population.
Grow contributing values independently of total contributors.
Grow duplicate supports/aliases independently of distinct values.
Grow unrelated revisions/retractions/suppressions independently of current input.
Grow FOREIGN dependencies independently of visible output.
Measure first, deep, sparse, denied, empty-initial and repair/readiness cases.
Measure eight-way request reservation and real supported sibling execution.
Do not discard failed/retried operations from the ledger.

Capture candidates, input keys, Access/dependency points and result/frontier writes.
Capture output slots, engine searches and every actual native iterator step.
For OpenSearch, sum `next_doc_count + advance_count` over the full query tree and all shards.
Also capture examined/removed SQL rows, shared blocks, nested statements and connections per backend.
Capture request/response bytes for PostgreSQL and engine together.
Record privacy-start/final role-attributed subset and inclusive whole-page query/status totals.
Prepared steps must satisfy exact numeric ceilings, with no slack.
Ready pages must show constant examined rows/statements/bytes and logarithmic blocks as data grows.
Engine direct work, if enabled later, must be constant/logarithmic at fixed size/leaves.
A preparation request's small JSON response is not a step-work measurement.

If the adopted native cut reads/probes active XIDs, hold 1, 8 and 64 allocated native transactions.
Use real `pg_current_xact_id()` allocation and include inclusive query plus final status.
The budget has no active-XID term; growing work on that axis fails.
Do not add the fixture for a layout independent of active XIDs.
The owner native cut acceptance remains authoritative; this is its facet integration discriminator.

Increase reduction arrival rate with population and measure actual repair/ACK latency.
Record served versus readiness share, without lowering mutation rate at larger scales.
The served share must not fall across scales under the existing contract.
Permanent readiness, fabricated ACKs and omitting FOREIGN work fail.
Preparation total work follows finite relevant input; it must not revisit its full prefix per page.
Default/max/size-2 output correctness must be demonstrated on actual API responses alongside counters.
Formatter/type passes and controlled sources cannot establish these native outcomes.

### Acceptance commands and delivery evidence

The future runtime owner first freezes the named native files from these scenarios.
Use the exact current check runner; the following commands are future post-integration acceptance.
They are not commands executed for this specification artifact.

```sh
bun run --cwd services/kernel check test/search/facet-continuation-native.test.ts test/search/facet-preparation-native.test.ts test/search/growth-facet-continuation.test.ts
bun run --cwd services/kernel check test/search/public-filter-consumer.test.ts test/search/public-filter-custody.test.ts
bun run --cwd services/kernel openapi
bun run --cwd services/kernel client
bun run --cwd packages/client typecheck
```

Keep the existing frozen Source/consumer tests unchanged.
Run affected existing facet/service/route tests through the same native runner after owner reconciliation.
A formatter acceptance here does not authorize editing an incompatible frozen runtime assertion.
Report every public error/status/header, complete returned key arrays and actual cursor outcomes.
Record exact observed generations/physical incarnations privately with native evidence.
Do not expose native locator/token plaintext or private support IDs in public artifacts.
Record measured budgets and finite progress; do not substitute a receipt hash for outcomes.
A native protocol pass alone does not prove the default worker or public API integration.
Hand off generated client/OpenAPI closure and exact call-site behavior to the next brief.

### Cost

- Touches: complete runtime/HTTP/default-worker/generator integration and the frozen native continuation, privacy, recovery and growth scenarios above.
- Bound: no acceptance-only bypass; actual page, ready and preparation ceilings in this plan and Filtered lists apply inclusive of failed/replayed work. Runtime tests consume the existing owner Source/consumer factories and declarations, without a new permission budget or test-only successful port.
- Growth check: execute the specified 64/512/4096 axes, page sizes and native raw counters after integration; both useful outputs and unchanged budgets must pass. This document does not execute or certify those checks.

## Whole implementation brief: genuine released catalogue native closure

This is one native consumer closure assignment using the actual released fixture and runtime above.
It does not dispatch another writer for the already deferred persona/classification assertions.
It closes complete enumeration, selectable refinements, full roster and real range semantics.
It must consume the actual committed suspended-persona driver and fixture operations.
No runtime/native pass is implied by the following proposed frozen cases.
Estimate 1100 implementation/acceptance lines across at most 12 files.

### Dispatch metadata

```yaml
---
goal: search
manager: search
kind: implementation
paths:
  - services/kernel/test/search/released-facet-catalogue.test.ts
  - services/kernel/test/search/released-facet-roster.test.ts
  - services/kernel/test/search/support/released-facet-controls.ts
  - apps/web/src/search/search.tsx
  - apps/web/src/library/collection-filter-params.ts
  - apps/web/src/kernel/fake/search-facets.ts
  - apps/web/src/stories/search-facets.stories.tsx
  - apps/web/tests/*facet*
  - apps/web/src/kernel/recorded/*facet*
riskAreas: [authorization, disclosure, rights, deletion, account]
acceptance:
  command:
    - bun
    - run
    - --cwd
    - services/kernel
    - check
    - test/search/released-facet-catalogue.test.ts
    - test/search/released-facet-roster.test.ts
  tests:
    - native released values beyond twenty and selectable typed refinements
    - complete actual Book roster with separate quantity and time semantics
    - real personas and current disclosure through retained continuation
  failing: true
estimate: { lines: 1100, files: 12 }
criticalPath: false
waiting: []
after: []
---
```

The genuine runtime/wire is a code prerequisite, not a reason to add unrelated after edges.
Freeze the named cases only against its exact adopted declarations and native driver.
The new helper owns additional local data through the shared fixture's existing operations.
It is not a second fixture registry, release builder, write API or source population provider.
Existing deferred acceptance writers continue owning their frozen files.
This assignment consumes their landed assertions and persona behavior rather than rewriting them.

### Fixture setup and provenance

Use `createReleasedDiscoveryFixture({version:1})` from the one shared fixture.
Read `release.definition` and its actual pin; do not swap in a handcrafted release.
Use `createSubject(type,name,statements?)`, `adopt(subject,statement)` and `request(...)`.
Use `discoveryStatement` to preserve cited controlled assertions through ordinary contribution APIs.
Use actual returned subject/candidate/adoption IDs and API responses as test inputs.
Call `classification()` and `books()` for the existing released controls.
Do not directly insert selected facts, index documents, source rights or prepared rows.
Do not claim these controlled records are imported facts or a complete real-world catalogue.

Create one additional public `skos:ConceptScheme` with the ordinary API.
Create 23 extra public `skos:Concept` controls with stable fixture labels.
This exceeds the existing requirement of at least 12 extra controls.
Adopt each `skos:inScheme` relation to that actual scheme.
Adopt each control through released `schema:keywords` on real public Books.
Keep citations on all controlled assertions; use only Semantic-approved released meanings.
The scheme organizes controlled terms; it does not publish a new property or release.
No imported harem/word-count completeness claim follows from this setup.
Labels/IDs are actual API data, not fixed UUID strings written into expected responses.

For page-order assertions, sort the native returned Concept IDs by UUID byte order.
Map every expected ID back to its observed public label.
Give labels an order different from native UUID order so label sorting would fail.
Give some values repeated eligible support so contribution-count sorting would fail.
Make a low-key value rare and a high-key value common where native IDs allow it.
Do not mutate UUIDs or repeatedly regenerate fixtures to manufacture desired UUID order.
Compute the rare/common choice from the actual ordered returned IDs.
Use a deterministic data assignment after ordinary subject creation.

Scope the enumeration query to its controlled cohort through existing admitted text/filter inputs.
Use one explicit unique cohort term in each Book's public name for the text predicate.
The source query remains ordinary Search text grammar, not a test-only population selector.
Do not let existing harem keywords silently expand the expected 23-value cohort.
If other selected values are deliberately included, include their actual keys in the exact expected set.
Create supporting Books rather than adding unsupported property registrations.
Use real Search catch-up/default worker paths from the native driver.
The shared fixture's `catchUp` link projection is not proof of Search worker convergence.

### Actual input/output: selected refinement

For each returned item value `v`, send this actual request with the native ID substituted:

```ts
{
  text: cohortTerm,
  filter: {
    and: [
      { type: { in: ['schema:Book'] } },
      { statement: { property: 'schema:keywords', in: [v] } }
    ]
  },
  facets: [{ property: 'schema:keywords', size: 2 }]
}
```

The final concatenation of values equals the controlled eligible values of the refined Book set.
Separately send the same typed filter to `POST /v1/subjects:search`.
The complete subject ID set equals the fixture's actual support Books for `v`.
Compare IDs after canonical deduplication, without substituting page length for membership.
A value is selectable only when the real typed API accepts and executes its filter.
A button or schema enum alone does not satisfy selectability.
Walk search continuation/readiness through its real current transport.
Do not adapt a successful fixture callback into a fake HTTP result.

Repeat this check for **every** emitted code and actual type value.
For code use released `schema:inLanguage` with the 23 valid inputs above.
For type use `{type:{in:[v]}}` and actual eligible subject types.
No test sends item UUIDs as language codes or applies statement syntax to `type`.
Use current language chain labels in the facet response, while retaining native key equality.
Do not use labels as operands for any refinement.

### Frozen catalogue page walks

Run independent fresh default-size, size-2 and size-20 walks over the 23-item cohort.
Record actual initial readiness transitions and require a finite useful first `200`.
For default size the exact successful page lengths are 10, 10, 3.
For size 20 they are 20, 3.
For size 2 they are eleven pages of 2 followed by 1.
All nonfinal pages are filled and carry actual non-null opaque cursor strings.
Every final page has `next:null`, even if it happens to be exactly full.
Concatenated IDs equal the complete canonical expected set in ascending native order.
Assert exact keys on the envelope, facets and value objects.
Reject `count`, `total`, `relation`, `estimate` and any numeric-count substitute at every depth.
Do not inspect ciphertext to establish native observation safety.

Add a separate 21-value control, satisfying the exact beyond-default/max boundary.
Default walks are 10, 10, 1; max walks are 20, 1; size-2 walks are ten 2s and 1.
Add exact-size 10 and exact-size 20 controls to disambiguate lookahead/exhaustion.
Add an initial zero-value control with a genuinely empty eligible population.
Add a one-value control whose hidden second target cannot produce a fake non-null tail token.
An unsafe observation returns readiness, not a terminal assertion on the sampled tail.

The 129-values-on-one-Book case belongs to runtime population acceptance above.
Consume its actual native result in the delivery evidence; do not duplicate its writer here.
A 23-value many-Book test alone cannot discriminate per-subject truncation.
Neither test replaces the other.

### Complete Book roster

Call actual `facetProperties(f.release.definition, ['schema:Book'])`.
The bundled release currently declares the following order:

```json
[
  "schema:author",
  "schema:genre",
  "schema:keywords",
  "wdt:P179",
  "schema:datePublished",
  "schema:contributor",
  "schema:inLanguage",
  "schema:wordCount",
  "wdt:P7937"
]
```

Its declared bases include `schema:CreativeWork` and `schema:Thing`.
The current release contains no own type definitions for those two structural base IDs.
They therefore add no facets to this Book roster today.
Do not manufacture base fields, recurse through a different inheritance model or claim 16 Book facets.
The exported function already handles actual own/base traversal and deduplication.
Assert exact helper output against the actual pinned release consumed by the fixture.
If a future release changes the roster, its owner adopts that change and updates frozen expectations.
Do not silently intersect the expected roster with whatever the preview returns.

Partition this roster by its actual datatype and admitted operator.
The seven current discrete properties are author, genre, keywords, series, contributor, language and work form.
Date published is a time range; word count is a quantity range.
All nine must be represented in released schema discovery and the consuming refinement UI.
Do not send nine descriptors in one facet request or request range buckets.
One seven-property size-10 request has seven reads and 70 output slots.
Include `type` only in a separately admitted group or the eighth descriptor if its slots fit.
Never drop the ninth roster entry with `.slice(0,8)`.

The roster is independent of whether a property has any current values.
An empty author facet is still an author control with a genuinely exhausted value page.
Word count and date range controls remain available even when no range value exists in the cohort.
A missing/unknown amount must not become zero, an item key or an invented min/max statistic.
Use actual released property labels and operators for the configured controls.
The request grouping follows the existing eight-property and common-page 128-slot limits.
No raised limit or synthetic demo field is permitted.

### Quantity/time and independent range cases

Consume the existing `books()` controlled amounts and fixture meanings.
`B-long` has `+1200001` words with unit `1`.
`B-edge` has `+1000000`; `B-short` has `+999999`.
`B-unknown` and `B-characters` have no word count.
The edition's `+1400000` page amount does not establish work words.
Use the actual adopted light-novel form and source-scoped harem Concepts.
No importer tag or format text is promoted to those Concepts by inference.

The existing words/form/conjunction cases remain owned by their deferred acceptance writer.
Consume those cases after reconciliation; do not create another writer for them.
This closure adds range independence from value enumeration:

```json
{
  "filter": {
    "and": [
      { "type": { "in": ["schema:Book"] } },
      { "statement": { "property": "schema:wordCount", "range": { "gte": 1000001, "unit": "1" } } }
    ]
  },
  "facets": [{ "property": "type", "size": 2 }]
}
```

Only the actual matching Book type contributes to that controlled query.
Search with the same filter yields exactly `B-long` in the original controlled Book group.
When the extra cohort is outside that query, it cannot contaminate the expected set.
A lower-bound request of 1000000 deliberately includes the edge Book.
No amount on a character measurement or edition page count can satisfy word count.
An incompatible word-count unit is rejected by existing admission.
Do not invent a conversion from pages or characters to words.

Create independent public Book date controls through ordinary adoption.
Use actual `schema:datePublished` typed time statements, for example:

```json
{
  "time": "+2020-01-01T00:00:00Z",
  "precision": 11,
  "calendarmodel": "http://www.wikidata.org/entity/Q1985727"
}
```

Put controls at 2019, 2020 and 2021 plus an absent date control.
Filter using the existing astronomical-year range semantics:
`{statement:{property:'schema:datePublished',range:{gte:2020,lte:2020}}}`.
The exact 2020 control matches; 2019/2021/absent do not.
Combine that range with returned keyword `in` and confirm same query semantics.
Do not use time strings as item bucket values or expose numeric extrema.
Preserve unknown under NOT; absence is not a fabricated known year zero.

Use `authoredRecipe(name,minutes)` for independent released cooking-time cases.
Run actual 25, 30 and 31-minute controls with the existing Q7727 unit.
`lte:30` includes 25/30 and excludes 31.
The release's cooking minutes are a quantity, independent of year-range time.
Do not substitute unit `1`, seconds, an ISO duration string or Recipe diet inference.
Diet classification uses the actual `diet()` group only when required by an existing adopted case.
A missing personal cooking completion producer is not simulated by `state != cooked`.
These range cases do not require inventing a new measurement property.

### Persona and disclosure integration

Use the committed native suspended bearer driver and the fixture's ordinary persona requests.
A held bearer of a now suspended account returns `401 invalid_credentials`.
Require `WWW-Authenticate: Bearer error="invalid_token"` through the actual route stack.
Do not expect a valid newly minted suspended bearer or a kernel 403 substitute.
Do not rewrite the frozen persona file or create a fake suspended principal string.
The account owner supplies suspension and sign-in truth; consume it.

Anonymous and authenticated public readers see only public contribution/target eligibility.
Editors and curators cannot contribute their private view to a public facet request.
Unscoped bearer behavior follows the existing route's real scope policy.
A current source denial remains denial, never an empty successful facet list.
Hidden/taken-down targets and contributors cannot leak through keys, labels or final tokens.
Apply local and FOREIGN controls through existing owner command surfaces.
Do not install test-only grants or source fences through product SQL.

Continue after a value-support privacy reduction while ordinary indexing is paused.
Observe readiness until genuine dependent repair, then require useful current pages.
Do not accept zero successful data, timed polling alone or a declaration of ACK as the outcome.
Bind any continued token to the same principal, property and original effective query.
Test the actual changed-sibling and malformed/expired-token outputs from runtime acceptance.
Do not write an alternate cursor decoder in the fixture.
If an owner declaration names a physical/native case already passed in its suite, consume it.
Do not recompute hashes or independently re-verify foreign receipt evidence for this brief.

### Existing frozen assertions and handoff ownership

`test/imports/discovery-user-cases.test.ts` contains an older count-bearing harem facet assertion.
That assertion expects `total`, facet `relation` and value `count`.
It conflicts with the already adopted wire and is already a contract-owner migration concern.
This specification does not edit it, restore counts or use it as runtime truth.
Its existing acceptance writer must replace it under the adopted owner authority before native closure.
The implementation worker must not weaken or rewrite a frozen file to make its run green.
The current documentation acceptance is independent of that future runtime migration.
No product/native completion is claimed while this assertion remains unreconciled.

Existing classification, words, combined filters, importer citations and persona cases retain their writers.
This assignment adds only missing complete enumeration/refinement/roster/range consumer cases.
It uses the shared released fixture without changing its exported signatures.
If an exact new helper is required for the extra cohort, keep it local to these tests.
The helper calls only existing create/adopt/request operations and closes only its owned fixture use.
It cannot become a second global released-data registry.
Do not create a test-only release/property just to force eight discrete Book facets.
Do not duplicate existing authored recipe or word-control populations unnecessarily.

### Consumer and generated closure

Consume the real generated `KernelClient['subjects']['$facets']['post']` types.
Remove local optional-next/preview casts that hide a schema mismatch.
Store continuation by property/effective query, not one shared cursor for every group.
A changed filter or language chain resets the affected query's cursor state.
A More action requests the same property's size and token and appends unique native keys in order.
A replay/retry cannot append a page twice.
A 409 discards old observation pages and starts the current query explicitly.
Readiness preserves usable query state and displays the existing preparing UI.
It cannot masquerade as a completed empty property.

Replace roster truncation in Search and Collection filter parameter admission with full helper output.
Group admitted discrete requests within eight descriptors and the common page's budget.
Render declared time/quantity controls from released operators/units independently of bucket pages.
Keep code operands as strings, type operands as type IDs and item operands as canonical UUIDs.
The same abstraction must behave consistently on Search and Collection refinement surfaces.
Do not add a private owner predicate to the public facet source.
Library/Collection owner execution remains the Commerce contract's responsibility.

Update the existing facet fake and stories only from recorded actual native API envelopes.
Record filled, final, preparing, restart, empty-initial and private-target-reduced cases.
Use current signed-out and authenticated viewer variants and existing responsive story conventions.
Keep range controls present with no discrete values.
Keep the actual nine-entry Book roster visible without inventing additional fields.
Story interactions select an emitted value and submit the same typed filter used by native acceptance.
A count-free visual snapshot alone cannot establish native completeness or selectability.
Page/API evidence remains distinct from the runtime factory's protocol evidence.

Generated OpenAPI/client changes belong to runtime brief regeneration, not hand edits here.
If the consumer reveals an omitted route response/error union, repair its owning schema minimally.
Regenerate and verify the affected generated closure through the existing commands.
List any files outside the brief's declared paths with a concrete blocking reason.
Keep authorization/disclosure/rights/deletion/account changes inside declared risk coverage.
Unrelated product redesign and native safety research remain outside this implementation assignment.

### Acceptance commands and evidence

The following are future post-integration native/consumer commands, not checks run for this document.
First freeze the new native files from the cases above without importing unavailable producers.
The native driver must execute real APIs and default worker integration once available.

```sh
bun run --cwd services/kernel check test/search/released-facet-catalogue.test.ts test/search/released-facet-roster.test.ts
bun run --cwd services/kernel check test/semantic/released-discovery-capabilities.test.ts
bun run --cwd apps/web typecheck
bun run --cwd packages/client typecheck
```

Run existing deferred native persona/classification acceptance unchanged after its owner adopts the wire migration.
Use `bun run --cwd apps/web test:stories` for the changed existing recorded-response stories
under the Web owner's scoped runner policy. A type check is not a renderer pass.
The native closure report contains actual request bodies and successful/error response envelopes.
It includes every page's IDs, expected canonical union and selected refinement subject IDs.
It records real released roster/operator/unit data and the controlled citations used to seed records.
It includes readiness-to-useful-page progress and actual current privacy outcomes.
It links the runtime's native growth/custody evidence rather than duplicating producer receipt writers.
No reference-project execution, external data provenance or product promotion is implied.

### Cost

- Touches: shared native fixture creation/adoption/read requests, complete facet walks and refinements, released roster/range controls, current personas, recorded client/renderer consumption.
- Bound: ordinary fixture writes retain owner limits; each API page shares the runtime's existing whole-request ceilings. Seven size-10 Book discrete facets reserve 70 slots; nine roster entries do not authorize nine descriptors or range buckets. Extra controls introduce no product property, quota, permission or background-work allowance.
- Growth check: consume actual runtime 64/512/4096 native counters and execute 21/23-value default/max/size-2 refinement walks plus the complete real roster. UI/format/type results prove only their respective layer; they are not exhaustion, privacy, native growth or promotion evidence.

## Adoption decisions and artifact handoff

Choose retained preparation for general complete value discovery; direct aggregation remains unadmitted.
Choose exact UUID-byte/code-byte/type-ID order and unique canonical retained value rows.
Choose per-property static bindings independent of siblings, with all dynamic custody retained confidentially.
Charge sibling reads through one common page and reject the syntactically valid 160-slot shape.
Use existing 503 readiness initially with actual retained work; invent no facet preparing DTO.
Keep the actual nine-property Book roster, seven discrete properties and two independent range controls.
Propose the complete population extension and facet consumer extension for owner adoption before runtime coding.
Keep existing deferred/frozen acceptance writers responsible for their own wire/persona migration.
These decisions resolve this design boundary without asserting an unlanded producer already exists.

The reference source read for the cost surface is OpenSearch `QueryTimingType.java` and `Timer.java`
under `.reference/search-canonical-coverage/opensearch/server/src/main/java/org/opensearch/search/profile/`
(`query/QueryTimingType.java` and `Timer.java`), read through the designated main-checkout reference path.
The reference index records OpenSearch commit `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`, Apache-2.0.
Those sources name iterator timing counters and serialize actual invocation counts.
They provide no evidence that a facet plan's iterator work meets the adopted growth limits.
No reference code is copied, built or executed; no new external research is required by this proposal.

Only this English design artifact changes in this specification slice.
Its frozen future scenarios stay as fenced examples/prose until the implementation owner installs real tests.
The artifact acceptance command is the prescribed formatter check on this file after integration.
Current minimal mode runs no acceptance, worker-check, native/database/browser/remote check or probe.
Documentation-only work requires no workspace compiler.
Formatting and committing this artifact supply no product outcome/native proof.
