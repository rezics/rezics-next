# API acceptance gaps before the first public release

Research date: 2026-10-28. Repository revision: `bc6c7eba7976422220c2fec1e572b9dce03ecd98`.

The missing guarantee is capability completion: a person can perform a useful job through the production HTTP API,
using the released data model, everywhere the relevant abstraction appears. There is substantial native API
acceptance already. Its strongest suites verify real authentication, Access, commands, relays and workers. However,
a passing implementation slice does not establish the complete capability, and several executable specifications
are still deliberately red without a product driver. The delivery machinery does not require a complete mapping
from first-public scope to production-bound user outcomes.

The three motivating jobs expose both missing data and missing composition: Book has no word-count property;
there is no released harem/light-novel demonstration; Recipe has cooking time but no dietary classification.
Generic filter tests cannot discover those omissions when they supply their own synthetic release. Neither can an
entry API test prove that the same predicate works in Everything, a state Collection, a curated Collection and a
mounted Zone. These are release prerequisites, rather than frontend prerequisites.

## Audit boundary and evidence standard

This is evidence and a proposed acceptance backlog, not a new normative contract or a product pass report. No
product suite was executed for this research. “Native” below describes the inspected test binding and assertions,
not its latest result. A present test that already demands the outcome is retained, even when the implementation
appears unable to pass it. Such an outcome needs implementation, not another equivalent acceptance test.

Inputs were [first-public scope](../scope.md), all eight owner [Goal definitions](../goals/README.md), development
workflow on local `dev` (the same revision as the audited checkout), the manager/worker machinery, and the supplied
`/home/edge/projects/rezics/rezics-next/.temp/goal/supermanager/research/architecture-capabilities.md`.
That earlier report inspected `34dbc5607bf58f36722fb7e252df58fc1120d541`; its 37 groups are a checklist of leads,
not current proof of absence. This audit checked current sources and tests again. In particular, native profile
commands, rating producer-to-search scenarios, publication feeds and cover-recovery tests now exist.

The brief sample is 30 recent, distinct, non-held brief bodies with frozen `specs/` or `services/*/test` code,
drawn from the main checkout's `.temp/goal/briefs/`. It is stratified across Goals with such briefs: six each for
semantic, commerce, search and imports, five content, one accounts. Revisions of the same suite remain separate
brief observations; they are not 30 independent capabilities. The appendix identifies each body by date and SHA-256
prefix, without embedding operational ticket identifiers. Frozen assertions and their current files/bindings were
read; two proposed frozen files not yet present at the audited revision are explicitly marked brief-only. A second
browse of recent unfrozen/UI work informed the boundary distinction, not the sample counts.

Evidence is classified as:

- **Native case:** production HTTP boundary, native authority and a meaningful fixture/outcome are present in source.
- **Partial:** a native slice exists, but the stated job, producer/consumer chain or required surface is untested.
- **Unbound:** an executable outcome specification exists, but no production binding was found for that suite.
- **Contract/helper:** schema, compiler, pure algorithm, source-shape or missing-driver verification only.
- **Publication:** an actual web HTTP response is required; a kernel test alone cannot prove HTML or redirects.

## Why the workflow admitted the gaps

### Local completion is enforceable; capability closure is not

The current [feature-design workflow](../development/feature-design.md) already asks for user jobs and for a generic
capability wherever its abstraction appears. It even names the long-book/harem examples. [Delivery](../development/delivery.md)
requires API acceptance before implementation, and [verification](../development/verification.md) distinguishes
specified, implemented, exposed, tested and promoted. The failure is therefore not an absence of good prose today.
The prose has no executable scope inventory that the dispatch and completion gates must satisfy.

| Mechanism | Primary evidence | Consequence |
| --- | --- | --- |
| A brief can describe only a substrate. | `tools/goal/src/briefs.ts` validates nonempty `acceptance.command` and `acceptance.tests`, plus a `failing` boolean. There is no required job/persona/fixture/surface mapping. | A type export, SQL hook or missing-driver verifier can fully meet its declared acceptance. `failing: true` is metadata, not measured proof that a useful product outcome failed. |
| The worker is bound to the dispatched slice. | `tools/goal/src/launch.ts`, `workerPrompt`, requires the brief's tests, preserves frozen files, and says landing runs that worker's own acceptance. | Finishing a missing route, profile or composition outside that slice is not forced by a local green result. Frozen tests protect existing promises but cannot supply omitted promises. |
| Manager completion aggregates tasks and gates. | `tools/goal/src/managers.ts`, `opening`, interpolates the manager brief and checks scoped tasks merged plus the main gate. `tools/goal/src/promotion.ts` derives promotion commands from dispatched acceptance. | A job omitted at dispatch has no independent completion obligation. Many completed supporting tasks can coexist with an unfinished capability. |
| Frozen-byte integrity is separate from semantic adequacy. | `tools/goal/src/frozen.ts` parses fenced paths and hashes; task/merge machinery preserves them. | Strong protection against weakening a test does not establish that the right user case was frozen. |
| Green contract verification can intentionally mean red product behavior. | `specs/support/verify-outcome-suite.ts` removes the driver and requires every declared scenario to fail with its missing-driver error. | This is useful specification validation. Treating its successful command as product completion loses the distinction already documented in that script. |
| Gate discovery needs an actual binding. | `scripts/gate.ts` checks workspace commands; `services/kernel/scripts/check.ts` discovers `test/**/*.test.ts`. Standalone `specs/` suites need registered native wrappers. | A specification file's existence does not make it part of native product acceptance. |
| Tests frequently establish a port rather than the consumer's job. | Sample: Zone typed schemas, page-continuation schemas, scope-leaf types with a not-ready stub, rating cursor codecs, label reservations and owner-fact hooks. | Valid intermediate landings lack a release-level obligation to connect the real producers, executor, HTTP route and useful result. |
| Fixtures are often chosen by the abstraction under test. | `specs/search-outcomes.test.ts` uses Books/People and accepted `schema:author`; profile tests use fixture releases; filter tests declare synthetic recipe properties. | A generic mechanism can pass without any bundled word count, real classification Concepts, diet field or usable profile binding. A private label named `vegetarian` in profile tests is not a catalogue dietary predicate. |

The Goal definitions assign outcomes across owners, but the executable suites follow modules. For example, semantic
can establish selected facts, search can establish a matcher, commerce can establish a source hook and web can
establish rendering against a fake. None of those facts alone proves “my library, books over a million words.”
The missing acceptance is the join of those obligations, owned by one Goal with named collaborating owners.

There are good models to retain. `test/semantic/outcomes.test.ts`, `test/search/outcomes.test.ts` and
`test/presentation/outcomes.test.ts` bind the original suites and check execution counts/no skips. Library,
commerce and community wrappers bind their product drivers. `test/imports/api-outcomes.test.ts` runs the frozen
import API suite against native infrastructure. `test/search/native-rating-outcomes.test.ts` creates real voters,
writes votes and observes the default worker, public figures, index and HTTP ordering. The preventive change is to
make this level of closure mandatory for every public capability, rather than replace these suites.

## All 37 architecture groups, rechecked

Paths beginning `K/` below mean `services/kernel/test/`; `S/` means `services/kernel/src/`. Scenario names in the
last column refer to the owner tables later in this report. “No new case” means relevant native API acceptance
already exists, not that the earlier report's web concerns disappeared.

| Group | First-public capability; current evidence | Missing user-case acceptance or disposition |
| --- | --- | --- |
| G1 | Configuration-defined vertical/editorial workflow. `K/semantic/outcomes.test.ts` covers definition extension; catalogue YAML is real, but lacks word count, diet and useful released library bindings. | **Partial:** `vertical-release`, `catalogue-jobs`, `import-to-discovery`. Exercise released definitions, contribution, adoption, indexing and library consumers together. |
| G2 | Subject relations, editions, credits, competing claims/history. `K/semantic/context-relations.test.ts`, `relations-uncapped.test.ts` and relation-page summary tests exercise native relation reads; full composed page traversal remains separate. | **Partial:** `subject-traversal` joins page continuation, preserved credit qualifiers/spoilers and competing sourced claims/history. Existing relation-route paging is not called absent. |
| G3 | Own vote, labelled public figures and privacy threshold. `K/rating/vote-http.test.ts`, `aggregate-http.test.ts`, and native rating-to-search acceptance exist. | **Native cases already exist.** Do not duplicate vote/aggregate tests. `subject-rating-context` adds only the missing composed subject-page/population consistency case; a client-only placeholder is not an absent rating API. |
| G4 | Reviews and discussion at a subject. `K/content/reviews.test.ts` exercises commands with seeded votes/effects; `subject-threads-http.test.ts` reads seeded threads. | **Partial:** `review-from-vote` writes the vote and review over HTTP, runs the production relay and traverses the subject discussion/review views. |
| G5 | Explicit Global/Realm subject context. Community publication APIs are native; `S/presentation/http/pages.ts` has subject/route/account targets without the required Realm-context journey. | **Partial:** `realm-subject-context`, including unpublished fallback, local facts, review/rating population and globally resolved agents. |
| Q1 | Admitted type, tag, range, qualifier and negative discovery. Native search/facet suites exist; synthetic author/unit fixtures do not exercise the motivating verticals. | **Partial:** `catalogue-jobs`, the cross-surface matrix and `platform-qualifiers`; include facets beyond a preview's first values. |
| Q2 | Global standard-rating sort, ties and private-population exclusion. `K/search/rating-api-outcomes.test.ts` and `native-rating-outcomes.test.ts` already demand public HTTP ordering; `S/search/http/routes.ts` still has a closed sort union without `rating`. | **Native cases already exist; runtime admission remains a source-visible gap.** Retain and complete those cases. Add `private-rating-isolation` only for the missing actual private Realm producer, not another null-tie/Global-vote test. |
| Q3 | Current truth in membership, negatives, order, counts and freshness. `K/search/deletion-count-outcomes.test.ts`, disclosure/cursor suites and rating current-hide cases cover useful slices. | **Partial:** `query-privacy`, `freshness-and-recovery`, real foreign repair and complete negative evidence. Returned-ID checks do not cover a subject excluded using a withheld tag. |
| C0 | Curated create/edit, visibility, duplicate occurrences, notes, reorder, paging and follow. Native `K/library/outcomes.test.ts` binds `specs/library-outcomes.test.ts`. | **Native basic cases already exist.** No replacement CRUD suite. Shared filtering/export/mount/personalization are separate C2/C4 obligations. |
| L1 | Definition-selected states and accepting-release pins. `K/library/profile-entry-command.test.ts`, `profile-session-command.test.ts`, `profile-copy-command.test.ts` now contain native command/HTTP checks. | **Partial:** full `specs/library-profiles-outcomes.test.ts` native binding and `released-profile-journey`, using the real released verticals and historical consumer reads. The old report's claim of only fixed-state writers is stale. |
| L2 | Independent private labels, including label-only library support. Schema/reservation and source-hook tests exist; `specs/library-labels-outcomes.test.ts` has no located native suite binding. | **Unbound:** `label-only-library`; complete the existing suite and add classification-versus-private-label isolation. |
| L3 | Typed progress/holdings, historical meanings and Continue. New profile-session/copy native tests exist; aggregate Continue still has a literal `in_progress` consumer. | **Partial:** `progress-and-continue`, `holdings-are-independent`; no inference that a purchase, holding, state or completed session creates any of the others. |
| C1 | Stable Everything/state Collection identities and union membership from state/label/session/history/holding. Frozen dynamic outcomes exist; current curated DTO/source composition is incomplete. | **Unbound:** `everything-population`, all owner catalogue jobs with and without state, and the original dynamic suite. |
| C2 | One members API for curated/dynamic filtering, text, order, layout and continuation. `S/library/collection-routes.ts` accepts view/cursor/limit, not the full shared query. | **Partial:** `collection-jobs` and the full cross-surface matrix; never implement a new shelf-only query path. |
| C3 | Bounded selected/query bulk operations. `S/library/bulk-contract.ts` still throws for factory/admission/execution operations. | **Unbound:** existing `specs/library-bulk-outcomes.test.ts` plus `bulk-user-population`; ensure captured real query population, replay, partial failure and cancellation. |
| C4 | Collection follow, ItemList export and Zone mount across allowed visibility/kinds. Existing curated follows cover only part. | **Partial:** `collection-actions`; private Everything/state identities remain undisclosed to others and are not granted follow/export merely by sharing a DTO family. |
| C5 | Truthful public outputs, complete publication, source freshness and terminal freeze. Native source helpers exist; `createCollectionSource` remains unavailable and listing freshness contract operations throw. | **Unbound composition:** bind source/freshness/dynamic suites; add `published-output-lifecycle` with real page consumers. |
| L4 | Ordinary deletion, 30-day undo, replacement-safe restoration and due purge. `K/library/entry-retained-schema.test.ts` and `collection-undo-store.test.ts` cover storage; the sampled entry-retention worker test is brief-only. Full `specs/library-deletion-outcomes.test.ts` binding was not found. | **Partial/unbound:** `ordinary-delete-undo`; distinguish ordinary undo from terminal account erasure. |
| Z1 | Zone resource lifecycle is native in `K/zones/resource-core.test.ts`; union, membership, routing and page continuation remain separate contracts. | **Partial:** `zone-user-site`; schema acceptance for `page-continuation.ts` is not an HTTP union/page case. |
| R1 | Realm/Space configuration, joins, boards and subject publications. `K/community/community-outcomes.test.ts` binds the production community suite. | **Native API cases already exist.** Remaining editor/join controls are web integration gaps; immediate protected-read bans are R2. |
| R2 | Immediate ban/admission safety. The community ban scenario settles membership removal and then reads a public Realm; public readability is intentional. | **Partial:** `protected-ban-barrier`, with no worker settlement, a protected venue and a manager trying to admit the banned target. Independent grant precedence needs the accounts/content owner decision before freezing that variant. |
| A1 | Human, organization and software-agent identity; one public page. `K/presentation/agent-read-kinds.test.ts` seeds human/organization cases; verified subject-to-handle redirect is publication behavior. | **Partial/publication:** `agent-identity`, including the automated actor and real HTTP canonical redirect. |
| A2 | Self-profile, public activity controls, verification and preferences. `K/access/account-profile-read.test.ts` reads via HTTP but updates profile through commands; notification preferences have native tests. | **Partial:** `self-profile-http`; native preference tests remain evidence and need not be rewritten. |
| A3 | Follow edges and owner-only counts for every eligible target. Native follow edge/list cases exist; `specs/follow-counts-outcomes.test.ts` is unbound. | **Unbound counts:** `follow-owner-counts`, including subject/agent/Space/eligible Collection and no public count disclosure. |
| A4 | Advertised actions agree with current Access and delegated authority. Permission suites are native; `specs/viewer-actions-outcomes.test.ts` has no located production binding. | **Unbound discovery:** `advertised-actions`, comparing each advertised operation with the actual request, including delegated editors and principal/consent revocation. |
| A5 | Terminal account deletion clears downstream private data/retained payloads. Native lifecycle/erasure workflow tests exist; the recent account-fact purge test is a primitive, not the whole owner graph. | **Partial:** `terminal-erasure-graph` through all owner HTTP reads, exports, prepared results, payload stores and ordinary-undo routes. |
| N1 | Private in-app reply/mention/moderation notices, preferences, dedup, inbox/read state and retention. `specs/content-notification-outcomes.test.ts` is unbound; preferences alone are native. | **Unbound:** `notice-delivery`, including loss of access between event and delivery and between delivery and read. |
| N2 | Reports, decisions, minimal appeals and reversal. Report/moderation foundations exist; notification outcomes specify the unfinished resolution chain. | **Unbound/partial:** `report-to-appeal`, with separate reporter, author, moderator and independent appeal reviewer. |
| N3 | Current containing authority at final content disclosure. `S/content/reads.ts` prepares board evidence before later work; `K/content/current-erased-read.test.ts` and other read tests cover earlier mutation boundaries. | **Partial:** `late-board-revocation` after initial board authorization but before the final HTTP result. This is a missing race witness, not a reproduced exploit. |
| O1 | Discover an offer, check out, poll an order and understand the entitlement. Native commerce outcomes cover checkout/grant/refund. | **Partial:** `offer-to-benefit`, beginning at a readable subject and ending at readable owned benefits without inventing a library copy/state. No marketplace or points scope is added. |
| O2 | Delisted offers are not publicly buyable/discoverable; receipts bind the target. `S/commerce/routes.ts` offer GET tests existence only and has no price-revision route; `commands.ts` revision receipt input omits offer ID. | **Missing regression cases:** `offer-lifecycle-receipts`; test HTTP disclosure, revision exposure and cross-offer idempotency conflict separately. |
| O3 | Out-of-order checkout observations never undo newer truth. `S/commerce/settlement.ts` returns unchanged for a newer same-state snapshot before advancing the observation watermark. | **Missing regression case:** `checkout-observation-order`; verify through order/entitlement HTTP results with controlled provider observations. Source inference, not a test result. |
| I1 | Bangumi/VNDB/Open Library/Wikidata facts become usable catalogue/discovery data. Native `K/imports/api-outcomes.test.ts` exists, with ordinary reads and attribution. | **Partial:** `import-to-discovery` for actual supported form/tag/platform/count mappings and consumer results, not opaque field preservation. Recipes use editorial input, not a recipe-site importer. |
| I2 | Crash-safe deferred cover recovery. `services/importer/tests/deferred-cover-recovery.test.ts` now reopens SQLite, but uses fake transport/media availability. | **Partial:** `cover-native-recovery` must connect that crash to native media/source/subject reads. Do not claim the local recovery regression is untested. |
| E1 | Correct public metadata, canonical identity and structured data for each vertical. `apps/web/tests/pages-jsonld.test.ts` tests a serializer, including a synthetic Book with cookTime. | **Publication:** `published-vertical-metadata`, using actual Recipe/Book/game/agent HTTP pages and only publicly rendered facts. |
| E2 | All eligible sitemap families and cache-safe anonymous HTML. New native community/content/library sitemap/feed tests exist. | **Partial/publication:** `public-discovery-and-cache` must connect feeds to served XML and prove anonymous HTML does not contain another account's personal facts. Do not duplicate existing feed API cases. |
| F1 | Bounded, useful composed pages and finite preparation under realistic sparsity/aliases/privacy. Many module growth tests exist. | **Partial:** `composed-cost-and-progress` measures the native full plans, every owner pool, engine work, deep pages and background recovery. |

### Scope rows that are not a new gap group

This reconciles the entire scope table, including systems that the 37-group report did not expand separately.

| Scope system | Disposition |
| --- | --- |
| Subject pages; catalogue/editorial/identity/definitions; search | G1–G5, Q1–Q3, A1 and I1 cover the missing API jobs. Existing semantic history/merge/relation acceptance remains required. |
| Library/Collections/progress/copies; Zones | L1–L4, C0–C5, Z1 and F1; user-saved dynamic queries and holding-derived platform joins remain deferred. |
| Ratings/reviews; posts/threads/boards | G3/G4, Q2/Q3, N1–N3. `K/content/thread-outcomes.test.ts` binds `specs/content-thread-outcomes.test.ts` for thread/reply/lifecycle cases. `K/content/subject-reactions-http.test.ts` supplies reaction set/change/clear and own/public separation. No new standalone reaction gap was found. |
| Realms/Spaces | R1/R2/G5; content owns the venue, accounts owns membership/Access. |
| Agents/profiles; follows; accounts/auth/preferences/deletion | A1–A5. Existing authorization, credential effects, durable initiator and account lifecycle suites cover native permission/session boundaries; profile discovery and downstream erasure are distinct missing jobs. |
| Moderation/reports/appeals; notifications | N1–N3 and A5. In-app notices only; email is deferred. |
| Commerce/offers/orders/entitlements | O1–O3. Points are deferred even though point code exists. |
| Imports/bridges | I1/I2. Four named providers; no recipe method-text scraping. |
| Sitemaps/metadata/sharing/SEO | E1/E2. Test served HTTP documents as well as native feed APIs. |
| Articles/hosted works/media | Closed behind platform grants until polished. Preserve existing granted media/content API acceptance and I2's public cover path; do not mark a closed editor as a first-public omission. |
| Feeds; recommendations/rankings; partner API | Deferred. Continue/catalogue rows, curated rankings, Global rating sort and Collection ItemList export remain in their explicitly owned groups. |

## Definitions and fixtures the missing cases require

Use a shared, versioned fixture builder under native test support, with deterministic logical names mapped to real
created IDs. The released data producer is part of acceptance: do not inject a test-only definition and claim the
bundled release supports the feature. A separate extension test may deliberately compile a custom release.
Inspection of `packages/definitions/release/rezics.json` confirms no `libraryProfiles`, type library bindings,
`schema:wordCount` or `schema:suitableForDiet`; the relevant source definitions are
`packages/definitions/catalogue/book.yaml`, `recipe.yaml`, `classification.yaml` and `game.yaml`.
All titles and classifications below are controlled test data, not statements about real works or recipes.

| Fixture contract | Required definition/data and discriminating examples | Owner |
| --- | --- | --- |
| `words` | Add/release genuine `schema:wordCount` as a nonnegative integer quantity with unit `1`, admitted Book facet. `B-long` = 1,200,001; `B-edge` = 1,000,000; `B-short` = 999,999; `B-unknown` has absent/somevalue evidence; `B-characters` has 1,400,000 characters but no word count. Pages, characters and estimated reading duration never fill wordCount. | semantic; imports for reviewed mappings |
| `classification` | Public adopted `skos:Concept` subjects for harem and light-novel form, with scheme/labels/attribution. Existing `schema:keywords` carries tag membership. The work-form property/mapping must be selected and released by semantic; this report does not pretend a new CURIE is already supported. Define `FORM` to that released property and `LN`/`HAREM` to actual Concept IDs. | semantic |
| `books` | `B-long` is light-novel + harem; `B-edge` is also both; `B-short` is light-novel without harem; `B-unknown` is harem with unknown form; `B-characters` is both but words unknown. `B-tag-only` has harem but a different form; `B-form-only` has light-novel form but no harem. Include an edition whose page count must not become its work's word count. | semantic |
| `diet` | Release `schema:suitableForDiet` with a declared classification representation, including a vegetarian Concept mapped to Schema.org VegetarianDiet; do not infer from a private label or ingredient-name heuristic. Existing `schema:cookTime` is an integer minute quantity (`wd:Q7727`), not total prep+rest time. | semantic |
| `recipes` | `R-quick`: vegetarian, cookTime 25; `R-edge`: vegetarian, 30; `R-slow`: vegetarian, 31; `R-meat`: nonvegetarian, 20; `R-unknown`: unknown diet, 20; `R-cooked`: vegetarian, 20, own completed cooking session; `R-other-cooked`: vegetarian, 20, completed only by another account. Authored ingredients/instructions are present. | semantic; commerce personal facts |
| `platform` | Public Nintendo Switch/PC platform Concepts and `schema:gamePlatform` on the released game/release types. Distinct release statements differ by platform, language and date; include a false Cartesian-product match assembled from two statements. Work-level platform sets do not invent release combinations. | semantic; imports |
| `profiles` | Bundled Book/game/recipe/record bindings, declared state IDs/roles, progress modes/units, holding kinds/statuses, and two immutable releases. A renamed/retired choice keeps its old accepting meaning; a no-profile Person cannot receive a fresh state. No literal universal `in_progress` rule. | semantic definitions; commerce consumers |
| `personal` | Alice and Bob each have independent facts. Alice supports different subjects by state-only, label-only, active session, completed history-only and holding-only; one subject has several supports, another only an empty entry shell, another only a follow. Include no-entry subjects with label/holding support. | commerce |
| `sources` | Public curated `C-public` contains all book/recipe controls, a duplicate occurrence with its own note, and an alias of `B-long`; unlisted/private Collections and a public published dynamic generation are separate. Zone `Z-public` mounts it plus an overlapping saved scope. | commerce; semantic |
| `privacy` | Same readable subject with a newly withheld harem statement; a hidden tag target; a foreign source fence/withdrawn consent; hidden original identity with readable terminal; invalidated public generation. Add suspended valid bearer, revoked token, unscoped actor and delegated agent personas. | accounts plus each producer |
| `ratings/content` | Real standard-question voters crossing the privacy threshold; real Global prior population; an extreme private Realm population; a review citing a vote; paged discussions; board access revoked at a deterministic late barrier. | content; search consumer |
| `lifecycle/commerce` | Two same-partition offers with different targets but equal prices, private/public benefits, controlled checkout snapshots at three ordered times, ordinary retained incarnations and terminal account deletion. | commerce; accounts |

The word-count recommendation follows [Schema.org wordCount](https://schema.org/wordCount), which defines an integer
word total for CreativeWork, including Books. [Schema.org Recipe](https://schema.org/Recipe) distinguishes dietary
suitability and cookTime. Its published cookTime representation is a duration; keep the repository's admitted minute
quantity internally and test explicit conversion, such as 25 minutes to `PT25M`, at the export boundary. These are
data definitions and adapters, not reasons to introduce vertical-specific kernel filtering.

### Precise catalogue requests and expected sets

The following is test-builder notation: uppercase values are replaced with released property/Concept IDs before
JSON is sent. `MINUTE` is the released minute-unit identifier in the filter DTO; the fixture writer uses its
canonical expanded storage value. This avoids silently mixing CURIE and expanded units. Names are not text-search
substitutes for classification. `schema:wordCount` and diet/form admission must actually be released first.

```json
{
  "filter": {
    "and": [
      { "type": { "in": ["schema:Book"] } },
      { "statement": { "property": "schema:wordCount", "range": { "gte": 1000001, "unit": "1" } } }
    ]
  },
  "sort": "id",
  "limit": 2
}
```

Send that body to `POST /v1/subjects:search`. For these integer counts, `gte: 1000001` expresses strictly over one
million using the existing inclusive range grammar. It must return exactly `B-long` across all pages, never equality,
absence, characters or edition page count. Run the form/tag request separately, then conjoin it with the range:

```json
{
  "filter": {
    "and": [
      { "type": { "in": ["schema:Book"] } },
      { "statement": { "property": "FORM", "in": ["LN"] } },
      { "statement": { "property": "schema:keywords", "in": ["HAREM"] } }
    ]
  },
  "sort": "id",
  "limit": 2
}
```

Expected form/tag set is exactly `{B-long, B-edge, B-characters}`; expected combined set is `{B-long}`. An
unsupported definition must fail admission explicitly before enumeration, but rejection is not completion of these
required jobs. `422 unsupported_query` is acceptance only for deliberately unsupported control requests.

For Recipe, send the same search envelope with an AND of type `schema:Recipe`, a diet statement containing the
vegetarian Concept ID, and `schema:cookTime` range `{ "lte": 30, "unit": MINUTE }`. The exact catalogue set is
`{R-quick, R-edge, R-cooked, R-other-cooked}`. Unknown diet and slow/nonvegetarian recipes are excluded.

For “I have not cooked,” use Alice's admitted owner population and owner completion predicate through the common
Collection query, not a catalogue-wide public NOT on private facts. Recommend that the recipe profile identify the
completed cooking-session predicate; “not cooked” then means no live completed cooking session in that owner
population. With all four eligible recipes supported in Alice's library, expected IDs are
`{R-quick, R-edge, R-other-cooked}`. Clearing a state alone must not erase completed history. This recipe-specific
completion interpretation is a proposal to adopt in the profile/consumer contract before freezing that new case.

### Required cross-surface expansion

Write each row as a separate named native scenario so a pass count exposes missing combinations. Do not substitute
one direct matcher call for all consumers. Common-query serialization must follow the adopted owner HTTP schema;
the current members route does not yet admit it. These are proposed acceptance inputs, not claims of mounted APIs.

| Job | Search | Public curated Collection | Own Everything, no state | Own state Collection / state predicate | Public mounted Zone | Subject page / TypeList |
| --- | --- | --- | --- | --- | --- | --- |
| Word count > 1,000,000 | Anonymous exact `{B-long}` | Same set after canonical browsing | Alice's label/holding-supported `B-long` included without an entry | Included only after Alice's selected state; Bob's state irrelevant | Same set from overlapping scope/mount, no duplicate | Word-count fact is readable with correct unit; configured Book TypeList returns same set |
| Light-novel form AND harem | Anonymous exact three-book set above | Same set; occurrence editor still retains duplicate notes | Same set intersect Alice's support union | Same set intersect Alice's selected state | Same set, union canonical and paged | Correct form/tag facts and inverse relation; configured TypeList agrees |
| Both book predicates | Anonymous exact `{B-long}` | Exact `{B-long}` | Exact supported `{B-long}` without fabricated state | Exact intersection with own selected state | Exact `{B-long}` | Facts and TypeList agree with the combined result |
| Vegetarian AND cookTime ≤ 30 | Anonymous exact four-recipe set | Same set | Same set intersect Alice's support union | Filtered by Alice's accepted state if requested | Same set from eligible public sources | Ingredients/instructions, diet and cookTime readable; TypeList agrees |
| Vegetarian, quick, not cooked by me | No unauthenticated private predicate; anonymous request denied | Alice-only personalized projection where admitted | Exact three-recipe owner set above | Equivalent admitted own predicate; no-entry is included within owner population | Public result never reads Alice's history; private personalization only if explicitly admitted | Personal hydration for Alice only; public facts unchanged |
| Platform plus release qualifiers | Anonymous exact release IDs satisfying one statement | Same catalogue semantics | Same semantics over own supported games | Same plus own accepted state | Same semantics and deduplication | Work/release page distinguishes aggregate platform from actual release tuples |

Each applicable cell also needs hidden-source/subject, valid suspended bearer, unknown evidence, sparse/deep pages,
alias/original identity, source revocation and cursor reauthorization variants. Use the current [filtered-list
contract](../filtered-lists.md): full useful page or genuine exhaustion, explicit preparation/readiness while work is
unsettled, finite retained progress, and no unsafe aggregate fallback. A subject detail page is tested for factual
projection; arbitrary filtering of its detail object is not a new feature. Its configured TypeList is the list
consumer. Public output never borrows an editor's or curator's private authority.

Use the frozen dynamic suite's existing query encoding for the catalogue part of Collection requests:

```ts
const query = new URLSearchParams({ filter: JSON.stringify(bookFilter), sort: 'id', limit: '2' });
// Send with Alice's bearer for Everything/state, or without a bearer for public curated output.
const request = new Request(`${origin}/v1/collections/${collectionId}/members?${query}`, { headers });
```

Assert the original response is `200`, `members` contains the expected fixture subject IDs in admitted order, and
`next` is null only on genuine exhaustion. For a two-row form/tag page, the first two admitted IDs fill page one,
the remaining ID fills the exhausted second page, and no ID repeats. Preserve each surface's actual DTO rather than
normalize fake responses into this shape. During preparation use its adopted readiness envelope, not an empty
successful `members` array plus a raw nonmatch cursor. The catalogue filter/encoding already appears in frozen
dynamic outcomes; implementing it in the production common route is still required.

For owner completion filtering, use the adopted owner-query schema to express the recipe profile's completed-session
predicate, combined with that catalogue filter. Its wire form is not selected by the current shared filter grammar.
Before freezing that new request, commerce must publish the concrete owner-query schema; copying catalogue state
into a public facet or adding a recipe-specific `notCooked` backend switch would violate the generic design.

For existing operations, preserve exact native HTTP expectations: subject create `201` with `subject.id`; a fresh
entry PUT `201` and replacement `200` with `libraryEntry`; copy/session create `201`; successful reads `200` with
the owner's typed envelope; bulk admission `202` with operation ID and Location, followed by `200` status/outcome
pages. Failure assertions check problem `status`, `code`, effect status and absence of unintended native effects.
In new cases a valid suspended bearer requires `403 account_suspended`; invalid/revoked credentials are distinct.
The appendix's red-specification evidence must not be counted as a successful response from any of these requests.

## Missing acceptance to freeze, grouped by owner Goal

These are scenario specifications for follow-up implementation, not tests added by this research. Add new files
only for genuinely missing outcomes; bind and finish existing frozen suites without editing their assertions.
Every fixture below includes native Auth/Access, not an allow-all test double. All writes carry fresh idempotency
keys and their required revision preconditions; replay variants reuse the same key and exact original request.
Expected statuses/envelopes come from the owning API contract. Routes explicitly marked **proposed** need owner
adoption before a test is frozen, rather than being presented as existing endpoints.

Some frozen drivers deliberately leave route spelling to the implementation. To make those requests concrete,
the following transport spellings are recommended for owner adoption; they add no alternative policy or authority.
The existing frozen driver must still send actual HTTP and return the original response. An already adopted owner
schema takes precedence over these research examples.

| Frozen operation / missing read | Proposed concrete HTTP request | Response assertion |
| --- | --- | --- |
| Label create/assign | `POST /v1/libraryLabels` with `{name:"try-next"}`; `PUT /v1/libraryLabels/{labelId}/subjects/{subjectId}` with `{}` | `201 {label:{id,revision,...}}`; `200 {assignment:{id,labelId,subjectId,revision}}`; no entry prerequisite |
| Inbox / unread / seen | `GET /v1/accounts/{recipient}/notices?limit=2`; `GET /v1/accounts/{recipient}/noticeUnreadCount`; `POST /v1/accounts/{recipient}/notices/{notice}:markSeen` with `{}` | `200 {items,next}` and `{count,capped}`; seen succeeds idempotently; another account is `404` |
| Author decision / appeal | `GET /v1/moderationDecisions/{id}`; `POST /v1/moderationDecisions/{id}/appeals` with `{statement:"Please reconsider"}` | `200` decision with reason/deadline; `201` pending appeal; unrelated reader `404` |
| Independent appeal resolution | `POST /v1/appeals/{id}:resolve` with `{outcome:"reverse",statement:"Independent review"}` | Successful final reversal; original decider/unprivileged caller `403`; subsequent state and notices match the frozen suite |
| Continue | `GET /v1/libraryContinue?limit=6` as Alice | `200` bounded profile-active/session-ranked own subjects; anonymous never receives Alice's row |
| Retained library undo | `POST /v1/libraryDeletions/{deletionId}:restore` with the frozen deletion incarnation/revision precondition | Exact retained fact/identity restored; replacement conflict and exact retention deadline `409`; deletion address is independent of replacement subject state |

### semantic

Suggested native files: `test/semantic/catalogue-user-cases.test.ts`, `test/zones/site-user-cases.test.ts`, with
shared released-data fixtures. Search/commerce/content/web implement their participating boundaries.

| Scenario / groups | Persona, fixture and HTTP request | Expected observable outcome |
| --- | --- | --- |
| `vertical-release` / G1 | Steward publishes/activates a release through `/v1/definitions/releases` and `:activate`; editor creates a new board-game type, designer/player-count facets/profile and an authored Recipe through `/v1/subjects`, candidate acceptance and Context adoption. Anonymous then reads/searches; Alice writes a permitted state. | Released type survives every API boundary with declared facts, template metadata and profile choices; no kernel type switch is needed. Person without a profile has no tracking capability. Repeat with actual bundled Book/Recipe release, so extension support cannot conceal missing launch data. |
| `catalogue-jobs` / G1,Q1 | Editor creates/adopts the books, Concepts and recipes through ordinary semantic HTTP; anonymous GETs subjects and runs all three book queries and diet/time query above. | Exact sets, values, units and Concept identities specified above; rejected/competing candidates are not public selected facts. Schema admission and searchable projection use the same release. |
| `platform-qualifiers` / Q1,I1 | Editor creates actual releases: Switch/Japanese on one statement, PC/English on another; anonymous queries Switch+English with required same-statement qualifiers, then Switch+Japanese. | First tuple does not match by combining statements; second does. Missing/withheld qualifier evidence cannot establish a negative match. Exercise compact and expanded storage representations with identical public results. |
| `zone-user-site` / Z1,C4,C5 | Owner creates/configures/publishes `Z-public` using mounted resources and saved scope. Anonymous sends **proposed** `POST /v1/zones/{id}/pages:read` with `{target:{route:"books"}}`, then `{target:{subject:B-long}}`; follow the typed continuation. | A routed common page uses the eligible source union, canonical unique subjects, declared order and all pages. Private/unpublished source grants do not follow from a Zone grant. Direct nonmember subject is undisclosed; removing/restricting a mount immediately changes eligible disclosure or readiness. Reuse typed contract rather than introduce a second page model. |
| `realm-subject-context` / G5 | Member and outsider read `Dune` through **proposed context-bearing** `POST /v1/pages:read`; fixture has different Global/Realm selected facts, one unpublished work and a global director agent. | Public and permitted Realm reads identify context/population explicitly, preserve local selected meaning, and give an honest no-local-publication result for the control. Director resolves to the same global agent. Outsider receives no protected local facts or population. |

### search

Suggested native file: `test/search/discovery-user-cases.test.ts`. Retain `outcomes.test.ts`,
`relation-facet-outcomes.test.ts`, `rating-api-outcomes.test.ts` and `native-rating-outcomes.test.ts`.

| Scenario / groups | Persona, fixture and HTTP request | Expected observable outcome |
| --- | --- | --- |
| `catalogue-jobs` / Q1 | Anonymous and editor POST the concrete search bodies, then `/v1/subjects:facets` with released form/tag/diet/time facets; fixture includes more than ten values and enough declared properties to exceed a preview. | Exact canonical ID sets and safe labelled buckets; all admitted facet values are reachable through the owner contract. Editor sees the same public membership. No text/title coincidence or test-only release makes the job pass. |
| `private-rating-isolation` / Q2 | Real native voters rate Global and an extreme protected Realm; member/outsider POST normal Global `sort:"rating"`, and try population/question overrides. | Public order uses only the designated Global question, threshold and prior. Changing private Realm answers changes neither public order nor public metadata. Overrides are rejected. Existing Global numeric/null-tie/cursor cases are reused. |
| `query-privacy` / Q3 | Anonymous/editor search positive harem, NOT harem, ordered results and facets. Pause projection; withhold a tag/fence a foreign source after initial query admission and again at final disclosure. | No stale positive hit, negative exclusion, ordering, count or cursor leak. The query remains preparing/readiness until current privacy acknowledgement covers local and every affected foreign refresh-visible repair. Safe omission of counts alone cannot pass. Then complete exact results return. |
| `freshness-and-recovery` / Q3,F1 | Editor changes public word count/tag and Alice changes private state while workers run; delay actual source-to-searchable progress beyond the contracted maximum; restart preparation after a crash. | Healthy catalogue edits become filterable within 60 seconds; over five minutes actual lag gives readiness. Alice's next owner read sees her committed change. Fixed finite sparse input eventually produces full/exhausted pages; no empty-success cursor chain, endless preparing or reset-to-zero recovery. |

### commerce: library and Collections

Bind `specs/library-profiles-outcomes.test.ts`, `library-labels-outcomes.test.ts`,
`dynamic-collections-outcomes.test.ts`, `library-bulk-outcomes.test.ts`, `collection-source-outcomes.test.ts`,
`library-listing-freshness-outcomes.test.ts` and `library-deletion-outcomes.test.ts` to production composition.
Suggested new native file: `test/library/collection-user-cases.test.ts`; add only the business-fixture cases the
existing suites lack. Private owner predicates stay in that owner's PostgreSQL partition.

| Scenario / groups | Persona, fixture and HTTP request | Expected observable outcome |
| --- | --- | --- |
| `released-profile-journey` / L1 | Alice GETs released Book/game/Recipe choices, PUTs `/v1/libraryEntries/{subject}`, reads it, activates a second release, replays and later reads/clears the old fact. Other/unscoped/suspended callers repeat. | `playing`/`cooked` and other declared IDs are accepted only for their profiles; old labels/meaning use accepting pins, retired choices remain readable/clearable, fresh undeclared writes fail. Public DTOs do not disclose private pins. Existing native command cases supply their covered variants. |
| `label-only-library` / L2 | Alice sends the label create/assign HTTP requests above for `B-long`, without an entry/session/copy; GET Everything members through its discovered Collection ID. Bob assigns a label named `vegetarian`; anonymous runs diet search. | Label create is `201` with a label ID/revision; assignment is `200` under the frozen DTO. Alice's subject enters Everything once, without invented state. Bob cannot see Alice's label/support/count; the label's text never classifies a Recipe publicly. Remove the last label/support and membership disappears on the next own read. |
| `everything-population` / C1 | Alice GETs `/v1/collections?curatorAccountId={alice}` and each built-in's `/members`; fixture has every independent support, duplicate supports, empty shell, follow-only and Bob-only subjects. | Stable supported built-in identities, read-only discovery and discriminated DTOs. Union includes each live support once, excludes empty shells/follow-only/Bob-only facts; state sibling uses only accepted own state. Other/anonymous private-ID lookup is indistinguishable from unknown. |
| `collection-jobs` / C2,Q1 | Alice/anonymous GET `/v1/collections/{id}/members?filter={encodedJSON}&sort=id&limit=2` with the filter documents above for every applicable matrix cell; compare curated, Everything and state identities, text, order and cursor. This encoding exists in frozen specs but is not admitted by the production route yet. | Exact intersection with source and own population, same released predicate meaning, canonical browsing without duplicate rows. Curated occurrence editing still retains two occurrences/notes. No fixed shelf endpoint substitutes for the common members API. |
| `progress-and-continue` / L3 | Alice POSTs `/v1/progressSessions`, then `/{id}:record` and `:complete` under a recipe/game/record profile; reads sessions, home Continue projection and recipe owner query. Activate changed/retired profile. | Declared modes/units and exact old pins survive; Continue follows the profile's active role instead of the string `in_progress`. Completed cooking excludes only Alice's completed recipe; Bob's completion has no effect. No automatic state/copy/entitlement creation. **Proposed Continue read boundary** must be named by its owner before freezing. |
| `holdings-are-independent` / L3 | Alice POSTs `/v1/copies`, PATCHes its declared kind/status, deletes/restores it; GET entries/sessions/entitlements before and after. | Typed profile choices accepted, invalid pair rejected without partial facts; independent copy IDs/pins and owner isolation. A holding can support Everything without state. Library copies are neither proof of purchase nor an automatic progress state. |
| `bulk-user-population` / C3 | Alice POSTs `/v1/libraryOperations` over explicit IDs and the same query selecting long harem light novels; GETs operation/outcomes, retries, cancels and revokes authority during later pages. | Exactly the captured eligible population receives the requested action once, with per-item failures and bounded continuation; excluded/unknown/other-owner subjects do not change. Membership changes follow the contract's capture semantics, not live ad hoc re-enumeration. Cancellation/replay cannot duplicate effects. |
| `collection-actions` / C4,Z1 | Eligible reader PUTs `/v1/follows/{collection}` for public/unlisted curated and permitted published dynamic output; GETs **proposed** `/v1/collections/{id}/export?format=schema.org` and reads the mounted Zone. Repeat for Alice's private built-ins as Bob. | Follow eligibility agrees with read/action contracts; `200` ItemList export has canonical ordered public URLs and no personal predicates. Curated export preserves permitted duplicate occurrences/notes/order; dynamic export emits unique subjects. Zone/Collection browsing uses canonical uniqueness over the same eligible output. No private built-in identity or owner predicate leaks. |
| `published-output-lifecycle` / C5 | Alice publishes a complete dynamic generation, changes private facts while generation work is pending, and anonymous GETs its members/export/Zone before and after publication and source revocation. Then terminal deletion occurs. | Only the last fully published eligible output is public; private no-output changes do not alter public cursor bases/fields. Revocation is immediate or explicit readiness. Eligible completed public output freezes/de-identifies on terminal erasure; private/unlisted/deleted outputs and logs do not survive. |
| `ordinary-delete-undo` / L4 | Alice DELETEs an entry/copy/occurrence/Collection, reads every list/source, uses the frozen restore API within 30 days, creates a replacement incarnation and tries stale undo; advance authoritative retention time to due purge. | Deleted facts are concealed everywhere immediately, retained only for undo, restored with their original pins when eligible, never overwrite a replacement. After due purge restoration fails; business state changes/takedowns do not silently start an ordinary deletion window. |

### commerce: offers, orders and entitlements

Suggested native file: `test/commerce/purchase-user-cases.test.ts`; retain the native commerce outcome suite.

| Scenario / groups | Persona, fixture and HTTP request | Expected observable outcome |
| --- | --- | --- |
| `offer-to-benefit` / O1 | Anonymous reads a subject and its **proposed minimal offer-discovery link**, buyer GETs the offer, POSTs `/v1/orders`, completes controlled Checkout, GETs order and `/v1/entitlements`; other buyer repeats those reads. | Discoverable target/price/currency/benefit agree through checkout and entitlement; buyer can identify usable granted access, other buyer sees no order/private benefit. Library entries/copies are unchanged. Existing refund/revoke cases remain in force. |
| `offer-lifecycle-receipts` / O2 | Seller POSTs `/v1/offers/{id}:delist`; anonymous/buyer GET the offer and POST `/v1/orders` with its ID. Seller uses **proposed** `PATCH /v1/offers/{id}` with `{unitAmountMinor:500}` on two same-partition offers using one key. | Delisted public GET is `404 not_found`, new order is `409 offer_unavailable` with no checkout; eligible existing buyer history remains `200`. Same original revision replays; different target produces the existing Commerce problem status `422 idempotency_conflict`, never another offer's receipt or mutation. Mount revision before claiming the HTTP journey works. |
| `checkout-observation-order` / O3 | Buyer has a paid/granted order. Feed provider observations in order: newer unchanged paid truth at t3, then older refund/dispute at t2, with initial truth t1. Trigger normal refresh/webhook processing; GET order, entitlement and benefit. | t3 advances the ordering watermark even without a business transition. t2 cannot revoke or replace newer truth; replay adds no transactions/effects. A genuinely newer refund still revokes. Provider transport may be controlled; settlement/store/command/workflow stay production. |

### content

Suggested native files: `test/content/subject-user-cases.test.ts`, `test/content/notice-user-cases.test.ts`.
Bind the existing frozen notification/moderation suite rather than accept its missing-driver verifier as delivery.

| Scenario / groups | Persona, fixture and HTTP request | Expected observable outcome |
| --- | --- | --- |
| `review-from-vote` / G4 | Reader PUTs a real vote, POSTs a review thread with subject target/citation using the existing content DTO, changes that vote, then anonymous GETs the subject's thread/review list and all continuations. | Production relay supplies correctly targeted paged reviews/discussion, review citation retains its publication-time value, later own vote changes independently. Hidden/protected posts never enter public results; immutable revisions/licence metadata survive. |
| `subject-rating-context` / G3,G5 | Reader fetches subject page data, own vote and public/Realm figures using native APIs; fixture crosses the threshold and has private and unpublished populations. | Subject presentation and search cards identify the same standard question/population, units/count and honest insufficient-data/updating state; own vote is private. Reuse native vote/figure producer cases rather than seed aggregate rows for this composed case. |
| `protected-ban-barrier` / R2 | Protected Realm member is banned; before asynchronous removal, member GETs protected boards/posts and manager tries to admit the banned member. No independent grant in the decisive fixture. | Immediate protected read/participation/admission denial with no worker-settlement prerequisite; unrelated public Realm reads keep their public behavior. Freeze the separate independent-grant variant only after accounts/content settle its precedence. |
| `notice-delivery` / N1 | Author replies/mentions a recipient through native content HTTP; recipient's per-kind preferences differ; revoke access before delivery and replay event. Recipient/other/anonymous send the proposed inbox/unread/markSeen HTTP requests above, binding frozen `inbox`, `unread` and `markSeen`. | `200` recipient inbox has exactly one eligible notice per event/recipient, `items`/continuation and bounded unread state; opted-out/inaccessible notices absent. Mark seen changes only that recipient's state. Other/anonymous never obtain the inbox. Access loss after delivery prevents later sensitive disclosure. No email requirement. |
| `report-to-appeal` / N2 | Reporter POSTs `/v1/reports` targeting a real post; moderator resolves; author sends decision/appeal HTTP requests above with the returned ID and statement; independent reviewer sends resolution. Bind frozen `decision`, `appeal` and `resolveAppeal` without emulation. | Report create is `201`; reporter reads `open` then `actioned`/`dismissed` as appropriate. Author sees decision reason/deadline, appeal is `pending` then `uphold`/`reverse`, with required deduplicated notices. Original decider cannot resolve the appeal; expired/replayed/unauthorized transitions add no effects. Reversal restores only eligible content. |
| `late-board-revocation` / N3 | Anonymous/member GETs a paged thread/post after initial board preparation is paused at a test barrier; moderator revokes/deletes the containing board, then resume the actual reader. | Final response discloses no now-ineligible item, summary/count/source/cursor material. Verify direct and composed callers. Barrier controls timing only; production board/Access reads and final serialization remain real. |

### accounts

Bind existing `specs/follow-counts-outcomes.test.ts` and `viewer-actions-outcomes.test.ts`; suggested new native file
`test/access/profile-user-cases.test.ts`. Coordinate terminal erasure with every owner.

| Scenario / groups | Persona, fixture and HTTP request | Expected observable outcome |
| --- | --- | --- |
| `agent-identity` / A1 | Anonymous GETs account/agent and page-read APIs for human, organization and software agent; browser HTTP GETs the verified subject URL. Operator/outsider repeat private-field reads. | Exactly one correctly typed public identity, canonical handle redirect, supported software-agent/operator presentation and no fabricated Person fallback. An operator relationship grants no agent authority or private profile disclosure. |
| `self-profile-http` / A2 | Alice PATCHes **proposed mounted** `/v1/accounts/{id}` profile/public-view fields with revision; GETs own and public views, changes preferences/verification with their contracted actions; Bob/unscoped/revoked caller repeats. | Valid profile changes appear through HTTP, public privacy controls are enforced in reads, identity/verification require their separate authority, forbidden/read-only/unknown fields fail without partial mutation, replay is stable. Existing command-only updates do not substitute for the mounted request. |
| `follow-owner-counts` / A3 | Follower PUT/DELETEs `/v1/follows/{target}` for each eligible subject/agent/Space/Collection; target owner GETs `/v1/followCounts/{targetType}/{targetId}`, follower GETs `/v1/followCounts/outgoing`; stranger/anonymous attempts both. | Counts reflect explicit edges only, owner-only incoming counts, private own outgoing count, no public followers list/count or inferred acquisition/activity. Hidden targets, duplicate replay and deletion stay safe. Native-bind the frozen suite's complete variants. |
| `advertised-actions` / A4 | Delegated editor GETs Collection/Realm/resource metadata containing viewer actions and attempts those actual operations. Remove only actor grant, principal grant or consent between discovery and execution. | Advertised actions match native Access at discovery; delegated editor is not rejected merely for not being curator. Execution reauthorizes and denies revoked operands. Discovery never substitutes for authorization or reveals hidden resources. |
| `terminal-erasure-graph` / A5 | Alice completes fresh-auth typed-confirmation deletion. Native erasure workers run; anonymous/Bob/Alice-old-token GET profile, entries, labels, sessions/logs, copies, follows/counts, private/unlisted Collections, offers/orders/entitlements and prepared exports/Zone sources. Attempt ordinary undo. | Terminal barrier is immediate, old credentials cannot act, private graph/payloads disappear under the owner policy, no ordinary restore resurrects it. Eligible public contributions/output survive only de-identified; retained commerce records are minimized under their contract. Inspect private backing payload stores as additional evidence, not instead of HTTP outcomes. |

### imports

Extend the existing native import API suite with consumer checks; suggested native file
`test/imports/discovery-user-cases.test.ts` and importer integration coverage for the real restart boundary.

| Scenario / groups | Persona, fixture and request | Expected observable outcome |
| --- | --- | --- |
| `import-to-discovery` / I1,G1,Q1 | Ordinary importer actor submits reviewed Bangumi/VNDB/Open Library/Wikidata fixtures through real batch/contribution APIs; editor accepts required candidates; anonymous GETs work/release/edition, search/facets and Collection/Zone consumers. | Source attribution, work/edition/release identity and selected facts agree. Map real supported provider fields only: tags/form/platform where licensed and semantically valid; page/character counts cannot become words. If no provider supplies genuine word count, editorial genuine-word fixtures still satisfy the job and absent imported words stay unknown. No recipe-site method import. |
| `cover-native-recovery` / I2 | Run importer with a persisted run store against native media/source APIs. Interrupt after a real acknowledgement but before local progress persistence; restart same run, then change the provider cover. Anonymous GETs subject/media/page. | Retry reuses the same receipt, no duplicate candidate/asset or skipped cover; resumed old cover and subsequent replacement each resolve with correct attribution/visibility. Fake provider availability is permissible; fake kernel receipts/media resolver are not proof of this integration. Preserve existing SQLite recovery tests. |

### web: HTTP publication rather than fake-client rendering

Suggested files: `apps/web/tests/publication-user-cases.test.ts` and `public-cache-user-cases.test.ts`, using the
native product boundary for upstream reads. Kernel assertions remain owned by their backend Goals.

| Scenario / groups | Persona, fixture and HTTP request | Expected observable outcome |
| --- | --- | --- |
| `subject-traversal` / G2 | Anonymous POSTs `/v1/pages:read` for full subject views and follows API continuation for a work with more than one page of editions, contents, cast/crew and inverse credits. Editor contributes a competing sourced date; follow Details/history through the semantic HTTP routes. | Every eligible relation is reachable, in declared order; character/credited-name/position/spoiler qualifiers retain meaning; sourced competing claims/history are reachable. Reuse native `K/semantic/relations-uncapped.test.ts` and `context-relations.test.ts` evidence for their covered relation boundaries; add the composed page/claim journey. |
| `published-vertical-metadata` / E1,A1 | Anonymous GETs served Book, Recipe, game/release and three agent-kind pages, stale slugs and verified subject URLs. Fixture contains public/withheld author/tag, Recipe instructions/diet/cookTime and an alternate configured public origin. | Declared schema.org type/canonical identity, title/sharing metadata and JSON-LD agree with actual disclosed/rendered facts. Recipe uses supported instructions and `PT25M` at publication; withheld data is absent. Correct canonical redirects/origin/localized slugs; no kernel-only or serializer-fake pass substitutes. |
| `public-discovery-and-cache` / E2 | Anonymous GETs robots, sitemap index and every eligible subject/Collection/Realm/Space/board/thread shard, following native feed pagination. Warm public page cache as Alice then GET as anonymous/Bob; request private hydration separately. | All and only eligible public URLs, valid continuation/lastmod and no unlisted/private/taken-down output. Cacheable public HTML/structured data contains no Alice state/labels/history/holdings/own vote or privileged source data; private hydration requires current account authority. Existing native feed tests are reused. |

### performance

Suggested native file: `test/performance/composed-discovery-user-cases.test.ts`; measurement collaborators retain
their existing module growth suites. Numeric allowances belong in the adopted native plan contracts before freezing.

| Scenario / groups | Persona, fixture and HTTP request | Expected observable outcome |
| --- | --- | --- |
| `composed-cost-and-progress` / F1,Q3,C2,C3,Z1 | Anonymous/Alice run the cross-surface jobs and bulk query at three geometric scales (library membership/filter population: 1,000/10,000/100,000 per its current contract), first/deep pages, sparse matches behind many nonmatches, alias/duplicate fanout, unrelated owner history and hidden/denied/empty controls. Restart retained preparation midway and revoke a foreign dependency. | Native examined/removed rows, buffers, statements/connections in every pool, bytes, Access/dependency points and actual engine work obey each approved page/step budget. Common page respects 16 distinct reads/128 total output slots. Fixed finite ready input completes useful pages after bounded durable progress; no tiny returned array hides unbounded work or endless preparation. Existing unrelated module-scale bounds are preserved. |

## Workflow change the manager can adopt

Create one capability acceptance manifest per owner Goal, checked against every In row in `docs/scope.md`. Each
entry names a user job, personas, released fixture definitions, required surfaces, frozen scenario names, native
wrapper and acceptance command. Use semantic capability names, not dispatch ticket IDs. Shared abstractions expand
into explicit cells: catalogue, curated, Everything without state, own state, mounted Zone and configured TypeList.
An explicit out-of-scope/not-applicable explanation is reviewable; a silently omitted cell is not.

Write the job and its discriminatory data before implementation. “Book with author” is insufficient evidence for
word count, form and tag; “vegetarian” as a private label cannot satisfy dietary suitability. Have semantic/imports
own the released-data producer and commerce/search own their consumers. The capability owner owns the composed
result, even if all participating module tasks have already landed.

Track separate stages in durable control-plane state: specification validated red; native driver registered;
implementation exposed; user-case acceptance passed at a named revision; promoted. A missing-driver verifier may
advance only the first stage. A schema/helper test may close an implementation slice, but cannot close its parent
public capability. Preserve the current frozen-byte protections and existing lower-level tests.

Require manager completion and promotion gates to validate manifest completeness and run the registered native
capability commands. Require exact declared scenario execution, zero skips/todos, and a binding that invokes
production routes/native Access/default worker composition where relevant. Inspect wrappers as well as counts:
a test adapter can otherwise fabricate a successful list. Reuse the repository's strongest existing outcome-driver
pattern; no new service, scheduler, search engine or parallel fixture permission model is needed.

Dispatch the smallest missing slice with its parent capability and producer/consumer dependencies named. A supporting
task can legitimately finish a schema or stub, while the parent remains open. Frozen missing outcomes stay red until
their real binding passes. A documented required feature must not become permanently unsupported/preparing merely
to keep a local acceptance green. Extend declarations and routes together, with owner-reviewed API schemas.

Keep execution economical: run a worker's exact scoped acceptance once after its last relevant edit and the root
typecheck. Run capability commands at the appropriate owner/integration gate, deduplicated by revision, rather than
ask every primitive worker to repeat all workspace suites. Preserve queued slot behavior and existing native growth
measurement. A gate can check manifest completeness cheaply before allocating heavy test slots.

Adoption order is released definitions/fixtures, missing production bindings, the core cross-surface jobs and privacy
barriers, then the remaining lifecycle/workflow/publication cases. Release readiness requires all first-public
capabilities; priority does not silently defer the rest. Record adopted decisions in owning documents, leaving this
report as evidence rather than creating a second authority.

## External primary sources and reusable patterns

Only source was read from these existing reference clones. Nothing was installed, built or executed. Reference
metadata is recorded under the `api-acceptance-gaps` topic in the main checkout's `.reference/INDEX.md`.

| Source and local reference | Pinned evidence and licence | Finding and repository-stack recommendation |
| --- | --- | --- |
| Mealie, `.reference/shelves/mealie` | Commit `3a9d78ef438bb9bb13a69c5fc88c25cc2fa2de7f`; [public cookbook integration tests](https://github.com/mealie-recipes/mealie/blob/3a9d78ef438bb9bb13a69c5fc88c25cc2fa2de7f/tests/integration_tests/public_explorer_tests/test_public_cookbooks.py), especially `test_get_cookbooks_with_recipes`; [LICENSE](https://github.com/mealie-recipes/mealie/blob/3a9d78ef438bb9bb13a69c5fc88c25cc2fa2de7f/LICENSE), AGPL-3.0. Also read `tests/integration_tests/user_household_tests/test_group_cookbooks.py`. | A real HTTP public recipe listing selects a tagged cookbook across two households and asserts both exact included public recipes and excluded private recipes. Data is repository-seeded, not an HTTP-write proof. Adopt the public/private, source-container and exact-ID-set fixture pattern in Bun/native kernel tests; copy no implementation. |
| OpenFGA, `.reference/search-visibility-witnesses/openfga` | Commit `57b39bc3dcc12f92270602bc01eb933ca4accfbe`; [pkg/server/list_objects_test.go](https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/pkg/server/list_objects_test.go), `TestListObjectsUnevaluableExclusion`; [LICENSE](https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/LICENSE), Apache-2.0. | The real server with an in-memory datastore tests both list forms when a subtraction condition lacks evidence; no objects may escape. This is logical/endpoint evidence, not PostgreSQL cost evidence. Adopt explicit unknown-under-NOT cases at every REZICS native list boundary, with production PostgreSQL/OpenSearch and current Access. |
| OpenFGA official [model testing guide](https://openfga.dev/docs/modeling/testing) | Official documentation read 2026-10-28; source implementation licence is recorded above, no documentation text copied. | Model fixtures specify relationship checks and expected list-object sets. Adopt explicit per-persona expected sets and reusable models; supplement individual access checks with list outcomes. |
| Schema.org [wordCount](https://schema.org/wordCount), [Recipe](https://schema.org/Recipe), [terms](https://schema.org/docs/terms.html) | Pages report vocabulary version 30.1, 2026-09-16; vocabulary copyright licence CC-BY-SA-3.0 under the published terms. | Distinguish words from pages/characters, diet from arbitrary tags, and exported cook duration from internal minute quantities. Use definitions and adapters in the existing stack, not a copied recipe backend. |

Across the implementation examples, the useful common pattern is a small named population with asymmetric
permissions, an actual public list request and explicit included/excluded outcomes. Unknown dependencies are tested
at the list boundary. Neither project is evidence that REZICS needs its framework, schema or authorization engine;
the recommended design uses existing definitions, Bun acceptance, native Access, PostgreSQL, OpenSearch and workers.

## Appendix: 30 recent frozen brief observations

`K/` abbreviates `services/kernel/test/`; all times are UTC. SHA prefixes identify the sampled **brief contents**,
not acceptance results. Repeated file paths expose successive attempts to close a slice. This is a qualitative,
stratified sample, not a random estimate of defect frequency or evidence that any task shipped.

| # | Date/time | Goal | Brief SHA-256 prefix | Frozen acceptance inspected; boundary actually asserted |
| --- | --- | --- | --- | --- |
| 1 | 10-28 13:41:15 | semantic | `4c26e03c7b6a` | `K/zones/resource-core.test.ts`, `K/semantic/outcome-fixture-capabilities.test.ts`: formatting reconciliation of native resource/fixture assertions; not Zone union pages. |
| 2 | 10-28 12:33:40 | commerce | `e365836d6856` | `K/library/account-fact-purge.test.ts`: native terminal purge of entry/copy/follow facts; first primitive, not full graph. |
| 3 | 10-28 06:12:34 | commerce | `e7cc61981735` | `specs/dynamic-collections-outcomes.test.ts`: label-only/trash policy outcomes, command verifies correctly red missing-driver specification. |
| 4 | 10-28 05:41:33 | commerce | `3a913799b78e` | `specs/dynamic-collections-driver.ts`, `dynamic-collections-outcomes.test.ts`: contract adoption and red specification checks; not native composition. |
| 5 | 10-28 05:37:09 | commerce | `5b6e5f025964` | Brief-only `K/library/entry-retention-worker.test.ts` (absent at the audited revision): proposes native due-retention worker behavior, not an ordinary HTTP undo journey. |
| 6 | 10-28 05:35:58 | commerce | `0f755d7031b3` | `K/library/owner-fact-source-hooks.test.ts`, `label-reservation-schema.test.ts`: native source hooks/reservations; no label-management HTTP consumer. |
| 7 | 10-28 05:32:34 | commerce | `5ac5a7ec2830` | `specs/dynamic-collections-driver.ts`, `dynamic-collections-outcomes.test.ts`: earlier revised specification boundary. |
| 8 | 10-28 04:11:33 | search | `3cdbb5de2b62` | `K/search/complete-search-shards.test.ts`: complete shard-response admission; no end-user form/range fixture. |
| 9 | 10-28 03:16:24 | search | `547baf3b6563` | Brief-only `K/project-snapshot-admission.test.ts` (absent at the audited revision): native snapshot admission/lock/checkpoint callback, not a searchable user population. |
| 10 | 10-27 23:55:03 | search | `72a02bae4fb8` | `K/search/rating-source.test.ts`: Global public-source type/normalizer shape; no native vote-to-index-to-API journey in that slice. |
| 11 | 10-27 22:49:36 | semantic | `469d449c1f4e` | `K/semantic/scope-leaf-types.test.ts`: exported leaf contracts and invalid-before-SQL/not-ready behavior; no usable scope membership. |
| 12 | 10-27 22:36:08 | accounts | `1165004bd241` | `specs/durable-initiator-outcomes.test.ts`: native durable authority/initiator outcomes; positive example of composed permission acceptance. |
| 13 | 10-27 22:01:52 | semantic | `b52a8eb9ca2f` | `K/zones/resource-core.test.ts`: real resource CRUD/grants/revision/replay; union and routed reads explicitly excluded. |
| 14 | 10-27 21:23:29 | search | `f931bf8aac36` | `K/search/rating-cursor.test.ts`: rating cursor codec and bindings; no HTTP ordering population. |
| 15 | 10-27 21:18:32 | semantic | `578dc7827618` | `K/zones/page-continuation-contract.test.ts`: typed continuation/202 schemas; runtime page composition excluded. |
| 16 | 10-27 20:19:52 | semantic | `0f5b00a6b745` | `K/zones/typed-contract.test.ts`: transport contracts, not a routed public site. |
| 17 | 10-27 20:07:16 | semantic | `6b95b6e75d8d` | `K/semantic/outcome-fixture-capabilities.test.ts`: genuine fixture scope/delete capabilities, not all consuming outcomes. |
| 18 | 10-27 19:36:20 | search | `3ea5977317f5` | `K/search/rating-cursor.test.ts`: earlier codec revision. |
| 19 | 10-27 19:33:21 | search | `e2a97194da03` | `K/search/rating-cursor.test.ts`: earlier codec revision; repeated work must not count as a second capability. |
| 20 | 10-27 10:52:33 | content | `206de4aaa739` | `specs/imported-field-outcomes.test.ts`: native imported-field/source-fence/media ordinary-API chain; useful cross-owner example. |
| 21 | 10-26 22:31:42 | imports | `6d5449ceb3a5` | `K/imports/growth-outcomes.test.ts`: native whole-import growth binding, revised frozen wrapper. |
| 22 | 10-26 22:26:14 | imports | `0b2a5594c71c` | Same growth wrapper, earlier revision. |
| 23 | 10-26 19:58:55 | imports | `36eb7f44aacd` | Same growth wrapper, earlier revision. |
| 24 | 10-26 19:44:14 | imports | `f96e56c5ee24` | Same growth wrapper, earlier revision. |
| 25 | 10-26 19:30:01 | imports | `10322d252ac3` | Same growth wrapper, earlier revision; not five independent importer jobs. |
| 26 | 10-26 17:07:20 | content | `0ea05735f700` | `specs/erasure-operation-outcomes.test.ts`: native erasure workflow/API binding; does not establish every downstream owner's private graph cleanup. |
| 27 | 10-26 16:22:22 | content | `b64a1b699e4d` | `K/community/scale-cap-community.test.ts`: source-scale-policy assertions; accompanying native growth work remains separate evidence. |
| 28 | 10-26 16:20:54 | content | `b7bd359c040b` | `specs/erasure-operation-outcomes.test.ts`: earlier native workflow revision. |
| 29 | 10-26 16:03:26 | imports | `098f44e0cd6b` | `specs/support/verify-import-api.ts`, `K/imports/api-outcomes.test.ts`: real API binding and growth-aware verification, not only a missing-driver verifier. |
| 30 | 10-26 15:13:08 | content | `fc6270f6bf45` | `specs/erasure-operation-outcomes.test.ts`: earlier native workflow revision. |

## Decisions and limits for adoption

- Scope is the current `docs/scope.md`; the older architecture report supplies the 37 labels, not a second authority.
  Curated CRUD, basic votes/figures, Realm/Space operations and Global rating producer-to-search tests already have
  native acceptance. They are not counted as wholly untested merely because a frontend is unfinished.
- Prefer binding/finishing the existing frozen suite to adding redundant tests. Add realistic vertical fixtures and
  cross-surface consumer scenarios where that suite cannot express the missing job. This report changes no frozen
  test or production contract, and claims no product suite passed.
- Form/diet representation, reviewed provider mappings and released profile choices are data-producer obligations.
  The proposed requests use fixture substitutions until those released IDs are adopted. No invented source key or
  fabricated word estimate is a substitute. Owner approval belongs in the owning definitions/contracts.
- “Not cooked” is proposed as absence of an own live completed cooking session within a supported owner population;
  it is not a public inference or simply `state != cooked`. Holding-derived platform joins, saved user queries,
  Realm rating sorting, points, email and algorithmic feeds remain deferred.
- Independent read grants versus bans require an accounts/content precedence decision. The no-independent-grant
  protected ban test can be frozen immediately; the ambiguous variant cannot honestly select an outcome yet.
- Existing suspended-persona scenarios sometimes expect `401 invalid_credentials` while `docs/filtered-lists.md`
  now requires `403 account_suspended` for a valid suspended bearer. Record this as an owner reconciliation item
  before adopting new acceptance; do not weaken or silently edit frozen tests to conceal the discrepancy. The
  research report's own acceptance does not depend on resolving that product-contract conflict.
- The frozen dynamic test “bounded Collection filters advance opaque prefixes through hidden and filtered
  candidates without joins” explicitly expects an empty successful page with a continuation and an old candidate
  multiplier. The current shared useful-page contract requires full/exhausted success or explicit preparation.
  This is a concrete existing acceptance/specification mismatch for commerce/search/performance to reconcile
  through the owning acceptance process before a replacement capability suite is frozen. Keep the existing file
  intact during this research; do not make new tests bless empty-success chains.
- O2/O3 and the late board boundary are source-derived regression hypotheses; native HTTP tests must establish
  their concrete behavior. The brief sample cannot establish historical release status or defect rates. A passing
  research-file check proves report delivery only.
