# Whole-row native Search closure proposal

This is an implementation-ready proposal for the remaining known In-row work in the
[Search capability manifest](goals/search.capabilities.md). Cross-owner choices below
are **proposed, pending owner adoption**. This document freezes future scenario
inputs, observations and assertions for that adoption; it does not adopt a second
product authority or establish a specification-red/native-pass receipt.

[Filtered lists](filtered-lists.md) owns meaning, disclosure, useful pages,
identity and numeric ceilings. The manifest owns the closure inventory. The
Semantic [producer contract](../services/kernel/src/semantic/public-filter-source-contract.md)
and Search [consumer contract](../services/kernel/src/search/public-filter-consumer-contract.md)
own the privacy protocol. Their writers, registration, repair, custody and ACK
implementation are consumed here, not reimplemented here.

The deliverable is this document only. No runtime port, fixture export, release,
SQL permission mechanism, native outcome, compiler result or promotion follows
from it. Original tests and frozen files remain unchanged. Native commands below
are handoff commands for post-integration, not commands run for this proposal.

## Adoption boundary and decisions

The proposed unit of completion is a whole observable job, across six surfaces,
using the same released predicates and real authority. It is not one happy-path
route, a descriptor counter, an unavailable-factory verifier or a protocol stub.

Search owns public execution and these acceptance consumers; Commerce owns native
owner plans and common members; Semantic owns released records, Collection/Zone
source integration and identity; Accounts owns credential producers; Content owns
rating populations; Web owns publication; Performance owns capture and budgets.
No new permission, account, deletion, rights or disclosure policy is selected.
Tests invoke existing owner behavior in those risk areas without changing it.

Adopt the following concrete integration choices in the corresponding owner docs
before production implementation. They resolve wiring rather than invent policy:

1. Use one versioned fixture receipt mapping logical records to real created IDs,
   releases, Concepts, profiles and reviewed import records. Consume the producer's
   declaration; do not recalculate its evidence or invent a fixture export.
2. Run catalogue leaves through the shared admitted AST on all six surfaces.
   Owner leaves go only to a viewer-self native owner plan. Public Search rejects
   OwnerLeaf even below NOT, OR or saved expansion, before private IO.
3. Extend configured TypeList admission with the existing shared filter grammar.
   Its proposed optional `filter` intersects its existing `types` restriction;
   no second predicate language, client account selector or Search cursor is added.
4. Use direct plans only with the current candidate and actual engine-work bounds.
   Otherwise use existing durable infrastructure for retained preparation. The
   read cannot hide enumeration in a low-output engine query or an empty page.
5. Give the common executor one execution scope for shared control, privacy and
   summaries work. Standalone HTTP semantics remain authoritative; internal scope
   reuse must retain authentication and every source/subject check.
6. Expose native test controls beside the owning driver, never in public DTOs.
   Controls observe real operations and hold real transport/worker boundaries;
   they cannot set ACK, permission, membership, results or a completed frontier.
7. Keep public Search totals absent, including rating. Existing internal source
   and bucket accounting remains independently tested. The current original
   Search/relation files and deletion outcomes already assert omitted totals;
   trust that landed reconciliation rather than resurrect the manifest's older
   exact-total/lower-bound wording. Preserve every original scenario.
8. Freeze first/deep/sparse/final and crash schedules here, then materialize only
   the missing cases. Reuse existing producer and consumer protocol assertions.

There are no dispatch `after` edges in this proposal. The briefs can be written
and their native assertions bound against owners' declarations concurrently.
Execution checks the required ports at startup and fails honestly if unavailable.
Unlanded producers are implementation prerequisites, not a reason to reduce the
brief, skip a case, invent an export or report native closure.

## Callable boundaries and precise gaps

The following declarations actually exist. A type is not a runtime implementation.

| Surface                      | Existing callable or declared type                                                                                                  | What must still be connected                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Original Search              | `createSearchDriver(): Promise<SearchDriver>` in `test/search/outcome-driver.ts`                                                    | Expanded native personas, released whole-row fixtures and new consumers                                                                   |
| Search supervisor            | `createDriverClient()` in `test/search/support/driver-client.ts`                                                                    | New controls must cross its RPC/supervisor/worker boundary                                                                                |
| Released discovery           | `createReleasedDiscoveryFixture({version: 1})` in `test/support/released-discovery.ts`                                              | Existing books/classification/diet/recipes and real personas; declared personal/source/privacy/profile/platform prerequisites remain open |
| Released import slice        | `DriverClient.importReleasedBook(input)`                                                                                            | Reuse its real import receipt; it is not the complete fixture builder                                                                     |
| Original Pages               | `createPagesDriver(): Promise<PagesDriver>` in `test/presentation/outcome-driver.ts`                                                | Shares Semantic fixture behavior, not Search's isolated worker world                                                                      |
| Structural admission         | `parseFilter`, `admitFilter`, `validateFilter`, `walkFilter` in `@rezics/filter`                                                    | Native public/owner execution, pins and full dependency closure                                                                           |
| Public source                | `PublicFilterSourceFactory` in `src/semantic/public-filter-source-contract.ts`                                                      | Future `publicFilterSource` runtime and default composition                                                                               |
| Public consumer              | `PublicFilterConsumerOperationsFactory` in `src/search/public-filter-consumer-contract.ts`                                          | Future `createPublicFilterConsumerOperations` runtime and HTTP integration                                                                |
| Collection source            | `createCollectionSource({pool, access, clock})` in `src/library/collection-source.ts`                                               | Present implementation throws `dependency_unavailable` for every method                                                                   |
| Native Collection primitives | `readNativeCollectionMetadata`, `authorizeNativeCollectionMetadata`, `readNativeCollectionRawPage`, `probeNativeCollectionOriginal` | Compose canonical source protocol; primitives alone are not a complete source                                                             |
| Preparation provenance       | `readPreparationNativeHeader` in `src/library/preparation-native-reader.ts`                                                         | Validates origin/receipt only; not plan execution or publication authority                                                                |
| Common presentation          | `readPage` in `src/presentation/reads.ts`                                                                                           | Shared native whole-page work and final safety, beyond descriptor dispatch                                                                |
| Static Zone                  | `readStaticZonePage` in `src/zones/page-runtime.ts`                                                                                 | Current source-dependent branch returns readiness, not union execution                                                                    |
| Dynamic fixture contract     | `DynamicCollectionsDriver` in `specs/dynamic-collections-driver.ts`                                                                 | Prospective contract explicitly has no registered production binding                                                                      |
| SQL capture                  | `openGrowthDatabase`, `capture`, `captureMeasuredRun` in `test/support/growth-capture.ts`                                           | Owner pools and child process captures must participate in the same measured operation                                                    |
| Classification               | `costOf`, `catalogStatementBound`, `withoutCatalogTexts` in `test/support/growth-cost.ts`                                           | Reuse classification; do not make a second SQL-cost calculator                                                                            |

Paths in this table are relative to `services/kernel/` unless qualified otherwise.
The two future public-filter exports are named by their existing contracts. No
runtime import of either missing module is added by this document.

The existing `PublicFilterSource` methods are exactly:

```ts
readPublicFilterProjectionPage(request: PublicFilterProjectionRequest): Promise<PublicFilterProjectionPage>;
readPrivacyReductionHeads(request: PrivacyReductionObservationRequest): Promise<PrivacyReductionObservation>;
readPrivacyReductionPage(request: PrivacyReductionLogRequest): Promise<PrivacyReductionLogPage>;
```

`PublicFilterConsumerOperations` declares `capture`, `query`, `repairStep`,
`readStatus`, `closeObservation` and `close`. Capture takes the actual SearchPlan
plus `filterDocument` and parsed `text`, and a `pit` or `prepared` snapshot choice.
Query returns the retained observation, execution locator, retained start, actual
SearchResult and internal cost. `readStatus({queried, execution})` checks that
execution. A caller-provided ACK, Boolean safety evaluator or repaired body is
not part of this port.

The proposed acceptance-side additions below are **names for owner adoption**, not
existing imports, exports or public endpoints:

```ts
// Proposed fixture additions; illustrative declarations, not an executable module.
type WholeRowSurface = 'catalogue' | 'curated' | 'everything' | 'own-state' | 'mounted-zone' | 'configured-typelist';

type WholeRowObservation = {
  response: HttpResponse; // actual status, Headers and parsed body
  captures: ReadonlyMap<string, Capture>; // actual database identity -> raw capture
  work: NativeWork; // existing specs/dynamic-collections-driver.ts native evidence shape
  internalCost: PublicFilterCost; // actual execution counters, never a public field
};

// Proposed fixture-owned operations, implemented beside existing native drivers.
// Inputs contain actual producer receipts, not client-chosen permission evidence.
interface WholeRowFixtureControls {
  run(surface: WholeRowSurface, request: unknown, persona: string): Promise<WholeRowObservation>;
  hold(boundary: string): Promise<{ entered: Promise<void>; release(): void }>;
  restartOwnedWorker(): Promise<void>;
  readRetainedProgress(): Promise<unknown>;
}
```

Do not implement this interface as an alternative backend. `run` must record an
ordinary owner HTTP operation; `hold` pauses the named real boundary and cannot
fabricate its completion. The implementation brief must replace `unknown` and
`string` with its owners' existing concrete types when adopting these test-only
controls. Their signatures deliberately make no claim about an unlanded factory.

## Shared fixture and request map

The [released fixture requirements](goals/search.capabilities.md#released-fixture-definitions-and-logical-records)
remain authoritative. Reuse the landed version-1
[ReleasedDiscoveryFixture](../services/kernel/test/support/released-discovery.ts):
`books()`, `classification()`, `diet()`, `recipes()` and `filters(c,d)` already
create native records and return actual identities. Its declared `personal`,
`sources`, `privacy`, `profiles`, `platform`, `completedCooking` and character
measurement prerequisites remain explicit gaps. Do not classify this real builder
as absent or claim those prerequisites are implemented. Extend its existing
receipt for a second immutable release, owner support and reviewed import records;
Commerce supplies accepted pins. Its controlled assertions are not import proof.
Below, uppercase symbols are receipt lookups, not literal exported IDs or CURIEs.
The test resolves them once from the native producer receipt before constructing
an actual request. No title matching or test-only invented Concept qualifies.

Proposed additive receipt map, for producer adoption beside the existing
`release`, `meaning`, `personas` and group receipts (not a replacement builder):

| Receipt field                                            | Actual value required                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `releases.first`, `releases.second`                      | Immutable real release bodies and producer-declared digest/pin               |
| `properties.words`, `properties.form`, `properties.diet` | Released property identities and datatype/unit declarations                  |
| `concepts.ln`, `concepts.harem`, `concepts.vegetarian`   | Actual adopted public Concept IDs, scheme and labels                         |
| `profiles.recipe`                                        | Actual profile, state-set, state, cooking-session and holding pins           |
| `subjects`                                               | Logical-name to created routed UUID map                                      |
| `sources`                                                | Created public/unlisted/private Collections, mounts and scope configurations |
| `imports`                                                | Reviewed source records, exact native selected candidates and attribution    |
| `personas`                                               | Native local handles to distinct accounts/tokens, never SQL authority rows   |
| `dependencies`                                           | Actual original/terminal, tuple/target/consent links used by race controls   |

### Catalogue records

| Logical record | Released facts                                                                                       | Discriminator                                       |
| -------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| B-long         | Book, LN, HAREM, words 1,200,001                                                                     | Matches all three Book jobs                         |
| B-edge         | Book, LN, HAREM, words 1,000,000                                                                     | Exact threshold excluded from long words            |
| B-short        | Book, LN, no HAREM, words 999,999                                                                    | Negative HAREM known, below threshold               |
| B-unknown      | Book, HAREM, unknown form, absent/somevalue words variants                                           | Unknown cannot become positive or negative evidence |
| B-characters   | Book, LN, HAREM, no words; separate character property 1,400,000 is a declared producer prerequisite | Characters do not supply words                      |
| B-tag-only     | Book, different known form, HAREM                                                                    | Tag alone does not imply LN                         |
| B-form-only    | Book, LN, known no HAREM                                                                             | Form alone does not imply tag                       |
| B-edition      | Edition with page-count control                                                                      | Pages and editions do not become work words         |

Use separate B-unknown variants for missing and somevalue so neither is hidden by
one other predicate. Add a withheld selected candidate in the privacy fixture;
withheld is not known absence. Each record has stable native labels chosen to make
name ordering distinguishable from IDs and source occurrence order.

### Recipe and release records

| Logical record | Actual facts and owner history                          | Expected quick/not-cooked job |
| -------------- | ------------------------------------------------------- | ----------------------------- |
| R-quick        | Vegetarian, cookTime 25 minutes, Alice support          | Included                      |
| R-edge         | Vegetarian, cookTime 30 minutes, Alice support          | Included                      |
| R-slow         | Vegetarian, cookTime 31 minutes                         | Excluded                      |
| R-meat         | Known nonvegetarian, 20 minutes                         | Excluded                      |
| R-unknown      | Unknown diet, 20 minutes                                | Excluded                      |
| R-cooked       | Vegetarian, 20 minutes, Alice completed cooking session | Excluded for Alice            |
| R-other-cooked | Vegetarian, 20 minutes, Bob completed, Alice support    | Included for Alice            |
| R-time-unknown | Vegetarian, unknown cookTime, Alice support             | Excluded                      |

Represent `schema:cookTime` using the actual fixture integer-minute unit
`http://www.wikidata.org/entity/Q7727` (`meaning.minuteStorage`/`minuteFilter`),
not an invented compact wire spelling.
No ingredient/text heuristic supplies diet. Clearing Alice's live entry state
leaves her completed cooking history and still excludes R-cooked. Bob's history
never excludes R-other-cooked from Alice's query.

A release fixture has distinct Switch/Japanese and PC/English release statements,
with dates and actual work/release identities. The same source statement must
satisfy both qualifiers. Switch+Japanese matches; Switch+English does not. Seed
compact and expanded representations with the same meaning and separate missing,
unknown, withheld and incompatible-unit controls. Do not combine work-level
platform aggregates into a release tuple.

### Private support and canonical records

Alice has state-only, label-only, active-session-only, completed-history-only and
holding-only records, plus overlapping support. Seed an empty entry shell and a
follow-only subject as exclusions from Everything support. Everything without
state must return the supported records without creating a state or entry.

Bob has independent state, labels, sessions and holdings on overlapping subjects.
Accepted historical pins continue to mean the first release after the second
renames/retires choices. Current type or profile changes cannot reinterpret them.

For canonical browsing, use originals `[a,c,z]` with `a -> z`; native canonical
order is `[c,z]`. Curated occurrence editing still exposes the two original
occurrences with their original IDs, notes and ordinals. Add an original denied
while its terminal is readable, and a readable original with denied terminal.
Neither may leak through canonical browsing. Add a terminal handoff concurrent
with a source read and independently grow one real group to 4,096 originals.

### Predicate inputs and exact membership oracles

These are actual grammar shapes. Bind WORDS, FORM, LN, HAREM, DIET, VEGETARIAN and
profile symbols from the receipt, then send the resulting ordinary JSON objects.
The range grammar has inclusive bounds; the released nonnegative integer words
contract makes `gte: 1000001` the exact expression for greater than one million.

```ts
const books = { type: { in: ['schema:Book'] } };
const ln = { statement: { property: FORM, in: [LN] } };
const harem = { statement: { property: 'schema:keywords', in: [HAREM] } };
const longWords = {
  statement: { property: WORDS, range: { gte: 1000001, unit: '1' } },
};
const bookJobs = {
  lnHarem: { and: [books, ln, harem] },
  longWords: { and: [books, longWords] },
  combined: { and: [books, ln, harem, longWords] },
};
const quickVegetarian = {
  and: [
    { type: { in: ['schema:Recipe'] } },
    { statement: { property: DIET, in: [VEGETARIAN] } },
    { statement: { property: 'schema:cookTime', range: { lte: 30, unit: 'http://www.wikidata.org/entity/Q7727' } } },
  ],
};
const notMyCompletedCooking = {
  not: { owner: { session: { profileId: RECIPE_PROFILE, lifecycle: 'completed' } } },
};
const ownerRecipeJob = { and: [quickVegetarian, notMyCompletedCooking] };
```

The actual fixture uses `wdt:P7937` for form, `schema:keywords` for HAREM,
`schema:wordCount` for words and `schema:suitableForDiet` for diet. Prefer its
`filters(c,d)` output directly; the expanded examples show the resulting shapes.
Do not change the released mapping or treat a controlled Bangumi assertion as an
executed import. Measurement-association grammar remains its separately declared
prerequisite; this plan does not reopen that deferred specification work.
The frozen expected sets are semantic logical sets resolved to actual IDs:

| Job                                         | Expected readable canonical IDs in the complete base fixture |
| ------------------------------------------- | ------------------------------------------------------------ |
| LN and HAREM                                | B-long, B-edge, B-characters                                 |
| Words > 1,000,000                           | B-long                                                       |
| LN and HAREM and long words                 | B-long                                                       |
| Quick vegetarian catalogue                  | R-quick, R-edge, R-cooked, R-other-cooked                    |
| Alice quick vegetarian not completed        | R-quick, R-edge, R-other-cooked                              |
| Known NOT HAREM within Book root            | B-short, B-form-only; unknown/withheld evidence never passes |
| Own NOT state X within supported population | Supported subjects without live X, including no entry        |
| Switch with Japanese on one release         | Switch/Japanese release only                                 |
| Switch with English on one release          | Empty, with genuine exhaustion                               |

If additional support fixtures qualify for a job, isolate them into a different
fixture population instead of silently weakening exact membership assertions.
Catalogue unknown controls stay within the same Book/Recipe type root.

## Native credentials and source visibility

Keep the original Search anonymous/editor/acceptor/suspended and Pages
anonymous/editor/curator/suspended factories intact. Add distinct fixture-local
owner Alice, other owner Bob, delegated actor, unscoped actor and revoked bearer.
The landed released-discovery fixture already supplies Alice, Bob, outsider and
unscoped native accounts, `scoped(alice|bob, scopes)`, and explicit
`setup.openFeatures`, `spaceCreation` and `realmCreation` native controls. Reuse
those, plus Semantic `fixtures.person`, native grants and ordinary token flow;
neither original Search/Pages driver exposes the complete union yet. Add genuine
delegation and revocation controls without replacing those native identities.

| Persona              | Fixture construction                                | Frozen assertion                                                                                                                                          |
| -------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous            | No Authorization header or account session          | Public facts only; private/unlisted source discovery follows owner rules                                                                                  |
| Editor               | Existing actual editor bearer                       | Same public Search membership as anonymous; no private authority borrowing                                                                                |
| Alice                | Distinct active owner and ordinary bearer           | Her admitted facts/pins only; next-read visibility after her writes                                                                                       |
| Bob                  | Distinct other owner and ordinary bearer            | Cannot read Alice's owner facts or reuse her cursor                                                                                                       |
| Delegated            | Actual native delegation/consent and scoped token   | Only admitted self-context; withdrawal invalidates continuation                                                                                           |
| Unscoped             | Actual scoped Alice/Bob or unscoped fixture bearer  | Existing library control: `403 forbidden`; preserve native `insufficient_scope` where that owner route declares it; no owner read/cache/preparation write |
| Suspended old bearer | Issue while active, then real suspension            | `401 invalid_credentials`, exact Bearer invalid_token challenge                                                                                           |
| Revoked              | Issue active token, then ordinary native revocation | Separate `401 invalid_credentials` control; never anonymous fallback                                                                                      |

No valid suspended bearer is requested. Accounts' correct-password suspended
sign-in must separately return `403 ACCOUNT_SUSPENDED` with no session, while
wrong password remains 401. Consume Accounts' eventual native receipt; do not
claim it from kernel defensive `403 account_suspended` or mint a synthetic token.

Source visibility is crossed with every surface that owns a source:
public, unlisted and private Collection; readable and denied mount; public Zone
with independently private source. Addressing an unlisted source is distinct from
public discovery. Grant/revoke only through actual native APIs. Zone/Collection
read grants never grant source facts, subjects, foreign targets or owner families.
Ban/suspension precedence is exercised through owner ports, not redefined here.

### Cost

- Touches: native account/source fixture commands and current source admissions;
  no SQL-written grants or permission results and no public index of private facts.
- Bound: setup is outside a measured page but recorded as setup, never attributed
  to zero-cost execution; each measured denied/read path uses the same one-read
  12-statement, one-connection and actual-candidate ceilings below, with no denial exemption.
- Growth check: grow unrelated owners and grants at 64/512/4,096 while fixing the
  requested source; denied, empty and successful paths all retain full capture.

## Brief: cross-surface predicates and full native call closure

Implement the missing shared consumers and adoption-ready fixtures together.
Do not fork a library-only matcher or manufacture results in an outcome driver.
The owner [query contract](library-owner-queries.md),
[Collection source](collection-source.md),
[Zone membership](zone-membership.md) and shared filter package retain meaning.

### Six surface bindings

| Surface                  | Actual request boundary                                     | Required native execution                                                          |
| ------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Catalogue                | `POST /v1/subjects:search`                                  | Shared admitted public AST, direct catalogue/prepared public plan                  |
| Curated                  | `GET /v1/collections/{id}/members`                          | Existing occurrence route plus proposed shared filtered canonical browse admission |
| Everything without state | Same members route for Alice's Everything                   | Actual owner population and public catalogue predicates, no state prerequisite     |
| Own state                | Same members route for Alice's accepted state Collection    | Accepted state identity plus the same catalogue AST and optional owner leaves      |
| Mounted Zone             | `POST /v1/zones/{id}:readPage`                              | Eligible native scope/mount union, shared whole-page executor                      |
| Configured TypeList      | Published profile/Zone document read through page aggregate | Shared Search descriptor from configured filter, same release and privacy scope    |

Current members admission is not claimed to accept the full owner query. Proposed
wire adoption: add `filter` as one URL-encoded JSON FilterDocument on the existing
members GET, parsed once through `parseFilter`; use existing limit/cursor/display
parameters unchanged. No body-selected account or pin. Commerce must adopt this
additive admission in its route/schema/client definitions before native binding.
Malformed JSON is 400; structurally valid but unsupported public owner operands
are 422; missing current scope is 403 with the owner route's existing problem
code, without normalization. Do not reinterpret a 422 for a required
released catalogue job as successful rejection.

For TypeList, the current registry takes `types`, `sort` (`name` or `collections`)
and `limit` (1..24), and emits a type-only Search descriptor. Proposal: optional `filter`
uses the same PageFilter/FilterDocument schema, validated at publication and read.
Generated descriptor filter is `and(type(types), configured filter)`, admitted
with the same immutable release. No raw SQL, `rating` widening or private owner
leaf is added to a public TypeList. Public recipe job uses quickVegetarian;
ownerRecipeJob is exercised only where the owner-context consumer is admitted.

Example actual Search request after symbol resolution:

```ts
await searchDriver.request('anonymous', 'POST', '/v1/subjects:search', {
  filter: bookJobs.combined,
  sort: 'name',
  limit: 2,
  languages: ['en'],
  properties: [WORDS],
});
```

Expect raw 200 with the route's closed `{subjects, next, as_of}` envelope,
B-long's actual canonical ID only, `next: null` after real exhaustion, real summary
and Global figure per the current schema, and only requested currently public
facts. No total, exact/lower-bound count, owner operand, private label, repair
locator or cost object is added. Compare field schema and values against the
actual native subject/public figure receipts, not a driver-manufactured DTO.

Example proposed filtered members call, retaining its owner envelope:

```ts
const query = new URLSearchParams({
  filter: JSON.stringify(bookJobs.lnHarem),
  limit: '2',
});
const path = `/v1/collections/${CURATED_ID}/members?${query}`;
// Send as the actual native Alice/anonymous identity in the extended owner driver.
```

Curated source is provisioned with the same records, duplicate occurrences and
nonmatching controls. Browsing returns canonical members, while occurrence editing
retains IDs/notes/multiplicity. Everything and own-state resolve their existing
native opaque Collection IDs; tests cannot encode profile/state keys into guessed
public IDs. Preserve the owner's `{members, next, ...}` schema rather than wrap
all surfaces in a new common list DTO.

Example proposed configured component, published through the ordinary profile API:

```ts
{
  type: 'TypeList',
  props: {
    id: 'long-light-novels',
    title: { en: 'Long light novels' },
    types: ['schema:Book'],
    filter: bookJobs.combined,
    sort: 'name',
    limit: 2,
  },
}
```

This is a proposed registry extension, not currently valid configuration. Before
publication, readers must not receive a staged profile DTO or use an unpublished
configuration as their release. Publish/activate via existing grants; then read
through the real aggregate. The public page uses its existing common document,
profile/template and per-read status/body fields. Web renders only that published
aggregate's current public bodies, including JSON-LD.

### State transitions and failures

Admission freezes release, expanded AST, source identity, order, languages and
requested fields into the owner plan. Saved expansion is one level and obeys
32 leaves/depth 4/16 OR alternatives; NOT dependencies are retained. Validate
before descriptor deduplication or plan-cache writes. Failed admission has no
preparation, native enumeration, private IO or accepted receipt side effect.

A direct plan either returns a full page or proves exhaustion. Exhaustion includes
rejected/lookahead and complete indexed negative coverage. If the bound cannot
establish either, retain admitted preparation rather than return short/empty 200.
Prepared membership is not saved authority: source/viewer/original/terminal and
query safety are checked again immediately before disclosure.

A change of release meaning, source eligibility, owner revision, identity basis or
required privacy dependency invalidates the affected build/cursor according to
its existing transport. Never use the latest release to reinterpret an accepted
historical pin. A new build may replace a stale building generation; it must not
publish partially rebuilt rows or resurrect a prior unsafe result.

### Frozen predicate scenarios

Materialize these titles in proposed `test/search/whole-row-predicates.test.ts`.
The file is future native acceptance, not created as a broken import by this plan.
Each title expands over the six surface cells and all applicable persona/source
combinations from the map, with an explicit assertion for denied combinations.

| Frozen title                                                                     | Arrange and act                                                               | Required observation                                                                      |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Released LN and HAREM have identical meaning across six native surfaces          | Provision base books, publish sources/configuration, execute lnHarem          | Exact three-ID set in native order; no unknown/form/tag-only substitution                 |
| Genuine integer words exclude threshold unknown characters and edition controls  | Execute longWords then combined on every surface                              | Exact B-long; boundary one million excluded; same unit and pin                            |
| Quick vegetarian and own completed cooking use separate public and owner meaning | Execute catalogue quickVegetarian everywhere; ownerRecipeJob in owner context | Four public matches; Alice three; Bob history isolated                                    |
| Same-statement release qualifiers agree in compact and expanded storage          | Execute Switch/Japanese and crossed Switch/English                            | Correct tuple matches; crossed tuple genuinely exhausted                                  |
| Everything supports no-state facts without inventing entries                     | Read after label/session/history/holding writes and clear state               | Supported no-entry rows included; empty shell/follow-only excluded                        |
| Accepted first-release pins survive second-release rename and retirement         | Pin facts under first, activate second, read same owner query                 | Historical meaning stable; writes follow current owner rules                              |
| Public editors never lend private authority to source filters                    | Same query as anonymous/editor across source visibilities                     | Identical public fact membership; authorized private source remains independently checked |
| Original and terminal checks precede canonical page disclosure                   | Browse aliases with each endpoint independently denied                        | Neither denied path leaks; surviving cards unique and ordered                             |

For each positive case, record the actual request and raw response before extracting
ID/order assertions. Also assert requested field values, labels, figure and source
metadata eligibility. Negative cases inspect the complete envelope for private
IDs/values, including nested summaries, errors and cursor-decoded fixture canaries.
A confidential cursor is judged by the existing token contract and actual
ciphertext/transport; never expose its internal keyset as the public oracle.

### Production and generated closure

The full call path to wire is fixture production command -> committed owner data
and release -> native Source/default worker -> complete indexed observation ->
shared admission/plan -> current source/Access -> Search/owner executor -> original
and terminal disclosure -> summaries/figures -> final safety -> route serializer.
For composed calls, insert aggregate admission before dispatch and one common
final barrier after every read. No driver may call the pure matcher to supply
expected runtime membership.

Update the owning route input/output schemas and generated client declarations
when the proposed members or TypeList admission is adopted. Registry JSON schema,
composition validator/planner, published profile loader, `readPage` descriptor
admission, HTTP route, `packages/client/src/kernel/...` declarations and actual
Web component binding must agree. Use existing repository generation commands;
do not hand-edit generated declarations to imply a route exists.

Preserve ordinary Search fields, Global figures, languages and bounded redirects.
The page host must keep one aggregate and the existing bounded routing request,
render current public metadata and continue relation/edition/credit context through
native owner APIs. This brief does not open articles, hosted works, Realm rating
sorts, feeds, saved personal queries or old intentionally deferred specification
work. None is a prerequisite for the listed released jobs.

### Cost

- Touches: admitted AST/release/source/pins, indexed candidates including rejects,
  duplicates and lookahead, original/terminal/source/consent/foreign checks, summaries and figures.
- Bound: direct `c <= min(600, 6s + 3)`, three refill rounds, six catalogue searches
  or three owner seeks; ready `c <= 2s + 2`, two result-index reads; points
  `16 + 8c`, rows `64 + 16c`, blocks six per budgeted row, 12 statements and one
  connection per PostgreSQL backend for a single read; byte derivations below apply unchanged.
- Growth check: run first/deep/sparse/final native pages at 64/512/4,096 with
  population, matches, history, owner families and aliases varied independently;
  actual engine iteration must be constant/logarithmic, with useful sparse output.

## Brief: whole-query privacy consumer integration

Connect the existing public-filter consumer contract to every admitted public
filter/order consumer, including owner plans' public catalogue portion. The
[producer](../services/kernel/src/semantic/public-filter-source-contract.md)
and [consumer](../services/kernel/src/search/public-filter-consumer-contract.md)
contracts own same-transaction recording, routing, incarnation, retained cuts,
repair, physical custody and ACK rules. Implementers of this brief do not create
parallel event writers, receipt formats, permission certificates or ACK setters.

### Exact input and output sequence

Use the actual expanded admitted AST, parsed TextNode, Search sort, limit and
keyset. Derive dependency keys from every branch and order/label/text/fallback
source, not only positive leaves or returned rows. `walkFilter` is structural
traversal, not a source of authorization. Reject public OwnerLeaf at admission.
The consumer captures the native request meaning before compiling its physical
plan; caller mutations afterward cannot change retained meaning or key closure.

The existing operation shapes are used as follows, with actual owner objects:

```ts
const captured = await operations.capture(
  {
    plan: {
      ...actualSearchPlan,
      filterDocument: expandedAdmittedFilter,
      text: parsedText,
    },
    snapshot: 'pit', // or the actual immutable prepared observation
  },
  { deadline: requestDeadline },
);
// Continue only on captured.status === 'captured'.
const queried = await operations.query(captured.queried, { deadline: requestDeadline });
// Continue only on queried.status === 'queried'.
const final = await operations.readStatus(
  { queried: queried.queried, execution: queried.execution },
  { deadline: requestDeadline },
);
```

This is a protocol call example, not an instruction to import a missing runtime.
`actualSearchPlan` comes from the native planner, including its actual sort and
keyset fields. A test cannot supply precompiled truth or a forged start. Native
capture must bind the physical target/incarnation, consumer/projection generation,
meaning digest, read definition and canonical PIT/prepared identity.

Before query, ensure the observation's original covered cut is safe. Retain the
execution start and original/terminal own-row set with the actual engine execution.
Before disclosure, validate both covered cut and that execution start against
current required safety. The current live target's newer ACK cannot cleanse an
older PIT or prepared observation. A PIT renewal may only preserve validated
native observation identity; a new live query is not an old observation's renewal.

`readStatus` diagnostic `observed` alone is not a publish permit. Require complete
routing, no relevant pending/changed blockers, unchanged required source/identity
basis, current viewer/source authority and final original/terminal/field checks.
Pending matching-key reductions cover excluded subjects as well as hits.
Subject-wide reductions cover emitted own rows independently of filter keys.
Unknown/incomplete foreign routing blocks; target property names cannot narrow
away the dependent source's actual property/order keys.

Return existing readiness/preparation transport when pending or changed. Return
an actual owner unavailable problem on dependency/deadline failure, never empty
success. Search keeps its existing 503 retryable readiness envelope; the Zone
transport has separate 202 continuation semantics below. No internal consumer
status is serialized as a new public common DTO.

### Failure, rollback and replay rules

Reduction and its lossless per-home log append commit in the same authoritative
native command. A rollback leaves neither; receipt replay and genuine noEffect
append neither. The acceptance consumer observes these outcomes through native
commands and actual source reads, not by writing the log itself.

A consumer's contiguous ACK advances only after native local and every affected
foreign repair is refresh-visible, registered and routed. Duplicate delivery or
out-of-order events cannot jump a missing prefix. A lost checkpoint CAS, changed
incarnation, ambiguous write/refresh response, incomplete registration, stale
snapshot or pruned external-version fence cannot certify repair.

For foreign repair, the dependent source advances its own anchored version and
its repaired winner becomes visible. An unrelated subject edit cannot be the
fixture's trigger. A same-version 409 is not repaired-body evidence. Delayed old
writes and retained copies remain under the producer's physical custody contract;
finite delete retention, write-block draining and checkpoint CAS alone do not
prove no resurrection after unblock.

On consumer restart, load retained observation/execution state or return honest
observation-lost readiness. Never reconstruct the start from current heads, wall
time, UUID order, a vector supplied by the test or current clean/dirty flags.
Close drains in-flight operations and releases only the factory's retained PITs
and observations; supplied Source, pools and engine remain owned by their caller.

### Discriminatory native schedule

Use the existing real transport fixture in
`test/search/support/public-filter-consumer.ts` for genuine write/refresh holds,
pre-send and post-effect disconnects, wait_for response custody and real
same-name index recreation. Its declared `createPublicFilterConsumerFixture`
loads the actual producer; it is not proof that the runtime export is present.
Reuse the existing `test/search/public-filter-consumer.test.ts` protocol cases.
Add only the HTTP/surface and operation-wide observations absent from those cases.

Proposed new file: `test/search/whole-query-privacy-outcomes.test.ts`.
The following frozen schedules retain actual raw requests, responses, query
results before final disclosure, and the inclusive SQL/engine capture.

| Frozen title                                                                   | Native schedule                                                                                                                        | Required result                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Withheld HAREM protects both positive and excluded negative subjects           | Capture positive and Book AND NOT HAREM on separate observations; pause ordinary indexing; withdraw selected tag through owner command | Both reads prepare until full repair, including the formerly excluded readable book |
| Order-only reduction invalidates the whole result                              | Capture name/order query; reduce an ordering label or declared sort dependency on a nonreturned row                                    | No stale order/cursor/metadata disclosed; safe fresh execution eventually serves    |
| Original and terminal own-row reductions survive irrelevant-key narrowing      | Use irrelevant filter-key change plus independent original or terminal hide between query and final                                    | Relevant own-row blocks; no original/terminal/private field leakage                 |
| Foreign target restriction routes to the source property                       | Reduce actual relation target or source tuple/consent at its native home, ordinary relay held                                          | Dependent source positive/negative/order reads prepare without unrelated edits      |
| Relevant reduction repaired and ACKed between start and final remains detected | Hold after native query start, commit reduction, finish real local/foreign repair and ACK, release final                               | Old execution prepares even when current pending set is empty                       |
| Old covered cut remains unsafe for a new execution                             | Retain old PIT/prepared observation; reduce, repair and ACK before the new query starts                                                | Query cannot borrow newer live ACK; fresh safe observation is required              |
| Rollback replay and noEffect cannot manufacture privacy progress               | Roll back owner reduction, then commit once, replay same receipt, issue genuine noEffect                                               | No rollback entry; exactly one real reduction; no duplicate ACK basis               |
| A later irrelevant change cannot erase an earlier relevant change              | After start commit relevant key K then irrelevant key L on same home, repair in controlled order                                       | K remains blocking/detectable through final; latest-key-only narrowing fails        |
| Lower allocated transaction commits after the retained start                   | Hold actual lower-XID command, take start, commit reduction, then final                                                                | Reduction detected regardless of allocation/commit order                            |
| Missing moved and unavailable homes are never pristine zero                    | Remove reachability through real fixture transport or owner relocation boundary                                                        | No observed-clean result; raw retryable failure/preparation and full charged work   |
| Foreign routing registered late cannot acknowledge an incomplete prefix        | Commit dependency reduction while registration is incomplete; complete registration later                                              | ACK waits for full dependent repair; fresh result only after real settlement        |
| Lost CAS ambiguous refresh and same-name replacement cannot publish ACK        | Use real consumer transport holds/disconnects/recreate controls                                                                        | Old registration/observation unavailable; no unsafe result or fabricated ACK        |

Run positive and negative HAREM with both PIT and prepared observations. Run
order-only with the actual supported name/collections/rating declaration where
applicable; do not invent a public TypeList rating sort. The current public
rating producer remains Content's Global figure, with no private Realm inputs.

For each privacy schedule, take an unrelated-key query as a narrowing control.
It must serve after actual safe source/own-row checks rather than universally
prepare. If the returned subject itself changes, it must still block. This pair
distinguishes correct narrowing from both global starvation and returned-ID-only
checks. No unsafe facet value, label, requested fact, description, source title,
count or cursor content may escape while the query is unsafe.

Apply six-surface binding to the positive/negative/order/foreign/reduce-ACK-final
rows. Test all common personas at admission and continuation, retaining native
suspended-old-bearer and revoked 401 controls. No editor can use public execution
to borrow private selected statements. The native suspension sign-in case remains
Accounts' producer obligation, not a duplicate authentication implementation.

### Inclusive native attribution

Each measured read spans native `query` **plus** `readStatus`, actual metadata,
retained-execution writes, summaries, final current authority and engine work.
Store raw whole capture even when privacy attribution fails. Capture each actual
SQL occurrence with backend identity, not one deduplicated query text.

Classify only the all-home privacy START/FINAL subset by the exact leading role
comments after optional whitespace:

```sql
/* semantic.privacy-start */
/* semantic.privacy-final */
/* semantic.own-rows */
```

The third role is separate keyed own-row work in whole-page cost, not the all-home
subset. If own-row work is merged into final, the full final native plan counts
as coverage. Match every non-control occurrence to actual native plans' Query Text,
`planStatements` and backend arrays; preserve duplicate SQL occurrences and byte
and error arrays. Missing/unmatched attribution fails measurement, not zero.
No supplied plan, relation-name heuristic or subtraction of nested work qualifies.

All 4,096 homes are logically covered through the indexed behind/changed path.
Two statements and `64 + 2(B + D)` examined rows bound the coverage subset, where
B is distinct behind homes and D distinct homes changed since retained start.
They are separate sets; overlap does not erase either term. The subset also fits
inside the whole page's statement/row/byte ceilings, never alongside extra slack.
A full head vector, packed aggregate, JSON array or hidden hash scan fails.

If the producer layout reads/probes active XIDs, hold 1/8/64 actual open native
transactions with allocated `pg_current_xact_id()` through the inclusive read at
fixed data. The adopted ceiling has no active-XID term; corresponding row/block
or statement growth fails. Do not impose this conditional axis on an independent
layout or reinterpret the test as permission for an XID scan.

### Cost

- Touches: actual all-home behind/changed observations, complete native routing,
  retained starts/executions, source/own-row authority and actual local/foreign repair.
- Bound: coverage at most two statements and `64 + 2(B + D)` examined rows once
  per whole page; whole read still 12 statements/backend, composed `8 + 4R`, one
  connection/backend, all current row/point/block/byte limits; repair consumes the
  preparation step ceiling, with no uncharged registration or ACK work.
- Growth check: native 64/512/4,096 homes and population, independent pending and
  changed homes, reduce-ACK-final races, growing reduction rate and actual repair
  latency; served share must not fall, with conditional 1/8/64 active-XID captures.

## Brief: composed cost, useful pages and finite retained progress

Search implements direct catalogue/prepared public plans; Commerce implements
direct owner/prepared owner plans; Semantic connects the Zone union consumer;
Presentation connects configured TypeList aggregation. Performance reviews the
same shared capture and classifier. A descriptor-count helper or an unregistered
dynamic fixture does not satisfy this brief.

### Current ceiling derivation

Use actual admitted slots `s_i`, distinct read count R and actual candidates c_i.
Raw aliases count toward the 16-descriptor admission limit, while canonical
effective reads share dispatch and contribute slots once. Inputs are validated
before deduplication. R is at most 16 and total distinct slots S at most 128;
Search list admission has 1..100 slots; existing component-specific limits,
including TypeList 1..24, remain tighter where applicable. Joined sessions retain the existing 16 by 32
component bound; no independent session allowance is added.

For a direct read, three refill rounds ask at most `2 * remaining + 1` each;
there are at most two catalogue searches or one owner seek per round. Thus the
simple candidate sum is at most `6s + 3`, further capped at 600. Count actual
examined candidates even if duplicate, rejected, lookahead, discarded or reread.
At s=100 the absolute cap is 600, not the algebraic 603. Count-only engine
searches count toward six and cannot justify unsafe public totals.

For a ready result, at most two index reads examine `2s + 2` candidates. Ready
results are already filtered and canonical; stale disclosure rejection is repaired
through preparation when that bound cannot fill or prove final exhaustion.

| Unit                                  | Single read at actual c              | All-direct R=16, S=128 ceiling |
| ------------------------------------- | ------------------------------------ | ------------------------------ |
| Candidates                            | `min(600,6s+3)` direct; `2s+2` ready | `6*128 + 3*16 = 816`           |
| Access plus dependency points         | `16 + 8c`                            | `16*16 + 8*816 = 6784`         |
| PostgreSQL examined/removed rows      | `64 + 16c`                           | `64*16 + 16*816 = 14080`       |
| Shared blocks                         | Six per budgeted examined row        | `6*14080 = 84480`              |
| PostgreSQL statements/backend         | 12                                   | `8 + 4*16 = 72`                |
| Catalogue engine searches             | At most 6                            | `6*16 = 96`                    |
| Owner keyset seeks                    | At most 3                            | `3*16 = 48`, within SQL cap    |
| Connections/backend                   | 1                                    | 1 shared, not 16               |
| PostgreSQL plus engine response bytes | `16 KiB + 4 KiB*c`                   | `256 + 3264 = 3520 KiB`        |
| PostgreSQL plus engine request bytes  | `64 KiB + 1 KiB*c`                   | `1024 + 816 = 1840 KiB`        |
| Output slots                          | s                                    | 128                            |

The block and byte aggregate numbers are arithmetic consequences of the existing
per-read ceilings, not new allowances. `3520 KiB = 3604480` bytes and
`1840 KiB = 1884160` bytes. Page/HTTP transport bytes are retained separately;
the listed byte caps retain their specified PostgreSQL-plus-engine scope.
Public response size or `as_of` never substitutes for those backend wire bytes.

The 816 maximum is reachable by sixteen reads of eight slots: each c is at most
51, points 424, examined rows 880, blocks 5,280, response 220 KiB and request
115 KiB. These are ceilings, not target work; fewer actual candidates tighten
the row/point/byte calculation. Shared safety/control work is charged inside,
not added after, the aggregate bound.

For all-ready R=16/S=128, total candidate ceiling is `2*128 + 2*16 = 288`.
Consequently points are at most 2,560, examined rows 5,632, shared blocks 33,792,
response 1,408 KiB (1,441,792 bytes) and request 1,312 KiB (1,343,488 bytes).
There are at most 32 result-index reads. They count as SQL or engine operations
according to the actual backend, never automatically as free non-SQL metadata.
Statements remain 72/backend, one connection/backend and the global page caps.

For mixed pages, compute `C = sum_direct min(600,6s_i+3) + sum_ready (2s_i+2)`.
Points are `16R+8C`, rows `64R+16C`, blocks six times that row allowance,
response `16R+4C` KiB and request `64R+C` KiB. At uniform eight slots with k
direct reads, `C = 288 + 33k`; direct catalogue searches are at most 6k and
ready index reads at most `2(16-k)`. Actual backend statements still fit `8+4R`.
An owner seek and its SQL statement are two views of the same charged operation,
not permission to double the allowance.

When actual planned sums cannot fit, admission returns existing typed
`422 unsupported_query` for deliberately unsupported controls, or retains
preparation for admitted plans. Sixteen reads at 100 slots are not admitted.
Do not raise a per-read ceiling, reserve 100 slots per descriptor or hide work
behind aliases to make a composed capture pass.

### Shared page execution

Proposed internal integration: create one request-local execution scope after
aggregate validation and before dispatch. It holds existing epoch/control reads,
shared privacy observations, per-round disclosure batching and summaries. This
is an implementation concept pending owner adoption, not a new exported factory,
SQL permission snapshot or reusable safety token.

The common executor admits all descriptors before any dispatch, binds languages
and native default limits, then runs at most four reads concurrently as today.
Share the epoch/control read, one safety start/final pair across actual query
key closure, one disclosure batch per refill round across reads and one summaries
read. Per-read source authority still occurs for each actual source. The scope
carries no saved allow verdict across a native authority change.

The implementation cannot merely forward sixteen independent standalone HTTP
calls each with twelve SQL statements and sixteen pools: 192 statements would
exceed 72, and separate connections would exceed one/backend. Reuse native
executors under the request scope while preserving the standalone route's action,
gate, principal, session and field/disclosure behavior. Keep a standalone-vs-
aggregate response comparison as acceptance, with identical actual credentials.

A different database is a different backend budget group. Record every database
and backend PID, including Auth/Access dependencies, partition placement, retained
execution/preparation storage, summaries and profiles. Each PostgreSQL backend's
statement/row/block/byte usage is visible; work is never divided by backend count
to make a global candidate/point ceiling pass. A page may use at most one
connection per backend, with database snapshots following architecture rules.

For Zone common-page reads, a ready response is atomic 200 containing the common
page plus public Zone shell. Existing privacy/source/identity uncertainty returns
202 `{next}` with private/no-store only after real retained progress exists.
Unavailable dependency returns standard 503 plus Retry-After, no cursor or partial
page. An earlier completed read cannot leak if a second read prepares or a source
is revoked before final. Keep legacy per-read error semantics on the ordinary
presentation endpoint; do not silently change all pages to Zone continuation.

### Frozen composed schedules

Proposed native file: `test/presentation/composed-filtered-lists.test.ts`.
Use actual published documents and real Search/owner/Zone factories, not fakeKernel.

| Frozen title                                                                     | Input and schedule                                                                | Required output and work                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Sixteen distinct eight-slot native reads complete under the common page ceilings | Publish 16 valid distinct effective descriptors, all fully matching               | 128 useful slots, R=16, actual backend/engine totals below the table             |
| Aliases share one validated native dispatch and preserve raw admission limits    | Publish valid aliases, then invalid alias and seventeenth raw descriptor controls | Exact shared result/session for aliases; reject invalid/overflow before dispatch |
| Mixed direct and ready plans use actual slot sums                                | Run k=0,8,16 direct eight-slot reads with remaining ready plans                   | All complete; each actual mixed capture meets its derived tighter envelope       |
| An aggregate cannot publish its first read while its second prepares             | Hold second admitted plan before native completion after first is ready           | Zone returns only 202 next; no first-read subjects/document fragment             |
| Source revocation after an earlier read prevents final aggregate disclosure      | Hold before final after real first result; revoke mount/source via owner API      | Honest denied/readiness response; no borrowed first-read authority               |
| Every descriptor uses the final local and foreign privacy barrier                | Reduce a matching excluded/order dependency after a read, repair later            | No partial page before all required native repair and final safety               |
| Standalone and aggregate filters preserve native meaning and credentials         | Send same expanded job/source/language as native single and composed read         | Same safe canonical IDs/order/fields and session custody                         |
| Composed cursor restart never preserves withdrawn source authority               | Obtain real 202/next, change source/principal/session per transport contract      | Restart or denial as owned; no replay of stale grant or build rows               |

For limit admission include 16/128 exactly, 17 raw descriptors, 129 slots, a
zero/fractional/101 list limit and a duplicate whose body becomes invalid before
canonicalization. Existing malformed/plain-JSON/redirect tests remain the owner
of those assertions; call them rather than duplicating their implementation.

### Cost

- Touches: complete aggregate admission, every native read/backend, current source
  and subject disclosure, shared control/privacy/summaries and bounded session joins.
- Bound: R<=16, S<=128, all-direct C<=816, points<=6784, rows<=14080,
  blocks<=84480, statements<=72/backend, searches<=96, one connection/backend,
  request<=1840 KiB and response<=3520 KiB in their existing backend scope;
  ready/mixed derivations tighten these limits and never add coverage slack.
- Growth check: execute actual 16/128 first/deep/sparse/final aggregates at all
  three scales, with denied/empty/revoked paths, same-operation per-backend capture,
  real engine profiles and no helper-dispatch or slot-count substitution.

### Retained preparation and useful pagination

Implement against the owner's actual durable build/frontier/result ports on
existing stores and work modules. No new scheduler, background truth cache or
public preparation DTO is selected. Existing dynamic outcomes already declare
useful pages, counted work and three-scale checks in this base; bind them rather
than reverting to the older empty-success inventory wording.

Use this fixed finite fixture for each of the four actual plan kinds:

| Fixture         | Native input                                                                  | Expected completed sequence at s=8                                  |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| First/final     | 17 eligible canonical matches, stable distinct order keys                     | 8, 8, 1; only final next is null                                    |
| Deep            | N eligible matches; reach the cursor after at least N/2 by real continuations | Next eight correct IDs without offset/replaying the prefix          |
| Sparse          | N nonmatches before nine qualifying matches, fixed same source                | Useful first eight then final one; no empty/short intermediate 200  |
| Hidden/rejected | Eligible tail plus native hidden original, terminal and lookahead candidates  | Same useful tail; rejects counted and confidential cursor preserved |
| Empty           | Complete known zero matches with ready source/coverage                        | One genuinely exhausted empty page, next null                       |
| Unknown         | Essential source coverage or authority unavailable                            | Readiness/preparation, never an empty success                       |

N is 64, 512 or 4,096, independently of the fixed requested slots. Matching and
nonmatching populations are varied on separate axes. Deep setup follows actual
native cursors outside the measured target read, records its setup cost, and
never builds a measured cursor by encoding a guessed keyset.

Retained state follows the owning contracts' conceptual lifecycle:

```text
admitted -> building(frontier, generation, immutable input/source basis)
building -> building(next frontier) after one bounded committed step
building -> ready only after finite input exhaustion, current basis and visibility
building/ready -> affected repair or replacement build on relevant source change
ready -> safe full/final page only after current disclosure and final safety
any retained state -> honest unavailable/restart if required observation is lost
expired/evicted -> ordinary fresh admission; no stale permission/result reuse
```

These are lifecycle meanings, not proposed database enum names. Native retained
frontier and result writes use the owner transaction/idempotency boundaries. A
crash before step commit leaves no advanced frontier; replayed output is keyed
by actual generation and canonical subject and cannot duplicate a result. A
crash after committed progress resumes there. Cross-store ambiguous effects use
the existing sink/version/refresh recovery, not a false local completion flag.

Source/identity/meaning drift prevents publication of the old basis; only indexed
affected definitions/results are repaired. Unrelated disjoint identity jobs must
not repeatedly restart a stable finite owner build. Real scoped reader revisions,
including a lower job publishing after a higher one, remain visible to the source
basis. No global active marker or universal identity page gate is introduced.

Seed 4,096 relevant input keys for the retained crash case so at least five
steps are necessary at a 1,000-input cap. Hold before the third frontier commit,
terminate only the worker owned by the fixture, restart the real registered work
module, then follow the actual continuation beyond four server steps. Separately
crash after a committed third frontier. Retain both failed and replay captures.
On fixed finite ready input and eventually successful IO, finish with the exact
ordered useful result. Repeated preparation, lost frontier or whole-build replay
fails, even if every individual response is a valid 202/503.

Frozen future additions, only if not already covered by the dynamic/Zone suites:

| Frozen title                                                                | Act                                                                          | Required assertion                                                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Four native plan kinds fill first deep sparse and final pages               | Run the five ready fixture shapes above for each plan                        | Exact native IDs/order/next and bounded raw work                            |
| Retained native preparation survives crash before and after frontier commit | Use the two real third-step crash schedules                                  | Resume retained progress, reread at most one step, no duplicate rows        |
| Privacy reduction during a retained build cannot publish an old result      | Commit matching local/foreign reduction before building-to-ready publication | Old generation withheld; actual repair settles and fresh result serves      |
| Stable owner input finishes while disjoint canonical jobs continue          | Keep affected input fixed and run unrelated native identity jobs             | No universal page gate; finite useful completion and scoped cursor validity |
| Prepared owner admission deduplicates and bounds retained state             | Repeat same-basis requests, then admit 33 distinct live definitions          | Same-basis reuse; existing 32-live limit and least-recently-read eviction   |
| Public building generations and idle expiry retain native cleanup bounds    | Replace one public build; expire an owner result after existing idle TTL     | One current/one building public generation; idle owner expires at 24 hours  |

Do not synthesize time by mutating native authority fields. Use the owner's
trusted clock fixture where available, preserving real request deadlines and
retained observation TTLs. Same-basis deduplication is after complete native
admission; denied/malformed requests cannot populate retained state.

### Cost

- Touches: actual finite input/frontier/result generations, indexed affected
  dependencies, native work enqueue/steps, visibility and replay/repair work.
- Bound: each step reads <=1000 input keys/candidates, writes <=1000 results and
  <=1 frontier, uses <=8 points/input, <=64+16*input examined rows, <=16 SQL
  statements/backend, <=4 engine searches, one connection/backend and <=4 MiB
  response; total relevant input read once/build plus at most one step reread.
  Retain <=32 live owner results, 24-hour idle expiry, one current/one building public generation.
- Growth check: per-step absolute limits and linear total relevant-input work at
  64/512/4,096; first/deep/sparse/final completion, actual crash/replay ledgers and
  concurrent reduction/disjoint identity schedules; no extra numeric preparation
  request-byte or block allowance is invented where the owner contract specifies growth only.

### Capture and engine work binding

Use the existing shared `GrowthCheck`/`checkGrowth` with explicit
`scales: [64, 512, 4096]`, `includeBackends: true`, and `counted` validation from
`test/support/growth-counters.ts`. No local regression calculator, SQL-plan
classifier, fake cost object or driver-supplied constant plan name is acceptable.
Current `Measurement`, `PreparationMeasurement` and `NativeWork` declarations in
`specs/dynamic-collections-driver.ts` already describe raw SQL, candidate encounter
order, points, rounds, engine iterator/bytes, result reads and retained frontiers.
Reuse those fields rather than invent a competing executable counter ABI.

Each measured operation uses `capture(db, operation, {includeBackends: true})`
on every actual owner database. `captureMeasuredRun` supplies the inclusive
operation's backend/databases association. In a supervisor/worker world, capture
must run where the instrumented actual pools are used and return raw evidence
through the existing RPC. Capturing only the parent process's empty pool proves
nothing. `GrowthDatabase.openPool` covers independently constructed library pools.

Keep foreground and causally triggered background statements, nested plans,
failures, discarded work and repair. Background arrays are evidence to charge,
not a discount. Separate external load-generator setup from page/repair work;
record the reduction commands and actual repair/ACK series as their own bounded
operations so no ongoing causal maintenance disappears between measurements.

For SQL, preserve `Capture.statements`, byte/error/backend arrays, `plans`,
`planStatements` and `planBackends`, plus corresponding background arrays. Use
`costOf`/the shared catalog classification for rows removed, loops, nested work,
blocks and catalog-only treatment. Keep all-cost raw plan totals as the existing
dynamic native assertions do; catalog work cannot vanish from whole operation
bytes/connections or the separately required privacy occurrence attribution.

For engine work, use actual OpenSearch query profile responses from the real
executed query, whole tree and every shard. Sum `next_doc_count + advance_count`
for each query node; include every search/refill/count-only request and rejected
lookahead. Missing profile, missing shard, partial search or malformed counters
is missing evidence/failure, not zero. Engine transport records actual request and
response bytes, including profiling overhead where transmitted; do not issue an
extra uncharged query and substitute its profile for the executed read.

The pinned reference source read for this proposal was OpenSearch 3.9.0
`QueryTimingType.java` and `Timer.java` at the revision linked by
[Filtered lists](filtered-lists.md#budgets), from the read-only reference clone
`/home/edge/projects/rezics/rezics-next/.reference/search-rating-populations/opensearch`.
The former names NEXT_DOC/ADVANCE, and the latter serializes invocation counts
with `_count`. This source reading fixes counter names, not measured complexity.
No native experiment, producer receipt audit or evidence hash was performed.

Configure counted bounds with zero absolute/relative slack. Candidates, points,
index reads, statements, connections, slots and bytes meet literal ceilings at
every accepted repetition, not only the median. Shared growth classification
judges constant rows/statements/bytes and logarithmic blocks; engine iteration
is constant or logarithmic at fixed slots/leaves. A direct query sorting/counting
all matches fails even if its returned-candidate count is small.

For prepared work, classify total input/engine/repair work as linear in relevant
finite input, retaining each step's absolute-limit checks. Do not apply the
ready-page constant bound to the entire build or use linear preparation to excuse
an unbounded synchronous page. Median reporting never discards a failing replay,
failed attempt or an absolute ceiling violation.

### Growth axes and exact native schedules

Keep the measured neighbourhood fixed and change exactly the named population.
Use native-created authorities; production-shaped bulk seed is allowed only for
inert growing data according to the kernel Growth checks README. No SQL token,
suspension, grant, permission truth or fake public completion is seeded.

| Axis                     | Scale construction                                                     | What distinguishes a correct native plan                                               |
| ------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Catalogue population     | Add N unrelated eligible subjects                                      | Rows/bytes constant; blocks and engine work at most logarithmic                        |
| Matching population      | N subjects actually satisfy the selected predicate                     | Direct plan cannot scan/sort/count all matches                                         |
| Sparse matches           | N preceding nonmatches and fixed nine-match tail                       | Finite preparation yields useful eight then final one                                  |
| History                  | N unrelated revisions/retractions/suppressions                         | No history walk or newest-row scan in the measured read                                |
| Owner pools              | N owners, then N entries/labels/holdings/sessions for Alice separately | Viewer-self indexed access, every private family charged                               |
| Aliases/duplicates       | Actual N-original canonical group and duplicate occurrences            | Largest scale really has 4096 originals; unique canonical page without group expansion |
| Depth                    | Reach a native cursor after >=N/2 eligible rows                        | Seek from retained key, no offset/prefix replay                                        |
| Privacy traffic          | N independent relevant/irrelevant reductions with actual owner repair  | Relevant safety blocks; unrelated safe read remains usable                             |
| Active XIDs, conditional | 1/8/64 allocated transactions, data fixed                              | No active-transaction term hidden in final coverage cost                               |

For privacy served share, proposal: use one fixed measurement window duration T
at every scale; choose T once from the existing native harness deadline, never
extend it by scale. Schedule 1, 8 and 64 real reductions per T respectively at
64/512/4,096, spread uniformly and with the same fixed proportion of relevant
and unrelated source keys. The native worker repairs normally; do not force zero
latency or manually ACK. Issue the same fixed read schedule per T after the same
warm-up policy, record 200/202/503 counts, actual committed/visible/ACK timestamps
and pending/changed homes, and require served share not to fall between scales.
This scheduling proposal adds no request or latency budget and needs Performance
adoption; deadlines and privacy observation TTL remain unchanged.

Use identical request inputs, leaves, slots, source authority and measured order
for each series. Separately report repair latency and read served share; excluding
slow repairs from the denominator, counting only started reads or serving unsafe
results to improve the fraction fails. Every schedule drains its own work in
`finally` and cleans only its owned resources.

### Cost

- Touches: shared raw SQL capture/classification, per-backend wire/connection
  records, actual profiled engine operations, internal counters and repair ledgers.
- Bound: measurement grants no work allowance; native page/preparation ceilings
  above apply to every operation and failed/replayed work; no uncounted remote
  pool, profiling query, metadata lookup, background worker or catalog subtraction.
- Growth check: shared classifier at explicit 64/512/4,096 with zero slack and
  raw per-repetition limits, conditional active-XID series, all four plan kinds,
  real 16/128 aggregate and nondecreasing privacy served share.

## Remaining In-row closure attached to the same briefs

These are required consumers of the same native fixtures and protocols, not
new parallel specification projects or permission mechanisms.

| Manifest row                       | Native acceptance retained or extended                                            | Missing connection to close                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| catalogue-jobs                     | Predicate map and released-discovery suites above                                 | All six consumers, actual owner completion and released controls                                 |
| query-privacy                      | Existing consumer/projection/log/custody suites plus whole-query HTTP schedules   | Default worker and public routes use actual immutable observation/final barrier                  |
| freshness-and-recovery             | Original fifteen-second new-subject case; shared healthy 60s/max five-minute lag  | End-to-end relay/dependency/prepare/refresh lag, owner next read and retained recovery           |
| canonical-keysets-and-generation   | Original ties/principal/signature/rebuild, bounded-name and native identity cases | All source dependencies including NOT/excluded/order; 4096-original canonical groups             |
| global-rating-order                | Existing native Global vote-to-worker-to-HTTP outcomes                            | Genuine extreme private Realm population proves isolation on aggregate/context consumers         |
| typeahead-and-invalid-requests     | Original prefix/operator/filter-limit cases                                       | Expanded real credentials and current hidden/taken-down sources; no new equivalent suggest suite |
| index-and-default-runtime          | Original outage/rebuild and real-source composition                               | New whole-row fixtures use the actual registered default kernel work modules                     |
| composition-and-profile-governance | Original six Pages cases and native read/session/admission suites                 | Proposed TypeList filter schema and actual shared whole-page backend work                        |
| subject-context-and-traversal      | Native relations/editions/credits and actual Workers publication cases            | Current public context and continuations from owner APIs to aggregate/SSR/JSON-LD                |
| composed-cost-and-progress         | Dynamic counted useful-page cases plus new composed matrix                        | Actual factories, native counters and finite retained progress on every plan                     |

For lag, retain original stronger fifteen-second fixture assertion unchanged.
Additionally timestamp actual committed source position through relay, dependencies,
preparation and engine visibility; healthy ordinary lag must be <=60 seconds.
At actual pipeline lag beyond five minutes, require readiness. An index document's
recent timestamp cannot hide old upstream work. Privacy reductions stay immediate
and owner writes must be visible on the owner's very next native read.

For rating isolation, Content provides real Global standard-question votes and
an extreme private Realm population on the same subjects. Search/presentation
compare order and public figure fields before/after the private votes. Public
Global result/order must be identical, with no private Realm count/mean/score.
Do not create synthetic public aggregates or infer a private producer from a
public-only figure. Existing native-rating tests remain their own full acceptance.

For context/publication, select a real released work with edition, relation and
credit continuations. Read through actual page aggregate, follow the native owner
continuations, then use the existing Workers HTTP host path to assert current
public rendered body and aggregate-derived JSON-LD. Hidden/denied source fields
must be absent in both. Publish/activate before route output; a serializer fed
an invented upstream DTO is not publication proof. Reuse original Pages grant,
profile validation, template fallback and session/redirect controls unchanged.

### Cost

- Touches: actual default relay/index/owner work, current scoped identity basis,
  public figures, native context continuations and aggregate-derived publication.
- Bound: consume existing owner operation limits without adding allowance;
  Search/list/composed portions stay within the literal page or preparation
  budgets above, one aggregate and existing bounded routing GET/session limits.
- Growth check: shared native capture covers context and default-worker calls
  actually used by each measured list; existing owner suites retain separate
  lifecycle/index/rating/publication bounds and no foreign receipt re-verification.

## Owner adoption and executable handoff

### Same-world fixture wiring

Do not mix IDs from a `createReleasedDiscoveryFixture` database with a separate
`createSearchDriver` or `createPagesDriver` database. Those factories own isolated
worlds. A matching UUID shape is not shared native state or a producer receipt.

Concrete proposal: factor the existing released-discovery group's construction
into one internal test-support routine accepting the actual owned
`SemanticOutcomeDriver`, without a replaceable HTTP callback or release. Proposed
internal name `buildReleasedDiscoveryGroups` is not an existing export. The public
version-1 factory continues to own its world and invokes that routine. Search's
existing supervisor invokes the same routine against its already-owned Semantic
fixture after native Search/default-worker setup, returns the real receipt through
its RPC, and exposes native Alice/Bob/scoped/delegated/revoked requests there.
Pages/Zone whole-row tests use this same world's kernel and published profiles,
rather than creating a second Pages fixture and transplanting IDs.

Keep original `createSearchDriver`/`createPagesDriver` interfaces sufficient for
their untouched suites. Add test-only whole-row controls to the existing
`DriverClient` and matching supervisor/worker RPC cases, with closed validated
arguments, raw WireResponse/Headers and per-persona production session custody.
The RPC does not accept permission results, ACK positions, repaired bodies or
caller-made frontiers. A native child owns engine-profile and pool capture at the
actual execution boundary; the parent only retains evidence and asserts outcomes.

Commerce binds the already declared `DynamicCollectionsDriver.measure`,
`resumeAndSettle`, `seedUnrelatedFacts`, `holdProjectionConsumer` and
`replayProjectionEvents` to real owner/default-worker operations. Its
`exportCollection` and `runCollectionBulkAction` remain ordinary owner consumers,
not a new export/factory promised by this plan. Never invoke an unimplemented
method and count its throw as a completed owner job.

### Adoption-ready scenario and fixture allocation

| Acceptance file or family                                    | Fixture/port adoption                                                                  | New coverage versus retained coverage                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Existing Search/relation/Pages originals                     | Existing factories; same native Auth, Access and default indexing                      | Retain all 13+6+6 scenarios below, no assertion/title edits                     |
| Existing released-discovery fixture/capability suites        | Actual version-1 builder and native setup/scoped controls                              | Reuse landed records and receipts; extend only declared missing groups          |
| Proposed `test/search/whole-row-predicates.test.ts`          | Same-world group builder, expanded native personas, adopted members/TypeList admission | Eight frozen predicate rows, six-surface bindings and exact sets                |
| Existing projection/log/consumer/custody suites              | Actual PublicFilterSource and consumer operations                                      | Reuse protocol assertions; do not duplicate their production writers            |
| Proposed `test/search/whole-query-privacy-outcomes.test.ts`  | Existing real transport controls plus HTTP/surface bindings                            | Twelve frozen schedules; existing protocol rows reused where already executable |
| Existing dynamic-Collections outcomes                        | Actual DynamicCollectionsDriver native factory                                         | Preserve useful-page and counted-work assertions already landed                 |
| Proposed `test/search/filtered-list-native-growth.test.ts`   | Search native plan/capture controls and shared growth harness                          | Direct catalogue/prepared public first/deep/sparse/final and independent axes   |
| Proposed `test/library/filtered-list-native-growth.test.ts`  | Native owner factory and existing Measurement/PreparationMeasurement                   | Direct/prepared owner axes and missing retained crash schedules                 |
| Proposed `test/presentation/composed-filtered-lists.test.ts` | Same-world published profiles, actual common executor/Zone union                       | Eight frozen aggregate schedules, real 16/128/mixed captures                    |
| Existing Zone user-site/membership/continuation suites       | Real owner source and durable work ports                                               | Preserve static/route/direct target; add missing >4-step retained journey only  |
| Existing rating/context/Workers suites                       | Content's genuine private producer and owner context APIs                              | Retain native producer/publication cases; bind missing whole-row context        |

Generated matrix keys are `(scenario title, surface, persona, source visibility,
observation kind, scale, plan)` restricted only by the explicitly applicable
surface semantics. Public owner predicates are asserted rejected, not omitted.
A TypeList no-continuation descriptor does not receive a Search cursor; page-depth
checks use the owning native list continuation or actual Zone query transport.
The registration report lists every expanded case and expected count before run,
then actual executed/pass/fail/skip counts. Unavailable prerequisites are failures,
not absent cases. Preserve zero skips/todos and raw failed receipts.

### Original scenario ledger retained unchanged

The manifest's historical titles mention totals/lower bounds that the current
source already reconciled. The actual frozen source names below govern; no
reintroduction of a public count or frozen-file edit is proposed here.

Search originals in `specs/search-outcomes.test.ts` (13):

1. Traditional and Simplified Chinese match without matching a different title or an extended phrase
2. Kana voicing and width fold with case and full width Latin names
3. Aliases and descriptions are searchable but adopted statement values are not free text
4. Search is public for editor and anonymous while suspended credentials fail on both routes
5. New subjects become searchable and suggestible within fifteen seconds with current as_of
6. Statement filters use adopted Global values and positive roots admit bounded negation
7. Committed takedown and hiding remove stale hits immediately and refill pages while indexing is paused
8. Name paging has stable ties and request principal and signature bound tokens
9. Rebuild invalidates old page tokens and preserves all visible subjects while excluding takedowns
10. Typeahead matches word prefixes in Latin Chinese and aliases and rejects invalid query parameters
11. Text admission rejects malformed syntax and budgets while all operators produce observable matches
12. Filter admission rejects excessive budgets unknown facets and malformed search bodies
13. Unavailable index returns retryable problems on both routes while subject reads keep working

Relation originals in `specs/search-relation-facets.test.ts` (6):

1. an adopted author beyond the bounded relation sample matches positive and negated filters
2. overflowing author facet values retain their disclosed identities and labels
3. overflow rechecks keep hidden and taken-down source subjects out while indexing is paused
4. a declared author relation update refreshes its source subject
5. hiding a relation target suppresses positive source hits before the rebuild
6. qualified relation facet filters are refused without changing unqualified author semantics

Pages originals in `specs/pages-outcomes.test.ts` (6):

1. anonymous reads a public subject's page in one aggregate read
2. an unknown, a hidden and a taken-down subject answer the same not_found
3. publishing a profile needs the presentation grant
4. activating a profile changes the template a page uses
5. a profile with HTML, script or an executable link is refused with pointers
6. a route template answers a route target and other routes fall back to generic

Existing wrappers derive child declaration count from source and require exactly
that many passes, zero failures and zero skips/todos. Keep that behavior. Whole-row
acceptance adds assertions and fixture bindings rather than replacing the original
native suite with a smaller new test file.

### Commands for later owner implementation and integration

These commands are concrete handoff targets, **not executed by this document's
attempt**. Proposed filenames must first contain the adopted complete native
scenarios and real bindings; a missing file/import is never a successful red or
runtime result. Run from the repository root at owner integration, using the
existing kernel check runner for its database, node and test-slot lifecycle.

Original outcomes and landed producer/consumer consumers:

```sh
bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/relation-facet-outcomes.test.ts test/presentation/outcomes.test.ts
bun run --cwd services/kernel check test/semantic/released-discovery-fixtures.test.ts test/semantic/released-discovery-capabilities.test.ts
bun run --cwd services/kernel check test/semantic/public-filter-projection.test.ts test/semantic/privacy-reduction-log.test.ts test/search/public-filter-consumer.test.ts test/search/public-filter-custody.test.ts
bun run --cwd services/kernel check test/search/deletion-count-outcomes.test.ts test/search/cursor-confidentiality-outcomes.test.ts test/search/real-source-composition.test.ts
```

The complete new predicate/privacy and native plan/composed acceptance targets:

```sh
bun run --cwd services/kernel check test/search/whole-row-predicates.test.ts test/search/whole-query-privacy-outcomes.test.ts
bun run --cwd services/kernel check test/search/filtered-list-native-growth.test.ts test/library/filtered-list-native-growth.test.ts test/presentation/composed-filtered-lists.test.ts
bun run --cwd services/kernel check test/zones/user-site.test.ts test/search/native-rating-outcomes.test.ts
```

The dynamic contract's actual `DYNAMIC_COLLECTIONS_DRIVER` binding must be
registered by Commerce before its suite is a native command. Its existing
contract requires an absolute path/file URL exporting
`createDynamicCollectionsDriver(): Promise<DynamicCollectionsDriver>`. There is
no registered path to paste here today. The implementation supplies the actual
path in its kernel wrapper and runs `specs/dynamic-collections-outcomes.test.ts`
through that wrapper, counting every declared case. A fake path, missing-driver
sample or throwing factory is not acceptance.

When adopting TypeList/route changes, regenerate composition schemas with
`bun packages/composition/scripts/schema.ts`, and kernel OpenAPI/client outputs
with `bun run --cwd services/kernel derived`. If migrations are necessary, the
owning implementation also uses `bun run --cwd services/kernel derived schema`.
Those are later implementation commands, not permission to change generated
files or start a database in this documentation attempt. Then typecheck every
changed workspace with its existing workspace command and run its scoped checks.

Later native evidence records actual revision, expanded case counts, real
factory registration, executed admission plan, raw requests/responses, every
backend capture, profiles, step/frontier/replay ledgers and resulting useful
pages. Owner declarations/receipts retain their authority. No foreign receipt
re-audit, independent SHA evidence or native feasibility probe is required by
this specification assignment.

### Closure conditions and present status

This plan supplies the complete bounded design, missing-code map and frozen
future schedules for owner adoption. It introduces no runtime/request/store or
numerical allowance. Every operation's Cost subsection consumes existing limits.
There are no new product implementations, executable acceptance modules or
outside-path edits in this attempt.

All manifest rows remain unproven by this artifact. Record separately:
specification adopted/red measured, driver registered, implementation exposed,
user-case native pass at named revision and promotion. Formatting this document
can establish only artifact formatting. Documentation-only work needs no
workspace compiler, and this minimal-mode attempt runs no acceptance, native,
database, browser, host, remote or worker check. Post-integration owners execute
the commands above against the completed native bindings; only those receipts
can advance the corresponding capability stages.
