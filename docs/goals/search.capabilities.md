# Search capability acceptance manifest

This is the Search start and closure inventory required by the adopted
[API acceptance gaps workflow](../research/api-acceptance-gaps.md#workflow-change-the-manager-can-adopt).
It adds no product authority, endpoint, fixture implementation or frozen assertion. [Search](search.md),
[first-public scope](../scope.md) and [Filtered lists](../filtered-lists.md) retain their authority.
Source inspection baseline: `a42079db4768720dc6075884b5486bbfef42289c`.
No native capability command was run for this inventory; no capability is promoted or complete.

## Evidence rules and common boundaries

Each capability records five separate stages: **specification validated red**, **native driver registered**,
**implementation exposed**, **user-case native pass at named revision**, **promoted**. A source-present assertion
is not a measured red result. A formatter, missing-driver verifier, helper, registration, source inspection or old
focused green supplies no native pass. Promotion requires main evidence covering the named revision and every
applicable cell. REQUIRED NOT YET FROZEN/BOUND means an obligation remains open, not a successful rejection.
Commands below identify existing evidence entry points for later owner checks; this document does not run them.
Exact original titles and declared counts are in [the suite ledger](#original-suite-ledger).

Every six-cell table covers public/private/unlisted source visibility and anonymous, editor, owner (Alice), other
owner (Bob), delegated actor, unscoped actor, the suspended account's pre-suspension bearer and revoked/invalid
credentials. Existing SearchDriver exposes only anonymous/editor/acceptor/suspended; PagesDriver adds curator instead
of acceptor.
The other personas require real native fixture extensions; a public grant cannot stand in for them. Public output
never borrows an editor's private authority. A grant on a Collection or Zone grants nothing in its sources.
Bans beat independent grants. The native suspended fixture is created by `createPersonas` in
[personas.ts](../../services/kernel/test/support/personas.ts): it receives an ordinary Auth bearer, then the
fixture suspends the account through the native account command ([suspension](../../services/kernel/src/access/suspension.ts),
[authentication floor](../../services/kernel/src/access/authenticate.ts)). That pre-suspension bearer is rejected as
`401 invalid_credentials` with `WWW-Authenticate: Bearer error="invalid_token"`; revoked credentials remain a
separate 401 control, and neither downgrades to anonymous. Auth mints active accounts only; correct-password
sign-in for a suspended account returns `403 ACCOUNT_SUSPENDED` without a session, while wrong-password sign-in
remains ordinary 401. Accounts owns that sign-in producer case; its native acceptance receipt is pending. A kernel
`403 account_suspended` for a hypothetical verified suspended bearer is defensive only. Search and Pages drivers
bind the fixture's real suspended account ([Search supervisor](../../services/kernel/test/search/support/outcome-supervisor.ts)
via the [Semantic outcome driver](../../services/kernel/test/semantic/outcome-driver.ts), and
[Pages outcome driver](../../services/kernel/test/presentation/outcome-driver.ts)); see their outcome suites for
current API evidence. These rulings supersede the earlier valid-suspended-persona interpretation.

Shared producer/consumer boundaries: Semantic owns released meanings, complete selected-public projections,
original/terminal identity and Zones; Imports owns reviewed provider mappings; Commerce owns common Collections,
owner facts and owner-query admission; Content owns public rating figures and native private populations; Accounts
owns Auth/Access and consent; Search owns public plans, indexing and presentation aggregation; Web owns publication;
Performance owns budgets and capture. This inventory covers Search participation in every relevant In scope row;
other owners retain accounts, checkout, notices, moderation and content commands. Articles/hosted works remain
closed behind grants; feeds, algorithmic recommendations, saved personal queries, Realm rating sorts and points
remain deferred. Curated rankings, Global rating order and Collection export remain relevant consumers.

## Released fixture definitions and logical records

The [report's definitions and fixtures](../research/api-acceptance-gaps.md#definitions-and-fixtures-the-missing-cases-require)
are shared producer requirements, not independent test-only releases. Inspection of the bundled
[release](../../packages/definitions/release/rezics.json), [Book](../../packages/definitions/catalogue/book.yaml),
[Recipe](../../packages/definitions/catalogue/recipe.yaml), [classification](../../packages/definitions/catalogue/classification.yaml)
and [game](../../packages/definitions/catalogue/game.yaml) does not supply the complete builder or its pins.
Semantic/Imports must supply a versioned native fixture builder mapping logical records to actual created IDs,
released property/Concept identities, release digests and reviewed import provenance. None is invented here.

| Fixture                | Required logical records and controls                                                                                                                                                                                       | Current producer gap                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Genuine words          | B-long=1200001, B-edge=1000000, B-short=999999; B-unknown absent/somevalue; B-characters has characters-only1400000; edition-page control                                                                                   | Semantic must release nonnegative integer `schema:wordCount`, unit `1`, Book facet and native data. Pages, characters and reading-time estimates cannot fill words.                                                          |
| Form and tag           | B-long, B-edge, B-characters are LN+HAREM; B-short LN without HAREM; B-unknown HAREM with unknown form; B-tag-only different form; B-form-only no HAREM                                                                     | Real public adopted LN/HAREM Concepts with scheme/labels/attribution and a released FORM property/mapping are missing as a pinned native fixture. FORM/LN/HAREM are logical names, never placeholder CURIEs or exported IDs. |
| Diet and duration      | R-quick vegetarian25, R-edge vegetarian30, R-slow vegetarian31, R-meat nonveg20, R-unknown unknown-diet20, R-cooked vegetarian20, R-other-cooked vegetarian20; unknown cookTime excluded; authored ingredients/instructions | `schema:cookTime` integer minutes (`wd:Q7727`) exists; Semantic must release diet representation/vegetarian Concept mapped to VegetarianDiet. No private label or ingredient heuristic supplies diet.                        |
| Completion             | Alice completed R-cooked; only Bob completed R-other-cooked; all four quick vegetarian recipes have Alice support                                                                                                           | Commerce must adopt the owner-query wire and absence-of-own-live-completed-cooking-session semantics. Clearing state cannot erase completed history.                                                                         |
| Releases               | Actual Switch/Japanese and PC/English crossed statement qualifiers, dates, work/release distinction, compact/expanded storage                                                                                               | Semantic/Imports own native released tuples; Switch+English must not combine statements, Switch+Japanese must match. Aggregate work platforms invent no releases.                                                            |
| Owner support and pins | Alice state-only, label-only, session-only, completed-history-only and holding-only subjects, overlap, empty shell and follow-only; Bob independent; two immutable releases and renamed/retired choices                     | Bundled library profiles/type bindings and native released pin fixture are missing. Alice label/holding-supported B-long must exist without state or entry. Unprofiled Person cannot gain a fresh state.                     |
| Sources                | C-public contains all controls, duplicate occurrence with separate note and B-long alias; distinct private/unlisted Collections and published dynamic generation; Z-public overlapping mount+scope                          | Commerce/Semantic must bind real common members and canonical union consumers, not a fake response.                                                                                                                          |
| Reductions             | Newly withheld HAREM on readable subject, hidden tag target, local/foreign source/consent/target loss, hidden original/readable terminal, invalid public generation                                                         | Semantic/Accounts must provide native reductions and deterministic barriers; Search must bind repair/ACK and current consumers.                                                                                              |
| Rating and traversal   | Real independent Global voters, threshold/prior controls, extreme private Realm producer, paged credits/claims, unpublished Realm work, global agent, late board loss                                                       | Existing Global native fixture is reusable; Content owns the missing private population, Semantic/Content/Web own composed context and traversal fixture pins.                                                               |

## catalogue-jobs

**User job:** find words>1000000, light-novel+harem (LN+HAREM), both, vegetarian+cookTime≤30 and platform releases with qualifiers
on one statement. **Personas:** all common personas, plus native acceptor. **Released fixtures:** words/form/tag,
diet/duration/completion, release tuples, owner support/pins and sources above. Book range uses existing inclusive
`gte:1000001`, unit `1`; minute storage and request units must agree.

| Surface                  | Required consumer result                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Anonymous words and combined exact {B-long}; LN+HAREM exact {B-long,B-edge,B-characters}; diet/time exact {R-quick,R-edge,R-cooked,R-other-cooked}; crossed release tuple excluded. Private completion predicate unavailable anonymously. |
| CURATED                  | Same catalogue predicates intersect eligible canonical C-public membership; occurrence editor separately preserves duplicates/notes/order. Alice personalization only where Commerce admits it.                                           |
| EVERYTHING WITHOUT STATE | Intersect each exact set with Alice's support union, including label/holding-only B-long with no state; no fabricated entry. Own not-completed set {R-quick,R-edge,R-other-cooked}.                                                       |
| OWN STATE                | Same catalogue predicates intersect Alice's selected accepted state; Bob's state irrelevant. Adopted completion predicate includes supported no-entry subjects where applicable; it is not `state != cooked`.                             |
| MOUNTED ZONE             | Same exact sets over eligible mount+scope canonical union, all pages without duplicate subjects; public results never read Alice history. Private personalization remains pending explicit owner admission.                               |
| configured TYPELIST      | Configured Book/Recipe/game lists agree with the predicates and eligible population. Subject detail projects words/unit/form/tag/diet/time/release tuples factually; no new filtered detail-object API.                                   |

**Frozen scenarios and binding:** reuse original “Statement filters use adopted Global values and positive roots
admit bounded negation” and relation “qualified relation facet filters are refused without changing unqualified
author semantics” from the ledger. These author cases do not prove the required catalogue jobs. Reuse dynamic
“shared cursors bind Collection identity, the effective filter, and the admitted sort” in
[dynamic outcomes](../../specs/dynamic-collections-outcomes.test.ts); its concrete query serialization does not
mount common route admission. Current [members route](../../services/kernel/src/library/collection-routes.ts)
admits view/cursor/limit, not the full shared query. Required six-cell named scenarios: REQUIRED NOT YET FROZEN/BOUND.
More-than-preview facet values and properties must be reachable through an actual owner API; current facet size≤20
and properties≤8 do not supply a continuation schema. Owner adoption is pending, not silently dropped.

**Native wrapper/command:** [Search wrapper](../../services/kernel/test/search/outcomes.test.ts) and
[relation wrapper](../../services/kernel/test/search/relation-facet-outcomes.test.ts), with the Search driver;
`bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/relation-facet-outcomes.test.ts`.
No complete six-surface catalogue command is registered. Semantic/Imports first supply released definitions and
builder/pins; Commerce adopts owner query, then consumers reuse those records. Unsupported required requests remain
failures of the job; typed422 only passes deliberately unsupported controls. No title matching or fake release.

| Stage                                   | Evidence                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| specification validated red             | Original assertions present; measured red receipt not recorded here; new jobs REQUIRED NOT YET FROZEN. |
| native driver registered                | Original Search/relation wrappers registered; required released cross-surface jobs unbound.            |
| implementation exposed                  | Search/facets exist; required definitions, owner query and generic members admission incomplete.       |
| user-case native pass at named revision | None recorded for this capability.                                                                     |
| promoted                                | No main closure evidence.                                                                              |

## query-privacy

**User job:** search/refine safely during paused indexing, including positive/NOT HAREM, order, facet value/label,
requested field and confidential consumed cursor. **Personas:** all common personas with local and foreign
source/consent/target reductions. **Released fixtures:** reductions, books, Concepts and sources above; no private
values/IDs may enter public projections.

| Surface                  | Required consumer result                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Native current filter/order-key narrowing protects exclusions and order, own-row reductions protect emitted fields; no public Search totals at all, including rating. |
| CURATED                  | Reauthorize source and originals/terminals at disclosure, including unlisted/private sources; public curator authority never bypasses a reduction.                    |
| EVERYTHING WITHOUT STATE | Current Alice authority and owner-row checks plus public catalogue dependency safety; labels/holdings remain private.                                                 |
| OWN STATE                | Same safety for own state/completion predicates; another principal, withdrawn delegation or consent cannot use the cursor.                                            |
| MOUNTED ZONE             | Zone grant does not grant mount/source/subject rights; local AND foreign dependent reductions protect union exclusions/order.                                         |
| configured TYPELIST      | Same Search safety in page aggregate, with requested facts/labels and final barrier; no aggregate cache becomes authority.                                            |

**Frozen scenarios and binding:** originals for paused hide/takedown and relation target hide in the ledger;
[deletion/count outcomes](../../services/kernel/test/search/deletion-count-outcomes.test.ts) declares four expanded
cases: “hidden source deletion immediately withholds hidden-only search totals and type/code/item facet counts”,
“hidden source deletion immediately withholds mixed visible/source search totals and type/code/item facet counts”,
“taken_down source deletion immediately withholds hidden-only search totals and type/code/item facet counts”, and
“taken_down source deletion immediately withholds mixed visible/source search totals and type/code/item facet counts”.
They check contributing sources, not just bucket target labels, but still assert totals and need owner reconciliation.
[Live facets](../../services/kernel/test/search/live-facets.test.ts) has “live facet counts include only current
disclosed source matches and values” and “repeated facts and duplicate hits contribute once per source and value”;
these helper cases are internal accounting evidence, not public count permission or complete API binding.
[Confidentiality outcomes](../../services/kernel/test/search/cursor-confidentiality-outcomes.test.ts) declares two:
“real API cursor confidentiality after a rejected hidden lookahead” and “real API cursor confidentiality after a
rejected taken_down lookahead”. They resume from rejected consumed keys through real HTTP with indexing paused.

**Native wrapper/command:** these outcomes import [Search driver](../../services/kernel/test/search/outcome-driver.ts);
`bun run --cwd services/kernel check test/search/deletion-count-outcomes.test.ts test/search/cursor-confidentiality-outcomes.test.ts`.
New withheld-positive/negative, foreign repair and late barrier/ACK races: REQUIRED NOT YET FROZEN/BOUND. Reuse
[Semantic producer contract](../../services/kernel/src/semantic/public-filter-source-contract.md), currently types/future
boundary: same-transaction lossless reductions, complete routing/registration, all4096-home logical coverage through
behind/changed access paths, actual refresh-visible local AND dependent foreign repair before contiguous ACK.
ACK binds physical target/incarnation, consumer/projection generation and meaning/read definition; checkpoint/alias
is insufficient. Late registration, old snapshots, lost CAS, ambiguous sink result and pruning must not advance ACK.
Start/final validation detects a relevant reduction even if repaired/ACKed between observations. Unknown routing
prepares; query key narrowing never replaces Access or own-row checks. No estimate, zero or row-length fallback.

| Stage                                   | Evidence                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| specification validated red             | Existing cases present; measured red receipt not recorded; full race matrix REQUIRED NOT YET FROZEN. |
| native driver registered                | Deletion/confidentiality outcomes registered; complete producer/repair/ACK binding missing.          |
| implementation exposed                  | Hit checks exist; public route still requires totals; narrowed native query privacy incomplete.      |
| user-case native pass at named revision | None recorded for this capability.                                                                   |
| promoted                                | No main closure evidence.                                                                            |

## freshness-and-recovery

**User job:** see ordinary edits within60s healthy, readiness beyond5m actual source-to-searchable lag, and owner
writes on the next read; reach useful full/final sparse/deep pages or explicit preparation. **Personas:** all common
personas through interruption/restart. **Released fixtures:** growing sparse sources, independent owner writes,
foreign repairs and retained finite build input using the shared records/pins.

| Surface                  | Required consumer result                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Measure whole relay/dependency/preparation/refresh path; finite retained progress fills sparse/deep/final pages. |
| CURATED                  | Filtered canonical members fill or exhaust; source revocation is immediate or explicit readiness.                |
| EVERYTHING WITHOUT STATE | Alice label/holding/session writes appear next read even with public index lag.                                  |
| OWN STATE                | State/completion write cannot hide behind stale owner preparation.                                               |
| MOUNTED ZONE             | Union consumer retains progress over every source and survives crash/replay without empty-success chains.        |
| configured TYPELIST      | Aggregate propagates honest preparation/unavailable and useful pages; no permanent preparing.                    |

**Frozen scenarios and binding:** retain original “New subjects become searchable and suggestible within fifteen
seconds with current as_of”, the original unavailable/rebuild cases and
[real-source composition](../../services/kernel/test/search/real-source-composition.test.ts) “Search pause drains its
runner while real semantic relation events converge, and resume owns one replacement”. Fifteen-second original
assertions remain intact; the shared healthy60s/max5m contract also needs pipeline/owner coverage. Dynamic
“bounded Collection filters advance opaque prefixes through hidden and filtered candidates without joins” in
[dynamic outcomes](../../specs/dynamic-collections-outcomes.test.ts) explicitly expects empty success and an old
candidate multiplier. Commerce/Search/Performance own reconciliation; it is not blessed as useful-page acceptance.

**Native wrapper/command:** original Search wrapper plus real-source composition imports the driver client;
`bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/real-source-composition.test.ts`.
Full retained preparation crash/owner-read-after-write matrix: REQUIRED NOT YET FROZEN/BOUND. Reuse interruption
controls; expose actual admitted plans/frontiers, not an in-memory result or endless preparation.

| Stage                                   | Evidence                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| specification validated red             | Original assertions present, measured red not recorded; full recovery matrix not frozen. |
| native driver registered                | Search/default-worker slice registered; owner/prepared cross-surface binding missing.    |
| implementation exposed                  | Ordinary indexing exposed; complete useful-page/preparation pipeline not established.    |
| user-case native pass at named revision | None recorded for this capability.                                                       |
| promoted                                | No main closure evidence.                                                                |

## canonical-keysets-and-generation

**User job:** traverse unique canonical subjects across pages/merges/identity epochs with private bound cursors,
and restart409 on generation change, including empty results. **Personas:** all common personas; hidden originals
with readable terminals, last eligible original in actual4096-original group. **Released fixtures:** sources, aliases,
two releases, identity epochs and real large groups; stored personal originals remain unchanged.

| Surface                  | Required consumer result                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Canonical cross-page uniqueness and epoch readiness/restart; original AND terminal access, no arbitrary representative. |
| CURATED                  | Canonical browsing unique across pages; curation retains each occurrence's order/note and duplicate identity.           |
| EVERYTHING WITHOUT STATE | Union support by canonical subject without losing original grants or owner conflict/pins.                               |
| OWN STATE                | Latest owner state with visible conflict, union labels, separate sessions/copies; no fabricated access via terminal.    |
| MOUNTED ZONE             | Overlapping sources/aliases produce one canonical traversal; current source authorization on continuation.              |
| configured TYPELIST      | Same canonical cursor/epoch/generation contract even when underlying query returns zero hits.                           |

**Frozen scenarios and binding:** original name paging/rebuild cases; [bounded generation readiness](../../services/kernel/test/search/bounded-generation-readiness.test.ts)
“an alias switch after readiness pins the verified physical generation including zero-hit queries”; and
[query generation](../../services/kernel/test/search/query-generation.test.ts) “zero native hits retain the explicitly
selected generation for every nonrating sort”. The latter is a query seam, not a complete HTTP capability.
[Bounded name outcomes](../../services/kernel/test/search/bounded-name-cursor-outcomes.test.ts) has “legal compatibility
ligature names page through the real API with native null sort keys and confidential bounded cursors”.
[Canonical coverage](../../services/kernel/test/search/canonical-coverage.test.ts) retains adversarial witnesses,
but helper/certificate scaffolding is not the adopted epoch lifecycle. Actual4096-original HTTP controls across
these surfaces: REQUIRED NOT YET FROZEN/BOUND; no per-page alias sweep or raw256 protocol is adopted.

**Native wrapper/command:** Search wrapper and bounded-name outcome driver client;
`bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/bounded-name-cursor-outcomes.test.ts test/search/bounded-generation-readiness.test.ts`.
Search binds confidential principal/request/operation/generation/epoch cursors; Semantic supplies maintained
identity access paths, Commerce supplies occurrence versus canonical read boundaries.

| Stage                                   | Evidence                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| specification validated red             | Existing assertions present; measured red not recorded; complete4096-original matrix not frozen. |
| native driver registered                | Existing HTTP slices registered; large-group cross-surface binding missing.                      |
| implementation exposed                  | Cursor/generation seams exist; complete native epoch traversal not established.                  |
| user-case native pass at named revision | None recorded for this capability.                                                               |
| promoted                                | No main closure evidence.                                                                        |

## global-rating-order

**User job:** sort by Content's safe Global standard-question score with correct threshold/prior, zero/null, ties,
order, cursor, epoch and generation behavior. **Personas:** all common personas and independent real voters;
private Realm producer adds private-rating-isolation only. **Released fixtures:** reuse actual native voter builder,
21 legal subjects, five independent voters, threshold5, genuine50/100-answer prior changes; new extreme private
Realm population belongs to Content, not seeded public score rows.

| Surface                  | Required consumer result                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| CATALOGUE                | Real vote→default worker→public figures→index→HTTP ordering; no population/question override and no public total.              |
| CURATED                  | Same admitted rating order over eligible canonical Collection members; editor occurrences retain their own ordering.           |
| EVERYTHING WITHOUT STATE | Same public rating order over Alice support, including no-state subjects; private facts do not affect public scores.           |
| OWN STATE                | Same rating consumer intersect Alice accepted state; no private Realm score substitution.                                      |
| MOUNTED ZONE             | Same order over eligible canonical union with current rating/subject disclosure.                                               |
| configured TYPELIST      | Same default Global score population/order; composed subject cards identify honest population and insufficient/updating state. |

**Frozen scenarios and binding:** RETAIN [native rating outcomes](../../services/kernel/test/search/native-rating-outcomes.test.ts),
“real native votes publish Global scores through the default worker, relay and Search with current disclosure”
(one declared case). It covers actual votes, threshold fall5→4→0 while paused, prior growth/end, zero ahead of null,
name/id ties, order, old cursor epoch/generation409, tamper, hide/takedown, override rejection and the suspended
pre-suspension bearer 401.
RETAIN four [rating API outcomes](../../services/kernel/test/search/rating-api-outcomes.test.ts):
“Global rating null ties page by normalized name then id for anonymous and editor; suspended fails”; “Real signed
rating cursors bind the entire request and principal and reject a reconciled generation change”; “Current hide and
takedown suppress stale rating hits and refill pages with Search paused”; “Ordinary Global rating search rejects
population and question body overrides as unknown fields”. Do not replace these with another fake-positive/null-tie suite.

**Native wrapper/command:** native rating uses createDriverClient/nativeVoter/nativeVote; rating API uses SearchDriver;
`bun run --cwd services/kernel check test/search/native-rating-outcomes.test.ts test/search/rating-api-outcomes.test.ts`.
Actual [route](../../services/kernel/src/search/http/routes.ts) sort union still lacks rating and requires total:
exposure gap, not absence of native acceptance. Internal unique-disclosed accounting/engine budgets are separate
from wire omission. New private-rating-isolation: REQUIRED NOT YET FROZEN/BOUND; existing controls reject private
inputs rather than produce an extreme private Realm. Reuse Global suite; Content adds genuine private producer,
Search public consumer. Other surfaces remain required binding gaps.

| Stage                                   | Evidence                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| specification validated red             | Native assertions present; measured red not recorded; private producer job not frozen.        |
| native driver registered                | Native Global producer and API consumers registered; private Realm producer missing.          |
| implementation exposed                  | Public sort admission and no-total transport incomplete; do not infer pass from registration. |
| user-case native pass at named revision | None recorded for this capability.                                                            |
| promoted                                | No main closure evidence.                                                                     |

## typeahead-and-invalid-requests

**User job:** get bounded public suggestions and typed failures for closed text syntax, strict filters,
unsupported422, unavailable503 and cursor restart409. **Personas:** all common personas; editor sees public source
projection; no private owner-specific suggestions. **Released fixtures:** original multilingual names/aliases,
public/hidden/taken-down controls, request budget boundaries and opaque cursors.

| Surface                  | Required consumer result                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Actual suggest q≤64 code points, limit1–10, public disclosure; closed text/filter admission and typed failures.                                   |
| CURATED                  | Shared generic list request admission remains required; a Collection search box consumes public suggest, with no separate private suggestion API. |
| EVERYTHING WITHOUT STATE | Shared owner list filters/cursors remain required; typeahead supplies public subjects only, never Alice labels/history.                           |
| OWN STATE                | Same public suggest boundary; owner predicate admission belongs to Commerce, not a hidden suggest parameter.                                      |
| MOUNTED ZONE             | Shared union list admission remains required; mounted SearchBox uses public suggest without inheriting source grants.                             |
| configured TYPELIST      | Shared list filters/order/cursor validation plus public SearchBox consumer; no separate members API for typeahead itself.                         |

**Frozen scenarios and binding:** reuse original typeahead, text admission, filter admission, unavailable and rebuild
scenario titles in the ledger, plus source privacy originals. Search public service and HTTP admission must agree;
400 malformed envelope and422 unsupported plan are distinct. Valid suspended403 conflicts with original frozen401;
Accounts/Search own reconciliation, not a weaker duplicate. Delegated/unscoped/revoked fixture coverage remains
REQUIRED NOT YET FROZEN/BOUND where the existing driver cannot express it.

**Native wrapper/command:** SearchDriver via Search wrapper;
`bun run --cwd services/kernel check test/search/outcomes.test.ts`.
No new suggest suite is needed for already frozen prefixes/operators/budgets; extend only missing persona/source
outcomes after owner adoption. Shared consumer acceptance is catalogue-jobs and composition-and-profile-governance.

| Stage                                   | Evidence                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| specification validated red             | Original assertions present; measured red not recorded; persona reconciliation remains.   |
| native driver registered                | Original Search wrapper registered; expanded personas unbound.                            |
| implementation exposed                  | Public suggest/search mounted; full current persona and cross-surface admission unproven. |
| user-case native pass at named revision | None recorded for this capability.                                                        |
| promoted                                | No main closure evidence.                                                                 |

## index-and-default-runtime

**User job:** operate documented OpenSearch/ICU analysis and observe converged public HTTP after real source events,
outage/recovery and safe rebuild. **Personas:** operator, editor/acceptor and all common read personas.
**Released fixtures:** original Chinese/Kana/Latin cases, real Semantic source keys/routeKey, source chunks256 EACH
including tails, exact source snapshot versions, checkpoints and actual physical indices.

| Surface                  | Required consumer result                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CATALOGUE                | Default registrations actually start Semantic/Search; real source events and rebuild become searchable.                                    |
| CURATED                  | Shared runtime feeds catalogue facts and public listing sources used by canonical members; consumer proof remains catalogue-jobs.          |
| EVERYTHING WITHOUT STATE | Public catalogue dependency uses runtime; private owner facts stay PostgreSQL. Shared owner consumer proof remains freshness-and-recovery. |
| OWN STATE                | Same dependency boundary, with owner next-read authority independent of index lag.                                                         |
| MOUNTED ZONE             | Real union/page consumer observes runtime recovery and source restrictions; Zone CRUD alone is insufficient.                               |
| configured TYPELIST      | Real default Search-backed reads inherit analysis/generation/recovery. Infrastructure has no separate per-surface members API.             |

**Frozen scenarios and binding:** originals first three analyzer cases and outage/rebuild ledger entries;
[index definition](../../services/kernel/test/search/index-definition.test.ts) “cjk_bigram_v2 produces the legacy tokens”;
[source batching native](../../services/kernel/test/search/source-batching-native.test.ts) “native event anchors use
exact chunk snapshots through later transport failure and replay”; [bulk visibility](../../services/kernel/test/search/bulk-visibility.test.ts)
“a same-version conflict proves independent winning data searchable before successful return”; [source fences](../../services/kernel/test/search/rebuild-source-fences.test.ts)
“the real rebuild command uses the configured route key for current imported-source fences”; [auto-create](../../services/kernel/test/search/subject-auto-create.test.ts)
“actual native late bulk cannot implicitly recreate a retired subject generation while explicit creation works”.
These native seams are retained, without claiming complete runtime closure.

**Native wrapper/command:** original Search/relation wrappers use
[outcome-driver](../../services/kernel/test/search/outcome-driver.ts)→[driver client](../../services/kernel/test/search/support/driver-client.ts)
→[supervisor](../../services/kernel/test/search/support/outcome-supervisor.ts)→[worker child](../../services/kernel/test/search/support/outcome-worker.ts).
Worker invokes startWorker with decorated full KERNEL_WORK_MODULES, original registrations and observed real starters;
pause/resume captures only Search, rebuild uses real rebuildSubjects/subjectSource and runner refresh. Current
source has progressed beyond [harness README](../../services/kernel/test/search/README.md)'s older captured-starter
status; neither source nor that stale status supplies a native pass.
`bun run --cwd services/kernel check test/search/real-source-composition.test.ts test/search/source-batching-native.test.ts test/search/rebuild-source-fences.test.ts test/search/subject-auto-create.test.ts`.
Operator command is `bun run --cwd services/kernel search rebuild`, documented in
[kernel README](../../services/kernel/README.md), plus actual public search/suggest evidence; no rebuild HTTP route.

Remaining gaps: complete identified keys/physical UUID/source versions and per-partition replay/reconciliation
before alias, including missing/extra keys (equal counts insufficient); keyed sink results and actual winning
refresh/shard success before checkpoint; competing workers/lost CAS/ambiguous response/crash; late old writes after
actual delete-version pruning; no accidental recreation; default writer normalization and real outage/recovery.
The separate64-envelope batch remains. Superseded coverage certificates and coverage/coverage-projection exports
that throw index_not_ready do not bind the replacement. Reuse real-source composition rather than helper-only completion.

| Stage                                   | Evidence                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| specification validated red             | Native assertions present; measured red not recorded; complete pruning/reconciliation matrix not frozen/bound. |
| native driver registered                | Real default-worker source chain registered; missing scenarios require binding to it.                          |
| implementation exposed                  | Worker and operator CLI exist; complete producer/generation guarantees unproven.                               |
| user-case native pass at named revision | None recorded for this capability.                                                                             |
| promoted                                | No main closure evidence.                                                                                      |

## composition-and-profile-governance

**User job:** publish safe immutable profiles with explicit grants/CAS, resolve every released vertical, and read
pages with standalone authority, at most16 distinct descriptors/128 output slots and bounded joined sessions.
**Personas:** anonymous/editor/curator plus all common personas. **Released fixtures:** bundled release/platform
profile; Book/Recipe/visual novel/anime/manga/game/series/character/agent configurations, two immutable profiles,
malicious input and shared public sources. Synthetic Book-with-author alone is not all-vertical proof.

| Surface                  | Required consumer result                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| CATALOGUE                | Registry plans public reads with standalone Search authority.                                                                  |
| CURATED                  | Configured Collection consumers use common members and source grants; no aggregate-specific permission.                        |
| EVERYTHING WITHOUT STATE | Private hydration for Alice separated from public composition; owner support independent of entry/state.                       |
| OWN STATE                | Current owner reads and joined-session bounds; no private state in anonymous page/cache/JSON-LD.                               |
| MOUNTED ZONE             | Routed common composition and mount reads obey same registry/admission/authority; starter data is not runtime proof.           |
| configured TYPELIST      | Every released vertical has a real admitted list and resolved route/type/base/generic fallback; actual HTTP consumer required. |

**Frozen scenarios and binding:** all six original pages titles in the ledger. Preserve registry limits64KiB,
256 nodes, depth8,16 reads/128 slots; profile1MiB/128 templates; executable HTML/script/links rejected with pointers.
[presentation reads](../../services/kernel/test/presentation/reads.test.ts) “each read runs through its standalone
route with only the caller's credentials”, “session tokens from every read are merged with the caller's”, and
“a page holds at most sixteen valid reads, runs at most four at a time and dispatches identical reads once” are
helper-dispatch evidence (fakeKernel), not native composed cost. Joined session work remains bounded by16×32 components.

**Native wrapper/command:** [pages wrapper](../../services/kernel/test/presentation/outcomes.test.ts)→
[pages driver](../../services/kernel/test/presentation/outcome-driver.ts)→real Semantic fixture; PAGES_DRIVER sets
createPagesDriver. `bun run --cwd services/kernel check test/presentation/outcomes.test.ts`.
Actual [Workers host tests](../../apps/web/tests/pages-workers.host.test.ts) separately declare “the real Workers SSR
path renders the Puck composition before client JavaScript” and “Workers HTML and JSON-LD use the same aggregate
public subject representation”. These are real served HTTP renderer evidence with recorded upstream fixture, not
all-type native producer proof. [JSON-LD serializer tests](../../apps/web/tests/pages-jsonld.test.ts) alone are helper
proof. Web owns publication command/evidence; none run/claimed here. Bind released verticals and native upstream
composition before closing; keep Puck render and aggregate-derived JSON-LD evidence separate.

| Stage                                   | Evidence                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| specification validated red             | Six original assertions present; measured red not recorded; all-vertical/native cost expansion not frozen. |
| native driver registered                | Six-case native pages wrapper registered; Workers publication tests separately present.                    |
| implementation exposed                  | Profile publish/activation/page read and Workers renderer exist; full consumer matrix incomplete.          |
| user-case native pass at named revision | None recorded for this capability, including publication.                                                  |
| promoted                                | No main closure evidence.                                                                                  |

## subject-context-and-traversal

**User job:** read Global/Realm selected subject facts and rating/review population, traverse every relation/edition/
credit/claim continuation and public metadata. **Personas:** all common personas, Realm member/outsider and acceptor.
**Released fixtures:** differing Global/Realm facts, unpublished fallback, private/unpublished rating populations,
globally resolved agents, more than a preview of editions/credits/claims with qualifiers/spoilers/provenance.

| Surface                  | Required consumer result                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| CATALOGUE                | Public discovery remains Global; subject factual projection exposes only eligible metadata and traversal links.                                |
| CURATED                  | Members open current subject/detail views without borrowing curator's Realm rights.                                                            |
| EVERYTHING WITHOUT STATE | Personal hydration stays Alice-only while public facts/traversal retain source context.                                                        |
| OWN STATE                | State/rating hydration distinct from public/Realm population and disclosed facts.                                                              |
| MOUNTED ZONE             | Realm-routed subject context/population and unpublished fallback require adopted Source/presentation boundary; agents always resolve globally. |
| configured TYPELIST      | Lists link to factual detail/continued views; no arbitrary filtering of a detail object. Composed context/read continuation remains required.  |

**Frozen scenarios and binding:** original pages public/hidden cases; [context relations](../../services/kernel/test/semantic/context-relations.test.ts)
“a community Context's relation pages show its accepted, replaced and suppressed relations over Global's”;
[uncapped relations](../../services/kernel/test/semantic/relations-uncapped.test.ts) “A forward relation page orders,
filters, counts and continues across all relations”; [subject-page HTTP](../../services/kernel/test/semantic/subject-page-http.test.ts)
“independent real HTTP traversal needs only native store and source primitive”. They prove separate boundaries,
not the full composed credit/claim/publication journey. Source/presentation participation in realm-subject-context,
subject-rating-context and subject-traversal is REQUIRED NOT YET FROZEN/BOUND as a complete job.

**Native wrapper/command:** pages driver plus existing Semantic native files;
`bun run --cwd services/kernel check test/presentation/outcomes.test.ts test/semantic/context-relations.test.ts test/semantic/relations-uncapped.test.ts test/semantic/subject-page-http.test.ts`.
[Actual pages target](../../services/kernel/src/presentation/http/pages.ts) admits subject/route/account and view,
not a Realm context-bearing schema. Research example context and plural Zone route spellings are proposals, not
mounted endpoints; Semantic/Content/Search/Web must adopt the concrete boundary first. Existing standalone relation
routes/native pagination are retained. Web separately owes served HTML/redirect/canonical/metadata for every launch
vertical and agent kind, instructions/diet/cookTime25→PT25M and cache-safe public JSON-LD. No serializer or kernel
response closes publication, and no native context schema is invented here.

| Stage                                   | Evidence                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| specification validated red             | Existing separate route assertions present; composed context/claim journey not frozen.    |
| native driver registered                | Pages and Semantic route slices registered; complete context/publication binding missing. |
| implementation exposed                  | Standalone relations/views exist; Realm-context aggregate schema pending owner adoption.  |
| user-case native pass at named revision | None recorded for this capability or its publication stage.                               |
| promoted                                | No main closure evidence.                                                                 |

## composed-cost-and-progress

**User job:** receive useful bounded direct/prepared lists and a common16/128 page as populations, depth and privacy
traffic grow. **Personas:** all common personas, including denied/empty paths. **Released fixtures:** shared native
records/pins,64/512/4096 scales, independent population/matches/sparse/history/owner pools/aliases/depth/privacy
arrival axes; actual4096 originals at largest scale. Old1000/10000/100000 report example yields to current budgets.

| Surface                  | Required consumer result                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| CATALOGUE                | Search owns direct catalogue and prepared-public native HTTP/growth, first/deep/sparse/final pages.                |
| CURATED                  | Common canonical member plans with growing duplicates/history and all owner pools counted.                         |
| EVERYTHING WITHOUT STATE | Commerce direct-owner/prepared-owner captures grow labels/holdings/sessions independently; no entry prerequisite.  |
| OWN STATE                | Same owner plans with growing state/completion history, current writes and bounded preparation.                    |
| MOUNTED ZONE             | Semantic owns actual composed readPage consumer,16 distinct reads/128 slots across eligible sources.               |
| configured TYPELIST      | Actual aggregate execution shares fixed work, disclosure and summaries; helper descriptor counts are insufficient. |

**Frozen scenarios and binding:** [dynamic outcomes](../../specs/dynamic-collections-outcomes.test.ts) “first and deep
native pages stay bounded with sparse catalog filters and hidden candidates at three scales” is retained but not
an established native factory. Existing [growth query](../../services/kernel/test/search/growth-query.test.ts),
[growth rating](../../services/kernel/test/search/growth-rating-query.test.ts) and
[growth pages](../../services/kernel/test/presentation/growth-pages.test.ts) are slice evidence, not complete
current filtered-list plans. Full native composed-cost-and-progress matrix: REQUIRED NOT YET FROZEN/BOUND.

**Native wrapper/command:** no complete capability wrapper/factory/command registered. Existing slice command:
`bun run --cwd services/kernel check test/search/growth-query.test.ts test/search/growth-rating-query.test.ts test/presentation/growth-pages.test.ts`.
Performance owns harness/budgets; Search public plans, Commerce owner plans, Semantic Zone composed consumer.
A missing-factory sample or old256-proof check is not growth evidence.

Capture actual engine iterator next_doc_count+advance_count across tree/shards, candidates/discards/lookahead,
Access/dependency points, examined/removed rows, blocks, bytes, statements and connections in every backend pool.
[Current budgets](../filtered-lists.md#budgets) apply without slack: direct c≤min(600,6s+3),≤3 refill
rounds,≤6 engine searches/3 owner seeks per read; prepared c≤2s+2 and≤2 index reads. Common16/128 all-direct page
ceilings816 candidates,6784 points,14080 examined rows,72 statements per backend,96 engine searches,one connection
per backend. Share query privacy observation,≤2 statements and64+2×(behind+changed homes) examined rows; logical
all4096-home coverage cannot hide a full-head scan. Preparation steps≤1000 inputs/writes,one frontier write,
≤16 statements/4 engine searches/one connection per backend,≤4MiB response; retain finite progress and reread at
most one interrupted step. Grow privacy arrival rate with actual repair/ACK latency; served share must not fall
between scales. Permanent preparing, small output hiding unbounded engine work and sparse empty-success chains fail.

| Stage                                   | Evidence                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| specification validated red             | Native plan/budget matrix REQUIRED NOT YET FROZEN; existing slice assertions are not its red receipt. |
| native driver registered                | Slice suites present; complete native factory/HTTP/growth binding missing.                            |
| implementation exposed                  | Full admitted direct/prepared/composed plans and captures not established.                            |
| user-case native pass at named revision | None recorded for this capability.                                                                    |
| promoted                                | No main closure evidence.                                                                             |

## Original suite ledger

These exact source titles are retained, including superseded words in titles. No title is a claim of current native
pass. The Search and relation wrappers count `^test(` declarations dynamically, require that exact pass count,
zero failures and zero skips/todos; pages does the same. Inspection counts are **13 Search,6 relation,6 pages**.
All three run their untouched specification as a child and return actual product responses through the drivers.

### Search originals

[specs/search-outcomes.test.ts](../../specs/search-outcomes.test.ts): 13 declared scenarios;
[wrapper](../../services/kernel/test/search/outcomes.test.ts), [driver](../../services/kernel/test/search/outcome-driver.ts).
Native command: `bun run --cwd services/kernel check test/search/outcomes.test.ts`.

- Traditional and Simplified Chinese match without matching a different title or an extended phrase
- Kana voicing and width fold with case and full width Latin names
- Aliases and descriptions are searchable but adopted statement values are not free text
- Search is public for editor and anonymous while suspended credentials fail on both routes
- New subjects become searchable and suggestible within fifteen seconds with current as_of
- Statement filters use adopted Global values and positive roots admit bounded negation
- Committed takedown and hiding remove stale hits immediately and refill pages while indexing is paused
- Name paging has exact totals stable ties and request principal and signature bound tokens
- Rebuild invalidates old page tokens and preserves all visible subjects while excluding takedowns
- Typeahead matches word prefixes in Latin Chinese and aliases and rejects invalid query parameters
- Text admission rejects malformed syntax and budgets while all operators produce observable matches
- Filter admission rejects excessive budgets unknown facets and malformed search bodies
- Unavailable index returns retryable problems on both routes while subject reads keep working

### Relation originals

[specs/search-relation-facets.test.ts](../../specs/search-relation-facets.test.ts): 6 declared scenarios;
[wrapper](../../services/kernel/test/search/relation-facet-outcomes.test.ts), [driver](../../services/kernel/test/search/outcome-driver.ts).
Native command: `bun run --cwd services/kernel check test/search/relation-facet-outcomes.test.ts`.

- an adopted author beyond the bounded relation sample matches positive and negated filters
- overflowing author facet counts stay honest lower bounds
- overflow rechecks keep hidden and taken-down source subjects out while indexing is paused
- a declared author relation update refreshes its source subject
- hiding a relation target suppresses positive source hits before the rebuild
- qualified relation facet filters are refused without changing unqualified author semantics

### Pages originals

[specs/pages-outcomes.test.ts](../../specs/pages-outcomes.test.ts): 6 declared scenarios;
[wrapper](../../services/kernel/test/presentation/outcomes.test.ts), [driver](../../services/kernel/test/presentation/outcome-driver.ts).
Native command: `bun run --cwd services/kernel check test/presentation/outcomes.test.ts`.

- anonymous reads a public subject's page in one aggregate read
- an unknown, a hidden and a taken-down subject answer the same not_found
- publishing a profile needs the presentation grant
- activating a profile changes the template a page uses
- a profile with HTML, script or an executable link is refused with pointers
- a route template answers a route target and other routes fall back to generic

## Remaining owner reconciliations and smallest followups

- Semantic/Imports release the missing genuine words, form/Concepts, diet and library bindings, then supply one
  versioned native fixture builder with real release/identity pins. Reuse ordinary contribution/adoption/import
  boundaries and existing reviewed provider fixtures; absent imported words remain unknown. No recipe-site import.
- Commerce adopts owner-query/completion semantics and common members admission, binds existing dynamic/profile/
  label suites, then reuses released records for each explicit surface/job. No shelf-only query path or private
  facts in public facets. Bulk methods that throw are not a bound consumer or performance factory.
- Search/Semantic/Accounts bind narrowed native privacy routing, late barrier/ACK and actual foreign repair to the
  existing real-worker driver, then add only the missing discriminatory six-surface cases. Reuse current native
  source chunks, sink visibility, generation and confidentiality tests before adding equivalent assertions.
- Content adds the genuine extreme private Realm producer for private-rating-isolation and joins subject context
  figures; retain the existing Global vote-to-worker-to-HTTP suite in full. Search admits its existing public sort
  and omits totals, including rating; internal accounting never becomes public totals.
- Search/Commerce/Performance reconcile the frozen dynamic empty-success scenario with useful-page requirements
  through the owning acceptance process. Accounts still owes its native correct-password suspended sign-in
  acceptance receipt; Search's native old-bearer cases are 401 and the kernel verified-suspended 403 remains
  defensive only.
  Search owns reconciliation of original exact-total/lower-bound assertions with current no-public-total transport;
  source contributor accounting remains useful internal evidence. Frozen files stay untouched in this inventory.
- Search/Content/Semantic/Web adopt the context-bearing Source/presentation boundary and connect existing native
  relation/edition/credit APIs to composed continuation, claims/history and public metadata. Retain real Workers
  Puck-render and aggregate-derived JSON-LD HTTP cases separately; extend native released-vertical publication
  evidence rather than count fake upstream serialization as closure.
- Performance binds the missing current plan factories/capture matrix with Search, Commerce and Semantic. Run each
  registered capability at owner integration/promotion, deduplicated by revision, with exact scenario counts and no
  skips/todos. Record specification-red, registration, exposure, named-revision native pass and main promotion
  independently; none of these followups is already complete by this document's formatter acceptance.
